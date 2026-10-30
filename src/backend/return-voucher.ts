/**
 * Printable return voucher (internal document, NOT a fiscal receipt and not a CFDI). Pure (no DB, no Electron), unit tested.
 * Same safety model as the receipt and the cash summary: built in main from persisted figures only, every dynamic value
 * escaped, the document carries a CSP that forbids scripts and network. Black and white, 80 mm or 58 mm.
 *
 * It states plainly what has happened to the money: PENDING (owed, not paid), PAID IN CASH, PAID BY CARD (refunded on the card
 * terminal) or BEFORE THE CONTROL (old return whose payment is unknown). It never says "paid" for anything else.
 */
import { escapeHtml, formatDateTime, formatMoney, RECEIPT_CSP, CONTENT_MM } from "./receipt.ts";
import type { PaperWidth } from "./settings-validation.ts";

export type ReturnVoucherData = {
  id: number;
  saleId: number;
  createdAt: Date | string;
  reason: string;
  status: "pending" | "paid" | "legacy_unspecified";
  totalRefund: string | null;
  processedByName: string | null;
  items: { name: string; sku: string | null; quantity: number; unitPrice: string; refundAmount: string }[];
  settlement: null | {
    method: "cash" | "card";
    amount: string;
    paidAt: Date | string;
    reference: string | null;
    authorizedByName: string | null;
    paidByName: string | null;
  };
};

export function refundStateLabel(d: Pick<ReturnVoucherData, "status" | "settlement">): string {
  if (d.status === "paid" && d.settlement) return d.settlement.method === "cash" ? "REEMBOLSO PAGADO EN EFECTIVO" : "REEMBOLSO PAGADO POR TARJETA";
  if (d.status === "pending") return "REEMBOLSO PENDIENTE (NO PAGADO)";
  if (d.status === "legacy_unspecified") return "ANTERIOR AL CONTROL DE REEMBOLSOS (SIN ESPECIFICAR)";
  return "ESTADO DESCONOCIDO";
}

export function renderReturnVoucherHtml(data: ReturnVoucherData, businessName: string, width: PaperWidth): string {
  const small = width === "58";
  const mm = CONTENT_MM[width];
  const row = (label: string, value: string, strong = false) =>
    `<div class="row${strong ? " strong" : ""}"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
  const lines = data.items
    .map(
      (i) =>
        `<div class="item"><div>${escapeHtml(i.name)}${i.sku ? ` <span class="sku">${escapeHtml(i.sku)}</span>` : ""}</div>` +
        row(`${i.quantity} x ${formatMoney(i.unitPrice)}`, formatMoney(i.refundAmount)) +
        `</div>`
    )
    .join("\n");
  const s = data.settlement;
  const paid = data.status === "paid" && s !== null;
  const total = data.totalRefund ?? (s ? s.amount : null);

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${RECEIPT_CSP}">
<title>Devolución ${escapeHtml(data.id)}</title>
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
.item { margin-bottom: 1mm; overflow-wrap: anywhere; }
.sku { font-size: ${small ? 7 : 8}pt; }
.state { border: 1px solid #000; padding: 1mm; margin: 2mm 0; font-weight: 700; text-align: center; }
.note { font-size: ${small ? 7.5 : 8.5}pt; margin-top: 1mm; }
</style></head>
<body><div class="sheet">
<div class="brand">${escapeHtml(businessName.toLocaleUpperCase("es"))}</div>
<div class="title">Comprobante de devolución #${escapeHtml(data.id)}</div>
<hr>
${row("Venta", "#" + data.saleId)}
${row("Fecha de la devolución", formatDateTime(data.createdAt))}
${row("Registró", data.processedByName ?? "—")}
<hr>
<h2>Artículos devueltos</h2>
${lines}
<hr>
${total !== null ? row("Total devuelto", formatMoney(total), true) : ""}
<div class="state">${escapeHtml(refundStateLabel(data))}</div>
${
  paid && s
    ? row("Pagado el", formatDateTime(s.paidAt)) +
      row("Forma de pago", s.method === "cash" ? "Efectivo (de la caja)" : "Tarjeta (en la terminal)") +
      (s.reference ? row("Referencia", s.reference) : "") +
      row("Autorizó", s.authorizedByName ?? "—") +
      row("Atendió", s.paidByName ?? "—") +
      `<div class="note">${s.method === "card" ? "Reembolso hecho en la terminal de tarjeta; el sistema no ejecuta operaciones bancarias." : "El efectivo salió de la caja al registrar este reembolso."}</div>`
    : data.status === "pending"
      ? `<div class="note">El dinero se debe al cliente: aún NO se ha entregado ni descontado de la caja.</div>`
      : `<div class="note">Devolución anterior al control de reembolsos: no se sabe si el dinero ya se entregó.</div>`
}
<hr>
${row("Motivo", data.reason)}
<hr>
<div class="small">Documento interno · no es una factura fiscal</div>
</div></body></html>`;
}
