/**
 * Popup App - main controller for the extension popup.
 *
 * Fetches dashboard data, renders the UI, triggers live refresh from the
 * active NIET ERP tab, and handles simulation plus pasted-data import.
 */

import type { DashboardData, DashboardSubject, SimulationResult } from "@/lib/types";
import { buildSnapshot, parseAttendanceHtml, parseAttendanceText } from "@/lib/erp-parser";

function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function sendMessage(type: string, payload?: unknown): Promise<any> {
  return chrome.runtime.sendMessage({ type, payload });
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 42;

function localDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateLabel(dateText: string) {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(year, (month ?? 1) - 1, day ?? 1);
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    weekday: "short",
  });
}

function setRingPercent(percent: number, status: string) {
  const ring = $("ring-fill") as unknown as SVGCircleElement;
  const offset = RING_CIRCUMFERENCE - (percent / 100) * RING_CIRCUMFERENCE;
  ring.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
  ring.style.strokeDashoffset = `${offset}`;

  ring.classList.remove("progress-ring__fill--safe", "progress-ring__fill--warning", "progress-ring__fill--critical");
  if (status === "safe") {
    ring.classList.add("progress-ring__fill--safe");
  } else if (status === "warning") {
    ring.classList.add("progress-ring__fill--warning");
  } else if (status === "critical") {
    ring.classList.add("progress-ring__fill--critical");
  }
}

function animateValue(element: HTMLElement, target: number, prefix = "", suffix = "") {
  const duration = 600;
  const start = 0;
  const startTime = performance.now();
  
  function update(currentTime: number) {
    const elapsed = currentTime - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const easeOut = 1 - Math.pow(1 - progress, 3);
    const current = Math.round(start + (target - start) * easeOut);
    element.textContent = prefix + current + suffix;
    
    if (progress < 1) {
      requestAnimationFrame(update);
    }
  }
  
  requestAnimationFrame(update);
}

function buildHeadline(dashboard: DashboardData): string {
  if (!dashboard.subjects.length) {
    return "Open NIET ERP or import data to get started.";
  }
  if (!dashboard.calendarSessions.length) {
    if (dashboard.timetableSync.status === "error") {
      return dashboard.timetableSync.message ?? "Attendance imported. Timetable sync pending.";
    }
    return "Open NIET portal once to sync your class schedule.";
  }
  if (dashboard.overall.safeLeaveDays > 0) {
    return `You can take ${dashboard.overall.safeLeaveDays} full day${dashboard.overall.safeLeaveDays === 1 ? "" : "s"} off and stay safe.`;
  }
  if (dashboard.overall.bunkableClasses > 0) {
    return `You can miss ${dashboard.overall.bunkableClasses} more class${dashboard.overall.bunkableClasses === 1 ? "" : "es"}.`;
  }
  return "At the edge. Any absence drops you below 75%.";
}

function renderDashboard(dashboard: DashboardData) {
  const percentEl = $("overall-percent");
  animateValue(percentEl, dashboard.overall.attendancePercent);
  setRingPercent(dashboard.overall.attendancePercent, dashboard.overall.status);

  $("headline").textContent = buildHeadline(dashboard);
  const syncNote = $("sync-note");
  if (dashboard.calendarSessions.length > 0) {
    syncNote.textContent = dashboard.timetableSync.rangeEnd 
      ? `Synced until ${dashboard.timetableSync.rangeEnd}` 
      : "Schedule synced";
  } else {
    syncNote.textContent = dashboard.timetableSync.message ?? "Open portal to sync";
  }

  const statusChip = $("overall-status");
  statusChip.textContent = dashboard.overall.status;
  statusChip.className = `status-pill status-pill--${dashboard.overall.status}`;

  const bunkableEl = $("stat-bunkable") as HTMLElement;
  animateValue(bunkableEl, dashboard.overall.bunkableClasses);
  
  const leaveDaysEl = $("stat-leave-days") as HTMLElement;
  animateValue(leaveDaysEl, dashboard.overall.safeLeaveDays);

  const nextMissEl = $("stat-next-miss") as HTMLElement;
  nextMissEl.innerHTML = `-${dashboard.overall.nextMissDropPercent}<span class="stat-card__unit">%</span>`;
  
  const recoveryEl = $("stat-recovery") as HTMLElement;
  animateValue(recoveryEl, dashboard.overall.recoveryClassesNeeded);

  renderSubjects(dashboard.subjects);
}

