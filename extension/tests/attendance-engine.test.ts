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
  enforcePerSubject: true,
};

/** Legacy aggregate mode remains supported for comparison and migration tests. */
const OVERALL_POLICY: AttendancePolicy = { ...POLICY, enforcePerSubject: false };

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
  policy?: AttendancePolicy;
}) {
  return buildDashboardData({
    student: STUDENT,
    policy: extras?.policy ?? POLICY,
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

test("aggregate mode can report a healthy overall figure", () => {
  // Aggregate: 155/200 = 77.5%, while Maths alone is at 68%.
  const data = dashboard([
    subject({ id: "maths", name: "Maths", attendedClasses: 68, heldClasses: 100 }),
    subject({ id: "dsa", name: "DSA", attendedClasses: 87, heldClasses: 100 }),
  ], { policy: OVERALL_POLICY });

  assert.equal(data.overall.attendancePercent, 77.5);
  // 77.5% is above the line but inside the 5-point warning band.
  assert.equal(data.overall.status, "warning");
  assert.notEqual(data.overall.status, "critical", "a weak subject must not force critical");
  assert.equal(data.overall.safeToMissClasses, computeBunkableClasses(155, 200, 75));
  // Still surfaced, so the popup can show an advisory note.
  assert.equal(data.overall.weakestSubjectName, "Maths");
  assert.equal(data.insights.belowThresholdCount, 1);
});

test("aggregate mode safeToMissClasses uses the overall pool", () => {
  const data = dashboard([
    subject({ id: "a", name: "A", attendedClasses: 76, heldClasses: 100 }),
    subject({ id: "b", name: "B", attendedClasses: 95, heldClasses: 100 }),
  ], { policy: OVERALL_POLICY });

  // 171/200 = 85.5%; the pooled allowance is what matters now.
  assert.equal(data.overall.safeToMissClasses, computeBunkableClasses(171, 200, 75));
  assert.equal(data.overall.safeToMissClasses, 28);
});

test("overall below the threshold reports critical", () => {
  const data = dashboard([
    subject({ id: "a", name: "A", attendedClasses: 60, heldClasses: 100 }),
    subject({ id: "b", name: "B", attendedClasses: 70, heldClasses: 100 }),
  ]);

  assert.equal(data.overall.attendancePercent, 65);
  assert.equal(data.overall.status, "critical");
  assert.equal(data.overall.safeToMissClasses, 0);
  assert.equal(data.overall.recoveryClassesNeeded, computeRecoveryClassesNeeded(130, 200, 75));
});

test("current policy makes a failing subject override a healthy aggregate", () => {
  const data = dashboard(
    [
      subject({ id: "maths", name: "Maths", attendedClasses: 68, heldClasses: 100 }),
      subject({ id: "dsa", name: "DSA", attendedClasses: 87, heldClasses: 100 }),
    ],
    { policy: POLICY },
  );

  assert.equal(data.overall.status, "critical");
  assert.equal(data.overall.safeToMissClasses, 0);
  assert.equal(data.overall.weakestSubjectName, "Maths");
});

test("subjects with no classes held do not distort the verdict", () => {
  const data = dashboard([
    subject({ id: "started", name: "Started", attendedClasses: 90, heldClasses: 100 }),
    subject({ id: "fresh", name: "Fresh", attendedClasses: 0, heldClasses: 0 }),
  ]);

  assert.equal(data.overall.safeToMissClasses, 20);
  assert.equal(data.subjects.find((s) => s.id === "fresh")?.status, "not-started");
});

test("an empty subject list reports safe rather than crashing", () => {
  const data = dashboard([]);
  assert.equal(data.overall.status, "safe");
  assert.equal(data.overall.safeToMissClasses, 0);
  assert.equal(data.overall.weakestSubjectName, undefined);
});

/* ---------------------------- safe leave days ---------------------------- */

test("leave days draw on one shared pool in aggregate mode", () => {
  // 166/200 = 83%; pooled allowance covers several days regardless of which
  // subject each class belongs to.
  const subjects = [
    subject({ id: "maths", name: "Maths", attendedClasses: 76, heldClasses: 100 }),
    subject({ id: "dsa", name: "DSA", attendedClasses: 90, heldClasses: 100 }),
  ];

  const calendarSessions = [
    session("s1", "maths", "2099-01-05", "09:00"),
    session("s2", "maths", "2099-01-05", "11:00"),
    session("s3", "dsa", "2099-01-05", "14:00"),
  ];

  const data = dashboard(subjects, { calendarSessions, policy: OVERALL_POLICY });

  assert.equal(data.overall.safeToMissClasses, computeBunkableClasses(166, 200, 75));
  assert.equal(data.overall.safeLeaveDays, 1, "3 classes fit inside the pooled budget");
});

test("a day is refused once the shared pool runs out", () => {
  // 150/200 = exactly 75%: no headroom at all.
  const subjects = [
    subject({ id: "maths", name: "Maths", attendedClasses: 75, heldClasses: 100 }),
    subject({ id: "dsa", name: "DSA", attendedClasses: 75, heldClasses: 100 }),
  ];

  const data = dashboard(subjects, {
    calendarSessions: [session("s1", "maths", "2099-01-05", "09:00")],
    policy: OVERALL_POLICY,
  });

  assert.equal(data.overall.safeToMissClasses, 0);
  assert.equal(data.overall.safeLeaveDays, 0);
});

test("per-subject mode gives each subject its own leave budget", () => {
  // Maths has exactly 1 class of headroom but meets twice that day, so the day
  // is unsafe even though a pooled budget would allow it.
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

  const data = dashboard(subjects, { calendarSessions, policy: POLICY });
  assert.equal(data.overall.safeLeaveDays, 0, "two Maths classes exceed its budget of 1");
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

test("aggregate simulation status follows the overall figure", () => {
  const subjects = [
    subject({ id: "maths", name: "Maths", attendedClasses: 76, heldClasses: 100 }),
    subject({ id: "dsa", name: "DSA", attendedClasses: 99, heldClasses: 100 }),
  ];

  const result = simulateAttendance({
    policy: OVERALL_POLICY,
    subjects,
    timetable: [],
    calendarSessions: [
      session("s1", "maths", "2099-04-06", "09:00"),
      session("s2", "maths", "2099-04-06", "10:00"),
    ],
    request: { mode: "date-range", fromDate: "2099-04-06", toDate: "2099-04-06" },
  });

  // 175/202 = 86.63% overall, so this is safe even though Maths lands at 74.5%.
  assert.ok(result.overall.afterPercent > 75);
  assert.equal(result.overall.status, "safe");
  assert.equal(result.overall.weakestSubjectName, "Maths");
  // Per-subject detail is still computed for the breakdown list.
  assert.equal(result.summary.thresholdBreaches, 1);
  assert.equal(result.summary.subjectsBelowThreshold, 1);
  assert.equal(result.summary.newThresholdBreaches, 1);
});

test("individual class planning works without a matching timetable slot", () => {
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [
      subject({
        id: "remedial",
        name: "Activity and Remedial Class",
        attendedClasses: 2,
        heldClasses: 2,
      }),
    ],
    timetable: [],
    calendarSessions: [],
    request: { mode: "future-count", subjectId: "remedial", futureClasses: 7 },
  });

  assert.equal(result.overall.classesMissed, 7);
  assert.equal(result.impactedSlots.length, 7);
  assert.equal(result.projections[0].beforePercent, 100);
  assert.equal(result.projections[0].afterPercent, computeAttendancePercent(2, 9));
  assert.equal(result.summary.newThresholdBreaches, 1);
});

test("leave planning supports a custom duration beyond the old preset list", () => {
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [subject({ id: "maths", attendedClasses: 50, heldClasses: 50 })],
    timetable: Array.from({ length: 7 }, (_, dayOfWeek) =>
      ({
        id: `maths-${dayOfWeek}`,
        subjectId: "maths",
        dayOfWeek,
        startTime: "09:00",
        endTime: "10:00",
      }),
    ),
    calendarSessions: [],
    request: {
      mode: "leave-days",
      leaveDays: 12,
      dayPart: "full",
      fromDate: "2099-01-01",
    },
    referenceDate: new Date("2098-12-31T23:00:00"),
  });

  assert.equal(result.overall.classesMissed, 12);
});

test("simulation reports critical once overall drops below the threshold", () => {
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [subject({ id: "maths", name: "Maths", attendedClasses: 76, heldClasses: 100 })],
    timetable: [],
    calendarSessions: [
      session("s1", "maths", "2099-04-06", "09:00"),
      session("s2", "maths", "2099-04-06", "10:00"),
      session("s3", "maths", "2099-04-07", "09:00"),
    ],
    request: { mode: "date-range", fromDate: "2099-04-06", toDate: "2099-04-07" },
  });

  // 76/103 = 73.79%
  assert.equal(result.overall.classesMissed, 3);
  assert.ok(result.overall.afterPercent < 75);
  assert.equal(result.overall.status, "critical");
});

