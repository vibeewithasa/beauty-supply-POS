import test from "node:test";
import assert from "node:assert/strict";
import { parseSalesQuery, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../src/backend/sales-query.ts";
import { parseSaleInput } from "../../src/backend/validation.ts";

const code = (fn) => { try { fn(); } catch (e) { return String(e.message).match(/^\[(\w+)\]/)?.[1] ?? "OTHER"; } return null; };

test("defaults: first page, default size, no filters", () => {
  for (const input of [undefined, null, {}]) {
    assert.deepEqual(parseSalesQuery(input), { page: 1, pageSize: DEFAULT_PAGE_SIZE, folio: null, start: null, endExclusive: null, method: null });
  }
});
test("folio accepts digits with an optional #, rejects everything else", () => {
  assert.equal(parseSalesQuery({ q: "#1042" }).folio, 1042);
  assert.equal(parseSalesQuery({ q: " 7 " }).folio, 7);
  for (const q of ["abc", "12a", "1; drop table sales", "-3", "0", "1.5", "9999999999", {}, 5]) assert.equal(code(() => parseSalesQuery({ q })), "BUSQUEDA_INVALIDA", String(q));
});
test("pagination bounds", () => {
  assert.equal(parseSalesQuery({ page: 3, pageSize: MAX_PAGE_SIZE }).page, 3);
  for (const p of [{ page: 0 }, { page: -1 }, { page: 1.5 }, { page: "2" }, { pageSize: 0 }, { pageSize: MAX_PAGE_SIZE + 1 }, { page: 2_000_000 }]) assert.equal(code(() => parseSalesQuery(p)), "PAGINA_INVALIDA", JSON.stringify(p));
});
test("date range: calendar days, inclusive end, from <= to, either side optional, no span limit", () => {
  const r = parseSalesQuery({ from: "2026-01-01", to: "2026-01-31" });
  assert.equal(r.start.getDate(), 1);
  assert.equal(r.endExclusive.getMonth(), 1);
  assert.equal(r.endExclusive.getDate(), 1);
  assert.ok(parseSalesQuery({ from: "2026-01-01" }).start && parseSalesQuery({ to: "2026-01-01" }).endExclusive);
  assert.equal(parseSalesQuery({ from: "2020-01-01", to: "2026-01-01" }).start.getFullYear(), 2020);
  assert.equal(parseSalesQuery({ from: "2026-03-05", to: "2026-03-05" }).endExclusive.getDate(), 6);
  assert.equal(code(() => parseSalesQuery({ from: "2026-02-01", to: "2026-01-01" })), "RANGO_INVALIDO");
  for (const bad of ["2026-02-30", "01/02/2026", "2026-1-1", "x"]) assert.equal(code(() => parseSalesQuery({ from: bad })), "FECHA_INVALIDA", bad);
});
test("payment method filter", () => {
  assert.equal(parseSalesQuery({ method: "card" }).method, "card");
  assert.equal(code(() => parseSalesQuery({ method: "check" })), "PAGO_INVALIDO");
});
test("garbage input is rejected", () => {
  for (const bad of ["x", 5, [], true]) assert.equal(code(() => parseSalesQuery(bad)), "CONSULTA_INVALIDA");
});

const sale = { sessionId: 1, paymentMethod: "cash", total: 10, items: [{ productId: 1, quantity: 1, unitPrice: 10, subtotal: 10 }] };
test("sale operationId is optional and strictly validated", () => {
  assert.equal(parseSaleInput(sale).operationId, null);
  assert.equal(parseSaleInput({ ...sale, operationId: null }).operationId, null);
  assert.equal(parseSaleInput({ ...sale, operationId: "3f2b7c1e-9a4d-4e1b-8c55-0d9e1f2a3b4c" }).operationId, "3f2b7c1e-9a4d-4e1b-8c55-0d9e1f2a3b4c");
  for (const bad of ["", "short", "has spaces in it!", "x".repeat(65), 87654321, {}, "a'; drop table sales;--"]) assert.equal(code(() => parseSaleInput({ ...sale, operationId: bad })), "OPERACION_INVALIDA", String(bad));
});
