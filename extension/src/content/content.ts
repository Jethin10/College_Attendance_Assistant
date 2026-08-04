/**
 * Content script — runs on nietcloud.niet.co.in.
 *
 * Reads the attendance table, pulls the student's dated schedule and academic
 * details from the portal's own JSON endpoints (using the session the student
 * is already signed in with), and injects on-page badges.
 *
 * Nothing leaves the browser. Every request here targets the ERP itself.
 */

const OVERLAY_ATTR = "data-niet-planner";
const THRESHOLD = 75;
const RESCAN_DEBOUNCE_MS = 500;
const TIMETABLE_RANGE_DAYS = 45;
const TIMETABLE_REFRESH_MS = 5 * 60 * 1000;

type ScheduleSlot = {
  id: string;
  subjectId: string;
  dayOfWeek: number;
  startTime: string;
  endTime: string;
  room?: string;
};

type CalendarSession = {
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
};

type StudentContext = {
  studentName?: string;
  semesterLabel?: string;
  branch?: string;
  section?: string;
  rollNo?: string;
};

type ERPImportSnapshot = {
  id: string;
  importedAt: string;
  source: string;
  parsedSubjects: ParsedSubject[];
  warnings: string[];
  rawSummary: string;
  student?: StudentContext;
};

type ParsedSubject = {
  code: string;
  name: string;
  heldClasses: number;
  attendedClasses: number;
  attendancePercent?: number;
};

type PortalTimetableRow = {
  lectureDate?: string;
  startTimeHM?: string;
  endTimeHM?: string;
  lStartTime?: string;
  lEndTime?: string;
  subjectId?: string;
  subShortName?: string;
  subName?: string;
  subjectName?: string;
  employeeName1?: string;
  roomNo?: string;
  roomName?: string;
};

/** Thrown when the portal answers with the login page instead of data. */
class SessionExpiredError extends Error {
  constructor() {
    super("Your NIET ERP session expired. Sign in again to refresh.");
    this.name = "SessionExpiredError";
  }
}

let lastSignature = "";
let lastTimetableSignature = "";
let lastTimetableFetchAt = 0;
let rescanTimer: number | null = null;
let currentUrl = location.href;
let overlayEnabled = true;
let observer: MutationObserver | null = null;
/** Set while we mutate the DOM ourselves, so the observer ignores our writes. */
let injecting = false;

function round(value: number, digits = 2) {
  return Number(value.toFixed(digits));
}

function computeAttendancePercent(attended: number, held: number) {
  if (held <= 0) {
    return 100;
  }

  return round((attended / held) * 100);
}

function computeBunkableClasses(
  attended: number,
  held: number,
  thresholdPercent: number,
) {
  if (held <= 0) {
    return 0;
  }

  const thresholdRatio = thresholdPercent / 100;
  return Math.max(0, Math.floor(attended / thresholdRatio - held));
}

function computeRecoveryClassesNeeded(
  attended: number,
  held: number,
  thresholdPercent: number,
) {
  const thresholdRatio = thresholdPercent / 100;

  if (held <= 0 || thresholdRatio >= 1 || attended / held >= thresholdRatio) {
    return 0;
  }

  const needed = (thresholdRatio * held - attended) / (1 - thresholdRatio);
  return Math.max(0, Math.ceil(round(needed, 6)));
}

function getSubjectStatus(
  percent: number,
  thresholdPercent: number,
): "safe" | "warning" | "critical" {
  if (percent < thresholdPercent) {
    return "critical";
  }

  if (percent < thresholdPercent + 5) {
    return "warning";
  }

  return "safe";
}

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function parseAttendanceCount(
  value: string,
): { attendedClasses: number; heldClasses: number } | null {
  const match = value.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) {
    return null;
  }

  return {
    attendedClasses: Number(match[1]),
    heldClasses: Number(match[2]),
  };
}

