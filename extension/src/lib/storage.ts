/**
 * Storage layer — wraps chrome.storage.local with typed access
 * for the AttendanceStore and computed DashboardData.
 */

import { buildDashboardData, simulateAttendance } from "@/lib/attendance-engine";
import type {
  AttendanceAdjustment,
  AttendancePolicy,
  AttendanceStore,
  CalendarSession,
  DashboardData,
  ERPImportSnapshot,
  ScheduleSlot,
  SimulationRequest,
  SimulationResult,
  Subject,
} from "@/lib/types";

const STORE_KEY = "attendance_store";

const DEFAULT_POLICY: AttendancePolicy = {
  thresholdPercent: 75,
  severeMedicalFloorPercent: 60,
  weightageByCategory: {
    normal: 1,
    seminar: 1,
    remedial: 1,
    sessional: 1,
    "technical-event": 1,
    "severe-medical": 0.15,
    curricular: 0,
    placement: 1,
    manual: 1,
  },
};

function defaultStore(): AttendanceStore {
  return {
    student: {
      institute: "NIET Greater Noida",
      studentName: "",
      branch: "",
      semesterLabel: "",
      studentEmail: "",
    },
    policy: DEFAULT_POLICY,
    subjects: [],
    timetable: [],
    calendarSessions: [],
    timetableSync: {
      source: "none",
      status: "idle",
    },
    adjustments: [],
    simulations: [],
    erpSnapshots: [],
  };
}

export async function readStore(): Promise<AttendanceStore> {
  const result = await chrome.storage.local.get(STORE_KEY);
  if (result[STORE_KEY]) {
    const store = result[STORE_KEY] as AttendanceStore;
    if (!store.student) {
      store.student = defaultStore().student;
    }
    if (!store.student.studentName) {
      store.student.studentName = "";
    }
    if (!store.calendarSessions) {
      store.calendarSessions = [];
    }
    if (!store.timetableSync) {
      store.timetableSync = {
        source: store.timetable.length > 0 ? "manual" : "none",
        status: store.timetable.length > 0 ? "ready" : "idle",
      };
    }
    return store;
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
  const recentSimulation = store.simulations.at(-1)?.result;
  const erpSnapshot = store.erpSnapshots?.at(-1);

  return buildDashboardData({
    student: store.student,
    policy: store.policy,
    subjects: store.subjects,
    timetable: store.timetable,
    calendarSessions: store.calendarSessions,
    timetableSync: store.timetableSync,
    adjustments: store.adjustments,
    recentSimulation,
    erpSnapshot,
  });
}

export async function replaceSubjects(subjects: Subject[]): Promise<DashboardData> {
  const store = await readStore();
  store.subjects = subjects;
  await writeStore(store);
  return getDashboardData();
}

export async function replaceTimetable(timetable: ScheduleSlot[]): Promise<DashboardData> {
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

export async function savePortalTimetable(args: {
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  rangeStart: string;
  rangeEnd: string;
  message?: string;
}): Promise<DashboardData> {
  const store = await readStore();
  const existingByCode = new Map(
    store.subjects.map((subject) => [
      subject.code.replace(/[^a-z0-9]/gi, "").toLowerCase(),
      subject,
    ]),
  );

  const resolveSubjectId = (session: CalendarSession) => {
    const normalizedCode = session.subjectCode.replace(/[^a-z0-9]/gi, "").toLowerCase();
    const direct = existingByCode.get(normalizedCode);
    if (direct) {
      return direct.id;
    }

    for (const [code, subject] of existingByCode.entries()) {
      if (
        code.startsWith(normalizedCode) ||
        normalizedCode.startsWith(code)
      ) {
        return subject.id;
      }
    }

    return session.subjectId;
  };

  const reconciledSessions = args.calendarSessions.map((session) => ({
    ...session,
    subjectId: resolveSubjectId(session),
  }));

  store.timetable = args.timetable.map((slot) => ({
    ...slot,
    subjectId:
      reconciledSessions.find(
        (session) =>
          session.dayOfWeek === slot.dayOfWeek &&
          session.startTime === slot.startTime &&
          session.endTime === slot.endTime &&
          session.subjectId === slot.subjectId,
      )?.subjectId ?? resolveSubjectId({
        id: slot.id,
        subjectId: slot.subjectId,
        subjectCode: slot.subjectId,
        subjectName: slot.subjectId,
        date: args.rangeStart,
        dayOfWeek: slot.dayOfWeek,
        startTime: slot.startTime,
        endTime: slot.endTime,
        source: "manual",
      }),
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

export async function saveTimetableSyncError(message: string): Promise<DashboardData> {
  const store = await readStore();
  store.calendarSessions = [];
  store.timetableSync = {
    source: store.timetable.length > 0 ? "manual" : "portal",
    status: "error",
    lastSyncedAt: new Date().toISOString(),
    message,
  };
  await writeStore(store);
  return getDashboardData();
}

export async function addAdjustment(adjustment: AttendanceAdjustment): Promise<DashboardData> {
  const store = await readStore();
  store.adjustments.push(adjustment);
  await writeStore(store);
  return getDashboardData();
}

export async function saveSimulation(request: SimulationRequest): Promise<SimulationResult> {
  const store = await readStore();
  const result = simulateAttendance({
    policy: store.policy,
    subjects: store.subjects,
    timetable: store.timetable,
    calendarSessions: store.calendarSessions,
    adjustments: store.adjustments,
    request,
  });

  store.simulations.push({
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    request,
    result,
  });

  await writeStore(store);
  return result;
}

export async function saveErpSnapshot(snapshot: ERPImportSnapshot): Promise<DashboardData> {
  const store = await readStore();

  if (snapshot.student?.studentName) {
    store.student.studentName = snapshot.student.studentName;
  }
  if (snapshot.student?.semesterLabel) {
    store.student.semesterLabel = snapshot.student.semesterLabel;
  }
  if (snapshot.student?.branch) {
    store.student.branch = snapshot.student.branch;
  }

  if (!store.erpSnapshots) {
    store.erpSnapshots = [];
  }
  store.erpSnapshots.push(snapshot);
  store.erpSnapshots = store.erpSnapshots.slice(-50);

  const existingByCode = new Map(
    store.subjects.map((s) => [s.code.toLowerCase(), s])
  );

  store.subjects = snapshot.parsedSubjects.map((s) => {
    const existing = existingByCode.get(s.code.toLowerCase());
    return {
      id: existing?.id ?? s.code.toLowerCase(),
      code: s.code,
      name: s.name,
      type: existing?.type ?? (/lab/i.test(s.name) ? "lab" as const : /mooc/i.test(s.name) ? "other" as const : "theory" as const),
      heldClasses: s.heldClasses,
      attendedClasses: s.attendedClasses,
    };
  });

  if (!store.calendarSessions) {
    store.calendarSessions = [];
  }

  if (!store.timetableSync) {
    store.timetableSync = {
      source: "none",
      status: "idle",
    };
  }

  await writeStore(store);
  return getDashboardData();
}
