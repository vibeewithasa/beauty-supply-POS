// Cart suite (visual + checkout idempotency): the sales screen as an operator uses it. Every effect is verified in
// PostgreSQL. Barcode scanners are simulated as a keyboard wedge (fast typing + Enter); no physical scanner was used.
import { APP_URL, ui, ipc, expect, closeStrayCash } from "../lib/harness.mjs";

export async function run(c) {
  const { page, app, db, data, test, runId } = c;
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
  // ====================================================================== the cart survives leaving the screen (0.8.1)
  // The cart lives above the routes (lib/cart-context). It is memory only and belongs to ONE login session.
  const vendor = await data.user("CART_VEND", "vendor");
  const NA = await data.product("NA", "10.00", 60);
  const NB = await data.product("NB", "4.50", 60);
  const NC = await data.product("NC", "2.25", 60);
  const cartSnapshot = () => page.evaluate(() => ({
    lines: [...document.querySelectorAll('[data-testid="cart-line"]')].map((l) => ({
      name: l.querySelector("p.font-semibold").textContent.trim(),
      qty: l.querySelector('input[type="number"]').value,
      sub: l.querySelector("p.text-right").textContent.trim(),
    })),
    total: (document.querySelector('[data-testid="cart-total"]') || {}).textContent || null,
  }));
  const badge = async () => ((await page.getByTestId("nav-cart-count").count()) ? (await page.getByTestId("nav-cart-count").innerText()).trim() : null);
  const loginAs = async (u) => {
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, u.pin);
    await page.waitForURL(/#\/(dashboard|sales)$/, { timeout: 8000 });
  };
  const logout = async () => {
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
  };
  const toSales = async () => { await ui.nav(page, "Vender"); await page.getByText(/Carrito \(\d+ art/).waitFor(); };
  const SALE_ROWS = "select count(*)::int n from sales";
  const keepOriginalSalesCreate = () => app.evaluate(({ ipcMain }) => { globalThis.__origSalesCreate ??= ipcMain._invokeHandlers.get("sales:create"); });
  const wrapSalesCreate = (mode) => app.evaluate(({ ipcMain }, m) => {
    const real = globalThis.__origSalesCreate;
    ipcMain._invokeHandlers.set("sales:create", async (e, ...a) => {
      if (m === "slow") await new Promise((r) => setTimeout(r, 2500));
      const r = await real(e, ...a); // the sale IS committed in PostgreSQL ...
      if (m === "lost") throw new Error("simulated: the response was lost"); // ... but the screen never hears about it
      return r;
    });
  }, mode);
  const restoreSalesCreate = () => app.evaluate(({ ipcMain }) => { if (globalThis.__origSalesCreate) ipcMain._invokeHandlers.set("sales:create", globalThis.__origSalesCreate); });

  /** One full pass of the owner's checklist for `u`; ends logged in as `next` with an empty cart. */
  async function scenario(u, next) {
    await toSales();
    await emptyCart();
    await add(NA); await add(NB); await add(NC);
    await ui.setCartQuantity(page, 3);
    await page.getByRole("button", { name: `Aumentar ${NB.name}` }).click();
    await page.getByRole("button", { name: `Aumentar ${NB.name}` }).click(); // NB x3
    await page.getByRole("button", { name: `Aumentar ${NC.name}` }).click(); // NC x2
    const before = await cartSnapshot();
    expect(before.lines.length === 3 && before.total === "$48.00" && before.lines.map((l) => l.qty).join() === "3,3,2", "cart built: " + J(before));
    const n0 = (await one(SALE_ROWS)).n;
    await ui.nav(page, "Caja");
    await page.getByText("Abierta", { exact: true }).waitFor();
    expect((await badge()) === "3", "the navigation shows the cart on Caja: " + (await badge()));
    await toSales();
    expect(J(await cartSnapshot()) === J(before), "identical after Caja: " + J(await cartSnapshot()));
    await ui.nav(page, "Historial");
    await page.locator("#hs-method").waitFor();
    await ui.nav(page, "Devoluciones");
    await page.locator("#rt-sale").waitFor();
    await toSales();
    expect(J(await cartSnapshot()) === J(before), "identical after Historial and Devoluciones");
    expect((await one(SALE_ROWS)).n === n0, "navigating registered no sale");
    // the cart can still be edited after coming back
    await page.getByRole("button", { name: `Disminuir ${NC.name}` }).click();
    expect((await cartSnapshot()).lines[2].qty === "1", "editable after coming back");
    await page.getByRole("button", { name: `Aumentar ${NC.name}` }).click();
    // complete a sale: the cart is cleared exactly once
    const d = await pay("cash");
    await d.getByRole("button", { name: "Completar Venta" }).click();
    await page.getByRole("dialog").getByText("Venta Completada").waitFor({ timeout: 8000 });
    await page.getByRole("dialog").getByRole("button", { name: "Nueva venta" }).click();
    await page.getByText("Carrito (0 artículos)").waitFor();
    expect((await one(SALE_ROWS)).n === n0 + 1, "exactly one sale for the cart");
    const sold = await one("select total from sales order by id desc limit 1");
    expect(num(sold.total) === 48, "the sale total is the cart total: " + sold.total);
    await ui.nav(page, "Caja");
    await page.getByText("Abierta", { exact: true }).waitFor();
    await toSales();
    expect((await cartSnapshot()).lines.length === 0 && (await badge()) === null, "still empty after the sale and a round trip");
    // another cart, then logout: the next session starts empty, the same user included
    await add(NA);
    await ui.nav(page, "Caja");
    await logout();
    await loginAs(u);
    await toSales();
    expect((await cartSnapshot()).lines.length === 0 && (await badge()) === null, "the same user logging in again gets an empty cart");
    await add(NB);
    await logout();
    await loginAs(next);
    await toSales();
    expect((await cartSnapshot()).lines.length === 0 && (await badge()) === null, "another user never sees the previous cart");
  }
  await test("CART-14.vendor_cart_survives_caja_and_historial_sale_clears_it_logout_and_user_change_isolate_it", "e2e", async () => {
    await keepOriginalSalesCreate();
    await logout();
    await loginAs(vendor);
    await scenario(vendor, admin);
  });
  await test("CART-15.administrator_cart_survives_caja_and_historial_sale_clears_it_logout_and_user_change_isolate_it", "e2e", async () => {
    await scenario(admin, vendor);
    await logout();
    await loginAs(admin);
    await toSales();
  });
  await test("CART-16.an_expired_session_drops_the_cart", "e2e", async () => {
    await add(NA);
    await ui.nav(page, "Caja");
    await page.evaluate(() => window.dispatchEvent(new Event("pos:session-expired")));
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await loginAs(admin);
    await toSales();
    expect((await cartSnapshot()).lines.length === 0, "an expired session leaves no cart behind");
  });

  // ---------------------------------------------------------------- catalog changed while the cart was away
  await test("CART-17.changed_price_stock_or_availability_is_explained_never_applied_silently_and_blocks_payment", "e2e", async () => {
    const n0 = (await one(SALE_ROWS)).n;
    await add(NA); await add(NB); await add(NC);
    await page.getByRole("button", { name: `Aumentar ${NB.name}` }).click();
    await page.getByRole("button", { name: `Aumentar ${NB.name}` }).click(); // NB x3
    const before = await cartSnapshot(); // 10.00 + 13.50 + 2.25
    expect(before.total === "$25.75", "start: " + before.total);
    await ui.nav(page, "Caja");
    await page.getByText("Abierta", { exact: true }).waitFor();
    await db.query("update products set price='12.00' where id=$1", [NA.id]);
    await db.query("update products set stock=2 where id=$1", [NB.id]);
    await db.query("update products set status='inactive' where id=$1", [NC.id]);
    await toSales();
    const box = page.getByTestId("cart-issues");
    await box.waitFor();
    const text = await box.innerText();
    expect(/precio cambió de \$10\.00 a \$12\.00/.test(text), "price change explained: " + text);
    expect(/hay 2 unidades disponibles y el carrito tiene 3/.test(text), "stock explained: " + text);
    expect(/ya no está disponible/.test(text), "unavailable explained: " + text);
    const same = await cartSnapshot();
    expect(J(same) === J(before), "nothing was changed silently: " + J(same));
    expect(await page.getByRole("button", { name: "Pagar" }).isDisabled(), "payment is blocked while the cart is stale");
    await page.getByRole("button", { name: "Actualizar carrito" }).click();
    await box.waitFor({ state: "hidden" });
    const after = await cartSnapshot();
    expect(after.lines.length === 2 && after.total === "$21.00" && after.lines.map((l) => l.qty).join() === "1,2", "accepted: " + J(after));
    expect(await page.getByRole("button", { name: "Pagar" }).isEnabled(), "payment possible again");
    expect((await one(SALE_ROWS)).n === n0, "no sale registered by any of this");
    await db.query("update products set price='10.00' where id=$1", [NA.id]);
    await db.query("update products set stock=60 where id=$1", [NB.id]);
    await db.query("update products set status='active' where id=$1", [NC.id]);
    await emptyCart();
  });

  // ---------------------------------------------------------------- failed and uncertain payments, and navigation
  await test("CART-18.a_rejected_payment_keeps_the_cart_and_it_still_survives_navigation", "e2e", async () => {
    await add(NA); await page.getByRole("button", { name: `Aumentar ${NA.name}` }).click(); // x2
    const n0 = (await one(SALE_ROWS)).n;
    await db.query("update products set stock=1 where id=$1", [NA.id]); // changed AFTER the screen read the catalog
    const d = await pay("cash");
    await d.getByRole("button", { name: "Completar Venta" }).click();
    await page.getByText(/Stock insuficiente/i).first().waitFor({ timeout: 6000 });
    expect((await one(SALE_ROWS)).n === n0, "no sale for a rejected payment");
    const kept = await cartSnapshot();
    expect(kept.lines.length === 1, "the cart was kept for correction: " + J(kept));
    await ui.nav(page, "Caja");
    await toSales();
    expect(J(await cartSnapshot()) === J(kept), "and survives navigation");
    await db.query("update products set stock=60 where id=$1", [NA.id]);
    await emptyCart();
  });
  await test("CART-19.an_uncertain_payment_cannot_be_duplicated_by_navigating_and_retrying", "e2e", async () => {
    await add(NB); await add(NC);
    const total = (await cartSnapshot()).total;
    const n0 = (await one(SALE_ROWS)).n;
    await wrapSalesCreate("lost");
    try {
      const d = await pay("cash");
      await d.getByRole("button", { name: "Completar Venta" }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden", timeout: 6000 });
      expect((await one(SALE_ROWS)).n === n0 + 1, "the sale was committed while the answer got lost");
      expect((await cartSnapshot()).lines.length === 2, "the screen could not know: the cart is still there");
      await ui.nav(page, "Caja");
      await toSales();
      expect((await cartSnapshot()).lines.length === 2 && (await cartSnapshot()).total === total, "still there after navigating");
    } finally {
      await restoreSalesCreate();
    }
    const first = (await one("select id from sales order by id desc limit 1")).id;
    const d2 = await pay("cash");
    await d2.getByRole("button", { name: "Completar Venta" }).click();
    await page.getByRole("dialog").getByText("Venta Completada").waitFor({ timeout: 8000 });
    expect((await page.getByTestId("sale-folio").innerText()) === `#${first}`, "the retry returned the SAME sale: " + (await page.getByTestId("sale-folio").innerText()) + " vs #" + first);
    expect((await one(SALE_ROWS)).n === n0 + 1, "still exactly one sale: " + ((await one(SALE_ROWS)).n - n0));
    await page.getByRole("dialog").getByRole("button", { name: "Nueva venta" }).click();
    await page.getByText("Carrito (0 artículos)").waitFor();
  });
  await test("CART-20.leaving_while_the_payment_runs_cannot_duplicate_it_and_the_result_is_not_lost", "e2e", async () => {
    await add(NA);
    const n0 = (await one(SALE_ROWS)).n;
    await wrapSalesCreate("slow");
    try {
      const d = await pay("cash");
      await d.getByRole("button", { name: "Completar Venta" }).click();
      await page.waitForTimeout(300);
      await page.evaluate(() => { location.hash = "#/cash"; }); // leaves while the request is in flight (a keyboard/back-button route)
      await page.getByText("Abierta", { exact: true }).waitFor();
      await page.evaluate(() => { location.hash = "#/sales"; });
      await page.getByText(/Carrito \(1 art/).waitFor();
      expect(await page.getByRole("button", { name: "Pagar" }).isDisabled(), "Pagar is blocked while the earlier payment is running");
      await page.getByRole("status").filter({ hasText: "cobro en proceso" }).waitFor();
      await page.getByRole("dialog").getByText("Venta Completada").waitFor({ timeout: 8000 }); // the result is shown on return
      expect((await one(SALE_ROWS)).n === n0 + 1, "exactly one sale: " + ((await one(SALE_ROWS)).n - n0));
    } finally {
      await restoreSalesCreate();
    }
    await page.getByRole("dialog").getByRole("button", { name: "Nueva venta" }).click();
    await page.getByText("Carrito (0 artículos)").waitFor();
    expect((await page.getByTestId("cart-line").count()) === 0, "the cart was cleared by the sale");
  });
  await test("CART-13.cash_session_closes_cleanly_after_all_sales", "e2e", async () => {
    await ui.nav(page, "Caja");
    const expected = await ui.closeCash(page);
    const s = await one("select status, final_amount from cash_sessions order by id desc limit 1");
    expect(s.status === "closed" && num(s.final_amount) === num(expected), "closed with the expected amount: " + J(s));
  });
}