test("missed classes are attributed to the subject that owns them", () => {
  // Regression guard: when calendar sessions carry subject ids that do not
  // match any subject, every absence collapsed onto whichever subject happened
  // to match, and the rest silently vanished from the breakdown.
  const subjects = [
    subject({ id: "sem5:oops", name: "OOP with Java", attendedClasses: 30, heldClasses: 40 }),
    subject({ id: "sem5:ai", name: "Artificial Intelligence", attendedClasses: 30, heldClasses: 40 }),
  ];

  const result = simulateAttendance({
    policy: POLICY,
    subjects,
    timetable: [],
    calendarSessions: [
      session("s1", "sem5:oops", "2099-09-01", "09:00"),
      session("s2", "sem5:ai", "2099-09-01", "10:00"),
    ],
    request: { mode: "date-range", fromDate: "2099-09-01", toDate: "2099-09-01" },
  });

  assert.equal(result.overall.classesMissed, 2);
  assert.equal(result.projections.length, 2, "both subjects must appear");
  for (const projection of result.projections) {
    assert.equal(projection.classesMissed, 1, `${projection.subjectName} took exactly one`);
  }
});

test("a class-free leave date misses nothing while preserving earlier attendance", () => {
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [subject({ id: "maths", attendedClasses: 80, heldClasses: 100 })],
    timetable: [],
    calendarSessions: [session("s1", "maths", "2099-05-10", "09:00")],
    request: { mode: "date-range", fromDate: "2099-06-01", toDate: "2099-06-02" },
    referenceDate: new Date("2099-05-09T00:00:00"),
  });

  assert.equal(result.overall.classesMissed, 0);
  assert.equal(result.overall.classesAssumedAttended, 1);
  assert.ok(result.overall.afterPercent > result.overall.beforePercent);
});

