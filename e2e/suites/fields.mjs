// Fields suite: every editable control of the application must be recognisable BEFORE it is focused. Nothing here is a
// snapshot comparison: each field is measured in the real window (computed border, fill, text and placeholder colours,
// composited over its real background) and checked against WCAG 2.2 1.4.11 (control boundary >= 3:1), 1.4.3 (text and
// placeholder >= 4.5:1) and 2.4.7 (a visible focus indicator). Screenshots go to e2e-artifacts (ignored by Git) at
// 1024x768, 1366x768 and 1920x1080. FIELDS_PHASE=before only records (it is how the "before" pictures were taken).
import path from "node:path";
import fs from "node:fs";
import { APP_URL, ui, expect, closeStrayCash } from "../lib/harness.mjs";

const VIEWPORTS = [[1024, 768], [1366, 768], [1920, 1080]];
const PHASE = process.env.FIELDS_PHASE === "before" ? "before" : "after";
const J = JSON.stringify;

// Runs in the page (installed as window.__pickFields): the editable fields the operator can actually reach now. With a
// dialog open only its own fields count (the screen behind it is covered and inert). The cart quantity stepper is a
// designed control between the - and + buttons and is not a form field in the sense of this audit.
function pickFields() {
  const root = document.querySelector('[role="dialog"], [role="alertdialog"]') || document;
  return [...root.querySelectorAll("input, select, textarea")].filter((el) => {
    if (["hidden", "checkbox", "radio", "file", "button", "submit"].includes(el.type)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden" && !el.closest('[data-testid="cart-line"]');
  });
}

// Runs in the page. Returns one record per visible editable field of the current screen (dialogs included).
function measureFields() {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (css) => {
    g.clearRect(0, 0, 1, 1);
    g.fillStyle = "#000";
    g.fillStyle = css;
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const over = (fg, bg) => [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3]));
  const lum = (c) => {
    const [r, gg, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * gg + 0.0722 * b;
  };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  // background actually seen behind a box: ancestors composited from the page down (the element itself excluded unless asked)
  const backdrop = (el, includeSelf) => {
    const chain = [];
    for (let n = includeSelf ? el : el.parentElement; n; n = n.parentElement) chain.unshift(n);
    let base = [255, 255, 255];
    for (const n of chain) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) base = over(c, base); }
    return base;
  };
  const label = (el) => (el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].textContent) || el.placeholder || el.id || el.name || el.tagName).toString().trim().slice(0, 48);
  const out = [];
  for (const el of window.__pickFields()) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const around = backdrop(el, false);
    const fill = backdrop(el, true);
    const border = over(rgba(cs.borderTopColor), around);
    const bw = Math.min(...["Top", "Right", "Bottom", "Left"].map((s) => parseFloat(cs[`border${s}Width`]) || 0));
    const placeholder = el.placeholder && !el.value ? ratio(rgba(getComputedStyle(el, "::placeholder").color), fill) : null;
    out.push({
      label: label(el), tag: el.tagName.toLowerCase(), type: el.type || "", disabled: el.disabled,
      borderWidth: bw, radius: parseFloat(cs.borderTopLeftRadius) || 0, height: Math.round(r.height), width: Math.round(r.width),
      borderContrast: +ratio(border, around).toFixed(2), fillContrast: +ratio(fill, around).toFixed(2),
      textContrast: +ratio(over(rgba(cs.color), fill), fill).toFixed(2), placeholderContrast: placeholder === null ? null : +placeholder.toFixed(2),
    });
  }
  return out;
}

