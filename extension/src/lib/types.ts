export type SubjectType = "theory" | "lab" | "other";

export type SimulationMode =
  | "class-specific"
  | "date-range"
  | "future-count"
  | "leave-days";

export type LeaveDayPart = "full" | "morning" | "afternoon";

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
  /** True when this occurrence was inferred because NIET had no dated row. */
  estimated?: boolean;
  /** Dated portal schedule used as the template for an inferred occurrence. */
  inferredFromDate?: string;
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
   * Minimum attendance percentage. NIET's current 2025-26 policy applies it
   * to each theory and practical subject individually.
   */
  thresholdPercent: number;
  /** Floor below which severe-medical condonation cannot be granted. */
  severeMedicalFloorPercent: number;
  /**
   * When true, the verdict is driven by the weakest subject rather than the
   * overall figure.
   *
   * The aggregate percentage is still shown because it is the figure exposed
   * by the ERP summary, but it must not hide a subject below the requirement.
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
    academicYear?: string;
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
  academicYear?: string;
  rollNo: string;
  studentEmail: string;
}

export interface SimulationRequest {
  mode: SimulationMode;
  subjectId?: string;
  slotId?: string;
  futureClasses?: number;
  leaveDays?: number;
  dayPart?: LeaveDayPart;
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
    /** Scheduled classes assumed attended before or around the planned leave. */
    classesAssumedAttended: number;
    classesMissed: number;
    recoveryClassesNeeded: number;
    recoveryDaysNeeded: number;
    /** True when the synced schedule ends before recovery is achievable. */
    recoveryBeyondSchedule: boolean;
    safeLeaveDaysRemaining: number;
    /** Policy verdict after the simulated absence. */
    status: RiskStatus;
    /** Weakest subject after the absence. */
    weakestSubjectName?: string;
    weakestSubjectPercent?: number;
  };
  summary: {
    impactedSubjects: number;
    /** Scheduled non-leave classes included in the chronological projection. */
    classesAssumedAttended: number;
    classesMissed: number;
    /** Impacted subjects below the threshold after the simulation. */
    thresholdBreaches: number;
    /** All started subjects below the threshold after the simulation. */
    subjectsBelowThreshold: number;
    /** Subjects that cross from compliant to below-threshold in this simulation. */
    newThresholdBreaches: number;
    /** The selected date was inferred from a coherent weekday template. */
    scheduleEstimated: boolean;
    /** Portal dates used as templates, newest first. */
    scheduleSourceDates: string[];
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
    /** Aggregate percentage displayed by the ERP. */
    attendancePercent: number;
    nextMissDropPercent: number;
    /** Classes that can be missed while overall stays at or above the threshold. */
    safeToMissClasses: number;
    safeLeaveDays: number;
    /** Classes needed to bring overall back to the threshold. */
    recoveryClassesNeeded: number;
    /** Policy verdict, using the weakest started subject when required. */
    status: RiskStatus;
    /**
     * Weakest subject. Present whenever at least one subject has started.
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
