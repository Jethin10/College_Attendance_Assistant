/**
 * Popup controller.
 *
 * The headline answers one question — "can I miss a class right now?" — and it
 * answers it from the student's WEAKEST subject, because NIET requires 75% in
 * each subject individually. Aggregate percentage is shown as supporting
 * detail only, so it can be cross-checked against the ERP.
 */

import type { DashboardData, DashboardSubject, SimulationResult } from "@/lib/types";
import { buildSnapshot, parseAttendanceHtml, parseAttendanceText } from "@/lib/erp-parser";

const MAX_LISTED_CLASSES = 8;

function $(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element: ${id}`);
  }
  return element;
}

function sendMessage(type: string, payload?: unknown): Promise<any> {
  return chrome.runtime.sendMessage({ type, payload });
}

/** Builds an element with text content — never interpolates into innerHTML. */
function el(tag: string, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

function plural(count: number, singular: string, pluralForm = `${singular}es`) {
  return count === 1 ? singular : pluralForm;
}

function localDateInputValue(date = new Date()) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDateLabel(dateText: string) {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1).toLocaleDateString("en-IN", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  });
}

/* ------------------------------ Verdict ------------------------------ */

function renderVerdict(dashboard: DashboardData) {
  const verdict = $("verdict");
  const headline = $("verdict-headline");
  const detail = $("verdict-detail");
  const meta = $("verdict-meta");
  const { overall } = dashboard;

  meta.replaceChildren();

  if (dashboard.subjects.length === 0) {
    verdict.dataset.state = "empty";
    headline.textContent = "No attendance data yet";
    detail.textContent = "Open your attendance page on the NIET ERP and this fills in automatically.";
    return;
  }

  const started = dashboard.subjects.filter((subject) => subject.status !== "not-started");

  if (started.length === 0) {
    verdict.dataset.state = "empty";
    headline.textContent = "No classes held yet";
    detail.textContent = "Your subjects are listed, but none have conducted classes so far.";
    return;
  }

  verdict.dataset.state = overall.status;

  if (overall.status === "critical") {
    const need = overall.recoveryClassesNeeded;
    headline.textContent = "Below 75% — do not miss class";
    detail.textContent =
      overall.bindingSubjectName
        ? `${overall.bindingSubjectName} is at ${overall.bindingSubjectPercent}%. Attend ${need} more ${plural(need, "class")} across your weak subjects to recover.`
        : `Attend ${need} more ${plural(need, "class")} to recover.`;
  } else if (overall.safeToMissClasses === 0) {
    headline.textContent = "No margin left";
    detail.textContent = overall.bindingSubjectName
      ? `${overall.bindingSubjectName} is at ${overall.bindingSubjectPercent}%. The next missed class drops it below 75%.`
      : "The next missed class drops you below 75%.";
  } else {
    const count = overall.safeToMissClasses;
    headline.textContent = `Safe to miss ${count} ${plural(count, "class")}`;
    detail.textContent = overall.bindingSubjectName
      ? `Limited by ${overall.bindingSubjectName} at ${overall.bindingSubjectPercent}%.`
      : "Based on your weakest subject.";
  }

  const stats: Array<[string, string]> = [
    ["Overall", `${overall.attendancePercent}%`],
  ];

  if (dashboard.calendarSessions.length > 0 && overall.safeLeaveDays > 0) {
    stats.push([
      "Full days off",
      `${overall.safeLeaveDays}`,
    ]);
  }

  if (overall.status !== "critical" && overall.safeToMissClasses > 0) {
    stats.push(["Next miss costs", `${overall.nextMissDropPercent}%`]);
  }

  const belowCount = dashboard.insights.belowThresholdCount;
  if (belowCount > 0) {
    stats.push([belowCount === 1 ? "Subject below 75%" : "Subjects below 75%", `${belowCount}`]);
  }

  for (const [label, value] of stats) {
    const item = el("span");
    item.append(`${label} `, el("strong", undefined, value));
    meta.append(item);
  }
}

/* ------------------------------ Notice ------------------------------ */

function renderNotice(dashboard: DashboardData) {
  const notice = $("notice");
  const text = $("notice-text");
  const action = $("notice-action");
  const sync = dashboard.timetableSync;

  action.classList.add("hidden");
  notice.classList.remove("notice--error");

  if (sync.status === "session-expired") {
    notice.classList.remove("hidden");
    notice.classList.add("notice--error");
    text.textContent = "Your ERP session expired. Sign in again, then refresh.";
    return;
  }

  if (sync.status === "error") {
    notice.classList.remove("hidden");
    text.textContent = sync.message ?? "Could not sync your schedule from the portal.";
    return;
  }

  // Attendance without a schedule still works, but leave-day estimates need dates.
  if (dashboard.subjects.length > 0 && dashboard.calendarSessions.length === 0) {
    notice.classList.remove("hidden");
    text.textContent = "Open the ERP once to sync your timetable for leave planning.";
    return;
  }

  notice.classList.add("hidden");
}

/* ------------------------------ Subjects ------------------------------ */

function renderSubjects(dashboard: DashboardData) {
  const container = $("subjects-list");
  const subjects = dashboard.subjects;
  container.replaceChildren();

  if (subjects.length === 0) {
    const empty = el("div", "empty");
    empty.append(
      el("p", "empty__title", "Nothing to show yet"),
      el(
        "p",
        "empty__body",
        "Sign in to the NIET ERP and open your attendance page. This reads it automatically — no setup, no typing your timetable.",
      ),
    );
    container.append(empty);
    return;
  }

  const rank: Record<string, number> = { critical: 0, warning: 1, safe: 2, "not-started": 3 };
  const ordered = [...subjects].sort(
    (a, b) =>
      (rank[a.status] ?? 4) - (rank[b.status] ?? 4) ||
      a.bunkableClasses - b.bunkableClasses ||
      a.attendancePercent - b.attendancePercent,
  );

  for (const subject of ordered) {
    container.append(subjectRow(subject, dashboard.overall.bindingSubjectId));
  }
}

function subjectRow(subject: DashboardSubject, bindingId?: string) {
  const isBinding = subject.id === bindingId;
  const row = el("div", `subject subject--${subject.status}${isBinding ? " subject--binding" : ""}`);

  const top = el("div", "subject__top");
  top.append(
    el("span", "subject__name", subject.name),
    el(
      "span",
      `subject__percent subject__percent--${subject.status}`,
      subject.status === "not-started" ? "—" : `${subject.attendancePercent}%`,
    ),
  );

  const meta = el("div", "subject__meta");

  if (subject.status === "not-started") {
    meta.textContent = `${subject.code} · no classes held yet`;
  } else {
    meta.append(`${subject.code} · ${subject.attendedClasses}/${subject.heldClasses} · `);

    if (subject.status === "critical") {
      const need = subject.recoveryClassesNeeded;
      meta.append(
        el("span", "subject__flag", `attend ${need} to recover`),
      );
    } else if (subject.bunkableClasses === 0) {
      meta.append(el("span", "subject__flag", "no margin left"));
    } else {
      meta.append(`${subject.bunkableClasses} to spare`);
    }

    if (isBinding && subject.status !== "critical") {
      meta.append(" · your limit");
    }
  }

  row.append(top, meta);
  return row;
}

/* ---------------------------- Simulation ---------------------------- */

function renderSimResult(result: SimulationResult) {
  const wrap = $("sim-result");
  wrap.classList.remove("hidden");

  const overall = result.overall;
  const worst = [...result.projections].sort((a, b) => a.afterPercent - b.afterPercent)[0];

  $("sim-result-title").textContent = `${overall.beforePercent}% → ${overall.afterPercent}% overall`;

  const status = $("sim-result-status");
  status.textContent = overall.status === "critical" ? "Not safe" : overall.status === "warning" ? "Tight" : "Safe";
  status.className = `pill pill--${overall.status}`;

  const body = $("sim-result-body");
  const missed = overall.classesMissed;

  if (missed === 0) {
    body.textContent = "No classes fall in that window, so your attendance is unchanged.";
  } else if (overall.status === "critical") {
    const breached = result.projections.filter((p) => p.afterPercent < 75);
    const names = breached.map((p) => p.subjectName).join(", ");
    body.textContent = names
      ? `Missing ${missed} ${plural(missed, "class")} puts ${names} below 75%. That is enough to be detained from exams.`
      : `Missing ${missed} ${plural(missed, "class")} puts you below 75%.`;
  } else if (worst) {
    body.textContent = `Missing ${missed} ${plural(missed, "class")} is survivable. Your weakest subject afterwards is ${worst.subjectName} at ${worst.afterPercent}%.`;
  } else {
    body.textContent = `Missing ${missed} ${plural(missed, "class")} keeps every subject above 75%.`;
  }

  const stats = $("sim-result-stats");
  stats.replaceChildren();

  const entries: Array<[string, string]> = [
    ["Classes missed", `${missed}`],
    ["Days off still safe", `${overall.safeLeaveDaysRemaining}`],
  ];

  if (overall.recoveryClassesNeeded > 0) {
    entries.push(["Classes to recover", `${overall.recoveryClassesNeeded}`]);
    entries.push([
      "Days to recover",
      overall.recoveryBeyondSchedule ? `${overall.recoveryDaysNeeded}+` : `${overall.recoveryDaysNeeded}`,
    ]);
  }

  for (const [label, value] of entries) {
    const cell = el("div");
    cell.append(el("dt", "result__stat-label", label), el("dd", "result__stat-value", value));
    stats.append(cell);
  }

  if (overall.recoveryBeyondSchedule) {
    stats.append(
      el(
        "p",
        "result__stat-label",
        "Recovery runs past your synced schedule, so the day count is a lower bound.",
      ),
    );
  }

  renderImpacts(result);
  renderAffectedClasses(result);
}

function renderImpacts(result: SimulationResult) {
  const block = $("sim-impact-summary");
  const list = $("sim-impact-list");
  list.replaceChildren();

  if (result.projections.length === 0) {
    block.classList.add("hidden");
    return;
  }

  block.classList.remove("hidden");

  const ordered = [...result.projections].sort(
    (a, b) => a.afterPercent - b.afterPercent || b.classesMissed - a.classesMissed,
  );

  for (const projection of ordered) {
    const row = el("div", "impact");
    const info = el("div");
    info.append(
      el("div", "impact__name", projection.subjectName),
      el(
        "div",
        "impact__meta",
        `${projection.classesMissed} missed · ${projection.beforePercent}% → ${projection.afterPercent}%`,
      ),
    );
    row.append(
      info,
      el("span", `impact__value impact__value--${projection.status}`, `${projection.afterPercent}%`),
    );
    list.append(row);
  }
}

function renderAffectedClasses(result: SimulationResult) {
  const block = $("sim-class-list-wrap");
  const list = $("sim-class-list");
  list.replaceChildren();

  if (result.impactedSlots.length === 0) {
    block.classList.add("hidden");
    return;
  }

  block.classList.remove("hidden");

  const ordered = [...result.impactedSlots].sort(
    (a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime),
  );

  for (const slot of ordered.slice(0, MAX_LISTED_CLASSES)) {
    const row = el("div", "class-row");
    row.append(
      el("div", "class-row__name", slot.subjectName),
      el("div", "class-row__meta", `${formatDateLabel(slot.date)} · ${slot.startTime}–${slot.endTime}`),
    );
    list.append(row);
  }

  const hidden = ordered.length - MAX_LISTED_CLASSES;
  if (hidden > 0) {
    list.append(el("div", "class-row class-row--more", `and ${hidden} more`));
  }
}

/* ------------------------------ Render ------------------------------ */

function renderDashboard(dashboard: DashboardData) {
  const bits = [
    dashboard.student.studentName,
    dashboard.student.branch,
    dashboard.student.section,
    dashboard.student.semesterLabel,
  ].filter((value): value is string => Boolean(value && value.trim()));

  $("student-context").textContent = bits.length > 0 ? bits.join(" · ") : "NIET Greater Noida";

  renderVerdict(dashboard);
  renderNotice(dashboard);
  renderSubjects(dashboard);
}

/* -------------------------------- Init -------------------------------- */

function initTabs() {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>(".tab"));
  const panels = Array.from(document.querySelectorAll<HTMLElement>(".panel"));

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((item) => {
        item.classList.remove("is-active");
        item.setAttribute("aria-selected", "false");
      });
      panels.forEach((panel) => panel.classList.remove("is-active"));

      tab.classList.add("is-active");
      tab.setAttribute("aria-selected", "true");
      $(`tab-${tab.dataset.tab}`).classList.add("is-active");
    });
  });
}

function initSimulator() {
  const modeSelect = $("sim-mode") as HTMLSelectElement;
  const leaveFields = $("sim-leave-fields");
  const rangeFields = $("sim-range-fields");
  const futureFields = $("sim-future-fields");
  const errorEl = $("sim-error");

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

  const button = $("btn-simulate") as HTMLButtonElement;

  button.addEventListener("click", async () => {
    errorEl.classList.add("hidden");

    const mode = modeSelect.value;
    const request: Record<string, unknown> = { mode };

    if (mode === "leave-days") {
      const days = Number(($("sim-leave-days") as HTMLInputElement).value);
      if (!Number.isFinite(days) || days < 1) {
        errorEl.textContent = "Enter how many days you want to take off.";
        errorEl.classList.remove("hidden");
        return;
      }
      request.leaveDays = days;
      request.fromDate = ($("sim-from-date") as HTMLInputElement).value;
    } else if (mode === "date-range") {
      const from = ($("sim-range-from") as HTMLInputElement).value;
      const to = ($("sim-range-to") as HTMLInputElement).value;
      if (!from || !to) {
        errorEl.textContent = "Pick both a start and an end date.";
        errorEl.classList.remove("hidden");
        return;
      }
      if (to < from) {
        errorEl.textContent = "The end date is before the start date.";
        errorEl.classList.remove("hidden");
        return;
      }
      request.fromDate = from;
      request.toDate = to;
    } else {
      const count = Number(($("sim-future-count") as HTMLInputElement).value);
      if (!Number.isFinite(count) || count < 1) {
        errorEl.textContent = "Enter how many classes you might miss.";
        errorEl.classList.remove("hidden");
        return;
      }
      request.futureClasses = count;
    }

    button.textContent = "Checking…";
    button.disabled = true;

    try {
      const response = await sendMessage("RUN_SIMULATION", request);
      if (response?.success && response.result) {
        renderSimResult(response.result);
      } else {
        errorEl.textContent = response?.error ?? "Could not run that check.";
        errorEl.classList.remove("hidden");
      }
    } catch {
      errorEl.textContent = "Could not run that check.";
      errorEl.classList.remove("hidden");
    } finally {
      button.textContent = "Check impact";
      button.disabled = false;
    }
  });
}

function initPasteImport() {
  const button = $("btn-import-paste") as HTMLButtonElement;

  button.addEventListener("click", async () => {
    const textarea = $("paste-data") as HTMLTextAreaElement;
    const result = $("paste-result");
    const raw = textarea.value.trim();

    if (!raw) {
      result.textContent = "Paste your attendance table first.";
      result.className = "field__note field__note--bad";
      return;
    }

    const isHtml = raw.includes("<table") || raw.includes("</tr>");
    const parsed = isHtml ? parseAttendanceHtml(raw) : parseAttendanceText(raw);

    if (parsed.length === 0) {
      result.textContent = "Could not read any subjects from that. Copy the whole table including its headings.";
      result.className = "field__note field__note--bad";
      return;
    }

    try {
      const response = await sendMessage(
        "IMPORT_PASTED",
        buildSnapshot(parsed, "Pasted into the extension popup.", []),
      );

      if (response?.success) {
        result.textContent = `Imported ${parsed.length} ${parsed.length === 1 ? "subject" : "subjects"}.`;
        result.className = "field__note field__note--ok";
        textarea.value = "";
        renderDashboard(response.dashboard);
      } else {
        result.textContent = response?.error ?? "Could not save that.";
        result.className = "field__note field__note--bad";
      }
    } catch {
      result.textContent = "Could not save that.";
      result.className = "field__note field__note--bad";
    }
  });
}

function initOverlayToggle() {
  const toggle = $("toggle-overlay") as HTMLInputElement;

  toggle.addEventListener("change", () => {
    void sendMessage("SET_OVERLAY_PREFERENCE", toggle.checked);
  });

  void sendMessage("GET_PREFERENCES").then((response) => {
    if (response?.success) {
      toggle.checked = response.preferences?.showPageOverlay ?? true;
    }
  });
}

function initRefresh() {
  const button = $("btn-refresh");

  button.addEventListener("click", async () => {
    button.classList.add("is-busy");

    try {
      const response = await sendMessage("SCRAPE_ACTIVE_TAB");

      if (response?.success) {
        renderDashboard(response.dashboard);
        return;
      }

      // Refresh failed — keep whatever is stored and explain why.
      const fallback = await sendMessage("GET_DASHBOARD");
      if (fallback?.success) {
        renderDashboard(fallback.dashboard);
      }

      const notice = $("notice");
      notice.classList.remove("hidden");
      notice.classList.add("notice--error");
      $("notice-text").textContent = response?.error ?? "Open your NIET ERP attendance page to refresh.";
    } finally {
      button.classList.remove("is-busy");
    }
  });
}

async function main() {
  initTabs();
  initSimulator();
  initPasteImport();
  initOverlayToggle();
  initRefresh();

  const manifest = chrome.runtime.getManifest();
  $("version-label").textContent = `Attendance Planner ${manifest.version}`;

  try {
    const response = await sendMessage("GET_DASHBOARD");
    if (response?.success) {
      renderDashboard(response.dashboard);
    } else {
      $("verdict").dataset.state = "empty";
      $("verdict-headline").textContent = "Could not load your data";
      $("verdict-detail").textContent = "Try reopening the extension.";
    }
  } catch {
    $("verdict").dataset.state = "empty";
    $("verdict-headline").textContent = "Could not load your data";
    $("verdict-detail").textContent = "Try reopening the extension.";
  }
}

void main();