test("a later leave date includes earlier attended classes", () => {
  const subjects = [
    subject({ id: "maths", attendedClasses: 70, heldClasses: 80 }),
    subject({ id: "dsa", attendedClasses: 63, heldClasses: 71 }),
  ];
  const calendarSessions = [
    session("sixth-1", "maths", "2026-08-06", "09:00"),
    session("sixth-2", "dsa", "2026-08-06", "10:00"),
    session("seventh-1", "maths", "2026-08-07", "09:00"),
  ];
  const common = {
    policy: POLICY,
    subjects,
    timetable: [] as ScheduleSlot[],
    calendarSessions,
    scheduleRangeStart: "2026-08-05",
    scheduleRangeEnd: "2026-08-31",
    referenceDate: new Date("2026-08-05T20:00:00"),
  };

  const sixth = simulateAttendance({
    ...common,
    request: { mode: "leave-days", leaveDays: 1, fromDate: "2026-08-06" },
  });
  const seventh = simulateAttendance({
    ...common,
    request: { mode: "leave-days", leaveDays: 1, fromDate: "2026-08-07" },
  });

  assert.equal(sixth.overall.classesAssumedAttended, 0);
  assert.equal(sixth.overall.classesMissed, 2);
  assert.equal(seventh.overall.classesAssumedAttended, 2);
  assert.equal(seventh.overall.classesMissed, 1);
  assert.equal(seventh.overall.afterAttended, 135);
  assert.equal(seventh.overall.afterHeld, 154);
  assert.notEqual(sixth.overall.afterPercent, seventh.overall.afterPercent);
});

