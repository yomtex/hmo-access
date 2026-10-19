/**
 * CSV / Excel parsing and row normalisation for member imports.
 * Parsing is defensive: bounded size, bounded rows, values treated strictly as text.
 */
import ExcelJS from "exceljs";
import Papa from "papaparse";
import { localMidnightUtc } from "@/lib/domain/periods";
import { normalizePhone } from "../crypto";
import { AppError } from "../errors";
import { inspectUpload, type InspectedUpload } from "../uploads/file-guard";
import type { NormalizedMemberRecord, RowError } from "./types";

/** Defaults; the effective limits come from config (IMPORT_MAX_BYTES, IMPORT_MAX_ROWS). */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 20_000;
export const MAX_IMPORT_COLUMNS = 50;
export const MAX_HEADER_LENGTH = 100;
export const MAX_CELL_LENGTH = 500;

export const IMPORT_FIELDS = [
  "member_number",
  "first_name",
  "last_name",
  "phone",
  "plan_code",
  "coverage_start",
  "coverage_end",
  "status",
  "member_group",
] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type FieldMapping = Partial<Record<ImportField, string>>;

const REQUIRED: ImportField[] = ["member_number", "first_name", "last_name", "phone", "plan_code", "coverage_start"];

const ALIASES: Record<ImportField, string[]> = {
  member_number: ["member_number", "member number", "member no", "enrollee id", "enrollee_id", "enrolee id", "member id", "memberid", "hmo id", "policy number"],
  first_name: ["first_name", "first name", "firstname", "given name", "other names"],
  last_name: ["last_name", "last name", "lastname", "surname", "family name"],
  phone: ["phone", "phone number", "phone_number", "mobile", "mobile number", "msisdn", "gsm"],
  plan_code: ["plan_code", "plan code", "plan", "plan id"],
  coverage_start: ["coverage_start", "coverage start", "start date", "effective date", "start"],
  coverage_end: ["coverage_end", "coverage end", "end date", "expiry date", "expiry", "end"],
  status: ["status", "coverage status", "member status"],
  member_group: ["member_group", "member group", "group", "employer", "company"],
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[_\s]+/g, " ");

export type ParsedTable = { headers: string[]; rows: Record<string, string>[] };
/** A valid, normalised row plus the original cell values it came from (kept, encrypted, for audit). */
export type StagedRecord = NormalizedMemberRecord & { row: number; raw: Record<string, string> };

export type ParseLimits = { maxBytes: number; maxRows: number };

/** Inspects (file-guard) and parses an upload. Kept for callers that have only a name and bytes. */
export async function parseTable(fileName: string, data: Buffer, limits: ParseLimits = { maxBytes: MAX_IMPORT_BYTES, maxRows: MAX_IMPORT_ROWS }): Promise<ParsedTable> {
  const inspected = inspectUpload({ fileName, data, maxBytes: limits.maxBytes });
  return parseInspected(inspected, data, limits);
}

export async function parseInspected(inspected: InspectedUpload, data: Buffer, limits: ParseLimits): Promise<ParsedTable> {
  const table = inspected.kind === "xlsx" ? await parseXlsx(data, limits.maxRows) : parseCsv(inspected.text ?? "", limits.maxRows);
  checkHeaders(table.headers);
  return table;
}

function checkHeaders(headers: string[]) {
  if (headers.length === 0) throw new AppError("VALIDATION_FAILED", "The first row must contain column names");
  if (headers.length > MAX_IMPORT_COLUMNS) throw new AppError("VALIDATION_FAILED", `The file has more than ${MAX_IMPORT_COLUMNS} columns`);
  const seen = new Set<string>();
  for (const h of headers) {
    if (h.length > MAX_HEADER_LENGTH) throw new AppError("VALIDATION_FAILED", "A column name is too long");
    const k = norm(h);
    if (seen.has(k)) throw new AppError("VALIDATION_FAILED", `Column "${h.slice(0, 40)}" appears more than once`);
    seen.add(k);
  }
}

