/**
 * Reference REST connector (generic JSON GET + field map).
 *
 * NOT certified with any HMO. It exists to (a) prove the connector contract end to end and
 * (b) enforce the fail-closed timeout behaviour. A real HMO adapter would subclass/replace the
 * mapping once that HMO's API documentation and sandbox credentials are available.
 *
 * integration_configs.config shape:
 *   { "baseUrl": "https://hmo.example/api", "memberPath": "/members/{memberNumber}",
 *     "timeoutMs": 3000, "realtimeLookup": true,
 *     "fieldMap": { "memberStatus": "status", "coverageEnd": "coverage.end" } }
 * integration_configs.secret_ref names an environment variable holding a bearer token.
 */
import { z } from "zod";
import type { LiveLookupResult, LiveMemberConnector } from "./types";

export const RestConnectorConfig = z.object({
  baseUrl: z.string().url().refine((u) => u.startsWith("https://") || process.env.NODE_ENV !== "production", "HTTPS required in production"),
  memberPath: z.string().startsWith("/").includes("{memberNumber}").default("/members/{memberNumber}"),
  timeoutMs: z.number().int().min(200).max(15_000).default(3000),
  realtimeLookup: z.boolean().default(false),
  fieldMap: z.object({ memberStatus: z.string().default("status") }).default({}),
});
export type RestConnectorConfig = z.infer<typeof RestConnectorConfig>;

function pick(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

export class RestMemberConnector implements LiveMemberConnector {
  readonly kind = "REST_API" as const;
  constructor(
    private readonly cfg: RestConnectorConfig,
    private readonly bearerToken: string | undefined,
  ) {}

  async lookupMember(memberNumber: string): Promise<LiveLookupResult> {
    const url = this.cfg.baseUrl.replace(/\/$/, "") + this.cfg.memberPath.replace("{memberNumber}", encodeURIComponent(memberNumber));
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}) },
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
        redirect: "error",
      });
      if (res.status === 404) return { ok: true, record: null };
      if (!res.ok) return { ok: false, reason: "UNAVAILABLE" };
      const body = await res.json().catch(() => undefined);
      if (!body || typeof body !== "object") return { ok: false, reason: "BAD_RESPONSE" };
      const raw = String(pick(body, this.cfg.fieldMap.memberStatus) ?? "").toUpperCase();
      const memberStatus = raw === "ACTIVE" ? "ACTIVE" : raw === "SUSPENDED" ? "SUSPENDED" : raw === "TERMINATED" || raw === "INACTIVE" ? "TERMINATED" : undefined;
      if (!memberStatus) return { ok: false, reason: "BAD_RESPONSE" };
      return { ok: true, record: { memberStatus } };
    } catch (e) {
      const name = (e as Error).name;
      return { ok: false, reason: name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "UNAVAILABLE" };
    }
  }
}
