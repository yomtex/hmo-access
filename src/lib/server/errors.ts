/**
 * Application errors carry a stable machine-readable code and an HTTP status.
 * Messages must be safe to show to API clients (no PII, no secrets, no internals).
 */
export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INVALID_STATE"
  | "RATE_LIMITED"
  | "IDEMPOTENCY_MISMATCH"
  | "ACCOUNT_LOCKED"
  | "CREDENTIAL_INVALID"
  | "OTP_INVALID"
  | "OTP_EXPIRED"
  | "OTP_LOCKED"
  | "OTP_COOLDOWN"
  | "SMS_UNAVAILABLE"
  | "NOT_ELIGIBLE"
  | "CHECK_IN_COOLDOWN"
  | "PAYLOAD_TOO_LARGE"
  | "UPSTREAM_UNAVAILABLE"
  | "CSRF_REJECTED"
  | "INTERNAL";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INVALID_STATE: 409,
  RATE_LIMITED: 429,
  IDEMPOTENCY_MISMATCH: 409,
  ACCOUNT_LOCKED: 423,
  CREDENTIAL_INVALID: 404,
  OTP_INVALID: 422,
  OTP_EXPIRED: 410,
  OTP_LOCKED: 423,
  OTP_COOLDOWN: 429,
  SMS_UNAVAILABLE: 503,
  NOT_ELIGIBLE: 422,
  CHECK_IN_COOLDOWN: 409,
  PAYLOAD_TOO_LARGE: 413,
  UPSTREAM_UNAVAILABLE: 503,
  CSRF_REJECTED: 403,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  /** Whether the client may retry the same request later. */
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: { details?: unknown; retryable?: boolean } = {}) {
    super(message);
    this.code = code;
    this.status = STATUS[code];
    this.details = opts.details;
    this.retryable = opts.retryable ?? ["RATE_LIMITED", "SMS_UNAVAILABLE", "UPSTREAM_UNAVAILABLE", "OTP_COOLDOWN"].includes(code);
  }
}

export const notFound = (what: string) => new AppError("NOT_FOUND", `${what} not found`);
export const forbidden = (msg = "You do not have permission to perform this action") => new AppError("FORBIDDEN", msg);
export const invalidState = (msg: string) => new AppError("INVALID_STATE", msg);

/** Postgres unique_violation */
export function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } };
  return err?.code === "23505" || err?.cause?.code === "23505";
}
