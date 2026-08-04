/**
 * Attendance engine tests.
 *
 * The case that matters most is `buildDashboardData` reporting NOT safe when
 * aggregate attendance looks healthy but one subject has already fallen below
 * 75%. That is the scenario a student would act on wrongly.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDashboardData,
  computeAttendancePercent,
  computeBunkableClasses,
  computeNextMissDrop,
  computeRecoveryClassesNeeded,
  getSubjectStatus,
  simulateAttendance,
} from "@/lib/attendance-engine";
import type {
  AttendancePolicy,
  CalendarSession,
  ScheduleSlot,
  StudentProfile,
  Subject,
  TimetableSyncState,
} from "@/lib/types";

const POLICY: AttendancePolicy = {
  thresholdPercent: 75,
  severeMedicalFloorPercent: 60,
};

const STUDENT: StudentProfile = {
  institute: "NIET Greater Noida",
  studentName: "Test Student",
  branch: "B.Tech CSE",
  section: "A",
  semesterLabel: "SEM-5",
  rollNo: "0000000000",
  studentEmail: "",
};

const SYNC: TimetableSyncState = { source: "portal", status: "ready" };

function subject(overrides: Partial<Subject> & Pick<Subject, "id">): Subject {
  return {
    code: overrides.id.toUpperCase(),
    name: overrides.id,
    type: "theory",
    heldClasses: 0,
    attendedClasses: 0,
    ...overrides,
  };
}

function dashboard(subjects: Subject[], extras?: {
  timetable?: ScheduleSlot[];
  calendarSessions?: CalendarSession[];
}) {
  return buildDashboardData({
    student: STUDENT,
    policy: POLICY,
    subjects,
    timetable: extras?.timetable ?? [],
    calendarSessions: extras?.calendarSessions ?? [],
    timetableSync: SYNC,
  });
}

/** Dated session on a fixed future date, so tests do not drift with the clock. */
function session(
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
    endTime: "23:59",
    source: "portal",
  };
}

/* ------------------------------ primitives ------------------------------ */

test("computeAttendancePercent treats a subject with no classes as 100%", () => {
  assert.equal(computeAttendancePercent(0, 0), 100);
});

test("computeBunkableClasses is exact at the threshold boundary", () => {
  // 75/100 is exactly 75%: no headroom, one more miss breaches.
  assert.equal(computeBunkableClasses(75, 100, 75), 0);
  // 80/100 -> can reach 80/106 = 75.47%, but 80/107 = 74.77%.
  assert.equal(computeBunkableClasses(80, 100, 75), 6);
});

test("computeBunkableClasses returns 0 when already below the threshold", () => {
  assert.equal(computeBunkableClasses(70, 100, 75), 0);
});

test("computeBunkableClasses returns 0 before any class is held", () => {
  assert.equal(computeBunkableClasses(0, 0, 75), 0);
});

test("computeRecoveryClassesNeeded solves the threshold exactly", () => {
  // 70/100: need n where (70+n)/(100+n) >= 0.75 -> n >= 20.
  assert.equal(computeRecoveryClassesNeeded(70, 100, 75), 20);
  const attended = 70 + 20;
  const held = 100 + 20;
  assert.ok(attended / held >= 0.75);
});

test("computeRecoveryClassesNeeded is 0 when already compliant", () => {
  assert.equal(computeRecoveryClassesNeeded(80, 100, 75), 0);
});

test("computeRecoveryClassesNeeded terminates at a 100% requirement", () => {
  // Guards the old while-loop, which never exited when the ratio was 1.
  assert.equal(computeRecoveryClassesNeeded(50, 100, 100), 0);
});

test("computeNextMissDrop reports the cost of one more absence", () => {
  // 80/100 = 80%, 80/101 = 79.21% -> a 0.79 point drop.
  assert.equal(computeNextMissDrop(80, 100), 0.79);
});

test("getSubjectStatus separates critical, warning and safe", () => {
  assert.equal(getSubjectStatus(74.9, 75), "critical");
  assert.equal(getSubjectStatus(75, 75), "warning");
  assert.equal(getSubjectStatus(79.9, 75), "warning");
  assert.equal(getSubjectStatus(80, 75), "safe");
});

/* --------------------------- the policy rule --------------------------- */

test("a healthy average does not hide a failing subject", () => {
  // Aggregate: 155/200 = 77.5%, comfortably above 75.
  // Maths alone: 68/100 = 68%, already detainable.
  const data = dashboard([
    subject({ id: "maths", name: "Maths", attendedClasses: 68, heldClasses: 100 }),
    subject({ id: "dsa", name: "DSA", attendedClasses: 87, heldClasses: 100 }),
  ]);

  assert.equal(data.overall.attendancePercent, 77.5);
  assert.equal(data.overall.status, "critical", "must not report safe");
  assert.equal(data.overall.safeToMissClasses, 0);
  assert.equal(data.overall.bindingSubjectName, "Maths");
});

test("safeToMissClasses is the minimum across subjects, not the aggregate", () => {
  const data = dashboard([
    subject({ id: "a", name: "A", attendedClasses: 76, heldClasses: 100 }), // 1 spare
    subject({ id: "b", name: "B", attendedClasses: 95, heldClasses: 100 }), // 26 spare
  ]);

  // Pooling totals would allow 24; the weakest subject allows 1.
  assert.equal(computeBunkableClasses(171, 200, 75), 28);
  assert.equal(data.overall.safeToMissClasses, 1);
  assert.equal(data.overall.bindingSubjectName, "A");
});

