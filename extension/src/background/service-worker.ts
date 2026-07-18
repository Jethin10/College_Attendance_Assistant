/**
 * Background service worker - routes messages and keeps the action badge updated.
 */

import {
  getDashboardData,
  readStore,
  replaceSubjects,
  replaceTimetable,
  saveErpSnapshot,
  savePortalTimetable,
  saveTimetableSyncError,
  saveSimulation,
} from "@/lib/storage";
import type { ERPImportSnapshot, SimulationRequest } from "@/lib/types";
import { buildSnapshot } from "@/lib/erp-parser";

type FallbackPortalData = {
  subjects: Array<{
    code: string;
    name: string;
    attendedClasses: number;
    heldClasses: number;
    attendancePercent?: number;
  }>;
  timetable: Array<{
    id: string;
    subjectId: string;
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    room?: string;
  }>;
  calendarSessions: Array<{
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
    source: "portal";
  }>;
  rangeStart: string;
  rangeEnd: string;
  message?: string;
  student?: ERPImportSnapshot["student"];
};

async function updateBadge() {
  try {
    const dashboard = await getDashboardData();
    const percent = dashboard.overall.attendancePercent;
    const status = dashboard.overall.status;

    await chrome.action.setBadgeText({ text: `${percent}%` });

    const colors: Record<string, string> = {
      safe: "#059669",
      warning: "#d97706",
      critical: "#dc2626",
    };
    await chrome.action.setBadgeBackgroundColor({ color: colors[status] ?? "#6366f1" });
  } catch (error) {
    console.warn("[NIET Planner SW] Failed to update badge:", error);
    await chrome.action.setBadgeText({ text: "" });
  }
}

