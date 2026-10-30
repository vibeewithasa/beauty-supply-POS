import test from "node:test";
import assert from "node:assert/strict";
import { parseReturnInput } from "../../src/backend/returns-validation.ts";

const code = (re) => (e) => re.test(e.message);
const line = (o = {}) => ({ saleItemId: 3, quantity: 2, ...o });
const ret = (o = {}) => ({ saleId: 1, reason: "  motivo  ", items: [line()], ...o });

test("a valid return is parsed; price/product are only optional claims", () => {
  assert.deepEqual(parseReturnInput(ret()), { saleId: 1, reason: "motivo", items: [{ saleItemId: 3, quantity: 2, claimedProductId: null, claimedUnitPriceCents: null }] });
  const c = parseReturnInput(ret({ items: [line({ productId: 9, unitPrice: 12.5 })] })).items[0];
  assert.equal(c.claimedProductId, 9);
  assert.equal(c.claimedUnitPriceCents, 1250);
});

test("sale, lines and payload shape", () => {
  for (const saleId of [0, -1, 1.5, "1", null, undefined, NaN]) assert.throws(() => parseReturnInput(ret({ saleId })), code(/VENTA_INVALIDA/));
  for (const items of [[], null, undefined, "x", {}]) assert.throws(() => parseReturnInput(ret({ items })), code(/DEVOLUCION_SIN_ITEMS/));
  for (const bad of [null, undefined, 5, "x", []]) assert.throws(() => parseReturnInput(bad), code(/DEVOLUCION_INVALIDA/));
  assert.throws(() => parseReturnInput(ret({ items: [5] })), code(/DEVOLUCION_INVALIDA/));
  assert.throws(() => parseReturnInput(ret({ items: Array.from({ length: 201 }, (_, i) => line({ saleItemId: i + 1 })) })), code(/DEVOLUCION_INVALIDA/));
});

test("quantities must be positive integers", () => {
  for (const quantity of [0, -1, 1.5, NaN, Infinity, "2", null, undefined, 100001]) assert.throws(() => parseReturnInput(ret({ items: [line({ quantity })] })), code(/CANTIDAD_INVALIDA/), String(quantity));
});

test("line ids, duplicates, unknown fields, claims and reason", () => {
  for (const saleItemId of [0, -2, 1.5, "3", null, undefined]) assert.throws(() => parseReturnInput(ret({ items: [line({ saleItemId })] })), code(/ITEM_INVALIDO/));
  assert.throws(() => parseReturnInput(ret({ items: [line(), line({ quantity: 1 })] })), code(/ITEM_DUPLICADO/));
  for (const extra of [{ refundAmount: 1 }, { refund_amount: 1 }, { userId: 1 }, { foo: 1 }]) assert.throws(() => parseReturnInput(ret({ items: [line(extra)] })), code(/CAMPO_NO_PERMITIDO/));
  for (const productId of [0, -1, 1.5, "9"]) assert.throws(() => parseReturnInput(ret({ items: [line({ productId })] })), code(/PRODUCTO_INVALIDO/));
  for (const unitPrice of [NaN, -1, 1.001, "x"]) assert.throws(() => parseReturnInput(ret({ items: [line({ unitPrice })] })), code(/IMPORTE_INVALIDO/));
  for (const reason of ["", "  ", null, 5, "x".repeat(501)]) assert.throws(() => parseReturnInput(ret({ reason })), code(/MOTIVO_INVALIDO/));
});
