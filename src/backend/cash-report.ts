/**
 * Printable closing summary of a cash-register session (internal document, NOT a fiscal receipt). Pure (no DB, no
 * Electron), unit tested. Same safety model as the receipt: built in main from persisted figures only, every dynamic
 * value escaped, the document carries a CSP that forbids scripts and network. Black and white, 80 mm or 58 mm.
 */
import { escapeHtml, formatDateTime, formatMoney, RECEIPT_CSP, CONTENT_MM } from "./receipt.ts";
import type { PaperWidth } from "./settings-validation.ts";

export type CashReportData = {
  session: { id: number; status: string; openedAt: Date | string; closedAt: Date | string | null; openedByName: string | null; closedByName: string | null };
  initialAmount: string;
  sales: { count: number; cash: { count: number; total: string }; card: { count: number; total: string } };
  movements: { manualIn: { count: number; total: string }; manualOut: { count: number; total: string } };
  expected: { fromRecords: string; registerBalance: string; reconciles: boolean };
  closing: { counted: string | null; difference: string | null };
  returns: { pending: { count: number; total: string }; paid: { count: number; total: string }; legacy: { count: number; total: string } };
  /** Refunds whose money was handed back while this register was open (optional: summaries made before refunds existed). */
  refunds?: { cash: { count: number; total: string }; card: { count: number; total: string } };
};

/** "+$5.00" / "-$5.00" / "$0.00" for a signed numeric text. */
export function formatSigned(value: string): string {
  const m = formatMoney(value);
  return /^-/.test(m) || /^\$0\.00$/.test(m) ? m : "+" + m;
}

export function renderCashReportHtml(data: CashReportData, businessName: string, width: PaperWidth): string {
  const small = width === "58";
  const mm = CONTENT_MM[width];
  const closed = data.session.closedAt !== null;
  const row = (label: string, value: string, strong = false) =>
    `<div class="row${strong ? " strong" : ""}"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
  let diffLabel = "";
  if (data.closing.difference !== null) {
    const d = data.closing.difference;
    diffLabel = /^-/.test(formatMoney(d)) ? "Faltante" : formatMoney(d) === "$0.00" ? "Sin diferencia" : "Sobrante";
  }
  const cashRefunds = data.refunds?.cash ?? { count: 0, total: "0" };
  const cardRefunds = data.refunds?.card ?? { count: 0, total: "0" };
  const refundLines: string[] = [];
  if (cashRefunds.count) refundLines.push(row(`En efectivo (${cashRefunds.count})`, "-" + formatMoney(cashRefunds.total)));
  if (cardRefunds.count) refundLines.push(row(`Con tarjeta (${cardRefunds.count})`, formatMoney(cardRefunds.total)));
  const returnsLines: string[] = [];
  if (data.returns.pending.count) returnsLines.push(row(`Reembolsos PENDIENTES (${data.returns.pending.count})`, formatMoney(data.returns.pending.total)));
  if (data.returns.paid.count) returnsLines.push(row(`Reembolsos pagados (${data.returns.paid.count})`, formatMoney(data.returns.paid.total)));
  if (data.returns.legacy.count) returnsLines.push(row(`Anteriores al control (${data.returns.legacy.count})`, formatMoney(data.returns.legacy.total)));

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${RECEIPT_CSP}">
<title>Corte de caja ${escapeHtml(data.session.id)}</title>
<style>
@page { size: ${width}mm auto; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; font-size: ${small ? 9 : 11}pt; line-height: 1.25; -webkit-print-color-adjust: exact; }
.sheet { width: ${mm}mm; margin: 0 auto; padding: 3mm 0 5mm; }
.brand { text-align: center; font-weight: 700; font-size: ${small ? 12 : 14}pt; letter-spacing: 1px; }
.title { text-align: center; font-weight: 700; margin: 1mm 0 2mm; text-transform: uppercase; }
.small { font-size: ${small ? 7.5 : 9}pt; text-align: center; }
h2 { font-size: ${small ? 8.5 : 10}pt; text-transform: uppercase; margin: 2mm 0 1mm; }
hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
.row { display: flex; justify-content: space-between; gap: 2mm; }
.row > * { min-width: 0; overflow-wrap: anywhere; }
.row > :last-child { text-align: right; }
.strong { font-weight: 700; font-size: ${small ? 10 : 12}pt; }
.note { font-size: ${small ? 7.5 : 8.5}pt; margin-top: 1mm; }
.warn { border: 1px solid #000; padding: 1mm; margin: 2mm 0; font-weight: 700; }
</style></head>
<body><div class="sheet">
<div class="brand">${escapeHtml(businessName.toLocaleUpperCase("es"))}</div>
<div class="title">Corte de caja #${escapeHtml(data.session.id)} · ${closed ? "CERRADA" : "ABIERTA"}</div>
<hr>
${row("Apertura", formatDateTime(data.session.openedAt))}
${row("Abrió", data.session.openedByName ?? "—")}
${closed ? row("Cierre", formatDateTime(data.session.closedAt as Date | string)) : ""}
${closed ? row("Cerró", data.session.closedByName ?? "—") : ""}
<hr>
<h2>Efectivo</h2>
${row("Efectivo inicial", formatMoney(data.initialAmount))}
${row(`Ventas en efectivo (${data.sales.cash.count})`, formatMoney(data.sales.cash.total))}
${row(`Otros ingresos (${data.movements.manualIn.count})`, formatMoney(data.movements.manualIn.total))}
${row(`Retiros (${data.movements.manualOut.count})`, "-" + formatMoney(data.movements.manualOut.total))}
${row(`Reembolsos en efectivo (${cashRefunds.count})`, "-" + formatMoney(cashRefunds.total))}
${row(closed ? "Efectivo esperado al cierre" : "Efectivo esperado ahora", formatMoney(data.expected.registerBalance), true)}
${closed ? row("Efectivo contado", formatMoney(data.closing.counted as string)) : ""}
${closed && data.closing.difference !== null ? row(`Diferencia (${diffLabel})`, formatSigned(data.closing.difference), true) : ""}
${data.expected.reconciles ? "" : `<div class="warn">Los registros no concilian con el saldo de caja (datos anteriores): revisa los movimientos.</div>`}
<hr>
<h2>Ventas</h2>
${row("Total de ventas", String(data.sales.count))}
${row(`Con tarjeta (${data.sales.card.count})`, formatMoney(data.sales.card.total))}
<div class="note">Las ventas con tarjeta son informativas: no entran al efectivo de la caja.</div>
${refundLines.length ? `<hr><h2>Reembolsos pagados en esta caja</h2>${refundLines.join("\n")}<div class="note">Los de efectivo ya están descontados arriba. Los de tarjeta se hicieron en la terminal: son informativos y no restan efectivo.</div>` : ""}
${returnsLines.length ? `<hr><h2>Devoluciones de las ventas de esta caja</h2>${returnsLines.join("\n")}<div class="note">Un reembolso pendiente es dinero que se debe al cliente: NO está pagado ni descontado de la caja.</div>` : ""}
<hr>
<div class="small">Documento interno · no es una factura fiscal</div>
</div></body></html>`;
}
