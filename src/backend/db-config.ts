/**
 * Where the database connection string comes from. Pure (no Electron, no pg), unit tested.
 *
 *   1. DATABASE_URL in the process environment (always wins; what the tests and scripts use).
 *   2. Packaged app: `config.json` in the per-user data folder: {"databaseUrl": "postgresql://..."}.
 *      Development: `.env` in the working directory. A packaged app NEVER reads `.env` from its working directory.
 *
 * Nothing is baked into the package. The resolved URL must point at a loopback host unless the operator opts in with
 * POS_ALLOW_REMOTE_DB=1 (a LAN server). Failure reasons never contain the connection string or its password.
 */
import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

export const CONFIG_FILE_NAME = "config.json";
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export type DbConfig =
  | { ok: true; url: string; source: "environment" | "config-file" | "dotenv" }
  | { ok: false; reason: string };

export type ResolveOptions = {
  env: Record<string, string | undefined>;
  packaged: boolean;
  userDataDir: string;
  cwd: string;
  /** Returns the file text, or null when it does not exist. Injectable for tests. */
  readFile?: (file: string) => string | null;
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

  try {
    if (!url && o.packaged) {
      const file = path.join(o.userDataDir, CONFIG_FILE_NAME);
      const text = read(file);
      if (text !== null) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return { ok: false, reason: `${file} no es un JSON válido` };
        }
        const v = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).databaseUrl : undefined;
        if (typeof v === "string") {
          url = v.trim();
          source = "config-file";
        }
      }
    } else if (!url && !o.packaged) {
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
      reason: o.packaged
        ? `Falta la configuración de la base de datos: define DATABASE_URL en el entorno o crea ${path.join(o.userDataDir, CONFIG_FILE_NAME)}`
        : "Falta DATABASE_URL (variable de entorno o .env)",
    };
  }
  const invalid = validateDatabaseUrl(url, allowRemote);
  if (invalid) return { ok: false, reason: invalid };
  return { ok: true, url, source };
}
