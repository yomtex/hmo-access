import { hash, verify } from "@node-rs/argon2";

// OWASP-recommended argon2id parameters (m=19 MiB, t=2, p=1).
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (password: string) => hash(password, OPTS);
export const verifyPassword = (hashed: string, password: string) => verify(hashed, password).catch(() => false);

/** Minimal strength policy: length and not entirely one character class. */
export function assertPasswordPolicy(pw: string): string | null {
  if (pw.length < 12) return "Password must be at least 12 characters";
  if (pw.length > 256) return "Password is too long";
  if (/^(.)\1+$/.test(pw)) return "Password is too weak";
  return null;
}
