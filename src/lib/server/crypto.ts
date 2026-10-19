import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { config } from "./config";

export const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** Keyed hash used for lookup tokens (session tokens, QR credentials, phone equality). */
export function hmacHex(purpose: string, value: string): string {
  return createHmac("sha256", config().APP_HMAC_SECRET).update(`${purpose}\u0000${value}`).digest("hex");
}

export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** URL-safe random token with `bytes` bytes of entropy. */
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

/** Unambiguous alphabet (no 0/O/1/I/L) for human-entered references. */
const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function randomRef(prefix: string, length = 8): string {
  let s = "";
  for (let i = 0; i < length; i++) s += REF_ALPHABET[randomInt(REF_ALPHABET.length)];
  return `${prefix}-${s}`;
}

/** Cryptographically secure numeric OTP. */
export function generateOtp(digits = 6): string {
  let s = "";
  for (let i = 0; i < digits; i++) s += String(randomInt(10));
  return s;
}

// ---------- Field-level encryption (AES-256-GCM) ----------
function key(): Buffer {
  return Buffer.from(config().FIELD_ENCRYPTION_KEY, "base64");
}

export function encryptField(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${enc.toString("base64url")}`;
}

export function decryptField(payload: string): string {
  const [v, iv, tag, data] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("Unsupported ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
}

// ---------- Phone numbers ----------
/** Normalise Nigerian / E.164 numbers to +234XXXXXXXXXX. Returns null if not plausible. */
/**
 * Normalises a phone number to E.164 (e.g. "0803 123 4567" → "+2348031234567") using libphonenumber
 * metadata, with Nigeria as the default country. Accepts spaces, dashes, dots, brackets, a leading
 * "+", "00" international prefix or "234" without "+". Returns null for anything that is not a valid
 * number for its country (wrong length, unknown range, letters); Nigerian numbers must be 10-digit
 * mobile numbers. The same function is used for
 * uploads, webhooks and member sign-in, so equality checks compare like with like.
 */
export function normalizePhone(raw: string, defaultCountry: CountryCode = "NG"): string | null {
  const s = raw.trim();
  if (!s || s.length > 32 || !/^[+\d\s().-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  let candidate = s;
  if (s.startsWith("00")) candidate = `+${digits.slice(2)}`;
  else if (!s.startsWith("+") && digits.startsWith("234") && digits.length === 13) candidate = `+${digits}`;
  const parsed = parsePhoneNumberFromString(candidate, defaultCountry);
  if (!parsed || !parsed.isValid()) return null;
  // Nigeria: codes go by SMS, so only the 10-digit mobile format (070…, 080…, 081…, 090…, 091…) is accepted.
  if (parsed.countryCallingCode === "234" && !/^[789]\d{9}$/.test(parsed.nationalNumber)) return null;
  return parsed.number;
}

export const phoneHash = (e164: string) => hmacHex("phone", e164);
