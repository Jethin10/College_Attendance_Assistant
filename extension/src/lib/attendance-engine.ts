/**
 * Attendance engine.
 *
 * NIET's published Attendance Policy 2025-26 sets a 75% per-subject standard.
 * The engine uses it as a planning target, not as a claim about exam eligibility,
 * condonation, or exceptions. Aggregate percentage remains an ERP cross-check.
 */

import {
  AttendancePolicy,
  CalendarSession,
  DashboardData,
  DashboardSubject,
  RiskStatus,
  ScheduleSlot,
  SimulationRequest,
  SimulationResult,
  Subject,
  SubjectProjection,
  TimetableSyncState,
} from "@/lib/types";
import { dedupeCalendarSessions } from "@/lib/portal-timetable";

/** Guard for schedule projections so a bad slot set cannot spin forever. */
const PROJECTION_DAY_LIMIT = 180;

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Parses `YYYY-MM-DD` in LOCAL time.
 *
 * `new Date("2026-08-04")` parses as UTC midnight, which is the previous day
 * in any negative-offset zone and shifts the date once local hours are set on
 * top of it. Always route date-key parsing through here.
 */
function parseDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
}

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function parseTimeMinutes(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    return 0;
  }
  return hours * 60 + minutes;
}

function matchesLeaveDayPart(
  startTime: string,
  dayPart: SimulationRequest["dayPart"],
) {
  if (!dayPart || dayPart === "full") {
    return true;
  }

  const startsInMorning = parseTimeMinutes(startTime) < 12 * 60;
  return dayPart === "morning" ? startsInMorning : !startsInMorning;
}

function sessionStartDate(session: CalendarSession) {
  const date = parseDateKey(session.date);
  const [hours, minutes] = session.startTime.split(":").map(Number);
  date.setHours(hours || 0, minutes || 0, 0, 0);
  return date;
}

function latestCalendarSession(calendarSessions: CalendarSession[]) {
  if (calendarSessions.length === 0) {
    return null;
  }

  return [...calendarSessions]
    .sort((a, b) => sessionStartDate(a).getTime() - sessionStartDate(b).getTime())
    .at(-1);
}

function makeSessionFromSlot(slot: ScheduleSlot, date: Date): CalendarSession {
  return {
    id: `${slot.id}:${toDateKey(date)}`,
    subjectId: slot.subjectId,
    subjectCode: slot.subjectId,
    subjectName: slot.subjectId,
    date: toDateKey(date),
    dayOfWeek: date.getDay(),
    startTime: slot.startTime,
    endTime: slot.endTime,
    room: slot.room,
    source: "manual",
    estimated: true,
  };
}

function makeSimulatedFutureSession(
  subjectId: string,
  index: number,
  startDate = new Date(),
): CalendarSession {
  const date = startOfDay(startDate);
  date.setDate(date.getDate() + index);

  return {
    id: `simulated-future:${subjectId}:${index}:${toDateKey(date)}`,
    subjectId,
    subjectCode: subjectId,
    subjectName: subjectId,
    date: toDateKey(date),
    dayOfWeek: date.getDay(),
    startTime: "00:00",
    endTime: "00:00",
    source: "manual",
  };
}

function fillRequestedFutureCount(
  sessions: CalendarSession[],
  wanted: number,
  subjectId?: string,
) {
  if (!subjectId || sessions.length >= wanted) {
    return sessions.slice(0, wanted);
  }

  const missing = wanted - sessions.length;
  return [
    ...sessions,
    ...Array.from({ length: missing }, (_, index) =>
      makeSimulatedFutureSession(subjectId, sessions.length + index),
    ),
  ];
}

export function computeAttendancePercent(attended: number, held: number) {
  if (held <= 0) {
    return 100;
  }

  return round((attended / held) * 100);
}

export function computeNextMissDrop(attended: number, held: number) {
  const current = computeAttendancePercent(attended, held);
  const afterMiss = computeAttendancePercent(attended, held + 1);
  return round(current - afterMiss);
}

/**
 * How many further classes of this subject can be missed while staying at or
 * above the threshold. Missing a class raises `held` but not `attended`.
 */
export function computeBunkableClasses(
  attended: number,
  held: number,
  thresholdPercent: number,
) {
  if (held <= 0) {
    return 0;
  }

  const thresholdRatio = thresholdPercent / 100;
  if (thresholdRatio <= 0) {
    return 0;
  }

  // Largest n where attended / (held + n) >= ratio.
  const limit = Math.floor(attended / thresholdRatio - held);
  return Math.max(0, limit);
}

export function computeRecoveryClassesNeeded(
  attended: number,
  held: number,
  thresholdPercent: number,
) {
  const thresholdRatio = thresholdPercent / 100;

  // At a 100% requirement no finite number of future classes recovers a past
  // absence, so report 0 rather than looping forever.
  if (held <= 0 || thresholdRatio >= 1) {
    return 0;
  }

  if (attended / held >= thresholdRatio) {
    return 0;
  }

  // attended + n >= ratio * (held + n)  ->  n >= (ratio*held - attended)/(1-ratio)
  const needed = (thresholdRatio * held - attended) / (1 - thresholdRatio);
  return Math.max(0, Math.ceil(round(needed, 6)));
}

