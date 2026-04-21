import {
  AttendanceAdjustment,
  AttendancePolicy,
  CalendarSession,
  DashboardData,
  DashboardSubject,
  ScheduleSlot,
  SimulationRequest,
  SimulationResult,
  Subject,
  SubjectProjection,
  TimetableSyncState,
} from "@/lib/types";

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1);
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

function latestCalendarSessionDate(calendarSessions: CalendarSession[]) {
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

export function computeBunkableClasses(
  attended: number,
  held: number,
  thresholdPercent: number,
) {
  if (held <= 0) {
    return 0;
  }

  const thresholdRatio = thresholdPercent / 100;
  const limit = Math.floor(attended / thresholdRatio - held);
  return Math.max(0, limit);
}

export function computeRecoveryClassesNeeded(
  attended: number,
  held: number,
  thresholdPercent: number,
) {
  const thresholdRatio = thresholdPercent / 100;

  if (held <= 0 || attended / held >= thresholdRatio) {
    return 0;
  }

  let recovery = 0;
  while ((attended + recovery) / (held + recovery) < thresholdRatio) {
    recovery += 1;
  }

  return recovery;
}

export function getSubjectStatus(
  percent: number,
  thresholdPercent: number,
): "safe" | "warning" | "critical" {
  if (percent < thresholdPercent) {
    return "critical";
  }

  if (percent < thresholdPercent + 5) {
    return "warning";
  }

  return "safe";
}

function sumApprovedCreditsForSubject(
  adjustments: AttendanceAdjustment[],
  subjectId: string,
) {
  return adjustments
    .filter(
      (adjustment) =>
        adjustment.approvalStatus === "approved" &&
        adjustment.subjectIds.includes(subjectId),
    )
    .reduce((sum, adjustment) => sum + adjustment.creditedClasses, 0);
}

function effectiveSubject(
  subject: Subject,
  adjustments: AttendanceAdjustment[],
) {
  const credited = sumApprovedCreditsForSubject(adjustments, subject.id);

  return {
    ...subject,
    effectiveAttended: subject.attendedClasses + credited,
  };
}

function computeSafeLeaveDaysFromSessions(args: {
  bunkableClasses: number;
  calendarSessions: CalendarSession[];
  startDate?: Date;
}) {
  if (args.bunkableClasses <= 0 || args.calendarSessions.length === 0) {
    return 0;
  }

  const countsByDate = args.calendarSessions.reduce<Map<string, number>>((acc, session) => {
    const sessionDate = sessionStartDate(session);
    if (args.startDate && sessionDate < args.startDate) {
      return acc;
    }
    acc.set(session.date, (acc.get(session.date) ?? 0) + 1);
    return acc;
  }, new Map());

  let remainingBunks = args.bunkableClasses;
  let leaveDays = 0;

  for (const [, classes] of [...countsByDate.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (remainingBunks < classes) {
      break;
    }
    remainingBunks -= classes;
    leaveDays += 1;
  }

  return leaveDays;
}

function computeSafeLeaveDaysFromSlots(args: {
  bunkableClasses: number;
  timetable: ScheduleSlot[];
  startDate?: Date;
}) {
  if (args.bunkableClasses <= 0 || args.timetable.length === 0) {
    return 0;
  }

  const classesByDay = args.timetable.reduce<Record<number, number>>((acc, slot) => {
    acc[slot.dayOfWeek] = (acc[slot.dayOfWeek] ?? 0) + 1;
    return acc;
  }, {});

  let remainingBunks = args.bunkableClasses;
  let leaveDays = 0;
  const cursor = new Date(args.startDate ?? new Date());
  cursor.setHours(0, 0, 0, 0);

  for (let i = 0; i < 180; i += 1) {
    const daySlots = classesByDay[cursor.getDay()] ?? 0;

    if (daySlots > 0) {
      if (remainingBunks < daySlots) {
        break;
      }

      remainingBunks -= daySlots;
      leaveDays += 1;
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return leaveDays;
}

function computeSafeLeaveDays(args: {
  bunkableClasses: number;
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  startDate?: Date;
}) {
  if (args.calendarSessions.length > 0) {
    const exactDays = computeSafeLeaveDaysFromSessions(args);
    const countsByDate = args.calendarSessions.reduce<Map<string, number>>((acc, session) => {
      const sessionDate = sessionStartDate(session);
      if (args.startDate && sessionDate < args.startDate) {
        return acc;
      }
      acc.set(session.date, (acc.get(session.date) ?? 0) + 1);
      return acc;
    }, new Map());
    const consumedClasses = [...countsByDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, exactDays)
      .reduce((sum, [, classes]) => sum + classes, 0);
    const remainingBunks = Math.max(0, args.bunkableClasses - consumedClasses);
    const lastSession = latestCalendarSessionDate(args.calendarSessions);

    if (remainingBunks <= 0 || !lastSession) {
      return exactDays;
    }

    const continuationStart = sessionStartDate(lastSession);
    continuationStart.setDate(continuationStart.getDate() + 1);
    continuationStart.setHours(0, 0, 0, 0);

    return (
      exactDays +
      computeSafeLeaveDaysFromSlots({
        bunkableClasses: remainingBunks,
        timetable: args.timetable,
        startDate: continuationStart,
      })
    );
  }

  return computeSafeLeaveDaysFromSlots(args);
}

function computeRecoveryDaysFromSessions(args: {
  recoveryClassesNeeded: number;
  calendarSessions: CalendarSession[];
  startDate?: Date;
}) {
  if (args.recoveryClassesNeeded <= 0 || args.calendarSessions.length === 0) {
    return 0;
  }

  const countsByDate = args.calendarSessions.reduce<Map<string, number>>((acc, session) => {
    const sessionDate = sessionStartDate(session);
    if (args.startDate && sessionDate < args.startDate) {
      return acc;
    }
    acc.set(session.date, (acc.get(session.date) ?? 0) + 1);
    return acc;
  }, new Map());

  let remaining = args.recoveryClassesNeeded;
  let days = 0;

  for (const [, classes] of [...countsByDate.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    remaining -= classes;
    days += 1;
    if (remaining <= 0) {
      break;
    }
  }

  return remaining > 0 ? days : days;
}

function computeRecoveryDaysFromSlots(args: {
  recoveryClassesNeeded: number;
  timetable: ScheduleSlot[];
  startDate?: Date;
}) {
  if (args.recoveryClassesNeeded <= 0 || args.timetable.length === 0) {
    return 0;
  }

  const classesByDay = args.timetable.reduce<Record<number, number>>((acc, slot) => {
    acc[slot.dayOfWeek] = (acc[slot.dayOfWeek] ?? 0) + 1;
    return acc;
  }, {});

  let remainingRecoveryClasses = args.recoveryClassesNeeded;
  let attendanceDays = 0;
  const cursor = new Date(args.startDate ?? new Date());
  cursor.setHours(0, 0, 0, 0);

  for (let i = 0; i < 180; i += 1) {
    const daySlots = classesByDay[cursor.getDay()] ?? 0;

    if (daySlots > 0) {
      remainingRecoveryClasses -= daySlots;
      attendanceDays += 1;

      if (remainingRecoveryClasses <= 0) {
        break;
      }
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return attendanceDays;
}

function computeRecoveryDays(args: {
  recoveryClassesNeeded: number;
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  startDate?: Date;
}) {
  if (args.calendarSessions.length > 0) {
    const exactDays = computeRecoveryDaysFromSessions(args);
    const countsByDate = args.calendarSessions.reduce<Map<string, number>>((acc, session) => {
      const sessionDate = sessionStartDate(session);
      if (args.startDate && sessionDate < args.startDate) {
        return acc;
      }
      acc.set(session.date, (acc.get(session.date) ?? 0) + 1);
      return acc;
    }, new Map());
    const recoveredClasses = [...countsByDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(0, exactDays)
      .reduce((sum, [, classes]) => sum + classes, 0);
    const remainingRecoveryClasses = Math.max(
      0,
      args.recoveryClassesNeeded - recoveredClasses,
    );
    const lastSession = latestCalendarSessionDate(args.calendarSessions);

    if (remainingRecoveryClasses <= 0 || !lastSession) {
      return exactDays;
    }

    const continuationStart = sessionStartDate(lastSession);
    continuationStart.setDate(continuationStart.getDate() + 1);
    continuationStart.setHours(0, 0, 0, 0);

    return (
      exactDays +
      computeRecoveryDaysFromSlots({
        recoveryClassesNeeded: remainingRecoveryClasses,
        timetable: args.timetable,
        startDate: continuationStart,
      })
    );
  }

  return computeRecoveryDaysFromSlots(args);
}

function computeEffectiveTotals(
  subjects: Subject[],
  adjustments: AttendanceAdjustment[],
) {
  const effectiveSubjects = subjects.map((subject) =>
    effectiveSubject(subject, adjustments),
  );

  return {
    effectiveSubjects,
    totalAttended: effectiveSubjects.reduce(
      (sum, subject) => sum + subject.effectiveAttended,
      0,
    ),
    totalHeld: subjects.reduce((sum, subject) => sum + subject.heldClasses, 0),
  };
}

export function buildDashboardData(input: {
  student: DashboardData["student"];
  policy: AttendancePolicy;
  subjects: Subject[];
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  timetableSync: TimetableSyncState;
  adjustments: AttendanceAdjustment[];
  recentSimulation?: SimulationResult;
  erpSnapshot?: DashboardData["erpSnapshot"];
}): DashboardData {
  const { effectiveSubjects, totalAttended, totalHeld } = computeEffectiveTotals(
    input.subjects,
    input.adjustments,
  );

  const subjects: DashboardSubject[] = input.subjects.map((subject, index) => {
    const effective = effectiveSubjects[index];
    const attendancePercent = computeAttendancePercent(
      effective.effectiveAttended,
      subject.heldClasses,
    );

    return {
      id: subject.id,
      code: subject.code,
      name: subject.name,
      type: subject.type,
      heldClasses: subject.heldClasses,
      attendedClasses: round(effective.effectiveAttended),
      attendancePercent,
      nextMissDropPercent: computeNextMissDrop(
        effective.effectiveAttended,
        subject.heldClasses,
      ),
      bunkableClasses: computeBunkableClasses(
        effective.effectiveAttended,
        subject.heldClasses,
        input.policy.thresholdPercent,
      ),
      recoveryClassesNeeded: computeRecoveryClassesNeeded(
        effective.effectiveAttended,
        subject.heldClasses,
        input.policy.thresholdPercent,
      ),
      severeMedicalEligible:
        attendancePercent >= input.policy.severeMedicalFloorPercent,
      status: getSubjectStatus(attendancePercent, input.policy.thresholdPercent),
    };
  });

  const averageAttendance =
    subjects.reduce((sum, subject) => sum + subject.attendancePercent, 0) /
    Math.max(subjects.length, 1);
  const overallAttendancePercent = computeAttendancePercent(totalAttended, totalHeld);
  const overallBunkableClasses = computeBunkableClasses(
    totalAttended,
    totalHeld,
    input.policy.thresholdPercent,
  );

  return {
    student: input.student,
    policy: input.policy,
    overall: {
      attendedClasses: round(totalAttended),
      heldClasses: round(totalHeld),
      attendancePercent: overallAttendancePercent,
      nextMissDropPercent: computeNextMissDrop(totalAttended, totalHeld),
      bunkableClasses: overallBunkableClasses,
      safeLeaveDays: computeSafeLeaveDays({
        bunkableClasses: overallBunkableClasses,
        timetable: input.timetable,
        calendarSessions: input.calendarSessions,
        startDate: new Date(),
      }),
      recoveryClassesNeeded: computeRecoveryClassesNeeded(
        totalAttended,
        totalHeld,
        input.policy.thresholdPercent,
      ),
      status: getSubjectStatus(
        overallAttendancePercent,
        input.policy.thresholdPercent,
      ),
    },
    subjects,
    timetable: input.timetable,
    calendarSessions: input.calendarSessions,
    timetableSync: input.timetableSync,
    adjustments: input.adjustments,
    recentSimulation: input.recentSimulation,
    erpSnapshot: input.erpSnapshot,
    insights: {
      averageAttendance: round(averageAttendance),
      belowThresholdCount: subjects.filter(
        (subject) => subject.attendancePercent < input.policy.thresholdPercent,
      ).length,
      explanation:
        "Missing one class hurts more early in the semester because the denominator is smaller. The app now uses the portal's dated schedule for leave-day predictions whenever that data is available.",
    },
  };
}

function dateRange(start: Date, end: Date) {
  const dates: Date[] = [];
  const cursor = new Date(start);
  cursor.setHours(0, 0, 0, 0);
  const cap = new Date(end);
  cap.setHours(0, 0, 0, 0);

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
  const cursor = new Date(startDate ?? new Date());
  const currentMinutes = cursor.getHours() * 60 + cursor.getMinutes();
  cursor.setHours(0, 0, 0, 0);

  for (let i = 0; i < 180 && occurrences.length < count; i += 1) {
    const isToday = i === 0;
    const daySlots = orderedSlots.filter((slot) => slot.dayOfWeek === cursor.getDay());

    for (const slot of daySlots) {
      if (occurrences.length >= count) {
        break;
      }

      if (isToday) {
        const slotMinutes = parseTimeMinutes(slot.startTime);
        if (slotMinutes < currentMinutes) {
          continue;
        }
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
  const days = dateRange(startDate, endDate);
  return days.flatMap((day) =>
    timetable
      .filter((slot) => {
        const normalized = day.getDay();
        return (
          slot.dayOfWeek === normalized &&
          (!subjectId || slot.subjectId === subjectId)
        );
      })
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
  const cursor = new Date(startDate ?? new Date());
  cursor.setHours(0, 0, 0, 0);

  for (let i = 0; i < 180 && dates.length < leaveDays; i += 1) {
    const hasClasses = timetable.some((slot) => slot.dayOfWeek === cursor.getDay());
    if (hasClasses) {
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

  const floor = new Date(startDate ?? new Date());
  floor.setHours(0, 0, 0, 0);

  return [...new Set(
    calendarSessions
      .filter((session) => parseDateKey(session.date) >= floor)
      .map((session) => session.date),
  )]
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
    if (hasExactSchedule) {
      const exact = upcomingCalendarSessions(
        calendarSessions.filter(
          (session) => !request.subjectId || session.subjectId === request.subjectId,
        ),
        request.futureClasses ?? 0,
        new Date(),
      );
      const remaining = Math.max(0, (request.futureClasses ?? 0) - exact.length);
      if (remaining === 0) {
        return exact;
      }

      const lastSession = latestCalendarSessionDate(calendarSessions);
      if (!lastSession) {
        return exact;
      }

      const continuationStart = sessionStartDate(lastSession);
      continuationStart.setDate(continuationStart.getDate() + 1);
      continuationStart.setHours(0, 0, 0, 0);

      return [
        ...exact,
        ...upcomingSlotOccurrences(
          timetable.filter((slot) => !request.subjectId || slot.subjectId === request.subjectId),
          remaining,
          continuationStart,
        ),
      ];
    }

    return upcomingSlotOccurrences(
      timetable.filter((slot) => !request.subjectId || slot.subjectId === request.subjectId),
      request.futureClasses ?? 0,
      new Date(),
    );
  }

  if (request.mode === "leave-days") {
    const startDate = request.fromDate ? new Date(request.fromDate) : new Date();
    startDate.setHours(0, 0, 0, 0);

    if (hasExactSchedule) {
      const days = upcomingDatesWithClassesFromSessions(
        calendarSessions,
        request.leaveDays ?? 0,
        startDate,
      );

      const dayKeys = new Set(days.map((date) => toDateKey(date)));
      const exact = calendarSessions.filter(
        (session) =>
          dayKeys.has(session.date) &&
          (!request.subjectId || session.subjectId === request.subjectId),
      );
      const remainingDays = Math.max(0, (request.leaveDays ?? 0) - days.length);
      if (remainingDays === 0) {
        return exact;
      }

      const lastSession = latestCalendarSessionDate(calendarSessions);
      if (!lastSession) {
        return exact;
      }

      const continuationStart = sessionStartDate(lastSession);
      continuationStart.setDate(continuationStart.getDate() + 1);
      continuationStart.setHours(0, 0, 0, 0);
      if (continuationStart < startDate) {
        continuationStart.setTime(startDate.getTime());
      }
      const fallbackDays = upcomingDatesWithClassesFromSlots(
        timetable,
        remainingDays,
        continuationStart,
      );

      return [
        ...exact,
        ...fallbackDays.flatMap((day) =>
          timetable
            .filter((slot) => {
              const normalized = day.getDay();
              return (
                slot.dayOfWeek === normalized &&
                (!request.subjectId || slot.subjectId === request.subjectId)
              );
            })
            .map((slot) => makeSessionFromSlot(slot, day)),
        ),
      ];
    }

    const days = upcomingDatesWithClassesFromSlots(
      timetable,
      request.leaveDays ?? 0,
      startDate,
    );

    return days.flatMap((day) =>
      timetable
        .filter((slot) => {
          const normalized = day.getDay();
          return (
            slot.dayOfWeek === normalized &&
            (!request.subjectId || slot.subjectId === request.subjectId)
          );
        })
        .map((slot) => makeSessionFromSlot(slot, day)),
    );
  }

  if (!request.fromDate || !request.toDate) {
    return [];
  }

  if (hasExactSchedule) {
    const fromDate = request.fromDate;
    const toDate = request.toDate;
    const exact = calendarSessions.filter(
      (session) =>
        session.date >= fromDate &&
        session.date <= toDate &&
        (!request.subjectId || session.subjectId === request.subjectId),
    );
    const lastSession = latestCalendarSessionDate(calendarSessions);
    if (!lastSession || toDate <= lastSession.date) {
      return exact;
    }

    const continuationStart = sessionStartDate(lastSession);
    continuationStart.setDate(continuationStart.getDate() + 1);
    continuationStart.setHours(0, 0, 0, 0);
    const requestedStart = new Date(fromDate);
    requestedStart.setHours(0, 0, 0, 0);
    if (continuationStart < requestedStart) {
      continuationStart.setTime(requestedStart.getTime());
    }

    return [
      ...exact,
      ...weeklyOccurrencesBetweenDates(
        timetable,
        continuationStart,
        new Date(toDate),
        request.subjectId,
      ),
    ];
  }

  const days = dateRange(new Date(request.fromDate), new Date(request.toDate));

  return days.flatMap((day) =>
    timetable
      .filter((slot) => {
        const normalized = day.getDay();
        return (
          slot.dayOfWeek === normalized &&
          (!request.subjectId || slot.subjectId === request.subjectId)
        );
      })
      .map((slot) => makeSessionFromSlot(slot, day)),
  );
}

function projectionForSubject(args: {
  subject: Subject;
  adjustments: AttendanceAdjustment[];
  policy: AttendancePolicy;
  classesMissed: number;
}): SubjectProjection {
  const effective = effectiveSubject(args.subject, args.adjustments);
  const beforePercent = computeAttendancePercent(
    effective.effectiveAttended,
    args.subject.heldClasses,
  );
  const afterHeld = args.subject.heldClasses + args.classesMissed;
  const afterAttended = effective.effectiveAttended;
  const afterPercent = computeAttendancePercent(afterAttended, afterHeld);

  return {
    subjectId: args.subject.id,
    subjectName: args.subject.name,
    beforeHeld: args.subject.heldClasses,
    beforeAttended: round(effective.effectiveAttended),
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
  adjustments: AttendanceAdjustment[];
  request: SimulationRequest;
}): SimulationResult {
  const impactedSlots = impactedSlotsFromRequest(
    args.timetable,
    args.calendarSessions,
    args.request,
  );
  const { totalAttended, totalHeld } = computeEffectiveTotals(
    args.subjects,
    args.adjustments,
  );
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
  const overallAfterAttended = totalAttended;
  const overallBeforePercent = computeAttendancePercent(totalAttended, totalHeld);
  const overallAfterPercent = computeAttendancePercent(
    overallAfterAttended,
    overallAfterHeld,
  );
  const overallRecoveryClassesNeeded = computeRecoveryClassesNeeded(
    overallAfterAttended,
    overallAfterHeld,
    args.policy.thresholdPercent,
  );

  const projections = args.subjects
    .filter((subject) => classesMissedBySubject[subject.id])
    .map((subject) =>
      projectionForSubject({
        subject,
        adjustments: args.adjustments,
        policy: args.policy,
        classesMissed: classesMissedBySubject[subject.id],
      }),
    );

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
      classesMissed: totalMissedClasses,
      recoveryClassesNeeded: overallRecoveryClassesNeeded,
      recoveryDaysNeeded: computeRecoveryDays({
        recoveryClassesNeeded: overallRecoveryClassesNeeded,
        timetable: args.timetable,
        calendarSessions: args.calendarSessions,
        startDate: new Date(),
      }),
      safeLeaveDaysRemaining: computeSafeLeaveDays({
        bunkableClasses: computeBunkableClasses(
          overallAfterAttended,
          overallAfterHeld,
          args.policy.thresholdPercent,
        ),
        timetable: args.timetable,
        calendarSessions: args.calendarSessions,
        startDate: new Date(),
      }),
      status: getSubjectStatus(overallAfterPercent, args.policy.thresholdPercent),
    },
    summary: {
      impactedSubjects: projections.length,
      classesMissed: totalMissedClasses,
      thresholdBreaches: projections.filter(
        (projection) => projection.afterPercent < args.policy.thresholdPercent,
      ).length,
    },
  };
}
