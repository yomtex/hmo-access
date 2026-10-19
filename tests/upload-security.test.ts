/**
 * Upload security: real file type from bytes, signature/extension mismatches, hostile workbooks,
 * size/row/column limits, size-capped request bodies, malware scanning, safe names, formula
 * injection in exported reports, and no personal data in logs of rejected files.
 */
import net from "node:net";
import ExcelJS from "exceljs";
import { eq, and } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db, schema } from "@/db/client";
import { handle } from "@/lib/server/api/router";
import { resetConfigCache } from "@/lib/server/config";
import { inspectUpload, safeDisplayName } from "@/lib/server/uploads/file-guard";
import { clamdScan, setUploadScannerForTests } from "@/lib/server/uploads/scanner";
import { errorsToCsv, importReportCsv, previewImport } from "@/lib/server/services/imports";
import { inviteStaff } from "@/lib/server/services/organizations";
import { csvOf, installSms, makeWorld, phone, uid } from "./helpers/factory";
import { makeZip, XLSX_BASE } from "./helpers/zip";

type World = Awaited<ReturnType<typeof makeWorld>>;
let w: World;
const MB = 1024 * 1024;
const inspect = (fileName: string, data: Buffer) => inspectUpload({ fileName, data, maxBytes: 5 * MB });
const row = (n = uid()) => ({ member_number: `SEC-${n}`, first_name: "Ngozi", last_name: "Eze", phone: phone(), plan_code: w.plan.code, coverage_start: "2024-01-01" });

beforeAll(async () => {
  installSms();
  w = await makeWorld();
});
afterEach(() => setUploadScannerForTests(null));

describe("file type is decided by content, not by name", () => {
  it("accepts a real CSV and a real .xlsx", async () => {
    expect(inspect("m.csv", Buffer.from("a,b\n1,2")).kind).toBe("csv");
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("S").addRow(["a"]);
    expect(inspect("m.xlsx", Buffer.from(await wb.xlsx.writeBuffer())).kind).toBe("xlsx");
  });

  it("rejects unsupported extensions, including double extensions", () => {
    for (const n of ["members.exe", "members.csv.exe", "members.xls", "members.xlsm", "members", "members.json"]) {
      expect(() => inspect(n, Buffer.from("a,b"))).toThrow(/Unsupported file type/);
    }
  });

  it("rejects mismatched signatures: executable named .csv, workbook named .csv, text named .xlsx", () => {
    expect(() => inspect("m.csv", Buffer.concat([Buffer.from("MZ"), Buffer.alloc(100)]))).toThrow(/Executable/);
    expect(() => inspect("m.csv", makeZip(XLSX_BASE))).toThrow(/upload it as .xlsx/);
    expect(() => inspect("m.xlsx", Buffer.from("member_number,first_name\n"))).toThrow(/not an Excel workbook/);
    expect(() => inspect("m.csv", Buffer.from("%PDF-1.7 ..."))).toThrow(/PDF/);
    expect(() => inspect("m.xlsx", Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]))).toThrow(/old .xls|password/);
  });

  it("rejects binary content in a CSV and decodes Excel's legacy Windows-1252 CSV", () => {
    expect(() => inspect("m.csv", Buffer.from([0x61, 0x2c, 0x00, 0x62]))).toThrow(/binary/);
    const latin = Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x4a, 0x6f, 0x73, 0xe9]); // "name\nJosé" in Windows-1252
    const r = inspect("m.csv", latin);
    expect(r.detectedType).toContain("windows-1252");
    expect(r.text).toContain("José");
  });

  it("rejects empty and oversized files", () => {
    expect(() => inspect("m.csv", Buffer.alloc(0))).toThrow(/empty/);
    expect(() => inspectUpload({ fileName: "m.csv", data: Buffer.alloc(2 * MB, 0x61), maxBytes: MB })).toThrow(/exceeds/);
  });

  it("never trusts the uploaded name: path parts and odd characters are removed", () => {
    expect(safeDisplayName("../../etc/passwd.csv")).toBe("passwd.csv");
    expect(safeDisplayName("C:\\Users\\x\\members<script>.csv")).toBe("members_script_.csv");
    expect(safeDisplayName("...hidden.csv")).toBe("hidden.csv");
  });
});

