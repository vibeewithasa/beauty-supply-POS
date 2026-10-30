/**
 * Validation of the sales-history query. Pure (no DB, no Electron), unit tested.
 * Everything comes from the renderer, so every field is checked here and the SQL only ever sees parsed values.
 */
import { BusinessError } from "./errors.ts";
import { parseDay } from "./reports-validation.ts";

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
const MAX_PAGE = 1_000_000;

export type SalesQuery = {
  page: number;
  pageSize: number;
  /** Receipt number (sale id) to look up, or null. */
  folio: number | null;
  start: Date | null;
  endExclusive: Date | null;
  method: "cash" | "card" | null;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const blank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

function intIn(value: unknown, min: number, max: number, code: string, label: string, fallback: number): number {
  if (blank(value)) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new BusinessError(code, `${label} inválido`);
  }
  return value;
}

export function parseSalesQuery(data: unknown): SalesQuery {
  const o = data === undefined || data === null ? {} : data;
  if (!isObject(o)) throw new BusinessError("CONSULTA_INVALIDA", "Consulta de ventas inválida");

  const page = intIn(o.page, 1, MAX_PAGE, "PAGINA_INVALIDA", "La página", 1);
  const pageSize = intIn(o.pageSize, 1, MAX_PAGE_SIZE, "PAGINA_INVALIDA", "El tamaño de página", DEFAULT_PAGE_SIZE);

  let folio: number | null = null;
  if (!blank(o.q)) {
    const m = typeof o.q === "string" ? /^#?\s*(\d{1,9})$/.exec(o.q.trim()) : null;
    if (!m) throw new BusinessError("BUSQUEDA_INVALIDA", "Busca por número de folio (solo dígitos)");
    folio = Number(m[1]);
    if (folio < 1) throw new BusinessError("BUSQUEDA_INVALIDA", "El folio debe ser mayor que cero");
  }

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

  let method: "cash" | "card" | null = null;
  if (!blank(o.method)) {
    if (o.method !== "cash" && o.method !== "card") throw new BusinessError("PAGO_INVALIDO", "Método de pago inválido");
    method = o.method;
  }
  return { page, pageSize, folio, start, endExclusive, method };
}
