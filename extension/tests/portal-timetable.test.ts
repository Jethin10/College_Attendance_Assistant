import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCoherentWeeklyTimetable,
  dedupeCalendarSessions,
  extractPortalTimetableRows,
  normalizePortalTime,
} from "@/lib/portal-timetable";
import type { CalendarSession } from "@/lib/types";

function portalSession(
  id: string,
  subjectId: string,
  date: string,
  startTime: string,
): CalendarSession {
  return {
    id,
    subjectId,
    subjectCode: subjectId.toUpperCase(),
    subjectName: subjectId,
    date,
    dayOfWeek: new Date(`${date}T00:00:00`).getDay(),
    startTime,
    endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`,
    source: "portal",
  };
}

test("normalizes NIET AM/PM timetable values to 24-hour time", () => {
  assert.equal(normalizePortalTime("09:10 AM"), "09:10");
  assert.equal(normalizePortalTime("12:30 PM"), "12:30");
  assert.equal(normalizePortalTime("01:30 PM"), "13:30");
  assert.equal(normalizePortalTime("12:05 AM"), "00:05");
});

test("rejects malformed timetable values", () => {
  assert.equal(normalizePortalTime("25:00"), null);
  assert.equal(normalizePortalTime("13:00 PM"), null);
  assert.equal(normalizePortalTime(undefined), null);
});

test("extracts the nested timetable returned by NIET's today endpoint", () => {
  const rows = extractPortalTimetableRows<{
    lectureDate?: string;
    subShortName?: string;
    startTimeHM?: string;
  }>([
    {
      timetable: [
        { subShortName: "ME701", startTimeHM: "09:10:00" },
        { subShortName: "MBAF201", startTimeHM: "10:00:00" },
      ],
    },
  ], "Aug 06,2026");

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.lectureDate), ["Aug 06,2026", "Aug 06,2026"]);
  assert.deepEqual(rows.map((row) => row.subShortName), ["ME701", "MBAF201"]);
});

test("deduplicates repeated portal rows for the same student period", () => {
  const original = portalSession("one", "mba-finance", "2027-08-12", "09:00");
  const duplicate = { ...original, id: "two", faculty: "Co-faculty" };

  assert.deepEqual(dedupeCalendarSessions([original, duplicate]), [original]);
});

test("uses one recent weekday schedule instead of merging rotating weeks", () => {
  const older = Array.from({ length: 8 }, (_, index) =>
    portalSession(`older-${index}`, "mechanical-a", "2026-07-23", `${9 + index}:00`),
  );
  const newer = Array.from({ length: 8 }, (_, index) =>
    portalSession(`newer-${index}`, "mba-finance-b", "2026-07-30", `${9 + index}:00`),
  );

  const timetable = buildCoherentWeeklyTimetable([...older, ...newer]);
  const thursday = timetable.filter((slot) => slot.dayOfWeek === 4);

  assert.equal(thursday.length, 8);
  assert.ok(thursday.every((slot) => slot.subjectId === "mba-finance-b"));
});
