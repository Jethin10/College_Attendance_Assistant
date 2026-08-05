export type PortalStudentContext = {
  branch?: string;
  section?: string;
  semesterLabel?: string;
  academicYear?: string;
  rollNo?: string;
};

function clean(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "null" ? trimmed : undefined;
}

/**
 * NIET/JUNO installations use slightly different academic-info field names.
 * Values stay unrestricted so every programme, branch, section and year works
 * without a CSE-specific allowlist.
 */
export function extractPortalStudentContext(
  info: Record<string, unknown>,
): PortalStudentContext {
  const entries = new Map(
    Object.entries(info).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = clean(entries.get(key.toLowerCase()));
      if (value) {
        return value;
      }
    }
    return undefined;
  };

  return {
    branch: first("courseName", "branchName", "programmeName", "programName"),
    section: first("divisionName", "sectionName", "division", "section"),
    semesterLabel: first("semesterName", "termName", "semester", "term"),
    academicYear: first(
      "academicYearName",
      "academicYear",
      "academicSessionName",
      "sessionName",
      "batchName",
    ),
    rollNo: first("rollNo", "studentRollNo", "enrollmentNo", "registrationNo"),
  };
}
