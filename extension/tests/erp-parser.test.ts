/**
 * ERP parser tests.
 *
 * Covers the two table layouts NIET has shipped (header-mapped "Present Count"
 * / "Total Count" columns, and the older combined "attended / held" cell) plus
 * the pasted-text path students use when automatic reading fails.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { parseAttendanceText, parsedToSubjects } from "@/lib/erp-parser";

test("parses tab-separated text with recognised headers", () => {
  const pasted = [
    "Course Code\tCourse Name\tPresent Count\tTotal Count\tPercentage",
    "CS301\tData Structures\t14\t22\t63.64",
    "MA302\tDiscrete Maths\t30\t32\t93.75",
  ].join("\n");

  const parsed = parseAttendanceText(pasted);

  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    code: "CS301",
    name: "Data Structures",
    attendedClasses: 14,
    heldClasses: 22,
    attendancePercent: 63.64,
  });
  assert.equal(parsed[1].heldClasses, 32);
});

test("parses the legacy attended/held line format", () => {
  const parsed = parseAttendanceText("CS301 Data Structures 14/22 63.64%");

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].code, "CS301");
  assert.equal(parsed[0].attendedClasses, 14);
  assert.equal(parsed[0].heldClasses, 22);
});

test("ignores prose that contains no attendance figures", () => {
  assert.equal(parseAttendanceText("No attendance recorded for this term.").length, 0);
});

test("keeps a subject whose classes have not started", () => {
  const pasted = [
    "Course Code\tCourse Name\tPresent Count\tTotal Count\tPercentage",
    "CS499\tProject Work\t0\t0\t0",
  ].join("\n");

  const parsed = parseAttendanceText(pasted);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].heldClasses, 0);
});

test("infers lab and MOOC subject types from the name", () => {
  const subjects = parsedToSubjects([
    { code: "CS301", name: "Data Structures", attendedClasses: 1, heldClasses: 2 },
    { code: "CS302", name: "Data Structures Lab", attendedClasses: 1, heldClasses: 2 },
    { code: "HS303", name: "NPTEL MOOC Elective", attendedClasses: 1, heldClasses: 2 },
  ]);

  assert.equal(subjects[0].type, "theory");
  assert.equal(subjects[1].type, "lab");
  assert.equal(subjects[2].type, "other");
});

test("preserves an existing subject's id and manually corrected type", () => {
  const existing = [
    {
      id: "sem5:cs301",
      code: "CS301",
      name: "Data Structures",
      type: "lab" as const,
      heldClasses: 10,
      attendedClasses: 8,
    },
  ];

  const subjects = parsedToSubjects(
    [{ code: "CS301", name: "Data Structures", attendedClasses: 9, heldClasses: 12 }],
    existing,
  );

  assert.equal(subjects[0].id, "sem5:cs301", "id must be stable across refreshes");
  assert.equal(subjects[0].type, "lab", "a corrected type must not be overwritten");
  assert.equal(subjects[0].attendedClasses, 9, "counts must update");
});
