import test from "node:test";
import assert from "node:assert/strict";
import { parseSaleInput, parseCashMovement, parseId, parseReason } from "../../src/backend/validation.ts";

const item = (o = {}) => ({ productId: 1, quantity: 2, unitPrice: 10.5, subtotal: 21, ...o });
const sale = (o = {}) => ({ sessionId: 5, paymentMethod: "cash", items: [item()], total: 21, ...o });
const code = (re) => (e) => re.test(e.message);

test("a valid sale is parsed into integer cents", () => {
  const s = parseSaleInput(sale());
  assert.deepEqual(s, { sessionId: 5, paymentMethod: "cash", totalCents: 2100, items: [{ productId: 1, quantity: 2, unitPriceCents: 1050, subtotalCents: 2100 }] });
});

test("sale: missing/invalid session, payment and items are rejected", () => {
  assert.throws(() => parseSaleInput(sale({ sessionId: null })), code(/CAJA_REQUERIDA/));
  assert.throws(() => parseSaleInput(sale({ sessionId: undefined })), code(/CAJA_REQUERIDA/));
  for (const sessionId of [0, -1, 1.5, "5", NaN]) assert.throws(() => parseSaleInput(sale({ sessionId })), code(/CAJA_INVALIDA/));
  for (const paymentMethod of ["cheque", "", null, undefined, "CASH"]) assert.throws(() => parseSaleInput(sale({ paymentMethod })), code(/PAGO_INVALIDO/));
  for (const items of [[], null, undefined, "x", {}]) assert.throws(() => parseSaleInput(sale({ items })), code(/VENTA_SIN_ITEMS/));
  for (const bad of [null, undefined, 5, "x", []]) assert.throws(() => parseSaleInput(bad), code(/VENTA_INVALIDA/));
});

test("sale: quantities must be positive integers", () => {
  for (const quantity of [0, -1, 1.5, 0.1, NaN, Infinity, "2", null, 100001]) {
    assert.throws(() => parseSaleInput(sale({ items: [item({ quantity })] })), code(/CANTIDAD_INVALIDA/), String(quantity));
  }
});

test("sale: product ids, amounts and duplicates", () => {
  for (const productId of [0, -3, 1.2, "1", null]) assert.throws(() => parseSaleInput(sale({ items: [item({ productId })] })), code(/PRODUCTO_INVALIDO/));
  for (const unitPrice of [NaN, Infinity, -1, 0.001, "x", null]) assert.throws(() => parseSaleInput(sale({ items: [item({ unitPrice })] })), code(/IMPORTE_INVALIDO/));
  for (const total of [NaN, -5, 1.234, undefined]) assert.throws(() => parseSaleInput(sale({ total })), code(/IMPORTE_INVALIDO/));
  assert.throws(() => parseSaleInput(sale({ items: [item(), item({ quantity: 1 })] })), code(/ITEM_DUPLICADO/), "same product twice cannot split the stock check");
});

test("cash movement validation", () => {
  const ok = parseCashMovement({ sessionId: 3, type: "OUT", amount: 10, reason: "  cambio  " });
  assert.deepEqual(ok, { sessionId: 3, type: "OUT", amountCents: 1000, reason: "cambio" });
  assert.throws(() => parseCashMovement({ sessionId: 3, type: "in", amount: 1, reason: "x" }), code(/TIPO_INVALIDO/));
  for (const amount of [0, -1, NaN, 0.001, "x"]) assert.throws(() => parseCashMovement({ sessionId: 3, type: "IN", amount, reason: "x" }), code(/IMPORTE_INVALIDO/));
  for (const reason of ["", "   ", null, 5, "x".repeat(501)]) assert.throws(() => parseCashMovement({ sessionId: 3, type: "IN", amount: 1, reason }), code(/MOTIVO_INVALIDO/));
  assert.throws(() => parseCashMovement({ sessionId: "3", type: "IN", amount: 1, reason: "x" }), code(/CAJA_INVALIDA/));
});

test("ids and reasons", () => {
  assert.equal(parseId(7, "X", "id"), 7);
  for (const v of [0, -1, 1.5, "1", NaN, null]) assert.throws(() => parseId(v, "ID_MAL", "id"), code(/ID_MAL/));
  assert.equal(parseReason(" ok "), "ok");
  assert.throws(() => parseReason(""), code(/MOTIVO_INVALIDO/));
});
