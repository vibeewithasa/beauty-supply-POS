/**
 * Where the database connection string comes from. Pure (no Electron, no pg), unit tested.
 *
 *   1. DATABASE_URL in the process environment (always wins; what the tests and scripts use).
 *   2. Packaged app: `config.json` in the per-user data folder, protected by Windows (see config-store.ts): the password is
 *      stored encrypted with safeStorage/DPAPI, bound to the Windows user. A legacy plain-text file
 *      {"databaseUrl": "postgresql://..."} is still read (and upgraded in place by the caller when encryption exists).
 *      Development: `.env` in the working directory. A packaged app NEVER reads `.env` from its working directory.
 *      (POS_USE_CONFIG_FILE=1 makes a DEVELOPMENT build use config.json instead of .env; it is ignored when packaged.)
 *
 * Nothing is baked into the package. The resolved URL must point at a loopback host unless the operator opts in with
 * POS_ALLOW_REMOTE_DB=1 (a LAN server). Failure reasons never contain the connection string or its password.
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";
import { buildUrl, readConfigFile } from "./config-store.ts";
import type { Cipher } from "./config-store.ts";

export const CONFIG_FILE_NAME = "config.json";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type DbConfig =
  | { ok: true; url: string; source: "environment" | "config-file" | "dotenv"; legacyPlaintext?: boolean }
  | { ok: false; reason: string; /** the problem is the stored file (setup can fix it), not an operator-managed variable */ fixableBySetup?: boolean };

export type ResolveOptions = {
  env: Record<string, string | undefined>;
  packaged: boolean;
  userDataDir: string;
  cwd: string;
  /** Returns the file text, or null when it does not exist. Injectable for tests. */
  readFile?: (file: string) => string | null;
  /** Protected storage for the password of config.json (Electron safeStorage in the app). */
  cipher?: Cipher;
};

function defaultRead(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** Returns an error text (without secrets) or null when the URL is acceptable. */
export function validateDatabaseUrl(raw: string, allowRemote: boolean): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "DATABASE_URL no es una URL válida";
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return "DATABASE_URL debe usar postgresql://";
  if (!u.hostname) return "DATABASE_URL no indica el servidor";
  if (u.pathname.length < 2) return "DATABASE_URL no indica la base de datos";
  if (!allowRemote && !LOOPBACK.has(u.hostname)) {
    return `El servidor "${u.hostname}" no es local; para una red local define POS_ALLOW_REMOTE_DB=1 (nunca expongas PostgreSQL a internet)`;
  }
  return null;
}

export function resolveDatabaseUrl(o: ResolveOptions): DbConfig {
  const read = o.readFile ?? defaultRead;
  const allowRemote = o.env.POS_ALLOW_REMOTE_DB === "1";
  let url = (o.env.DATABASE_URL ?? "").trim();
  let source: "environment" | "config-file" | "dotenv" = "environment";
  let legacyPlaintext = false;
  const useFile = o.packaged || o.env.POS_USE_CONFIG_FILE === "1";
  const file = path.join(o.userDataDir, CONFIG_FILE_NAME);

  try {
    if (!url && useFile) {
      const cfg = readConfigFile(file, read);
      if (cfg.kind === "invalid") return { ok: false, reason: cfg.reason, fixableBySetup: true };
      if (cfg.kind === "legacy") {
        url = cfg.url;
        source = "config-file";
        legacyPlaintext = true;
      } else if (cfg.kind === "v2") {
        let password: string | null = null;
        if (cfg.passwordEncrypted) {
          try {
            if (!o.cipher || !o.cipher.available()) throw new Error("unavailable");
            password = o.cipher.decrypt(cfg.passwordEncrypted);
          } catch {
            return {
              ok: false,
              fixableBySetup: true,
              reason: "La contraseña guardada no se puede descifrar con esta cuenta de Windows (otro usuario, otro equipo o cifrado no disponible): vuelve a configurar la conexión",
            };
          }
        }
        url = buildUrl(cfg.parts, password);
        source = "config-file";
      }
    } else if (!url && !useFile) {
      const text = read(path.join(o.cwd, ".env"));
      if (text !== null) {
        url = (dotenv.parse(text).DATABASE_URL ?? "").trim();
        source = "dotenv";
      }
    }
  } catch {
    return { ok: false, reason: "No se pudo leer la configuración de la base de datos" };
  }

  if (!url) {
    return {
      ok: false,
      fixableBySetup: useFile,
      reason: useFile
        ? "Falta la configuración de la base de datos: configura la conexión desde la ventana de configuración inicial (o define DATABASE_URL en el entorno)"
        : "Falta DATABASE_URL (variable de entorno o .env)",
    };
  }
  const invalid = validateDatabaseUrl(url, allowRemote);
  if (invalid) return { ok: false, reason: invalid, fixableBySetup: source === "config-file" };
  return { ok: true, url, source, ...(legacyPlaintext ? { legacyPlaintext: true } : {}) };
}