// Runs in the page for ONE field (by index among the visible editable fields): focus and invalid appearance.
function probeField(index) {
  const el = window.__pickFields()[index];
  if (!el) return null;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (css) => { g.clearRect(0, 0, 1, 1); g.fillStyle = "#000"; g.fillStyle = css; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const lum = (c) => { const [r, gg, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * gg + 0.0722 * b; };
  const ratio = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
  const backdrop = (n0) => { const chain = []; for (let n = n0.parentElement; n; n = n.parentElement) chain.unshift(n); let base = [255, 255, 255]; for (const n of chain) { const c = rgba(getComputedStyle(n).backgroundColor); if (c[3] > 0) base = [0, 1, 2].map((i) => c[i] * c[3] + base[i] * (1 - c[3])); } return base; };
  const around = backdrop(el);
  const edge = () => { const cs = getComputedStyle(el); const c = rgba(cs.borderTopColor); const b = [0, 1, 2].map((i) => c[i] * c[3] + around[i] * (1 - c[3])); return { color: b.map(Math.round).join(","), contrast: +ratio(b, around).toFixed(2) }; };
  const result = { label: el.getAttribute("aria-label") || el.id || el.placeholder || el.tagName, normal: edge() };
  const wasInvalid = el.getAttribute("aria-invalid");
  el.setAttribute("aria-invalid", "true");
  result.invalid = edge();
  if (wasInvalid === null) el.removeAttribute("aria-invalid"); else el.setAttribute("aria-invalid", wasInvalid);
  const wasDisabled = el.disabled;
  const enabledCs = getComputedStyle(el);
  const before = { opacity: enabledCs.opacity, bg: enabledCs.backgroundColor };
  el.disabled = true;
  const dcs = getComputedStyle(el);
  result.disabled = { distinct: dcs.opacity !== before.opacity || dcs.backgroundColor !== before.bg, opacity: dcs.opacity, borderWidth: dcs.borderTopWidth };
  el.disabled = wasDisabled;
  return result;
}

export async function run(c) {
  const { page, app, db, data, test, artifacts } = c;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const admin = await data.user("FLD_ADMIN", "admin");
  await closeStrayCash(db, admin.id);
  const prods = [];
  for (let i = 0; i < 4; i++) prods.push(await data.product("FLD" + i, (5 + i * 3.25).toFixed(2), 40 + i));
  const sess = (await one("insert into cash_sessions(opened_by,initial_amount,current_amount,status,opened_at,closed_at,closed_by,final_amount) values($1,'0','0','closed',$2,$3,$1,'0') returning id", [admin.id, new Date(2026, 5, 1, 8), new Date(2026, 5, 1, 20)])).id;
  const sale = (await one("insert into sales(user_id,cash_session_id,total,payment_method,created_at) values($1,$2,'30.00','cash',$3) returning id", [admin.id, sess, new Date(2026, 5, 1, 12)])).id;
  await db.query("insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal,product_name,product_sku) values($1,$2,3,'10.00','30.00',$3,$4)", [sale, prods[0].id, "Producto FLD", "FLD-0"]);

  const results = {};
  const resize = async (w, h) => {
    await app.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows()[0].setContentSize(s[0], s[1]); }, [w, h]);
    await page.waitForTimeout(250);
  };
  const shot = (name, w, h) => page.screenshot({ path: path.join(artifacts, `fields-${PHASE}-${name}-${w}x${h}.png`) }).catch(() => {});
  const closeAll = async () => { for (let i = 0; i < 5; i++) { if ((await page.getByRole("dialog").count()) + (await page.getByRole("alertdialog").count()) === 0) return; await page.keyboard.press("Escape"); await page.waitForTimeout(300); } };

  /** Measures the current screen at the three sizes, probes focus/invalid/disabled at 1366x768, and asserts the thresholds. */
  async function audit(id, screen) {
    const fields = [];
    for (const [w, h] of VIEWPORTS) {
      await resize(w, h);
      // the field that happens to hold the focus (the search box autofocuses) would be measured in its focused look
      await page.evaluate(`window.__pickFields = ${pickFields.toString()}; document.activeElement && document.activeElement.blur && document.activeElement.blur()`);
      await shot(screen, w, h);
      if (w === 1366) {
        const m = await page.evaluate(measureFields);
        fields.push(...m);
        if (m.length) {
          const probes = [];
          for (let i = 0; i < m.length; i++) probes.push(await page.evaluate(probeField, i));
          results[screen] = { fields: m, probes };
          const focusInfo = await page.evaluate(() => {
            const el = window.__pickFields().find((x) => !x.disabled);
            if (!el) return null;
            el.focus();
            const cs = getComputedStyle(el);
            return { label: el.getAttribute("aria-label") || el.id || el.placeholder, boxShadow: cs.boxShadow, outline: `${cs.outlineStyle} ${cs.outlineWidth}`, borderColor: cs.borderTopColor, focusVisible: el.matches(":focus-visible") };
          });
          await shot(`${screen}-focus`, w, h);
          if (focusInfo) { results[screen].focus = focusInfo; await page.evaluate(() => document.activeElement && document.activeElement.blur()); }
          // forced invalid + disabled picture of the first field, then restored
          await page.evaluate(() => { const el = window.__pickFields()[0]; if (el) el.setAttribute("aria-invalid", "true"); });
          await shot(`${screen}-invalid`, w, h);
          await page.evaluate(() => { const el = document.querySelector('[aria-invalid="true"]'); if (el) { el.removeAttribute("aria-invalid"); el.disabled = true; el.dataset.fldDisabled = "1"; } });
          await shot(`${screen}-disabled`, w, h);
          await page.evaluate(() => { const el = document.querySelector('[data-fld-disabled="1"]'); if (el) { el.disabled = false; delete el.dataset.fldDisabled; } });
        }
      }
    }
    if (PHASE === "before") return;
    const r = results[screen];
    expect(r && r.fields.length > 0, `${id}: no editable field found on ${screen}`);
    const bad = [];
    for (const f of r.fields) {
      if (f.borderWidth < 1) bad.push(`${f.label}: no border`);
      if (f.radius < 4) bad.push(`${f.label}: square corners (${f.radius}px)`);
      if (f.borderContrast < 3 && !f.disabled) bad.push(`${f.label}: border ${f.borderContrast}:1 (<3:1)`);
      if (f.textContrast < 4.5) bad.push(`${f.label}: text ${f.textContrast}:1`);
      if (f.placeholderContrast !== null && f.placeholderContrast < 4.5) bad.push(`${f.label}: placeholder ${f.placeholderContrast}:1`);
      if (f.height < 36) bad.push(`${f.label}: only ${f.height}px high`);
    }
    for (const p of r.probes) {
      if (!p) continue;
      if (p.invalid.contrast < 3 || p.invalid.color === p.normal.color) bad.push(`${p.label}: invalid state not distinct (${p.invalid.contrast}:1)`);
      if (!p.disabled.distinct) bad.push(`${p.label}: disabled looks like enabled`);
    }
    const fo = r.focus;
    if (fo) {
      const ring = fo.boxShadow !== "none" || /^(solid|auto|double|dotted|dashed) (?!0px)/.test(fo.outline);
      if (!ring) bad.push(`${fo.label}: no focus ring (${fo.boxShadow} / ${fo.outline})`);
      if (!fo.focusVisible) bad.push(`${fo.label}: :focus-visible did not match`);
    }
    if (bad.length) await closeAll(); // a failed screen must not leave its dialog over the next one
    expect(bad.length === 0, `${id}: ${J(bad)}`);
  }

  await test("FLD-00.login_and_open_cash", "e2e", async () => {
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
  });

  await test("FLD-01.cash_open_dialog", "e2e", async () => {
    await ui.nav(page, "Caja");
    await page.getByText("No hay sesión de caja abierta").waitFor();
    await page.getByRole("button", { name: "Abrir Caja" }).click();
    await page.getByPlaceholder("Monto inicial").waitFor();
    await audit("FLD-01", "cash-open-dialog");
    await page.getByPlaceholder("Monto inicial").fill("100");
    await audit("FLD-01b", "cash-open-dialog-filled");
    await page.getByRole("dialog").getByRole("button", { name: "Abrir Caja" }).click();
    await page.getByText("Abierta", { exact: true }).waitFor();
  });

  await test("FLD-02.sales_search_and_payment", "e2e", async () => {
    await ui.nav(page, "Vender");
    await page.getByText("Carrito (0 artículos)").waitFor();
    await audit("FLD-02", "sales-empty");
    await page.getByPlaceholder("Código, SKU o nombre...").fill("FLD");
    await audit("FLD-02b", "sales-search-with-value");
    await page.getByPlaceholder("Código, SKU o nombre...").fill(""); // the audit took the focus away and closed the results
    await page.getByPlaceholder("Código, SKU o nombre...").fill("FLD");
    await page.getByRole("option").first().click();
    await page.getByRole("button", { name: "Pagar" }).click();
    await page.getByLabel(/Efectivo recibido/).waitFor();
    await page.getByLabel(/Efectivo recibido/).fill("50");
    await audit("FLD-02c", "sales-payment-dialog");
    await closeAll();
    await page.getByRole("button", { name: "Limpiar", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Limpiar carrito" }).click();
  });

  await test("FLD-03.cash_movement_and_close_dialogs", "e2e", async () => {
    await ui.nav(page, "Caja");
    await page.getByRole("button", { name: "Registrar Movimiento" }).click();
    await page.getByPlaceholder("Monto").waitFor();
    await audit("FLD-03", "cash-movement-dialog");
    await closeAll();
    await page.getByRole("button", { name: "Cerrar Caja" }).click();
    await page.getByPlaceholder("Monto real contado").waitFor();
    await audit("FLD-03b", "cash-close-dialog");
    await closeAll();
  });

  await test("FLD-04.returns_sale_number_and_quantities", "e2e", async () => {
    await ui.nav(page, "Devoluciones");
    await page.locator("#rt-sale").waitFor();
    await audit("FLD-04", "returns-search");
    await page.locator("#rt-sale").fill(String(sale));
    await page.getByRole("button", { name: "Buscar venta" }).click();
    await page.getByLabel(/Cantidad a devolver de/).first().waitFor();
    await page.getByLabel(/Cantidad a devolver de/).first().fill("1");
    await audit("FLD-04b", "returns-lines");
  });

  await test("FLD-05.inventory_and_product_form", "e2e", async () => {
    await ui.nav(page, "Productos");
    await page.getByLabel("Buscar productos").waitFor();
    await audit("FLD-05", "inventory-list");
    await page.getByRole("button", { name: "Nuevo Producto" }).click();
    await page.locator("#pf-status").waitFor();
    await audit("FLD-05b", "inventory-product-dialog");
    await closeAll();
  });

  await test("FLD-06.users_and_user_form", "e2e", async () => {
    await ui.nav(page, "Usuarios");
    await page.getByLabel("Buscar usuarios").waitFor();
    await audit("FLD-06", "users-list");
    await page.getByRole("button", { name: "Nuevo Usuario" }).click();
    await page.getByLabel("PIN", { exact: true }).waitFor();
    await audit("FLD-06b", "users-dialog");
    await closeAll();
  });

  await test("FLD-07.settings_inputs_selects_textareas", "e2e", async () => {
    await ui.nav(page, "Configuración");
    await page.locator("#bs-paper").waitFor();
    await audit("FLD-07", "settings");
  });

  await test("FLD-08.history_cash_history_stock_receive", "e2e", async () => {
    await ui.nav(page, "Historial");
    await page.locator("#hs-method").waitFor();
    await audit("FLD-08", "history");
    await page.evaluate(() => { location.hash = "#/cash/history"; });
    await page.locator("#ch-status").waitFor();
    await audit("FLD-08b", "cash-history");
    await ui.nav(page, "Ver Stock");
    await page.getByRole("heading", { name: "Consultar Stock" }).waitFor();
    await audit("FLD-08c", "stock");
    await ui.nav(page, "Recepción");
    await page.getByRole("heading", { level: 1 }).first().waitFor();
    await audit("FLD-08d", "receive");
  });

  fs.writeFileSync(path.join(artifacts, `fields-${PHASE}.json`), JSON.stringify(results, null, 2));
}
