import test from "node:test";
import assert from "node:assert/strict";
import { parseProductCreate, parseProductUpdate, parseInventoryMovement, parsePriceChange, parseStock } from "../../src/backend/catalog-validation.ts";

const code = (re) => (e) => re.test(e.message);
const create = (o = {}) => ({ sku: "SKU-1", name: "Shampoo", price: "12.30", ...o });

test("create: normalizes a valid product", () => {
  const p = parseProductCreate(create({ name: "  Shampoo  ", stock: 7, barcode: " 7501 ", category: " Cabello " }));
  assert.deepEqual(p, { sku: "SKU-1", name: "Shampoo", priceCents: 1230, stock: 7, barcode: "7501", category: "Cabello", status: "active" });
  const d = parseProductCreate(create());
  assert.equal(d.stock, 0); assert.equal(d.barcode, null); assert.equal(d.category, null); assert.equal(d.status, "active");
  assert.equal(parseProductCreate(create({ barcode: "", category: "  " })).barcode, null);
  assert.equal(parseProductCreate(create({ status: "inactive" })).status, "inactive");
});

test("create: price, stock, status", () => {
  for (const price of [-1, NaN, 1.001, "abc", undefined, null]) assert.throws(() => parseProductCreate(create({ price })), code(/IMPORTE_INVALIDO/));
  for (const stock of [-1, 1.5, NaN, "5", null, 1_000_001]) assert.throws(() => parseProductCreate(create({ stock })), code(/STOCK_INVALIDO/));
  assert.throws(() => parseProductCreate(create({ status: "deleted" })), code(/OPERACION_INVALIDA/));
  assert.throws(() => parseProductCreate(create({ status: "x" })), code(/ESTADO_INVALIDO/));
  assert.equal(parseStock(0), 0);
});

test("create: sku, name and text fields", () => {
  for (const sku of ["", " ", "-a", "a b", "x".repeat(65), 5, null, undefined, "a;drop"]) assert.throws(() => parseProductCreate(create({ sku })), code(/CAMPO_INVALIDO/), String(sku));
  for (const name of ["", "  ", "x".repeat(256), "a\u0000b", "a\nb", 5, null]) assert.throws(() => parseProductCreate(create({ name })), code(/CAMPO_INVALIDO/));
  assert.throws(() => parseProductCreate(create({ barcode: "a b" })), code(/CAMPO_INVALIDO/));
  assert.throws(() => parseProductCreate(create({ category: "y".repeat(129) })), code(/CAMPO_INVALIDO/));
  assert.equal(parseProductCreate(create({ sku: "A.b_c-1/2" })).sku, "A.b_c-1/2");
});

test("create: unknown/administrative fields and bad payloads are rejected", () => {
  for (const extra of [{ id: 1 }, { createdAt: "x" }, { updatedAt: "x" }, { userId: 1 }, { isAdmin: true }, { __proto__x: 1 }]) assert.throws(() => parseProductCreate(create(extra)), code(/CAMPO_NO_PERMITIDO/));
  for (const bad of [null, undefined, 5, "x", []]) assert.throws(() => parseProductCreate(bad), code(/PRODUCTO_INVALIDO/));
});

test("update: only whitelisted fields; stock and price have dedicated errors", () => {
  assert.deepEqual(parseProductUpdate({ name: " N ", status: "inactive", barcode: "", category: null, sku: "S-2" }), { name: "N", status: "inactive", barcode: null, category: null, sku: "S-2" });
  assert.throws(() => parseProductUpdate({ stock: 5 }), code(/STOCK_NO_MODIFICABLE/));
  assert.throws(() => parseProductUpdate({ name: "x", stock: 0 }), code(/STOCK_NO_MODIFICABLE/));
  assert.throws(() => parseProductUpdate({ price: "1.00" }), code(/PRECIO_NO_MODIFICABLE/));
  for (const f of [{ id: 1 }, { createdAt: 1 }, { updatedAt: 1 }, { foo: 1 }]) assert.throws(() => parseProductUpdate(f), code(/CAMPO_NO_PERMITIDO/));
  assert.throws(() => parseProductUpdate({}), code(/UPDATE_VACIO/));
  assert.throws(() => parseProductUpdate({ status: "deleted" }), code(/OPERACION_INVALIDA/));
  assert.throws(() => parseProductUpdate({ status: "nope" }), code(/ESTADO_INVALIDO/));
  assert.throws(() => parseProductUpdate({ name: "" }), code(/CAMPO_INVALIDO/));
  for (const bad of [null, [], "x"]) assert.throws(() => parseProductUpdate(bad), code(/PRODUCTO_INVALIDO/));
});

