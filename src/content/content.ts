/**
 * Content Script - runs on nietcloud.niet.co.in
 *
 * Detects the attendance table, keeps watching for SPA-style page updates,
 * injects overlay badges, syncs parsed attendance back to the extension,
 * and auto-imports dated timetable sessions from the NIET portal.
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

type ERPImportSnapshot = {
  id: string;
  importedAt: string;
  source: string;
  parsedSubjects: ParsedSubject[];
  warnings: string[];
  rawSummary: string;
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

let lastSignature = "";
let lastTimetableSignature = "";
let lastTimetableFetchAt = 0;
let rescanTimer: number | null = null;
let currentUrl = location.href;

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
  const limit = Math.floor(attended / thresholdRatio - held);
  return Math.max(0, limit);
}

function computeRecoveryClassesNeeded(
  attended: number,
  held: number,
  thresholdPercent: number,
) {
  const thresholdRatio = thresholdPercent / 100;

  if (held <= 0 || attended / held >= thresholdRatio) {
    return 0;
  }

  let recovery = 0;
  while ((attended + recovery) / (held + recovery) < thresholdRatio) {
    recovery += 1;
  }

  return recovery;
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

function getTableRows(table: ParentNode): HTMLTableRowElement[] {
  return Array.from(table.querySelectorAll("tr"));
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
  const tables = Array.from(root.querySelectorAll("table"));
  let bestTable: HTMLTableElement | null = null;
  let bestScore = 0;

  for (const table of tables) {
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

function parseSubjectsFromTable(table: ParentNode): ParsedSubject[] {
  const subjects: ParsedSubject[] = [];

  getTableRows(table).forEach((row) => {
    const cells = Array.from(row.querySelectorAll("td")).map((cell) =>
      normalizeWhitespace(cell.textContent ?? ""),
    );

    if (cells.length < 3) {
      return;
    }

    const [code, courseName, attendanceCount, percentage = ""] = cells;
    const counts = parseAttendanceCount(attendanceCount);

    if (code && courseName && counts) {
      subjects.push({
        code,
        name: courseName,
        attendedClasses: counts.attendedClasses,
        heldClasses: counts.heldClasses,
        attendancePercent: percentage ? asNumber(percentage) : undefined,
      });
      return;
    }

    const attendanceCell = cells.find((cell) => /\d+\s*\/\s*\d+/.test(cell));
    const codeCell = cells.find((cell) => /^[A-Z]{2,}\d+[A-Z0-9]*$/i.test(cell));

    if (!attendanceCell || !codeCell) {
      return;
    }

    const flexCounts = parseAttendanceCount(attendanceCell);
    if (!flexCounts) {
      return;
    }

    const codeIndex = cells.indexOf(codeCell);
    const percentageCell = cells.find((cell) => /^\d+(\.\d+)?%?$/.test(cell));
    const nameCell =
      cells[codeIndex + 1] &&
      !/\d+\s*\/\s*\d+/.test(cells[codeIndex + 1]) &&
      cells[codeIndex + 1] !== percentageCell
        ? cells[codeIndex + 1]
        : cells.find((cell) => /[A-Za-z]{3,}/.test(cell) && cell !== codeCell) ?? codeCell;

    subjects.push({
      code: codeCell,
      name: nameCell,
      attendedClasses: flexCounts.attendedClasses,
      heldClasses: flexCounts.heldClasses,
      attendancePercent: percentageCell ? asNumber(percentageCell) : undefined,
    });
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
): ERPImportSnapshot {
  return {
    id: crypto.randomUUID(),
    importedAt: new Date().toISOString(),
    source: "nietcloud.niet.co.in",
    parsedSubjects,
    warnings,
    rawSummary,
  };
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

  const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const monthIndex = monthNames.indexOf(match[1].toLowerCase());
  if (monthIndex < 0) {
    return null;
  }

  const day = Number(match[2]);
  const year = Number(match[3]);
  return new Date(year, monthIndex, day);
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
  const subjects = scrapeAttendanceFromDOM();
  return JSON.stringify(
    subjects.map((subject) => [
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

  const subjects = scrapeAttendanceFromDOM();
  if (subjects.length === 0) {
    return;
  }

  const totalAttended = subjects.reduce((sum, subject) => sum + subject.attendedClasses, 0);
  const totalHeld = subjects.reduce((sum, subject) => sum + subject.heldClasses, 0);
  const overallPercent = computeAttendancePercent(totalAttended, totalHeld);
  const overallBunkable = computeBunkableClasses(totalAttended, totalHeld, THRESHOLD);
  const overallStatus = getSubjectStatus(overallPercent, THRESHOLD);
  const attendanceTable = findAttendanceTableElement();

  const summaryBar = document.createElement("div");
  summaryBar.setAttribute(OVERLAY_ATTR, "summary");
  summaryBar.className = "niet-planner-summary";
  summaryBar.innerHTML = `
    <div class="niet-planner-summary__inner">
      <div class="niet-planner-summary__brand">
        <span class="niet-planner-summary__logo">NIET Attendance</span>
        <span class="niet-planner-summary__caption">Live help for this table</span>
      </div>
      <span class="niet-planner-summary__stat">
        Overall
        <strong class="niet-planner-status--${overallStatus}">${overallPercent}%</strong>
      </span>
      <span class="niet-planner-summary__stat">
        Bunkable
        <strong>${overallBunkable} classes</strong>
      </span>
      <span class="niet-planner-summary__stat">
        Status
        <strong class="niet-planner-status--${overallStatus}">${overallStatus.toUpperCase()}</strong>
      </span>
    </div>
  `;
  attendanceTable?.parentElement?.insertBefore(summaryBar, attendanceTable);

  const rows = attendanceTable?.querySelectorAll("tr") ?? [];
  let subjectIndex = 0;

  rows.forEach((row) => {
    const cells = row.querySelectorAll("td");
    if (cells.length < 4) {
      return;
    }

    const cellTexts = Array.from(cells).map((cell) =>
      (cell.textContent ?? "").replace(/\s+/g, " ").trim(),
    );
    const hasAttendance = cellTexts.some((text) => /\d+\s*\/\s*\d+/.test(text));
    const hasCode = cellTexts.some((text) => /^[A-Z]{2,}\d+[A-Z0-9]*$/i.test(text));

    if (!hasAttendance || !hasCode || subjectIndex >= subjects.length) {
      return;
    }

    const subject = subjects[subjectIndex];
    subjectIndex += 1;

    const percent = computeAttendancePercent(
      subject.attendedClasses,
      subject.heldClasses,
    );
    const bunkable = computeBunkableClasses(
      subject.attendedClasses,
      subject.heldClasses,
      THRESHOLD,
    );
    const recovery = computeRecoveryClassesNeeded(
      subject.attendedClasses,
      subject.heldClasses,
      THRESHOLD,
    );
    const status = getSubjectStatus(percent, THRESHOLD);

    const badge = document.createElement("div");
    badge.setAttribute(OVERLAY_ATTR, "badge");
    badge.className = `niet-planner-badge niet-planner-badge--${status}`;

    if (status === "critical") {
      badge.textContent = `Critical: need ${recovery} to recover`;
    } else if (bunkable === 0) {
      badge.textContent = "Watch: no bunks left";
    } else {
      badge.textContent = `${status === "safe" ? "Safe" : "Watch"}: ${bunkable} bunkable`;
    }

    const lastCell = cells[cells.length - 1];
    lastCell.style.position = "relative";
    lastCell.appendChild(badge);
  });
}

async function sendAttendanceToServiceWorker() {
  const subjects = scrapeAttendanceFromDOM();
  if (subjects.length === 0) {
    return;
  }

  const snapshot = buildSnapshot(
    subjects,
    `Auto-scraped from ${window.location.href}`,
    [],
  );

  await chrome.runtime.sendMessage({
    type: "ATTENDANCE_SCRAPED",
    payload: snapshot,
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
    const subjectId = code.toLowerCase();

    if (!dateKey || !startTime || !endTime || !code) {
      return;
    }

    const dayOfWeek = parsePortalDate(row.lectureDate)?.getDay();
    if (dayOfWeek === undefined) {
      return;
    }

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

  return sessions.sort((a, b) => {
    const byDate = a.date.localeCompare(b.date);
    if (byDate !== 0) {
      return byDate;
    }
    return a.startTime.localeCompare(b.startTime);
  });
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

  return [...unique.values()].sort((a, b) => {
    if (a.dayOfWeek !== b.dayOfWeek) {
      return a.dayOfWeek - b.dayOfWeek;
    }
    return a.startTime.localeCompare(b.startTime);
  });
}

async function fetchPortalJson(path: string) {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      Accept: "application/json, text/plain, */*",
      "X-Requested-With": "XMLHttpRequest",
    },
  });

  if (!response.ok) {
    throw new Error(`Portal request failed with ${response.status}`);
  }

  return response.json();
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
    ).catch(() => []),
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
    Array.isArray(todayPayload) && todayPayload[0]?.holiday
      ? `Today is marked as ${todayPayload[0].holiday}.`
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
            ? `Imported ${calendarSessions.length} upcoming classes. ${holidayMessage}`
            : `Imported ${calendarSessions.length} upcoming classes from the portal.`
          : holidayMessage ?? "The portal returned no upcoming classes in the selected range.",
    },
  });

  return { imported: true, count: calendarSessions.length };
}

