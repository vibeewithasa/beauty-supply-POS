/**
 * Exact money handling: everything is computed in integer cents (never floats).
 * PostgreSQL numeric(12,2) strings <-> integer cents. Dependency free (unit tested).
 */
import { BusinessError } from "./errors.ts";

/** numeric(12,2) maximum: 9,999,999,999.99 */
export const MAX_CENTS = 999_999_999_999;

/**
 * Parses an amount received from the renderer (number or "12.34" string) into integer cents.
 * Rejects NaN, Infinity, negatives, more than 2 decimals, and values above numeric(12,2).
 * `allowZero` only matters for amounts that must be strictly positive.
 */
export function toCents(value: unknown, field: string, { allowZero = true } = {}): number {
  let cents: number;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid(field);
    cents = Math.round(value * 100);
    // 0.1 * 3 = 0.30000000000000004 is fine; 0.001 is not a money amount
    if (Math.abs(value * 100 - cents) > 1e-6) throw invalid(field, "no puede tener más de 2 decimales");
  } else if (typeof value === "string") {
    const m = /^(\d{1,10})(?:\.(\d{1,2}))?$/.exec(value.trim());
    if (!m) throw invalid(field);
    cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  } else {
    throw invalid(field);
  }
  if (cents < 0 || cents > MAX_CENTS) throw invalid(field, "fuera de rango");
  if (!allowZero && cents === 0) throw invalid(field, "debe ser mayor que cero");
  return cents;
}

/** Reads a numeric(12,2) string coming from PostgreSQL ("65.00", "-4.50") into cents. */
export function centsFromDb(value: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!m) throw new Error("Importe inválido en la base de datos");
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0") || "0");
  return m[1] ? -cents : cents;
}

/** Integer cents -> "123.45" for numeric(12,2) columns. */
export function centsToDb(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error("Importe inválido");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

function invalid(field: string, why = "importe inválido") {
  return new BusinessError("IMPORTE_INVALIDO", `${field}: ${why}`);
}
