/**
 * Input validation for sales and cash operations. Pure functions (no DB, no Electron):
 * everything coming from the renderer is untrusted. Unit tested in e2e/unit.
 */
import { BusinessError } from "./errors.ts";
import { toCents } from "./money.ts";

export const MAX_ITEMS = 200;
export const MAX_QUANTITY = 100_000;
export const MAX_REASON = 500;

export type SaleItemInput = {
  productId: number;
  quantity: number;
  /** What the client displayed; the server recomputes and compares, it never trusts it. */
  unitPriceCents: number;
  subtotalCents: number;
};
export type SaleInput = {
  sessionId: number;
  paymentMethod: "cash" | "card";
  items: SaleItemInput[];
  totalCents: number;
  /** Optional key of one checkout attempt (retries and double submits return the same sale). */
  operationId: string | null;
};
const OPERATION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export type CashMovementInput = {
  sessionId: number;
  type: "IN" | "OUT";
  amountCents: number;
  reason: string;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function parseId(value: unknown, code: string, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BusinessError(code, `${label} inválido`);
  }
  return value;
}

export function parseReason(value: unknown): string {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < 1 || reason.length > MAX_REASON) {
    throw new BusinessError("MOTIVO_INVALIDO", `El motivo es obligatorio (máximo ${MAX_REASON} caracteres)`);
  }
  return reason;
}

export function parseSaleInput(data: unknown): SaleInput {
  if (!isObject(data)) throw new BusinessError("VENTA_INVALIDA", "Datos de venta inválidos");
  const paymentMethod = data.paymentMethod;
  if (paymentMethod !== "cash" && paymentMethod !== "card") {
    throw new BusinessError("PAGO_INVALIDO", "Método de pago inválido");
  }
  if (data.sessionId === null || data.sessionId === undefined) {
    throw new BusinessError("CAJA_REQUERIDA", "La venta requiere una caja abierta");
  }
  const sessionId = parseId(data.sessionId, "CAJA_INVALIDA", "La sesión de caja");
  const raw = data.items;
  if (!Array.isArray(raw) || raw.length < 1) {
    throw new BusinessError("VENTA_SIN_ITEMS", "La venta debe incluir al menos un producto");
  }
  if (raw.length > MAX_ITEMS) throw new BusinessError("VENTA_INVALIDA", `Máximo ${MAX_ITEMS} productos por venta`);

  const seen = new Set<number>();
  const items: SaleItemInput[] = raw.map((it) => {
    if (!isObject(it)) throw new BusinessError("VENTA_INVALIDA", "Producto inválido en la venta");
    const productId = parseId(it.productId, "PRODUCTO_INVALIDO", "El producto");
    if (seen.has(productId)) {
      throw new BusinessError("ITEM_DUPLICADO", "El mismo producto aparece más de una vez; agrupa las cantidades");
    }
    seen.add(productId);
    const q = it.quantity;
    if (typeof q !== "number" || !Number.isSafeInteger(q) || q < 1 || q > MAX_QUANTITY) {
      throw new BusinessError("CANTIDAD_INVALIDA", `La cantidad debe ser un entero entre 1 y ${MAX_QUANTITY}`);
    }
    return {
      productId,
      quantity: q,
      unitPriceCents: toCents(it.unitPrice, "precio unitario"),
      subtotalCents: toCents(it.subtotal, "subtotal"),
    };
  });
  let operationId: string | null = null;
  if (data.operationId !== undefined && data.operationId !== null) {
    if (typeof data.operationId !== "string" || !OPERATION_ID_RE.test(data.operationId)) {
      throw new BusinessError("OPERACION_INVALIDA", "Identificador de operación inválido");
    }
    operationId = data.operationId;
  }
  return { sessionId, paymentMethod, items, totalCents: toCents(data.total, "total"), operationId };
}

export function parseCashMovement(data: unknown): CashMovementInput {
  if (!isObject(data)) throw new BusinessError("MOVIMIENTO_INVALIDO", "Datos de movimiento inválidos");
  if (data.type !== "IN" && data.type !== "OUT") {
    throw new BusinessError("TIPO_INVALIDO", "El tipo de movimiento debe ser IN u OUT");
  }
  return {
    sessionId: parseId(data.sessionId, "CAJA_INVALIDA", "La sesión de caja"),
    type: data.type,
    amountCents: toCents(data.amount, "monto", { allowZero: false }),
    reason: parseReason(data.reason),
  };
}
