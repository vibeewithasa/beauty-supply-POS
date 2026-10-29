/**
 * Input validation for user management. Pure (no DB, no Electron), unit tested.
 * Everything from the renderer is untrusted: only name, role and pin exist in the contract.
 */
import { BusinessError } from "./errors.ts";
import { parseId } from "./validation.ts";

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const PIN_RE = /^\d{4}$/;

export type Role = "admin" | "vendor";
export type UserCreateInput = { name: string; role: Role; pin: string };
export type UserUpdateInput = { name: string; role: Role; pin: string | null };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(data: Record<string, unknown>, allowed: string[]) {
  for (const k of Object.keys(data)) {
    if (!allowed.includes(k)) throw new BusinessError("CAMPO_NO_PERMITIDO", `Campo no permitido: ${k}`);
  }
}

function name(v: unknown): string {
  const n = typeof v === "string" ? v.trim() : "";
  if (n.length < 1 || n.length > 120 || CONTROL_CHARS.test(n)) {
    throw new BusinessError("NOMBRE_INVALIDO", "El nombre es obligatorio (máximo 120 caracteres, sin caracteres de control)");
  }
  return n;
}

function role(v: unknown): Role {
  if (v !== "admin" && v !== "vendor") throw new BusinessError("ROL_INVALIDO", "Rol inválido (admin o vendor)");
  return v;
}

function pin(v: unknown): string {
  if (typeof v !== "string" || !PIN_RE.test(v)) throw new BusinessError("PIN_INVALIDO", "El PIN debe tener exactamente 4 dígitos");
  return v;
}

export const parseUserId = (v: unknown) => parseId(v, "USUARIO_INVALIDO", "El usuario");

export function parseUserCreate(data: unknown): UserCreateInput {
  if (!isObject(data)) throw new BusinessError("USUARIO_INVALIDO", "Datos de usuario inválidos");
  onlyKeys(data, ["name", "role", "pin"]);
  return { name: name(data.name), role: role(data.role), pin: pin(data.pin) };
}

/** pin is optional on update: undefined / null / "" keep the current one. */
export function parseUserUpdate(data: unknown): UserUpdateInput {
  if (!isObject(data)) throw new BusinessError("USUARIO_INVALIDO", "Datos de usuario inválidos");
  onlyKeys(data, ["name", "role", "pin"]);
  const hasPin = data.pin !== undefined && data.pin !== null && data.pin !== "";
  return { name: name(data.name), role: role(data.role), pin: hasPin ? pin(data.pin) : null };
}