function parseCsv(text: string, maxRows: number): ParsedTable {
  // Count lines before parsing so a huge file is refused without building every row.
  let lines = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10 && ++lines > maxRows + 1000) break;
  if (lines > maxRows + 1000) throw new AppError("VALIDATION_FAILED", `File has more than ${maxRows} rows`);
  const res = Papa.parse<string[]>(text, { header: false, skipEmptyLines: "greedy", dynamicTyping: false });
  if (res.errors.length > 0 && res.data.length === 0) throw new AppError("VALIDATION_FAILED", "Could not parse CSV file");
  const [head = [], ...body] = res.data;
  if (body.length > maxRows) throw new AppError("VALIDATION_FAILED", `File has more than ${maxRows} rows`);
  const headers = head.map((h) => String(h ?? "").trim());
  if (headers.length > MAX_IMPORT_COLUMNS) throw new AppError("VALIDATION_FAILED", `The file has more than ${MAX_IMPORT_COLUMNS} columns`);
  const rows = body.map((cells) => Object.fromEntries(headers.map((h, i) => [h, String(cells[i] ?? "").trim()])));
  return { headers: headers.filter(Boolean), rows };
}

async function parseXlsx(data: Buffer, maxRows: number): Promise<ParsedTable> {
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(data as unknown as ArrayBuffer);
  } catch {
    throw new AppError("VALIDATION_FAILED", "Could not read Excel file");
  }
  const ws = wb.worksheets[0];
  if (!ws) throw new AppError("VALIDATION_FAILED", "Workbook has no sheets");
  if (ws.rowCount > maxRows + 1) throw new AppError("VALIDATION_FAILED", `File has more than ${maxRows} rows`);
  if (ws.columnCount > MAX_IMPORT_COLUMNS) throw new AppError("VALIDATION_FAILED", `The file has more than ${MAX_IMPORT_COLUMNS} columns`);
  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => {
    headers[col - 1] = cellText(cell.value).trim();
  });
  const rows: Record<string, string>[] = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const obj: Record<string, string> = {};
    let any = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const v = cellText(row.getCell(i + 1).value).trim();
      if (v) any = true;
      obj[h] = v;
    });
    if (any) rows.push(obj);
  }
  return { headers: headers.filter(Boolean), rows };
}

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    // Excel dates are calendar dates; ExcelJS gives them as UTC midnight.
    return v.toISOString().slice(0, 10);
  }
  if (typeof v === "object") {
    // Formula / rich text / hyperlink: take the displayed result as plain text. Formulas are never evaluated.
    const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] };
    if (o.richText) return o.richText.map((t) => t.text).join("");
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return o.result instanceof Date ? o.result.toISOString().slice(0, 10) : String(o.result);
    return "";
  }
  return String(v);
}

/** Auto-detect a mapping from file headers; explicit mapping entries take precedence. */
export function resolveMapping(headers: string[], explicit: FieldMapping = {}): { mapping: FieldMapping; missing: ImportField[] } {
  const mapping: FieldMapping = {};
  const byNorm = new Map(headers.map((h) => [norm(h), h]));
  for (const f of IMPORT_FIELDS) {
    const e = explicit[f];
    if (e && headers.includes(e)) {
      mapping[f] = e;
      continue;
    }
    const hit = ALIASES[f].map(norm).find((a) => byNorm.has(a));
    if (hit) mapping[f] = byNorm.get(hit)!;
  }
  const missing = REQUIRED.filter((f) => !mapping[f]);
  return { mapping, missing };
}

/** Parses YYYY-MM-DD or DD/MM/YYYY (day-first, as used in Nigeria). Returns [y, m, d] or null. */
export function parseLocalDate(s: string): [number, number, number] | null {
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (y < 1990 || y > 2100) return null;
  return [y, mo, d];
}