test("subjects with no classes held do not force a false zero", () => {
  const data = dashboard([
    subject({ id: "started", name: "Started", attendedClasses: 90, heldClasses: 100 }),
    subject({ id: "fresh", name: "Fresh", attendedClasses: 0, heldClasses: 0 }),
  ]);

  assert.equal(data.overall.safeToMissClasses, 20);
  assert.equal(data.overall.bindingSubjectName, "Started");
  assert.equal(data.subjects.find((s) => s.id === "fresh")?.status, "not-started");
});

test("an empty subject list reports safe rather than crashing", () => {
  const data = dashboard([]);
  assert.equal(data.overall.status, "safe");
  assert.equal(data.overall.safeToMissClasses, 0);
  assert.equal(data.overall.bindingSubjectName, undefined);
});

/* ---------------------------- safe leave days ---------------------------- */

test("a day is only safe if every subject that meets can absorb its own hit", () => {
  // Maths has exactly 1 class of headroom but meets TWICE on the same day,
  // so that day cannot be taken off even though the pooled budget looks fine.
  const subjects = [
    subject({ id: "maths", name: "Maths", attendedClasses: 76, heldClasses: 100 }),
    subject({ id: "dsa", name: "DSA", attendedClasses: 95, heldClasses: 100 }),
  ];

  const calendarSessions = [
    session("s1", "maths", "2099-01-05", "09:00"),
    session("s2", "maths", "2099-01-05", "11:00"),
    session("s3", "dsa", "2099-01-05", "14:00"),
  ];

  assert.equal(computeBunkableClasses(76, 100, 75), 1);

  const data = dashboard(subjects, { calendarSessions });
  assert.equal(data.overall.safeLeaveDays, 0, "two Maths classes exceed its budget of 1");
});

test("a day is safe when every subject stays within its own budget", () => {
  const subjects = [
    subject({ id: "maths", name: "Maths", attendedClasses: 90, heldClasses: 100 }),
    subject({ id: "dsa", name: "DSA", attendedClasses: 95, heldClasses: 100 }),
  ];

  const calendarSessions = [
    session("s1", "maths", "2099-01-05", "09:00"),
    session("s2", "dsa", "2099-01-05", "14:00"),
  ];

  const data = dashboard(subjects, { calendarSessions });
  assert.equal(data.overall.safeLeaveDays, 1);
});

/* ------------------------------ simulation ------------------------------ */

test("missing classes raises held without raising attended", () => {
  const subjects = [
    subject({ id: "maths", name: "Maths", attendedClasses: 80, heldClasses: 100 }),
  ];

  const result = simulateAttendance({
    policy: POLICY,
    subjects,
    timetable: [],
    calendarSessions: [
      session("s1", "maths", "2099-03-02", "09:00"),
      session("s2", "maths", "2099-03-03", "09:00"),
    ],
    request: { mode: "date-range", fromDate: "2099-03-01", toDate: "2099-03-04" },
  });

  assert.equal(result.overall.classesMissed, 2);
  assert.equal(result.overall.afterAttended, 80, "attended must not change");
  assert.equal(result.overall.afterHeld, 102);
  assert.equal(result.projections[0].afterPercent, computeAttendancePercent(80, 102));
});

test("simulation status reflects the worst subject, not the average", () => {
  const subjects = [
    subject({ id: "maths", name: "Maths", attendedClasses: 76, heldClasses: 100 }),
    subject({ id: "dsa", name: "DSA", attendedClasses: 99, heldClasses: 100 }),
  ];

  const result = simulateAttendance({
    policy: POLICY,
    subjects,
    timetable: [],
    calendarSessions: [
      session("s1", "maths", "2099-04-06", "09:00"),
      session("s2", "maths", "2099-04-06", "10:00"),
    ],
    request: { mode: "date-range", fromDate: "2099-04-06", toDate: "2099-04-06" },
  });

  // 175/202 = 86.6% overall, but Maths lands at 76/102 = 74.5%.
  assert.ok(result.overall.afterPercent > 75);
  assert.equal(result.overall.status, "critical");
  assert.equal(result.summary.thresholdBreaches, 1);
});

test("a window with no classes leaves attendance untouched", () => {
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [subject({ id: "maths", attendedClasses: 80, heldClasses: 100 })],
    timetable: [],
    calendarSessions: [session("s1", "maths", "2099-05-10", "09:00")],
    request: { mode: "date-range", fromDate: "2099-06-01", toDate: "2099-06-02" },
  });

  assert.equal(result.overall.classesMissed, 0);
  assert.equal(result.overall.afterPercent, result.overall.beforePercent);
});

test("date ranges are parsed in local time", () => {
  // A UTC-parsed "2099-07-06" would shift the boundary and drop this session.
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [subject({ id: "maths", attendedClasses: 80, heldClasses: 100 })],
    timetable: [],
    calendarSessions: [session("s1", "maths", "2099-07-06", "08:00")],
    request: { mode: "date-range", fromDate: "2099-07-06", toDate: "2099-07-06" },
  });

  assert.equal(result.overall.classesMissed, 1);
});

test("recovery beyond the synced schedule is flagged, not silently rounded", () => {
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [subject({ id: "maths", attendedClasses: 50, heldClasses: 100 })],
    timetable: [],
    calendarSessions: [session("s1", "maths", "2099-08-03", "09:00")],
    request: { mode: "future-count", futureClasses: 0 },
  });

  assert.ok(result.overall.recoveryClassesNeeded > 0);
  assert.equal(result.overall.recoveryBeyondSchedule, true);
});
