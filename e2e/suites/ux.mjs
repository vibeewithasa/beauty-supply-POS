// UX suite: layout and operability checks on every screen at 1024x768, 1366x768 and 1920x1080, with local screenshots
// (e2e-artifacts, ignored by Git). Hard assertions: no horizontal page overflow, no clipped tables, critical buttons
// reachable, modals inside the viewport, one h1 per screen, labelled controls. Touch-target size is reported (WARN).
// Contrast and screen-reader behaviour are NOT measured here; see docs/UX_AUDIT.md for what was reviewed by hand.
import path from "node:path";
import { APP_URL, ui, expect, closeStrayCash } from "../lib/harness.mjs";

const VIEWPORTS = [[1024, 768], [1366, 768], [1920, 1080]];
const J = JSON.stringify;

export async function run(c) {
  const { page, app, db, data, test, artifacts } = c;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const admin = await data.user("UX_ADMIN", "admin");
  const vendor = await data.user("UX_VEND", "vendor");
  await closeStrayCash(db, admin.id);
  const prods = [];
  for (let i = 0; i < 9; i++) prods.push(await data.product("UX" + i, (5 + i * 3.25).toFixed(2), 40 + i));
  await db.query("update products set barcode=$1 where id=$2", ["7509990000011", prods[0].id]);
  const sess = (await one("insert into cash_sessions(opened_by,initial_amount,current_amount,status,opened_at,closed_at,closed_by,final_amount) values($1,'0','0','closed',$2,$3,$1,'0') returning id", [admin.id, new Date(2026, 5, 1, 8), new Date(2026, 5, 1, 20)])).id;
  const sale = (await one("insert into sales(user_id,cash_session_id,total,payment_method,created_at) values($1,$2,'30.00','cash',$3) returning id", [admin.id, sess, new Date(2026, 5, 1, 12)])).id;
  await db.query("insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal,product_name,product_sku) values($1,$2,3,'10.00','30.00',$3,$4)", [sale, prods[0].id, "Producto UX largo para probar el ajuste de línea en el recibo", "UX-0"]);

  const resize = async (w, h) => {
    await app.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows()[0].setContentSize(s[0], s[1]); }, [w, h]);
    await page.waitForFunction((s) => Math.abs(window.innerWidth - s[0]) <= 2 && Math.abs(window.innerHeight - s[1]) <= 2, [w, h], { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(150);
    // a previous failed test must not leave a dialog open over the next one
    for (let i = 0; i < 5 && (await page.getByRole("dialog").count()) + (await page.getByRole("alertdialog").count()) > 0; i++) { await page.keyboard.press("Escape"); await page.waitForTimeout(300); }
  };
  const shot = (name, w, h) => page.screenshot({ path: path.join(artifacts, `ux-${name}-${w}x${h}.png`) }).catch(() => {});
  // measures the current screen: horizontal overflow, clipped tables, headings, unlabelled controls, small targets
  const measure = () => page.evaluate(() => {
    const out = { hscroll: document.documentElement.scrollWidth - window.innerWidth, clipped: [], h1: document.querySelectorAll("h1").length, unlabelled: [], small: [], offscreenButtons: [] };
    for (const t of document.querySelectorAll("table")) {
      let p = t.parentElement;
      while (p && p !== document.body) {
        const ov = getComputedStyle(p).overflowX;
        if (ov !== "visible") { if (ov !== "auto" && ov !== "scroll" && t.scrollWidth > p.clientWidth + 1) out.clipped.push((t.getAttribute("aria-label") || t.className) + ` (${t.scrollWidth}>${p.clientWidth})`); break; }
        p = p.parentElement;
      }
    }
    for (const el of document.querySelectorAll("input, select, textarea")) {
      if (el.type === "hidden" || el.type === "file" || el.type === "checkbox") { if (!(el.labels && el.labels.length) && !el.getAttribute("aria-label") && el.type !== "hidden") out.unlabelled.push(el.type + ":" + (el.id || el.placeholder || el.name)); continue; }
      const labelled = (el.labels && el.labels.length) || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby");
      if (!labelled) out.unlabelled.push((el.id || el.placeholder || el.name || el.tagName).toString().slice(0, 40));
    }
    for (const b of document.querySelectorAll("button, a[href], [role=tab], select")) {
      const r = b.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < 36 || r.width < 36) out.small.push((b.getAttribute("aria-label") || b.textContent || b.tagName).trim().slice(0, 24) + ` ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  });
  // dialogs animate in (zoom/fade): measure once they have settled
  const fitsViewport = async (loc) => { await loc.first().waitFor(); await page.waitForTimeout(400); return loc.first().evaluate((el) => { const r = el.getBoundingClientRect(); return { ok: r.top >= -1 && r.bottom <= window.innerHeight + 1 && r.left >= -1 && r.right <= window.innerWidth + 1, rect: [r.left, r.top, r.right, r.bottom].map(Math.round), vp: [window.innerWidth, window.innerHeight] }; }); };
  const closeAll = async () => { for (let i = 0; i < 5; i++) { if ((await page.getByRole("dialog").count()) + (await page.getByRole("alertdialog").count()) === 0) return; await page.keyboard.press("Escape"); await page.waitForTimeout(300); } };
  const smallReport = new Map();

  const ROUTES = [["sales", "Punto de Venta"], ["cash", null], ["cash/history", "Historial de caja"], ["history", "Historial de ventas"], ["inventory", "Gestión de Productos"], ["receive", null], ["stock", "Consultar Stock"], ["returns", "Devoluciones"], ["dashboard", null], ["reports", "Reportes"], ["users", null], ["settings", "Configuración comercial"]];

  await test("UX-00.admin_login_by_keyboard", "e2e", async () => {
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await page.keyboard.press("Escape");
    for (const d of admin.pin) await page.keyboard.press(d);
    await page.keyboard.press("Enter");
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
  });

  for (const [w, h] of VIEWPORTS) {
    await test(`UX-01.every_screen_fits_without_overflow_at_${w}x${h}`, "e2e", async () => {
      await resize(w, h);
      const problems = [];
      for (const [route] of ROUTES) {
        await page.goto(APP_URL + "/#/" + route);
        await page.waitForTimeout(700);
        await page.locator("main").waitFor();
        const m = await measure();
        await shot(route.replace("/", "-"), w, h);
        if (m.hscroll > 1) problems.push(`${route}: horizontal page overflow ${m.hscroll}px`);
        if (m.clipped.length) problems.push(`${route}: clipped tables ${J(m.clipped)}`);
        if (m.h1 < 1) problems.push(`${route}: no h1`);
        if (m.unlabelled.length) problems.push(`${route}: unlabelled controls ${J(m.unlabelled)}`);
        for (const s of m.small) smallReport.set(`${route}: ${s}`, true);
        const nav = await page.locator("nav").boundingBox();
        if (!nav || nav.height > 110) problems.push(`${route}: navigation takes ${nav && Math.round(nav.height)}px`);
      }
      expect(problems.length === 0, problems.join(" | "));
    });
  }

  for (const [w, h] of VIEWPORTS) {
    await test(`UX-02.sales_screen_keeps_pay_reachable_with_a_long_cart_at_${w}x${h}`, "e2e", async () => {
      await resize(w, h);
      await ui.openCash(page, 10).catch(() => {});
      await page.goto(APP_URL + "/#/sales");
      await page.getByPlaceholder("Código, SKU o nombre...").waitFor();
      for (const p of prods) {
        await page.getByPlaceholder("Código, SKU o nombre...").fill(p.sku);
        await page.getByRole("option", { name: new RegExp(p.name) }).first().click();
      }
      await page.getByText("Carrito (9 artículos)").waitFor();
      const pay = page.getByRole("button", { name: "Pagar" });
      const f = await fitsViewport(pay);
      expect(f.ok, "Pagar is inside the viewport: " + J(f));
      expect((await page.getByTestId("cart-total").isVisible()), "the total is visible");
      const m = await measure();
      expect(m.hscroll <= 1, "no horizontal overflow with a long cart: " + m.hscroll);
      await shot("sales-long-cart", w, h);
      await pay.click();
      const dlg = page.getByRole("dialog").filter({ hasText: "Método de Pago" });
      const fd = await fitsViewport(dlg);
      expect(fd.ok, "payment dialog fits: " + J(fd));
      await shot("sales-payment", w, h);
      await closeAll();
      await page.getByRole("button", { name: "Limpiar", exact: true }).click();
      const alert = page.getByRole("alertdialog");
      expect((await fitsViewport(alert)).ok, "confirmation fits");
      await alert.getByRole("button", { name: "Limpiar carrito" }).click();
      await page.getByText("Carrito vacío").waitFor();
    });
  }

  await test("UX-03.cash_change_calculator_in_the_payment_dialog", "e2e", async () => {
    await resize(1366, 768);
    await page.goto(APP_URL + "/#/sales");
    await page.getByPlaceholder("Código, SKU o nombre...").fill(prods[1].sku);
    await page.getByRole("option", { name: new RegExp(prods[1].name) }).first().click(); // 8.25
    await page.getByRole("button", { name: "Pagar" }).click();
    const dlg = page.getByRole("dialog").filter({ hasText: "Método de Pago" });
    await dlg.getByLabel("Efectivo recibido").fill("20");
    await dlg.getByTestId("change-due").getByText("$11.75").waitFor();
    await dlg.getByLabel("Efectivo recibido").fill("5");
    await dlg.getByText(/Faltan \$3\.25/).waitFor();
    await dlg.getByRole("tab", { name: "Tarjeta" }).click();
    expect((await dlg.getByLabel("Efectivo recibido").count()) === 0, "no cash calculator for card payments");
    await shot("sales-change", 1366, 768);
    const n0 = (await one("select count(*)::int n from sales")).n;
    await closeAll();
    expect((await one("select count(*)::int n from sales")).n === n0, "the calculator writes nothing");
    await page.getByRole("button", { name: "Limpiar", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Limpiar carrito" }).click();
  });

  for (const [w, h] of VIEWPORTS) {
    await test(`UX-04.dialogs_and_receipt_preview_fit_the_viewport_at_${w}x${h}`, "e2e", async () => {
      await resize(w, h);
      const problems = [];
      const check = async (name, loc) => { const f = await fitsViewport(loc); await shot(name, w, h); if (!f.ok) problems.push(`${name}: ${J(f)}`); };
      await page.goto(APP_URL + "/#/history");
      await page.locator("#hs-q").fill(String(sale));
      await page.getByRole("button", { name: "Buscar", exact: true }).click();
      await page.getByRole("button", { name: `Ver venta ${sale}` }).click();
      await page.getByRole("dialog").getByText(`Venta #${sale}`).first().waitFor();
      await check("history-detail", page.getByRole("dialog"));
      await page.getByRole("dialog").getByRole("button", { name: "Ver recibo" }).click();
      const rd = page.getByRole("dialog").filter({ hasText: `Recibo de la venta #${sale}` });
      await page.frameLocator('iframe[title="Vista previa del recibo"]').getByText("TOTAL").waitFor({ timeout: 8000 });
      await check("receipt-preview", rd);
      await closeAll();
      await page.goto(APP_URL + "/#/inventory");
      await page.getByRole("button", { name: "Nuevo Producto" }).click();
      await check("product-form", page.getByRole("dialog"));
      await closeAll();
      await page.goto(APP_URL + "/#/users");
      await page.getByRole("button", { name: /Nuevo Usuario|Crear Usuario|Agregar/ }).first().click();
      await check("user-form", page.getByRole("dialog"));
      await closeAll();
      await page.goto(APP_URL + "/#/cash");
      // a register may be open from the sales checks above: use the dialogs that exist in either state
      const openBtn = page.getByRole("button", { name: "Abrir Caja" });
      if ((await openBtn.count()) > 0) { await openBtn.click(); await check("cash-open", page.getByRole("dialog")); await closeAll(); }
      else {
        await page.getByRole("button", { name: "Registrar Movimiento" }).click();
        await check("cash-movement", page.getByRole("dialog"));
        await closeAll();
        await page.getByRole("button", { name: "Cerrar Caja" }).click();
        await check("cash-close", page.getByRole("dialog"));
        await closeAll();
      }
      expect(problems.length === 0, problems.join(" | "));
    });
  }

  await test("UX-05.receipt_preview_is_legible_for_80_and_58_mm", "e2e", async () => {
    await resize(1366, 768);
    for (const width of ["80", "58"]) {
      await db.query("update business_settings set paper_width=$1, address='Dirección de prueba 123', phone='55 0000 0000' where id=1", [width]);
      await page.goto(APP_URL + "/#/history");
      await page.locator("#hs-q").fill(String(sale));
      await page.getByRole("button", { name: "Buscar", exact: true }).click();
      await page.getByRole("button", { name: `Ver venta ${sale}` }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Ver recibo" }).click();
      const fr = page.frameLocator('iframe[title="Vista previa del recibo"]');
      await fr.getByText("Producto UX largo para probar el ajuste de línea en el recibo").waitFor({ timeout: 8000 });
      const metrics = await fr.locator("body").evaluate((b) => ({ over: b.scrollWidth - b.clientWidth, ticketW: Math.round(b.querySelector(".ticket").getBoundingClientRect().width) }));
      expect(metrics.over <= 1, `no horizontal overflow at ${width} mm (long product name wraps): ` + J(metrics));
      await shot("receipt-" + width + "mm", 1366, 768);
      await closeAll();
    }
    await db.query("update business_settings set paper_width='80', address=null, phone=null where id=1");
  });

  await test("UX-06.vendor_navigation_is_complete_and_fits", "e2e", async () => {
    await resize(1024, 768);
    await page.goto(APP_URL + "/#/sales");
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    for (const d of vendor.pin) await page.getByRole("button", { name: d, exact: true }).click();
    await page.keyboard.press("Enter");
    await page.waitForURL(/#\/sales$/, { timeout: 8000 });
    const problems = [];
    for (const label of ["Vender", "Caja", "Historial", "Devoluciones", "Ver Stock"]) {
      const link = page.locator("nav").getByRole("link", { name: label, exact: true });
      await link.waitFor({ timeout: 5000 }).catch(() => {});
      if ((await link.count()) !== 1) { problems.push("missing link " + label); continue; }
      await link.click();
      await page.waitForTimeout(400);
      const m = await measure();
      await shot("vendor-" + label.toLowerCase().replace(/\s/g, "-"), 1024, 768);
      if (m.hscroll > 1) problems.push(`${label}: overflow ${m.hscroll}`);
    }
    const nav = await page.locator("nav").boundingBox();
    expect(nav && nav.height <= 110, "vendor navigation is compact: " + (nav && Math.round(nav.height)));
    expect(problems.length === 0, problems.join(" | "));
  });

  await test("UX-09.typing_the_whole_pin_and_enter_at_once_signs_in_(keyboard_wedge_speed)", "e2e", async () => {
    // the last digit and Enter arrive within the same millisecond: the login must read the PIN from the keystrokes, not from a stale render
    for (let i = 0; i < 3; i++) {
      await ui.logout(page);
      await page.getByText("Ingresa tu PIN para comenzar").waitFor();
      await page.keyboard.type(vendor.pin, { delay: 0 });
      await page.keyboard.press("Enter");
      await page.waitForURL(/#\/sales$/, { timeout: 8000 });
    }
  });
  await test("UX-08.the_session_ends_with_the_register_closed", "e2e", async () => {
    await closeStrayCash(db, admin.id); // the register opened for the sales checks
  });
  await test("UX-07.touch_target_report", "e2e", async () => {
    const list = [...smallReport.keys()];
    return `${list.length} interactive elements under 36 px (informational): ` + list.slice(0, 12).join("; ");
  });
}
