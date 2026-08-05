/**
 * Storage layer — typed wrapper over chrome.storage.local for the
 * AttendanceStore and the computed DashboardData.
 *
 * Everything here stays on the student's machine. Nothing is transmitted.
 */

import { buildDashboardData, simulateAttendance } from "@/lib/attendance-engine";
import {
  buildCoherentWeeklyTimetable,
  dedupeCalendarSessions,
} from "@/lib/portal-timetable";
import type {
  AttendancePolicy,
  AttendanceStore,
  CalendarSession,
  DashboardData,
  ERPImportSnapshot,
  ScheduleSlot,
  SimulationRequest,
  SimulationResult,
  StudentProfile,
  Subject,
} from "@/lib/types";

const STORE_KEY = "attendance_store";
const MAX_SNAPSHOTS = 50;
const MAX_SIMULATIONS = 25;

/**
 * NIET Attendance Policy 2025-26: published 75% planning standard, with a
 * 60% floor described for exceptional severe-medical consideration.
 *
 * Section 1 sets 75% in each theory and practical subject individually.
 * The ERP aggregate remains useful context, but cannot override a low subject.
 */
const DEFAULT_POLICY: AttendancePolicy = {
  thresholdPercent: 75,
  severeMedicalFloorPercent: 60,
  enforcePerSubject: true,
};

function defaultStudent(): StudentProfile {
  return {
    institute: "NIET Greater Noida",
    studentName: "",
    branch: "",
    section: "",
    semesterLabel: "",
    academicYear: "",
    rollNo: "",
    studentEmail: "",
  };
}

function defaultStore(): AttendanceStore {
  return {
    student: defaultStudent(),
    policy: DEFAULT_POLICY,
    subjects: [],
    timetable: [],
    calendarSessions: [],
    timetableSync: { source: "none", status: "idle" },
    simulations: [],
    erpSnapshots: [],
    activeSemesterLabel: "",
    preferences: { showPageOverlay: true },
  };
}

/**
 * Fills in anything missing from a stored object so upgrades from an older
 * shape (or a partially-written store) cannot crash the dashboard.
 */
function migrate(stored: Partial<AttendanceStore>): AttendanceStore {
  const base = defaultStore();

  return {
    student: { ...base.student, ...(stored.student ?? {}) },
    // Policy is intentionally not spread from storage: it encodes institute
    // rules, not user preferences, so a stored copy must never pin an outdated
    // interpretation (e.g. per-subject enforcement) after a policy change.
    policy: base.policy,
    subjects: stored.subjects ?? [],
    timetable: stored.timetable ?? [],
    calendarSessions: stored.calendarSessions ?? [],
    timetableSync:
      stored.timetableSync ??
      (stored.timetable && stored.timetable.length > 0
        ? { source: "manual", status: "ready" }
        : base.timetableSync),
    simulations: stored.simulations ?? [],
    erpSnapshots: stored.erpSnapshots ?? [],
    activeSemesterLabel:
      stored.activeSemesterLabel ?? stored.student?.semesterLabel ?? "",
    preferences: { ...base.preferences, ...(stored.preferences ?? {}) },
  };
}

export async function readStore(): Promise<AttendanceStore> {
  const result = await chrome.storage.local.get(STORE_KEY);

  if (result[STORE_KEY]) {
    return migrate(result[STORE_KEY] as Partial<AttendanceStore>);
  }

  const store = defaultStore();
  await chrome.storage.local.set({ [STORE_KEY]: store });
  return store;
}

export async function writeStore(store: AttendanceStore): Promise<void> {
  await chrome.storage.local.set({ [STORE_KEY]: store });
}

export async function getDashboardData(): Promise<DashboardData> {
  const store = await readStore();

  return buildDashboardData({
    student: store.student,
    policy: store.policy,
    subjects: store.subjects,
    timetable: store.timetable,
    calendarSessions: store.calendarSessions,
    timetableSync: store.timetableSync,
    recentSimulation: store.simulations.at(-1)?.result,
    erpSnapshot: store.erpSnapshots.at(-1),
  });
}

