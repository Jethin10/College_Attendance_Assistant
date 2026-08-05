import test from "node:test";
import assert from "node:assert/strict";

import { extractPortalStudentContext } from "@/lib/portal-student";

test("reads branch, section, semester and academic year without programme assumptions", () => {
  assert.deepEqual(
    extractPortalStudentContext({
      courseName: "B.Tech - Mechanical Engineering",
      divisionName: "ME-B",
      semesterName: "SEM-VII",
      academicYearName: "2027-28",
      rollNo: "0271ME042",
    }),
    {
      branch: "B.Tech - Mechanical Engineering",
      section: "ME-B",
      semesterLabel: "SEM-VII",
      academicYear: "2027-28",
      rollNo: "0271ME042",
    },
  );
});

test("supports alternate JUNO field names used by other cohorts", () => {
  const context = extractPortalStudentContext({
    programmeName: "MBA",
    sectionName: "Finance-A",
    termName: "Term 2",
    academicSessionName: "2026-27",
    enrollmentNo: "MBA-112",
  });

  assert.equal(context.branch, "MBA");
  assert.equal(context.section, "Finance-A");
  assert.equal(context.semesterLabel, "Term 2");
  assert.equal(context.academicYear, "2026-27");
  assert.equal(context.rollNo, "MBA-112");
});