describe("hostile .xlsx workbooks are refused before parsing", () => {
  const cases: [string, ReturnType<typeof makeZip>, RegExp][] = [
    ["macros", makeZip([...XLSX_BASE, { name: "xl/vbaProject.bin", data: Buffer.from("x") }]), /macros/],
    ["ActiveX", makeZip([...XLSX_BASE, { name: "xl/activeX/activeX1.bin", data: Buffer.from("x") }]), /macros/],
    ["embedded objects", makeZip([...XLSX_BASE, { name: "xl/embeddings/oleObject1.bin", data: Buffer.from("x") }]), /macros/],
    ["external links", makeZip([...XLSX_BASE, { name: "xl/externalLinks/externalLink1.xml", data: Buffer.from("x") }]), /external links/],
    ["path traversal", makeZip([...XLSX_BASE, { name: "../../evil.sh", data: Buffer.from("x") }]), /unsafe internal file names/],
    ["absolute path", makeZip([...XLSX_BASE, { name: "/etc/cron.d/x", data: Buffer.from("x") }]), /unsafe internal file names/],
    ["encryption", makeZip([...XLSX_BASE, { name: "xl/worksheets/sheet1.xml", data: Buffer.from("x"), flags: 1 }]), /Password-protected/],
    ["decompression bomb (ratio)", makeZip([...XLSX_BASE, { name: "xl/worksheets/sheet1.xml", data: Buffer.from("x"), claimCompressed: 1000, claimUncompressed: 50 * MB }]), /zip bomb/],
    ["decompression bomb (total)", makeZip([...XLSX_BASE, ...Array.from({ length: 5 }, (_, i) => ({ name: `xl/worksheets/s${i}.xml`, data: Buffer.from("x"), claimCompressed: 15 * MB, claimUncompressed: 15 * MB }))]), /too much data/],
    ["duplicate parts", makeZip([...XLSX_BASE, { name: "xl/workbook.xml", data: Buffer.from("x") }]), /duplicate/],
    ["not a workbook", makeZip([{ name: "readme.txt", data: Buffer.from("x") }]), /not an Excel workbook/],
    ["truncated", makeZip(XLSX_BASE).subarray(0, 40), /damaged/],
  ];
  for (const [label, data, re] of cases) {
    it(`refuses ${label}`, () => {
      expect(() => inspect("m.xlsx", Buffer.from(data))).toThrow(re);
    });
  }

  it("a corrupted workbook that passes the container check fails parsing cleanly", async () => {
    await expect(previewImport(w.hmo.admin, { fileName: "m.xlsx", data: makeZip([...XLSX_BASE, { name: "xl/worksheets/sheet1.xml", data: Buffer.from("<not xml") }]) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
});

describe("structure and resource limits", () => {
  it("refuses too many columns, duplicate columns and over-long column names", async () => {
    const wide = Array.from({ length: 51 }, (_, i) => `c${i}`).join(",");
    await expect(previewImport(w.hmo.admin, { fileName: "w.csv", data: Buffer.from(`${wide}\n`) })).rejects.toThrow(/more than 50 columns/);
    await expect(previewImport(w.hmo.admin, { fileName: "d.csv", data: Buffer.from("member_number,Member Number,first_name\n1,2,3") })).rejects.toThrow(/appears more than once/);
    await expect(previewImport(w.hmo.admin, { fileName: "l.csv", data: Buffer.from(`${"x".repeat(101)}\n1`) })).rejects.toThrow(/too long/);
  });

  it("refuses files with more rows than IMPORT_MAX_ROWS", async () => {
    process.env.IMPORT_MAX_ROWS = "5";
    resetConfigCache();
    try {
      await expect(previewImport(w.hmo.admin, { fileName: "big.csv", data: csvOf(Array.from({ length: 6 }, () => row())) })).rejects.toThrow(/more than 5 rows/);
    } finally {
      delete process.env.IMPORT_MAX_ROWS;
      resetConfigCache();
    }
  });

  it("over-long cell values are row errors, not crashes", async () => {
    const p = await previewImport(w.hmo.admin, { fileName: "long.csv", data: csvOf([{ ...row(), first_name: "A".repeat(600) }]) });
    expect(p.errors.map((e) => e.code)).toContain("VALUE_TOO_LONG");
  });

  it("formulas in workbook cells are read as their text result, never evaluated", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Members");
    ws.addRow(["member_number", "first_name", "last_name", "phone", "plan_code", "coverage_start"]);
    ws.addRow([`F-${uid()}`, { formula: 'HYPERLINK("http://evil.example","Ada")', result: "Ada" }, "Bello", "08031234567", w.plan.code, "2024-01-01"]);
    const p = await previewImport(w.hmo.admin, { fileName: "f.xlsx", data: Buffer.from(await wb.xlsx.writeBuffer()) });
    expect(p.errors).toEqual([]);
    expect(p.previewRows[0].name).toBe("Ada Bello");
  });
});

describe("HTTP upload limits", () => {
  let token: string;
  beforeAll(async () => {
    const u = await inviteStaff(w.hmo.admin, { email: `upl-${uid()}@test.local`, name: "Uploader", roleKey: "HMO_OPERATIONS" });
    const res = await handle(new Request("http://localhost:3000/v1/auth/login", { method: "POST", headers: { host: "localhost:3000", "content-type": "application/json", "x-forwarded-for": "9.9.9.77" }, body: JSON.stringify({ email: u.email, password: u.temporaryPassword }) }));
    token = (await res.json()).token;
  });
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    handle(new Request("http://localhost:3000/v1/imports", { method: "POST", headers: { host: "localhost:3000", authorization: `Bearer ${token}`, ...headers }, body }));

  it("refuses an upload whose declared size exceeds the limit without reading it", async () => {
    const res = await post("x", { "content-length": String(50 * MB), "content-type": "multipart/form-data; boundary=x" });
    expect(res.status).toBe(413);
  });

  it("refuses a streamed body that grows past the limit", async () => {
    const big = new FormData();
    big.set("file", new File([Buffer.alloc(6 * MB, 0x61)], "big.csv", { type: "text/csv" }));
    const res = await post(big);
    expect(res.status).toBe(413);
  });

  it("refuses a chunked body with no Content-Length once it passes the limit", async () => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent > 20 * MB) return c.close(); // never reached: the reader stops at the limit
        sent += MB;
        c.enqueue(new Uint8Array(MB));
      },
    });
    const res = await handle(new Request("http://localhost:3000/v1/imports", { method: "POST", headers: { host: "localhost:3000", authorization: `Bearer ${token}`, "content-type": "multipart/form-data; boundary=x" }, body: stream, duplex: "half" } as RequestInit));
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(10 * MB);
  });

  it("records the browser's claimed MIME type but decides by content", async () => {
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(csvOf([row()]))], "m.csv", { type: "application/x-msdownload" }));
    const res = await post(fd);
    expect(res.status).toBe(201);
    const body = await res.json();
    const job = await db.query.importJobs.findFirst({ where: eq(schema.importJobs.id, body.job.id) });
    expect(job).toMatchObject({ clientMime: "application/x-msdownload", detectedType: "text/csv; charset=utf-8" });
  });
});