async function syncPortalData(force = false) {
  const timetableResult = await fetchPortalTimetable(force).catch((error) => {
    console.warn("[NIET Planner] Timetable sync failed:", error);
    chrome.runtime.sendMessage({
      type: "PORTAL_TIMETABLE_ERROR",
      payload: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    return { imported: false, count: 0, error: String(error) };
  });

  if (!detectAttendanceTable()) {
    clearOverlay();
    lastSignature = "";
    return { found: false, imported: false, timetableImported: timetableResult.imported };
  }

  const signature = subjectSignature();
  if (!force && signature === lastSignature) {
    return { found: true, imported: false, timetableImported: timetableResult.imported };
  }

  lastSignature = signature;
  injectOverlayBadges();
  await sendAttendanceToServiceWorker();
  return { found: true, imported: true, timetableImported: timetableResult.imported };
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

function monitorPageChanges() {
  const observer = new MutationObserver(() => {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      scheduleSync(true);
      return;
    }

    scheduleSync(false);
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  window.addEventListener("popstate", () => scheduleSync(true));
  window.addEventListener("hashchange", () => scheduleSync(true));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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

function init() {
  syncPortalData(true).catch((error) => {
    console.warn("[NIET Planner] Initial sync failed:", error);
  });
  monitorPageChanges();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init, { once: true });
} else {
  init();
}
