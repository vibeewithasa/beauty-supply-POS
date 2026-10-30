/**
 * Date-range validation for reports. Pure (no DB, no Electron), unit tested.
 * Dates are calendar days "YYYY-MM-DD" in the machine's local time; the range is [from 00:00, to+1 00:00).
 */
import { BusinessError } from "./errors.ts";

export const MAX_REPORT_DAYS = 366;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type ReportRange = { from: string; to: string; start: Date; endExclusive: Date; days: number };

export function parseDay(value: unknown, label: string): { text: string; date: Date } {
  const m = typeof value === "string" ? DAY_RE.exec(value) : null;
  if (!m) throw new BusinessError("FECHA_INVALIDA", `${label}: usa el formato AAAA-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  // reject 2026-02-30 and friends: the Date constructor silently rolls them over
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d || y < 2000 || y > 2100) {
    throw new BusinessError("FECHA_INVALIDA", `${label}: no es una fecha válida`);
  }
  return { text: value as string, date };
}

export function parseReportRange(data: unknown): ReportRange {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new BusinessError("FECHA_INVALIDA", "Indica el rango de fechas");
  }
  const o = data as Record<string, unknown>;
  const from = parseDay(o.from, "Fecha inicial");
  const to = parseDay(o.to, "Fecha final");
  if (from.date.getTime() > to.date.getTime()) {
    throw new BusinessError("RANGO_INVALIDO", "La fecha inicial no puede ser posterior a la final");
  }
  const endExclusive = new Date(to.date.getFullYear(), to.date.getMonth(), to.date.getDate() + 1);
  const days = Math.round((endExclusive.getTime() - from.date.getTime()) / 86_400_000);
  if (days > MAX_REPORT_DAYS) {
    throw new BusinessError("RANGO_INVALIDO", `El rango máximo es de ${MAX_REPORT_DAYS} días`);
  }
  return { from: from.text, to: to.text, start: from.date, endExclusive, days };
}