describe("malware scanning", () => {
  it("rejects infected files, records the rejection without content, and stores nothing", async () => {
    setUploadScannerForTests(async () => ({ status: "INFECTED", signature: "Eicar-Test-Signature", engine: "test" }));
    const before = await db.$count(schema.importJobs, eq(schema.importJobs.hmoOrgId, w.hmo.org.id));
    await expect(previewImport(w.hmo.admin, { fileName: "m.csv", data: csvOf([row()]) })).rejects.toThrow(/malware scanner/);
    expect(await db.$count(schema.importJobs, eq(schema.importJobs.hmoOrgId, w.hmo.org.id))).toBe(before);
    const ev = await db.query.auditEvents.findFirst({ where: and(eq(schema.auditEvents.orgId, w.hmo.org.id), eq(schema.auditEvents.action, "import.rejected")), orderBy: (t, { desc }) => [desc(t.id)] });
    expect(ev?.metadata).toMatchObject({ stage: "malware-scan" });
    expect(JSON.stringify(ev?.metadata)).not.toMatch(/Ngozi|\+234/);
  });

  it("fails closed when scanning is required but unavailable", async () => {
    process.env.UPLOAD_SCAN_REQUIRED = "true";
    resetConfigCache();
    try {
      await expect(previewImport(w.hmo.admin, { fileName: "m.csv", data: csvOf([row()]) })).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    } finally {
      delete process.env.UPLOAD_SCAN_REQUIRED;
      resetConfigCache();
    }
  });

  it("records NOT_SCANNED when scanning is off, and CLEAN when a scanner passes the file", async () => {
    const off = await previewImport(w.hmo.admin, { fileName: "m.csv", data: csvOf([row()]) });
    expect(off.job.scanStatus).toBe("NOT_SCANNED");
    setUploadScannerForTests(async () => ({ status: "CLEAN", engine: "test" }));
    const on = await previewImport(w.hmo.admin, { fileName: "m.csv", data: csvOf([row()]) });
    expect(on.job.scanStatus).toBe("CLEAN");
  });

  it("speaks the clamd INSTREAM protocol (against a local stand-in for clamd)", async () => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length >= 14 && buf.subarray(buf.length - 4).readUInt32BE(0) === 0) {
          const payload = buf.subarray(10).toString("latin1");
          sock.end(payload.includes("EICAR") ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;
    try {
      expect(await clamdScan(Buffer.from("member_number\n1"), "127.0.0.1", port)).toMatchObject({ status: "CLEAN" });
      expect(await clamdScan(Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"), "127.0.0.1", port)).toMatchObject({ status: "INFECTED", signature: "Eicar-Test-Signature" });
    } finally {
      server.close();
    }
    expect(await clamdScan(Buffer.from("x"), "127.0.0.1", 1, 500)).toMatchObject({ status: "ERROR" });
  });
});

describe("reports never become spreadsheet formulas and never leak other data", () => {
  it("escapes formula-like values in exported CSVs", () => {
    const out = errorsToCsv([{ row: 2, field: "plan_code", code: "UNKNOWN_PLAN", message: '=HYPERLINK("http://evil","x")' }, { row: 3, field: "x", code: "Y", message: "+1-2" }, { row: 4, field: "x", code: "Y", message: "@SUM(A1)" }]);
    expect(out).toContain(`"'=HYPERLINK(""http://evil"",""x"")"`);
    expect(out).toContain(`"'+1-2"`);
    expect(out).toContain(`"'@SUM(A1)"`);
  });

  it("an unknown plan code shaped like a formula is reported safely", async () => {
    const p = await previewImport(w.hmo.admin, { fileName: "m.csv", data: csvOf([{ ...row(), plan_code: "=cmd|' /C calc'!A0" }]) });
    const csv = await importReportCsv(w.hmo.admin, p.job.id);
    expect(csv).not.toMatch(/,"=/);
  });

  it("the import report and job record contain no phone numbers", async () => {
    const r = row();
    const p = await previewImport(w.hmo.admin, { fileName: "m.csv", data: csvOf([r, { ...r, member_number: `${r.member_number}-B` }]) });
    const csv = await importReportCsv(w.hmo.admin, p.job.id);
    const job = await db.query.importJobs.findFirst({ where: eq(schema.importJobs.id, p.job.id) });
    const digits = r.phone.slice(1);
    expect(csv).not.toContain(digits);
    expect(JSON.stringify(job)).not.toContain(digits);
    const staged = await db.select().from(schema.importRows).where(eq(schema.importRows.importJobId, p.job.id));
    expect(staged.length).toBe(2);
    for (const s of staged) expect(s.payloadEnc).not.toContain(digits);
  });
});
