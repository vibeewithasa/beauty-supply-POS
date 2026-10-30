import test from "node:test";
import assert from "node:assert/strict";
import { renderReturnVoucherHtml, refundStateLabel } from "../../src/backend/return-voucher.ts";
import { renderCashReportHtml } from "../../src/backend/cash-report.ts";

const base = {
  id: 7,
  saleId: 31,
  createdAt: new Date(2026, 9, 29, 10, 15),
  reason: "Producto dañado <b>",
  status: "paid",
  totalRefund: "25.00",
  processedByName: "Ana",
  items: [{ name: "Shampoo <script>x</script>", sku: "SH-1", quantity: 2, unitPrice: "12.50", refundAmount: "25.00" }],
  settlement: { method: "cash", amount: "25.00", paidAt: new Date(2026, 9, 30, 9, 5), reference: null, authorizedByName: "Luis", paidByName: "Ana" },
};

test("the voucher names the state of the money in plain words", () => {
  assert.equal(refundStateLabel(base), "REEMBOLSO PAGADO EN EFECTIVO");
  assert.equal(refundStateLabel({ ...base, settlement: { ...base.settlement, method: "card" } }), "REEMBOLSO PAGADO POR TARJETA");
  assert.equal(refundStateLabel({ status: "pending", settlement: null }), "REEMBOLSO PENDIENTE (NO PAGADO)");
  assert.equal(refundStateLabel({ status: "legacy_unspecified", settlement: null }), "ANTERIOR AL CONTROL DE REEMBOLSOS (SIN ESPECIFICAR)");
  // a "paid" status without a settlement row can never be presented as paid
  assert.equal(refundStateLabel({ status: "paid", settlement: null }), "ESTADO DESCONOCIDO");
});

test("a paid cash refund shows amount, dates, authority and the cash note", () => {
  const html = renderReturnVoucherHtml(base, "Estética Leal", "80");
  for (const needle of ["ESTÉTICA LEAL", "Comprobante de devolución #7", "Venta", "#31", "29/10/2026 10:15", "30/10/2026 09:05", "2 x $12.50", "$25.00", "Total devuelto", "REEMBOLSO PAGADO EN EFECTIVO", "Efectivo (de la caja)", "Autorizó", "Luis", "Atendió", "Ana", "El efectivo salió de la caja", "no es una factura fiscal"]) {
    assert.ok(html.includes(needle), "missing: " + needle);
  }
});

test("a card refund carries the reference and says the bank operation happened on the terminal", () => {
  const html = renderReturnVoucherHtml({ ...base, settlement: { ...base.settlement, method: "card", reference: "TERM-9/A" } }, "X", "58");
  assert.ok(html.includes("REEMBOLSO PAGADO POR TARJETA") && html.includes("Tarjeta (en la terminal)") && html.includes("TERM-9/A") && html.includes("no ejecuta operaciones bancarias"));
  assert.ok(html.includes("width: 48mm") || html.includes("size: 58mm auto"), "58 mm paper");
});

test("pending and legacy returns never read as paid", () => {
  const pending = renderReturnVoucherHtml({ ...base, status: "pending", settlement: null }, "X", "80");
  assert.ok(pending.includes("REEMBOLSO PENDIENTE (NO PAGADO)") && pending.includes("aún NO se ha entregado"));
  assert.equal(pending.includes("PAGADO EN EFECTIVO") || pending.includes("Pagado el"), false);
  const legacy = renderReturnVoucherHtml({ ...base, status: "legacy_unspecified", settlement: null }, "X", "80");
  assert.ok(legacy.includes("ANTERIOR AL CONTROL") && legacy.includes("no se sabe si el dinero ya se entregó"));
  assert.equal(/REEMBOLSO PAGADO/.test(legacy), false);
});

test("every dynamic value is escaped and the document forbids scripts and network", () => {
  const html = renderReturnVoucherHtml(base, "<img src=x onerror=1>", "80");
  assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes("<img src=x"), false);
  assert.ok(html.includes("&#60;script&#62;") && html.includes("&#60;b&#62;"));
  assert.match(html, /Content-Security-Policy" content="default-src 'none'/);
});

const cashBase = {
  session: { id: 3, status: "closed", openedAt: new Date(2026, 9, 30, 8), closedAt: new Date(2026, 9, 30, 20), openedByName: "Ana", closedByName: "Luis" },
  initialAmount: "100.00",
  sales: { count: 2, cash: { count: 1, total: "50.00" }, card: { count: 1, total: "30.00" } },
  movements: { manualIn: { count: 0, total: "0" }, manualOut: { count: 0, total: "0" } },
  expected: { fromRecords: "125.00", registerBalance: "125.00", reconciles: true },
  closing: { counted: "125.00", difference: "0.00" },
  returns: { pending: { count: 1, total: "9.00" }, paid: { count: 2, total: "25.00" }, legacy: { count: 0, total: "0" } },
};

test("the closing summary lists cash refunds apart from withdrawals and card refunds as information", () => {
  const html = renderCashReportHtml({ ...cashBase, refunds: { cash: { count: 1, total: "25.00" }, card: { count: 1, total: "5.00" } } }, "X", "80");
  const cashBlock = html.slice(html.indexOf("<h2>Efectivo</h2>"), html.indexOf("<h2>Ventas</h2>"));
  assert.ok(cashBlock.includes("Retiros (0)") && cashBlock.includes("Reembolsos en efectivo (1)") && cashBlock.includes("-$25.00"), "cash refunds are their own line in the cash block");
  assert.equal(cashBlock.includes("$5.00"), false, "the card refund is not in the cash block");
  assert.ok(html.includes("Reembolsos pagados en esta caja") && html.includes("Con tarjeta (1)") && html.includes("son informativos y no restan efectivo"));
  assert.ok(html.includes("Devoluciones de las ventas de esta caja") && html.includes("Reembolsos PENDIENTES (1)"), "pending refunds stay apart: owed, not paid");
});

test("a summary without refunds (older data) still renders with a zero cash-refund line", () => {
  const html = renderCashReportHtml(cashBase, "X", "80");
  assert.ok(html.includes("Reembolsos en efectivo (0)") && html.includes("-$0.00"));
  assert.equal(html.includes("Reembolsos pagados en esta caja"), false);
});
