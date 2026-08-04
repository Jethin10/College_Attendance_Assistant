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

function findHeaderIndex(headers: string[], aliases: string[]): number {
  return headers.findIndex((header) => aliases.includes(header));
}

function getAttendanceColumnsFromHeaders(
  headers: string[],
): AttendanceColumns | null {
  const columns: AttendanceColumns = {
    code: findHeaderIndex(headers, ["course code", "subject code", "paper code", "code"]),
    name: findHeaderIndex(headers, ["course name", "subject name", "paper name", "subject", "course"]),
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

  return columns.code >= 0 &&
    columns.name >= 0 &&
    columns.attended >= 0 &&
    columns.held >= 0
    ? columns
    : null;
}

function getAttendanceColumns(table: ParentNode): AttendanceColumns | null {
  for (const row of getTableRows(table)) {
    const headerCells = Array.from(row.querySelectorAll("th"));
    if (headerCells.length < 3) {
      continue;
    }

    const headers = headerCells.map((cell) => normalizeHeader(cell.textContent ?? ""));
    const columns = getAttendanceColumnsFromHeaders(headers);
    if (columns) {
      return columns;
    }
  }

  return null;
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

  const columns = getAttendanceColumns(table);
  if (columns) {
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

  const percentageText =
    columns.percentage >= 0 ? (cells[columns.percentage] ?? "") : "";

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
      : cells.find((cell) => /[A-Za-z]{3,}/.test(cell) && cell !== codeCell) ?? codeCell;

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
  const tabRows = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\t+/).map(normalizeWhitespace));
  const headerRowIndex = tabRows.findIndex(
    (cells) =>
      cells.length >= 4 &&
      getAttendanceColumnsFromHeaders(cells.map(normalizeHeader)) !== null,
  );

  if (headerRowIndex >= 0) {
    const columns = getAttendanceColumnsFromHeaders(
      tabRows[headerRowIndex].map(normalizeHeader),
    );
    if (columns) {
      const parsed = tabRows
        .slice(headerRowIndex + 1)
        .map((cells) => parseHeaderMappedRow(cells, columns))
        .filter((subject): subject is ParsedSubject => subject !== null);
      if (parsed.length > 0) {
        return parsed;
      }
    }
  }

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
  student?: ERPImportSnapshot["student"],
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

export function parsedToSubjects(
  parsed: ParsedSubject[],
  existingSubjects: Subject[] = [],
): Subject[] {
  const existingByCode = new Map(existingSubjects.map((subject) => [subject.code.toLowerCase(), subject]));

  return parsed.map((subject) => {
    const existing = existingByCode.get(subject.code.toLowerCase());
    const type: SubjectType =
      existing?.type ??
      (/\blab\b|practical|workshop/i.test(subject.name)
        ? "lab"
        : /mooc|nptel/i.test(subject.name)
          ? "other"
          : "theory");

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
