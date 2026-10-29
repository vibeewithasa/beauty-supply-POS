/**
 * Input validation for the administrative catalog operations (products, inventory movements,
 * price changes). Pure functions (no DB, no Electron): everything from the renderer is untrusted.
 * Unit tested in e2e/unit.
 */
import { BusinessError } from "./errors.ts";
import { toCents } from "./money.ts";
import { parseId, parseReason } from "./validation.ts";

export const MAX_STOCK = 1_000_000;
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,63}$/;
const BARCODE_RE = /^[A-Za-z0-9._\-/]{1,128}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export type ProductStatusInput = "active" | "inactive";
export type ProductCreateInput = {
  sku: string;
  name: string;
  priceCents: number;
  stock: number;
  barcode: string | null;
  category: string | null;
  status: ProductStatusInput;
};
export type ProductUpdateInput = Partial<{
  sku: string;
  name: string;
  barcode: string | null;
  category: string | null;
  status: ProductStatusInput;
}>;
export type InventoryMovementInput = {
  productId: number;
  type: "IN" | "OUT" | "ADJUST";
  /** Signed stock delta, exactly as stored in the history (sales store OUT as negative). */
  amount: number;
  reason: string;
};
export type PriceChangeInput = {
  productId: number;
  newPriceCents: number;
  /** Only used to detect stale data; the recorded old price always comes from the database. */
  claimedOldPriceCents: number | null;
  reason: string | null;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function rejectUnknown(data: Record<string, unknown>, allowed: string[]) {
  for (const key of Object.keys(data)) {
    if (!allowed.includes(key)) throw new BusinessError("CAMPO_NO_PERMITIDO", `Campo no permitido: ${key}`);
  }
}

function text(value: unknown, field: string, max: number): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (v.length < 1 || v.length > max || CONTROL_CHARS.test(v)) {
    throw new BusinessError("CAMPO_INVALIDO", `${field}: obligatorio, máximo ${max} caracteres, sin caracteres de control`);
  }
  return v;
}

function optionalText(value: unknown, field: string, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  return text(value, field, max);
}

function sku(value: unknown): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!SKU_RE.test(v)) {
    throw new BusinessError("CAMPO_INVALIDO", "SKU: 1 a 64 caracteres (letras, números, . _ - /), debe empezar con letra o número");
  }
  return v;
}

function barcode(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const v = typeof value === "string" ? value.trim() : "";
  if (v === "") return null;
  if (!BARCODE_RE.test(v)) throw new BusinessError("CAMPO_INVALIDO", "Código de barras: máximo 128 caracteres (letras, números, . _ - /)");
  return v;
}

function status(value: unknown): ProductStatusInput {
  if (value === "deleted") {
    throw new BusinessError("OPERACION_INVALIDA", "Usa la eliminación lógica para eliminar productos");
  }
  if (value !== "active" && value !== "inactive") throw new BusinessError("ESTADO_INVALIDO", "Estado inválido (active o inactive)");
  return value;
}

export function parseStock(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_STOCK) {
    throw new BusinessError("STOCK_INVALIDO", `El stock debe ser un entero entre 0 y ${MAX_STOCK}`);
  }
  return value;
}

export function parseProductCreate(data: unknown): ProductCreateInput {
  if (!isObject(data)) throw new BusinessError("PRODUCTO_INVALIDO", "Datos de producto inválidos");
  rejectUnknown(data, ["sku", "name", "price", "stock", "barcode", "category", "status"]);
  return {
    sku: sku(data.sku),
    name: text(data.name, "Nombre", 255),
    priceCents: toCents(data.price, "precio"),
    stock: data.stock === undefined ? 0 : parseStock(data.stock),
    barcode: barcode(data.barcode),
    category: optionalText(data.category, "Categoría", 128),
    status: data.status === undefined ? "active" : status(data.status),
  };
}

export function parseProductUpdate(data: unknown): ProductUpdateInput {
  if (!isObject(data)) throw new BusinessError("PRODUCTO_INVALIDO", "Datos de producto inválidos");
  if ("stock" in data) {
    throw new BusinessError("STOCK_NO_MODIFICABLE", "El stock solo cambia mediante movimientos de inventario");
  }
  if ("price" in data) {
    throw new BusinessError("PRECIO_NO_MODIFICABLE", "El precio solo cambia mediante un cambio de precio registrado");
  }
  rejectUnknown(data, ["sku", "name", "barcode", "category", "status"]);
  const out: ProductUpdateInput = {};
  if ("sku" in data) out.sku = sku(data.sku);
  if ("name" in data) out.name = text(data.name, "Nombre", 255);
  if ("barcode" in data) out.barcode = barcode(data.barcode);
  if ("category" in data) out.category = optionalText(data.category, "Categoría", 128);
  if ("status" in data) out.status = status(data.status);
  if (Object.keys(out).length === 0) throw new BusinessError("UPDATE_VACIO", "No hay campos para actualizar");
  return out;
}

export function parseInventoryMovement(data: unknown): InventoryMovementInput {
  if (!isObject(data)) throw new BusinessError("MOVIMIENTO_INVALIDO", "Datos de movimiento inválidos");
  const productId = parseId(data.productId, "PRODUCTO_INVALIDO", "El producto");
  const type = data.type;
  if (type === "DELETE") {
    throw new BusinessError("TIPO_RESERVADO", "DELETE solo lo registra la eliminación lógica de productos");
  }
  if (type !== "IN" && type !== "OUT" && type !== "ADJUST") {
    throw new BusinessError("TIPO_INVALIDO", "El tipo de movimiento debe ser IN, OUT o ADJUST");
  }
  const amount = data.amount;
  if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount === 0 || Math.abs(amount) > MAX_STOCK) {
    throw new BusinessError("CANTIDAD_INVALIDA", `La cantidad debe ser un entero distinto de cero (máximo ${MAX_STOCK})`);
  }
  // amount is the signed delta stored in the history: IN adds, OUT subtracts, ADJUST is a signed difference.
  if (type === "IN" && amount < 0) throw new BusinessError("SIGNO_INVALIDO", "Una entrada (IN) debe ser positiva");
  if (type === "OUT" && amount > 0) throw new BusinessError("SIGNO_INVALIDO", "Una salida (OUT) debe ser negativa");
  return { productId, type, amount, reason: parseReason(data.reason) };
}

export function parsePriceChange(data: unknown): PriceChangeInput {
  if (!isObject(data)) throw new BusinessError("CAMBIO_INVALIDO", "Datos de cambio de precio inválidos");
  const productId = parseId(data.productId, "PRODUCTO_INVALIDO", "El producto");
  const claimed = data.oldPrice === undefined || data.oldPrice === null ? null : toCents(data.oldPrice, "precio anterior");
  const reason =
    data.reason === undefined || data.reason === null || (typeof data.reason === "string" && data.reason.trim() === "")
      ? null
      : parseReason(data.reason);
  return { productId, newPriceCents: toCents(data.newPrice, "precio nuevo"), claimedOldPriceCents: claimed, reason };
}
