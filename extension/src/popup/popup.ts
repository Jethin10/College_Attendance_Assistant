/**
 * Popup controller.
 *
 * The headline shows the student's margin against NIET's published 75% target.
 * It is deliberately advisory: the extension cannot decide exam eligibility,
 * condonation, or exceptions. Aggregate percentage remains supporting context
 * that can be cross-checked against the ERP.
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
  $("weak-note").classList.add("hidden");

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
    const weakest = dashboard.subjects.find(
      (subject) => subject.id === overall.weakestSubjectId,
    );
    if (overall.attendancePercent < dashboard.policy.thresholdPercent) {
      const need = overall.recoveryClassesNeeded;
      headline.textContent = "Below the 75% planning target";
      detail.textContent = `You are at ${overall.attendancePercent}% overall. ${need} attended ${plural(need, "class")} would return you to 75%; this does not decide exam eligibility.`;
    } else if (weakest) {
      const need = weakest.recoveryClassesNeeded;
      headline.textContent = `${weakest.name} is below the target`;
      detail.textContent = `It is at ${weakest.attendancePercent}%. ${need} attended ${plural(need, "class")} would return it to 75%; overall is ${overall.attendancePercent}%.`;
    } else {
      headline.textContent = "A subject is below the target";
      detail.textContent = `Your overall attendance is ${overall.attendancePercent}%. This is a planning warning, not an exam-eligibility decision.`;
    }
  } else if (overall.safeToMissClasses === 0) {
    headline.textContent = "At the 75% planning limit";
    detail.textContent = `Another recorded absence would move a subject below the target. NIET and the ERP remain authoritative.`;
  } else {
    const count = overall.safeToMissClasses;
    headline.textContent = `${count} ${plural(count, "class")} of margin to 75%`;
    detail.textContent = `Your weakest subject would stay at or above the published target. Overall attendance is ${overall.attendancePercent}%.`;
  }

  const stats: Array<[string, string]> = [];

  if (dashboard.calendarSessions.length > 0 && overall.safeLeaveDays > 0) {
    stats.push(["Full days off", `${overall.safeLeaveDays}`]);
  }

  if (overall.status !== "critical" && overall.safeToMissClasses > 0) {
    stats.push(["Next miss costs", `${overall.nextMissDropPercent}%`]);
  }

  stats.push(["Classes", `${overall.attendedClasses}/${overall.heldClasses}`]);

  for (const [label, value] of stats) {
    const item = el("span");
    item.append(`${label} `, el("strong", undefined, value));
    meta.append(item);
  }

  // Keep a concise subject-level note beside the primary verdict.
  renderWeakSubjectNote(dashboard);
}

function renderWeakSubjectNote(dashboard: DashboardData) {
  const note = $("weak-note");
  const below = dashboard.subjects.filter(
    (subject) => subject.status !== "not-started" && subject.attendancePercent < 75,
  );

  if (below.length === 0 || dashboard.overall.status === "critical") {
    note.classList.add("hidden");
    return;
  }

  const weakest = [...below].sort((a, b) => a.attendancePercent - b.attendancePercent)[0];
  note.classList.remove("hidden");
  note.replaceChildren();

  const label =
    below.length === 1
      ? `${weakest.name} is at ${weakest.attendancePercent}%`
      : `${below.length} subjects are below 75%, lowest ${weakest.name} at ${weakest.attendancePercent}%`;

  note.append(
    el("span", "weak-note__label", label),
    el("span", "weak-note__hint", "Published planning target; approved exceptions may apply."),
  );
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
    container.append(subjectRow(subject));
  }
}

function subjectRow(subject: DashboardSubject) {
  const row = el("div", `subject subject--${subject.status}`);

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
    meta.append(`${subject.code} · ${subject.attendedClasses}/${subject.heldClasses}`);

    if (subject.status === "critical") {
      const need = subject.recoveryClassesNeeded;
      meta.append(" · ", el("span", "subject__flag", `${need} to reach 75%`));
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

  $("sim-result-title").textContent = `${overall.beforePercent}% → ${overall.afterPercent}% overall`;

  const status = $("sim-result-status");
  status.textContent = overall.status === "critical" ? "Below target" : overall.status === "warning" ? "Close to target" : "Above target";
  status.className = `pill pill--${overall.status}`;

  const body = $("sim-result-body");
  const missed = overall.classesMissed;

  if (missed === 0) {
    body.textContent = "No classes fall in that window, so your attendance is unchanged.";
  } else if (overall.status === "critical") {
    body.textContent = `Missing ${missed} ${plural(missed, "class")} drops you to ${overall.afterPercent}% overall, below the published 75% target. ${overall.recoveryClassesNeeded} attended ${plural(overall.recoveryClassesNeeded, "class")} would return you to it; eligibility is decided by NIET.`;
  } else {
    body.textContent = `Missing ${missed} ${plural(missed, "class")} leaves you at ${overall.afterPercent}% overall, still above the published target.`;
  }

  const stats = $("sim-result-stats");
  stats.replaceChildren();

  const entries: Array<[string, string]> = [
    ["Classes missed", `${missed}`],
    ["Days within target", `${overall.safeLeaveDaysRemaining}`],
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
