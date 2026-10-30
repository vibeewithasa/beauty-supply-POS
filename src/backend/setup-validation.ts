/**
 * Input validation of the first-run setup window. Pure (no Electron, no pg), unit tested.
 * Everything that arrives from the setup page is untrusted: a fixed shape, strict formats, and the same "loopback only unless
 * the operator opted in" rule as the rest of the application. Error messages never include what was typed.
 */
import { BusinessError } from "./errors.ts";
import { validParts } from "./config-store.ts";
import type { ConnectionParts } from "./config-store.ts";
import { PIN_NEW_RE } from "./pin-hash.ts";

export type SetupConnection = { parts: ConnectionParts; password: string | null };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (code: string, message: string) => new BusinessError(code, message);

function onlyKeys(o: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw bad("CAMPO_NO_PERMITIDO", `Campo no permitido: ${k}`);
}

export function parseConnection(data: unknown, allowRemote: boolean): SetupConnection {
  if (!isObject(data)) throw bad("CONEXION_INVALIDA", "Datos de conexión inválidos");
  onlyKeys(data, ["host", "port", "database", "user", "password"]);
  const host = typeof data.host === "string" ? data.host.trim().replace(/^\[|\]$/g, "") : "";
  let port: number;
  if (data.port === undefined || data.port === null || data.port === "") port = 5432;
  else if (typeof data.port === "number") port = data.port;
  else if (typeof data.port === "string" && /^\d{1,5}$/.test(data.port.trim())) port = Number(data.port.trim());
  else throw bad("PUERTO_INVALIDO", "El puerto debe ser un número entre 1 y 65535");
  const database = typeof data.database === "string" ? data.database.trim() : "";
  const user = typeof data.user === "string" ? data.user.trim() : "";
  const password = data.password;
  if (password !== undefined && password !== null && (typeof password !== "string" || password.length > 200 || password.includes("\u0000"))) {
    throw bad("CLAVE_INVALIDA", "La contraseña no es válida");
  }
  const parts = { host, port, database, user };
  if (!host) throw bad("SERVIDOR_INVALIDO", "Indica el servidor (normalmente localhost)");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad("PUERTO_INVALIDO", "El puerto debe ser un número entre 1 y 65535");
  if (!database) throw bad("BASE_INVALIDA", "Indica el nombre de la base de datos");
  if (!user) throw bad("USUARIO_INVALIDO", "Indica el usuario de PostgreSQL");
  if (!validParts(parts)) throw bad("CONEXION_INVALIDA", "El servidor, la base de datos o el usuario tienen caracteres no permitidos");
  if (!allowRemote && !LOOPBACK.has(host)) {
    throw bad("SERVIDOR_NO_LOCAL", "El servidor debe ser local (localhost). Para una red local define POS_ALLOW_REMOTE_DB=1; nunca expongas PostgreSQL a internet");
  }
  return { parts, password: typeof password === "string" && password !== "" ? password : null };
}

export type FirstAdminInput = { connection: SetupConnection; name: string; pin: string };

export function parseFirstAdmin(data: unknown, allowRemote: boolean): FirstAdminInput {
  if (!isObject(data)) throw bad("ADMIN_INVALIDO", "Datos del administrador inválidos");
  onlyKeys(data, ["connection", "name", "pin"]);
  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (name.length < 1 || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) {
    throw bad("NOMBRE_INVALIDO", "El nombre es obligatorio (máximo 120 caracteres, sin caracteres de control)");
  }
  if (typeof data.pin !== "string" || !PIN_NEW_RE.test(data.pin)) throw bad("PIN_INVALIDO", "El PIN debe tener de 6 a 8 dígitos");
  return { connection: parseConnection(data.connection, allowRemote), name, pin: data.pin };
}

/** Maps a driver error to a safe, actionable Spanish message (never the driver's text, which can carry details). */
export function describeConnectionError(error: unknown, parts: ConnectionParts): { code: string; message: string } {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === "string" ? e.code : "";
  const text = String(e?.message ?? "");
  if (code === "ECONNREFUSED") return { code: "SIN_SERVIDOR", message: `No hay un servidor PostgreSQL escuchando en ${parts.host}:${parts.port}. Comprueba que el servicio esté iniciado y el puerto.` };
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return { code: "SERVIDOR_DESCONOCIDO", message: `No se encontró el servidor "${parts.host}".` };
  if (code === "28P01" || code === "28000") return { code: "ACCESO_DENEGADO", message: "Usuario o contraseña incorrectos." };
  if (code === "3D000") return { code: "SIN_BASE", message: `La base de datos "${parts.database}" no existe en ese servidor.` };
  if (code === "ETIMEDOUT" || /timeout|timed out/i.test(text)) return { code: "TIEMPO_AGOTADO", message: "PostgreSQL no respondió a tiempo." };
  if (code === "57P03") return { code: "INICIANDO", message: "PostgreSQL se está iniciando; espera unos segundos e inténtalo de nuevo." };
  return { code: "ERROR_CONEXION", message: `No se pudo conectar a PostgreSQL${code ? ` (código ${code})` : ""}.` };
}