function renderSubjects(subjects: DashboardSubject[]) {
  const container = $("subjects-list");

  if (subjects.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg class="empty-state__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4"></path>
        </svg>
        <p class="empty-state__title">No data yet</p>
        <p class="empty-state__desc">Open the NIET portal or paste attendance data in Settings to get started.</p>
      </div>
    `;
    return;
  }

  const ordered = [...subjects].sort((a, b) => {
    const priority: Record<string, number> = { critical: 0, warning: 1, safe: 2 };
    return (priority[a.status] ?? 3) - (priority[b.status] ?? 3);
  });

  container.innerHTML = ordered
    .map(
      (subject) => `
        <div class="subject-card subject-card--${subject.status}">
          <div class="subject-card__top">
            <div class="subject-card__info">
              <div class="subject-card__name" title="${subject.name}">${subject.name}</div>
              <div class="subject-card__code">${subject.code}</div>
            </div>
            <span class="subject-card__percent subject-card__percent--${subject.status}">${subject.attendancePercent}%</span>
          </div>
          <div class="subject-card__meta">
            <span class="subject-card__bunks subject-card__bunks--${subject.status}">${subject.bunkableClasses} bunks left</span>
            <span class="subject-card__attendance">${subject.attendedClasses}/${subject.heldClasses} classes</span>
          </div>
          <div class="subject-card__bar">
            <div class="subject-card__bar-fill subject-card__bar-fill--${subject.status}" style="width: ${Math.min(subject.attendancePercent, 100)}%"></div>
          </div>
        </div>
      `,
    )
    .join("");
}

function renderSimResult(result: SimulationResult) {
  const el = $("sim-result");
  el.classList.add("visible");

  const title = $("sim-result-title");
  const statusChip = $("sim-result-status");
  const body = $("sim-result-body");
  const statsEl = $("sim-result-stats");
  const impactSummary = $("sim-impact-summary");
  const impactList = $("sim-impact-list");
  const classListWrap = $("sim-class-list-wrap");
  const classList = $("sim-class-list");
  const overall = result.overall;

  title.textContent = `${overall.beforePercent}% → ${overall.afterPercent}%`;
  statusChip.textContent = overall.status;
  statusChip.className = `status-pill status-pill--${overall.status}`;

  if (overall.afterPercent < 75) {
    body.textContent = `Not safe. Missing ${overall.classesMissed} class${overall.classesMissed === 1 ? "" : "es"} drops you to ${overall.afterPercent}%. You'll need ${overall.recoveryClassesNeeded} more classes to recover.`;
  } else {
    body.textContent = `Safe. After missing ${overall.classesMissed} class${overall.classesMissed === 1 ? "" : "es"}, you'll be at ${overall.afterPercent}%. You still have ${overall.safeLeaveDaysRemaining} full leave day${overall.safeLeaveDaysRemaining === 1 ? "" : "s"} left.`;
  }

  statsEl.innerHTML = `
    <div class="sim-stat">
      <span class="sim-stat__label">Classes Missed</span>
      <span class="sim-stat__value">${overall.classesMissed}</span>
    </div>
    <div class="sim-stat">
      <span class="sim-stat__label">Drop</span>
      <span class="sim-stat__value">-${overall.deltaPercent}%</span>
    </div>
    <div class="sim-stat">
      <span class="sim-stat__label">Recovery Needed</span>
      <span class="sim-stat__value">${overall.recoveryClassesNeeded}</span>
    </div>
    <div class="sim-stat">
      <span class="sim-stat__label">Leave Days Left</span>
      <span class="sim-stat__value">${overall.safeLeaveDaysRemaining}</span>
    </div>
  `;

  if (result.projections.length > 0) {
    impactSummary.classList.remove("hidden");
    impactList.innerHTML = result.projections
      .sort((a, b) => b.classesMissed - a.classesMissed || a.subjectName.localeCompare(b.subjectName))
      .map(
        (projection) => `
          <div class="sim-impact-card">
            <div class="sim-impact-card__info">
              <strong>${projection.subjectName}</strong>
              <span>Missed ${projection.classesMissed} | ${projection.beforePercent}% → ${projection.afterPercent}%</span>
            </div>
            <span class="status-pill status-pill--${projection.status}">${projection.afterPercent}%</span>
          </div>
        `,
      )
      .join("");
  } else {
    impactSummary.classList.add("hidden");
    impactList.innerHTML = "";
  }

  if (result.impactedSlots.length > 0) {
    classListWrap.classList.remove("hidden");
    classList.innerHTML = result.impactedSlots
      .slice()
      .sort((a, b) => {
        const byDate = a.date.localeCompare(b.date);
        if (byDate !== 0) return byDate;
        return a.startTime.localeCompare(b.startTime);
      })
      .slice(0, 10)
      .map(
        (slot) => `
          <div class="sim-class-card">
            <div>
              <div class="sim-class-card__title">${slot.subjectName}</div>
              <div class="sim-class-card__meta">${formatDateLabel(slot.date)} · ${slot.startTime} - ${slot.endTime}</div>
            </div>
          </div>
        `,
      )
      .join("");
    
    if (result.impactedSlots.length > 10) {
      classList.innerHTML += `<div class="sim-class-card" style="text-align:center;opacity:0.6;">+ ${result.impactedSlots.length - 10} more classes</div>`;
    }
  } else {
    classListWrap.classList.add("hidden");
    classList.innerHTML = "";
  }
}

function initTabs() {
  const tabs = document.querySelectorAll(".tab");
  const panels = document.querySelectorAll(".tab-panel");

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const targetId = (tab as HTMLElement).dataset.tab;
      tabs.forEach((item) => item.classList.remove("active"));
      panels.forEach((item) => item.classList.remove("active"));
      tab.classList.add("active");
      $(`tab-${targetId}`).classList.add("active");
    });
  });
}

