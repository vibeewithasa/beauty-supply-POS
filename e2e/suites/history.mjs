// History suite: searchable, paginated sales history and the persisted sale detail, through the real UI.
// Old sales are inserted as fixtures (controlled dates, snapshots, returns); one sale is made through the UI to prove
// the snapshot is written by the real checkout. Reprinting is checked here only as "never creates a sale" (the
// printing path itself is covered by the receipts suite).
import fs from "node:fs";
import { APP_URL, ui, ipc, expect, closeStrayCash, launchApp, waitFor } from "../lib/harness.mjs";

export async function run(c) {
  const { db, data, test, runDb, artifacts } = c;
  let page = c.page;
  let relaunched = null;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  const num = (v) => Number(v);
  const J = JSON.stringify;

  const admin = await data.user("HIS_ADMIN", "admin");
  const v1 = await data.user("HIS_V1", "vendor");
  const v2 = await data.user("HIS_V2", "vendor");
  await closeStrayCash(db, admin.id);

  // ---------------------------------------------------------------- fixtures
  const pBulk = await data.product("HBULK", "5.00", 1000);
  const pLegacy = await data.product("HLEG", "8.00", 10);
  const pRen = await data.product("HREN", "20.00", 10);
  const pDel = await data.product("HDEL", "12.00", 10);
  const pReal = await data.product("HREAL", "6.00", 50);
  const sess = (await one(
    "insert into cash_sessions(opened_by, initial_amount, current_amount, status, opened_at, closed_at, closed_by, final_amount) values($1,'100','100','closed', $2, $3, $1, '100') returning id",
    [admin.id, new Date(2026, 2, 1, 8, 0), new Date(2026, 2, 31, 22, 0)]
  )).id;
  const mkSale = async (userId, total, method, at, items) => {
    const s = await one("insert into sales(user_id,cash_session_id,total,payment_method,created_at) values($1,$2,$3,$4,$5) returning id", [userId, sess, total, method, at]);
    for (const it of items) {
      await db.query("insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal,product_name,product_sku) values($1,$2,$3,$4,$5,$6,$7)", [s.id, it.p.id, it.q, it.price, (num(it.price) * it.q).toFixed(2), it.name ?? null, it.sku ?? null]);
    }
    return s.id;
  };
  // 130 bulk sales (more than the former 100-row ceiling), one per minute, alternating cash/card
  await db.query(`insert into sales(user_id,cash_session_id,total,payment_method,created_at)
    select $1,$2,'5.00', (case when g % 2 = 0 then 'cash' else 'card' end)::payment_method, $3::timestamptz + (g || ' minutes')::interval from generate_series(1,130) g`, [admin.id, sess, new Date(2026, 2, 5, 9, 0)]);
  await db.query(`insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal,product_name,product_sku)
    select id,$1,1,'5.00','5.00','Bulk '||id,'HB-'||id from sales where cash_session_id=$2 and created_at >= $3 and created_at < $4`, [pBulk.id, sess, new Date(2026, 2, 5, 9, 0), new Date(2026, 2, 5, 12, 0)]);
  const oldest = (await one("select min(id)::int id from sales where cash_session_id=$1", [sess])).id;
  const sLegacy = await mkSale(admin.id, "8.00", "cash", new Date(2025, 11, 31, 10, 0), [{ p: pLegacy, q: 1, price: "8.00" }]); // no snapshot
  const sRen = await mkSale(admin.id, "40.00", "card", new Date(2026, 2, 12, 11, 30), [{ p: pRen, q: 2, price: "20.00", name: "Tinte Original", sku: "TI-ORIG" }]);
  const sDel = await mkSale(admin.id, "12.00", "cash", new Date(2026, 2, 13, 16, 45), [{ p: pDel, q: 1, price: "12.00", name: "Cera Vieja", sku: "CE-OLD" }]);
  const sBoundA = await mkSale(admin.id, "5.00", "cash", new Date(2026, 2, 10, 23, 59), [{ p: pBulk, q: 1, price: "5.00", name: "Bound A", sku: "BA" }]);
  const sBoundB = await mkSale(admin.id, "5.00", "card", new Date(2026, 2, 11, 0, 0), [{ p: pBulk, q: 1, price: "5.00", name: "Bound B", sku: "BB" }]);
  const sV1 = [];
  for (let i = 0; i < 3; i++) sV1.push(await mkSale(v1.id, "5.00", "cash", new Date(2026, 3, 1 + i, 10, 0), [{ p: pBulk, q: 1, price: "5.00", name: "V1 item " + i, sku: "V1" + i }]));
  const sV2 = [];
  for (let i = 0; i < 2; i++) sV2.push(await mkSale(v2.id, "5.00", "card", new Date(2026, 3, 5 + i, 10, 0), [{ p: pBulk, q: 1, price: "5.00", name: "V2 item " + i, sku: "V2" + i }]));
  // a sale with returns (one pending, one legacy)
  const sRet = await mkSale(admin.id, "30.00", "cash", new Date(2026, 2, 14, 9, 15), [{ p: pBulk, q: 6, price: "5.00", name: "Bulk retornable", sku: "BR" }]);
  const retItem = (await one("select id from sale_items where sale_id=$1", [sRet])).id;
  const ret1 = (await one("insert into returns(sale_id,total_refund,refund_status,reason,processed_by,created_at) values($1,'10.00','pending','Cliente se arrepintió',$2,$3) returning id", [sRet, admin.id, new Date(2026, 2, 14, 10, 0)])).id;
  await db.query("insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values($1,$2,$3,2,'10.00')", [ret1, retItem, pBulk.id]);
  const ret2 = (await one("insert into returns(sale_id,total_refund,refund_status,reason,processed_by,created_at) values($1,'5.00','legacy_unspecified','Devolución antigua',$2,$3) returning id", [sRet, admin.id, new Date(2026, 2, 14, 11, 0)])).id;
  await db.query("insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values($1,$2,$3,1,'5.00')", [ret2, retItem, pBulk.id]);
  // the catalog changes AFTER those sales were made
  await db.query("update products set name='Tinte Renombrado', sku='TI-NEW' where id=$1", [pRen.id]);
  await db.query("update products set name='Cera ELIMINADA', status='deleted', stock=0 where id=$1", [pDel.id]);

  const table = () => page.getByRole("table", { name: "Ventas" });
  const bodyRows = () => table().locator("tbody tr");
  const folios = async () => (await bodyRows().locator("td:first-child").allInnerTexts()).map((t) => num(t.replace("#", "")));
  const apply = async ({ q = "", from = "", to = "", method = "" } = {}) => {
    await page.locator("#hs-q").fill(q);
    await page.locator("#hs-from").fill(from);
    await page.locator("#hs-to").fill(to);
    await page.locator("#hs-method").selectOption(method);
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
  };
  const summary = () => page.getByTestId("history-summary");
  const openDetail = async (id) => {
    await apply({ q: String(id) });
    await page.getByRole("button", { name: `Ver venta ${id}` }).click();
    await page.getByRole("dialog").getByText(`Venta #${id}`).first().waitFor();
    return page.getByRole("dialog");
  };
  // Escape closes one layer at a time; pressing it while a previous layer is still animating out can be swallowed
  const closeDialog = async () => {
    for (let i = 0; i < 5; i++) {
      if ((await page.getByRole("dialog").count()) === 0) return;
      await page.keyboard.press("Escape");
      await page.waitForTimeout(350);
    }
    await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 3000 });
  };

  await test("HIS-00.admin_opens_the_history_from_the_navigation_newest_first", "e2e", async () => {
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    await ui.nav(page, "Historial");
    await page.waitForURL(/#\/history$/, { timeout: 5000 });
    await table().waitFor();
    const total = (await one("select count(*)::int n from sales")).n;
    await summary().getByText(new RegExp(`^${total} ventas · Página 1 de ${Math.ceil(total / 20)}$`)).waitFor();
    const f = await folios();
    expect(f.length === 20, "20 rows per page: " + f.length);
    const dbOrder = (await rows("select id from sales order by created_at desc, id desc limit 20")).map((r) => r.id);
    expect(J(f) === J(dbOrder), "newest first, same order as PostgreSQL: " + J(f) + " vs " + J(dbOrder));
  });

  await test("HIS-01.pagination_reaches_every_sale_not_just_the_last_100", "e2e", async () => {
    const total = (await one("select count(*)::int n from sales")).n;
    expect(total > 130, "precondition: more than 100 sales exist (" + total + ")");
    const pages = Math.ceil(total / 20);
    const seen = new Set(await folios());
    await page.getByRole("button", { name: "Anterior" }).isDisabled().then((d) => expect(d, "Anterior is disabled on the first page"));
    for (let p = 2; p <= pages; p++) {
      await page.getByRole("button", { name: "Siguiente" }).click();
      await summary().getByText(new RegExp(`Página ${p} de ${pages}`)).waitFor();
      // the page label changes before the rows do: wait until the table shows rows that are not the previous page's (a REAL
      // repetition across pages would never get here and fails below)
      await waitFor(async () => { const ids = await folios(); return ids.length > 0 && ids.every((id) => !seen.has(id)); }, 8000);
      for (const id of await folios()) { expect(!seen.has(id), "no sale repeated across pages: " + id); seen.add(id); }
    }
    expect(seen.size === total, `every one of the ${total} sales was reached by paging (${seen.size})`);
    expect(seen.has(oldest), "the oldest sale of the database is reachable");
    expect(await page.getByRole("button", { name: "Siguiente" }).isDisabled(), "Siguiente is disabled on the last page");
    const bad = await ipc(page, "api.sales.list({page:1,pageSize:101})");
    expect(bad.ok === false && /\[PAGINA_INVALIDA\]/.test(bad.err), "page size is capped in main: " + J(bad));
  });

  await test("HIS-02.search_by_folio_with_and_without_hash_and_clear_errors", "e2e", async () => {
    await apply({ q: String(oldest) });
    await bodyRows().first().waitFor();
    expect(J(await folios()) === J([oldest]), "oldest sale found by folio");
    await apply({ q: `#${sRen}` });
    await page.getByRole("button", { name: `Ver venta ${sRen}` }).waitFor();
    expect((await bodyRows().count()) === 1, "# prefix accepted");
    await apply({ q: "99999999" });
    await page.getByText("No hay ventas que coincidan").waitFor();
    await apply({ q: "abc" });
    await page.getByRole("alert").getByText(/folio/i).waitFor();
    await page.getByRole("button", { name: "Limpiar", exact: true }).click();
    await bodyRows().first().waitFor();
  });

  await test("HIS-03.date_range_includes_both_end_days_and_method_filter_combines", "e2e", async () => {
    // 2026-03-10 23:59 and 2026-03-11 00:00 straddle midnight
    await apply({ from: "2026-03-10", to: "2026-03-10" });
    await page.getByRole("button", { name: `Ver venta ${sBoundA}` }).waitFor();
    let f = await folios();
    expect(f.includes(sBoundA) && !f.includes(sBoundB), "10th: 23:59 in, 00:00 of the 11th out: " + J(f));
    await apply({ from: "2026-03-11", to: "2026-03-11" });
    await page.getByRole("button", { name: `Ver venta ${sBoundB}` }).waitFor();
    f = await folios();
    expect(f.includes(sBoundB) && !f.includes(sBoundA), "11th: only the 00:00 sale");
    const exp = await rows("select id from sales where created_at >= $1 and created_at < $2 and payment_method='card' order by created_at desc, id desc", [new Date(2026, 2, 5), new Date(2026, 2, 6)]);
    await apply({ from: "2026-03-05", to: "2026-03-05", method: "card" });
    await summary().getByText(new RegExp(`^${exp.length} ventas`)).waitFor();
    expect(J(await folios()) === J(exp.slice(0, 20).map((r) => r.id)), "card sales of the 5th, same rows and order as SQL");
    await apply({ from: "2026-03-20", to: "2026-03-01" });
    await page.getByRole("alert").getByText(/no puede ser posterior/).waitFor();
    await apply({ from: "2030-01-01", to: "2030-01-02" });
    await page.getByText("No hay ventas que coincidan").waitFor();
  });

  await test("HIS-04.detail_of_a_sale_from_a_closed_cash_session_and_a_previous_day", "e2e", async () => {
    const d = await openDetail(sLegacy);
    await d.getByText(/Caja: #\d+ \(cerrada\)/).waitFor();
    await d.getByText(new Date(2025, 11, 31, 10, 0).toLocaleString()).waitFor();
    expect((await d.getByTestId("detail-total").innerText()) === "$8.00", "total");
    await d.getByText("Vendedor:").locator("strong").getByText(admin.name).waitFor();
    await closeDialog();
  });

  await test("HIS-05.old_sales_keep_the_product_as_it_was_sold_even_if_renamed_or_deleted", "e2e", async () => {
    let d = await openDetail(sRen);
    await d.getByText("Tinte Original").waitFor();
    expect(await d.getByText("Tinte Renombrado").count() === 0, "the new catalog name is NOT shown");
    expect((await d.getByText("nombre actual del catálogo").count()) === 0, "a snapshot is not flagged as catalog data");
    await d.getByText("TI-ORIG").waitFor();
    await closeDialog();
    d = await openDetail(sDel);
    await d.getByText("Cera Vieja").waitFor();
    await d.getByText(/producto eliminado/).waitFor();
    expect(await d.getByText("Cera ELIMINADA").count() === 0, "deleted product keeps its sold identity");
    await closeDialog();
    d = await openDetail(sLegacy);
    await d.getByText(pLegacy.name).waitFor();
    await d.getByText(/nombre actual del catálogo/).waitFor(); // honest: no stored historical name exists for this old sale
    await closeDialog();
  });

  await test("HIS-06.related_returns_are_listed_with_their_refund_status", "e2e", async () => {
    const d = await openDetail(sRet);
    await d.getByText("Devoluciones", { exact: true }).waitFor();
    await d.getByText(`Devolución #${ret1}`).waitFor();
    await d.getByText("PENDIENTE DE REEMBOLSO").waitFor();
    await d.getByText("Anterior al control de reembolsos").waitFor();
    await d.getByText("Cliente se arrepintió").waitFor();
    expect(await d.getByRole("button", { name: /pagado|marcar/i }).count() === 0, "no control settles a refund");
    await closeDialog();
    await apply({ from: "2026-03-14", to: "2026-03-14" });
    await page.getByRole("row", { name: new RegExp(`#${sRet}`) }).getByText("Con devolución").waitFor();
  });

  await test("HIS-07.preview_and_reprint_never_create_sales_or_movements", "e2e", async () => {
    const before = await one("select (select count(*) from sales)::int s, (select count(*) from sale_items)::int i, (select count(*) from inventory_movements)::int m, (select count(*) from cash_movements)::int c, (select coalesce(sum(stock),0) from products)::int st");
    const d = await openDetail(sRen);
    await d.getByRole("button", { name: "Ver recibo" }).click();
    const rd = page.getByRole("dialog").filter({ hasText: `Recibo de la venta #${sRen}` });
    await rd.waitFor({ timeout: 6000 }).catch(async (e) => {
      const info = await page.evaluate(() => ({ dialogs: [...document.querySelectorAll('[role="dialog"]')].map((d) => d.textContent.slice(0, 60)), iframes: document.querySelectorAll("iframe").length }));
      throw new Error("receipt dialog did not open: " + JSON.stringify(info) + " " + String(e.message).split(" ")[0]);
    });
    const frame = page.frameLocator('iframe[title="Vista previa del recibo"]');
    await frame.getByText("Tinte Original").waitFor({ timeout: 8000 });
    expect(await frame.getByText("REIMPRESIÓN").count() === 0, "the first preview is not marked as a copy");
    await rd.getByRole("button", { name: "Cerrar" }).click();
    await d.getByRole("button", { name: "Reimprimir" }).click();
    const rd2 = page.getByRole("dialog").filter({ hasText: `Recibo de la venta #${sRen}` });
    await page.frameLocator('iframe[title="Vista previa del recibo"]').getByText("REIMPRESIÓN").waitFor({ timeout: 8000 });
    await rd2.getByRole("button", { name: "Cerrar" }).click();
    await closeDialog();
    const after = await one("select (select count(*) from sales)::int s, (select count(*) from sale_items)::int i, (select count(*) from inventory_movements)::int m, (select count(*) from cash_movements)::int c, (select coalesce(sum(stock),0) from products)::int st");
    expect(J(before) === J(after), "nothing was written: " + J({ before, after }));
  });

  await test("HIS-08.a_real_checkout_stores_the_product_as_sold_and_it_shows_up_first", "e2e", async () => {
    await ui.openCash(page, 50);
    await ui.sell(page, { query: pReal.sku, name: pReal.name, qty: 2, method: "cash" }).catch((e) => { throw new Error(String(e.message).replace(/s+/g, " ").slice(0, 600)); });
    const s = await one("select s.id, i.product_name, i.product_sku from sales s join sale_items i on i.sale_id=s.id order by s.id desc limit 1");
    expect(s.product_name === pReal.name && s.product_sku === pReal.sku, "the checkout wrote the snapshot: " + J(s));
    await db.query("update products set name='Nombre Cambiado Despues' where id=$1", [pReal.id]);
    await ui.nav(page, "Caja");
    await ui.closeCash(page);
    await ui.nav(page, "Historial");
    await table().waitFor();
    expect((await folios())[0] === s.id, "the new sale is the first row");
    const d = await openDetail(s.id);
    await d.getByText(pReal.name).waitFor();
    expect(await d.getByText("Nombre Cambiado Despues").count() === 0, "renaming after the sale does not change its record");
    await d.getByText(/Caja: #\d+ \(cerrada\)/).waitFor();
    await closeDialog();
  });

  await test("HIS-09.vendors_see_only_their_own_sales_and_cannot_probe_others", "security", async () => {
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, v1.pin);
    await page.waitForURL(/#\/sales$/, { timeout: 8000 });
    await ui.nav(page, "Historial");
    await table().waitFor();
    await summary().getByText(/^3 ventas · Página 1 de 1$/).waitFor();
    expect(J((await folios()).sort()) === J([...sV1].sort()), "exactly their 3 sales: " + J(await folios()));
    await apply({ q: String(sV2[0]) });
    await page.getByText("No hay ventas que coincidan").waitFor();
    for (const id of [sV2[0], sRen, oldest]) {
      const r = await ipc(page, `api.sales.getDetail(${id})`);
      expect(r.ok === false && /\[VENTA_NO_ENCONTRADA\]/.test(r.err), `another seller's sale ${id} is "not found": ` + J(r));
      const p = await ipc(page, `api.receipts.preview(${id})`);
      expect(p.ok === false && /\[VENTA_NO_ENCONTRADA\]/.test(p.err), `no receipt for another seller's sale ${id}: ` + J(p));
    }
    await page.getByRole("button", { name: "Limpiar", exact: true }).click();
    const d = await openDetail(sV1[0]);
    await d.getByText("V1 item 0").waitFor();
    await d.getByRole("button", { name: "Ver recibo" }).click();
    await page.frameLocator('iframe[title="Vista previa del recibo"]').getByText("V1 item 0").waitFor({ timeout: 8000 });
    await page.getByRole("dialog").filter({ hasText: "Recibo de la venta" }).getByRole("button", { name: "Cerrar" }).click();
    await closeDialog();
    const all = await ipc(page, "api.sales.list({page:1,pageSize:100})");
    expect(all.ok && all.v.total === 3 && all.v.rows.every((r) => r.userId === v1.id), "IPC list is also limited to the caller: " + J(all.ok ? all.v.total : all));
    for (const route of ["/settings", "/reports"]) {
      await page.goto(APP_URL + "/#" + route);
      await page.waitForTimeout(500);
      expect(!new URL(page.url()).hash.startsWith("#" + route), "vendor redirected away from " + route);
    }
  });

  await test("HIS-10.history_survives_an_application_restart", "e2e", async () => {
    await c.app.close();
    relaunched = await launchApp(runDb, db, artifacts, {});
    page = relaunched.page;
    await page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 15000 });
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    await ui.nav(page, "Historial");
    await table().waitFor();
    const total = (await one("select count(*)::int n from sales")).n;
    await summary().getByText(new RegExp(`^${total} ventas`)).waitFor();
    const d = await openDetail(sRen);
    await d.getByText("Tinte Original").waitFor();
    await d.getByText(/Caja: #\d+ \(cerrada\)/).waitFor();
    await closeDialog();
    await apply({ q: String(oldest) });
    await page.getByRole("button", { name: `Ver venta ${oldest}` }).waitFor();
  });

  // the suite owns the relaunched instance
  if (relaunched) {
    await relaunched.app.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(relaunched.userData, { recursive: true, force: true });
  }
}