export async function replaceSubjects(subjects: Subject[]): Promise<DashboardData> {
  const store = await readStore();
  store.subjects = subjects;
  await writeStore(store);
  return getDashboardData();
}

export async function replaceTimetable(
  timetable: ScheduleSlot[],
): Promise<DashboardData> {
  const store = await readStore();
  store.timetable = timetable;
  store.calendarSessions = [];
  store.timetableSync = {
    source: "manual",
    status: timetable.length > 0 ? "ready" : "idle",
    lastSyncedAt: new Date().toISOString(),
    message: timetable.length > 0 ? "Timetable saved manually." : "Timetable cleared.",
  };
  await writeStore(store);
  return getDashboardData();
}

export async function setOverlayPreference(enabled: boolean): Promise<DashboardData> {
  const store = await readStore();
  store.preferences.showPageOverlay = enabled;
  await writeStore(store);
  return getDashboardData();
}

function normalizeCode(code: string) {
  return code.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function normalizeName(name: string) {
  return name
    .toLowerCase()
    .replace(/\b(lab|laboratory|practical|theory|using|with|and|of|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Points calendar sessions at the subject they belong to.
 *
 * The timetable feed identifies a class by course code or short name, while
 * subjects are keyed by a semester-namespaced id derived from the attendance
 * table. Those two never agree on their own, so sessions must be re-matched
 * every time either side changes — matching once at sync time leaves sessions
 * orphaned as soon as attendance re-imports and renames the subject ids.
 *
 * An orphaned session is not cosmetic: the simulator counts missed classes by
 * subject id, so orphans silently vanish from per-subject impact while still
 * inflating the totals.
 *
 * Matching is deliberately strict. An earlier prefix-based fallback returned
 * the first loose match, which funnelled unrelated sessions into a single
 * subject and made one subject appear to absorb an entire absence.
 */
export function reconcileSessionsToSubjects(
  sessions: CalendarSession[],
  subjects: Subject[],
): CalendarSession[] {
  if (subjects.length === 0) {
    return sessions;
  }

  const byCode = new Map(subjects.map((s) => [normalizeCode(s.code), s]));
  const byId = new Map(subjects.map((s) => [s.id, s]));
  const byName = new Map<string, Subject>();

  // Ambiguous names must not match anything, so track and drop collisions.
  const nameCollisions = new Set<string>();
  for (const subject of subjects) {
    const key = normalizeName(subject.name);
    if (!key) continue;
    if (byName.has(key)) {
      nameCollisions.add(key);
    } else {
      byName.set(key, subject);
    }
  }
  for (const key of nameCollisions) {
    byName.delete(key);
  }

  const resolve = (session: CalendarSession) => {
    // Already pointing at a known subject.
    if (byId.has(session.subjectId)) {
      return session.subjectId;
    }

    const byExactCode =
      byCode.get(normalizeCode(session.subjectCode)) ??
      byCode.get(normalizeCode(session.subjectId));
    if (byExactCode) {
      return byExactCode.id;
    }

    const nameKey = normalizeName(session.subjectName);
    const byExactName = nameKey ? byName.get(nameKey) : undefined;
    if (byExactName) {
      return byExactName.id;
    }

    // Unmatched: keep the feed's own id so the session still counts toward
    // schedule density, rather than being attributed to the wrong subject.
    return session.subjectId;
  };

  return sessions.map((session) => ({ ...session, subjectId: resolve(session) }));
}

/** Weekly slots carry a course code in subjectId; align them the same way. */
function reconcileTimetableToSubjects(
  timetable: ScheduleSlot[],
  sessions: CalendarSession[],
  subjects: Subject[],
): ScheduleSlot[] {
  if (subjects.length === 0) {
    return timetable;
  }

  const byId = new Map(subjects.map((s) => [s.id, s]));
  const byCode = new Map(subjects.map((s) => [normalizeCode(s.code), s]));

  // Sessions already resolved above are the most reliable bridge from a raw
  // feed code to a subject id.
  const resolvedByRawCode = new Map<string, string>();
  for (const session of sessions) {
    if (byId.has(session.subjectId)) {
      resolvedByRawCode.set(normalizeCode(session.subjectCode), session.subjectId);
    }
  }

  return timetable.map((slot) => {
    if (byId.has(slot.subjectId)) {
      return slot;
    }

    const raw = normalizeCode(slot.subjectId);
    const resolved = resolvedByRawCode.get(raw) ?? byCode.get(raw)?.id;
    return resolved ? { ...slot, subjectId: resolved } : slot;
  });
}

export async function savePortalTimetable(args: {
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  rangeStart: string;
  rangeEnd: string;
  message?: string;
}): Promise<DashboardData> {
  const store = await readStore();

  if (args.calendarSessions.length === 0) {
    // An empty NIET response frequently means future sessions have not been
    // published yet. Never erase the last usable timetable on that signal.
    store.timetableSync = {
      ...store.timetableSync,
      source: store.timetable.length > 0 ? store.timetableSync.source : "portal",
      status: "error",
      message: args.message ?? "No timetable rows were returned by the portal.",
    };
    await writeStore(store);
    return getDashboardData();
  }

  const reconciledSessions = reconcileSessionsToSubjects(
    dedupeCalendarSessions(args.calendarSessions),
    store.subjects,
  );

  store.timetable = reconcileTimetableToSubjects(
    buildCoherentWeeklyTimetable(reconciledSessions),
    reconciledSessions,
    store.subjects,
  );
  store.calendarSessions = reconciledSessions;
  store.timetableSync = {
    source: "portal",
    status: args.calendarSessions.length > 0 ? "ready" : "error",
    lastSyncedAt: new Date().toISOString(),
    rangeStart: args.rangeStart,
    rangeEnd: args.rangeEnd,
    message:
      args.message ??
      (args.calendarSessions.length > 0
        ? `Imported ${args.calendarSessions.length} upcoming classes from the portal.`
        : "No upcoming classes were returned by the portal."),
  };

  await writeStore(store);
  return getDashboardData();
}

export async function saveTimetableSyncError(
  message: string,
  status: "error" | "session-expired" = "error",
): Promise<DashboardData> {
  const store = await readStore();
  // Keep previously synced sessions: stale dates beat no dates, and clearing
  // them would silently zero out the student's safe-leave-day estimate.
  store.timetableSync = {
    ...store.timetableSync,
    source: store.timetable.length > 0 ? store.timetableSync.source : "portal",
    status,
    lastSyncedAt: store.timetableSync.lastSyncedAt,
    message,
  };
  await writeStore(store);
  return getDashboardData();
}

export async function saveSimulation(
  request: SimulationRequest,
): Promise<SimulationResult> {
  const store = await readStore();
  const result = simulateAttendance({
    policy: store.policy,
    subjects: store.subjects,
    timetable: store.timetable,
    calendarSessions: store.calendarSessions,
    scheduleRangeStart: store.timetableSync.rangeStart,
    scheduleRangeEnd: store.timetableSync.rangeEnd,
    request,
  });

  store.simulations.push({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    request,
    result,
  });
  store.simulations = store.simulations.slice(-MAX_SIMULATIONS);

  await writeStore(store);
  return result;
}

/** Runs an on-page projection without adding it to simulation history. */
export async function previewSimulation(
  request: SimulationRequest,
): Promise<SimulationResult> {
  const store = await readStore();

  return simulateAttendance({
    policy: store.policy,
    subjects: store.subjects,
    timetable: store.timetable,
    calendarSessions: store.calendarSessions,
    scheduleRangeStart: store.timetableSync.rangeStart,
    scheduleRangeEnd: store.timetableSync.rangeEnd,
    request,
  });
}

function inferSubjectType(name: string): Subject["type"] {
  if (/\blab\b|practical|workshop/i.test(name)) {
    return "lab";
  }
  if (/mooc|nptel/i.test(name)) {
    return "other";
  }
  return "theory";
}

/**
 * Commits a scraped snapshot.
 *
 * The ERP has a semester dropdown, so the table on screen is not necessarily
 * the current semester. Subjects are only replaced when the snapshot's
 * semester matches the active one; otherwise the snapshot is archived and
 * live state is left alone. Without this, browsing last semester's attendance
 * silently destroys the current semester's data.
 */
export async function saveErpSnapshot(
  snapshot: ERPImportSnapshot,
): Promise<DashboardData> {
  const store = await readStore();

  store.erpSnapshots.push(snapshot);
  store.erpSnapshots = store.erpSnapshots.slice(-MAX_SNAPSHOTS);

  const snapshotSemester = snapshot.student?.semesterLabel?.trim() ?? "";
  const activeSemester = store.activeSemesterLabel.trim();

  const isHistoricalView =
    snapshotSemester !== "" && activeSemester !== "" && snapshotSemester !== activeSemester;

  if (isHistoricalView) {
    await writeStore(store);
    return getDashboardData();
  }

  if (snapshot.student?.studentName) {
    store.student.studentName = snapshot.student.studentName;
  }
  if (snapshot.student?.semesterLabel) {
    store.student.semesterLabel = snapshot.student.semesterLabel;
    store.activeSemesterLabel = snapshot.student.semesterLabel;
  }
  if (snapshot.student?.academicYear) {
    store.student.academicYear = snapshot.student.academicYear;
  }
  if (snapshot.student?.branch) {
    store.student.branch = snapshot.student.branch;
  }
  if (snapshot.student?.section) {
    store.student.section = snapshot.student.section;
  }
  if (snapshot.student?.rollNo) {
    store.student.rollNo = snapshot.student.rollNo;
  }

  // Subject ids are namespaced by semester because course codes repeat across
  // terms and would otherwise collide with stale calendar sessions.
  const academicYearKey = normalizeCode(store.student.academicYear || "current-year");
  const semesterKey = normalizeCode(store.activeSemesterLabel || "current-term");
  const subjectIdFor = (code: string) =>
    `${academicYearKey}:${semesterKey}:${normalizeCode(code)}`;

  const existingById = new Map(store.subjects.map((subject) => [subject.id, subject]));
  const existingByCode = new Map(
    store.subjects.map((subject) => [normalizeCode(subject.code), subject]),
  );

  store.subjects = snapshot.parsedSubjects.map((parsed) => {
    const id = subjectIdFor(parsed.code);
    const existing = existingById.get(id) ?? existingByCode.get(normalizeCode(parsed.code));

    return {
      id,
      code: parsed.code,
      name: parsed.name,
      type: existing?.type ?? inferSubjectType(parsed.name),
      heldClasses: parsed.heldClasses,
      attendedClasses: parsed.attendedClasses,
    };
  });

  // Subject ids may have just changed (new semester, or the first attendance
  // sync after a timetable-only sync), which would orphan every stored session
  // and silently drop it from per-subject impact. Re-match against the new ids.
  store.calendarSessions = reconcileSessionsToSubjects(
    store.calendarSessions,
    store.subjects,
  );
  store.timetable = reconcileTimetableToSubjects(
    store.timetable,
    store.calendarSessions,
    store.subjects,
  );

  await writeStore(store);
  return getDashboardData();
}

/** Merges portal-derived profile fields without disturbing attendance data. */
export async function saveStudentProfile(
  profile: Partial<StudentProfile>,
): Promise<DashboardData> {
  const store = await readStore();

  const assignable: Array<keyof StudentProfile> = [
    "studentName",
    "branch",
    "section",
    "semesterLabel",
    "academicYear",
    "rollNo",
    "studentEmail",
  ];

  for (const key of assignable) {
    const value = profile[key];
    if (typeof value === "string" && value.trim() !== "") {
      store.student[key] = value.trim();
    }
  }

  // First profile read of a new term establishes the active semester.
  if (store.activeSemesterLabel === "" && profile.semesterLabel?.trim()) {
    store.activeSemesterLabel = profile.semesterLabel.trim();
  }

  await writeStore(store);
  return getDashboardData();
}
