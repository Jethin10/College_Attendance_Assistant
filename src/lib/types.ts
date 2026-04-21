export type SubjectType = "theory" | "lab" | "other";

export type AttendanceAdjustmentCategory =
  | "normal"
  | "seminar"
  | "remedial"
  | "sessional"
  | "technical-event"
  | "severe-medical"
  | "curricular"
  | "placement"
  | "manual";

export type AttendanceAdjustmentSource = "manual" | "erp" | "od";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type SimulationMode =
  | "class-specific"
  | "date-range"
  | "future-count"
  | "leave-days";

export interface Subject {
  id: string;
  code: string;
  name: string;
  type: SubjectType;
  heldClasses: number;
  attendedClasses: number;
}

export interface ScheduleSlot {
  id: string;
  subjectId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  room?: string;
}

export interface CalendarSession {
  id: string;
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  date: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  room?: string;
  faculty?: string;
  source: "portal" | "manual";
}

export interface TimetableSyncState {
  source: "portal" | "manual" | "none";
  status: "idle" | "ready" | "error";
  lastSyncedAt?: string;
  rangeStart?: string;
  rangeEnd?: string;
  message?: string;
}

export interface AttendancePolicy {
  thresholdPercent: number;
  severeMedicalFloorPercent: number;
  weightageByCategory: Record<AttendanceAdjustmentCategory, number>;
}

export interface AttendanceAdjustment {
  id: string;
  subjectIds: string[];
  category: AttendanceAdjustmentCategory;
  source: AttendanceAdjustmentSource;
  approvalStatus: ApprovalStatus;
  fromDate: string;
  toDate: string;
  impactedClasses: number;
  creditedClasses: number;
  notes?: string;
}

export interface ERPImportSnapshot {
  id: string;
  importedAt: string;
  source: string;
  parsedSubjects: Array<{
    code: string;
    name: string;
    heldClasses: number;
    attendedClasses: number;
    attendancePercent?: number;
  }>;
  warnings: string[];
  rawSummary: string;
}

export interface StudentProfile {
  institute: string;
  branch: string;
  semesterLabel: string;
  studentEmail: string;
}

export interface SimulationRequest {
  mode: SimulationMode;
  subjectId?: string;
  slotId?: string;
  futureClasses?: number;
  leaveDays?: number;
  fromDate?: string;
  toDate?: string;
}

export interface SubjectProjection {
  subjectId: string;
  subjectName: string;
  beforeHeld: number;
  beforeAttended: number;
  afterHeld: number;
  afterAttended: number;
  beforePercent: number;
  afterPercent: number;
  deltaPercent: number;
  classesMissed: number;
  bunkableClasses: number;
  recoveryClassesNeeded: number;
  status: "safe" | "warning" | "critical";
}

export interface SimulationResult {
  request: SimulationRequest;
  projections: SubjectProjection[];
  impactedSlots: CalendarSession[];
  overall: {
    beforeAttended: number;
    beforeHeld: number;
    afterAttended: number;
    afterHeld: number;
    beforePercent: number;
    afterPercent: number;
    deltaPercent: number;
    classesMissed: number;
    recoveryClassesNeeded: number;
    recoveryDaysNeeded: number;
    safeLeaveDaysRemaining: number;
    status: "safe" | "warning" | "critical";
  };
  summary: {
    impactedSubjects: number;
    classesMissed: number;
    thresholdBreaches: number;
  };
}

export interface SimulationRecord {
  id: string;
  createdAt: string;
  request: SimulationRequest;
  result: SimulationResult;
}

export interface AttendanceStore {
  student: StudentProfile;
  policy: AttendancePolicy;
  subjects: Subject[];
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  timetableSync: TimetableSyncState;
  adjustments: AttendanceAdjustment[];
  simulations: SimulationRecord[];
  erpSnapshots: ERPImportSnapshot[];
}

export interface DashboardSubject {
  id: string;
  code: string;
  name: string;
  type: SubjectType;
  heldClasses: number;
  attendedClasses: number;
  attendancePercent: number;
  nextMissDropPercent: number;
  bunkableClasses: number;
  recoveryClassesNeeded: number;
  severeMedicalEligible: boolean;
  status: "safe" | "warning" | "critical";
}

export interface DashboardData {
  student: StudentProfile;
  policy: AttendancePolicy;
  overall: {
    attendedClasses: number;
    heldClasses: number;
    attendancePercent: number;
    nextMissDropPercent: number;
    bunkableClasses: number;
    safeLeaveDays: number;
    recoveryClassesNeeded: number;
    status: "safe" | "warning" | "critical";
  };
  subjects: DashboardSubject[];
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  timetableSync: TimetableSyncState;
  adjustments: AttendanceAdjustment[];
  recentSimulation?: SimulationResult;
  erpSnapshot?: ERPImportSnapshot;
  insights: {
    averageAttendance: number;
    belowThresholdCount: number;
    explanation: string;
  };
}
