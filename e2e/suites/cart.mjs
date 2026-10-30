// Cart suite (visual + checkout idempotency): the sales screen as an operator uses it. Every effect is verified in
// PostgreSQL. Barcode scanners are simulated as a keyboard wedge (fast typing + Enter); no physical scanner was used.
import { APP_URL, ui, ipc, expect, closeStrayCash } from "../lib/harness.mjs";

export async function run(c) {
  const { page, db, data, test, runId } = c;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const num = (v) => Number(v);
  const J = JSON.stringify;
  const salesCount = async () => (await one("select count(*)::int n from sales")).n;
  const lines = () => page.getByTestId("cart-line");
  const search = page.getByPlaceholder("Código, SKU o nombre...");
  const toastTexts = () => page.evaluate(() => [...document.querySelectorAll("[data-sonner-toast]")].map((t) => t.textContent));
  const admin = await data.user("CART_ADMIN", "admin");
  const A = await data.product("CA", "10.00", 50);
  const B = await data.product("CB", "4.50", 50);
  const C = await data.product("CC", "2.25", 3);
  await db.query("update products set barcode=$1 where id=$2", [`7501${runId.replace(/\D/g, "").padEnd(6, "0").slice(0, 6)}1`, A.id]);
  const BARCODE = (await one("select barcode from products where id=$1", [A.id])).barcode;
  await closeStrayCash(db, admin.id);

  const add = async (p) => {
    await search.fill(p.sku);
    await page.getByRole("option", { name: new RegExp(p.name) }).first().click();
  };
  const emptyCart = async () => {
    if ((await lines().count()) === 0) return;
    await page.getByRole("button", { name: "Limpiar", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Limpiar carrito" }).click();
    await page.getByText("Carrito vacío").waitFor();
  };

  await test("CART-00.login_and_open_cash", "e2e", async () => {
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    await ui.openCash(page, 100);
    await ui.nav(page, "Vender");
    await page.getByText("Carrito (0 artículos)").waitFor();
  });

  // ================================================================== A1 no toast, Pay stays reachable
  await test("CART-01.adding_a_product_shows_no_toast_and_the_pay_button_stays_reachable", "e2e", async () => {
    await add(A);
    await lines().first().waitFor();
    await page.waitForTimeout(400);
    const toasts = await toastTexts();
    expect(!toasts.some((t) => /agregado/i.test(t)), "no 'agregado al carrito' toast: " + J(toasts));
    expect((await page.getByTestId("cart-total").innerText()) === "$10.00", "the cart total changed immediately");
    // an error toast must not cover Pagar either
    await search.fill(C.sku);
    await page.getByRole("option", { name: new RegExp(C.name) }).first().click();
    await db.query("update products set stock=0 where id=$1", [C.id]); // make the NEXT add fail
    await page.getByRole("button", { name: "Pagar" }).waitFor();
    const covered = async () => page.evaluate(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Pagar");
      const r = b.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !(top && (top === b || b.contains(top)));
    });
    expect(!(await covered()), "Pagar is not covered");
    await search.fill(C.sku);
    await page.getByRole("option", { name: new RegExp(C.name) }).first().click();
    await page.locator("[data-sonner-toast]").first().waitFor({ timeout: 4000 }).catch(() => {});
    expect(!(await covered()), "Pagar is not covered while an error toast is visible");
    await db.query("update products set stock=3 where id=$1", [C.id]);
    await emptyCart();
  });

  // ================================================================== A2 clear
  await test("CART-02.clear_asks_first_cancel_keeps_the_cart_confirm_empties_it_without_db_writes", "e2e", async () => {
    await add(A); await add(B);
    const n0 = await salesCount();
    const mv0 = (await one("select count(*)::int n from inventory_movements")).n;
    await page.getByRole("button", { name: "Limpiar", exact: true }).click();
    const dlg = page.getByRole("alertdialog");
    await dlg.getByText(/Se quitarán 2 productos \(2 unidades\)/).waitFor();
    await dlg.getByRole("button", { name: "Cancelar" }).click();
    await dlg.waitFor({ state: "hidden" });
    expect((await lines().count()) === 2 && (await page.getByTestId("cart-total").innerText()) === "$14.50", "cancel keeps the cart exactly as it was");
    await page.getByRole("button", { name: "Limpiar", exact: true }).click();
    await dlg.getByRole("button", { name: "Limpiar carrito" }).click();
    await page.getByText("Carrito vacío").waitFor();
    expect((await salesCount()) === n0 && (await one("select count(*)::int n from inventory_movements")).n === mv0, "no database writes");
    expect(await page.getByRole("button", { name: "Limpiar", exact: true }).count() === 0, "no Limpiar control (and so no confirmation) when the cart is empty");
  });

  // ================================================================== A3 remove / minus
  await test("CART-03.removing_an_item_asks_first_and_only_that_item_goes", "e2e", async () => {
    await add(A); await add(B);
    await page.getByRole("button", { name: `Quitar ${A.name}` }).click();
    const dlg = page.getByRole("alertdialog");
    await dlg.getByText(new RegExp(`${A.name} · cantidad 1`)).waitFor();
    await dlg.getByRole("button", { name: "Cancelar" }).click();
    await dlg.waitFor({ state: "hidden" });
    expect((await lines().count()) === 2, "cancel keeps both lines");
    await page.getByRole("button", { name: `Quitar ${A.name}` }).click();
    await dlg.getByRole("button", { name: "Quitar producto" }).click();
    await dlg.waitFor({ state: "hidden" });
    expect((await lines().count()) === 1 && (await lines().first().innerText()).includes(B.name), "only A was removed");
    await emptyCart();
  });
  await test("CART-04.minus_from_1_to_0_asks_but_5_to_4_does_not", "e2e", async () => {
    await add(A);
    await page.getByRole("button", { name: `Aumentar ${A.name}` }).click();
    await page.getByRole("button", { name: `Aumentar ${A.name}` }).click();
    expect(num(await page.getByLabel(`Cantidad de ${A.name}`).inputValue()) === 3, "quantity 3");
    await page.getByRole("button", { name: `Disminuir ${A.name}` }).click();
    expect(num(await page.getByLabel(`Cantidad de ${A.name}`).inputValue()) === 2 && (await page.getByRole("alertdialog").count()) === 0, "3 -> 2 is immediate");
    await page.getByRole("button", { name: `Disminuir ${A.name}` }).click();
    expect(num(await page.getByLabel(`Cantidad de ${A.name}`).inputValue()) === 1 && (await page.getByRole("alertdialog").count()) === 0, "2 -> 1 is immediate");
    await page.getByRole("button", { name: `Disminuir ${A.name}` }).click();
    const dlg = page.getByRole("alertdialog");
    await dlg.getByText(/cantidad 1/).waitFor();
    await dlg.getByRole("button", { name: "Cancelar" }).click();
    await dlg.waitFor({ state: "hidden" });
    expect(num(await page.getByLabel(`Cantidad de ${A.name}`).inputValue()) === 1, "cancel keeps quantity 1");
    await page.getByLabel(`Cantidad de ${A.name}`).fill("0");
    await dlg.waitFor();
    await dlg.getByRole("button", { name: "Cancelar" }).click();
    await page.getByRole("button", { name: `Disminuir ${A.name}` }).click();
    await dlg.getByRole("button", { name: "Quitar producto" }).click();
    await page.getByText("Carrito vacío").waitFor();
  });

  // ================================================================== A4/A5 checkout
  const pay = async (method = "cash") => {
    await page.getByRole("button", { name: "Pagar" }).click();
    const d = page.getByRole("dialog");
    await d.getByRole("tab", { name: method === "cash" ? "Efectivo" : "Tarjeta" }).click();
    return d;
  };
  await test("CART-05.double_click_on_complete_sale_creates_exactly_one_sale", "e2e", async () => {
    await add(A);
    await page.getByRole("button", { name: `Aumentar ${A.name}` }).click(); // 2 units
    const n0 = await salesCount();
    const stock0 = (await one("select stock from products where id=$1", [A.id])).stock;
    const cm0 = (await one("select count(*)::int n from cash_movements")).n;
    const d = await pay("cash");
    const btn = d.getByRole("button", { name: /Completar Venta|Procesando/ });
    await btn.dblclick();
    await page.getByRole("dialog").getByText("Venta Completada").waitFor({ timeout: 8000 });
    await page.waitForTimeout(600);
    expect((await salesCount()) === n0 + 1, "one sale: " + ((await salesCount()) - n0));
    expect((await one("select stock from products where id=$1", [A.id])).stock === stock0 - 2, "stock decreased once");
    expect((await one("select count(*)::int n from cash_movements")).n === cm0 + 1, "one cash movement");
  });
  await test("CART-06.completed_modal_shows_persisted_data_and_cannot_be_dismissed_by_accident", "e2e", async () => {
    const s = await one("select id, total, payment_method, created_at from sales order by id desc limit 1");
    const dlg = page.getByRole("dialog");
    expect((await dlg.getByTestId("sale-folio").innerText()) === `#${s.id}`, "real folio");
    expect((await dlg.getByTestId("sale-total").innerText()) === `$${num(s.total).toFixed(2)}`, "total from the database");
    await dlg.getByText("Efectivo").waitFor();
    await dlg.getByText(new Date(s.created_at).toLocaleString()).waitFor();
    await dlg.getByText("✓ Venta registrada").waitFor();
    await page.mouse.click(5, 5); // outside
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    expect(await dlg.getByText("Venta Completada").isVisible(), "still open after clicking outside and Escape");
    for (const name of ["Ver recibo", "Imprimir", "Nueva venta"]) expect(await dlg.getByRole("button", { name }).count() === 1, "button " + name);
    expect(await dlg.getByRole("button", { name: "Close" }).count() === 0, "no hidden X: closing is explicit");
    await dlg.getByRole("button", { name: "Nueva venta" }).click();
    await dlg.waitFor({ state: "hidden" });
    await page.getByText("Carrito (0 artículos)").waitFor();
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === "pos-search", null, { timeout: 2500 }).catch(() => {});
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id) === "pos-search", "focus returns to the search box for the next sale: active=" + (await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName))));
  });
  await test("CART-07.closed_sale_is_still_in_the_database_and_a_new_sale_works", "e2e", async () => {
    await add(B);
    const n0 = await salesCount();
    const d = await pay("card");
    await d.getByRole("button", { name: "Completar Venta" }).click();
    await page.getByRole("dialog").getByText("Venta Completada").waitFor({ timeout: 8000 });
    await page.getByRole("dialog").getByText("Tarjeta").waitFor();
    await page.getByRole("button", { name: "Nueva venta" }).click();
    expect((await salesCount()) === n0 + 1, "card sale persisted");
  });
  await test("CART-08.rejected_sales_keep_the_cart_and_resync_stock_and_price", "e2e", async () => {
    await add(C);
    await page.getByRole("button", { name: `Aumentar ${C.name}` }).click();
    await page.getByRole("button", { name: `Aumentar ${C.name}` }).click(); // 3 of 3
    const n0 = await salesCount();
    await db.query("update products set stock=1 where id=$1", [C.id]); // another terminal sold 2
    let d = await pay("cash");
    await d.getByRole("button", { name: "Completar Venta" }).click();
    await page.getByText(/Stock insuficiente/).first().waitFor({ timeout: 5000 });
    expect((await salesCount()) === n0, "no sale created");
    expect((await lines().count()) === 1 && num(await page.getByLabel(`Cantidad de ${C.name}`).inputValue()) === 1, "the cart is kept and the quantity is capped at the real stock");
    await db.query("update products set price='3.00', stock=5 where id=$1", [C.id]);
    d = await pay("cash");
    await d.getByRole("button", { name: "Completar Venta" }).click();
    await page.getByText(/cambió/).first().waitFor({ timeout: 5000 });
    expect((await salesCount()) === n0, "still no sale");
    expect((await lines().count()) === 1 && (await page.getByTestId("cart-total").innerText()) === "$3.00", "the cart is kept with the new price");
    d = await pay("cash");
    await d.getByRole("button", { name: "Completar Venta" }).click(); // now it goes through with the refreshed cart
    await page.getByRole("dialog").getByText("Venta Completada").waitFor({ timeout: 8000 });
    expect((await salesCount()) === n0 + 1, "the corrected cart is sold");
    await page.getByRole("button", { name: "Nueva venta" }).click();
  });

  // ================================================================== idempotency of sales:create
  const payload = (op, extra = {}) => ({ items: [{ productId: B.id, quantity: 1, unitPrice: 4.5, subtotal: 4.5 }], total: 4.5, paymentMethod: "cash", ...extra, operationId: op });
  await test("CART-09.same_operation_id_returns_the_same_sale_never_a_second_one", "integration", async () => {
    const sess = await one("select id from cash_sessions where closed_at is null");
    const op = "op-" + runId + "-aaaa1111";
    const stock0 = (await one("select stock from products where id=$1", [B.id])).stock;
    const n0 = await salesCount();
    const r1 = await ipc(page, `api.sales.create(${J(payload(op, { sessionId: sess.id }))})`);
    const r2 = await ipc(page, `api.sales.create(${J(payload(op, { sessionId: sess.id }))})`);
    expect(r1.ok && r2.ok && r1.v.id === r2.v.id, "same sale returned: " + J([r1, r2]));
    expect(r1.v.replayed === false && r2.v.replayed === true, "second answer is flagged as a replay");
    expect((await salesCount()) === n0 + 1, "only one sale row");
    expect((await one("select stock from products where id=$1", [B.id])).stock === stock0 - 1, "stock decreased once");
    expect((await one("select count(*)::int n from cash_movements where reason like $1", [`Venta #${r1.v.id} %`])).n === 1, "one cash movement");
    const other = await ipc(page, `api.sales.create(${J(payload(op, { sessionId: sess.id, paymentMethod: "card" }))})`);
    expect(other.ok === false && /\[OPERACION_DUPLICADA\]/.test(other.err), "same id with different content is refused: " + J(other));
  });
  await test("CART-10.concurrent_identical_requests_create_one_sale", "integration", async () => {
    const sess = await one("select id from cash_sessions where closed_at is null");
    const op = "op-" + runId + "-bbbb2222";
    const n0 = await salesCount();
    const rs = await ipc(page, `Promise.all(Array.from({length: 6}, () => api.sales.create(${J(payload(op, { sessionId: sess.id }))}).then(r => ({ok:true,id:r.id}), e => ({ok:false,err:String(e.message)}))))`);
    expect(rs.ok, "call");
    const ok = rs.v.filter((x) => x.ok);
    expect(ok.length >= 1 && new Set(ok.map((x) => x.id)).size === 1, "every successful answer is the same sale: " + J(rs.v));
    expect(rs.v.every((x) => x.ok), "none failed: " + J(rs.v));
    expect((await salesCount()) === n0 + 1, "exactly one sale was created: " + ((await salesCount()) - n0));
  });
  await test("CART-11.invalid_operation_ids_are_rejected_and_no_id_still_works", "integration", async () => {
    const sess = await one("select id from cash_sessions where closed_at is null");
    const n0 = await salesCount();
    for (const bad of ["x", "has spaces in the id", "a".repeat(80), "'; drop table sales;--"]) {
      const r = await ipc(page, `api.sales.create(${J(payload(bad, { sessionId: sess.id }))})`);
      expect(r.ok === false && /\[OPERACION_INVALIDA\]/.test(r.err), "rejected " + bad.slice(0, 12) + ": " + J(r));
    }
    expect((await salesCount()) === n0, "nothing was created");
    const legacy = await ipc(page, `api.sales.create(${J({ ...payload("op-" + runId + "-cccc3333"), sessionId: sess.id, operationId: undefined })})`);
    expect(legacy.ok && legacy.v.id, "a client that sends no operation id still sells: " + J(legacy));
  });

  // ================================================================== A6 search and scanner
  await test("CART-12.search_with_mouse_keyboard_and_a_simulated_hid_scanner", "e2e", async () => {
    await emptyCart();
    // keyboard: type, ArrowDown, Enter
    await search.fill(B.sku.slice(-4));
    await page.getByRole("option", { name: new RegExp(B.name) }).first().waitFor();
    await search.press("ArrowDown");
    await search.press("Enter");
    await page.getByLabel(`Cantidad de ${B.name}`).waitFor();
    expect(await page.evaluate(() => document.activeElement && document.activeElement.id) === "pos-search", "focus stays in the search box");
    // scanner: the whole code arrives as fast keystrokes followed by Enter (keyboard wedge)
    await search.click();
    await page.keyboard.type(BARCODE, { delay: 2 });
    await page.keyboard.press("Enter");
    await page.getByLabel(`Cantidad de ${A.name}`).waitFor({ timeout: 4000 });
    expect((await lines().count()) === 2, "scanned product added next to the existing one");
    // scanning the same code again increments the quantity
    await page.keyboard.type(BARCODE, { delay: 2 });
    await page.keyboard.press("Enter");
    await page.waitForFunction((l) => document.querySelector(`input[aria-label="${l}"]`)?.value === "2", `Cantidad de ${A.name}`, { timeout: 4000 });
    expect((await search.inputValue()) === "", "the box is cleared for the next scan");
    // unknown code
    await page.keyboard.type("0000000000000", { delay: 2 });
    await page.keyboard.press("Enter");
    await page.getByText(/Producto no encontrado/).first().waitFor({ timeout: 4000 });
    expect((await lines().count()) === 2, "an unknown code adds nothing");
    await search.fill("");
    // several matches + Enter without choosing: nothing is added silently
    await search.fill(`E2E ${runId}`);
    await page.keyboard.press("Enter");
    await page.getByText(/varios productos/).first().waitFor({ timeout: 4000 });
    expect((await lines().count()) === 2, "an ambiguous term adds nothing");
    await search.fill("");
    // the list stays usable with the mouse: clicking an option does not lose it to the blur handler
    await search.fill(C.sku);
    await page.getByRole("option", { name: new RegExp(C.name) }).first().click();
    await page.getByLabel(`Cantidad de ${C.name}`).waitFor({ timeout: 4000 });
    await emptyCart();
  });
  await test("CART-13.cash_session_closes_cleanly_after_all_sales", "e2e", async () => {
    await ui.nav(page, "Caja");
    const expected = await ui.closeCash(page);
    const s = await one("select status, final_amount from cash_sessions order by id desc limit 1");
    expect(s.status === "closed" && num(s.final_amount) === num(expected), "closed with the expected amount: " + J(s));
  });
}
