// Pure cart rules (src/renderer/lib/cart.ts): what a cart kept in memory is compared with when the operator comes back.
import test from "node:test";
import assert from "node:assert/strict";
import { applyCartIssues, checkoutSignature, describeCartIssue, findCartIssues } from "../../src/renderer/lib/cart.ts";

const line = (productId, quantity, unitPrice, name = `P${productId}`) => ({ productId, sku: `S${productId}`, name, quantity, unitPrice, subtotal: quantity * unitPrice });
const prod = (id, price, stock) => ({ id, price: String(price), stock });

test("an unchanged catalog has no issues", () => {
  assert.deepEqual(findCartIssues([line(1, 2, 10), line(2, 1, 4.5)], [prod(1, "10.00", 5), prod(2, "4.50", 1)]), []);
});

test("a changed price, a short stock and a missing or sold-out product are each reported", () => {
  const items = [line(1, 2, 10), line(2, 3, 4.5), line(3, 1, 2), line(4, 1, 2)];
  const catalog = [prod(1, "12.00", 9), prod(2, "4.50", 2), prod(4, "2.00", 0)];
  const issues = findCartIssues(items, catalog);
  assert.deepEqual(issues.map((i) => `${i.kind}:${i.productId}`), ["price:1", "stock:2", "unavailable:3", "unavailable:4"]);
});

test("a price and a stock problem on the same line are both reported", () => {
  const issues = findCartIssues([line(1, 5, 10)], [prod(1, "11.00", 3)]);
  assert.deepEqual(issues.map((i) => i.kind), ["price", "stock"]);
});

test("looking at the cart never changes it", () => {
  const items = [line(1, 2, 10)];
  const copy = JSON.stringify(items);
  findCartIssues(items, [prod(1, "99.00", 0)]);
  assert.equal(JSON.stringify(items), copy);
});

test("accepting the changes uses the current price, caps the quantity and drops what is gone", () => {
  const items = [line(1, 2, 10), line(2, 3, 4.5), line(3, 1, 2)];
  const next = applyCartIssues(items, [prod(1, "12.00", 9), prod(2, "4.50", 2)]);
  assert.deepEqual(next.map((i) => [i.productId, i.quantity, i.unitPrice, i.subtotal]), [[1, 2, 12, 24], [2, 2, 4.5, 9]]);
});

test("subtotals stay exact in cents", () => {
  const next = applyCartIssues([line(1, 3, 0.1)], [prod(1, "0.29", 10)]);
  assert.equal(next[0].subtotal, 0.87);
});

test("every issue is described in plain Spanish with the amounts involved", () => {
  const text = findCartIssues([line(1, 3, 10, "Shampoo")], [prod(1, "12.5", 2)]).map(describeCartIssue).join(" ");
  assert.match(text, /Shampoo: el precio cambió de \$10\.00 a \$12\.50\./);
  assert.match(text, /hay 2 unidades disponibles y el carrito tiene 3/);
  assert.match(describeCartIssue({ kind: "unavailable", productId: 1, name: "X" }), /ya no está disponible/);
});

test("the checkout signature separates carts, methods and cash sessions but not repeats of the same checkout", () => {
  const a = [line(1, 2, 10)];
  const s = checkoutSignature(a, "cash", 7);
  assert.equal(checkoutSignature([line(1, 2, 10)], "cash", 7), s);
  assert.notEqual(checkoutSignature([line(1, 3, 10)], "cash", 7), s);
  assert.notEqual(checkoutSignature([line(1, 2, 11)], "cash", 7), s);
  assert.notEqual(checkoutSignature(a, "card", 7), s);
  assert.notEqual(checkoutSignature(a, "cash", 8), s);
});
