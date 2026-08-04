/**
 * Storage reconciliation tests.
 *
 * Calendar sessions arrive from the timetable feed keyed by course code, while
 * subjects are keyed by a semester-namespaced id. If those are only matched at
 * timetable-sync time, then syncing attendance afterwards renames every
 * subject id and orphans the sessions — the simulator then attributes missed
 * classes to whichever subject still happens to match and reports the rest as
 * unaffected. These tests pin the order-independence.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { reconcileSessionsToSubjects } from "@/lib/storage";
import type { CalendarSession, Subject } from "@/lib/types";

function subject(id: string, code: string, name: string): Subject {
  return { id, code, name, type: "theory", heldClasses: 40, attendedClasses: 34 };
}

function session(subjectId: string, subjectCode: string, subjectName: string): CalendarSession {
  return {
    id: `${subjectId}-1`,
    subjectId,
    subjectCode,
    subjectName,
    date: "2026-08-06",
    dayOfWeek: 4,
    startTime: "09:00",
    endTime: "10:00",
    source: "portal",
  };
}

test("matches sessions to semester-namespaced subject ids by code", () => {
  const subjects = [
    subject("sem5:acse0403", "ACSE0403", "Object Oriented Techniques using Java"),
    subject("sem5:acse0401", "ACSE0401", "Artificial Intelligence"),
  ];

  const sessions = [
    session("acse0403", "ACSE0403", "OOPS"),
    session("acse0401", "ACSE0401", "AI"),
  ];

  const reconciled = reconcileSessionsToSubjects(sessions, subjects);

  assert.equal(reconciled[0].subjectId, "sem5:acse0403");
  assert.equal(reconciled[1].subjectId, "sem5:acse0401");
});

test("falls back to matching on subject name when codes differ", () => {
  // The timetable feed often carries a short name where the attendance table
  // carries a formal course code, so the two never match on code alone.
  const subjects = [
    subject("sem5:acse0403", "ACSE0403", "Object Oriented Techniques using Java"),
    subject("sem5:acse0552", "ACSE0552", "Artificial Intelligence Lab"),
  ];

  const sessions = [
    session("oops", "OOPS", "Object Oriented Techniques using Java"),
    session("ailab", "AILAB", "Artificial Intelligence Lab"),
  ];

  const reconciled = reconcileSessionsToSubjects(sessions, subjects);

  assert.equal(reconciled[0].subjectId, "sem5:acse0403");
  assert.equal(reconciled[1].subjectId, "sem5:acse0552");
});

test("does not collapse unrelated sessions onto one subject", () => {
  // The old prefix-matching fallback returned the first loose match, which
  // could funnel every unmatched session into a single subject and make one
  // subject look like it absorbed the entire absence.
  const subjects = [
    subject("sem5:acse0403", "ACSE0403", "Object Oriented Techniques using Java"),
  ];

  const sessions = [
    session("unknown", "unknown", "Unknown A"),
    session("unknown", "unknown", "Unknown B"),
    session("acse0403", "ACSE0403", "OOPS"),
  ];

  const reconciled = reconcileSessionsToSubjects(sessions, subjects);
  const matched = reconciled.filter((s) => s.subjectId === "sem5:acse0403");

  assert.equal(matched.length, 1, "only the genuine OOPS session may match");
  assert.notEqual(reconciled[0].subjectId, "sem5:acse0403");
  assert.notEqual(reconciled[1].subjectId, "sem5:acse0403");
});

test("reconciliation is idempotent", () => {
  const subjects = [subject("sem5:acse0403", "ACSE0403", "OOP with Java")];
  const sessions = [session("acse0403", "ACSE0403", "OOP with Java")];

  const once = reconcileSessionsToSubjects(sessions, subjects);
  const twice = reconcileSessionsToSubjects(once, subjects);

  assert.deepEqual(twice, once);
});

test("leaves sessions untouched when no subjects are known yet", () => {
  const sessions = [session("acse0403", "ACSE0403", "OOP with Java")];
  const reconciled = reconcileSessionsToSubjects(sessions, []);

  assert.equal(reconciled[0].subjectId, "acse0403");
});
