/**
 * Protected storage of the PostgreSQL connection settings (`config.json` in the per-user data folder).
 *
 * Pure (Node fs/path/url only): the encryption is injected, so it is unit tested with a fake cipher; in the application the
 * cipher is Electron `safeStorage`, which on Windows is DPAPI (the blob can only be decrypted by the same Windows user on the
 * same machine). Nothing here prints a secret, and nothing here ever writes a password in clear text.
 *
 * File formats:
 *   v2 (written by the app):  { "version": 2, "host", "port", "database", "user", "passwordEncrypted": "<base64 DPAPI blob>" }
 *        host/port/database/user are not secrets (support needs to see them); only the password is encrypted.
 *   legacy (read for compatibility): { "databaseUrl": "<a postgresql connection string that includes the password>" } (plain text).
 *        It is upgraded in place to v2 as soon as encryption is available, after verifying that the new file decrypts to the
 *        very same password. No backup copy is made (that would be a new plain-text copy of the secret).
 *
 * This protects the stored secret against copying the file or the profile folder; it does not replace least privilege in
 * PostgreSQL: use a runtime role with minimum rights (docs/OPERATIONS.md) so that a stolen credential can do little.
 */
import fs from "node:fs";
import path from "node:path";

export interface Cipher {
  /** false when the operating system offers no usable protected storage */
  available(): boolean;
  /** plain text -> base64 text of the protected blob (throws when unavailable) */
  encrypt(plain: string): string;
  /** inverse of encrypt (throws when the blob cannot be decrypted by this user/machine) */
  decrypt(blob: string): string;
}

export type ConnectionParts = { host: string; port: number; database: string; user: string };
export type ConfigFile =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "legacy"; url: string }
  | { kind: "v2"; parts: ConnectionParts; passwordEncrypted: string | null };

const HOST_RE = /^[A-Za-z0-9.\-[\]:]{1,253}$/;
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_$.\-@]{0,127}$/;

export function validParts(p: unknown): p is ConnectionParts {
  if (typeof p !== "object" || p === null) return false;
  const o = p as Record<string, unknown>;
  return (
    typeof o.host === "string" && HOST_RE.test(o.host) &&
    typeof o.port === "number" && Number.isInteger(o.port) && o.port >= 1 && o.port <= 65535 &&
    typeof o.database === "string" && NAME_RE.test(o.database) &&
    typeof o.user === "string" && NAME_RE.test(o.user)
  );
}

/** Builds the connection string. The password is percent-encoded; the result is a secret and must never be logged. */
export function buildUrl(parts: ConnectionParts, password: string | null): string {
  const u = new URL("postgresql://placeholder");
  u.hostname = parts.host.replace(/^\[|\]$/g, "");
  u.port = String(parts.port);
  // the URL setters leave a literal % alone: encode first, so a password containing %, @, :, / or # survives the round trip
  u.username = encodeURIComponent(parts.user);
  if (password) u.password = encodeURIComponent(password);
  u.pathname = "/" + parts.database;
  return u.toString();
}

export function partsFromUrl(raw: string): { parts: ConnectionParts; password: string | null } | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
    const parts = {
      host: u.hostname || "",
      port: u.port ? Number(u.port) : 5432,
      database: decodeURIComponent(u.pathname.replace(/^\//, "")),
      user: decodeURIComponent(u.username),
    };
    if (!validParts(parts)) return null;
    return { parts, password: u.password ? decodeURIComponent(u.password) : null };
  } catch {
    return null;
  }
}