export function getSubjectStatus(
  percent: number,
  thresholdPercent: number,
): RiskStatus {
  if (percent < thresholdPercent) {
    return "critical";
  }

  if (percent < thresholdPercent + 5) {
    return "warning";
  }

  return "safe";
}

function worstStatus(statuses: RiskStatus[]): RiskStatus {
  if (statuses.includes("critical")) {
    return "critical";
  }
  if (statuses.includes("warning")) {
    return "warning";
  }
  return "safe";
}

/** Sessions on or after `from`, grouped by date key then subject id. */
function sessionsByDateAndSubject(
  calendarSessions: CalendarSession[],
  from?: Date,
) {
  const floor = from ? startOfDay(from) : null;
  const byDate = new Map<string, Map<string, number>>();

  for (const session of calendarSessions) {
    if (floor && sessionStartDate(session) < floor) {
      continue;
    }

    const bySubject = byDate.get(session.date) ?? new Map<string, number>();
    bySubject.set(session.subjectId, (bySubject.get(session.subjectId) ?? 0) + 1);
    byDate.set(session.date, bySubject);
  }

  return byDate;
}

/**
 * Full days that can be taken off while EVERY subject stays at or above the
 * threshold.
 *
 * A pooled budget is wrong here: if the weakest subject meets twice on one
 * day, spending two classes from a shared pool hides the fact that the
 * weakest subject absorbed both. Each subject carries its own budget and the
 * first day that pushes any budget negative ends the run.
 */
function safeLeaveDaysFromSessions(args: {
  budgets: Map<string, number>;
  calendarSessions: CalendarSession[];
  startDate?: Date;
}) {
  const byDate = sessionsByDateAndSubject(args.calendarSessions, args.startDate);
  const remaining = new Map(args.budgets);
  let leaveDays = 0;

  for (const dateKey of [...byDate.keys()].sort((a, b) => a.localeCompare(b))) {
    const bySubject = byDate.get(dateKey)!;

    const affordable = [...bySubject.entries()].every(
      ([subjectId, classes]) => (remaining.get(subjectId) ?? 0) >= classes,
    );

    if (!affordable) {
      break;
    }

    for (const [subjectId, classes] of bySubject.entries()) {
      remaining.set(subjectId, (remaining.get(subjectId) ?? 0) - classes);
    }
    leaveDays += 1;
  }

  return { leaveDays, remaining };
}

