/** Helpers for server components and server actions (portal UI). */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { resolveSession, SESSION_COOKIE, type Actor } from "./auth/session";
import type { OrgTypeName } from "./auth/permissions";
import { AppError } from "./errors";

export async function currentActor(): Promise<Actor | null> {
  const jar = await cookies();
  return resolveSession(jar.get(SESSION_COOKIE)?.value);
}

export async function requireActor(...types: OrgTypeName[]): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  if (types.length && !types.includes(actor.orgType)) redirect(homeFor(actor));
  return actor;
}

export function homeFor(actor: Actor): string {
  if (actor.orgType === "HMO") return "/hmo";
  if (actor.orgType === "PROVIDER") return actor.roleKey === "PROVIDER_FRONT_DESK" ? "/reception" : "/provider";
  return "/platform";
}

export async function requestIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] ?? "unknown").trim();
}

/** Human-readable message for an error thrown by a service. */
export function errorMessage(e: unknown): string {
  if (e instanceof AppError) {
    const reasons = (e.details as { reasons?: { message: string }[] } | undefined)?.reasons;
    return reasons?.length ? `${e.message}: ${reasons.map((r) => r.message).join("; ")}` : e.message;
  }
  if (e instanceof ZodError) return e.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
  console.error(JSON.stringify({ level: "error", type: (e as Error)?.name }));
  return "Something went wrong. Try again.";
}

/**
 * Runs a mutation from a server action, then redirects back with a status message.
 * redirect() is called outside the try so Next's redirect signal is never swallowed.
 */
export async function runAction(path: string, fn: () => Promise<string | void>): Promise<never> {
  let target: string;
  try {
    const msg = await fn();
    target = `${path}${path.includes("?") ? "&" : "?"}ok=${encodeURIComponent(msg || "Saved")}`;
  } catch (e) {
    target = `${path}${path.includes("?") ? "&" : "?"}err=${encodeURIComponent(errorMessage(e))}`;
  }
  redirect(target);
}

export const str = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
export const num = (fd: FormData, k: string) => Number(str(fd, k));
/** Parses a naira amount like "2,000.50" into kobo. */
export function nairaToMinor(v: string): number {
  const n = Number(v.replace(/[,\s₦]/g, ""));
  if (!Number.isFinite(n) || n < 0) throw new AppError("VALIDATION_FAILED", "Enter a valid amount");
  return Math.round(n * 100);
}
