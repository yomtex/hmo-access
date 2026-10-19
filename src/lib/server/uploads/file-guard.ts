/**
 * Upload gate for member files. Decides what a file REALLY is from its bytes — never from the file
 * name or the browser's MIME type alone — and rejects anything that is not a plain CSV or a
 * macro-free .xlsx workbook within safe resource limits.
 *
 * Nothing here writes to disk: uploads are parsed in memory and only validated, encrypted rows are
 * stored (import_rows), so there is no file path to traverse and nothing that could be executed.
 */
import { AppError } from "../errors";

export type UploadKind = "csv" | "xlsx";
export type InspectedUpload = { kind: UploadKind; detectedType: string; displayName: string; text?: string };

/** Limits for .xlsx containers (a zip of XML files). */
export const XLSX_LIMITS = {
  maxEntries: 2000,
  maxTotalUncompressedBytes: 64 * 1024 * 1024,
  /** Compression ratio above which a large entry is treated as a decompression bomb. */
  maxRatio: 200,
  ratioAppliesAboveBytes: 1024 * 1024,
};

const ALLOWED_EXTENSIONS: Record<string, UploadKind> = { ".csv": "csv", ".txt": "csv", ".xlsx": "xlsx" };

/** Signatures of formats that are never accepted, with a message the uploader can act on. */
const REJECTED_SIGNATURES: { magic: number[]; message: string }[] = [
  { magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], message: "This is an old .xls workbook or a password-protected file. Open it in Excel and save as .xlsx (no password) or CSV UTF-8." },
  { magic: [0x4d, 0x5a], message: "Executable files are not accepted." },
  { magic: [0x7f, 0x45, 0x4c, 0x46], message: "Executable files are not accepted." },
  { magic: [0x25, 0x50, 0x44, 0x46], message: "PDF files are not accepted; export the member list as CSV or .xlsx." },
  { magic: [0x89, 0x50, 0x4e, 0x47], message: "Images are not accepted; upload a CSV or .xlsx file." },
  { magic: [0xff, 0xd8, 0xff], message: "Images are not accepted; upload a CSV or .xlsx file." },
  { magic: [0x47, 0x49, 0x46, 0x38], message: "Images are not accepted; upload a CSV or .xlsx file." },
  { magic: [0x1f, 0x8b], message: "Compressed (.gz) files are not accepted; upload the CSV or .xlsx itself." },
  { magic: [0x52, 0x61, 0x72, 0x21], message: "Archives are not accepted; upload the CSV or .xlsx itself." },
  { magic: [0x37, 0x7a, 0xbc, 0xaf], message: "Archives are not accepted; upload the CSV or .xlsx itself." },
];

const startsWith = (b: Buffer, magic: number[]) => b.length >= magic.length && magic.every((m, i) => b[i] === m);
const reject = (message: string, details?: Record<string, unknown>) => new AppError("VALIDATION_FAILED", message, { details: { stage: "file", ...details } });

/** The name shown back to the HMO. Path parts, control characters and odd symbols are removed. */
export function safeDisplayName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^\w.\- ()]/g, "_").replace(/^\.+/, "").slice(0, 120);
  return cleaned || "upload";
}

