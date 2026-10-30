import test from "node:test";
import assert from "node:assert/strict";
import { renderCashReportHtml, formatSigned } from "../../src/backend/cash-report.ts";
import { parseCashSessionsQuery, DEFAULT_SESSIONS_PAGE_SIZE, MAX_SESSIONS_PAGE_SIZE } from "../../src/backend/cash-query.ts";

const base = {
  session: { id: 12, status: "closed", openedAt: new Date(2026, 9, 29, 8, 0), closedAt: new Date(2026, 9, 29, 20, 30), openedByName: "Ana", closedByName: "Luis" },
  initialAmount: "200.00",
  sales: { count: 5, cash: { count: 3, total: "450.00" }, card: { count: 2, total: "1234.50" } },
  movements: { manualIn: { count: 1, total: "100.00" }, manualOut: { count: 2, total: "80.00" } },
  expected: { fromRecords: "670.00", registerBalance: "670.00", reconciles: true },
  closing: { counted: "665.00", difference: "-5.00" },
  returns: { pending: { count: 1, total: "50.00" }, paid: { count: 0, total: "0" }, legacy: { count: 0, total: "0" } },
};
const code = (fn) => { try { fn(); } catch (e) { return String(e.message).match(/^\[(\w+)\]/)?.[1] ?? "OTHER"; } return null; };

test("signed differences read as +/-/zero", () => {
  assert.equal(formatSigned("5.00"), "+$5.00");
  assert.equal(formatSigned("-5.00"), "-$5.00");
  assert.equal(formatSigned("0.00"), "$0.00");
  assert.equal(formatSigned("1234.5"), "+$1,234.50");
});
test("closed session: cash lines, expected, counted, a shortage, card as information only", () => {
  const html = renderCashReportHtml(base, "Estética Leal", "80");
  for (const needle of ["ESTÉTICA LEAL", "Corte de caja #12", "CERRADA", "Ana", "Luis", "29/10/2026 08:00", "29/10/2026 20:30", "$200.00", "Ventas en efectivo (3)", "$450.00", "Otros ingresos (1)", "$100.00", "Retiros (2)", "-$80.00", "Efectivo esperado al cierre", "$670.00", "Efectivo contado", "$665.00", "Diferencia (Faltante)", "-$5.00", "Con tarjeta (2)", "$1,234.50", "no entran al efectivo", "no es una factura fiscal"]) {
    assert.ok(html.includes(needle), "missing: " + needle);
  }
});
test("card sales are never added to the cash lines", () => {
  const html = renderCashReportHtml(base, "X", "80");
  const cashBlock = html.slice(html.indexOf("<h2>Efectivo</h2>"), html.indexOf("<h2>Ventas</h2>"));
  assert.equal(cashBlock.includes("1,234.50"), false);
});
test("an overage and an exact match are labelled", () => {
  assert.ok(renderCashReportHtml({ ...base, closing: { counted: "675.00", difference: "5.00" } }, "X", "80").includes("Diferencia (Sobrante)"));
  assert.ok(renderCashReportHtml({ ...base, closing: { counted: "670.00", difference: "0.00" } }, "X", "80").includes("Diferencia (Sin diferencia)"));
});
test("an open session has no closing lines and says the expected cash is 'now'", () => {
  const html = renderCashReportHtml({ ...base, session: { ...base.session, closedAt: null, closedByName: null }, closing: { counted: null, difference: null } }, "X", "80");
  assert.ok(html.includes("ABIERTA") && html.includes("Efectivo esperado ahora"));
  assert.equal(html.includes("Efectivo contado") || html.includes("Diferencia ("), false);
});
test("pending refunds are labelled as owed, never as paid, and absent returns print nothing", () => {
  const html = renderCashReportHtml(base, "X", "80");
  assert.ok(html.includes("Reembolsos PENDIENTES (1)") && html.includes("NO está pagado ni descontado de la caja"));
  assert.equal(html.includes("Reembolsos pagados"), false);
  const none = renderCashReportHtml({ ...base, returns: { pending: { count: 0, total: "0" }, paid: { count: 0, total: "0" }, legacy: { count: 0, total: "0" } } }, "X", "80");
  assert.equal(none.includes("Devoluciones registradas"), false);
});
test("data that does not reconcile is flagged, not hidden", () => {
  assert.ok(renderCashReportHtml({ ...base, expected: { ...base.expected, reconciles: false } }, "X", "80").includes("no concilian"));
  assert.equal(renderCashReportHtml(base, "X", "80").includes("no concilian"), false);
});
test("every dynamic value is escaped", () => {
  const evil = `<img src=x onerror=alert(1)>"&`;
  const html = renderCashReportHtml({ ...base, session: { ...base.session, openedByName: evil, closedByName: evil } }, evil, "58");
  assert.equal(/<img/i.test(html), false);
  assert.ok(html.includes("&#60;"));
  assert.ok(html.includes("size: 58mm auto") && html.includes("width: 48mm"));
});

test("cash session query: defaults, bounds, dates and status", () => {
  assert.deepEqual(parseCashSessionsQuery(undefined), { page: 1, pageSize: DEFAULT_SESSIONS_PAGE_SIZE, start: null, endExclusive: null, status: null });
  const r = parseCashSessionsQuery({ from: "2026-01-01", to: "2026-01-31", status: "closed", page: 2, pageSize: MAX_SESSIONS_PAGE_SIZE });
  assert.equal(r.status, "closed");
  assert.equal(r.endExclusive.getDate(), 1);
  for (const bad of [{ page: 0 }, { pageSize: MAX_SESSIONS_PAGE_SIZE + 1 }, { page: "1" }]) assert.equal(code(() => parseCashSessionsQuery(bad)), "PAGINA_INVALIDA");
  assert.equal(code(() => parseCashSessionsQuery({ status: "paused" })), "ESTADO_INVALIDO");
  assert.equal(code(() => parseCashSessionsQuery({ from: "2026-02-01", to: "2026-01-01" })), "RANGO_INVALIDO");
  assert.equal(code(() => parseCashSessionsQuery({ from: "2026-02-30" })), "FECHA_INVALIDA");
  assert.equal(code(() => parseCashSessionsQuery("x")), "CONSULTA_INVALIDA");
});
