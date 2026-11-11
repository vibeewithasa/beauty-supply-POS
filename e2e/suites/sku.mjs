// SKU suite (Sprint 08A): automatic SKU generation, through the real window and the real IPC, verified in PostgreSQL.
// Creating a product never asks for a SKU; PostgreSQL's sequence guarantees uniqueness under concurrency; existing SKUs are untouched;
// the barcode stays independent and optional; searching by SKU and by barcode keeps working.
import fs from "node:fs";
import path from "node:path";
import { APP_URL, ui, ipc, expect, forbidden, closeStrayCash } from "../lib/harness.mjs";

const SKU_RE = /^EL-[0-9]{6,}$/;
const J = JSON.stringify;

export async function run(c) {
  const { page, db, data, test, artifacts, runId } = c;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  const call = (expr) => ipc(page, expr);
  const create = (body) => call(`api.products.create(${J(body)})`);
  const settled = (calls) => call(`Promise.allSettled([${calls.join(",")}]).then(rs => rs.map(x => ({ ok: x.status === 'fulfilled', v: x.value, err: x.reason && x.reason.message })))`);
  const expected = (id) => "EL-" + String(id).padStart(6, "0");
  const admin = await data.user("SKU_ADMIN", "admin");
  const vendor = await data.user("SKU_VEND", "vendor");
  await closeStrayCash(db, admin.id);
  // products that already exist before the feature is used: their SKUs must survive untouched
  const legacy = [];
  for (const [label, sku] of [["L1", "SHAMPOO-500"], ["L2", "7501-ABC.9/x"], ["L3", "EL-000001"]]) {
    const r = await one("insert into products(sku,name,price,stock,category) values($1,$2,'5.00',4,'E2E') returning id, sku, name, price, stock", [sku + "-" + runId, "Legacy " + label]);
    legacy.push(r);
  }
  const legacySnapshot = async () => J(await rows("select id, sku, name, price::text, stock, barcode, status from products where id = any($1) order by id", [legacy.map((l) => l.id)]));
  const legacyBefore = await legacySnapshot();

  await test("SKU-00.admin_login", "e2e", async () => {
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
  });

  // ================================================================== the screen
  await test("SKU-01.creating_a_product_in_the_screen_asks_for_no_sku_and_shows_the_generated_one", "e2e", async () => {
    await ui.nav(page, "Productos");
    await page.getByRole("button", { name: /Nuevo Producto/ }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByText("Nuevo producto").waitFor();
    expect((await dlg.getByLabel("SKU").count()) === 0 && (await dlg.locator("#pf-sku").count()) === 0, "there is no SKU field to fill");
    expect((await dlg.getByTestId("sku-auto-note").innerText()).includes("EL-000001"), "an informative note explains the automatic SKU");
    await dlg.getByLabel("Nombre").fill(`Producto automático ${runId}`);
    await dlg.getByLabel("Precio inicial").fill("19.90");
    await dlg.getByLabel("Stock inicial").fill("6");
    await dlg.getByRole("button", { name: "Crear producto" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: /SKU EL-\d{6,}/ }).first().waitFor({ timeout: 6000 });
    const p = await one("select * from products where name=$1", [`Producto automático ${runId}`]);
    expect(SKU_RE.test(p.sku) && p.sku === expected(p.id), "sku " + p.sku + " for id " + p.id);
    expect(p.barcode === null && p.stock === 6 && Number(p.price) === 19.9, "barcode left empty stays null: " + J(p));
    const mv = await rows("select type, amount, reason from inventory_movements where product_id=$1", [p.id]);
    expect(mv.length === 1 && mv[0].reason === "Stock inicial", "initial stock history is unchanged: " + J(mv));
    await page.getByLabel("Buscar productos").fill(p.sku);
    await page.getByRole("cell", { name: p.sku, exact: true }).waitFor();
  });

  await test("SKU-02.editing_shows_the_sku_as_read_only_information_and_never_changes_it", "e2e", async () => {
    const p = await one("select * from products where name=$1", [`Producto automático ${runId}`]);
    await page.getByLabel("Buscar productos").fill(p.sku);
    await page.getByRole("button", { name: `Editar Producto automático ${runId}` }).click();
    const dlg = page.getByRole("dialog");
    const field = dlg.getByLabel("SKU");
    await field.waitFor();
    expect((await field.inputValue()) === p.sku && (await field.getAttribute("readonly")) !== null, "read-only field with the SKU");
    await dlg.getByLabel("Nombre").fill(`Renombrado ${runId}`);
    await dlg.getByRole("button", { name: "Guardar cambios" }).click();
    await page.locator("[data-sonner-toast]").filter({ hasText: "Producto actualizado" }).first().waitFor({ timeout: 6000 });
    const after = await one("select name, sku from products where id=$1", [p.id]);
    expect(after.sku === p.sku && after.name === `Renombrado ${runId}`, "name changed, SKU kept: " + J(after));
    await page.getByLabel("Buscar productos").fill("");
  });

  // ================================================================== the API contract
  await test("SKU-03.the_backend_refuses_a_client_sku_and_any_attempt_to_change_one", "integration", async () => {
    const before = (await one("select count(*)::int n from products")).n;
    for (const sku of ["MI-SKU", "EL-000999", "", null]) {
      const r = await create({ sku, name: "x", price: "1.00" });
      expect(r.ok === false && String(r.err).includes("[SKU_AUTOMATICO]"), `create with sku ${J(sku)}: ${J(r)}`);
    }
    expect((await one("select count(*)::int n from products")).n === before, "nothing persisted");
    const target = legacy[0];
    for (const sku of ["OTRO", target.sku, ""]) {
      const r = await call(`api.products.update(${target.id}, ${J({ sku })})`);
      expect(r.ok === false && String(r.err).includes("[SKU_NO_MODIFICABLE]"), `update with sku ${J(sku)}: ${J(r)}`);
    }
    expect((await legacySnapshot()) === legacyBefore, "existing products are exactly as they were");
  });

  // ================================================================== concurrency
  await test("SKU-10.concurrent_creations_never_share_a_sku", "integration", async () => {
    const all = [];
    const t0 = Date.now();
    for (let round = 0; round < 3; round++) {
      const calls = Array.from({ length: 20 }, (_, i) => `api.products.create(${J({ name: `Concurrente ${runId} r${round} n${i}`, price: "1.00", stock: 1 })})`);
      const rs = (await settled(calls)).v;
      expect(rs.every((r) => r.ok), "every creation succeeded: " + J(rs.filter((r) => !r.ok)));
      all.push(...rs.map((r) => r.v));
    }
    const skus = all.map((p) => p.sku);
    const ids = all.map((p) => p.id);
    expect(new Set(skus).size === 60 && new Set(ids).size === 60, "60 concurrent creations, 60 distinct SKUs and ids");
    expect(skus.every((s) => SKU_RE.test(s)) && all.every((p) => p.sku === expected(p.id)), "every SKU is EL- plus its own id");
    const inDb = await rows("select sku, count(*)::int n from products group by sku having count(*) > 1");
    expect(inDb.length === 0, "no duplicate SKU in the table: " + J(inDb));
    const mv = (await one("select count(*)::int n from inventory_movements where reason='Stock inicial' and product_id = any($1)", [ids])).n;
    expect(mv === 60, "one initial-stock movement per product: " + mv);
    fs.writeFileSync(path.join(artifacts, "sku-concurrency-evidence.json"), J({ rounds: 3, perRound: 20, ms: Date.now() - t0, distinct: new Set(skus).size, skus: [...skus].sort(), duplicatesInTable: inDb.length }, null, 1));
    // the database itself refuses a second row with the same SKU
    let code = null;
    try { await db.query("insert into products(sku,name,price,stock) values($1,'dup','1.00',0)", [skus[0]]); } catch (e) { code = e.code; }
    expect(code === "23505", "PostgreSQL's unique constraint backs the guarantee: " + code);
  });

  await test("SKU-11.two_independent_database_sessions_drawing_numbers_at_once_never_collide", "integration", async () => {
    const { connectRunDb } = await import("../lib/harness.mjs");
    const conns = await Promise.all([connectRunDb(c.runDb), connectRunDb(c.runDb), connectRunDb(c.runDb), connectRunDb(c.runDb)]);
    try {
      const draw = (cn) => Promise.all(Array.from({ length: 50 }, () => cn.query("select nextval(pg_get_serial_sequence('products','id'))::int as id").then((r) => r.rows[0].id)));
      const drawn = (await Promise.all(conns.map(draw))).flat();
      expect(new Set(drawn).size === 200, "200 numbers drawn from 4 sessions are all distinct");
    } finally { await Promise.all(conns.map((x) => x.end().catch(() => {}))); }
  });

  await test("SKU-12.a_sku_already_taken_by_an_old_product_is_skipped_never_reused_or_overwritten", "integration", async () => {
    const next = Number((await one("select case when is_called then last_value + 1 else last_value end n from products_id_seq")).n);
    const ahead = [0, 1, 2].map((k) => expected(next + k)); // the next three numbers are occupied by old manual SKUs
    for (const [i, sku] of ahead.entries()) await db.query("insert into products(id,sku,name,price,stock) values($1,$2,$3,'1.00',0)", [next + 5_000_000 + i, sku, `Old manual ${i}`]);
    const r = await create({ name: `Tras SKUs ocupados ${runId}`, price: "3.00" });
    expect(r.ok, r.err);
    expect(!ahead.includes(r.v.sku) && SKU_RE.test(r.v.sku) && r.v.sku === expected(r.v.id), "generated " + r.v.sku + " skipping " + ahead.join(","));
    const olds = await rows("select name, sku from products where sku = any($1) order by sku", [ahead]);
    expect(olds.length === 3 && olds.every((o, i) => o.name === `Old manual ${i}`), "the three occupied SKUs still belong to their products: " + J(olds));
  });

  await test("SKU-13.existing_skus_and_their_products_are_untouched_after_all_of_this", "integration", async () => {
    expect((await legacySnapshot()) === legacyBefore, "legacy products unchanged");
    const l3 = await one("select sku from products where id=$1", [legacy[2].id]);
    expect(l3.sku === "EL-000001-" + runId, "an old SKU that looks like the new format is preserved: " + l3.sku);
  });

  // ================================================================== barcode independence and search
  await test("SKU-14.barcode_is_independent_and_optional_and_both_identifiers_find_the_product", "integration", async () => {
    const withCode = await create({ name: `Con código ${runId}`, price: "8.00", stock: 3, barcode: "7501234500017" });
    const without1 = await create({ name: `Sin código A ${runId}`, price: "2.00" });
    const without2 = await create({ name: `Sin código B ${runId}`, price: "2.00" });
    expect(withCode.ok && without1.ok && without2.ok, "created: " + J([withCode, without1, without2].filter((r) => !r.ok)));
    expect(withCode.v.barcode === "7501234500017" && without1.v.barcode === null && without2.v.barcode === null, "the barcode is stored as given, or stays null");
    expect(withCode.v.sku !== withCode.v.barcode && SKU_RE.test(withCode.v.sku), "SKU and barcode are different fields");
    const bySku = await call(`api.products.findBySkuOrBarcode(${J(withCode.v.sku)})`);
    const byBarcode = await call(`api.products.findBySkuOrBarcode("7501234500017")`);
    expect(bySku.ok && bySku.v?.id === withCode.v.id && byBarcode.ok && byBarcode.v?.id === withCode.v.id, "found by SKU and by barcode: " + J([bySku.v?.id, byBarcode.v?.id]));
    const byLegacy = await call(`api.products.findBySkuOrBarcode(${J(legacy[0].sku)})`);
    expect(byLegacy.ok && byLegacy.v?.id === legacy[0].id, "an old SKU is still found");
    const bad = await create({ name: "x", price: "1.00", barcode: "has space" });
    expect(bad.ok === false && String(bad.err).includes("[CAMPO_INVALIDO]"), "barcode validation unchanged: " + J(bad));
  });

  await test("SKU-15.the_sales_screen_finds_a_generated_sku_and_sells_it_without_changing_the_money_flow", "e2e", async () => {
    await closeStrayCash(db, admin.id);
    const prod = await create({ name: `Venta SKU ${runId}`, price: "10.00", stock: 5 });
    expect(prod.ok, prod.err);
    await ui.openCash(page, 50);
    await ui.sell(page, { query: prod.v.sku, name: `Venta SKU ${runId}`, qty: 2, method: "cash" });
    const sale = await one("select total, payment_method from sales order by id desc limit 1");
    const item = await one("select product_sku, product_name, quantity from sale_items order by id desc limit 1");
    expect(Number(sale.total) === 20 && sale.payment_method === "cash", "sale " + J(sale));
    expect(item.product_sku === prod.v.sku && item.quantity === 2, "the sale line stores the generated SKU as sold: " + J(item));
    expect((await one("select stock from products where id=$1", [prod.v.id])).stock === 3, "stock decremented as always");
    await ui.nav(page, "Caja");
    await ui.closeCash(page);
  });

  // ================================================================== roles
  await test("SKU-16.a_vendor_cannot_create_products_so_cannot_draw_skus", "security", async () => {
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, vendor.pin);
    await page.getByText("Carrito (0 artículos)").waitFor();
    const before = (await one("select count(*)::int n from products")).n;
    const r = await create({ name: "Vendedor", price: "1.00" });
    expect(forbidden(r), "vendor create is refused: " + J(r));
    expect((await one("select count(*)::int n from products")).n === before, "nothing was created");
    const seq = Number((await one("select last_value from products_id_seq")).last_value);
    const r2 = await create({ name: "Vendedor 2", price: "1.00" });
    expect(forbidden(r2) && Number((await one("select last_value from products_id_seq")).last_value) === seq, "a refused request does not even consume a number");
  });
}
