export type SubjectType = "theory" | "lab" | "other";

export type SimulationMode =
  | "class-specific"
  | "date-range"
  | "future-count"
  | "leave-days";

export type RiskStatus = "safe" | "warning" | "critical";

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

export type TimetableSyncStatus = "idle" | "ready" | "error" | "session-expired";

export interface TimetableSyncState {
  source: "portal" | "manual" | "none";
  status: TimetableSyncStatus;
  lastSyncedAt?: string;
  rangeStart?: string;
  rangeEnd?: string;
  message?: string;
}

export interface AttendancePolicy {
  /**
   * NIET requires 75% in each theory and practical subject individually
   * (Attendance Policy 2025-26, section 1). This threshold is therefore
   * applied per subject, not to the aggregate.
   */
  thresholdPercent: number;
  /** Floor below which severe-medical condonation cannot be granted. */
  severeMedicalFloorPercent: number;
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
  student?: {
    studentName?: string;
    semesterLabel?: string;
    branch?: string;
    section?: string;
    rollNo?: string;
  };
}

export interface StudentProfile {
  institute: string;
  studentName: string;
  branch: string;
  section: string;
  semesterLabel: string;
  rollNo: string;
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
  status: RiskStatus;
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
    /** True when the synced schedule ends before recovery is achievable. */
    recoveryBeyondSchedule: boolean;
    safeLeaveDaysRemaining: number;
    /** Worst per-subject status after the simulated absence. */
    status: RiskStatus;
    /** Subject that breaches the threshold first, if any. */
    bindingSubjectName?: string;
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
  simulations: SimulationRecord[];
  erpSnapshots: ERPImportSnapshot[];
  /** Semester the stored subjects belong to; guards against rollover clobbering. */
  activeSemesterLabel: string;
  preferences: {
    showPageOverlay: boolean;
  };
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
  status: RiskStatus | "not-started";
}

export interface DashboardData {
  student: StudentProfile;
  policy: AttendancePolicy;
  overall: {
    attendedClasses: number;
    heldClasses: number;
    /** Aggregate percentage. Shown for cross-checking against the ERP only. */
    attendancePercent: number;
    nextMissDropPercent: number;
    /**
     * Classes that can be missed while every subject stays at or above the
     * threshold. This is the minimum across started subjects, NOT the figure
     * derived from aggregate totals.
     */
    safeToMissClasses: number;
    /** Subject with the least headroom; the constraint the student feels. */
    bindingSubjectId?: string;
    bindingSubjectName?: string;
    bindingSubjectPercent?: number;
    safeLeaveDays: number;
    /** Classes needed to bring every subject back to the threshold. */
    recoveryClassesNeeded: number;
    /** Worst status across started subjects. */
    status: RiskStatus;
  };
  subjects: DashboardSubject[];
  timetable: ScheduleSlot[];
  calendarSessions: CalendarSession[];
  timetableSync: TimetableSyncState;
  recentSimulation?: SimulationResult;
  erpSnapshot?: ERPImportSnapshot;
  insights: {
    averageAttendance: number;
    belowThresholdCount: number;
    explanation: string;
  };
}