export function inspectUpload(input: { fileName: string; data: Buffer; maxBytes: number }): InspectedUpload {
  const { data } = input;
  const displayName = safeDisplayName(input.fileName);
  if (data.length === 0) throw reject("The file is empty");
  if (data.length > input.maxBytes) throw reject(`File exceeds ${Math.floor(input.maxBytes / 1024 / 1024)} MB`);

  const dot = displayName.lastIndexOf(".");
  const ext = dot >= 0 ? displayName.slice(dot).toLowerCase() : "";
  const claimed = ALLOWED_EXTENSIONS[ext];
  if (!claimed) throw reject("Unsupported file type; upload .csv or .xlsx", { extension: ext || null });

  for (const s of REJECTED_SIGNATURES) if (startsWith(data, s.magic)) throw reject(s.message);

  const isZip = startsWith(data, [0x50, 0x4b, 0x03, 0x04]);
  if (claimed === "xlsx") {
    if (!isZip) throw reject("The file is named .xlsx but is not an Excel workbook");
    inspectXlsxContainer(data);
    return { kind: "xlsx", detectedType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", displayName };
  }
  if (isZip) throw reject("The file is named .csv but contains a workbook or archive; upload it as .xlsx");
  const { text, charset } = decodeText(data);
  return { kind: "csv", detectedType: `text/csv; charset=${charset}`, displayName, text };
}

/** CSV text: UTF-8 (with or without BOM); Windows-1252 accepted as Excel's legacy "CSV" export. */
function decodeText(data: Buffer): { text: string; charset: string } {
  if (data.includes(0)) throw reject("The file contains binary data; it is not a CSV file");
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(data).replace(/^﻿/, ""), charset: "utf-8" };
  } catch {
    return { text: new TextDecoder("windows-1252").decode(data), charset: "windows-1252" };
  }
}

/**
 * Reads the zip central directory (without decompressing anything) and rejects workbooks that are
 * encrypted, contain macros / ActiveX / embedded objects / external links, have unsafe entry names,
 * or would expand beyond the limits (decompression bombs).
 */
export function inspectXlsxContainer(data: Buffer): void {
  // End of central directory record: signature 0x06054b50, within the last 64 KiB + 22 bytes.
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65_557); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw reject("The workbook is damaged (no zip directory)");
  const entries = data.readUInt16LE(eocd + 10);
  const cdSize = data.readUInt32LE(eocd + 12);
  const cdOffset = data.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) throw reject("Workbooks in ZIP64 format are not supported");
  if (entries > XLSX_LIMITS.maxEntries) throw reject("The workbook has too many internal parts");
  if (cdOffset + cdSize > eocd) throw reject("The workbook is damaged (bad zip directory)");

  const names = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (p + 46 > data.length || data.readUInt32LE(p) !== 0x02014b50) throw reject("The workbook is damaged (bad zip entry)");
    const flags = data.readUInt16LE(p + 8);
    const compressed = data.readUInt32LE(p + 20);
    const uncompressed = data.readUInt32LE(p + 24);
    const nameLen = data.readUInt16LE(p + 28);
    const extraLen = data.readUInt16LE(p + 30);
    const commentLen = data.readUInt16LE(p + 32);
    const name = data.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    p += 46 + nameLen + extraLen + commentLen;

    if (flags & 0x1) throw reject("Password-protected workbooks are not accepted; remove the password and upload again");
    if (compressed === 0xffffffff || uncompressed === 0xffffffff) throw reject("Workbooks in ZIP64 format are not supported");
    if (name.startsWith("/") || name.includes("..") || name.includes("\\") || /[\x00-\x1f]/.test(name)) throw reject("The workbook contains unsafe internal file names");
    const lower = name.toLowerCase();
    if (names.has(lower)) throw reject("The workbook contains duplicate internal parts");
    names.add(lower);
    if (/vbaproject\.bin$/.test(lower) || lower.startsWith("xl/activex/") || lower.startsWith("xl/embeddings/") || lower.startsWith("xl/externallinks/") || lower.endsWith(".bin")) {
      throw reject("Workbooks with macros, ActiveX controls, embedded objects or external links are not accepted. Save a plain .xlsx copy (or CSV) and upload that.");
    }
    total += uncompressed;
    if (total > XLSX_LIMITS.maxTotalUncompressedBytes) throw reject("The workbook expands to too much data");
    if (uncompressed > XLSX_LIMITS.ratioAppliesAboveBytes && uncompressed > Math.max(compressed, 1) * XLSX_LIMITS.maxRatio) throw reject("The workbook is compressed suspiciously (possible zip bomb)");
  }
  if (!names.has("[content_types].xml") || !names.has("xl/workbook.xml")) throw reject("The file is a zip archive but not an Excel workbook");
}
