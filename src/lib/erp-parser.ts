/**
 * ERP Parser - parses NIET ERP attendance tables from live DOM or pasted HTML/text.
 */

import { ERPImportSnapshot, Subject, SubjectType } from "@/lib/types";

export interface ParsedSubject {
  code: string;
  name: string;
  heldClasses: number;
  attendedClasses: number;
  attendancePercent?: number;
}

function normalizeWhitespace(value: string): string {
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

export function findAttendanceTableElement(): HTMLTableElement | null {
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

export function scrapeAttendanceFromDOM(): ParsedSubject[] {
  const table = findAttendanceTableElement();
  return table ? parseSubjectsFromTable(table) : [];
}

export function parseAttendanceHtml(html: string): ParsedSubject[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const table = findAttendanceTableInRoot(doc);
  return table ? parseSubjectsFromTable(table) : [];
}

export function parseAttendanceText(text: string): ParsedSubject[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean);

  const subjects: ParsedSubject[] = [];

  for (const line of lines) {
    const match = line.match(
      /^([A-Z]{2,}\d+[A-Z0-9]*)\s+(.+?)\s+(\d+\s*\/\s*\d+)\s+(\d+(?:\.\d+)?)%?$/i,
    );
    if (!match) {
      continue;
    }

    const counts = parseAttendanceCount(match[3]);
    if (!counts) {
      continue;
    }

    subjects.push({
      code: match[1].toUpperCase(),
      name: match[2],
      attendedClasses: counts.attendedClasses,
      heldClasses: counts.heldClasses,
      attendancePercent: Number(match[4]),
    });
  }

  return subjects;
}

export function buildSnapshot(
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

export function parsedToSubjects(
  parsed: ParsedSubject[],
  existingSubjects: Subject[] = [],
): Subject[] {
  const existingByCode = new Map(existingSubjects.map((subject) => [subject.code.toLowerCase(), subject]));

  return parsed.map((subject) => {
    const existing = existingByCode.get(subject.code.toLowerCase());
    const type: SubjectType =
      existing?.type ??
      (/lab/i.test(subject.name) ? "lab" : /mooc/i.test(subject.name) ? "other" : "theory");

    return {
      id: existing?.id ?? subject.code.toLowerCase(),
      code: subject.code,
      name: subject.name,
      type,
      heldClasses: subject.heldClasses,
      attendedClasses: subject.attendedClasses,
    };
  });
}

export function detectAttendanceTable(): boolean {
  return findAttendanceTableInRoot(document) !== null;
}
