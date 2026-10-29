// Integration suite: backend behaviour through the real IPC (after a real visual login) + DB checks.
// Tests tagged knownBug assert the DESIRED behaviour of bugs confirmed in Phase 0.5 that are still open:
// they are reported as KNOWN_FAIL (strict assertions are not relaxed) and flag UNEXPECTED_PASS once fixed.
import { ui, ipc, expect, money } from "../lib/harness.mjs";

export async function run(c) {
  const { page, db, data, test } = c;
  const admin = await data.user("ADMIN", "admin");
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];

  await test("I0.admin_visual_login", "e2e", async () => {
    await ui.login(page, admin.pin);
    await page.waitForURL("**/dashboard", { timeout: 8000 });
  });

  await test("I1.sale_transaction_is_atomic_and_consistent", "integration", async () => {
    const p = await data.product("ATOM", "12.34", 5);
    const s = (await ipc(page, "api.cash.openSession(10)")).v;
    const sale = await ipc(page, `api.sales.create({items:[{productId:${p.id},quantity:2,unitPrice:12.34,subtotal:24.68}],total:24.68,paymentMethod:'cash',sessionId:${s.id}})`);
    expect(sale.ok, sale.err);
    const items = (await db.query("select sum(subtotal) t from sale_items where sale_id=$1", [sale.v.id])).rows[0].t;
    expect(money(items) === 24.68, "items sum equals total");
    expect(Number((await one("select stock from products where id=$1", [p.id])).stock) === 3, "stock 3");
    expect(money((await one("select current_amount from cash_sessions where id=$1", [s.id])).current_amount) === 34.68, "cash 34.68");
    await ipc(page, `api.cash.closeSession(${s.id},34.68)`);
  });
  await test("I2.auth_derived_user_is_recorded_on_cash_and_sales", "integration", async () => {
    const s = (await ipc(page, "api.cash.openSession(1)")).v;
    expect((await one("select opened_by from cash_sessions where id=$1", [s.id])).opened_by === admin.id, "opened_by");
    await ipc(page, `api.cash.closeSession(${s.id},1)`);
    expect((await one("select closed_by from cash_sessions where id=$1", [s.id])).closed_by === admin.id, "closed_by");
  });

  // ---- known open bugs (Phase 0.5) -------------------------------------
  await test("BUG-1.closed_session_status_becomes_closed", "integration", async () => {
    const s = (await ipc(page, "api.cash.openSession(1)")).v;
    await ipc(page, `api.cash.closeSession(${s.id},1)`);
    const st = (await one("select status from cash_sessions where id=$1", [s.id])).status;
    expect(st === "closed", `status is '${st}' after closing`);
  }, { knownBug: { id: "BUG-1", symptom: /status is 'open'/ } });
  await test("BUG-2.softDelete_marks_product_and_logs", "integration", async () => {
    const p = await data.product("DEL", "5.00", 3);
    const r = await ipc(page, `api.products.softDelete(${p.id},'e2e')`);
    expect(r.ok, "softDelete failed: " + String(r.err).split("\n")[0]);
  }, { knownBug: { id: "BUG-2", symptom: /softDelete failed/ } });
  await test("BUG-3.sale_rejects_oversell_and_tampered_total", "integration", async () => {
    const p = await data.product("OVER", "5.00", 3);
    const r = await ipc(page, `api.sales.create({items:[{productId:${p.id},quantity:10,unitPrice:5,subtotal:50}],total:0.01,paymentMethod:'card',sessionId:null})`);
    const st = Number((await one("select stock from products where id=$1", [p.id])).stock);
    expect(r.ok === false, `accepted: stock now ${st}, total 0.01 vs items 50.00, no cash session`);
  }, { knownBug: { id: "BUG-3", symptom: /accepted: stock now/ } });
  await test("BUG-4.cash_out_cannot_overdraw_session", "integration", async () => {
    const s = (await ipc(page, "api.cash.openSession(10)")).v;
    const r = await ipc(page, `api.cash.addMovement({sessionId:${s.id},type:'OUT',amount:5000,reason:'overdraw'})`);
    const cur = money((await one("select current_amount from cash_sessions where id=$1", [s.id])).current_amount);
    await ipc(page, `api.cash.closeSession(${s.id},0)`);
    expect(r.ok === false || cur >= 0, `current_amount is ${cur}`);
  }, { knownBug: { id: "BUG-4", symptom: /current_amount is -/ } });
  await test("BUG-5.only_one_cash_session_can_be_open", "integration", async () => {
    const a = (await ipc(page, "api.cash.openSession(1)")).v;
    const b = await ipc(page, "api.cash.openSession(2)");
    const open = (await one("select count(*)::int n from cash_sessions where closed_at is null")).n;
    await ipc(page, `api.cash.closeSession(${a.id},0)`);
    if (b.ok) await ipc(page, `api.cash.closeSession(${b.v.id},0)`);
    expect(b.ok === false || open < 2, `${open} sessions were open simultaneously`);
  }, { knownBug: { id: "BUG-5", symptom: /sessions were open simultaneously/ } });
  await test("BUG-6.zero_stock_product_cannot_enter_cart", "e2e", async () => {
    const p = await data.product("ZERO", "9.00", 0);
    await ui.nav(page, "Vender");
    await page.getByPlaceholder("Código, SKU o nombre...").fill(p.sku);
    await page.getByRole("button", { name: new RegExp(p.name) }).first().click();
    const inCart = await page.getByText("Carrito (1 artículo)").count();
    expect(inCart === 0, "zero-stock product was added to the cart");
  }, { knownBug: { id: "BUG-6", symptom: /zero-stock product was added/ } });

  await ui.logout(page).catch(() => {});
}
