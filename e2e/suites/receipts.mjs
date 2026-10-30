// Receipts suite: Estetica Leal ticket, commercial settings and the printing path.
// No physical or thermal printer is used. Printing is exercised through the development-only automation of the main
// process (POS_PRINT_MODE_FILE): "pdf" renders the real print document to a PDF (paper size is checked in the file),
// "cancel" and "fail" simulate a cancelled or failed print. The system print dialog itself is not automated.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_URL, ui, ipc, expect, closeStrayCash } from "../lib/harness.mjs";

const PRINT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pos-print-"));
const MODE_FILE = path.join(PRINT_DIR, "mode.txt");
fs.writeFileSync(MODE_FILE, "pdf");
export const env = { POS_PRINT_MODE_FILE: MODE_FILE, POS_PRINT_PDF_DIR: PRINT_DIR };

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const J = JSON.stringify;

export async function run(c) {
  const { page, db, data, test } = c;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const num = (v) => Number(v);
  const setMode = (m) => fs.writeFileSync(MODE_FILE, m);
  const counts = () => one("select (select count(*) from sales)::int s, (select count(*) from sale_items)::int i, (select count(*) from inventory_movements)::int m, (select count(*) from cash_movements)::int c, (select coalesce(sum(stock),0) from products)::int st");
  const settingsRow = () => one("select * from business_settings where id=1");
  const pdfWidthMm = (file) => {
    const t = fs.readFileSync(file).toString("latin1");
    const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(t);
    return m ? { w: (Number(m[1]) / 72) * 25.4, h: (Number(m[2]) / 72) * 25.4 } : null;
  };
  const toast = (re) => page.getByText(re).first().waitFor({ timeout: 6000 });

  const admin = await data.user("REC_ADMIN", "admin");
  const vendor = await data.user("REC_VEND", "vendor");
  const other = await data.user("REC_OTHER", "vendor");
  await closeStrayCash(db, admin.id);
  const pA = await data.product("RA", "100.00", 100);
  const pB = await data.product("RB", "1034.50", 100);
  const pX = await data.product("RX", "10.00", 100);
  const sess = (await one("insert into cash_sessions(opened_by,initial_amount,current_amount,status,opened_at,closed_at,closed_by,final_amount) values($1,'0','0','closed',$2,$3,$1,'0') returning id", [admin.id, new Date(2026, 4, 1, 8), new Date(2026, 4, 1, 20)])).id;
  const mkSale = async (userId, total, method, at, items) => {
    const s = await one("insert into sales(user_id,cash_session_id,total,payment_method,created_at) values($1,$2,$3,$4,$5) returning id", [userId, sess, total, method, at]);
    for (const it of items) await db.query("insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal,product_name,product_sku) values($1,$2,$3,$4,$5,$6,$7)", [s.id, it.p.id, it.q, it.price, (num(it.price) * it.q).toFixed(2), it.name, it.sku]);
    return s.id;
  };
  const evil = `<img src=x onerror="window.__xss=1">&<script>window.__xss=2</script>`;
  const sCash = await mkSale(admin.id, "1234.50", "cash", new Date(2026, 4, 1, 14, 5), [
    { p: pA, q: 2, price: "100.00", name: "Shampoo reparador 500 ml", sku: "SH-500" },
    { p: pB, q: 1, price: "1034.50", name: "Tinte profesional 7.1", sku: "TI-71" },
  ]);
  const sCard = await mkSale(vendor.id, "30.00", "card", new Date(2026, 4, 1, 15, 30), [{ p: pX, q: 3, price: "10.00", name: "Cera modeladora", sku: "CE-1" }]);
  const sEvil = await mkSale(admin.id, "10.00", "cash", new Date(2026, 4, 1, 16, 0), [{ p: pX, q: 1, price: "10.00", name: evil, sku: "EV-1" }]);
  const sOther = await mkSale(other.id, "10.00", "cash", new Date(2026, 4, 1, 17, 0), [{ p: pX, q: 1, price: "10.00", name: "Venta de otro vendedor", sku: "OT-1" }]);
  const preview = async (id, copy) => {
    const r = await ipc(page, `api.receipts.preview(${id}${copy === undefined ? "" : "," + copy})`);
    expect(r.ok, "preview of " + id + ": " + J(r));
    return r.v;
  };
  const iframe = () => page.frameLocator('iframe[title="Vista previa del recibo"]');
  const openPreview = async (id, button = "Ver recibo") => {
    await ui.nav(page, "Historial");
    await page.locator("#hs-q").fill(String(id));
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await page.getByRole("button", { name: `Ver venta ${id}` }).click();
    await page.getByRole("dialog").getByRole("button", { name: button }).click();
    await page.getByRole("dialog").filter({ hasText: `Recibo de la venta #${id}` }).waitFor();
  };
  const closeAll = async () => {
    for (let i = 0; i < 5; i++) {
      if ((await page.getByRole("dialog").count()) === 0) return;
      await page.keyboard.press("Escape");
      await page.waitForTimeout(350);
    }
  };

  await test("REC-00.admin_logs_in", "e2e", async () => {
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
  });

  // ================================================================== commercial settings
  await test("REC-01.defaults_name_only_and_every_optional_field_empty", "e2e", async () => {
    await ui.nav(page, "Configuración");
    await page.getByRole("heading", { name: "Configuración comercial" }).waitFor();
    await page.waitForFunction(() => document.querySelector("#bs-name")?.value === "Estética Leal", null, { timeout: 8000 });
    for (const id of ["bs-address", "bs-phone", "bs-whatsapp", "bs-tax", "bs-contact", "bs-footer", "bs-policy"]) {
      expect((await page.locator("#" + id).inputValue()) === "", id + " starts empty (nothing is invented)");
    }
    expect((await page.locator("#bs-paper").inputValue()) === "80", "80 mm by default");
    const row = await settingsRow();
    expect(row.name === "Estética Leal" && row.address === null && row.logo_data === null, "database defaults");
    const html = (await preview(sCash)).html;
    for (const bad of ["Tel.", "WhatsApp", "<img", "RFC"]) expect(!html.includes(bad), "empty optional data is not printed: " + bad);
    expect(html.includes("ESTÉTICA LEAL") && html.includes("¡Gracias por su compra!") && html.includes("No es una factura fiscal"), "brand, default thanks and the non-fiscal notice");
  });
  await test("REC-02.saving_settings_persists_and_shows_up_on_the_ticket", "e2e", async () => {
    await page.locator("#bs-address").fill("Av. Reforma 100\nCol. Centro");
    await page.locator("#bs-phone").fill("55 1234 5678");
    await page.locator("#bs-whatsapp").fill("+52 55 8765 4321");
    await page.locator("#bs-contact").fill("hola@ejemplo.test");
    await page.locator("#bs-footer").fill("Vuelva pronto");
    await page.locator("#bs-policy").fill("Cambios dentro de 7 días con ticket.");
    await page.getByRole("button", { name: "Guardar configuración" }).click();
    await toast(/Configuración guardada/);
    const row = await settingsRow();
    expect(row.address === "Av. Reforma 100\nCol. Centro" && row.phone === "55 1234 5678" && row.whatsapp === "+52 55 8765 4321" && row.footer_message === "Vuelva pronto" && row.updated_by === admin.id, "persisted: " + J(row));
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#bs-phone")?.value === "55 1234 5678", null, { timeout: 8000 });
    const html = (await preview(sCash)).html;
    for (const needle of ["Av. Reforma 100<br>Col. Centro", "Tel. 55 1234 5678", "WhatsApp +52 55 8765 4321", "hola@ejemplo.test", "Vuelva pronto", "Cambios dentro de 7 días"]) expect(html.includes(needle), "on the ticket: " + needle);
    expect(!html.includes("¡Gracias por su compra!"), "custom footer replaces the default thanks");
    expect(!html.includes("RFC"), "tax data still empty -> not printed");
  });
  await test("REC-03.invalid_settings_are_rejected_without_changing_anything", "security", async () => {
    const before = await settingsRow();
    await page.locator("#bs-phone").fill("llámame <ya>");
    await page.getByRole("button", { name: "Guardar configuración" }).click();
    await toast(/Teléfono/);
    expect(J(await settingsRow()) === J(before), "unchanged after an invalid phone");
    await page.locator("#bs-phone").fill("55 1234 5678");
    const bad = [
      ["{name:'x',isAdmin:true}", "CAMPO_NO_PERMITIDO"], ["{name:''}", "CAMPO_INVALIDO"], ["{name:'x',paperWidth:'70'}", "FORMATO_INVALIDO"],
      ["{name:'x',silentPrint:true}", "CAMPO_INVALIDO"], ["{name:'x'.repeat(200)}", "CAMPO_INVALIDO"], ["{name:'x',logoData:'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='}", "LOGO_INVALIDO"],
      ["{name:'x',logoData:'data:image/png;base64,AAAA'}", "LOGO_INVALIDO"], ["{name:'x\\u0000y'}", "CAMPO_INVALIDO"], ["null", "CONFIGURACION_INVALIDA"],
    ];
    for (const [expr, code] of bad) {
      const r = await ipc(page, `api.settings.updateBusiness(${expr})`);
      expect(r.ok === false && r.err.includes(`[${code}]`), `${expr.slice(0, 40)} -> ${code}: ${J(r)}`);
    }
    expect(J(await settingsRow()) === J(before), "nothing changed after every rejected attempt");
  });
  await test("REC-04.logo_upload_replace_and_remove", "e2e", async () => {
    await page.reload();
    await page.waitForFunction(() => document.querySelector("#bs-name")?.value === "Estética Leal", null, { timeout: 8000 });
    await page.getByLabel("Seleccionar logotipo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: PNG_1PX });
    await page.getByRole("button", { name: "Guardar configuración" }).click();
    await toast(/Configuración guardada/);
    const row = await settingsRow();
    expect(row.logo_data && row.logo_data.startsWith("data:image/png;base64,"), "logo stored as a PNG data URL");
    expect((await preview(sCash)).html.includes(`<img class="logo" alt="" src="data:image/png;base64,`), "the ticket carries the logo");
    await page.getByRole("img", { name: "Logotipo actual" }).waitFor();
    // an oversized or wrong-type file is refused in the screen before anything is sent
    await page.getByLabel("Seleccionar logotipo").setInputFiles({ name: "big.png", mimeType: "image/png", buffer: Buffer.alloc(210 * 1024, 1) });
    await toast(/no puede superar 200 KB/);
    await page.getByLabel("Seleccionar logotipo").setInputFiles({ name: "x.svg", mimeType: "image/svg+xml", buffer: Buffer.from("<svg/>") });
    await toast(/PNG o JPEG/);
    // saving other fields keeps the logo; removing it clears it
    await page.locator("#bs-footer").fill("Vuelva pronto");
    await page.getByRole("button", { name: "Guardar configuración" }).click();
    await toast(/Configuración guardada/);
    expect((await settingsRow()).logo_data === row.logo_data, "an unrelated save keeps the stored logo");
    await page.getByRole("button", { name: "Quitar logotipo" }).click();
    await page.getByRole("button", { name: "Guardar configuración" }).click();
    await toast(/Configuración guardada/);
    expect((await settingsRow()).logo_data === null, "logo removed");
    expect(!(await preview(sCash)).html.includes("<img"), "no logo, no image on the ticket");
  });
  await test("REC-05.settings_are_admin_only", "security", async () => {
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, vendor.pin);
    await page.waitForURL(/#\/sales$/, { timeout: 8000 });
    for (const expr of ["api.settings.getBusiness()", "api.settings.updateBusiness({name:'Hackeado'})", "api.receipts.listPrinters()"]) {
      const r = await ipc(page, expr);
      expect(r.ok === false && /No autorizado/.test(r.err), expr + " refused for a vendor: " + J(r));
    }
    expect((await settingsRow()).name === "Estética Leal", "the name was not changed");
    await page.goto(APP_URL + "/#/settings");
    await page.waitForTimeout(500);
    expect(!new URL(page.url()).hash.startsWith("#/settings"), "vendor redirected away from the settings screen");
    expect(await page.locator("nav").getByRole("link", { name: "Configuración" }).count() === 0, "vendor has no Configuración link");
  });

  // ================================================================== ticket content
  await test("REC-06.ticket_content_cash_card_multi_item_snapshot_and_money", "integration", async () => {
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    const r = await preview(sCash);
    const html = r.html;
    for (const needle of [`#${sCash}`, "01/05/2026 14:05", "Shampoo reparador 500 ml", "2 x $100.00", "$200.00", "Tinte profesional 7.1", "1 x $1,034.50", "$1,034.50", "TOTAL", "$1,234.50", "Efectivo", "Artículos", ">3<", admin.name]) expect(html.includes(needle), "cash ticket has: " + needle);
    expect(!html.includes("REIMPRESIÓN"), "not a copy");
    expect(r.width === "80" && r.folio === sCash, "metadata");
    const card = (await preview(sCard)).html;
    expect(card.includes("Tarjeta") && card.includes("3 x $10.00") && card.includes("$30.00") && card.includes("Cera modeladora"), "card ticket");
    // renamed catalog product: the ticket keeps what was sold
    await db.query("update products set name='Shampoo NUEVO NOMBRE' where id=$1", [pA.id]);
    expect((await preview(sCash)).html.includes("Shampoo reparador 500 ml") && !(await preview(sCash)).html.includes("NUEVO NOMBRE"), "ticket keeps the name as sold");
    expect((await preview(sCash, true)).html.includes("REIMPRESIÓN"), "copy flag marks a reprint");
    const missing = await ipc(page, "api.receipts.preview(99999999)");
    expect(missing.ok === false && /\[VENTA_NO_ENCONTRADA\]/.test(missing.err), "unknown sale: " + J(missing));
    for (const bad of ["0", "-1", "'1'", "1.5", "null", "{}"]) {
      const b = await ipc(page, `api.receipts.preview(${bad})`);
      expect(b.ok === false && /\[VENTA_INVALIDA\]/.test(b.err), `invalid id ${bad} rejected: ${J(b)}`);
    }
  });
  await test("REC-07.untrusted_content_is_escaped_in_the_html_and_in_the_visible_preview", "security", async () => {
    const html = (await preview(sEvil)).html;
    const body = html.replace(/<style>[\s\S]*?<\/style>/, "");
    expect(!/<script/i.test(body) && !/<img[^>]*onerror/i.test(body), "no live markup in the generated document");
    expect(/&#60;img src=x onerror=/.test(html), "the hostile text is present, escaped");
    await openPreview(sEvil);
    await iframe().getByText("onerror=", { exact: false }).first().waitFor({ timeout: 8000 });
    expect(await page.evaluate(() => window.__xss === undefined), "nothing executed in the app window");
    expect(await iframe().locator("img").count() === 0 && (await iframe().locator("script").count()) === 0, "no img/script element exists inside the preview");
    await closeAll();
  });

  // ================================================================== printing
  await test("REC-08.print_writes_the_document_at_80mm_and_58mm_and_never_touches_the_sale", "e2e", async () => {
    const before = await counts();
    await openPreview(sCash);
    await page.getByRole("dialog").filter({ hasText: `Recibo de la venta #${sCash}` }).getByRole("button", { name: "Imprimir" }).click();
    await page.getByTestId("print-status").getByText(/Recibo enviado a imprimir/).waitFor({ timeout: 15000 });
    const f80 = path.join(PRINT_DIR, `receipt-${sCash}-80mm.pdf`);
    expect(fs.existsSync(f80) && fs.readFileSync(f80).subarray(0, 5).toString() === "%PDF-" && fs.statSync(f80).size > 1500, "an 80 mm PDF was produced");
    const d80 = pdfWidthMm(f80);
    expect(d80 && Math.abs(d80.w - 80) < 2.5, "page width is 80 mm: " + J(d80));
    await closeAll();
    expect(J(await counts()) === J(before), "printing wrote nothing to the database");
    // switch the paper to 58 mm in the settings screen and print again
    await ui.nav(page, "Configuración");
    await page.waitForFunction(() => document.querySelector("#bs-name")?.value === "Estética Leal", null, { timeout: 8000 });
    await page.locator("#bs-paper").selectOption("58");
    await page.getByRole("button", { name: "Guardar configuración" }).click();
    await toast(/Configuración guardada/);
    await openPreview(sCash);
    await page.getByRole("dialog").filter({ hasText: `Recibo de la venta #${sCash}` }).getByRole("button", { name: "Imprimir" }).click();
    await page.getByTestId("print-status").getByText(/Recibo enviado a imprimir/).waitFor({ timeout: 15000 });
    const f58 = path.join(PRINT_DIR, `receipt-${sCash}-58mm.pdf`);
    const d58 = fs.existsSync(f58) ? pdfWidthMm(f58) : null;
    expect(d58 && Math.abs(d58.w - 58) < 2.5, "page width is 58 mm: " + J(d58));
    expect((await preview(sCash)).width === "58" && (await preview(sCash)).html.includes("width: 48mm"), "the 58 mm layout is used");
    await closeAll();
    expect(J(await counts()) === J(before), "still nothing written");
    await ui.nav(page, "Configuración");
    await page.locator("#bs-paper").selectOption("80");
    await page.getByRole("button", { name: "Guardar configuración" }).click();
    await toast(/Configuración guardada/);
  });
  await test("REC-09.cancelled_and_failed_prints_leave_the_sale_untouched_and_can_be_retried", "e2e", async () => {
    const before = await counts();
    for (const [mode, text] of [["cancel", /Impresión cancelada/], ["fail", /No se pudo imprimir/]]) {
      setMode(mode);
      await openPreview(sCard);
      await page.getByRole("dialog").filter({ hasText: `Recibo de la venta #${sCard}` }).getByRole("button", { name: "Imprimir" }).click();
      await page.getByTestId("print-status").getByText(text).waitFor({ timeout: 10000 });
      await closeAll();
    }
    expect(J(await counts()) === J(before), "no sale or movement created or reverted by cancel/fail");
    setMode("pdf");
    await openPreview(sCard);
    await page.getByRole("dialog").filter({ hasText: `Recibo de la venta #${sCard}` }).getByRole("button", { name: "Imprimir" }).click();
    await page.getByTestId("print-status").getByText(/Recibo enviado a imprimir/).waitFor({ timeout: 15000 });
    await closeAll();
    expect(fs.existsSync(path.join(PRINT_DIR, `receipt-${sCard}-80mm.pdf`)), "the retry printed");
    expect(J(await counts()) === J(before), "still no writes");
  });
  await test("REC-10.print_failure_after_a_real_checkout_does_not_undo_or_duplicate_the_sale", "e2e", async () => {
    const pSell = await data.product("RSELL", "7.00", 20);
    await ui.openCash(page, 20);
    const n0 = (await one("select count(*)::int n from sales")).n;
    setMode("fail");
    await ui.nav(page, "Vender");
    await page.getByPlaceholder("Código, SKU o nombre...").fill(pSell.sku);
    await page.getByRole("option", { name: new RegExp(pSell.name) }).first().click();
    await page.getByRole("button", { name: "Pagar" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Completar Venta" }).click();
    const dlg = page.getByRole("dialog").filter({ hasText: "Venta Completada" });
    await dlg.getByText("✓ Venta registrada").waitFor({ timeout: 8000 });
    const sale = await one("select id, total from sales order by id desc limit 1");
    await dlg.getByRole("button", { name: "Imprimir" }).click();
    await dlg.getByTestId("print-status").getByText(/No se pudo imprimir/).waitFor({ timeout: 10000 });
    await dlg.getByText(/La venta ya quedó registrada/).waitFor();
    await dlg.getByText("✓ Venta registrada").waitFor(); // the sale status is independent of the printer
    expect((await one("select count(*)::int n from sales")).n === n0 + 1, "exactly one sale after the failed print");
    setMode("pdf");
    await dlg.getByRole("button", { name: "Imprimir" }).click();
    await dlg.getByTestId("print-status").getByText(/Recibo enviado a la impresora/).waitFor({ timeout: 15000 });
    expect(fs.existsSync(path.join(PRINT_DIR, `receipt-${sale.id}-80mm.pdf`)), "the retry produced the ticket of THAT sale");
    expect((await one("select count(*)::int n from sales")).n === n0 + 1, "retrying the print does not duplicate the sale");
    await dlg.getByRole("button", { name: "Ver recibo" }).click();
    await iframe().getByText(`#${sale.id}`).first().waitFor({ timeout: 8000 });
    await closeAll();
    await dlg.getByRole("button", { name: "Nueva venta" }).click();
    await ui.nav(page, "Caja");
    await ui.closeCash(page);
  });
  await test("REC-11.print_permissions_and_concurrency", "security", async () => {
    setMode("pdf");
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, vendor.pin);
    await page.waitForURL(/#\/sales$/, { timeout: 8000 });
    const own = await ipc(page, `api.receipts.print(${sCard})`);
    expect(own.ok && own.v.status === "printed", "a vendor prints their own sale: " + J(own));
    const foreign = await ipc(page, `api.receipts.print(${sOther})`);
    expect(foreign.ok === false && /\[VENTA_NO_ENCONTRADA\]/.test(foreign.err), "but not another seller's: " + J(foreign));
    expect(!fs.existsSync(path.join(PRINT_DIR, `receipt-${sOther}-80mm.pdf`)), "no document was produced for the foreign sale");
    const both = await ipc(page, `Promise.allSettled([api.receipts.print(${sCard}), api.receipts.print(${sCard})]).then(rs => rs.map(r => r.status === 'fulfilled' ? r.value.status : String(r.reason.message))) `);
    expect(both.ok && both.v.some((x) => x === "printed") && both.v.every((x) => x === "printed" || /\[IMPRESION_EN_CURSO\]/.test(x)), "two simultaneous prints: one prints, the other is refused or also printed: " + J(both));
    const bad = await ipc(page, "api.receipts.print('1')");
    expect(bad.ok === false && /\[VENTA_INVALIDA\]/.test(bad.err), "id validated");
  });
  await test("REC-12.print_automation_hooks_are_development_only", "security", async () => {
    const src = fs.readFileSync(new URL("../../src/backend/receipt-service.ts", import.meta.url), "utf8");
    expect(/if \(app\.isPackaged\) return null;/.test(src), "the print automation returns early in a packaged app");
  });

  fs.rmSync(PRINT_DIR, { recursive: true, force: true });
}
