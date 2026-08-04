/**
 * Storage layer — typed wrapper over chrome.storage.local for the
 * AttendanceStore and the computed DashboardData.
 *
 * Everything here stays on the student's machine. Nothing is transmitted.
 */

import { buildDashboardData, simulateAttendance } from "@/lib/attendance-engine";
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

/** NIET Attendance Policy 2025-26: 75% per subject, 60% floor for condonation. */
const DEFAULT_POLICY: AttendancePolicy = {
  thresholdPercent: 75,
  severeMedicalFloorPercent: 60,
};

function defaultStudent(): StudentProfile {
  return {
    institute: "NIET Greater Noida",
    studentName: "",
    branch: "",
    section: "",
    semesterLabel: "",
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
    policy: { ...base.policy, ...(stored.policy ?? {}) },
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

export async function savePortalTimetable(args: {
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  rangeStart: string;
  rangeEnd: string;
  message?: string;
}): Promise<DashboardData> {
  const store = await readStore();

  const byCode = new Map(
    store.subjects.map((subject) => [normalizeCode(subject.code), subject]),
  );

  /**
   * The timetable feed and the attendance table name subjects differently, so
   * match on an exact normalised code first, then on a prefix either way
   * ("CS301" vs "CS301A"). Falls back to the feed's own id.
   */
  const resolveSubjectId = (subjectCode: string, fallbackId: string) => {
    const normalized = normalizeCode(subjectCode);
    const direct = byCode.get(normalized);
    if (direct) {
      return direct.id;
    }

    for (const [code, subject] of byCode.entries()) {
      if (code.startsWith(normalized) || normalized.startsWith(code)) {
        return subject.id;
      }
    }

    return fallbackId;
  };

  const reconciledSessions = args.calendarSessions.map((session) => ({
    ...session,
    subjectId: resolveSubjectId(session.subjectCode, session.subjectId),
  }));

  // Weekly slots carry a subject code in subjectId (set by the content script).
  store.timetable = args.timetable.map((slot) => ({
    ...slot,
    subjectId: resolveSubjectId(slot.subjectId, slot.subjectId),
  }));
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
  const semesterKey = normalizeCode(store.activeSemesterLabel || "current");
  const subjectIdFor = (code: string) => `${semesterKey}:${normalizeCode(code)}`;

  const existingById = new Map(store.subjects.map((subject) => [subject.id, subject]));

  store.subjects = snapshot.parsedSubjects.map((parsed) => {
    const id = subjectIdFor(parsed.code);
    const existing = existingById.get(id);

    return {
      id,
      code: parsed.code,
      name: parsed.name,
      type: existing?.type ?? inferSubjectType(parsed.name),
      heldClasses: parsed.heldClasses,
      attendedClasses: parsed.attendedClasses,
    };
  });

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
