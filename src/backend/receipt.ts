/**
 * Receipt (commercial, NON-fiscal ticket) rendering. Pure (no DB, no Electron), unit tested.
 *
 * The HTML is built in the main process from persisted data only. Every dynamic value is escaped here, the logo is
 * accepted only as a PNG/JPEG data URL, and the document carries its own CSP (no scripts, no network), so nothing
 * sent by the renderer can execute inside the preview or the print window. Black and white, 80 mm or 58 mm.
 */
import type { PaperWidth } from "./settings-validation.ts";

export type ReceiptItem = { name: string; sku: string | null; quantity: number; unitPrice: string; subtotal: string };
export type ReceiptData = {
  folio: number;
  createdAt: Date | string;
  paymentMethod: "cash" | "card";
  seller: string | null;
  items: ReceiptItem[];
  total: string;
};
export type ReceiptBusiness = {
  name: string;
  address: string | null;
  phone: string | null;
  whatsapp: string | null;
  taxInfo: string | null;
  footerMessage: string | null;
  returnPolicy: string | null;
  contactInfo: string | null;
  logoData: string | null;
};

export const RECEIPT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";
const LOGO_RE = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const METHOD_LABEL = { cash: "Efectivo", card: "Tarjeta" } as const;

export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}
const multi = (value: string) => escapeHtml(value).replace(/\n/g, "<br>");

/** "1234.5" / "1234.50" (numeric(12,2) text) -> "$1,234.50". Never goes through floating point. */
export function formatMoney(value: string): string {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!m) return "$?";
  const whole = m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${m[1]}$${whole}.${(m[3] ?? "").padEnd(2, "0") || "00"}`;
}

const pad = (n: number) => String(n).padStart(2, "0");
export function formatDateTime(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Content width in millimetres inside the paper (printers cannot use the full roll width). */
export const CONTENT_MM: Record<PaperWidth, number> = { "80": 72, "58": 48 };

export function renderReceiptHtml(
  data: ReceiptData,
  business: ReceiptBusiness,
  width: PaperWidth,
  opts: { copy?: boolean } = {}
): string {
  const mm = CONTENT_MM[width];
  const small = width === "58";
  const header: string[] = [];
  if (business.logoData && LOGO_RE.test(business.logoData)) {
    header.push(`<img class="logo" alt="" src="${business.logoData}">`);
  }
  header.push(`<div class="brand">${escapeHtml(business.name.toLocaleUpperCase("es"))}</div>`);
  for (const line of [business.address, business.phone && `Tel. ${business.phone}`, business.whatsapp && `WhatsApp ${business.whatsapp}`, business.contactInfo, business.taxInfo]) {
    if (line) header.push(`<div class="small">${multi(line)}</div>`);
  }

  const items = data.items
    .map(
      (it) => `<div class="item"><div class="iname">${escapeHtml(it.name)}</div>
<div class="row"><span>${escapeHtml(it.quantity)} x ${escapeHtml(formatMoney(it.unitPrice))}</span><span>${escapeHtml(formatMoney(it.subtotal))}</span></div></div>`
    )
    .join("\n");
  const units = data.items.reduce((s, i) => s + i.quantity, 0);

  const footer: string[] = [];
  if (business.footerMessage) footer.push(`<div class="center">${multi(business.footerMessage)}</div>`);
  else footer.push(`<div class="center">¡Gracias por su compra!</div>`);
  if (business.returnPolicy) footer.push(`<div class="small policy">${multi(business.returnPolicy)}</div>`);

  return `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${RECEIPT_CSP}">
<title>Folio ${escapeHtml(data.folio)}</title>
<style>
@page { size: ${width}mm auto; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #fff; color: #000; }
body { font-family: "Segoe UI", Arial, Helvetica, sans-serif; font-size: ${small ? 9 : 11}pt; line-height: 1.25; -webkit-print-color-adjust: exact; }
.ticket { width: ${mm}mm; margin: 0 auto; padding: 3mm 0 5mm; }
.center { text-align: center; }
.brand { text-align: center; font-weight: 700; font-size: ${small ? 13 : 16}pt; letter-spacing: 1px; margin: 1mm 0; }
.logo { display: block; margin: 0 auto 2mm; max-width: ${Math.round(mm * 0.6)}mm; max-height: 22mm; }
.small { font-size: ${small ? 7.5 : 9}pt; text-align: center; }
.title { text-align: center; font-weight: 700; margin: 2mm 0 1mm; text-transform: uppercase; font-size: ${small ? 8 : 9.5}pt; }
hr { border: 0; border-top: 1px dashed #000; margin: 2mm 0; }
.meta .row, .row { display: flex; justify-content: space-between; gap: 2mm; }
.row > * { min-width: 0; overflow-wrap: anywhere; }
.row > :last-child { text-align: right; }
.item { margin: 1.2mm 0; }
.iname { font-weight: 600; overflow-wrap: anywhere; }
.total { display: flex; justify-content: space-between; font-weight: 700; font-size: ${small ? 12 : 15}pt; margin: 1mm 0; }
.policy { margin-top: 2mm; text-align: center; }
.copy { text-align: center; font-weight: 700; margin-bottom: 1mm; }
.nofiscal { text-align: center; font-size: ${small ? 7 : 8}pt; margin-top: 2mm; text-transform: uppercase; }
</style></head>
<body><div class="ticket">
${opts.copy ? `<div class="copy">*** REIMPRESIÓN ***</div>` : ""}
${header.join("\n")}
<hr>
<div class="meta">
<div class="row"><span>Folio</span><strong>#${escapeHtml(data.folio)}</strong></div>
<div class="row"><span>Fecha</span><span>${escapeHtml(formatDateTime(data.createdAt))}</span></div>
${data.seller ? `<div class="row"><span>Atendió</span><span>${escapeHtml(data.seller)}</span></div>` : ""}
<div class="row"><span>Pago</span><span>${escapeHtml(METHOD_LABEL[data.paymentMethod])}</span></div>
</div>
<hr>
${items}
<hr>
<div class="row"><span>Artículos</span><span>${escapeHtml(units)}</span></div>
<div class="total"><span>TOTAL</span><span>${escapeHtml(formatMoney(data.total))}</span></div>
<hr>
${footer.join("\n")}
<div class="nofiscal">Comprobante comercial · No es una factura fiscal</div>
</div></body></html>`;
}
