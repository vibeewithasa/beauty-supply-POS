// Screens suite (visual): the administrative screens exercised through the REAL UI (Playwright clicking and typing),
// with every effect verified in PostgreSQL. IPC is used only for the role-isolation negatives, never to act.
// Covers: products (create/edit/price/history/logical delete), inventory movements (IN/OUT/ADJUST), returns
// (partial, over-return, pending refund), reports (real data, invalid input), vendor isolation, sales + cash still work.
import { APP_URL, ui, ipc, expect } from "../lib/harness.mjs";

export async function run(c) {
  const { page, db, data, test, runId } = c;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  const num = (v) => Number(v);
  const toast = (re) => page.getByText(re).first().waitFor({ timeout: 6000 });
  const productRow = (sku) => page.getByRole("row", { name: new RegExp(sku) });

  const admin = await data.user("SCR_ADMIN", "admin");
  const vendor = await data.user("SCR_VEND", "vendor");
  const SKU = `SCR-${runId}-A`;
  const NAME = `Pantalla ${runId} A`;
  const NAME2 = `Pantalla ${runId} Editada`;

  // a previous suite must not leave an open cash session behind (the UI flow below opens its own)
  await db.query(
    "update cash_sessions set status='closed', closed_at=now(), closed_by=$1, final_amount=current_amount where closed_at is null",
    [admin.id]
  );

  await test("SCR-00.admin_logs_in_and_sees_the_new_modules_in_the_navbar", "e2e", async () => {
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    for (const l of ["Productos", "Recepción", "Devoluciones", "Reportes", "Caja", "Vender"]) {
      const link = page.locator("nav").getByRole("link", { name: l, exact: true });
      await link.waitFor({ timeout: 5000 }).catch(() => {});
      expect(await link.count() === 1, "navbar link " + l);
    }
  });

  // ================================================================== products
  await test("SCR-01.create_product_with_initial_price_and_stock", "e2e", async () => {
    await ui.nav(page, "Productos");
    await page.getByRole("heading", { name: "Gestión de Productos" }).waitFor();
    await page.getByRole("button", { name: "Nuevo Producto" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("SKU", { exact: true }).fill(SKU);
    await d.getByLabel("Nombre", { exact: true }).fill(NAME);
    await d.getByLabel("Categoría").fill("Pantallas");
    await d.getByLabel("Precio inicial").fill("12.50");
    await d.getByLabel("Stock inicial").fill("5");
    await d.getByRole("button", { name: "Crear producto" }).click();
    await toast(/Producto creado/);
    await productRow(SKU).waitFor();
    const p = await one("select * from products where sku=$1", [SKU]);
    expect(p && num(p.price) === 12.5 && p.stock === 5 && p.status === "active", "persisted price/stock/status: " + JSON.stringify(p));
    const m = await rows("select type, amount, reason from inventory_movements where product_id=$1", [p.id]);
    expect(m.length === 1 && m[0].type === "IN" && m[0].amount === 5, "initial stock is recorded as one IN movement: " + JSON.stringify(m));
  });
  await test("SCR-02.invalid_price_and_duplicate_sku_are_rejected_with_a_message", "e2e", async () => {
    await page.getByRole("button", { name: "Nuevo Producto" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("SKU", { exact: true }).fill(SKU);
    await d.getByLabel("Nombre", { exact: true }).fill("Duplicado");
    await d.getByLabel("Precio inicial").fill("abc");
    await d.getByRole("button", { name: "Crear producto" }).click();
    await toast(/importe válido/);
    await d.getByLabel("Precio inicial").fill("3.00");
    await d.getByRole("button", { name: "Crear producto" }).click();
    await toast(/SKU|existe|duplicad/i);
    expect((await one("select count(*)::int n from products where sku=$1", [SKU])).n === 1, "no duplicate was created");
    await page.keyboard.press("Escape");
  });
  await test("SCR-03.edit_product_changes_data_but_never_stock_or_price", "e2e", async () => {
    const before = await one("select price, stock from products where sku=$1", [SKU]);
    await page.getByRole("button", { name: `Editar ${NAME}` }).click();
    const d = page.getByRole("dialog");
    expect(await d.getByLabel("Precio inicial").count() === 0 && (await d.getByLabel("Stock inicial").count()) === 0, "edit form has no price or stock fields");
    await d.getByLabel("Nombre", { exact: true }).fill(NAME2);
    await d.getByLabel("Código de barras").fill(`BC${runId}`);
    await d.getByRole("button", { name: "Guardar cambios" }).click();
    await toast(/Producto actualizado/);
    await page.getByRole("row", { name: new RegExp(NAME2) }).waitFor();
    const after = await one("select name, barcode, price, stock from products where sku=$1", [SKU]);
    expect(after.name === NAME2 && after.barcode === `BC${runId}`, "name/barcode persisted: " + JSON.stringify(after));
    expect(num(after.price) === num(before.price) && after.stock === before.stock, "price and stock untouched");
  });
  await test("SCR-04.search_by_sku_name_and_barcode_and_empty_state", "e2e", async () => {
    const q = page.getByLabel("Buscar productos");
    for (const term of [SKU, "editada", `BC${runId}`]) {
      await q.fill(term);
      await productRow(SKU).waitFor();
    }
    await q.fill("zzz-no-existe-zzz");
    await page.getByText("No hay productos que coincidan").waitFor();
    await q.fill("");
  });

  // ================================================================== inventory movements
  const receive = async (label, type, qty, reason) => {
    await page.getByLabel("Tipo de movimiento").selectOption(type);
    await page.getByLabel(type === "ADJUST" ? "Diferencia (con signo)" : "Cantidad", { exact: true }).fill(qty);
    await page.getByLabel("Motivo", { exact: true }).fill(reason);
    await page.getByRole("button", { name: "Registrar movimiento" }).click();
  };
  await test("SCR-05.receive_stock_out_and_adjust_through_the_screen", "e2e", async () => {
    await ui.nav(page, "Recepción");
    await page.getByLabel("Buscar producto").fill(SKU);
    await page.getByRole("button", { name: `Seleccionar ${NAME2}` }).click();
    expect((await page.getByTestId("current-stock").innerText()) === "5", "current stock shown");
    const p = await one("select id from products where sku=$1", [SKU]);

    await receive("in", "IN", "10", "Recepción de prueba");
    await page.getByTestId("movement-result").getByText(/Stock persistido: 15/).waitFor();
    await receive("out", "OUT", "3", "Merma de prueba");
    await page.getByTestId("movement-result").getByText(/Stock persistido: 12/).waitFor();
    await receive("adj", "ADJUST", "-2", "Conteo físico");
    await page.getByTestId("movement-result").getByText(/Stock persistido: 10/).waitFor();

    const m = await rows("select type, amount from inventory_movements where product_id=$1 order by id", [p.id]);
    expect(JSON.stringify(m.map((x) => [x.type, x.amount])) === JSON.stringify([["IN", 5], ["IN", 10], ["OUT", -3], ["ADJUST", -2]]), "stored deltas: " + JSON.stringify(m));
    expect((await one("select stock from products where id=$1", [p.id])).stock === 10, "stock in PostgreSQL = 10");
    await page.getByRole("cell", { name: "Conteo físico" }).first().waitFor(); // basic history on screen
  });
  await test("SCR-06.invalid_movements_are_blocked_and_change_nothing", "e2e", async () => {
    const p = await one("select id, stock from products where sku=$1", [SKU]);
    const n0 = (await one("select count(*)::int n from inventory_movements where product_id=$1", [p.id])).n;
    await page.getByLabel("Tipo de movimiento").selectOption("OUT");
    await page.getByLabel("Cantidad", { exact: true }).fill("99");
    await page.getByLabel("Motivo", { exact: true }).fill("Demasiado");
    await page.getByText(/no permitido: el stock no puede ser negativo/).waitFor();
    await page.getByRole("button", { name: "Registrar movimiento" }).click();
    await toast(/Stock insuficiente/);
    await page.getByLabel("Cantidad", { exact: true }).fill("-1");
    await page.getByText(/escribe la cantidad en positivo/).waitFor();
    await page.getByLabel("Cantidad", { exact: true }).fill("0");
    await page.getByText(/distinto de cero/).waitFor();
    const n1 = (await one("select count(*)::int n from inventory_movements where product_id=$1", [p.id])).n;
    expect(n1 === n0 && (await one("select stock from products where id=$1", [p.id])).stock === p.stock, "nothing changed");
  });

  // ================================================================== price changes
  await test("SCR-07.price_change_from_the_product_screen_with_history_and_stale_detection", "e2e", async () => {
    const p = await one("select id from products where sku=$1", [SKU]);
    await ui.nav(page, "Productos");
    await page.getByRole("button", { name: `Cambiar precio de ${NAME2}` }).click();
    const d = page.getByRole("dialog");
    expect((await d.getByTestId("current-price").innerText()) === "$12.50", "current price read from PostgreSQL");
    await d.getByLabel("Precio nuevo").fill("15.00");
    await d.getByLabel("Motivo (opcional)").fill("Ajuste de lista");
    await d.getByRole("button", { name: "Registrar cambio de precio" }).click();
    await toast(/Precio actualizado/);
    expect(num((await one("select price from products where id=$1", [p.id])).price) === 15, "price persisted");
    const h = await rows("select old_price, new_price, reason, changed_by from price_changes where product_id=$1", [p.id]);
    expect(h.length === 1 && num(h[0].old_price) === 12.5 && num(h[0].new_price) === 15 && h[0].changed_by === admin.id, "history row: " + JSON.stringify(h));

    // stale: another terminal changes the price while this dialog is open
    await page.getByRole("button", { name: `Cambiar precio de ${NAME2}` }).click();
    const d2 = page.getByRole("dialog");
    expect((await d2.getByTestId("current-price").innerText()) === "$15.00", "dialog shows the new price");
    await d2.getByText("Ajuste de lista").waitFor(); // history visible in the dialog
    await db.query("update products set price='14.00' where id=$1", [p.id]);
    await d2.getByLabel("Precio nuevo").fill("16.00");
    await d2.getByRole("button", { name: "Registrar cambio de precio" }).click();
    await toast(/El precio actual es \$14\.00/);
    await d2.getByTestId("current-price").getByText("$14.00").waitFor();
    expect(num((await one("select price from products where id=$1", [p.id])).price) === 14, "the stale write did not overwrite");
    expect((await one("select count(*)::int n from price_changes where product_id=$1", [p.id])).n === 1, "no history row for the rejected change");
    await d2.getByLabel("Precio nuevo").fill("16.00");
    await d2.getByRole("button", { name: "Registrar cambio de precio" }).click();
    await toast(/Precio actualizado/);
    expect(num((await one("select price from products where id=$1", [p.id])).price) === 16, "retry with fresh data succeeds");
  });
  await test("SCR-08.invalid_price_is_rejected", "e2e", async () => {
    const p = await one("select id, price from products where sku=$1", [SKU]);
    await page.getByRole("button", { name: `Cambiar precio de ${NAME2}` }).click();
    const d = page.getByRole("dialog");
    for (const bad of ["-5", "1.234", "abc", ""]) {
      await d.getByLabel("Precio nuevo").fill(bad);
      await d.getByRole("button", { name: "Registrar cambio de precio" }).click();
      await toast(/importe válido/);
    }
    expect(num((await one("select price from products where id=$1", [p.id])).price) === num(p.price), "price untouched");
    await page.keyboard.press("Escape");
  });
  await test("SCR-09.movement_history_dialog_shows_the_persisted_movements", "e2e", async () => {
    await page.getByRole("button", { name: `Historial de ${NAME2}` }).click();
    const d = page.getByRole("dialog");
    await d.getByText("Stock inicial").waitFor();
    await d.getByText("Merma de prueba").waitFor();
    await d.getByText("-3", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
  });

  // ================================================================== sale + returns
  const ret = await data.product("RET", 10, 20);
  let saleId;
  await test("SCR-10.sale_through_the_ui_still_works_with_cash_open", "e2e", async () => {
    await ui.openCash(page, 100);
    await ui.sell(page, { query: ret.sku, name: ret.name, qty: 3, method: "cash" });
    const s = await one("select id, total from sales order by id desc limit 1");
    saleId = s.id;
    expect(num(s.total) === 30, "sale total persisted: " + s.total);
    expect((await one("select stock from products where id=$1", [ret.id])).stock === 17, "stock decreased by the sale");
  });
  const cashState = async () => ({
    cur: num((await one("select current_amount from cash_sessions where closed_at is null")).current_amount),
    mv: (await one("select count(*)::int n from cash_movements")).n,
  });
  await test("SCR-11.partial_return_is_pending_refund_and_never_touches_cash", "e2e", async () => {
    const cash0 = await cashState();
    await ui.nav(page, "Devoluciones");
    await page.getByLabel("Número de venta").fill(String(saleId));
    await page.getByRole("button", { name: "Buscar venta" }).click();
    await page.getByRole("heading", { name: `Venta #${saleId}` }).waitFor();
    const qty = page.getByLabel(`Cantidad a devolver de ${ret.name}`);
    await qty.fill("1");
    await page.getByLabel("Motivo", { exact: true }).fill("Cliente se arrepintió");
    expect((await page.getByTestId("refund-preview").innerText()) === "$10.00", "amount preview");
    // no administrator at hand: the return is registered WITHOUT a refund and stays pending (the main button needs a PIN)
    expect(await page.getByRole("button", { name: "Confirmar devolución y reembolso" }).isDisabled(), "the refund button stays disabled until a method is chosen and the money is confirmed");
    await page.getByRole("button", { name: /Registrar la devolución sin reembolso/ }).click();
    await page.getByTestId("return-result").getByText(/Estado: PENDIENTE/).waitFor();
    const r = await one("select * from returns where sale_id=$1", [saleId]);
    expect(r && r.refund_status === "pending" && num(r.total_refund) === 10, "persisted pending return: " + JSON.stringify(r));
    expect((await one("select stock from products where id=$1", [ret.id])).stock === 18, "stock returned to inventory");
    const cash1 = await cashState();
    expect(cash1.cur === cash0.cur && cash1.mv === cash0.mv, "cash untouched: " + JSON.stringify({ cash0, cash1 }));
    // lookup now reflects the persisted state, and the history shows the refund status
    await page.getByRole("cell", { name: "PENDIENTE", exact: true }).first().waitFor();
    // paying it needs the authorization dialog (administrator PIN): nothing marks a refund as paid on its own
    await page.getByRole("button", { name: "Registrar pago pendiente" }).first().click();
    await page.locator("#rf-admin-pin").waitFor();
    expect(await page.getByRole("button", { name: "Autorizar y registrar pago" }).isDisabled(), "no PIN, no method, no confirmation: the payment cannot be sent");
    await page.getByRole("button", { name: "Cancelar" }).click();
    expect((await one("select refund_status from returns where sale_id=$1", [saleId])).refund_status === "pending", "still pending after cancelling");
  });
  await test("SCR-12.over_return_is_blocked_then_the_remaining_units_can_be_returned", "e2e", async () => {
    const n0 = (await one("select count(*)::int n from returns")).n;
    const qty = page.getByLabel(`Cantidad a devolver de ${ret.name}`);
    await qty.fill("3");
    await page.getByText("Máximo 2").waitFor();
    await page.getByLabel("Motivo", { exact: true }).fill("Exceso");
    expect(await page.getByRole("button", { name: "Confirmar devolución y reembolso" }).isDisabled(), "an over-return cannot be sent for authorization");
    expect(await page.getByRole("button", { name: /Registrar la devolución sin reembolso/ }).isDisabled(), "nor registered as pending");
    expect((await one("select count(*)::int n from returns")).n === n0, "no return was created");
    await qty.fill("2");
    await page.getByRole("button", { name: /Registrar la devolución sin reembolso/ }).click();
    await page.getByTestId("return-result").waitFor();
    expect((await one("select coalesce(sum(quantity),0)::int q from return_items ri join returns r on r.id=ri.return_id where r.sale_id=$1", [saleId])).q === 3, "all 3 units returned in total");
    await page.getByText("Ya devuelto completo").waitFor();
    expect((await one("select stock from products where id=$1", [ret.id])).stock === 20, "stock fully restored");
  });
  await test("SCR-13.unknown_or_invalid_sale_numbers_show_a_clear_error", "e2e", async () => {
    await page.getByLabel("Número de venta").fill("99999999");
    await page.getByRole("button", { name: "Buscar venta" }).click();
    await page.getByRole("alert").getByText(/no existe/i).waitFor();
    await page.getByLabel("Número de venta").fill("abc");
    await page.getByRole("button", { name: "Buscar venta" }).click();
    await page.getByRole("alert").getByText(/solo dígitos/).waitFor();
  });

  // ================================================================== reports
  const runReport = async (from, to) => {
    await page.getByLabel("Desde").fill(from);
    await page.getByLabel("Hasta").fill(to);
    await page.getByRole("button", { name: "Generar reporte" }).click();
  };
  await test("SCR-14.report_matches_postgresql_totals_methods_and_return_statuses", "e2e", async () => {
    await ui.nav(page, "Reportes");
    await page.getByRole("heading", { name: "Reportes" }).waitFor();
    const t = await one("select count(*)::int n, coalesce(sum(total),0)::text s from sales");
    const rp = await one("select count(*)::int n, coalesce(sum(total_refund),0)::text s from returns where refund_status='pending'");
    await page.getByTestId("rp-count").getByText(String(t.n), { exact: true }).waitFor();
    expect((await page.getByTestId("rp-total").innerText()) === `$${Number(t.s).toFixed(2)}`, "total matches PostgreSQL: " + t.s);
    const pend = await page.getByTestId("rp-ret-pending").innerText();
    expect(pend.includes(String(rp.n)) && pend.includes(`$${Number(rp.s).toFixed(2)}`), "pending returns row: " + pend + " vs " + JSON.stringify(rp));
    expect((await page.getByTestId("rp-ret-paid").innerText()).includes("$0.00"), "paid returns are $0.00: nothing marks paid");
    await page.getByRole("cell", { name: "Efectivo" }).first().waitFor();
    await page.getByRole("cell", { name: ret.sku }).waitFor();
    expect(await page.getByText(/utilidad|ganancia|impuesto/i).count() === 1, "only the disclaimer mentions profit/taxes (none are computed)");
  });
  await test("SCR-15.report_rejects_invalid_ranges_and_shows_an_empty_state", "e2e", async () => {
    await runReport("2026-12-31", "2026-01-01");
    await page.getByRole("alert").getByText(/no puede ser posterior/).waitFor();
    await runReport("2020-01-01", "2022-01-01");
    await page.getByRole("alert").getByText(/rango máximo/).waitFor();
    await page.getByLabel("Desde").fill("");
    await page.getByRole("button", { name: "Generar reporte" }).click();
    await page.getByRole("alert").getByText(/AAAA-MM-DD/).waitFor();
    await runReport("2001-01-01", "2001-01-02");
    await page.getByText(/No hay ventas ni devoluciones en el rango/).waitFor();
  });

  // ================================================================== role isolation
  await test("SCR-16.vendor_sees_no_admin_modules_cannot_open_them_and_can_still_use_returns", "e2e", async () => {
    // leave the cash session open for the admin; vendor only needs lookups
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, vendor.pin);
    await page.waitForURL(/#\/sales$/, { timeout: 8000 });
    for (const l of ["Productos", "Recepción", "Reportes", "Usuarios", "Dashboard"]) {
      expect(await page.getByRole("link", { name: l, exact: true }).count() === 0, "vendor has no link " + l);
    }
    for (const route of ["/inventory", "/receive", "/reports"]) {
      await page.goto(APP_URL + "/#" + route);
      await page.waitForTimeout(600);
      expect(!new URL(page.url()).hash.startsWith("#" + route), `vendor redirected away from ${route}: ${page.url()}`);
    }
    for (const expr of ["api.products.listAdmin()", `api.reports.getSummary({from:'2026-01-01',to:'2026-01-02'})`, "api.inventory.getMovements(1)", "api.priceChanges.getAll(1)"]) {
      const r = await ipc(page, expr);
      expect(r.ok === false && /No autorizado/.test(r.err), expr + " rejected for a vendor: " + JSON.stringify(r));
    }
    await ui.nav(page, "Devoluciones");
    await page.getByLabel("Número de venta").fill(String(saleId));
    await page.getByRole("button", { name: "Buscar venta" }).click();
    await page.getByRole("heading", { name: `Venta #${saleId}` }).waitFor();
    await page.getByRole("cell", { name: "PENDIENTE", exact: true }).first().waitFor();
  });

  await test("SCR-17.cash_session_closes_cleanly_after_the_whole_flow", "e2e", async () => {
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    await ui.nav(page, "Caja");
    const expected = await ui.closeCash(page);
    const s = await one("select status, final_amount from cash_sessions order by id desc limit 1");
    expect(s.status === "closed" && num(s.final_amount) === num(expected), "closed with the expected amount: " + JSON.stringify(s));
  });
}
