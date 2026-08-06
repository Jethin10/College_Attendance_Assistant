import type { CalendarSession, ScheduleSlot } from "@/lib/types";

/** Convert NIET's 12/24-hour timetable values to sortable 24-hour time. */
export function normalizePortalTime(raw?: string): string | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d{1,2}):(\d{2})(?:\s*([ap]m))?/i);
  if (!match) {
    return null;
  }

  let hours = Number(match[1]);
  const minutes = Number(match[2]);
  const meridiem = match[3]?.toLowerCase();

  if (meridiem) {
    if (hours < 1 || hours > 12) {
      return null;
    }
    hours %= 12;
    if (meridiem === "pm") {
      hours += 12;
    }
  }

  if (hours > 23 || minutes > 59) {
    return null;
  }

  return `${`${hours}`.padStart(2, "0")}:${`${minutes}`.padStart(2, "0")}`;
}

/**
 * NIET uses two response shapes for schedules:
 * - range endpoint: a flat array of timetable rows
 * - today endpoint: `[{ timetable: [...] }]`
 *
 * Flatten both without assuming any branch, section, semester, or year fields.
 */
export function extractPortalTimetableRows<T extends { lectureDate?: string }>(
  payload: unknown,
  fallbackLectureDate?: string,
): T[] {
  if (!Array.isArray(payload)) {
    return [];
  }

  return payload.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const container = item as { timetable?: unknown };
    const candidates = Array.isArray(container.timetable) ? container.timetable : [item];

    return candidates.flatMap((candidate) => {
      if (!candidate || typeof candidate !== "object") {
        return [];
      }
      const row = candidate as T;
      return [{
        ...row,
        lectureDate: row.lectureDate ?? fallbackLectureDate,
      }];
    });
  });
}

/**
 * JUNO can return duplicate rows for co-faculty, room changes, or repeated API
 * calls. Those collapse to one session.
 *
 * Subject IS part of the key: NIET legitimately schedules two different
 * subjects in the same window (parallel lab batches, split sections), and a
 * subject-blind key silently dropped the extra class — turning a 9-period
 * Thursday into 8 and under-reporting the cost of a leave day.
 */
export function dedupeCalendarSessions(
  sessions: CalendarSession[],
): CalendarSession[] {
  const unique = new Map<string, CalendarSession>();

  for (const session of [...sessions].sort(
    (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
  )) {
    const key = [session.subjectId, session.date, session.startTime, session.endTime].join("|");
    if (!unique.has(key)) {
      unique.set(key, session);
    }
  }

  return [...unique.values()];
}

/**
 * Builds one coherent weekly template from dated portal data.
 *
 * The old implementation unioned every subject ever seen at a weekday/time.
 * When Thursday's subjects changed between weeks, that produced fifteen slots
 * from two real eight-period days. Instead, each weekday now comes wholly from
 * its most recent dated occurrence, regardless of branch, section, or year.
 */
export function buildCoherentWeeklyTimetable(
  sessions: CalendarSession[],
): ScheduleSlot[] {
  const byDate = new Map<string, CalendarSession[]>();

  for (const session of dedupeCalendarSessions(sessions)) {
    const group = byDate.get(session.date) ?? [];
    group.push(session);
    byDate.set(session.date, group);
  }

  const latestByWeekday = new Map<number, { date: string; sessions: CalendarSession[] }>();
  for (const [date, datedSessions] of byDate) {
    const dayOfWeek = datedSessions[0]?.dayOfWeek;
    if (dayOfWeek === undefined) {
      continue;
    }

    const current = latestByWeekday.get(dayOfWeek);
    if (!current || date > current.date) {
      latestByWeekday.set(dayOfWeek, { date, sessions: datedSessions });
    }
  }

  return [...latestByWeekday.values()]
    .flatMap(({ sessions: datedSessions }) =>
      datedSessions.map((session) => ({
        id: `slot:${session.subjectId}:${session.dayOfWeek}:${session.startTime}:${session.endTime}`,
        subjectId: session.subjectId,
        dayOfWeek: session.dayOfWeek,
        startTime: session.startTime,
        endTime: session.endTime,
        room: session.room,
      })),
    )
    .sort(
      (a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime),
    );
}