test("inventory: types, signs, quantities and reasons", () => {
  const m = (o) => parseInventoryMovement({ productId: 1, type: "IN", amount: 5, reason: " compra ", ...o });
  assert.deepEqual(m({}), { productId: 1, type: "IN", amount: 5, reason: "compra" });
  assert.equal(m({ type: "OUT", amount: -2 }).amount, -2);
  assert.equal(m({ type: "ADJUST", amount: 3 }).amount, 3);
  assert.equal(m({ type: "ADJUST", amount: -3 }).amount, -3);
  assert.throws(() => m({ type: "IN", amount: -1 }), code(/SIGNO_INVALIDO/));
  assert.throws(() => m({ type: "OUT", amount: 1 }), code(/SIGNO_INVALIDO/));
  for (const type of ["DELETE"]) assert.throws(() => m({ type, amount: -1 }), code(/TIPO_RESERVADO/));
  for (const type of ["XX", "in", "", null, undefined, 5]) assert.throws(() => m({ type }), code(/TIPO_INVALIDO/));
  for (const amount of [0, -0, 1.5, NaN, Infinity, "3", null, undefined, 1_000_001, -1_000_001]) assert.throws(() => m({ amount, type: "ADJUST" }), code(/CANTIDAD_INVALIDA/), String(amount));
  for (const productId of [0, -1, 1.5, "1", null]) assert.throws(() => m({ productId }), code(/PRODUCTO_INVALIDO/));
  for (const reason of ["", "  ", null, 5, "x".repeat(501)]) assert.throws(() => m({ reason }), code(/MOTIVO_INVALIDO/));
  assert.equal(m({ userId: 99, user_id: 99 }).userId, undefined, "client-supplied user is never part of the parsed input");
  assert.throws(() => parseInventoryMovement(null), code(/MOVIMIENTO_INVALIDO/));
});

test("price change: oldPrice is only a claim, reason is optional", () => {
  assert.deepEqual(parsePriceChange({ productId: 1, newPrice: "12.50" }), { productId: 1, newPriceCents: 1250, claimedOldPriceCents: null, reason: null });
  assert.deepEqual(parsePriceChange({ productId: 1, newPrice: 9.99, oldPrice: 12.5, reason: " r " }), { productId: 1, newPriceCents: 999, claimedOldPriceCents: 1250, reason: "r" });
  assert.equal(parsePriceChange({ productId: 1, newPrice: 1, reason: "  " }).reason, null);
  for (const newPrice of [-1, NaN, 1.001, "x", undefined, null]) assert.throws(() => parsePriceChange({ productId: 1, newPrice }), code(/IMPORTE_INVALIDO/));
  assert.throws(() => parsePriceChange({ productId: 1, newPrice: 1, oldPrice: NaN }), code(/IMPORTE_INVALIDO/));
  assert.throws(() => parsePriceChange({ productId: 1, newPrice: 1, reason: "x".repeat(501) }), code(/MOTIVO_INVALIDO/));
  for (const productId of [0, -1, "1", null]) assert.throws(() => parsePriceChange({ productId, newPrice: 1 }), code(/PRODUCTO_INVALIDO/));
  assert.throws(() => parsePriceChange(null), code(/CAMBIO_INVALIDO/));
});