test("the validated immediate-leave formula stays exact to the decimal", () => {
  const calendarSessions = Array.from({ length: 6 }, (_, index) =>
    session(`sixth-${index}`, index % 2 === 0 ? "maths" : "dsa", "2026-08-06", `${9 + index}:00`),
  );
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [
      subject({ id: "maths", attendedClasses: 70, heldClasses: 80 }),
      subject({ id: "dsa", attendedClasses: 63, heldClasses: 71 }),
    ],
    timetable: [],
    calendarSessions,
    scheduleRangeStart: "2026-08-05",
    scheduleRangeEnd: "2026-08-31",
    request: { mode: "leave-days", leaveDays: 1, fromDate: "2026-08-06" },
    referenceDate: new Date("2026-08-05T20:00:00"),
  });

  assert.equal(result.overall.beforePercent, 88.08);
  assert.equal(result.overall.classesAssumedAttended, 0);
  assert.equal(result.overall.classesMissed, 6);
  assert.equal(result.overall.afterPercent, 84.71);
  assert.equal(result.overall.deltaPercent, 3.37);
});

test("an unpublished future date falls back to the recent recurring timetable", () => {
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [subject({ id: "maths", attendedClasses: 141, heldClasses: 159 })],
    timetable: [
      {
        id: "thursday-maths",
        subjectId: "maths",
        dayOfWeek: 4,
        startTime: "09:00",
        endTime: "10:00",
      },
    ],
    // The portal returned a row for Wednesday but nothing for Thursday even
    // though the declared fetch range includes it.
    calendarSessions: [session("wednesday", "maths", "2026-08-05", "09:00")],
    scheduleRangeStart: "2026-07-22",
    scheduleRangeEnd: "2026-09-19",
    request: { mode: "leave-days", leaveDays: 1, fromDate: "2026-08-06" },
    referenceDate: new Date("2026-08-05T20:00:00"),
  });

  assert.equal(result.overall.classesMissed, 1);
  assert.equal(result.overall.afterPercent, 88.13);
  assert.equal(result.impactedSlots[0]?.date, "2026-08-06");
});

test("an unpublished date reuses one coherent weekday and never unions weeks", () => {
  const times = ["09:10", "10:00", "10:50", "11:40", "13:30", "14:30", "15:20", "16:10"];
  const olderThursday = times.map((time, index) =>
    session(`older-${index}`, index < 4 ? "me-design" : "me-lab", "2026-07-23", time),
  );
  const recentThursday = times.map((time, index) =>
    session(`recent-${index}`, "mba-finance-b", "2026-07-30", time),
  );
  // Reproduces the old broken weekly store: two different eight-period weeks
  // became fifteen unique subject/time rows after one coincident period.
  const unionedTimetable: ScheduleSlot[] = [
    ...olderThursday,
    ...recentThursday.slice(0, 7),
  ].map((item) => ({
    id: `slot:${item.id}`,
    subjectId: item.subjectId,
    dayOfWeek: item.dayOfWeek,
    startTime: item.startTime,
    endTime: item.endTime,
  }));

  const result = simulateAttendance({
    policy: POLICY,
    subjects: [
      subject({ id: "me-design", code: "ME701", attendedClasses: 40, heldClasses: 45 }),
      subject({ id: "me-lab", code: "MEL703", attendedClasses: 30, heldClasses: 34 }),
      subject({ id: "mba-finance-b", code: "MBAF201", attendedClasses: 71, heldClasses: 80 }),
    ],
    timetable: unionedTimetable,
    calendarSessions: [...olderThursday, ...recentThursday],
    scheduleRangeStart: "2026-07-22",
    scheduleRangeEnd: "2026-09-19",
    request: { mode: "leave-days", leaveDays: 1, fromDate: "2026-08-06" },
    referenceDate: new Date("2026-08-05T20:00:00"),
  });

  assert.equal(result.overall.beforeAttended, 141);
  assert.equal(result.overall.beforeHeld, 159);
  assert.equal(result.overall.classesMissed, 8);
  assert.equal(result.overall.afterPercent, 84.43);
  assert.equal(result.summary.scheduleEstimated, true);
  assert.deepEqual(result.summary.scheduleSourceDates, ["2026-07-30"]);
  assert.ok(result.impactedSlots.every((item) => item.subjectId === "mba-finance-b"));
});

