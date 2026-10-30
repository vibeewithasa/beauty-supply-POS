/**
 * Input validation for authorized refunds. Pure (no DB, no Electron); everything from the renderer is untrusted.
 *
 * The renderer never sends an amount, a cash session, an administrator id or a status: the amount is computed in main from
 * the persisted sale lines, the register is the single open one, the administrator comes from the verified PIN, the
 * operator from the session. What it does send is the intent (what to return, how the money was handed back) plus an
 * explicit confirmation that the money has ALREADY been handed back, and the key of the attempt (idempotency).
 */
import { BusinessError } from "./errors.ts";
import { parseId } from "./validation.ts";
import { parseReturnInput } from "./returns-validation.ts";
import type { ReturnInput } from "./returns-validation.ts";

export type RefundMethod = "cash" | "card";
export type RefundPayment = { method: RefundMethod; reference: string | null };

const OPERATION_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const MAX_REFERENCE = 64;
// terminal slips: letters, digits and a few separators; nothing that could be markup or a control character
const REFERENCE_RE = /^[A-Za-z0-9][A-Za-z0-9 ._\-/#]{0,63}$/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseOperationId(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID_RE.test(value)) {
    throw new BusinessError("OPERACION_INVALIDA", "Identificador de operación inválido (8 a 64 caracteres: letras, números, _ o -)");
  }
  return value;
}

export function parsePayment(data: unknown): RefundPayment {
  if (!isObject(data)) throw new BusinessError("REEMBOLSO_INVALIDO", "Indica cómo se reembolsó el dinero");
  for (const key of Object.keys(data)) {
    if (!["method", "confirmed", "reference"].includes(key)) {
      throw new BusinessError("CAMPO_NO_PERMITIDO", `Campo no permitido en el pago: ${key}`);
    }
  }
  const method = data.method;
  if (method !== "cash" && method !== "card") {
    throw new BusinessError("METODO_INVALIDO", "El método del reembolso debe ser efectivo o tarjeta");
  }
  // The system must never mark a refund as paid unless somebody states that the money was already handed back.
  if (data.confirmed !== true) {
    throw new BusinessError(
      "CONFIRMACION_REQUERIDA",
      method === "cash"
        ? "Confirma que el efectivo ya fue entregado al cliente"
        : "Confirma que el reembolso ya fue realizado en la terminal de tarjeta"
    );
  }
  let reference: string | null = null;
  if (data.reference !== undefined && data.reference !== null && !(typeof data.reference === "string" && data.reference.trim() === "")) {
    if (method !== "card") throw new BusinessError("REFERENCIA_NO_APLICA", "La referencia solo aplica a reembolsos con tarjeta");
    if (typeof data.reference !== "string" || !REFERENCE_RE.test(data.reference.trim())) {
      throw new BusinessError("REFERENCIA_INVALIDA", `Referencia inválida (hasta ${MAX_REFERENCE} caracteres: letras, números y . _ - / #)`);
    }
    reference = data.reference.trim();
  }
  return { method, reference };
}

export type NewRefundInput = { sale: ReturnInput; payment: RefundPayment; operationId: string };

/** A new return AND its payment: { saleId, reason, items, payment, operationId }. */
export function parseNewRefundInput(data: unknown): NewRefundInput {
  if (!isObject(data)) throw new BusinessError("DEVOLUCION_INVALIDA", "Datos de devolución inválidos");
  const { payment, operationId, ...rest } = data;
  // parseReturnInput rejects unknown fields of the lines itself; top-level extras are rejected here
  for (const key of Object.keys(rest)) {
    if (!["saleId", "reason", "items"].includes(key)) throw new BusinessError("CAMPO_NO_PERMITIDO", `Campo no permitido: ${key}`);
  }
  return { sale: parseReturnInput(rest), payment: parsePayment(payment), operationId: parseOperationId(operationId) };
}

export type SettleInput = { returnId: number; payment: RefundPayment; operationId: string };

/** The payment of a return that already exists and is pending: { returnId, payment, operationId }. */
export function parseSettleInput(data: unknown): SettleInput {
  if (!isObject(data)) throw new BusinessError("REEMBOLSO_INVALIDO", "Datos de reembolso inválidos");
  for (const key of Object.keys(data)) {
    if (!["returnId", "payment", "operationId"].includes(key)) throw new BusinessError("CAMPO_NO_PERMITIDO", `Campo no permitido: ${key}`);
  }
  return {
    returnId: parseId(data.returnId, "DEVOLUCION_INVALIDA", "La devolución"),
    payment: parsePayment(data.payment),
    operationId: parseOperationId(data.operationId),
  };
}
