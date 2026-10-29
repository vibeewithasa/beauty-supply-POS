// UI suite: real interaction with the Electron window (login, navigation, stock, cash, sales),
// with persistence verified in PostgreSQL after each operation. Synthetic data only.
import { ui, expect, money, APP_URL } from "../lib/harness.mjs";

export async function run(c) {
  const { page, db, data, test, artifacts } = c;
  const shot = (n) => page.screenshot({ path: `${artifacts}/ui_${n}.png` });
  const admin = await data.user("ADMIN", "admin");
  const vendor = await data.user("VENDOR", "vendor");
  const wrongPin = await data.newPin();
  const prodA = await data.product("A", "65.00", 20); // priced like the real sample
  const prodB = await data.product("B", "10.50", 2);
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const stock = async (id) => Number((await one("select stock from products where id=$1", [id])).stock);
  const cashNow = async (id) => money((await one("select current_amount from cash_sessions where id=$1", [id])).current_amount);
  const maxIds = async () => one("select (select coalesce(max(id),0) from sales)::int s,(select coalesce(max(id),0) from cash_sessions)::int cs,(select coalesce(max(id),0) from inventory_movements)::int im");
  const ids0 = await maxIds();
  let sess;

  await test("A0.login_screen_renders", "e2e", async () => { await page.getByText("POS Estética").first().waitFor(); await shot("login"); });
  await test("A1.login_wrong_pin", "e2e", async () => { await ui.login(page, wrongPin); await page.getByText("PIN incorrecto").waitFor({ timeout: 5000 }); });
  await test("A2.login_admin_goes_to_dashboard", "e2e", async () => { await ui.login(page, admin.pin); await page.waitForURL(/#\/dashboard$/, { timeout: 8000 }); });
  await test("B1.dashboard_loads_without_error", "e2e", async () => {
    await page.waitForTimeout(1200);
    const t = await page.evaluate(() => document.body.innerText);
    expect(/Dashboard Administrativo/.test(t) && !/Error al cargar/i.test(t), "dashboard text/errors");
    await shot("dashboard");
  });
  await test("C1.stock_lists_product_matching_db", "e2e", async () => {
    await ui.nav(page, "Ver Stock");
    await page.getByRole("cell", { name: prodA.sku, exact: true }).waitFor();
    const row = await page.locator("tr", { hasText: prodA.sku }).innerText();
    expect(row.includes("20 unidades") && row.includes("$65.00"), "row: " + row.replace(/\s+/g, " "));
    await shot("stock");
  });
  await test("C2.stock_search_by_sku_and_name", "e2e", async () => {
    const inp = page.getByPlaceholder("Buscar por nombre o SKU...");
    await inp.fill(prodA.sku); expect((await page.locator("tbody tr", { hasText: prodA.sku }).count()) === 1, "sku search");
    await inp.fill(prodB.name); expect((await page.locator("tbody tr", { hasText: prodB.name }).count()) === 1, "name search");
    await inp.fill("zzzzzz-none"); await page.getByText("No se encontraron productos").waitFor();
  });
  await test("D0.sale_is_blocked_without_open_cash", "e2e", async () => {
    await ui.nav(page, "Vender");
    await page.getByPlaceholder("Código, SKU o nombre...").fill(prodA.sku);
    await page.getByRole("button", { name: new RegExp(prodA.name) }).first().click();
    await page.getByRole("button", { name: "Pagar" }).click();
    await page.getByText("No hay caja abierta").waitFor({ timeout: 4000 });
    await page.getByRole("button", { name: "Limpiar" }).click();
  });
  await test("D1.open_cash_500", "e2e", async () => {
    await ui.openCash(page, 500);
    const s = (await db.query("select * from cash_sessions where id>$1 order by id", [ids0.cs])).rows;
    expect(s.length === 1 && money(s[0].initial_amount) === 500 && money(s[0].current_amount) === 500 && s[0].closed_at === null && s[0].opened_by === admin.id, "session row");
    sess = s[0].id;
    await shot("cash_open");
  });
  await test("D2.cash_in_20_and_out_10", "e2e", async () => {
    await ui.cashMovement(page, "Ingreso", 20, "Prueba ingreso");
    expect((await cashNow(sess)) === 520 && (await ui.statVal(page, "Total en Caja")) === "$520.00", "520 after IN");
    await ui.cashMovement(page, "Retiro", 10, "Prueba retiro");
    expect((await cashNow(sess)) === 510 && (await ui.statVal(page, "Total en Caja")) === "$510.00", "510 after OUT");
    await shot("cash_movements");
  });
  let m1;
  await test("E1.sale_cash_one_unit_persisted", "e2e", async () => {
    const before = await stock(prodA.id);
    await ui.sell(page, { query: prodA.sku, name: prodA.name, qty: 1, method: "cash" });
    const sale = (await db.query("select * from sales where id>$1 order by id", [ids0.s])).rows;
    expect(sale.length === 1, "one sale");
    const s = sale[0];
    expect(s.payment_method === "cash" && money(s.total) === 65 && s.user_id === admin.id && s.cash_session_id === sess, "sale fields");
    const it = (await db.query("select * from sale_items where sale_id=$1", [s.id])).rows;
    expect(it.length === 1 && it[0].quantity === 1 && money(it[0].subtotal) === 65, "sale item");
    expect((await stock(prodA.id)) === before - 1, "stock -1");
    const im = (await db.query("select type,amount,reason from inventory_movements where id>$1", [ids0.im])).rows;
    expect(im.length === 1 && im[0].type === "OUT" && im[0].amount === -1 && im[0].reason === `Venta #${s.id}`, "inventory movement " + JSON.stringify(im));
    const cm = (await db.query("select type,amount from cash_movements where session_id=$1 and reason like $2", [sess, `Venta #${s.id}%`])).rows;
    expect(cm.length === 1 && cm[0].type === "IN" && money(cm[0].amount) === 65, "cash movement");
    expect((await cashNow(sess)) === 575, "cash 575");
    m1 = await maxIds();
    return `sale #${s.id}`;
  });
  await test("E2.sale_card_one_unit_does_not_move_cash", "e2e", async () => {
    const before = await stock(prodA.id);
    await ui.sell(page, { query: prodA.sku, name: prodA.name, qty: 1, method: "card" });
    const s = (await db.query("select * from sales where id>$1 order by id", [m1.s])).rows[0];
    expect(s && s.payment_method === "card" && money(s.total) === 65, "card sale");
    expect((await stock(prodA.id)) === before - 1, "stock -1");
    const cm = (await db.query("select amount,reason from cash_movements where session_id=$1 and reason like $2", [sess, `Venta #${s.id}%`])).rows;
    expect(cm.length === 1 && money(cm[0].amount) === 0 && /Tarjeta/.test(cm[0].reason), "informational card movement");
    expect((await cashNow(sess)) === 575, "cash unchanged");
  });
  await test("E3.sale_cash_two_units_decimal_price", "e2e", async () => {
    const m = await maxIds();
    await ui.sell(page, { query: prodB.sku, name: prodB.name, qty: 2, method: "cash" });
    const s = (await db.query("select * from sales where id>$1 order by id", [m.s])).rows[0];
    expect(s && money(s.total) === 21, "total 21.00 got " + (s && s.total));
    expect((await stock(prodB.id)) === 0, "stock 0");
    expect((await cashNow(sess)) === 596, "cash 596");
  });
  await test("E4.cash_reconciliation_matches_movements", "e2e", async () => {
    const r = await one("select cs.initial_amount + coalesce((select sum(case when type='IN' then amount else -amount end) from cash_movements where session_id=cs.id),0) as expected, cs.current_amount cur from cash_sessions cs where cs.id=$1", [sess]);
    expect(money(r.expected) === 596 && money(r.cur) === 596, JSON.stringify(r));
  });
  await test("F1.close_cash_with_expected_total", "e2e", async () => {
    await ui.nav(page, "Caja");
    const expected = await ui.closeCash(page);
    const s = await one("select * from cash_sessions where id=$1", [sess]);
    expect(money(expected) === 596 && s.status === "closed" && s.closed_at && s.closed_by === admin.id && money(s.final_amount) === 596, "closed row " + JSON.stringify({ expected, final: s.final_amount }));
    await shot("cash_closed");
  });
  await test("F2.sales_screen_shows_closed_cash", "e2e", async () => {
    await ui.nav(page, "Vender");
    await page.getByText("✗ Caja Cerrada").waitFor();
  });
  await test("A3.logout_returns_to_login", "e2e", async () => { await ui.logout(page); await page.getByText("Ingresa tu PIN para comenzar").waitFor(); });
  await test("A4.vendor_login_sees_only_vendor_navigation", "e2e", async () => {
    await ui.login(page, vendor.pin);
    await page.waitForURL(/#\/sales$/, { timeout: 8000 });
    const links = await page.getByRole("link").allInnerTexts();
    expect(!links.some((l) => /Usuarios|Dashboard|Inventario/.test(l)), "links: " + links.join(","));
    await page.goto(APP_URL + "/#/users");
    await page.waitForURL(/#\/sales$/, { timeout: 6000 });
    await shot("vendor");
  });
  await test("A5.vendor_can_open_cash_and_sell", "e2e", async () => {
    await ui.openCash(page, 100);
    const m = await maxIds();
    await ui.sell(page, { query: prodA.sku, name: prodA.name, qty: 1, method: "cash" });
    const s = (await db.query("select * from sales where id>$1 order by id", [m.s])).rows[0];
    expect(s && s.user_id === vendor.id && money(s.total) === 65, "sale attributed to the vendor session");
    await ui.nav(page, "Caja");
    await ui.closeCash(page);
  });
  c.skip("P0.packaged_build_e2e", "e2e", "not executed: the packaged build is not exercised (renderer uses absolute asset paths and BrowserRouter under file://); production coverage is NOT claimed");
  await ui.logout(page).catch(() => {});
}