async function fallbackScrapeWithScripting(tabId: number) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: async () => {
      const TIMETABLE_RANGE_DAYS = 45;

      const normalizeWhitespace = (value: string) =>
        value.replace(/\s+/g, " ").trim();

      const normalizeHeader = (value: string) =>
        normalizeWhitespace(value)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, " ")
          .trim();

      const asCount = (value: string) => {
        const normalized = value.replace(/,/g, "").trim();
        if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
          return null;
        }
        const numeric = Number(normalized);
        return Number.isFinite(numeric) ? numeric : null;
      };

      const parseAttendanceCount = (value: string) => {
        const match = value.match(/(\d+)\s*\/\s*(\d+)/);
        if (!match) {
          return null;
        }
        return {
          attendedClasses: Number(match[1]),
          heldClasses: Number(match[2]),
        };
      };

      const getRows = (table: ParentNode) =>
        Array.from(table.querySelectorAll("tr"));

      const findHeaderIndex = (headers: string[], aliases: string[]) =>
        headers.findIndex((header) => aliases.includes(header));

      const getAttendanceColumns = (table: ParentNode) => {
        for (const row of getRows(table)) {
          const headerCells = Array.from(row.querySelectorAll("th"));
          if (headerCells.length < 3) {
            continue;
          }
          const headers = headerCells.map((cell) => normalizeHeader(cell.textContent ?? ""));
          const columns = {
            code: findHeaderIndex(headers, ["course code", "subject code", "paper code", "code"]),
            name: findHeaderIndex(headers, ["course name", "subject name", "paper name", "subject", "course"]),
            attended: findHeaderIndex(headers, ["present count", "present", "attended count", "attended classes", "classes attended"]),
            held: findHeaderIndex(headers, ["total count", "classes held", "held classes", "total classes"]),
            percentage: findHeaderIndex(headers, ["percentage", "attendance percentage", "attendance percent", "percent"]),
          };
          if (columns.code >= 0 && columns.name >= 0 && columns.attended >= 0 && columns.held >= 0) {
            return columns;
          }
        }
        return null;
      };

      const scoreAttendanceTable = (table: HTMLTableElement) => {
        const rows = getRows(table);
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

        score += rows.reduce((sum, row) => {
          const rowText = normalizeWhitespace(row.textContent ?? "");
          if (!/\d+\s*\/\s*\d+/.test(rowText)) {
            return sum;
          }
          return sum + (/[A-Z]{2,}\d+[A-Z0-9]*/i.test(rowText) ? 3 : 1);
        }, 0);

        return score;
      };

      const tables = Array.from(document.querySelectorAll("table"));
      const attendanceTable = tables
        .map((table) => ({ table, score: scoreAttendanceTable(table) }))
        .sort((a, b) => b.score - a.score)[0]?.table ?? null;

      const attendanceColumns = attendanceTable
        ? getAttendanceColumns(attendanceTable)
        : null;

      const subjects = attendanceTable
        ? getRows(attendanceTable)
            .flatMap((row) => {
              const cells = Array.from(row.querySelectorAll("td")).map((cell) =>
                normalizeWhitespace(cell.textContent ?? ""),
              );
              if (cells.length < 3) {
                return [];
              }

              if (attendanceColumns) {
                const code = cells[attendanceColumns.code] ?? "";
                const courseName = cells[attendanceColumns.name] ?? "";
                const attendedClasses = asCount(cells[attendanceColumns.attended] ?? "");
                const heldClasses = asCount(cells[attendanceColumns.held] ?? "");
                if (
                  code &&
                  courseName &&
                  /[A-Za-z]/.test(code) &&
                  /[A-Za-z]/.test(courseName) &&
                  attendedClasses !== null &&
                  heldClasses !== null
                ) {
                  const percentage = attendanceColumns.percentage >= 0
                    ? cells[attendanceColumns.percentage] ?? ""
                    : "";
                  return [{
                    code,
                    name: courseName,
                    attendedClasses,
                    heldClasses,
                    attendancePercent: percentage ? Number(percentage.replace(/[^\d.]/g, "")) : undefined,
                  }];
                }
                return [];
              }

              const [code, courseName, attendanceCount, percentage = ""] = cells;
              const counts = parseAttendanceCount(attendanceCount);
              if (code && courseName && counts) {
                return [{
                  code,
                  name: courseName,
                  attendedClasses: counts.attendedClasses,
                  heldClasses: counts.heldClasses,
                  attendancePercent: percentage ? Number(percentage.replace(/[^\d.]/g, "")) : undefined,
                }];
              }

              return [];
            })
        : [];

      const semesterSelect = Array.from(document.querySelectorAll("select")).find(
        (select) => Array.from(select.options).some(
          (option) => /^SEM(?:ESTER)?[-\s]/i.test(option.text.trim()),
        ),
      );
      const studentName = normalizeWhitespace(
        document.querySelector<HTMLAnchorElement>('a[href*="stu_studentProfile"]')?.textContent ?? "",
      );
      const student = {
        studentName: studentName || undefined,
        semesterLabel: semesterSelect?.selectedOptions[0]?.text.trim() || undefined,
      };

      const toDateKey = (date: Date) => {
        const year = date.getFullYear();
        const month = `${date.getMonth() + 1}`.padStart(2, "0");
        const day = `${date.getDate()}`.padStart(2, "0");
        return `${year}-${month}-${day}`;
      };

      const formatPortalDate = (date: Date) => {
        const month = date.toLocaleString("en-US", { month: "short" });
        return `${month} ${`${date.getDate()}`.padStart(2, "0")},${date.getFullYear()}`;
      };

      const parsePortalDate = (dateText?: string) => {
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
        return new Date(Number(match[3]), monthIndex, Number(match[2]));
      };

      const normalizeTime = (raw?: string) => {
        const value = raw?.trim();
        if (!value) {
          return null;
        }
        const match = value.match(/^(\d{1,2}):(\d{2})/);
        if (!match) {
          return null;
        }
        return `${match[1].padStart(2, "0")}:${match[2]}`;
      };

      const deriveSubjectCode = (row: any) => {
        const shortName = row.subShortName?.trim();
        if (shortName) {
          return shortName;
        }
        const suffix = row.subjectId?.split("-").at(-1)?.trim();
        if (suffix) {
          return suffix;
        }
        const match = (row.subjectName ?? row.subName ?? "").match(/[A-Z]{2,}\d+[A-Z0-9]*/i);
        return match?.[0] ?? "unknown";
      };

      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + TIMETABLE_RANGE_DAYS);

      const todayPromise = fetch(
        `/stu_getTodaysScheduleForStudentLoggedIn.json?date=${encodeURIComponent(formatPortalDate(start))}`,
        { credentials: "include", headers: { Accept: "application/json, text/plain, */*" } },
      ).then((response) => response.ok ? response.json() : []);

      const rangePromise = fetch(
        `/getBetweenDatesTimetableForStudent.json?startDate=${encodeURIComponent(formatPortalDate(start))}&endDate=${encodeURIComponent(formatPortalDate(end))}`,
        { credentials: "include", headers: { Accept: "application/json, text/plain, */*" } },
      ).then((response) => response.ok ? response.json() : []);

      const [todayPayload, rangePayload] = await Promise.all([todayPromise, rangePromise]);
      const rows = Array.isArray(rangePayload) ? rangePayload : [];

      const calendarSessions = rows.flatMap((row: any, index: number) => {
        const parsedDate = parsePortalDate(row.lectureDate);
        const startTime = normalizeTime(row.startTimeHM ?? row.lStartTime);
        const endTime = normalizeTime(row.endTimeHM ?? row.lEndTime);
        const subjectCode = deriveSubjectCode(row);
        if (!parsedDate || !startTime || !endTime || !subjectCode) {
          return [];
        }
        const dateKey = toDateKey(parsedDate);
        const subjectId = subjectCode.toLowerCase();
        return [{
          id: `${subjectId}:${dateKey}:${startTime}:${index}`,
          subjectId,
          subjectCode,
          subjectName: row.subjectName?.trim() || row.subName?.trim() || subjectCode,
          date: dateKey,
          dayOfWeek: parsedDate.getDay(),
          startTime,
          endTime,
          room: row.roomNo?.trim() || row.roomName?.trim() || undefined,
          faculty: row.employeeName1?.trim() || undefined,
          source: "portal" as const,
        }];
      }).sort((a: any, b: any) =>
        a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
      );

      const timetableMap = new Map<string, any>();
      calendarSessions.forEach((session: any) => {
        const key = [
          session.subjectId,
          session.dayOfWeek,
          session.startTime,
          session.endTime,
          session.room ?? "",
        ].join("|");
        if (!timetableMap.has(key)) {
          timetableMap.set(key, {
            id: `slot:${session.subjectId}:${session.dayOfWeek}:${session.startTime}:${session.endTime}`,
            subjectId: session.subjectId,
            dayOfWeek: session.dayOfWeek,
            startTime: session.startTime,
            endTime: session.endTime,
            room: session.room,
          });
        }
      });

      const holidayMessage =
        Array.isArray(todayPayload) && todayPayload[0]?.holiday
          ? `Today is marked as ${todayPayload[0].holiday}.`
          : undefined;

      return {
        subjects,
        timetable: [...timetableMap.values()],
        calendarSessions,
        rangeStart: toDateKey(start),
        rangeEnd: toDateKey(end),
        message:
          calendarSessions.length > 0
            ? holidayMessage
              ? `Imported ${calendarSessions.length} upcoming classes. ${holidayMessage}`
              : `Imported ${calendarSessions.length} upcoming classes from the portal.`
            : holidayMessage ?? "The portal returned no upcoming classes in the selected range.",
        student,
      };
    },
  });

  return injection?.result as FallbackPortalData | undefined;
}

