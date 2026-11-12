/**
 * Automatic product SKU. Pure (no DB, no Electron), unit tested.
 * The number comes from PostgreSQL's own sequence of products.id (see catalog-service.ts), never from MAX(id) + 1, so two
 * concurrent creations can never obtain the same value; this module only gives that number its printed shape.
 */
export const SKU_PREFIX = "EL-";
export const SKU_DIGITS = 6;

/** 1 -> "EL-000001". Ids beyond 999999 simply grow ("EL-1000000"); the column holds 64 characters. */
export function formatSku(id: number): string {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Identificador inválido para generar el SKU");
  return SKU_PREFIX + String(id).padStart(SKU_DIGITS, "0");
}