/** Same rule as above, projected forward from a repeating weekly timetable. */
function safeLeaveDaysFromSlots(args: {
  budgets: Map<string, number>;
  timetable: ScheduleSlot[];
  startDate?: Date;
}) {
  if (args.timetable.length === 0) {
    return 0;
  }

  const slotsByDay = new Map<number, Map<string, number>>();
  for (const slot of args.timetable) {
    const bySubject = slotsByDay.get(slot.dayOfWeek) ?? new Map<string, number>();
    bySubject.set(slot.subjectId, (bySubject.get(slot.subjectId) ?? 0) + 1);
    slotsByDay.set(slot.dayOfWeek, bySubject);
  }

  const remaining = new Map(args.budgets);
  let leaveDays = 0;
  const cursor = startOfDay(args.startDate ?? new Date());

  for (let i = 0; i < PROJECTION_DAY_LIMIT; i += 1) {
    const bySubject = slotsByDay.get(cursor.getDay());

    if (bySubject && bySubject.size > 0) {
      const affordable = [...bySubject.entries()].every(
        ([subjectId, classes]) => (remaining.get(subjectId) ?? 0) >= classes,
      );

      if (!affordable) {
        break;
      }

      for (const [subjectId, classes] of bySubject.entries()) {
        remaining.set(subjectId, (remaining.get(subjectId) ?? 0) - classes);
      }
      leaveDays += 1;
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return leaveDays;
}

/**
 * Overall mode: consecutive days off until the total missed classes would push
 * overall attendance below the threshold. Subject identity is irrelevant here.
 */
function safeLeaveDaysFromSharedBudget(args: {
  budget: number;
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  startDate?: Date;
}) {
  if (args.budget <= 0) {
    return 0;
  }

  let remaining = args.budget;
  let leaveDays = 0;

  if (args.calendarSessions.length > 0) {
    const byDate = sessionsByDateAndSubject(args.calendarSessions, args.startDate);

    for (const dateKey of [...byDate.keys()].sort((a, b) => a.localeCompare(b))) {
      const classes = [...byDate.get(dateKey)!.values()].reduce((sum, n) => sum + n, 0);
      if (classes > remaining) {
        return leaveDays;
      }
      remaining -= classes;
      leaveDays += 1;
    }
  }

  if (args.timetable.length === 0 || remaining <= 0) {
    return leaveDays;
  }

  // Continue past the synced range using the repeating weekly pattern.
  const classesByDay = new Map<number, number>();
  for (const slot of args.timetable) {
    classesByDay.set(slot.dayOfWeek, (classesByDay.get(slot.dayOfWeek) ?? 0) + 1);
  }

  const lastSession = latestCalendarSession(args.calendarSessions);
  const cursor = lastSession
    ? startOfDay(sessionStartDate(lastSession))
    : startOfDay(args.startDate ?? new Date());
  if (lastSession) {
    cursor.setDate(cursor.getDate() + 1);
  }

  for (let i = 0; i < PROJECTION_DAY_LIMIT; i += 1) {
    const classes = classesByDay.get(cursor.getDay()) ?? 0;
    if (classes > 0) {
      if (classes > remaining) {
        break;
      }
      remaining -= classes;
      leaveDays += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return leaveDays;
}

/**
 * Safe full days off, preferring the portal's dated schedule and continuing
 * with the repeating weekly timetable once those dates run out.
 *
 * `sharedBudget` switches to overall mode: every missed class draws on one
 * pool regardless of subject, which is how the institute actually counts.
 * Without it, each subject carries its own allowance and a day is only safe
 * when every subject meeting that day can absorb its own hit.
 */
function computeSafeLeaveDays(args: {
  budgets: Map<string, number>;
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  startDate?: Date;
  sharedBudget?: number;
}) {
  if (args.sharedBudget !== undefined) {
    return safeLeaveDaysFromSharedBudget({
      budget: args.sharedBudget,
      timetable: args.timetable,
      calendarSessions: args.calendarSessions,
      startDate: args.startDate,
    });
  }

  const anyBudget = [...args.budgets.values()].some((value) => value > 0);
  if (!anyBudget) {
    return 0;
  }

  if (args.calendarSessions.length === 0) {
    return safeLeaveDaysFromSlots({
      budgets: args.budgets,
      timetable: args.timetable,
      startDate: args.startDate,
    });
  }

  const { leaveDays, remaining } = safeLeaveDaysFromSessions({
    budgets: args.budgets,
    calendarSessions: args.calendarSessions,
    startDate: args.startDate,
  });

  const lastSession = latestCalendarSession(args.calendarSessions);
  const budgetLeft = [...remaining.values()].some((value) => value > 0);

  if (!budgetLeft || !lastSession || args.timetable.length === 0) {
    return leaveDays;
  }

  const continuationStart = startOfDay(sessionStartDate(lastSession));
  continuationStart.setDate(continuationStart.getDate() + 1);

  return (
    leaveDays +
    safeLeaveDaysFromSlots({
      budgets: remaining,
      timetable: args.timetable,
      startDate: continuationStart,
    })
  );
}

/**
 * Days of attendance needed to clear every subject's recovery requirement.
 *
 * `beyondSchedule` is true when the known schedule ends before the target is
 * reached, so the UI can say the estimate runs past synced data instead of
 * implying certainty.
 */
function computeRecoveryDays(args: {
  needBySubject: Map<string, number>;
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  startDate?: Date;
}): { days: number; beyondSchedule: boolean } {
  const outstanding = new Map(
    [...args.needBySubject.entries()].filter(([, need]) => need > 0),
  );

  if (outstanding.size === 0) {
    return { days: 0, beyondSchedule: false };
  }

  let days = 0;

  const spend = (bySubject: Map<string, number>) => {
    for (const [subjectId, classes] of bySubject.entries()) {
      const need = outstanding.get(subjectId);
      if (need === undefined) {
        continue;
      }
      const left = need - classes;
      if (left <= 0) {
        outstanding.delete(subjectId);
      } else {
        outstanding.set(subjectId, left);
      }
    }
  };

  if (args.calendarSessions.length > 0) {
    const byDate = sessionsByDateAndSubject(args.calendarSessions, args.startDate);
    for (const dateKey of [...byDate.keys()].sort((a, b) => a.localeCompare(b))) {
      spend(byDate.get(dateKey)!);
      days += 1;
      if (outstanding.size === 0) {
        return { days, beyondSchedule: false };
      }
    }
  }

  if (args.timetable.length === 0) {
    return { days, beyondSchedule: outstanding.size > 0 };
  }

  const slotsByDay = new Map<number, Map<string, number>>();
  for (const slot of args.timetable) {
    const bySubject = slotsByDay.get(slot.dayOfWeek) ?? new Map<string, number>();
    bySubject.set(slot.subjectId, (bySubject.get(slot.subjectId) ?? 0) + 1);
    slotsByDay.set(slot.dayOfWeek, bySubject);
  }

  const lastSession = latestCalendarSession(args.calendarSessions);
  const cursor = lastSession
    ? startOfDay(sessionStartDate(lastSession))
    : startOfDay(args.startDate ?? new Date());
  if (lastSession) {
    cursor.setDate(cursor.getDate() + 1);
  }

  for (let i = 0; i < PROJECTION_DAY_LIMIT && outstanding.size > 0; i += 1) {
    const bySubject = slotsByDay.get(cursor.getDay());
    if (bySubject && bySubject.size > 0) {
      spend(bySubject);
      days += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return { days, beyondSchedule: outstanding.size > 0 };
}

/**
 * Overall mode: days of attendance needed to claw back a single pooled
 * shortfall. Every class counts, regardless of which subject it belongs to.
 */
function computeRecoveryDaysOverall(args: {
  classesNeeded: number;
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  startDate?: Date;
}): { days: number; beyondSchedule: boolean } {
  if (args.classesNeeded <= 0) {
    return { days: 0, beyondSchedule: false };
  }

  let outstanding = args.classesNeeded;
  let days = 0;

  if (args.calendarSessions.length > 0) {
    const byDate = sessionsByDateAndSubject(args.calendarSessions, args.startDate);
    for (const dateKey of [...byDate.keys()].sort((a, b) => a.localeCompare(b))) {
      const classes = [...byDate.get(dateKey)!.values()].reduce((sum, n) => sum + n, 0);
      outstanding -= classes;
      days += 1;
      if (outstanding <= 0) {
        return { days, beyondSchedule: false };
      }
    }
  }

  if (args.timetable.length === 0) {
    return { days, beyondSchedule: outstanding > 0 };
  }

  const classesByDay = new Map<number, number>();
  for (const slot of args.timetable) {
    classesByDay.set(slot.dayOfWeek, (classesByDay.get(slot.dayOfWeek) ?? 0) + 1);
  }

  const lastSession = latestCalendarSession(args.calendarSessions);
  const cursor = lastSession
    ? startOfDay(sessionStartDate(lastSession))
    : startOfDay(args.startDate ?? new Date());
  if (lastSession) {
    cursor.setDate(cursor.getDate() + 1);
  }

  for (let i = 0; i < PROJECTION_DAY_LIMIT && outstanding > 0; i += 1) {
    const classes = classesByDay.get(cursor.getDay()) ?? 0;
    if (classes > 0) {
      outstanding -= classes;
      days += 1;
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return { days, beyondSchedule: outstanding > 0 };
}

function totalsOf(subjects: Subject[]) {
  return {
    totalAttended: subjects.reduce((sum, s) => sum + s.attendedClasses, 0),
    totalHeld: subjects.reduce((sum, s) => sum + s.heldClasses, 0),
  };
}

export function buildDashboardData(input: {
  student: DashboardData["student"];
  policy: AttendancePolicy;
  subjects: Subject[];
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  timetableSync: TimetableSyncState;
  recentSimulation?: SimulationResult;
  erpSnapshot?: DashboardData["erpSnapshot"];
}): DashboardData {
  const threshold = input.policy.thresholdPercent;
  const { totalAttended, totalHeld } = totalsOf(input.subjects);

  const subjects: DashboardSubject[] = input.subjects.map((subject) => {
    const hasStarted = subject.heldClasses > 0;
    const attendancePercent = hasStarted
      ? computeAttendancePercent(subject.attendedClasses, subject.heldClasses)
      : 0;

    return {
      id: subject.id,
      code: subject.code,
      name: subject.name,
      type: subject.type,
      heldClasses: subject.heldClasses,
      attendedClasses: round(subject.attendedClasses),
      attendancePercent,
      nextMissDropPercent: computeNextMissDrop(
        subject.attendedClasses,
        subject.heldClasses,
      ),
      bunkableClasses: computeBunkableClasses(
        subject.attendedClasses,
        subject.heldClasses,
        threshold,
      ),
      recoveryClassesNeeded: computeRecoveryClassesNeeded(
        subject.attendedClasses,
        subject.heldClasses,
        threshold,
      ),
      severeMedicalEligible:
        hasStarted && attendancePercent >= input.policy.severeMedicalFloorPercent,
      status: hasStarted ? getSubjectStatus(attendancePercent, threshold) : "not-started",
    };
  });

  // Subjects with no classes held yet carry no information; including them
  // would force the minimum to 0 and report a false "not safe".
  const started = subjects.filter((subject) => subject.status !== "not-started");

  // Weakest subject drives the current policy verdict.
  const weakest = [...started].sort(
    (a, b) =>
      a.bunkableClasses - b.bunkableClasses ||
      a.attendancePercent - b.attendancePercent,
  )[0];

  const overallPercent = computeAttendancePercent(totalAttended, totalHeld);
  const overallBunkable = computeBunkableClasses(totalAttended, totalHeld, threshold);
  const overallRecovery = computeRecoveryClassesNeeded(totalAttended, totalHeld, threshold);
  const overallStatus = getSubjectStatus(overallPercent, threshold);

  const perSubject = input.policy.enforcePerSubject;

  const safeToMissClasses = started.length === 0
    ? 0
    : perSubject
      ? weakest.bunkableClasses
      : overallBunkable;

  const budgets = perSubject
    ? new Map(
        subjects.map((subject) => [
          subject.id,
          subject.status === "not-started"
            ? Number.POSITIVE_INFINITY
            : subject.bunkableClasses,
        ]),
      )
    : // Overall mode: any class counts against one shared budget, so give every
      // subject the same pool rather than an individual allowance.
      new Map(subjects.map((subject) => [subject.id, overallBunkable]));

  const averageAttendance =
    started.reduce((sum, subject) => sum + subject.attendancePercent, 0) /
    Math.max(started.length, 1);

  return {
    student: input.student,
    policy: input.policy,
    overall: {
      attendedClasses: round(totalAttended),
      heldClasses: round(totalHeld),
      attendancePercent: overallPercent,
      nextMissDropPercent: perSubject
        ? (weakest?.nextMissDropPercent ?? 0)
        : computeNextMissDrop(totalAttended, totalHeld),
      safeToMissClasses,
      safeLeaveDays: computeSafeLeaveDays({
        budgets,
        timetable: input.timetable,
        calendarSessions: input.calendarSessions,
        startDate: new Date(),
        sharedBudget: perSubject ? undefined : overallBunkable,
      }),
      recoveryClassesNeeded: perSubject
        ? started.reduce((sum, subject) => sum + subject.recoveryClassesNeeded, 0)
        : overallRecovery,
      status: started.length === 0
        ? "safe"
        : perSubject
          ? worstStatus(started.map((s) => s.status as RiskStatus))
          : overallStatus,
      weakestSubjectId: weakest?.id,
      weakestSubjectName: weakest?.name,
      weakestSubjectPercent: weakest?.attendancePercent,
    },
    subjects,
    timetable: input.timetable,
    calendarSessions: input.calendarSessions,
    timetableSync: input.timetableSync,
    recentSimulation: input.recentSimulation,
    erpSnapshot: input.erpSnapshot,
    insights: {
      averageAttendance: round(averageAttendance),
      belowThresholdCount: started.filter(
        (subject) => subject.attendancePercent < threshold,
      ).length,
      explanation: perSubject
        ? "Your weakest subject sets the planning margin against the published 75% per-subject target."
        : "Using aggregate attendance mode. Missing a class costs more early in the semester, when the total is still small.",
    },
  };
}

function dateRange(start: Date, end: Date) {
  const dates: Date[] = [];
  const cursor = startOfDay(start);
  const cap = startOfDay(end);

  while (cursor <= cap) {
    dates.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function sortSlotsByTime(slots: ScheduleSlot[]) {
  return [...slots].sort((a, b) => {
    if (a.dayOfWeek !== b.dayOfWeek) {
      return a.dayOfWeek - b.dayOfWeek;
    }

    return a.startTime.localeCompare(b.startTime);
  });
}

function upcomingSlotOccurrences(
  timetable: ScheduleSlot[],
  count: number,
  startDate?: Date,
) {
  if (count <= 0) {
    return [];
  }

  const orderedSlots = sortSlotsByTime(timetable);
  const occurrences: CalendarSession[] = [];
  const reference = startDate ?? new Date();
  const currentMinutes = reference.getHours() * 60 + reference.getMinutes();
  const cursor = startOfDay(reference);

  for (let i = 0; i < PROJECTION_DAY_LIMIT && occurrences.length < count; i += 1) {
    const isToday = i === 0;
    const daySlots = orderedSlots.filter((slot) => slot.dayOfWeek === cursor.getDay());

    for (const slot of daySlots) {
      if (occurrences.length >= count) {
        break;
      }

      // Classes already finished today cannot be skipped.
      if (isToday && parseTimeMinutes(slot.startTime) < currentMinutes) {
        continue;
      }

      occurrences.push(makeSessionFromSlot(slot, cursor));
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return occurrences;
}

function upcomingCalendarSessions(
  calendarSessions: CalendarSession[],
  count: number,
  startDate?: Date,
) {
  if (count <= 0) {
    return [];
  }

  const floor = startDate ?? new Date();

  return [...calendarSessions]
    .filter((session) => sessionStartDate(session) >= floor)
    .sort((a, b) => sessionStartDate(a).getTime() - sessionStartDate(b).getTime())
    .slice(0, count);
}

function requestedLeaveDates(startDate: Date, leaveDays: number) {
  if (leaveDays <= 0) {
    return [];
  }

  const endDate = startOfDay(startDate);
  endDate.setDate(endDate.getDate() + leaveDays - 1);
  return dateRange(startDate, endDate);
}

function moveSessionToDate(
  session: CalendarSession,
  targetDate: Date,
  inferredFromDate: string,
): CalendarSession {
  const date = toDateKey(targetDate);
  return {
    ...session,
    id: `estimated:${date}:${session.subjectId}:${session.startTime}:${session.endTime}`,
    date,
    dayOfWeek: targetDate.getDay(),
    estimated: true,
    inferredFromDate,
  };
}

/**
 * Selects a single dated schedule for this weekday. Different weeks can carry
 * different subjects, so combining them would create impossible overlapping
 * classes. Prefer the nearest prior occurrence; only look forward when there
 * is no historical example for that weekday.
 */
function weekdayTemplateForDate(
  calendarSessions: CalendarSession[],
  targetDate: Date,
) {
  const targetKey = toDateKey(targetDate);
  const byDate = new Map<string, CalendarSession[]>();

  for (const session of dedupeCalendarSessions(calendarSessions)) {
    if (session.date === targetKey || session.dayOfWeek !== targetDate.getDay()) {
      continue;
    }
    const group = byDate.get(session.date) ?? [];
    group.push(session);
    byDate.set(session.date, group);
  }

  const dates = [...byDate.keys()];
  const priorDate = dates
    .filter((date) => date < targetKey)
    .sort((a, b) => b.localeCompare(a))[0];
  const nextDate = dates
    .filter((date) => date > targetKey)
    .sort((a, b) => a.localeCompare(b))[0];
  const templateDate = priorDate ?? nextDate;

  return templateDate
    ? (byDate.get(templateDate) ?? []).map((session) =>
        moveSessionToDate(session, targetDate, templateDate),
      )
    : [];
}

function weeklySlotsForDate(timetable: ScheduleSlot[], targetDate: Date) {
  const uniqueByPeriod = new Map<string, ScheduleSlot>();

  for (const slot of sortSlotsByTime(timetable)) {
    if (slot.dayOfWeek !== targetDate.getDay()) {
      continue;
    }
    const periodKey = `${slot.startTime}|${slot.endTime}`;
    if (!uniqueByPeriod.has(periodKey)) {
      uniqueByPeriod.set(periodKey, slot);
    }
  }

  return [...uniqueByPeriod.values()].map((slot) => makeSessionFromSlot(slot, targetDate));
}

function sessionsForDates(args: {
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  dates: Date[];
}) {
  return args.dates.flatMap((day) => {
    const dateKey = toDateKey(day);
    const exactSessions = dedupeCalendarSessions(
      args.calendarSessions.filter((session) => session.date === dateKey),
    );

    // NIET's range endpoint is sparse: an empty future date often means that
    // classes are not published yet, not that the day is a confirmed holiday.
    // Exact rows win when present; otherwise use the recent recurring pattern.
    if (exactSessions.length > 0) {
      return exactSessions;
    }

    const datedTemplate = weekdayTemplateForDate(args.calendarSessions, day);
    if (datedTemplate.length > 0) {
      return datedTemplate;
    }

    // Manual or legacy stores may only contain a weekly timetable. Collapse
    // conflicting rows by period so one student is never assigned two classes
    // at the same time.
    return weeklySlotsForDate(args.timetable, day);
  });
}

function sessionsInWindow(args: {
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  from: Date;
  until: Date;
}) {
  if (args.until <= args.from) {
    return [];
  }

  const finalMoment = new Date(args.until.getTime() - 1);
  return sessionsForDates({
    timetable: args.timetable,
    calendarSessions: args.calendarSessions,
    dates: dateRange(startOfDay(args.from), startOfDay(finalMoment)),
  }).filter((session) => {
    const startsAt = sessionStartDate(session);
    return startsAt >= args.from && startsAt < args.until;
  });
}

function leaveProjectionEnd(request: SimulationRequest) {
  if (request.mode === "leave-days" && request.fromDate) {
    const end = startOfDay(parseDateKey(request.fromDate));
    end.setDate(end.getDate() + Math.max(0, request.leaveDays ?? 0));
    return end;
  }

  if (request.mode === "date-range" && request.toDate) {
    const end = startOfDay(parseDateKey(request.toDate));
    end.setDate(end.getDate() + 1);
    return end;
  }

  return null;
}

function sessionKey(session: CalendarSession) {
  return [
    session.date,
    session.subjectId,
    session.startTime,
    session.endTime,
    session.room ?? "",
  ].join("|");
}

function impactedSlotsFromRequest(
  timetable: ScheduleSlot[],
  calendarSessions: CalendarSession[],
  request: SimulationRequest,
  referenceDate = new Date(),
) {
  const hasExactSchedule = calendarSessions.length > 0;

  if (request.mode === "class-specific") {
    if (hasExactSchedule) {
      return calendarSessions.filter(
        (session) =>
          (!request.slotId || session.id === request.slotId) &&
          (!request.subjectId || session.subjectId === request.subjectId),
      );
    }

    const matches = timetable.filter(
      (slot) =>
        (!request.slotId || slot.id === request.slotId) &&
        (!request.subjectId || slot.subjectId === request.subjectId),
    );

    const today = new Date();
    return matches.map((slot) => makeSessionFromSlot(slot, today));
  }

  if (request.mode === "future-count") {
    const wanted = request.futureClasses ?? 0;
    const matchesSubject = (id: string) => !request.subjectId || id === request.subjectId;

    if (hasExactSchedule) {
      const exact = upcomingCalendarSessions(
        calendarSessions.filter((session) => matchesSubject(session.subjectId)),
        wanted,
        new Date(),
      );
      const remaining = Math.max(0, wanted - exact.length);
      const lastSession = latestCalendarSession(calendarSessions);
      if (remaining === 0 || !lastSession) {
        return fillRequestedFutureCount(exact, wanted, request.subjectId);
      }

      const continuationStart = startOfDay(sessionStartDate(lastSession));
      continuationStart.setDate(continuationStart.getDate() + 1);

      return fillRequestedFutureCount([
        ...exact,
        ...upcomingSlotOccurrences(
          timetable.filter((slot) => matchesSubject(slot.subjectId)),
          remaining,
          continuationStart,
        ),
      ], wanted, request.subjectId);
    }

    return fillRequestedFutureCount(
      upcomingSlotOccurrences(
        timetable.filter((slot) => matchesSubject(slot.subjectId)),
        wanted,
        new Date(),
      ),
      wanted,
      request.subjectId,
    );
  }

  if (request.mode === "leave-days") {
    const startDate = startOfDay(
      request.fromDate ? parseDateKey(request.fromDate) : new Date(),
    );
    const wantedDays = request.leaveDays ?? 0;
    const matchesSubject = (id: string) => !request.subjectId || id === request.subjectId;

    return sessionsForDates({
      timetable,
      calendarSessions,
      dates: requestedLeaveDates(startDate, wantedDays),
    }).filter(
      (session) =>
        sessionStartDate(session) >= referenceDate &&
        matchesSubject(session.subjectId) &&
        matchesLeaveDayPart(session.startTime, request.dayPart),
    );
  }

  // date-range
  if (!request.fromDate || !request.toDate) {
    return [];
  }

  return sessionsForDates({
    timetable,
    calendarSessions,
    dates: dateRange(
      parseDateKey(request.fromDate),
      parseDateKey(request.toDate),
    ),
  }).filter(
    (session) =>
      sessionStartDate(session) >= referenceDate &&
      (!request.subjectId || session.subjectId === request.subjectId),
  );
}

function projectionForSubject(args: {
  subject: Subject;
  policy: AttendancePolicy;
  classesAssumedAttended: number;
  classesMissed: number;
}): SubjectProjection {
  const beforePercent = computeAttendancePercent(
    args.subject.attendedClasses,
    args.subject.heldClasses,
  );
  // Non-leave sessions before the projection horizon are assumed attended;
  // leave sessions increase classes held without increasing attendance.
  const afterHeld =
    args.subject.heldClasses + args.classesAssumedAttended + args.classesMissed;
  const afterAttended = args.subject.attendedClasses + args.classesAssumedAttended;
  const afterPercent = computeAttendancePercent(afterAttended, afterHeld);

  return {
    subjectId: args.subject.id,
    subjectName: args.subject.name,
    beforeHeld: args.subject.heldClasses,
    beforeAttended: round(args.subject.attendedClasses),
    afterHeld,
    afterAttended: round(afterAttended),
    beforePercent,
    afterPercent,
    deltaPercent: round(beforePercent - afterPercent),
    classesMissed: args.classesMissed,
    bunkableClasses: computeBunkableClasses(
      afterAttended,
      afterHeld,
      args.policy.thresholdPercent,
    ),
    recoveryClassesNeeded: computeRecoveryClassesNeeded(
      afterAttended,
      afterHeld,
      args.policy.thresholdPercent,
    ),
    status: getSubjectStatus(afterPercent, args.policy.thresholdPercent),
  };
}

export function simulateAttendance(args: {
  policy: AttendancePolicy;
  subjects: Subject[];
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  request: SimulationRequest;
  /** Portal schedule coverage; dates inside it are exact even when class-free. */
  scheduleRangeStart?: string;
  scheduleRangeEnd?: string;
  /** Test seam for "today" and already-started class handling. */
  referenceDate?: Date;
}): SimulationResult {
  const threshold = args.policy.thresholdPercent;
  const referenceDate = args.referenceDate ?? new Date();
  const impactedSlots = impactedSlotsFromRequest(
    args.timetable,
    args.calendarSessions,
    args.request,
    referenceDate,
  );
  const projectionEnd = leaveProjectionEnd(args.request);
  const rangeStart = args.scheduleRangeStart
    ? startOfDay(parseDateKey(args.scheduleRangeStart))
    : null;
  const rangeEndExclusive = args.scheduleRangeEnd
    ? (() => {
        const end = startOfDay(parseDateKey(args.scheduleRangeEnd));
        end.setDate(end.getDate() + 1);
        return end;
      })()
    : null;
  const coveredFrom = rangeStart && rangeStart > referenceDate ? rangeStart : referenceDate;
  const coveredUntil = projectionEnd && rangeEndExclusive && rangeEndExclusive < projectionEnd
    ? rangeEndExclusive
    : projectionEnd;
  const scheduledThroughProjection = projectionEnd
    ? rangeStart && rangeEndExclusive && coveredUntil
      ? sessionsInWindow({
          timetable: args.timetable,
          calendarSessions: args.calendarSessions,
          from: coveredFrom,
          until: coveredUntil,
        })
      : dedupeCalendarSessions(args.calendarSessions).filter((session) => {
          const startsAt = sessionStartDate(session);
          return startsAt >= referenceDate && startsAt < projectionEnd;
        })
    : [];
  const impactedKeys = new Set(impactedSlots.map(sessionKey));
  const assumedAttendedSlots = scheduledThroughProjection.filter(
    (session) => !impactedKeys.has(sessionKey(session)),
  );
  const { totalAttended, totalHeld } = totalsOf(args.subjects);

  const classesMissedBySubject = impactedSlots.reduce<Record<string, number>>(
    (acc, slot) => {
      acc[slot.subjectId] = (acc[slot.subjectId] ?? 0) + 1;
      return acc;
    },
    {},
  );
  const totalMissedClasses = Object.values(classesMissedBySubject).reduce(
    (sum, count) => sum + count,
    0,
  );
  const classesAssumedAttendedBySubject = assumedAttendedSlots.reduce<
    Record<string, number>
  >((acc, slot) => {
    acc[slot.subjectId] = (acc[slot.subjectId] ?? 0) + 1;
    return acc;
  }, {});
  const totalAssumedAttended = assumedAttendedSlots.length;
  const scheduleSessions = [...impactedSlots, ...assumedAttendedSlots];
  const scheduleSourceDates = [...new Set(
    scheduleSessions
      .map((session) => session.inferredFromDate)
      .filter((date): date is string => Boolean(date)),
  )].sort((a, b) => b.localeCompare(a));

  const overallAfterAttended = totalAttended + totalAssumedAttended;
  const overallAfterHeld = totalHeld + totalAssumedAttended + totalMissedClasses;
  const overallBeforePercent = computeAttendancePercent(totalAttended, totalHeld);
  const overallAfterPercent = computeAttendancePercent(
    overallAfterAttended,
    overallAfterHeld,
  );

  const projections = args.subjects
    .filter((subject) => classesMissedBySubject[subject.id])
    .map((subject) =>
      projectionForSubject({
        subject,
        policy: args.policy,
        classesAssumedAttended: classesAssumedAttendedBySubject[subject.id] ?? 0,
        classesMissed: classesMissedBySubject[subject.id],
      }),
    );

  // Post-absence state for every subject, whether or not it was impacted.
  const afterSubjects = args.subjects.map((subject) => {
    const missed = classesMissedBySubject[subject.id] ?? 0;
    const assumedAttended = classesAssumedAttendedBySubject[subject.id] ?? 0;
    return {
      id: subject.id,
      name: subject.name,
      attended: subject.attendedClasses + assumedAttended,
      held: subject.heldClasses + assumedAttended + missed,
      started: subject.heldClasses + assumedAttended + missed > 0,
    };
  });

  const afterStarted = afterSubjects.filter((subject) => subject.started);
  const afterStatuses = afterStarted.map((subject) =>
    getSubjectStatus(computeAttendancePercent(subject.attended, subject.held), threshold),
  );

  const perSubject = args.policy.enforcePerSubject;

  const overallAfterBunkable = computeBunkableClasses(
    overallAfterAttended,
    overallAfterHeld,
    threshold,
  );
  const overallAfterRecovery = computeRecoveryClassesNeeded(
    overallAfterAttended,
    overallAfterHeld,
    threshold,
  );
  const overallAfterStatus = getSubjectStatus(overallAfterPercent, threshold);

  const budgets = perSubject
    ? new Map(
        afterSubjects.map((subject) => [
          subject.id,
          subject.started
            ? computeBunkableClasses(subject.attended, subject.held, threshold)
            : Number.POSITIVE_INFINITY,
        ]),
      )
    : new Map(afterSubjects.map((subject) => [subject.id, overallAfterBunkable]));

  const recoveryBySubject = perSubject
    ? new Map(
        afterSubjects.map((subject) => [
          subject.id,
          subject.started
            ? computeRecoveryClassesNeeded(subject.attended, subject.held, threshold)
            : 0,
        ]),
      )
    : // Overall mode: recovery is a single pool, so charge it against whichever
      // classes come next rather than to any one subject.
      new Map(
        afterSubjects.length > 0
          ? [[afterSubjects[0].id, overallAfterRecovery] as const]
          : [],
      );

  const overallRecoveryClassesNeeded = perSubject
    ? [...recoveryBySubject.values()].reduce((sum, need) => sum + need, 0)
    : overallAfterRecovery;

  const recovery = perSubject
    ? computeRecoveryDays({
        needBySubject: recoveryBySubject,
        timetable: args.timetable,
        calendarSessions: args.calendarSessions,
        startDate: projectionEnd ?? referenceDate,
      })
    : computeRecoveryDaysOverall({
        classesNeeded: overallAfterRecovery,
        timetable: args.timetable,
        calendarSessions: args.calendarSessions,
        startDate: projectionEnd ?? referenceDate,
      });

  // Weakest subject after the absence.
  const weakestAfter = [...afterStarted]
    .map((subject) => ({
      name: subject.name,
      percent: computeAttendancePercent(subject.attended, subject.held),
      headroom: computeBunkableClasses(subject.attended, subject.held, threshold),
    }))
    .sort((a, b) => a.headroom - b.headroom || a.percent - b.percent)[0];

  return {
    request: args.request,
    projections,
    impactedSlots,
    overall: {
      beforeAttended: round(totalAttended),
      beforeHeld: round(totalHeld),
      afterAttended: round(overallAfterAttended),
      afterHeld: round(overallAfterHeld),
      beforePercent: overallBeforePercent,
      afterPercent: overallAfterPercent,
      deltaPercent: round(overallBeforePercent - overallAfterPercent),
      classesAssumedAttended: totalAssumedAttended,
      classesMissed: totalMissedClasses,
      recoveryClassesNeeded: overallRecoveryClassesNeeded,
      recoveryDaysNeeded: recovery.days,
      recoveryBeyondSchedule: recovery.beyondSchedule,
      safeLeaveDaysRemaining: computeSafeLeaveDays({
        budgets,
        timetable: args.timetable,
        calendarSessions: args.calendarSessions,
        startDate: projectionEnd ?? referenceDate,
        sharedBudget: perSubject ? undefined : overallAfterBunkable,
      }),
      status: perSubject
        ? (afterStatuses.length > 0 ? worstStatus(afterStatuses) : "safe")
        : overallAfterStatus,
      weakestSubjectName: weakestAfter?.name,
      weakestSubjectPercent: weakestAfter?.percent,
    },
    summary: {
      impactedSubjects: projections.length,
      classesAssumedAttended: totalAssumedAttended,
      classesMissed: totalMissedClasses,
      thresholdBreaches: projections.filter(
        (projection) => projection.afterPercent < threshold,
      ).length,
      subjectsBelowThreshold: afterStarted.filter(
        (subject) => computeAttendancePercent(subject.attended, subject.held) < threshold,
      ).length,
      newThresholdBreaches: afterStarted.filter((subject) => {
        const afterPercent = computeAttendancePercent(subject.attended, subject.held);
        const original = args.subjects.find((candidate) => candidate.id === subject.id);
        const beforePercent = original
          ? computeAttendancePercent(original.attendedClasses, original.heldClasses)
          : 100;
        return afterPercent < threshold && beforePercent >= threshold;
      }).length,
      scheduleEstimated: scheduleSessions.some((session) => session.estimated),
      scheduleSourceDates,
    },
  };
}