export const NAME_RE = /^[\p{L}][\p{L}\p{M}'’. -]{0,79}$/u;
export const MEMBER_NO_RE = /^[A-Za-z0-9][A-Za-z0-9/_.-]{0,63}$/;
export const GROUP_RE = /^[\p{L}\p{N}][\p{L}\p{N} &'._-]{0,59}$/u;

export function normalizeRows(
  rows: Record<string, string>[],
  mapping: FieldMapping,
  opts: { knownPlanCodes: Set<string>; timezone: string },
): { valid: StagedRecord[]; errors: RowError[] } {
  const valid: StagedRecord[] = [];
  const errors: RowError[] = [];
  const seen = new Map<string, number>();

  rows.forEach((raw, idx) => {
    const row = idx + 2; // spreadsheet row number (header is row 1)
    const get = (f: ImportField) => (mapping[f] ? (raw[mapping[f]!] ?? "").trim() : "");
    const errs: RowError[] = [];
    const err = (field: ImportField, code: string, message: string) => errs.push({ row, field, code, message });

    for (const f of REQUIRED) if (!get(f)) err(f, "REQUIRED", `${f} is required`);
    for (const f of IMPORT_FIELDS) if (get(f).length > MAX_CELL_LENGTH) err(f, "VALUE_TOO_LONG", `${f} is longer than ${MAX_CELL_LENGTH} characters`);

    const memberNumber = get("member_number");
    if (memberNumber && !MEMBER_NO_RE.test(memberNumber)) err("member_number", "INVALID_FORMAT", "Member number contains unsupported characters");
    const firstName = get("first_name");
    const lastName = get("last_name");
    if (firstName && !NAME_RE.test(firstName)) err("first_name", "INVALID_FORMAT", "First name contains unsupported characters");
    if (lastName && !NAME_RE.test(lastName)) err("last_name", "INVALID_FORMAT", "Last name contains unsupported characters");

    const phoneRaw = get("phone");
    const phone = phoneRaw ? normalizePhone(phoneRaw) : null;
    if (phoneRaw && !phone) err("phone", "INVALID_PHONE", "Phone number is not a valid mobile number");

    const planCode = get("plan_code").toUpperCase();
    if (planCode && !opts.knownPlanCodes.has(planCode)) err("plan_code", "UNKNOWN_PLAN", `Plan code ${planCode.slice(0, 30)} does not exist`);

    const startRaw = get("coverage_start");
    const endRaw = get("coverage_end");
    const start = startRaw ? parseLocalDate(startRaw) : null;
    const end = endRaw ? parseLocalDate(endRaw) : null;
    if (startRaw && !start) err("coverage_start", "INVALID_DATE", "Use YYYY-MM-DD or DD/MM/YYYY");
    if (endRaw && !end) err("coverage_end", "INVALID_DATE", "Use YYYY-MM-DD or DD/MM/YYYY");
    let coverageStart: Date | null = null;
    let coverageEnd: Date | null = null;
    if (start) coverageStart = localMidnightUtc(start[0], start[1], start[2], opts.timezone);
    if (end) {
      const next = new Date(Date.UTC(end[0], end[1] - 1, end[2] + 1)); // inclusive end date -> exclusive instant
      coverageEnd = localMidnightUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), opts.timezone);
    }
    if (coverageStart && coverageEnd && coverageEnd <= coverageStart) err("coverage_end", "END_BEFORE_START", "Coverage end is before coverage start");

    const statusRaw = (get("status") || "ACTIVE").toUpperCase();
    const statusMap: Record<string, NormalizedMemberRecord["coverageStatus"]> = {
      ACTIVE: "ACTIVE", A: "ACTIVE", SUSPENDED: "SUSPENDED", S: "SUSPENDED", TERMINATED: "TERMINATED", T: "TERMINATED", INACTIVE: "TERMINATED", CANCELLED: "TERMINATED",
    };
    const coverageStatus = statusMap[statusRaw];
    if (!coverageStatus) err("status", "INVALID_STATUS", "Status must be ACTIVE, SUSPENDED or TERMINATED");

    const memberGroup = get("member_group") || null;
    if (memberGroup && !GROUP_RE.test(memberGroup)) err("member_group", "INVALID_FORMAT", "Member group contains unsupported characters");

    if (memberNumber && planCode && coverageStart) {
      const key = `${memberNumber.toUpperCase()}|${planCode}|${coverageStart.toISOString()}`;
      const prev = seen.get(key);
      if (prev) err("member_number", "DUPLICATE_IN_FILE", `Duplicate of row ${prev}`);
      else seen.set(key, row);
    }

    if (errs.length) errors.push(...errs);
    else
      valid.push({
        row,
        raw: Object.fromEntries(IMPORT_FIELDS.filter((f) => mapping[f]).map((f) => [f, (raw[mapping[f]!] ?? "").slice(0, MAX_CELL_LENGTH)])),
        memberNumber,
        firstName,
        lastName,
        phone,
        planCode,
        coverageStart: coverageStart!,
        coverageEnd,
        coverageStatus: coverageStatus!,
        memberGroup,
      });
  });

  return { valid, errors };
}
