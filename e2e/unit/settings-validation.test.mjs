import test from "node:test";
import assert from "node:assert/strict";
import { parseBusinessSettings, validateLogo, MAX_LOGO_BYTES } from "../../src/backend/settings-validation.ts";

const code = (fn) => { try { fn(); } catch (e) { return String(e.message).match(/^\[(\w+)\]/)?.[1] ?? "OTHER"; } return null; };
const png = (extra = 0) => "data:image/png;base64," + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32 + extra)]).toString("base64");
const jpeg = "data:image/jpeg;base64," + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]).toString("base64");

test("only the name is required; empty optional fields become null and defaults apply", () => {
  const r = parseBusinessSettings({ name: "  Estética Leal  ", address: "", phone: "   " });
  assert.deepEqual(r, { name: "Estética Leal", address: null, phone: null, whatsapp: null, taxInfo: null, footerMessage: null, returnPolicy: null, contactInfo: null, logoData: undefined, paperWidth: "80", printerName: null, silentPrint: false });
  assert.equal(code(() => parseBusinessSettings({})), "CAMPO_INVALIDO");
  assert.equal(code(() => parseBusinessSettings({ name: "  " })), "CAMPO_INVALIDO");
});
test("unknown fields and non-objects are rejected", () => {
  assert.equal(code(() => parseBusinessSettings({ name: "x", isAdmin: true })), "CAMPO_NO_PERMITIDO");
  for (const bad of [null, "x", [], 3]) assert.equal(code(() => parseBusinessSettings(bad)), "CONFIGURACION_INVALIDA");
});
test("length limits and control characters", () => {
  assert.equal(code(() => parseBusinessSettings({ name: "x".repeat(121) })), "CAMPO_INVALIDO");
  assert.equal(code(() => parseBusinessSettings({ name: "ok", returnPolicy: "x".repeat(601) })), "CAMPO_INVALIDO");
  assert.equal(code(() => parseBusinessSettings({ name: "bad\u0000name" })), "CAMPO_INVALIDO");
  assert.equal(code(() => parseBusinessSettings({ name: "line1\nline2" })), "CAMPO_INVALIDO", "single-line fields refuse newlines");
  assert.equal(parseBusinessSettings({ name: "ok", address: "l1\r\nl2" }).address, "l1\nl2", "multi-line fields normalise CRLF");
  assert.equal(code(() => parseBusinessSettings({ name: "ok", footerMessage: "a‮b" })), "CAMPO_INVALIDO", "bidi override");
});
test("HTML is accepted as plain text (it is escaped when printed), never interpreted", () => {
  const r = parseBusinessSettings({ name: "<b>Leal</b>", footerMessage: "<script>x</script>" });
  assert.equal(r.name, "<b>Leal</b>");
});
test("phones", () => {
  assert.equal(parseBusinessSettings({ name: "ok", phone: "+52 (55) 1234-5678" }).phone, "+52 (55) 1234-5678");
  assert.equal(code(() => parseBusinessSettings({ name: "ok", whatsapp: "call me <now>" })), "CAMPO_INVALIDO");
});
test("paper width is 80 or 58 only", () => {
  assert.equal(parseBusinessSettings({ name: "ok", paperWidth: "58" }).paperWidth, "58");
  for (const bad of ["70", 80, "", null]) assert.equal(code(() => parseBusinessSettings({ name: "ok", paperWidth: bad })), "FORMATO_INVALIDO", String(bad));
});
test("silent printing needs a printer", () => {
  assert.equal(code(() => parseBusinessSettings({ name: "ok", silentPrint: true })), "CAMPO_INVALIDO");
  assert.equal(parseBusinessSettings({ name: "ok", silentPrint: true, printerName: "TM-T20" }).silentPrint, true);
  assert.equal(code(() => parseBusinessSettings({ name: "ok", silentPrint: "yes" })), "CAMPO_INVALIDO");
});
test("logo: real PNG/JPEG data URLs of limited size; undefined keeps, null removes", () => {
  assert.equal(parseBusinessSettings({ name: "ok", logoData: png() }).logoData, png());
  assert.equal(parseBusinessSettings({ name: "ok", logoData: jpeg }).logoData, jpeg);
  assert.equal(parseBusinessSettings({ name: "ok", logoData: null }).logoData, null);
  assert.equal(parseBusinessSettings({ name: "ok", logoData: "" }).logoData, null);
  assert.equal(parseBusinessSettings({ name: "ok" }).logoData, undefined);
  const bad = [
    "http://example.com/logo.png",
    "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    "data:image/png;base64,###",
    "data:text/html;base64,PHNjcmlwdD4=",
    "data:image/png;base64,AAAA",
    'data:image/png;base64,AAAA" onerror="x',
    png(MAX_LOGO_BYTES),
    "data:image/jpeg;base64," + Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString("base64"),
    42,
  ];
  for (const b of bad) assert.equal(code(() => parseBusinessSettings({ name: "ok", logoData: b })), "LOGO_INVALIDO", String(b).slice(0, 40));
  assert.equal(code(() => validateLogo("nope")), "LOGO_INVALIDO");
});