async function scrapeActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

  if (!tab?.id) {
    throw new Error("Open the NIET ERP attendance page, then try again.");
  }

  if (!tab.url?.includes("nietcloud.niet.co.in")) {
    throw new Error("The active tab is not a NIET ERP page.");
  }

  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "SCRAPE_ATTENDANCE" });
    if (!response?.success) {
      throw new Error(response?.error ?? "Could not scrape attendance from the active tab.");
    }
    return getDashboardData();
  } catch (_error) {
    const fallback = await fallbackScrapeWithScripting(tab.id);
    if (!fallback) {
      throw new Error("Could not scrape attendance from the active tab.");
    }

    if (fallback.subjects.length > 0) {
      const snapshot = buildSnapshot(
        fallback.subjects,
        `Fallback-scraped from ${tab.url}`,
        [],
        fallback.student,
      );
      await saveErpSnapshot(snapshot);
    }

    if (fallback.calendarSessions.length > 0 || fallback.timetable.length > 0) {
      await savePortalTimetable({
        timetable: fallback.timetable,
        calendarSessions: fallback.calendarSessions,
        rangeStart: fallback.rangeStart,
        rangeEnd: fallback.rangeEnd,
        message: fallback.message,
      });
    }
  }

  return getDashboardData();
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case "ATTENDANCE_SCRAPED": {
      const snapshot = payload as ERPImportSnapshot;
      saveErpSnapshot(snapshot)
        .then((dashboard) => {
          updateBadge();
          sendResponse({ success: true, dashboard });
        })
        .catch((error) => {
          sendResponse({ success: false, error: String(error) });
        });
      return true;
    }

    case "PORTAL_TIMETABLE_SCRAPED": {
      savePortalTimetable(payload)
        .then((dashboard) => {
          updateBadge();
          sendResponse({ success: true, dashboard });
        })
        .catch((error) => {
          sendResponse({ success: false, error: String(error) });
        });
      return true;
    }

    case "PORTAL_TIMETABLE_ERROR": {
      saveTimetableSyncError(String(payload ?? "Portal timetable sync failed."))
        .then((dashboard) => {
          updateBadge();
          sendResponse({ success: true, dashboard });
        })
        .catch((error) => {
          sendResponse({ success: false, error: String(error) });
        });
      return true;
    }

    case "GET_DASHBOARD": {
      getDashboardData()
        .then((dashboard) => sendResponse({ success: true, dashboard }))
        .catch((error) => sendResponse({ success: false, error: String(error) }));
      return true;
    }

    case "SCRAPE_ACTIVE_TAB": {
      scrapeActiveTab()
        .then((dashboard) => {
          updateBadge();
          sendResponse({ success: true, dashboard });
        })
        .catch((error) => sendResponse({ success: false, error: String(error) }));
      return true;
    }

    case "RUN_SIMULATION": {
      const request = payload as SimulationRequest;
      saveSimulation(request)
        .then((result) => {
          updateBadge();
          sendResponse({ success: true, result });
        })
        .catch((error) => sendResponse({ success: false, error: String(error) }));
      return true;
    }

    case "SAVE_SUBJECTS": {
      replaceSubjects(payload)
        .then((dashboard) => {
          updateBadge();
          sendResponse({ success: true, dashboard });
        })
        .catch((error) => sendResponse({ success: false, error: String(error) }));
      return true;
    }

    case "SAVE_TIMETABLE": {
      replaceTimetable(payload)
        .then((dashboard) => {
          updateBadge();
          sendResponse({ success: true, dashboard });
        })
        .catch((error) => sendResponse({ success: false, error: String(error) }));
      return true;
    }

    case "IMPORT_PASTED": {
      const pastedSnapshot = payload as ERPImportSnapshot;
      saveErpSnapshot(pastedSnapshot)
        .then((dashboard) => {
          updateBadge();
          sendResponse({ success: true, dashboard });
        })
        .catch((error) => sendResponse({ success: false, error: String(error) }));
      return true;
    }

    case "GET_STORE": {
      readStore()
        .then((store) => sendResponse({ success: true, store }))
        .catch((error) => sendResponse({ success: false, error: String(error) }));
      return true;
    }

    default:
      return false;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  updateBadge();
});

chrome.runtime.onStartup.addListener(() => {
  updateBadge();
});