function asNumber(value: string): number {
  const numeric = Number(value.replace(/[^\d.]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function asCount(value: string): number | null {
  const normalized = value.replace(/,/g, "").trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    return null;
  }

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeHeader(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

type AttendanceColumns = {
  code: number;
  name: number;
  attended: number;
  held: number;
  percentage: number;
};

function getTableRows(table: ParentNode): HTMLTableRowElement[] {
  return Array.from(table.querySelectorAll("tr"));
}

function findHeaderIndex(headers: string[], aliases: string[]): number {
  return headers.findIndex((header) => aliases.includes(header));
}

function getAttendanceColumns(table: ParentNode): AttendanceColumns | null {
  for (const row of getTableRows(table)) {
    const headerCells = Array.from(row.querySelectorAll("th"));
    if (headerCells.length < 3) {
      continue;
    }

    const headers = headerCells.map((cell) => normalizeHeader(cell.textContent ?? ""));
    const columns: AttendanceColumns = {
      code: findHeaderIndex(headers, ["course code", "subject code", "paper code", "code"]),
      name: findHeaderIndex(headers, [
        "course name",
        "subject name",
        "paper name",
        "subject",
        "course",
      ]),
      attended: findHeaderIndex(headers, [
        "present count",
        "present",
        "attended count",
        "attended classes",
        "classes attended",
      ]),
      held: findHeaderIndex(headers, [
        "total count",
        "classes held",
        "held classes",
        "total classes",
      ]),
      percentage: findHeaderIndex(headers, [
        "percentage",
        "attendance percentage",
        "attendance percent",
        "percent",
      ]),
    };

    if (columns.code >= 0 && columns.name >= 0 && columns.attended >= 0 && columns.held >= 0) {
      return columns;
    }
  }

  return null;
}

function scoreAttendanceTable(table: HTMLTableElement): number {
  const rows = getTableRows(table);
  if (rows.length === 0) {
    return -1;
  }

  const text = normalizeWhitespace(table.textContent ?? "").toLowerCase();
  let score = 0;

  if (text.includes("attendance")) {
    score += 5;
  }

  if (text.includes("course") || text.includes("subject")) {
    score += 2;
  }

  if (getAttendanceColumns(table)) {
    score += 20;
  }

  if (text.includes("present count")) {
    score += 4;
  }

  if (text.includes("total count") && text.includes("percentage")) {
    score += 4;
  }

  score += rows.reduce((sum, row) => {
    const rowText = normalizeWhitespace(row.textContent ?? "");
    if (!/\d+\s*\/\s*\d+/.test(rowText)) {
      return sum;
    }

    return sum + (/[A-Z]{2,}\d+[A-Z0-9]*/i.test(rowText) ? 3 : 1);
  }, 0);

  return score;
}

function findAttendanceTableInRoot(root: ParentNode): HTMLTableElement | null {
  let bestTable: HTMLTableElement | null = null;
  let bestScore = 0;

  for (const table of Array.from(root.querySelectorAll("table"))) {
    const score = scoreAttendanceTable(table);
    if (score > bestScore) {
      bestTable = table;
      bestScore = score;
    }
  }

  return bestTable;
}

function findAttendanceTableElement(): HTMLTableElement | null {
  return findAttendanceTableInRoot(document);
}

function parseHeaderMappedRow(
  cells: string[],
  columns: AttendanceColumns,
): ParsedSubject | null {
  const code = cells[columns.code] ?? "";
  const name = cells[columns.name] ?? "";
  const attendedClasses = asCount(cells[columns.attended] ?? "");
  const heldClasses = asCount(cells[columns.held] ?? "");

  if (
    !code ||
    !name ||
    !/[A-Za-z]/.test(code) ||
    !/[A-Za-z]/.test(name) ||
    attendedClasses === null ||
    heldClasses === null
  ) {
    return null;
  }

  const percentageText = columns.percentage >= 0 ? (cells[columns.percentage] ?? "") : "";

  return {
    code,
    name,
    attendedClasses,
    heldClasses,
    attendancePercent: percentageText ? asNumber(percentageText) : undefined,
  };
}

function parseLegacyRow(cells: string[]): ParsedSubject | null {
  const [code, courseName, attendanceCount, percentage = ""] = cells;
  const counts = parseAttendanceCount(attendanceCount);

  if (code && courseName && counts) {
    return {
      code,
      name: courseName,
      attendedClasses: counts.attendedClasses,
      heldClasses: counts.heldClasses,
      attendancePercent: percentage ? asNumber(percentage) : undefined,
    };
  }

  const attendanceCell = cells.find((cell) => /\d+\s*\/\s*\d+/.test(cell));
  const codeCell = cells.find((cell) => /^[A-Z]{2,}\d+[A-Z0-9]*$/i.test(cell));
  if (!attendanceCell || !codeCell) {
    return null;
  }

  const flexCounts = parseAttendanceCount(attendanceCell);
  if (!flexCounts) {
    return null;
  }

  const codeIndex = cells.indexOf(codeCell);
  const percentageCell = cells.find((cell) => /^\d+(\.\d+)?%?$/.test(cell));
  const nameCell =
    cells[codeIndex + 1] &&
    !/\d+\s*\/\s*\d+/.test(cells[codeIndex + 1]) &&
    cells[codeIndex + 1] !== percentageCell
      ? cells[codeIndex + 1]
      : (cells.find((cell) => /[A-Za-z]{3,}/.test(cell) && cell !== codeCell) ?? codeCell);

  return {
    code: codeCell,
    name: nameCell,
    attendedClasses: flexCounts.attendedClasses,
    heldClasses: flexCounts.heldClasses,
    attendancePercent: percentageCell ? asNumber(percentageCell) : undefined,
  };
}

function parseSubjectsFromTable(table: ParentNode): ParsedSubject[] {
  const subjects: ParsedSubject[] = [];
  const columns = getAttendanceColumns(table);

  getTableRows(table).forEach((row) => {
    const cells = Array.from(row.querySelectorAll("td")).map((cell) =>
      normalizeWhitespace(cell.textContent ?? ""),
    );

    if (cells.length < 3) {
      return;
    }

    const subject = columns
      ? parseHeaderMappedRow(cells, columns)
      : parseLegacyRow(cells);
    if (subject) {
      subjects.push(subject);
    }
  });

  const deduped = new Map<string, ParsedSubject>();
  for (const subject of subjects) {
    const key = `${subject.code.toLowerCase()}::${subject.name.toLowerCase()}`;
    if (!deduped.has(key)) {
      deduped.set(key, subject);
    }
  }

  return Array.from(deduped.values()).filter(
    (subject) => subject.code && subject.name && subject.heldClasses >= 0,
  );
}

function scrapeAttendanceFromDOM(): ParsedSubject[] {
  const table = findAttendanceTableElement();
  return table ? parseSubjectsFromTable(table) : [];
}

function detectAttendanceTable(): boolean {
  return findAttendanceTableInRoot(document) !== null;
}

function buildSnapshot(
  parsedSubjects: ParsedSubject[],
  rawSummary: string,
  warnings: string[],
  student?: StudentContext,
): ERPImportSnapshot {
  return {
    id: crypto.randomUUID(),
    importedAt: new Date().toISOString(),
    source: "nietcloud.niet.co.in",
    parsedSubjects,
    warnings,
    rawSummary,
    student,
  };
}

/** Semester shown in the page's own dropdown; used as a fallback. */
function detectSemesterFromDom(): string | undefined {
  const semesterSelect = Array.from(document.querySelectorAll("select")).find((select) =>
    Array.from(select.options).some((option) => /^SEM(?:ESTER)?[-\s]/i.test(option.text.trim())),
  );

  return semesterSelect?.selectedOptions[0]?.text.trim() || undefined;
}

function detectStudentNameFromDom(): string | undefined {
  const profileLink = document.querySelector<HTMLAnchorElement>(
    'a[href*="stu_studentProfile"]',
  );
  return normalizeWhitespace(profileLink?.textContent ?? "") || undefined;
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatPortalDate(date: Date) {
  const month = date.toLocaleString("en-US", { month: "short" });
  return `${month} ${`${date.getDate()}`.padStart(2, "0")},${date.getFullYear()}`;
}

function parsePortalDate(dateText?: string) {
  if (!dateText) {
    return null;
  }

  const match = dateText.trim().match(/^([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})$/);
  if (!match) {
    return null;
  }

  const monthNames = [
    "jan", "feb", "mar", "apr", "may", "jun",
    "jul", "aug", "sep", "oct", "nov", "dec",
  ];
  const monthIndex = monthNames.indexOf(match[1].toLowerCase());
  if (monthIndex < 0) {
    return null;
  }

  return new Date(Number(match[3]), monthIndex, Number(match[2]));
}

function normalizePortalDate(dateText?: string) {
  const date = parsePortalDate(dateText);
  return date ? toDateKey(date) : null;
}

function normalizeTime(raw?: string) {
  const value = raw?.trim();
  if (!value) {
    return null;
  }

  const match = value.match(/^(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }

  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function subjectSignature() {
  return JSON.stringify(
    scrapeAttendanceFromDOM().map((subject) => [
      subject.code,
      subject.name,
      subject.attendedClasses,
      subject.heldClasses,
    ]),
  );
}

function clearOverlay() {
  document.querySelectorAll(`[${OVERLAY_ATTR}]`).forEach((element) => element.remove());
}

function injectOverlayBadges() {
  clearOverlay();

  if (!overlayEnabled) {
    return;
  }

  const subjects = scrapeAttendanceFromDOM();
  if (subjects.length === 0) {
    return;
  }

  const attendanceTable = findAttendanceTableElement();
  if (!attendanceTable) {
    return;
  }

  const started = subjects.filter((subject) => subject.heldClasses > 0);

  const totalAttended = subjects.reduce((sum, s) => sum + s.attendedClasses, 0);
  const totalHeld = subjects.reduce((sum, s) => sum + s.heldClasses, 0);

  // Overall is what the institute enforces, so the bar reports on that and the
  // number always agrees with the portal's own figure.
  const overallPercent = computeAttendancePercent(totalAttended, totalHeld);
  const safeToMiss = computeBunkableClasses(totalAttended, totalHeld, THRESHOLD);
  const overallStatus = getSubjectStatus(overallPercent, THRESHOLD);
  const belowCount = started.filter(
    (subject) =>
      computeAttendancePercent(subject.attendedClasses, subject.heldClasses) < THRESHOLD,
  ).length;

  const summaryBar = document.createElement("div");
  summaryBar.setAttribute(OVERLAY_ATTR, "summary");
  summaryBar.className = "niet-planner-summary";

  const brand = document.createElement("div");
  brand.className = "niet-planner-summary__brand";
  brand.innerHTML = `
    <span class="niet-planner-summary__logo">Attendance Planner</span>
    <span class="niet-planner-summary__caption">${
      belowCount > 0
        ? `${belowCount} subject${belowCount === 1 ? "" : "s"} below 75%`
        : "Based on your overall attendance"
    }</span>
  `;

  const stats = document.createElement("div");
  stats.className = "niet-planner-summary__stats";
  stats.innerHTML = `
    <span class="niet-planner-summary__stat">
      Overall
      <strong class="niet-planner-status--${overallStatus}">${overallPercent}%</strong>
    </span>
    <span class="niet-planner-summary__stat">
      Safe to miss
      <strong class="niet-planner-status--${overallStatus}">${safeToMiss}</strong>
    </span>
    <span class="niet-planner-summary__stat">
      Classes
      <strong>${totalAttended}/${totalHeld}</strong>
    </span>
  `;

  const dismiss = document.createElement("button");
  dismiss.className = "niet-planner-summary__dismiss";
  dismiss.type = "button";
  dismiss.title = "Hide this bar on ERP pages";
  dismiss.setAttribute("aria-label", "Hide this bar on ERP pages");
  dismiss.textContent = "×";
  dismiss.addEventListener("click", () => {
    overlayEnabled = false;
    clearOverlay();
    chrome.runtime
      .sendMessage({ type: "SET_OVERLAY_PREFERENCE", payload: false })
      .catch(() => {});
  });

  const inner = document.createElement("div");
  inner.className = "niet-planner-summary__inner";
  inner.append(brand, stats, dismiss);
  summaryBar.append(inner);

  attendanceTable.parentElement?.insertBefore(summaryBar, attendanceTable);

  const columns = getAttendanceColumns(attendanceTable);
  const subjectsByKey = new Map(
    subjects.map((subject) => [
      `${subject.code.toLowerCase()}::${subject.name.toLowerCase()}`,
      subject,
    ]),
  );

  attendanceTable.querySelectorAll("tr").forEach((row) => {
    const cells = row.querySelectorAll("td");
    if (cells.length < 4) {
      return;
    }

    const cellTexts = Array.from(cells).map((cell) =>
      normalizeWhitespace(cell.textContent ?? ""),
    );
    const parsedRow = columns
      ? parseHeaderMappedRow(cellTexts, columns)
      : parseLegacyRow(cellTexts);
    if (!parsedRow) {
      return;
    }

    const subject = subjectsByKey.get(
      `${parsedRow.code.toLowerCase()}::${parsedRow.name.toLowerCase()}`,
    );
    if (!subject) {
      return;
    }

    const percent = computeAttendancePercent(
      subject.attendedClasses,
      subject.heldClasses,
    );
    const recovery = computeRecoveryClassesNeeded(
      subject.attendedClasses,
      subject.heldClasses,
      THRESHOLD,
    );

    const badge = document.createElement("span");
    badge.setAttribute(OVERLAY_ATTR, "badge");

    // Per-row badges report only this subject's own standing. They do not claim
    // it is safe to miss a class, because that depends on the overall figure.
    if (subject.heldClasses === 0) {
      badge.className = "niet-planner-badge niet-planner-badge--neutral";
      badge.textContent = "Not started";
    } else if (percent < THRESHOLD) {
      badge.className = "niet-planner-badge niet-planner-badge--critical";
      badge.textContent = `${recovery} to reach 75%`;
    } else {
      badge.className = "niet-planner-badge niet-planner-badge--safe";
      badge.textContent = "Above 75%";
    }

    cells[cells.length - 1].appendChild(badge);
  });
}

async function sendAttendanceToServiceWorker(student: StudentContext) {
  const subjects = scrapeAttendanceFromDOM();
  if (subjects.length === 0) {
    return;
  }

  await chrome.runtime.sendMessage({
    type: "ATTENDANCE_SCRAPED",
    payload: buildSnapshot(
      subjects,
      `Auto-scraped from ${window.location.href}`,
      [],
      student,
    ),
  });
}

function deriveSubjectCode(row: PortalTimetableRow) {
  const fromShortName = row.subShortName?.trim();
  if (fromShortName) {
    return fromShortName;
  }

  const suffix = row.subjectId?.split("-").at(-1)?.trim();
  if (suffix) {
    return suffix;
  }

  const match = (row.subjectName ?? row.subName ?? "").match(/[A-Z]{2,}\d+[A-Z0-9]*/i);
  return match?.[0] ?? "unknown";
}

function buildCalendarSessions(rows: PortalTimetableRow[]) {
  const sessions: CalendarSession[] = [];

  rows.forEach((row, index) => {
    const dateKey = normalizePortalDate(row.lectureDate);
    const startTime = normalizeTime(row.startTimeHM ?? row.lStartTime);
    const endTime = normalizeTime(row.endTimeHM ?? row.lEndTime);
    const code = deriveSubjectCode(row);

    if (!dateKey || !startTime || !endTime || !code) {
      return;
    }

    const dayOfWeek = parsePortalDate(row.lectureDate)?.getDay();
    if (dayOfWeek === undefined) {
      return;
    }

    const subjectId = code.toLowerCase();

    sessions.push({
      id: `${subjectId}:${dateKey}:${startTime}:${index}`,
      subjectId,
      subjectCode: code,
      subjectName: row.subjectName?.trim() || row.subName?.trim() || code,
      date: dateKey,
      dayOfWeek,
      startTime,
      endTime,
      room: row.roomNo?.trim() || row.roomName?.trim() || undefined,
      faculty: row.employeeName1?.trim() || undefined,
      source: "portal",
    });
  });

  return sessions.sort(
    (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
  );
}

function buildWeeklyTimetable(calendarSessions: CalendarSession[]): ScheduleSlot[] {
  const unique = new Map<string, ScheduleSlot>();

  calendarSessions.forEach((session) => {
    const key = [
      session.subjectId,
      session.dayOfWeek,
      session.startTime,
      session.endTime,
      session.room ?? "",
    ].join("|");

    if (!unique.has(key)) {
      unique.set(key, {
        id: `slot:${session.subjectId}:${session.dayOfWeek}:${session.startTime}:${session.endTime}`,
        subjectId: session.subjectId,
        dayOfWeek: session.dayOfWeek,
        startTime: session.startTime,
        endTime: session.endTime,
        room: session.room,
      });
    }
  });

  return [...unique.values()].sort(
    (a, b) => a.dayOfWeek - b.dayOfWeek || a.startTime.localeCompare(b.startTime),
  );
}

/**
 * Fetches JSON from the portal.
 *
 * An expired session does NOT 401 here — the ERP serves its login page with
 * HTTP 200 and an HTML body, so `response.json()` would throw an opaque parse
 * error. Detect that case explicitly and report it as a session expiry.
 */
async function fetchPortalJson(path: string): Promise<unknown> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (response.status === 401 || response.status === 403) {
    throw new SessionExpiredError();
  }

  if (!response.ok) {
    throw new Error(`Portal request failed with ${response.status}`);
  }

  const body = await response.text();
  const looksLikeHtml = /^\s*(<!doctype|<html)/i.test(body);
  const isLoginPage = looksLikeHtml && /login|j_spring_security|signin/i.test(body);

  if (isLoginPage) {
    throw new SessionExpiredError();
  }

  if (looksLikeHtml) {
    throw new Error("The portal returned a page instead of data.");
  }

  if (body.trim() === "") {
    return null;
  }

  try {
    // Some endpoints double-encode: a JSON string containing JSON.
    const parsed = JSON.parse(body);
    return typeof parsed === "string" ? JSON.parse(parsed) : parsed;
  } catch {
    throw new Error("The portal returned data in an unexpected format.");
  }
}

/**
 * Branch, section, semester and roll number.
 *
 * Source of truth for who the student is; replaces guessing from page markup.
 * Failure is non-fatal — attendance still works without it.
 */
async function fetchAcademicInfo(): Promise<StudentContext> {
  try {
    const payload = (await fetchPortalJson("stu_getAcademicInformationNew.json")) as
      | { AcademicInfo?: Record<string, string> }
      | null;

    const info = payload?.AcademicInfo;
    if (!info) {
      return {};
    }

    const clean = (value?: string) => {
      const trimmed = value?.trim();
      return trimmed && trimmed !== "null" ? trimmed : undefined;
    };

    return {
      branch: clean(info.courseName),
      section: clean(info.divisionName),
      semesterLabel: clean(info.semesterName),
      rollNo: clean(info.rollNo),
    };
  } catch (error) {
    if (error instanceof SessionExpiredError) {
      throw error;
    }
    return {};
  }
}

async function resolveStudentContext(): Promise<StudentContext> {
  const fromPortal = await fetchAcademicInfo().catch((error) => {
    if (error instanceof SessionExpiredError) {
      throw error;
    }
    return {} as StudentContext;
  });

  return {
    ...fromPortal,
    studentName: fromPortal.studentName ?? detectStudentNameFromDom(),
    semesterLabel: fromPortal.semesterLabel ?? detectSemesterFromDom(),
  };
}

async function fetchPortalTimetable(force = false) {
  const now = Date.now();
  if (!force && now - lastTimetableFetchAt < TIMETABLE_REFRESH_MS) {
    return { imported: false, count: 0, skipped: true };
  }

  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + TIMETABLE_RANGE_DAYS);

  const rangeStart = toDateKey(start);
  const rangeEnd = toDateKey(end);

  const [todayPayload, betweenPayload] = await Promise.all([
    fetchPortalJson(
      `/stu_getTodaysScheduleForStudentLoggedIn.json?date=${encodeURIComponent(
        formatPortalDate(start),
      )}`,
    ).catch((error) => {
      if (error instanceof SessionExpiredError) {
        throw error;
      }
      return [];
    }),
    fetchPortalJson(
      `/getBetweenDatesTimetableForStudent.json?startDate=${encodeURIComponent(
        formatPortalDate(start),
      )}&endDate=${encodeURIComponent(formatPortalDate(end))}`,
    ),
  ]);

  const rows = Array.isArray(betweenPayload) ? (betweenPayload as PortalTimetableRow[]) : [];
  const calendarSessions = buildCalendarSessions(rows);
  const timetable = buildWeeklyTimetable(calendarSessions);

  const holidayMessage =
    Array.isArray(todayPayload) && (todayPayload[0] as { holiday?: string })?.holiday
      ? `Today is marked as ${(todayPayload[0] as { holiday?: string }).holiday}.`
      : undefined;

  const signature = JSON.stringify(
    calendarSessions.map((session) => [
      session.subjectId,
      session.date,
      session.startTime,
      session.endTime,
    ]),
  );

  if (!force && signature === lastTimetableSignature) {
    lastTimetableFetchAt = now;
    return { imported: false, count: calendarSessions.length };
  }

  lastTimetableSignature = signature;
  lastTimetableFetchAt = now;

  await chrome.runtime.sendMessage({
    type: "PORTAL_TIMETABLE_SCRAPED",
    payload: {
      timetable,
      calendarSessions,
      rangeStart,
      rangeEnd,
      message:
        calendarSessions.length > 0
          ? holidayMessage
            ? `Synced ${calendarSessions.length} upcoming classes. ${holidayMessage}`
            : `Synced ${calendarSessions.length} upcoming classes.`
          : (holidayMessage ?? "The portal returned no upcoming classes in this range."),
    },
  });

  return { imported: true, count: calendarSessions.length };
}

async function reportSyncProblem(error: unknown) {
  const expired = error instanceof SessionExpiredError;

  await chrome.runtime
    .sendMessage({
      type: "PORTAL_TIMETABLE_ERROR",
      payload: {
        message:
          expired || !(error instanceof Error)
            ? "Your NIET ERP session expired. Sign in again to refresh."
            : error.message,
        status: expired ? "session-expired" : "error",
      },
    })
    .catch(() => {});
}

async function syncPortalData(force = false) {
  let student: StudentContext = {};
  let timetableImported = false;

  try {
    student = await resolveStudentContext();

    if (Object.values(student).some(Boolean)) {
      await chrome.runtime
        .sendMessage({ type: "STUDENT_PROFILE_DETECTED", payload: student })
        .catch(() => {});
    }

    const timetableResult = await fetchPortalTimetable(force);
    timetableImported = timetableResult.imported;
  } catch (error) {
    await reportSyncProblem(error);
  }

  if (!detectAttendanceTable()) {
    clearOverlay();
    lastSignature = "";
    return { found: false, imported: false, timetableImported };
  }

  const signature = subjectSignature();
  if (!force && signature === lastSignature) {
    return { found: true, imported: false, timetableImported };
  }

  lastSignature = signature;

  // Suspend observation while we write to the page, otherwise our own badge
  // insertions retrigger the observer and it rescans forever.
  injecting = true;
  try {
    injectOverlayBadges();
  } finally {
    injecting = false;
  }

  await sendAttendanceToServiceWorker(student);
  return { found: true, imported: true, timetableImported };
}

function scheduleSync(force = false) {
  if (rescanTimer !== null) {
    window.clearTimeout(rescanTimer);
  }

  rescanTimer = window.setTimeout(() => {
    syncPortalData(force).catch((error) => {
      console.warn("[NIET Planner] Sync failed:", error);
    });
  }, RESCAN_DEBOUNCE_MS);
}

/** True when every mutation came from our own overlay. */
function isSelfInflicted(mutations: MutationRecord[]) {
  return mutations.every((mutation) => {
    const target = mutation.target as HTMLElement;
    if (target?.closest?.(`[${OVERLAY_ATTR}]`)) {
      return true;
    }

    const touched = [...mutation.addedNodes, ...mutation.removedNodes];
    return (
      touched.length > 0 &&
      touched.every(
        (node) =>
          node instanceof HTMLElement &&
          (node.hasAttribute(OVERLAY_ATTR) || node.closest(`[${OVERLAY_ATTR}]`) !== null),
      )
    );
  });
}

function monitorPageChanges() {
  observer = new MutationObserver((mutations) => {
    if (injecting || isSelfInflicted(mutations)) {
      return;
    }

    if (location.href !== currentUrl) {
      currentUrl = location.href;
      scheduleSync(true);
      return;
    }

    scheduleSync(false);
  });

  // characterData is deliberately omitted: the ERP rewrites text nodes
  // constantly and watching them kept the whole page in a rescan loop.
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener("popstate", () => scheduleSync(true));
  window.addEventListener("hashchange", () => scheduleSync(true));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "SET_OVERLAY_ENABLED") {
    overlayEnabled = Boolean(message.payload);
    if (!overlayEnabled) {
      clearOverlay();
    } else {
      injecting = true;
      try {
        injectOverlayBadges();
      } finally {
        injecting = false;
      }
    }
    sendResponse({ success: true });
    return false;
  }

  if (message?.type !== "SCRAPE_ATTENDANCE") {
    return false;
  }

  syncPortalData(true)
    .then((result) => sendResponse({ success: true, ...result }))
    .catch((error) =>
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  return true;
});

async function init() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "GET_PREFERENCES" });
    if (response?.success) {
      overlayEnabled = response.preferences?.showPageOverlay ?? true;
    }
  } catch {
    // Preferences are best-effort; default to showing the overlay.
  }

  syncPortalData(true).catch((error) => {
    console.warn("[NIET Planner] Initial sync failed:", error);
  });
  monitorPageChanges();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => void init(), { once: true });
} else {
  void init();
}
