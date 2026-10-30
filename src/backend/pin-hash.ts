/**
 * PIN hashing and verification (pure: Node crypto only, no Electron, no DB).
 *
 * Format of a stored hash:  scrypt$<N>$<r>$<p>$<salt base64url>$<key base64url>
 *  - algorithm: scrypt (Node's built-in crypto.scrypt, asynchronous: the event loop is not blocked)
 *  - parameters: N=2^14, r=8, p=1, 32-byte key, 16-byte random salt PER USER (~16 MiB, ~40 ms on a desktop).
 *    The cost is deliberately moderate: login has to verify against every active user (the PIN is the only
 *    identifier), and the PIN space itself (4-8 digits) is small, so the real defence is the global login
 *    limiter plus not leaking the database. The parameters are stored in each hash, so they can be raised later
 *    and old hashes still verify (needsUpgrade() reports them).
 *  - comparison: crypto.timingSafeEqual.
 *
 * Legacy format: 64 hex chars = unsalted SHA-256 of the PIN. It is still VERIFIED (so existing accounts keep
 * working) but never written: after a successful login the caller upgrades it to scrypt.
 * Nothing here logs or returns a PIN, salt or hash except hashPin() returning the new stored value.
 */
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLen: 32, saltLen: 16 } as const;
const MAX_MEM = 64 * 1024 * 1024;

/** New PINs (create / change): 6 to 8 digits (provisional minimum). */
export const PIN_NEW_RE = /^\d{6,8}$/;
/** PINs accepted at the login keypad: legacy 4-digit PINs still work until their owners change them. */
export const PIN_LOGIN_RE = /^\d{4,8}$/;
/** Legacy 4-digit PINs. */
export const PIN_LEGACY_RE = /^\d{4}$/;

const LEGACY_RE = /^[0-9a-f]{64}$/;

export const isLegacyHash = (stored: string): boolean => LEGACY_RE.test(stored);
export const isScryptHash = (stored: string): boolean => stored.startsWith("scrypt$");

function derive(pin: string, salt: Buffer, N: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(pin, salt, keyLen, { N, r, p, maxmem: MAX_MEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPin(pin: string): Promise<string> {
  const { N, r, p, keyLen, saltLen } = SCRYPT_PARAMS;
  const salt = randomBytes(saltLen);
  const key = await derive(pin, salt, N, r, p, keyLen);
  return ["scrypt", N, r, p, salt.toString("base64url"), key.toString("base64url")].join("$");
}

type Parsed = { N: number; r: number; p: number; salt: Buffer; key: Buffer };

function parseScrypt(stored: string): Parsed | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // bounds protect against a tampered row asking for absurd memory/time
  if (!Number.isInteger(N) || N < 1024 || N > 1 << 20 || (N & (N - 1)) !== 0) return null;
  if (!Number.isInteger(r) || r < 1 || r > 16 || !Number.isInteger(p) || p < 1 || p > 4) return null;
  const salt = Buffer.from(parts[4], "base64url");
  const key = Buffer.from(parts[5], "base64url");
  if (salt.length < 8 || key.length < 16 || key.length > 64) return null;
  return { N, r, p, salt, key };
}

export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  if (isLegacyHash(stored)) {
    const candidate = createHash("sha256").update(pin).digest();
    return timingSafeEqual(candidate, Buffer.from(stored, "hex"));
  }
  const parsed = parseScrypt(stored);
  if (!parsed) return false;
  const key = await derive(pin, parsed.salt, parsed.N, parsed.r, parsed.p, parsed.key.length);
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

/** True for legacy SHA-256 hashes and for scrypt hashes made with weaker parameters than the current ones. */
export function needsUpgrade(stored: string): boolean {
  if (isLegacyHash(stored)) return true;
  const parsed = parseScrypt(stored);
  if (!parsed) return false;
  return parsed.N < SCRYPT_PARAMS.N || parsed.r < SCRYPT_PARAMS.r || parsed.p < SCRYPT_PARAMS.p || parsed.key.length < SCRYPT_PARAMS.keyLen;
}
