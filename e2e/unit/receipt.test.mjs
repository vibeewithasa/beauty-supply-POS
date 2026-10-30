import test from "node:test";
import assert from "node:assert/strict";
import { renderReceiptHtml, escapeHtml, formatMoney, formatDateTime, RECEIPT_CSP } from "../../src/backend/receipt.ts";

const data = {
  folio: 1042,
  createdAt: new Date(2026, 9, 29, 14, 5),
  paymentMethod: "cash",
  seller: "Ana",
  total: "1234.50",
  items: [
    { name: "Shampoo reparador 500 ml", sku: "SH-500", quantity: 2, unitPrice: "100.00", subtotal: "200.00" },
    { name: "Tinte 7.1", sku: "TI-71", quantity: 1, unitPrice: "1034.50", subtotal: "1034.50" },
  ],
};
const empty = { name: "Estética Leal", address: null, phone: null, whatsapp: null, taxInfo: null, footerMessage: null, returnPolicy: null, contactInfo: null, logoData: null };
const PNG = "data:image/png;base64,iVBORw0KGgo=";

test("money is formatted from the numeric text, with thousands separators and two decimals", () => {
  assert.equal(formatMoney("1234.5"), "$1,234.50");
  assert.equal(formatMoney("0"), "$0.00");
  assert.equal(formatMoney("9999999999.99"), "$9,999,999,999.99");
  assert.equal(formatMoney("12.00"), "$12.00");
  assert.equal(formatMoney("-4.50"), "-$4.50");
  assert.equal(formatMoney("abc"), "$?");
});
test("date and time are the real ones, formatted dd/mm/yyyy hh:mm", () => {
  assert.equal(formatDateTime(new Date(2026, 0, 5, 9, 7)), "05/01/2026 09:07");
  assert.equal(formatDateTime("not a date"), "");
});
test("mandatory content: brand, real folio, items, total, payment, thank-you and the non-fiscal notice", () => {
  const html = renderReceiptHtml(data, empty, "80");
  for (const needle of ["ESTÉTICA LEAL", "#1042", "29/10/2026 14:05", "Shampoo reparador 500 ml", "2 x $100.00", "$200.00", "$1,234.50", "Efectivo", "Atendió", "Ana", "¡Gracias por su compra!", "No es una factura fiscal"]) {
    assert.ok(html.includes(needle), "missing: " + needle);
  }
  assert.ok(renderReceiptHtml({ ...data, paymentMethod: "card" }, empty, "80").includes("Tarjeta"));
  assert.ok(html.includes(`content="${RECEIPT_CSP}"`) && /script-src|default-src 'none'/.test(RECEIPT_CSP));
});
test("optional business data that is empty is not printed, and nothing is invented", () => {
  const html = renderReceiptHtml(data, empty, "80");
  for (const bad of ["Tel.", "WhatsApp", "<img", "REIMPRESIÓN", "RFC"]) assert.equal(html.includes(bad), false, bad);
  const full = renderReceiptHtml(data, { ...empty, address: "Calle 1\nCol. Centro", phone: "55 1234 5678", whatsapp: "55 8765 4321", contactInfo: "hola@example.com", taxInfo: "RFC XAXX010101000", footerMessage: "Vuelva pronto", returnPolicy: "Cambios en 7 días", logoData: PNG }, "80");
  for (const needle of ["Calle 1<br>Col. Centro", "Tel. 55 1234 5678", "WhatsApp 55 8765 4321", "hola@example.com", "RFC XAXX010101000", "Vuelva pronto", "Cambios en 7 días", `src="${PNG}"`]) assert.ok(full.includes(needle), needle);
  assert.equal(full.includes("¡Gracias por su compra!"), false, "a custom footer replaces the default one");
});
test("untrusted text is escaped everywhere and cannot inject markup, scripts or attributes", () => {
  const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>"'&\``;
  const html = renderReceiptHtml(
    { ...data, seller: evil, items: [{ name: evil, sku: evil, quantity: 1, unitPrice: "1.00", subtotal: "1.00" }] },
    { ...empty, name: evil, address: evil, phone: null, footerMessage: evil, returnPolicy: evil, contactInfo: evil, taxInfo: evil, logoData: `data:image/png;base64,AAAA" onerror="alert(3)` },
    "58"
  );
  assert.equal(/<script/i.test(html.replace(/<style[\s\S]*?<\/style>/, "")), false);
  assert.equal(/<img[^>]*onerror/i.test(html), false);
  assert.equal(/<img/.test(html), false, "a malformed logo is dropped, never interpolated");
  assert.ok(html.includes("&#60;SCRIPT&#62;") || html.includes("&#60;script&#62;"));
  assert.equal(escapeHtml(`<>&"'`), "&#60;&#62;&#38;&#34;&#39;");
});
test("80 mm and 58 mm use different paper and content widths", () => {
  const w80 = renderReceiptHtml(data, empty, "80");
  const w58 = renderReceiptHtml(data, empty, "58");
  assert.ok(w80.includes("size: 80mm auto") && w80.includes("width: 72mm"));
  assert.ok(w58.includes("size: 58mm auto") && w58.includes("width: 48mm"));
  assert.notEqual(w80, w58);
});
test("a reprint is marked as a copy; the first print is not", () => {
  assert.ok(renderReceiptHtml(data, empty, "80", { copy: true }).includes("REIMPRESIÓN"));
  assert.equal(renderReceiptHtml(data, empty, "80", { copy: false }).includes("REIMPRESIÓN"), false);
});
test("the ticket is black and white only (thermal friendly)", () => {
  const css = renderReceiptHtml(data, empty, "80").match(/<style>([\s\S]*?)<\/style>/)[1];
  const colors = css.match(/#[0-9a-fA-F]{3,6}\b/g) ?? [];
  for (const c of colors) assert.ok(["#000", "#fff"].includes(c.toLowerCase()), "non B/W color " + c);
});
