/**
 * Attendance engine.
 *
 * The verdict is driven by OVERALL attendance, which is what NIET enforces in
 * practice and what the ERP displays.
 *
 * The signed Attendance Policy 2025-26 (section 1) also requires 75% in each
 * theory and practical subject individually, but that clause is not currently
 * enforced. Reporting on it as the verdict would tell students they are unsafe
 * when the institute considers them fine, so per-subject shortfalls are kept as
 * an advisory note instead. `policy.enforcePerSubject` flips the verdict back
 * to the weakest subject if that ever changes.
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
  };
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

  // Weakest subject — advisory context, and the verdict only when the
  // per-subject clause is being enforced.
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
        ? "Your weakest subject sets the limit, because 75% is required in each subject individually."
        : "Based on your overall attendance, which is what the institute enforces. Missing a class costs more early in the semester, when the total is still small.",
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

function weeklyOccurrencesBetweenDates(
  timetable: ScheduleSlot[],
  startDate: Date,
  endDate: Date,
  subjectId?: string,
) {
  return dateRange(startDate, endDate).flatMap((day) =>
    timetable
      .filter(
        (slot) =>
          slot.dayOfWeek === day.getDay() &&
          (!subjectId || slot.subjectId === subjectId),
      )
      .map((slot) => makeSessionFromSlot(slot, day)),
  );
}

function upcomingDatesWithClassesFromSlots(
  timetable: ScheduleSlot[],
  leaveDays: number,
  startDate?: Date,
) {
  if (leaveDays <= 0) {
    return [];
  }

  const dates: Date[] = [];
  const cursor = startOfDay(startDate ?? new Date());

  for (let i = 0; i < PROJECTION_DAY_LIMIT && dates.length < leaveDays; i += 1) {
    if (timetable.some((slot) => slot.dayOfWeek === cursor.getDay())) {
      dates.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }

  return dates;
}

function upcomingDatesWithClassesFromSessions(
  calendarSessions: CalendarSession[],
  leaveDays: number,
  startDate?: Date,
) {
  if (leaveDays <= 0) {
    return [];
  }

  const floor = startOfDay(startDate ?? new Date());

  return [
    ...new Set(
      calendarSessions
        .filter((session) => parseDateKey(session.date) >= floor)
        .map((session) => session.date),
    ),
  ]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, leaveDays)
    .map((dateKey) => parseDateKey(dateKey));
}

function impactedSlotsFromRequest(
  timetable: ScheduleSlot[],
  calendarSessions: CalendarSession[],
  request: SimulationRequest,
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
        return exact;
      }

      const continuationStart = startOfDay(sessionStartDate(lastSession));
      continuationStart.setDate(continuationStart.getDate() + 1);

      return [
        ...exact,
        ...upcomingSlotOccurrences(
          timetable.filter((slot) => matchesSubject(slot.subjectId)),
          remaining,
          continuationStart,
        ),
      ];
    }

    return upcomingSlotOccurrences(
      timetable.filter((slot) => matchesSubject(slot.subjectId)),
      wanted,
      new Date(),
    );
  }

  if (request.mode === "leave-days") {
    const startDate = startOfDay(
      request.fromDate ? parseDateKey(request.fromDate) : new Date(),
    );
    const wantedDays = request.leaveDays ?? 0;
    const matchesSubject = (id: string) => !request.subjectId || id === request.subjectId;

    if (hasExactSchedule) {
      const days = upcomingDatesWithClassesFromSessions(
        calendarSessions,
        wantedDays,
        startDate,
      );
      const dayKeys = new Set(days.map((date) => toDateKey(date)));
      const exact = calendarSessions.filter(
        (session) => dayKeys.has(session.date) && matchesSubject(session.subjectId),
      );

      const remainingDays = Math.max(0, wantedDays - days.length);
      const lastSession = latestCalendarSession(calendarSessions);
      if (remainingDays === 0 || !lastSession) {
        return exact;
      }

      const continuationStart = startOfDay(sessionStartDate(lastSession));
      continuationStart.setDate(continuationStart.getDate() + 1);
      if (continuationStart < startDate) {
        continuationStart.setTime(startDate.getTime());
      }

      return [
        ...exact,
        ...upcomingDatesWithClassesFromSlots(
          timetable,
          remainingDays,
          continuationStart,
        ).flatMap((day) =>
          timetable
            .filter(
              (slot) =>
                slot.dayOfWeek === day.getDay() && matchesSubject(slot.subjectId),
            )
            .map((slot) => makeSessionFromSlot(slot, day)),
        ),
      ];
    }

    return upcomingDatesWithClassesFromSlots(timetable, wantedDays, startDate).flatMap(
      (day) =>
        timetable
          .filter(
            (slot) => slot.dayOfWeek === day.getDay() && matchesSubject(slot.subjectId),
          )
          .map((slot) => makeSessionFromSlot(slot, day)),
    );
  }

  // date-range
  if (!request.fromDate || !request.toDate) {
    return [];
  }

  const fromKey = request.fromDate;
  const toKey = request.toDate;

  if (hasExactSchedule) {
    const exact = calendarSessions.filter(
      (session) =>
        session.date >= fromKey &&
        session.date <= toKey &&
        (!request.subjectId || session.subjectId === request.subjectId),
    );
    const lastSession = latestCalendarSession(calendarSessions);
    if (!lastSession || toKey <= lastSession.date) {
      return exact;
    }

    const continuationStart = startOfDay(sessionStartDate(lastSession));
    continuationStart.setDate(continuationStart.getDate() + 1);
    const requestedStart = startOfDay(parseDateKey(fromKey));
    if (continuationStart < requestedStart) {
      continuationStart.setTime(requestedStart.getTime());
    }

    return [
      ...exact,
      ...weeklyOccurrencesBetweenDates(
        timetable,
        continuationStart,
        parseDateKey(toKey),
        request.subjectId,
      ),
    ];
  }

  return weeklyOccurrencesBetweenDates(
    timetable,
    parseDateKey(fromKey),
    parseDateKey(toKey),
    request.subjectId,
  );
}

function projectionForSubject(args: {
  subject: Subject;
  policy: AttendancePolicy;
  classesMissed: number;
}): SubjectProjection {
  const beforePercent = computeAttendancePercent(
    args.subject.attendedClasses,
    args.subject.heldClasses,
  );
  // A missed class increases classes held but not classes attended.
  const afterHeld = args.subject.heldClasses + args.classesMissed;
  const afterAttended = args.subject.attendedClasses;
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
}): SimulationResult {
  const threshold = args.policy.thresholdPercent;
  const impactedSlots = impactedSlotsFromRequest(
    args.timetable,
    args.calendarSessions,
    args.request,
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

  const overallAfterHeld = totalHeld + totalMissedClasses;
  const overallBeforePercent = computeAttendancePercent(totalAttended, totalHeld);
  const overallAfterPercent = computeAttendancePercent(totalAttended, overallAfterHeld);

  const projections = args.subjects
    .filter((subject) => classesMissedBySubject[subject.id])
    .map((subject) =>
      projectionForSubject({
        subject,
        policy: args.policy,
        classesMissed: classesMissedBySubject[subject.id],
      }),
    );

  // Post-absence state for every subject, whether or not it was impacted.
  const afterSubjects = args.subjects.map((subject) => {
    const missed = classesMissedBySubject[subject.id] ?? 0;
    return {
      id: subject.id,
      name: subject.name,
      attended: subject.attendedClasses,
      held: subject.heldClasses + missed,
      started: subject.heldClasses > 0,
    };
  });

  const afterStarted = afterSubjects.filter((subject) => subject.started);
  const afterStatuses = afterStarted.map((subject) =>
    getSubjectStatus(computeAttendancePercent(subject.attended, subject.held), threshold),
  );

  const perSubject = args.policy.enforcePerSubject;

  const overallAfterBunkable = computeBunkableClasses(
    totalAttended,
    overallAfterHeld,
    threshold,
  );
  const overallAfterRecovery = computeRecoveryClassesNeeded(
    totalAttended,
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
        startDate: new Date(),
      })
    : computeRecoveryDaysOverall({
        classesNeeded: overallAfterRecovery,
        timetable: args.timetable,
        calendarSessions: args.calendarSessions,
        startDate: new Date(),
      });

  // Weakest subject after the absence — advisory unless per-subject is enforced.
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
      afterAttended: round(totalAttended),
      afterHeld: round(overallAfterHeld),
      beforePercent: overallBeforePercent,
      afterPercent: overallAfterPercent,
      deltaPercent: round(overallBeforePercent - overallAfterPercent),
      classesMissed: totalMissedClasses,
      recoveryClassesNeeded: overallRecoveryClassesNeeded,
      recoveryDaysNeeded: recovery.days,
      recoveryBeyondSchedule: recovery.beyondSchedule,
      safeLeaveDaysRemaining: computeSafeLeaveDays({
        budgets,
        timetable: args.timetable,
        calendarSessions: args.calendarSessions,
        startDate: new Date(),
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
      classesMissed: totalMissedClasses,
      thresholdBreaches: projections.filter(
        (projection) => projection.afterPercent < threshold,
      ).length,
    },
  };
}
