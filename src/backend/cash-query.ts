/**
 * Validation of the cash-session history query. Pure (no DB, no Electron), unit tested.
 */
import { BusinessError } from "./errors.ts";
import { parseDay } from "./reports-validation.ts";

export const DEFAULT_SESSIONS_PAGE_SIZE = 20;
export const MAX_SESSIONS_PAGE_SIZE = 100;

export type CashSessionsQuery = {
  page: number;
  pageSize: number;
  start: Date | null;
  endExclusive: Date | null;
  status: "open" | "closed" | null;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

export function parseCashSessionsQuery(data: unknown): CashSessionsQuery {
  const o = data === undefined || data === null ? {} : data;
  if (!isObject(o)) throw new BusinessError("CONSULTA_INVALIDA", "Consulta de sesiones de caja inválida");
  const int = (v: unknown, min: number, max: number, label: string, fallback: number) => {
    if (blank(v)) return fallback;
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) throw new BusinessError("PAGINA_INVALIDA", `${label} inválido`);
    return v;
  };
  const page = int(o.page, 1, 1_000_000, "La página", 1);
  const pageSize = int(o.pageSize, 1, MAX_SESSIONS_PAGE_SIZE, "El tamaño de página", DEFAULT_SESSIONS_PAGE_SIZE);
  let start: Date | null = null;
  let endExclusive: Date | null = null;
  if (!blank(o.from)) start = parseDay(o.from, "Fecha inicial").date;
  if (!blank(o.to)) {
    const to = parseDay(o.to, "Fecha final").date;
    endExclusive = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
  }
  if (start && endExclusive && start.getTime() >= endExclusive.getTime()) {
    throw new BusinessError("RANGO_INVALIDO", "La fecha inicial no puede ser posterior a la final");
  }
  let status: "open" | "closed" | null = null;
  if (!blank(o.status)) {
    if (o.status !== "open" && o.status !== "closed") throw new BusinessError("ESTADO_INVALIDO", "Estado inválido (open o closed)");
    status = o.status;
  }
  return { page, pageSize, start, endExclusive, status };
}
