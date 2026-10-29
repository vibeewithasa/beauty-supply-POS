/**
 * Input validation for returns. Pure (no DB, no Electron); everything from the renderer is untrusted.
 * Prices, products and sold quantities are NEVER taken from the client: productId/unitPrice may be sent
 * only as claims, used to detect tampering or stale screens.
 */
import { BusinessError } from "./errors.ts";
import { toCents } from "./money.ts";
import { MAX_ITEMS, MAX_QUANTITY, parseId, parseReason } from "./validation.ts";

export type ReturnItemInput = {
  saleItemId: number;
  quantity: number;
  claimedProductId: number | null;
  claimedUnitPriceCents: number | null;
};
export type ReturnInput = { saleId: number; reason: string; items: ReturnItemInput[] };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseReturnInput(data: unknown): ReturnInput {
  if (!isObject(data)) throw new BusinessError("DEVOLUCION_INVALIDA", "Datos de devolución inválidos");
  const saleId = parseId(data.saleId, "VENTA_INVALIDA", "La venta");
  const raw = data.items;
  if (!Array.isArray(raw) || raw.length < 1) {
    throw new BusinessError("DEVOLUCION_SIN_ITEMS", "La devolución debe incluir al menos un producto");
  }
  if (raw.length > MAX_ITEMS) throw new BusinessError("DEVOLUCION_INVALIDA", `Máximo ${MAX_ITEMS} líneas por devolución`);

  const seen = new Set<number>();
  const items = raw.map((it): ReturnItemInput => {
    if (!isObject(it)) throw new BusinessError("DEVOLUCION_INVALIDA", "Línea de devolución inválida");
    for (const key of Object.keys(it)) {
      if (!["saleItemId", "quantity", "productId", "unitPrice"].includes(key)) {
        throw new BusinessError("CAMPO_NO_PERMITIDO", `Campo no permitido en la línea: ${key}`);
      }
    }
    const saleItemId = parseId(it.saleItemId, "ITEM_INVALIDO", "La línea de venta");
    if (seen.has(saleItemId)) throw new BusinessError("ITEM_DUPLICADO", "La misma línea de venta aparece más de una vez");
    seen.add(saleItemId);
    const q = it.quantity;
    if (typeof q !== "number" || !Number.isSafeInteger(q) || q < 1 || q > MAX_QUANTITY) {
      throw new BusinessError("CANTIDAD_INVALIDA", `La cantidad debe ser un entero entre 1 y ${MAX_QUANTITY}`);
    }
    return {
      saleItemId,
      quantity: q,
      claimedProductId: it.productId === undefined || it.productId === null ? null : parseId(it.productId, "PRODUCTO_INVALIDO", "El producto"),
      claimedUnitPriceCents: it.unitPrice === undefined || it.unitPrice === null ? null : toCents(it.unitPrice, "precio unitario"),
    };
  });
  return { saleId, reason: parseReason(data.reason), items };
}