export function readConfigFile(file: string, read: (f: string) => string | null = defaultRead): ConfigFile {
  let text: string | null;
  try {
    text = read(file);
  } catch {
    return { kind: "invalid", reason: "No se pudo leer la configuración de la base de datos" };
  }
  if (text === null) return { kind: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: `${file} no es un JSON válido` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "invalid", reason: `${file} no tiene el formato esperado` };
  const o = parsed as Record<string, unknown>;
  if (o.version === 2) {
    const raw: unknown = o;
    if (!validParts(raw)) return { kind: "invalid", reason: `${file} tiene datos de conexión no válidos` };
    const enc = o.passwordEncrypted;
    if (enc !== undefined && enc !== null && (typeof enc !== "string" || !/^[A-Za-z0-9+/=]+$/.test(enc))) {
      return { kind: "invalid", reason: `${file} tiene una contraseña protegida no válida` };
    }
    return { kind: "v2", parts: { host: raw.host, port: raw.port, database: raw.database, user: raw.user }, passwordEncrypted: typeof enc === "string" ? enc : null };
  }
  if (typeof o.databaseUrl === "string") return { kind: "legacy", url: o.databaseUrl.trim() };
  return { kind: "invalid", reason: `${file} no contiene la conexión` };
}

function defaultRead(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export type WriteResult = { ok: true } | { ok: false; code: "NO_ENCRYPTION" | "WRITE_FAILED" | "VERIFY_FAILED"; message: string };

/**
 * Writes a v2 file atomically: temp file -> read back -> decrypt -> compare -> rename. The password is only ever written
 * encrypted; with no encryption available NOTHING is written (safe failure, never a plain-text fallback).
 */
export function writeConfigV2(file: string, parts: ConnectionParts, password: string | null, cipher: Cipher): WriteResult {
  if (!validParts(parts)) return { ok: false, code: "WRITE_FAILED", message: "Datos de conexión no válidos" };
  let passwordEncrypted: string | undefined;
  if (password) {
    if (!cipher.available()) {
      return { ok: false, code: "NO_ENCRYPTION", message: "Windows no ofrece almacenamiento protegido para esta cuenta: la contraseña no se guarda en texto plano" };
    }
    try {
      passwordEncrypted = cipher.encrypt(password);
    } catch {
      return { ok: false, code: "NO_ENCRYPTION", message: "No se pudo proteger la contraseña con Windows: no se guardó nada" };
    }
  }
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = { version: 2, host: parts.host, port: parts.port, database: parts.database, user: parts.user, ...(passwordEncrypted ? { passwordEncrypted } : {}) };
    fs.writeFileSync(tmp, JSON.stringify(body, null, 2), { encoding: "utf8", mode: 0o600 });
    // verify what is on disk before it replaces anything
    const back = readConfigFile(tmp);
    if (back.kind !== "v2" || (back.passwordEncrypted ?? null) !== (passwordEncrypted ?? null)) throw new Error("verify");
    if (passwordEncrypted && cipher.decrypt(passwordEncrypted) !== password) throw new Error("verify");
    fs.renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean */
    }
    return (e as Error).message === "verify"
      ? { ok: false, code: "VERIFY_FAILED", message: "No se pudo verificar la configuración protegida: no se cambió nada" }
      : { ok: false, code: "WRITE_FAILED", message: "No se pudo escribir la configuración en la carpeta de datos del usuario" };
  }
}

export type UpgradeResult =
  | { status: "not-legacy" }
  | { status: "upgraded" }
  | { status: "kept-plaintext"; reason: "NO_ENCRYPTION" | "FAILED" };

/**
 * Replaces a legacy plain-text config.json by the protected format, keeping the same connection. If anything goes wrong (no
 * encryption, unreadable URL, disk error) the legacy file is left exactly as it was: the configuration is never lost.
 */
export function upgradeLegacyConfig(file: string, cipher: Cipher, read: (f: string) => string | null = defaultRead): UpgradeResult {
  const cfg = readConfigFile(file, read);
  if (cfg.kind !== "legacy") return { status: "not-legacy" };
  const parsed = partsFromUrl(cfg.url);
  if (!parsed) return { status: "kept-plaintext", reason: "FAILED" };
  if (parsed.password && !cipher.available()) return { status: "kept-plaintext", reason: "NO_ENCRYPTION" };
  const r = writeConfigV2(file, parsed.parts, parsed.password, cipher);
  if (r.ok) return { status: "upgraded" };
  return { status: "kept-plaintext", reason: r.code === "NO_ENCRYPTION" ? "NO_ENCRYPTION" : "FAILED" };
}
