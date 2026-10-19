/**
 * Malware scanning for uploads.
 *
 * UPLOAD_SCAN_MODE=clamav streams the bytes to a ClamAV daemon (clamd INSTREAM over TCP) before the
 * file is parsed. UPLOAD_SCAN_MODE=off (default in development) records NOT_SCANNED.
 * UPLOAD_SCAN_REQUIRED=true makes NOT_SCANNED or a scanner failure reject the upload (fail closed);
 * that is the recommended production setting once a clamd sidecar is deployed.
 */
import net from "node:net";
import { config } from "../config";
import { AppError } from "../errors";

export type ScanResult = { status: "CLEAN" | "NOT_SCANNED" | "INFECTED" | "ERROR"; signature?: string; engine: string };

const CHUNK = 64 * 1024;
const TIMEOUT_MS = 15_000;

/** clamd INSTREAM: "zINSTREAM\0", then <uint32 BE length><bytes> chunks, then a zero-length chunk. */
export function clamdScan(data: Buffer, host: string, port: number, timeoutMs = TIMEOUT_MS): Promise<ScanResult> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    let reply = "";
    let done = false;
    const finish = (r: ScanResult) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs, () => finish({ status: "ERROR", engine: "clamav", signature: "timeout" }));
    sock.on("error", () => finish({ status: "ERROR", engine: "clamav", signature: "unreachable" }));
    sock.on("data", (d) => {
      reply += d.toString("utf8");
      if (reply.includes("\0") || reply.includes("\n")) {
        const line = reply.replace(/[\0\n]/g, "").trim();
        if (/: OK$/.test(line)) finish({ status: "CLEAN", engine: "clamav" });
        else if (/ FOUND$/.test(line)) finish({ status: "INFECTED", engine: "clamav", signature: line.replace(/^stream: /, "").replace(/ FOUND$/, "").slice(0, 120) });
        else finish({ status: "ERROR", engine: "clamav", signature: line.slice(0, 120) });
      }
    });
    sock.on("connect", () => {
      sock.write("zINSTREAM\0");
      for (let i = 0; i < data.length; i += CHUNK) {
        const part = data.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length);
        sock.write(len);
        sock.write(part);
      }
      sock.write(Buffer.alloc(4));
    });
  });
}

let override: ((data: Buffer) => Promise<ScanResult>) | null = null;
export function setUploadScannerForTests(fn: typeof override) {
  override = fn;
}

/** Scans and enforces the policy. Returns the status to record; throws when the upload must be refused. */
export async function scanUploadOrReject(data: Buffer): Promise<ScanResult> {
  const c = config();
  const result = override
    ? await override(data)
    : c.UPLOAD_SCAN_MODE === "clamav"
      ? await clamdScan(data, c.CLAMAV_HOST, c.CLAMAV_PORT)
      : { status: "NOT_SCANNED" as const, engine: "none" };
  if (result.status === "INFECTED") {
    throw new AppError("VALIDATION_FAILED", "The file was rejected by the malware scanner and was not processed", { details: { stage: "malware-scan" } });
  }
  if (result.status !== "CLEAN" && c.UPLOAD_SCAN_REQUIRED === "true") {
    throw new AppError("UPSTREAM_UNAVAILABLE", "Uploads can't be checked for malware right now; try again later", { retryable: true, details: { stage: "malware-scan" } });
  }
  return result;
}