function initSimulator() {
  const modeSelect = $("sim-mode") as HTMLSelectElement;
  const leaveFields = $("sim-leave-fields");
  const rangeFields = $("sim-range-fields");
  const futureFields = $("sim-future-fields");

  const today = localDateInputValue();
  ($("sim-from-date") as HTMLInputElement).value = today;
  ($("sim-range-from") as HTMLInputElement).value = today;
  const nextWeek = new Date();
  nextWeek.setDate(nextWeek.getDate() + 7);
  ($("sim-range-to") as HTMLInputElement).value = localDateInputValue(nextWeek);

  modeSelect.addEventListener("change", () => {
    leaveFields.classList.toggle("hidden", modeSelect.value !== "leave-days");
    rangeFields.classList.toggle("hidden", modeSelect.value !== "date-range");
    futureFields.classList.toggle("hidden", modeSelect.value !== "future-count");
  });

  $("btn-simulate").addEventListener("click", async () => {
    const mode = modeSelect.value;
    const request: Record<string, unknown> = { mode, subjectId: "" };

    if (mode === "leave-days") {
      request.leaveDays = Number(($("sim-leave-days") as HTMLInputElement).value);
      request.fromDate = ($("sim-from-date") as HTMLInputElement).value;
    } else if (mode === "date-range") {
      request.fromDate = ($("sim-range-from") as HTMLInputElement).value;
      request.toDate = ($("sim-range-to") as HTMLInputElement).value;
    } else if (mode === "future-count") {
      request.futureClasses = Number(($("sim-future-count") as HTMLInputElement).value);
    }

    const button = $("btn-simulate") as HTMLButtonElement;
    button.textContent = "Calculating...";
    button.disabled = true;

    try {
      const response = await sendMessage("RUN_SIMULATION", request);
      if (response?.success && response.result) {
        renderSimResult(response.result);
        const dashboardResponse = await sendMessage("GET_DASHBOARD");
        if (dashboardResponse?.success) {
          renderDashboard(dashboardResponse.dashboard);
        }
      }
    } catch (error) {
      console.error("[Popup] Simulation failed:", error);
    } finally {
      button.textContent = "Calculate Impact";
      button.disabled = false;
    }
  });
}

function initPasteImport() {
  $("btn-import-paste").addEventListener("click", async () => {
    const textareaEl = $("paste-data") as HTMLTextAreaElement;
    const resultEl = $("paste-result");
    const raw = textareaEl.value.trim();

    if (!raw) {
      resultEl.textContent = "Paste some attendance data first.";
      resultEl.className = "settings-result settings-result--error";
      return;
    }

    const isHtml = raw.includes("<table") || raw.includes("</tr>");
    const parsed = isHtml ? parseAttendanceHtml(raw) : parseAttendanceText(raw);

    if (parsed.length === 0) {
      resultEl.textContent = "Couldn't parse any subjects. Try the full attendance table.";
      resultEl.className = "settings-result settings-result--error";
      return;
    }

    const snapshot = buildSnapshot(
      parsed,
      "Imported from pasted data in extension popup.",
      [],
    );

    try {
      const response = await sendMessage("IMPORT_PASTED", snapshot);
      if (response?.success) {
        resultEl.textContent = `Imported ${parsed.length} subjects successfully.`;
        resultEl.className = "settings-result settings-result--success";
        renderDashboard(response.dashboard);
        textareaEl.value = "";
      } else {
        resultEl.textContent = response?.error ?? "Import failed.";
        resultEl.className = "settings-result settings-result--error";
      }
    } catch (_error) {
      resultEl.textContent = "Failed to save data.";
      resultEl.className = "settings-result settings-result--error";
    }
  });
}

function initRefresh() {
  const refreshBtn = $("btn-refresh");
  
  refreshBtn.addEventListener("click", async () => {
    refreshBtn.classList.add("loading");
    refreshBtn.style.pointerEvents = "none";
    
    try {
      const response = await sendMessage("SCRAPE_ACTIVE_TAB");
      if (response?.success) {
        renderDashboard(response.dashboard);
        refreshBtn.classList.remove("loading");
        refreshBtn.style.pointerEvents = "";
        return;
      }

      const headline = $("headline");
      headline.textContent = response?.error ?? "Open NIET ERP tab to refresh.";
      
      const fallback = await sendMessage("GET_DASHBOARD");
      if (fallback?.success) {
        renderDashboard(fallback.dashboard);
      }
    } finally {
      refreshBtn.classList.remove("loading");
      refreshBtn.style.pointerEvents = "";
    }
  });
}

async function main() {
  initTabs();
  initSimulator();
  initPasteImport();
  initRefresh();

  try {
    const response = await sendMessage("GET_DASHBOARD");
    if (response?.success) {
      renderDashboard(response.dashboard);
    }
  } catch (error) {
    console.error("[Popup] Failed to load data:", error);
    $("headline").textContent = "Couldn't load data. Try refreshing.";
  }
}

main();