test("exact dated rows win over every inferred weekday template", () => {
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [subject({ id: "section-z", attendedClasses: 90, heldClasses: 100 })],
    timetable: [],
    calendarSessions: [
      session("older-a", "section-z", "2028-07-27", "09:00"),
      session("older-b", "section-z", "2028-07-27", "10:00"),
      session("exact", "section-z", "2028-08-03", "13:00"),
    ],
    scheduleRangeStart: "2028-07-20",
    scheduleRangeEnd: "2028-09-10",
    request: { mode: "leave-days", leaveDays: 1, fromDate: "2028-08-03" },
    referenceDate: new Date("2028-08-02T20:00:00"),
  });

  assert.equal(result.overall.classesMissed, 1);
  assert.equal(result.summary.scheduleEstimated, false);
  assert.deepEqual(result.summary.scheduleSourceDates, []);
});

test("leave duration uses consecutive calendar days instead of skipping to classes", () => {
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [subject({ id: "maths", attendedClasses: 80, heldClasses: 100 })],
    timetable: [],
    calendarSessions: [
      session("sixth", "maths", "2026-08-06", "09:00"),
      session("eighth", "maths", "2026-08-08", "09:00"),
    ],
    scheduleRangeStart: "2026-08-05",
    scheduleRangeEnd: "2026-08-31",
    request: { mode: "leave-days", leaveDays: 2, fromDate: "2026-08-06" },
    referenceDate: new Date("2026-08-05T20:00:00"),
  });

  assert.equal(result.overall.classesMissed, 1);
  assert.deepEqual(result.impactedSlots.map((item) => item.date), ["2026-08-06"]);
});

test("leave today only counts classes that have not started", () => {
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [subject({ id: "maths", attendedClasses: 80, heldClasses: 100 })],
    timetable: [],
    calendarSessions: [
      session("morning", "maths", "2026-08-06", "09:00"),
      session("afternoon", "maths", "2026-08-06", "13:00"),
    ],
    scheduleRangeStart: "2026-08-06",
    scheduleRangeEnd: "2026-08-31",
    request: { mode: "leave-days", leaveDays: 1, fromDate: "2026-08-06" },
    referenceDate: new Date("2026-08-06T12:00:00"),
  });

  assert.equal(result.overall.classesMissed, 1);
  assert.deepEqual(result.impactedSlots.map((item) => item.id), ["afternoon"]);
});

test("a future half day assumes the other half is attended", () => {
  const result = simulateAttendance({
    policy: POLICY,
    subjects: [subject({ id: "maths", attendedClasses: 80, heldClasses: 100 })],
    timetable: [],
    calendarSessions: [
      session("morning", "maths", "2026-08-06", "09:00"),
      session("afternoon", "maths", "2026-08-06", "13:00"),
    ],
    scheduleRangeStart: "2026-08-05",
    scheduleRangeEnd: "2026-08-31",
    request: {
      mode: "leave-days",
      leaveDays: 1,
      dayPart: "morning",
      fromDate: "2026-08-06",
    },
    referenceDate: new Date("2026-08-05T20:00:00"),
  });

  assert.equal(result.overall.classesMissed, 1);
  assert.equal(result.overall.classesAssumedAttended, 1);
  assert.equal(result.overall.afterAttended, 81);
  assert.equal(result.overall.afterHeld, 102);
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

test("half-day leave only counts sessions in the selected part of the day", () => {
  const subjects = [
    subject({ id: "maths", name: "Maths", attendedClasses: 40, heldClasses: 50 }),
    subject({ id: "dsa", name: "DSA", attendedClasses: 40, heldClasses: 50 }),
  ];

  const calendarSessions = [
    session("morning-1", "maths", "2099-08-06", "09:00"),
    session("morning-2", "dsa", "2099-08-06", "11:00"),
    session("afternoon-1", "maths", "2099-08-06", "13:00"),
  ];

  const morning = simulateAttendance({
    policy: POLICY,
    subjects,
    timetable: [],
    calendarSessions,
    request: {
      mode: "leave-days",
      leaveDays: 1,
      dayPart: "morning",
      fromDate: "2099-08-06",
    },
  });

  const afternoon = simulateAttendance({
    policy: POLICY,
    subjects,
    timetable: [],
    calendarSessions,
    request: {
      mode: "leave-days",
      leaveDays: 1,
      dayPart: "afternoon",
      fromDate: "2099-08-06",
    },
  });

  assert.equal(morning.overall.classesMissed, 2);
  assert.equal(morning.summary.impactedSubjects, 2);
  assert.equal(afternoon.overall.classesMissed, 1);
  assert.equal(afternoon.summary.impactedSubjects, 1);
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
