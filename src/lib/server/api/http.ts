/**
 * HTTP plumbing shared by the REST API: authentication (Bearer token or session cookie), CSRF
 * defence for cookie-authenticated writes, JSON parsing, and mapping errors to safe responses.
 */
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { resolveSession, SESSION_COOKIE, type Actor } from "../auth/session";
import { config } from "../config";
import { AppError } from "../errors";

export type ApiContext = {
  req: Request;
  url: URL;
  params: Record<string, string>;
  ip: string;
  actor: Actor | null;
  /** True when the caller authenticated with the browser session cookie (not a Bearer token). */
  viaCookie: boolean;
};

export function clientIp(req: Request): string {
  // Behind a trusted proxy/load balancer, the first X-Forwarded-For hop is the client.
  const xff = req.headers.get("x-forwarded-for");
  return (xff?.split(",")[0] ?? req.headers.get("x-real-ip") ?? "unknown").trim().slice(0, 64);
}

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return undefined;
}

export async function authenticate(req: Request): Promise<{ actor: Actor | null; viaCookie: boolean }> {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return { actor: await resolveSession(auth.slice(7).trim()), viaCookie: false };
  const cookie = readCookie(req, SESSION_COOKIE);
  if (cookie) return { actor: await resolveSession(cookie), viaCookie: true };
  return { actor: null, viaCookie: false };
}

/**
 * CSRF: browsers attach cookies automatically, so cookie-authenticated state changes must come from
 * our own origin. Bearer-token API clients are not affected. SameSite=Lax cookies add a second layer.
 */
export function assertSameOrigin(req: Request) {
  // Modern browsers send Sec-Fetch-Site, which page scripts cannot forge. Prefer it when present.
  const site = req.headers.get("sec-fetch-site");
  if (site) {
    if (site === "same-origin") return;
    throw new AppError("CSRF_REJECTED", "Cross-site request rejected");
  }
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (!origin || origin === "null" || !host) throw new AppError("CSRF_REJECTED", "Cross-site request rejected");
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new AppError("CSRF_REJECTED", "Cross-site request rejected");
  }
  if (originHost !== host) throw new AppError("CSRF_REJECTED", "Cross-site request rejected");
}

/** For unauthenticated endpoints: non-browser clients send no Origin; browsers always do on POST. */
export function assertSameOriginIfPresent(req: Request) {
  if (req.headers.get("origin") || req.headers.get("sec-fetch-site")) assertSameOrigin(req);
}

export async function jsonBody<T = unknown>(req: Request, maxBytes = 256 * 1024): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new AppError("VALIDATION_FAILED", "Request body too large");
  const text = await req.text();
  if (text.length > maxBytes) throw new AppError("VALIDATION_FAILED", "Request body too large");
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new AppError("VALIDATION_FAILED", "Body must be valid JSON");
  }
}

/** Reads a request body, refusing it as soon as it exceeds `maxBytes` (Content-Length or streamed). */
export async function readBodyCapped(req: Request, maxBytes: number): Promise<Buffer> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > maxBytes) throw new AppError("PAYLOAD_TOO_LARGE", `Upload exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new AppError("PAYLOAD_TOO_LARGE", `Upload exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v)), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(e: unknown): Response {
  if (e instanceof AppError) {
    const headers: Record<string, string> = {};
    const retryAfter = (e.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
    if (retryAfter) headers["retry-after"] = String(retryAfter);
    return json({ error: { code: e.code, message: e.message, retryable: e.retryable, details: e.details ?? null } }, e.status, headers);
  }
  if (e instanceof ZodError) {
    return json({ error: { code: "VALIDATION_FAILED", message: "Request validation failed", retryable: false, details: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } }, 422);
  }
  // Unexpected: log a correlation id and the error type only (no request data, which may contain PII).
  const id = randomUUID();
  const err = e as { name?: string; message?: string; code?: string };
  console.error(JSON.stringify({ level: "error", correlationId: id, type: err?.name, pgCode: err?.code, message: config().NODE_ENV === "production" ? undefined : err?.message }));
  return json({ error: { code: "INTERNAL", message: "Unexpected error", retryable: true, details: { correlationId: id } } }, 500);
}

export function sessionCookie(token: string, maxAgeSeconds: number, name = SESSION_COOKIE): string {
  const secure = config().NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}
export function clearCookie(name = SESSION_COOKIE): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
