import test from "node:test";
import assert from "node:assert/strict";
import { parseNewRefundInput, parseOperationId, parsePayment, parseSettleInput } from "../../src/backend/refund-validation.ts";

const code = (fn) => { try { fn(); return "OK"; } catch (e) { return e.code ?? "THROWN:" + e.message; } };
const base = () => ({
  saleId: 7,
  reason: "  se arrepintió ",
  items: [{ saleItemId: 11, quantity: 2 }],
  payment: { method: "cash", confirmed: true },
  operationId: "op-a1b2c3d4",
});

test("a valid new refund parses; the reason is trimmed and nothing monetary is carried", () => {
  const r = parseNewRefundInput(base());
  assert.equal(r.sale.saleId, 7);
  assert.equal(r.sale.reason, "se arrepintió");
  assert.deepEqual(r.sale.items.map((i) => [i.saleItemId, i.quantity]), [[11, 2]]);
  assert.deepEqual(r.payment, { method: "cash", reference: null });
  assert.equal(r.operationId, "op-a1b2c3d4");
  assert.deepEqual(Object.keys(r).sort(), ["operationId", "payment", "sale"]);
});

test("the money is only ever marked as handed back with an explicit boolean true", () => {
  for (const method of ["cash", "card"]) {
    for (const bad of [false, undefined, null, "true", 1, 0, "yes", {}, []]) {
      assert.equal(code(() => parsePayment({ method, confirmed: bad })), "CONFIRMACION_REQUERIDA", method + " " + JSON.stringify(bad));
    }
    assert.equal(code(() => parsePayment({ method, confirmed: true })), "OK");
  }
});

test("only cash and card exist as methods", () => {
  for (const m of ["CASH", "transfer", "", null, undefined, 1, {}, "cash "]) assert.equal(code(() => parsePayment({ method: m, confirmed: true })), "METODO_INVALIDO");
  assert.equal(code(() => parsePayment(null)), "REEMBOLSO_INVALIDO");
  assert.equal(code(() => parsePayment("cash")), "REEMBOLSO_INVALIDO");
});

test("the payment object accepts no other field (no amount, movement, date or authority from the client)", () => {
  for (const extra of [{ amount: 1 }, { cashMovementId: 1 }, { paidAt: "x" }, { authorizedBy: 1 }]) {
    assert.equal(code(() => parsePayment({ method: "card", confirmed: true, ...extra })), "CAMPO_NO_PERMITIDO");
  }
});

test("the reference belongs to card refunds and is a plain terminal slip", () => {
  assert.deepEqual(parsePayment({ method: "card", confirmed: true, reference: "  AUT 9K2Q7M " }), { method: "card", reference: "AUT 9K2Q7M" });
  assert.deepEqual(parsePayment({ method: "card", confirmed: true, reference: "" }), { method: "card", reference: null });
  assert.deepEqual(parsePayment({ method: "card", confirmed: true, reference: "   " }), { method: "card", reference: null });
  assert.equal(code(() => parsePayment({ method: "cash", confirmed: true, reference: "X1" })), "REFERENCIA_NO_APLICA");
  assert.equal(parsePayment({ method: "cash", confirmed: true, reference: "" }).reference, null);
  for (const bad of ["<b>", "a".repeat(65), "x\ny", "x\0y", "a;b", "é", 12, {}, " - "]) {
    assert.equal(code(() => parsePayment({ method: "card", confirmed: true, reference: bad })), "REFERENCIA_INVALIDA", JSON.stringify(bad));
  }
  assert.equal(code(() => parsePayment({ method: "card", confirmed: true, reference: "a".repeat(64) })), "OK");
});

test("operation ids are mandatory and shaped like the checkout's", () => {
  assert.equal(parseOperationId("abcd1234"), "abcd1234");
  assert.equal(parseOperationId("a-b_c-D-1234"), "a-b_c-D-1234");
  for (const bad of ["short", "x".repeat(65), "has space 123", "semi;colon1", "", undefined, null, 48203917, {}]) {
    assert.equal(code(() => parseOperationId(bad)), "OPERACION_INVALIDA", JSON.stringify(bad));
  }
});

test("a new refund rejects every field the client must not send", () => {
  for (const extra of [{ amount: 5 }, { totalRefund: 5 }, { authorizedBy: 1 }, { processedBy: 1 }, { refundStatus: "paid" }, { cashSessionId: 3 }, { adminPin: "604812" }, { pin: "604812" }]) {
    assert.equal(code(() => parseNewRefundInput({ ...base(), ...extra })), "CAMPO_NO_PERMITIDO", JSON.stringify(extra));
  }
  const withPrice = base();
  withPrice.items[0].unitPrice = 5; // allowed only as a claim to detect stale screens
  assert.equal(code(() => parseNewRefundInput(withPrice)), "OK");
  const withAmount = base();
  withAmount.items[0].refundAmount = 5;
  assert.equal(code(() => parseNewRefundInput(withAmount)), "CAMPO_NO_PERMITIDO");
});

test("a new refund still enforces the return rules", () => {
  assert.equal(code(() => parseNewRefundInput({ ...base(), items: [] })), "DEVOLUCION_SIN_ITEMS");
  assert.equal(code(() => parseNewRefundInput({ ...base(), reason: "   " })) !== "OK", true);
  assert.equal(code(() => parseNewRefundInput({ ...base(), items: [{ saleItemId: 1, quantity: 0 }] })), "CANTIDAD_INVALIDA");
  assert.equal(code(() => parseNewRefundInput({ ...base(), items: [{ saleItemId: 1, quantity: 1 }, { saleItemId: 1, quantity: 1 }] })), "ITEM_DUPLICADO");
  assert.equal(code(() => parseNewRefundInput({ ...base(), saleId: "7" })), "VENTA_INVALIDA");
  assert.equal(code(() => parseNewRefundInput(null)), "DEVOLUCION_INVALIDA");
  assert.equal(code(() => parseNewRefundInput({ ...base(), operationId: undefined })), "OPERACION_INVALIDA");
  assert.equal(code(() => parseNewRefundInput({ ...base(), payment: undefined })), "REEMBOLSO_INVALIDO");
});

test("settling a pending return takes the return id, the payment and the operation id only", () => {
  const ok = parseSettleInput({ returnId: 4, payment: { method: "card", confirmed: true, reference: "T-9" }, operationId: "op-abcdefgh" });
  assert.deepEqual(ok, { returnId: 4, payment: { method: "card", reference: "T-9" }, operationId: "op-abcdefgh" });
  for (const extra of [{ amount: 1 }, { items: [] }, { saleId: 1 }, { reason: "x" }, { refundStatus: "paid" }]) {
    assert.equal(code(() => parseSettleInput({ returnId: 4, payment: { method: "cash", confirmed: true }, operationId: "op-abcdefgh", ...extra })), "CAMPO_NO_PERMITIDO");
  }
  assert.equal(code(() => parseSettleInput({ returnId: "4", payment: { method: "cash", confirmed: true }, operationId: "op-abcdefgh" })), "DEVOLUCION_INVALIDA");
  assert.equal(code(() => parseSettleInput({ returnId: 4, payment: { method: "cash", confirmed: false }, operationId: "op-abcdefgh" })), "CONFIRMACION_REQUERIDA");
  assert.equal(code(() => parseSettleInput([])), "REEMBOLSO_INVALIDO");
});
