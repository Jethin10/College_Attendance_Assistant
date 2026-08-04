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
   * Minimum attendance percentage. Applied to the OVERALL figure, which is
   * what NIET currently enforces in practice.
   */
  thresholdPercent: number;
  /** Floor below which severe-medical condonation cannot be granted. */
  severeMedicalFloorPercent: number;
  /**
   * When true, the verdict is driven by the weakest subject rather than the
   * overall figure.
   *
   * The signed Attendance Policy 2025-26 (section 1) requires 75% in each
   * subject individually, but that clause is not being enforced — only the
   * overall percentage is. The extension therefore reports on overall by
   * default and keeps per-subject shortfalls as an advisory note, so students
   * are not told they are unsafe when the institute considers them fine.
   */
  enforcePerSubject: boolean;
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
    /** Status of the overall percentage after the simulated absence. */
    status: RiskStatus;
    /** Weakest subject after the absence, as advisory context. */
    weakestSubjectName?: string;
    weakestSubjectPercent?: number;
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
    /** Aggregate percentage — the figure NIET enforces and the ERP displays. */
    attendancePercent: number;
    nextMissDropPercent: number;
    /** Classes that can be missed while overall stays at or above the threshold. */
    safeToMissClasses: number;
    safeLeaveDays: number;
    /** Classes needed to bring overall back to the threshold. */
    recoveryClassesNeeded: number;
    /** Status of the overall percentage. */
    status: RiskStatus;
    /**
     * Weakest subject, surfaced as advisory context rather than as the verdict.
     * Present whenever at least one subject has started.
     */
    weakestSubjectId?: string;
    weakestSubjectName?: string;
    weakestSubjectPercent?: number;
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
