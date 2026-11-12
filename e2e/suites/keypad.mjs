// Keypad suite (Sprint 08A): the floating numeric keypad of the sales screen, driven through the real window.
// Every effect on money is verified in PostgreSQL. Touch is simulated (CDP touch events); no touch screen or barcode reader was used:
// the reader is simulated as a keyboard wedge (fast typing + Enter), like in the cart suite.
import path from "node:path";
import { APP_URL, ui, expect, closeStrayCash, money } from "../lib/harness.mjs";

const KEY = "pos.numpad.v1";
const VIEWPORTS = [[1024, 768], [1366, 768], [1920, 1080]];
const J = JSON.stringify;

export async function run(c) {
  const { page, app, db, data, test, artifacts, runId } = c;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const admin = await data.user("KP_ADMIN", "admin");
  const vendor = await data.user("KP_VEND", "vendor");
  const A = await data.product("KA", "12.50", 500);
  const B = await data.product("KB", "3.25", 500);
  const BARCODE = "7508" + runId.replace(/\D/g, "").padEnd(8, "3").slice(0, 8) + "9";
  await db.query("update products set barcode=$1 where id=$2", [BARCODE, B.id]);
  await closeStrayCash(db, admin.id);
  const salesNow = async () => (await one("select count(*)::int n from sales")).n;
  const salesAtStart = await salesNow();
  const total20Before = (await one("select count(*)::int n from sales where total::numeric = 20")).n;

  const search = page.getByPlaceholder("Código, SKU o nombre...");
  const root = () => page.locator("[data-numpad-root]");
  const pad = () => page.getByTestId("numpad");
  const chip = () => page.getByTestId("numpad-chip");
  const status = () => page.getByTestId("numpad-status");
  const key = (k) => page.locator(`[data-numpad-root] [data-key="${k}"]`);
  const press = async (...keys) => { for (const k of keys) await key(k).click(); };
  const qty = (p) => page.getByLabel(`Cantidad de ${p.name}`);
  const active = () => page.evaluate(() => ({ id: document.activeElement?.id || "", label: document.activeElement?.getAttribute("aria-label") || "", tag: document.activeElement?.tagName }));
  const stored = () => page.evaluate((k) => localStorage.getItem(k), KEY);
  const box = async () => (await root().boundingBox());
  const shot = (name) => page.screenshot({ path: path.join(artifacts, `keypad-${name}.png`) }).catch(() => {});
  const lines = () => page.getByTestId("cart-line");
  const inside = (b, w, h) => b && b.x >= 0 && b.y >= 0 && b.x + b.width <= w + 0.5 && b.y + b.height <= h + 0.5;
  const resize = async (w, h) => {
    await app.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows()[0].setContentSize(s[0], s[1]); }, [w, h]);
    await page.waitForFunction((s) => Math.abs(window.innerWidth - s[0]) <= 2 && Math.abs(window.innerHeight - s[1]) <= 2, [w, h], { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(200);
  };
  const drag = async (loc, dx, dy) => {
    const b = await loc.boundingBox();
    const x = b.x + b.width / 2, y = b.y + b.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 });
    await page.mouse.move(x + dx, y + dy, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(100);
  };
  // the open keypad can sit over the search results (it is movable and minimizable): the operator minimizes it to search
  const ensureMin = async () => { if ((await pad().count()) > 0) { await page.getByTestId("numpad-minimize").click(); await chip().waitFor(); } };
  const ensureOpen = async () => { if ((await pad().count()) === 0) { await chip().click(); await pad().waitFor(); } };
  const addProduct = async (p) => {
    await ensureMin();
    await search.fill(p.sku);
    await page.getByRole("option", { name: new RegExp(p.name) }).first().click();
    await lines().first().waitFor();
  };
  const emptyCart = async () => {
    if ((await lines().count()) === 0) return;
    await ensureMin(); // a keypad left over a confirmation dialog can cover its button: the operator moves or minimizes it
    await page.getByRole("button", { name: "Limpiar", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Limpiar carrito" }).click();
    await page.getByText("Carrito vacío").waitFor();
  };
  const setEnabled = async (on) => {
    await ui.nav(page, "Configuración");
    const sw = page.getByRole("switch", { name: /Teclado numérico en Vender/ });
    await sw.waitFor();
    if ((await sw.isChecked()) !== on) await sw.click();
    expect((await sw.isChecked()) === on, "switch state");
  };

  // ================================================================== default off, enable from Configuración, persistence
  await test("KEY-00.login_and_open_cash", "e2e", async () => {
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    await ui.openCash(page, 100);
  });

  await test("KEY-01.keypad_is_off_by_default_everywhere_and_nothing_is_stored", "e2e", async () => {
    await ui.nav(page, "Vender");
    await page.getByText("Carrito (0 artículos)").waitFor();
    expect((await root().count()) === 0, "no keypad on Vender by default");
    expect((await stored()) === null, "nothing stored: " + (await stored()));
    await ui.nav(page, "Configuración");
    const sw = page.getByRole("switch", { name: /Teclado numérico en Vender/ });
    await sw.waitFor();
    expect(!(await sw.isChecked()), "the switch is off");
    expect((await page.getByTestId("device-settings").innerText()).includes("Este equipo"), "section is labelled as per-device");
  });

  await test("KEY-02.enabling_in_configuracion_is_immediate_persistent_and_touches_no_business_data", "e2e", async () => {
    const before = await one("select count(*)::int n, max(updated_at) u from business_settings");
    await setEnabled(true);
    expect(J(JSON.parse(await stored())).includes('"enabled":true'), "stored: " + (await stored()));
    await page.reload();
    await page.getByRole("switch", { name: /Teclado numérico en Vender/ }).waitFor();
    expect(await page.getByRole("switch", { name: /Teclado numérico en Vender/ }).isChecked(), "still on after a reload");
    const after = await one("select count(*)::int n, max(updated_at) u from business_settings");
    expect(before.n === after.n && String(before.u) === String(after.u), "business_settings untouched: " + J([before, after]));
    await ui.nav(page, "Vender");
    await chip().waitFor();
    expect((await pad().count()) === 0, "it starts minimized as the «123» button, covering nothing");
    expect(JSON.parse(await stored()).minimized === true, "stored minimized");
    await ensureOpen();
    expect((await root().getAttribute("aria-label")) === "Teclado numérico" && (await root().getAttribute("role")) === "group", "named group for assistive technology");
    await shot("01-enabled-default-position");
  });

  // ================================================================== typing: integers, replace-on-focus, no focus theft
  await test("KEY-03.integer_field_takes_digits_keeps_the_focus_and_refuses_the_decimal_point", "e2e", async () => {
    await page.getByText("Carrito (0 artículos)").waitFor();
    expect((await status().innerText()).includes("Toca un campo numérico"), "idle hint");
    expect(await key("5").isDisabled(), "keys are off while no numeric field is focused");
    await addProduct(A);
    await page.waitForFunction(() => document.activeElement?.id === "pos-search"); // the screen hands the focus back to the search box
    await ensureOpen();
    expect(await key("5").isDisabled(), "still off with the search box focused (the reader types there)");
    await qty(A).click();
    expect(!(await key("5").isDisabled()) && (await key(".").isDisabled()), "digits on, decimal point off for a whole-number field");
    expect((await status().innerText()).includes(`Cantidad de ${A.name}`), "names the field: " + (await status().innerText()));
    await press("7");
    expect((await qty(A).inputValue()) === "7", "typed over the 1: " + (await qty(A).inputValue()));
    await press("2");
    expect((await qty(A).inputValue()) === "72", "appended after the first key");
    expect((await active()).label === `Cantidad de ${A.name}`, "the focus never left the field: " + J(await active()));
    expect((await page.getByTestId("cart-total").innerText()) === "$900.00", "the cart reacted like to typed input: " + (await page.getByTestId("cart-total").innerText()));
    await press("backspace");
    expect((await qty(A).inputValue()) === "7", "backspace");
    await press("clear");
    await press("9");
    expect((await qty(A).inputValue()) === "9", "an emptied quantity is typed over, not appended: " + (await qty(A).inputValue()));
    expect((await salesNow()) === salesAtStart, "typing is not a sale");
  });

  await test("KEY-04.the_existing_validation_still_decides_stock_limit", "e2e", async () => {
    await qty(A).click();
    await press("9", "9", "9");
    expect((await qty(A).inputValue()) === "99", "the third digit would exceed the stock of 500 and is refused by the screen: " + (await qty(A).inputValue()));
    await press("clear", "1");
    expect((await qty(A).inputValue()) === "1", "back to 1");
    await shot("02-integer-field");
  });

  // ================================================================== reader, physical keyboard, other fields
  await test("KEY-05.barcode_reader_and_physical_keyboard_are_unaffected", "e2e", async () => {
    await search.click();
    expect((await status().innerText()).includes("Toca un campo numérico") && await key("5").isDisabled(), "focus in the search box detaches the keypad");
    await page.keyboard.type(BARCODE, { delay: 5 }); // keyboard-wedge reader: fast typing, then Enter
    await page.keyboard.press("Enter");
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="cart-line"]').length === n, 2, { timeout: 4000 });
    expect((await search.inputValue()) === "" && (await lines().count()) === 2, "the scanned product was added: lines " + (await lines().count()));
    await page.waitForFunction(() => document.activeElement?.id === "pos-search");
    // the physical keyboard in an eligible field
    await qty(B).click();
    await page.keyboard.press("Control+A");
    await page.keyboard.type("4");
    expect((await qty(B).inputValue()) === "4", "physical typing: " + (await qty(B).inputValue()));
    // a key press while the focus is in the search box must not reach the quantity field
    await search.click();
    expect(await key("5").isDisabled() && (await qty(B).inputValue()) === "4", "after the focus left the field the keys are off and the field is not written to");
  });

  // ================================================================== dialogs: payment (Radix modal)
  await test("KEY-06.decimal_field_inside_the_payment_dialog_works_and_the_dialog_stays_open", "e2e", async () => {
    await page.getByRole("button", { name: "Pagar" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByText("Método de Pago").waitFor();
    await page.waitForTimeout(400);
    const received = page.locator("#cash-received");
    await received.click();
    expect(!(await key(".").isDisabled()), "the decimal point is allowed in the cash-received field");
    // the keypad is above the overlay and reachable although Radix makes the rest of the page inert
    const reachable = await key("1").evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!top && el.contains(top); });
    expect(reachable, "keys are not covered by the dialog or its overlay");
    await press("5", "0", ".", "5", "9", "9");
    expect((await received.inputValue()) === "50.59", "two-decimal limit (the third decimal is refused): " + (await received.inputValue()));
    await press(".");
    expect((await received.inputValue()) === "50.59", "a second point is refused");
    expect((await dlg.count()) === 1 && (await dlg.getByText("Método de Pago").isVisible()), "the dialog did not close");
    expect((await active()).id === "cash-received", "the focus stayed in the field: " + J(await active()));
    await page.getByTestId("change-due").waitFor();
    const text = await page.getByTestId("change-due").innerText();
    expect(/Cambio a entregar: \$\d+\.\d{2}/.test(text), "change computed from the typed amount: " + text);
    await shot("03-payment-dialog-open");
    await press("clear", "1", "0");
    expect(/Faltan \$/.test(await page.getByTestId("change-due").innerText()), "a short amount is reported, as typed by hand");
    await page.keyboard.press("Escape");
    await dlg.waitFor({ state: "hidden" });
    expect((await status().innerText()).includes("Toca un campo numérico"), "closing the dialog detaches the keypad");
  });

  await test("KEY-07.a_full_cash_sale_with_the_keypad_changes_money_and_stock_exactly_as_before", "e2e", async () => {
    const s0 = { n: await salesNow() };
    const stockA = (await one("select stock from products where id=$1", [A.id])).stock;
    await qty(B).click();
    await press("2"); // B: 2 x 3.25 = 6.50 ; A: 1 x 12.50
    expect((await page.getByTestId("cart-total").innerText()) === "$19.00", "total " + (await page.getByTestId("cart-total").innerText()));
    await page.getByRole("button", { name: "Pagar" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("tab", { name: "Efectivo" }).click();
    await page.locator("#cash-received").click();
    await press("2", "0");
    await dlg.getByRole("button", { name: "Completar Venta" }).click();
    await page.getByRole("dialog").getByText("Venta Completada").waitFor({ timeout: 8000 });
    const sale = await one("select * from sales order by id desc limit 1");
    expect(c.runDb && (await one("select count(*)::int n from sales")).n === s0.n + 1, "exactly one sale");
    expect(money(sale.total) === 19 && sale.payment_method === "cash", "sale " + J(sale));
    const items = (await db.query("select product_id, quantity, subtotal from sale_items where sale_id=$1 order by product_id", [sale.id])).rows;
    expect(items.length === 2 && items.find((i) => i.product_id === B.id).quantity === 2, "items " + J(items));
    expect((await one("select stock from products where id=$1", [A.id])).stock === stockA - 1, "stock moved as always");
    const mv = await one("select amount, reason from cash_movements where sale_id=$1", [sale.id]);
    expect(money(mv.amount) === 19, "the cash movement is the sale total, not the keypad amount: " + J(mv));
    expect(Number((await one("select count(*)::int n from sales where total::numeric = 20")).n) === total20Before, "the 'received' amount is not stored anywhere");
    await page.getByRole("button", { name: "Nueva Venta" }).click();
  });

  // ================================================================== drag, minimize, restore, persistence, bounds
  await test("KEY-08.drag_minimize_restore_and_the_position_survives_a_reload", "e2e", async () => {
    await resize(1024, 768);
    const b0 = await box();
    expect(inside(b0, 1024, 768), "opens fully inside the window: " + J(b0));
    expect(b0.x < 1024 / 2 - 232 / 2, "it opens on the left, clear of the cart and the Pay button: " + J(b0));
    await drag(page.getByTestId("numpad-handle"), 300, -150);
    const b1 = await box();
    expect(Math.abs(b1.x - (b0.x + 300)) <= 2 && Math.abs(b1.y - (b0.y - 150)) <= 2, `moved by the drag: ${J(b0)} -> ${J(b1)}`);
    const saved = JSON.parse(await stored());
    expect(saved.x === Math.round(b1.x) && saved.y === Math.round(b1.y) && saved.minimized === false, "position persisted: " + J(saved));
    await shot("04-dragged");
    await page.getByTestId("numpad-minimize").click();
    await chip().waitFor();
    expect((await pad().count()) === 0 && (await chip().isVisible()), "minimized to the chip");
    expect(JSON.parse(await stored()).minimized === true, "minimized state persisted");
    await shot("05-minimized");
    await page.reload();
    await chip().waitFor();
    const cb = await box();
    expect(Math.abs(cb.x - Math.round(b1.x)) <= 2 && Math.abs(cb.y - Math.round(b1.y)) <= 2, "the chip sits where the keypad was after a reload: " + J(cb));
    await drag(chip(), 120, 90); // dragging the chip must not restore it
    expect((await chip().isVisible()) && (await pad().count()) === 0, "a drag on the chip does not open the keypad");
    await chip().click();
    await pad().waitFor();
    expect(JSON.parse(await stored()).minimized === false, "restored from the chip");
  });

  await test("KEY-09.it_can_never_end_up_outside_the_window_at_any_resolution", "e2e", async () => {
    for (const [w, h] of VIEWPORTS) {
      await resize(w, h);
      await page.getByTestId("numpad").waitFor();
      let b = await box();
      expect(inside(b, w, h), `${w}x${h} default/last position inside: ${J(b)}`);
      await drag(page.getByTestId("numpad-handle"), 5000, 5000);
      b = await box();
      expect(inside(b, w, h) && b.x + b.width >= w - 12 && b.y + b.height >= h - 12, `${w}x${h} dragged past the bottom-right corner is held at the edge: ${J(b)}`);
      await drag(page.getByTestId("numpad-handle"), -5000, -5000);
      b = await box();
      expect(inside(b, w, h) && b.x <= 12 && b.y <= 12, `${w}x${h} dragged past the top-left corner is held at the edge: ${J(b)}`);
      await drag(page.getByTestId("numpad-handle"), 5000, 5000);
      await shot(`06-${w}x${h}`);
    }
    // the window shrinks while the keypad sits at the far corner: it follows
    await resize(1920, 1080);
    await drag(page.getByTestId("numpad-handle"), 5000, 5000);
    await resize(1024, 768);
    expect(inside(await box(), 1024, 768), "re-clamped after the window shrank: " + J(await box()));
    // keys reachable at 1024x768 (every key fully visible)
    const keys = await page.locator("[data-numpad-root] button").evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom, r.width, r.height]; }));
    expect(keys.every((r) => r[0] >= 0 && r[1] >= 0 && r[2] <= 1024 && r[3] <= 768), "every key inside the window at 1024x768");
    expect(keys.every((r) => r[4] >= 44 && r[5] >= 44), "every control is at least 44x44 px: " + J(keys.filter((r) => r[4] < 44 || r[5] < 44)));
  });

  // ================================================================== touch (simulated) and pointer behaviour
  await test("KEY-10.touch_taps_and_touch_drag_work_without_moving_the_focus", "e2e", async () => {
    await resize(1024, 768);
    const cdp = await page.context().newCDPSession(page);
    const touch = async (x, y, dx = 0, dy = 0) => {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      if (dx || dy) for (let i = 1; i <= 6; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / 6, y: y + (dy * i) / 6 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(120);
    };
    const center = async (loc) => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
    await addProduct(A);
    await qty(A).click();
    await ensureOpen();
    await press("clear", "1");
    await touch(...(await center(key("4"))));
    expect((await qty(A).inputValue()) === "14", "touch tap on 4 typed it after the 1: " + (await qty(A).inputValue()));
    await touch(...(await center(key("6"))));
    expect((await qty(A).inputValue()) === "146", "second tap appended");
    expect((await active()).label === `Cantidad de ${A.name}`, "focus unchanged by touch: " + J(await active()));
    // minimize and restore by touch
    await touch(...(await center(page.getByTestId("numpad-minimize"))));
    await chip().waitFor({ timeout: 3000 });
    await touch(...(await center(chip())));
    await pad().waitFor({ timeout: 3000 });
    // drag by touch (the next tap after a synthetic drag is dropped by Chromium's gesture recognizer, so the drag goes last)
    const b0 = await box();
    await touch(...(await center(page.getByTestId("numpad-handle"))), -150, -100);
    const b1 = await box();
    expect(b1.x < b0.x - 100 && b1.y < b0.y - 60 && inside(b1, 1024, 768), `touch drag moved it: ${J(b0)} -> ${J(b1)}`);
    expect(Math.abs(JSON.parse(await stored()).x - Math.round(b1.x)) <= 1, "touch drag persisted: " + (await stored()));
    await cdp.detach().catch(() => {});
    await press("clear", "1");
    await emptyCart();
  });

  // ================================================================== never on login / PIN screens
  await test("KEY-11.no_keypad_on_other_screens_login_or_pin_dialogs", "e2e", async () => {
    for (const label of ["Caja", "Historial", "Devoluciones", "Configuración"]) {
      await ui.nav(page, label);
      await page.waitForTimeout(250);
      expect((await root().count()) === 0, `no keypad on ${label}`);
    }
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    expect((await root().count()) === 0, "none on the login screen while the preference is on");
  });

  // ================================================================== sessions: vendor sees what the device is configured with
  await test("KEY-12.a_vendor_session_uses_the_device_setting_and_cannot_change_it", "e2e", async () => {
    await ui.login(page, vendor.pin);
    await page.waitForURL(/#\/sales$/, { timeout: 8000 }).catch(() => {});
    await page.getByText("Carrito (0 artículos)").waitFor();
    await root().waitFor();
    await addProduct(A);
    await qty(A).click();
    await ensureOpen();
    await press("clear", "3");
    expect((await qty(A).inputValue()) === "3", "the vendor types with the keypad");
    await page.goto(APP_URL + "#/settings");
    await page.getByText("Punto de Venta").waitFor();
    expect((await page.getByRole("switch").count()) === 0, "a vendor is sent away from Configuración and cannot reach the preference");
    await emptyCart();
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
  });

  await test("KEY-13.turning_it_off_removes_it_for_every_session_and_a_corrupt_store_means_off", "e2e", async () => {
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    await setEnabled(false);
    await ui.nav(page, "Vender");
    await page.getByText("Carrito (0 artículos)").waitFor();
    expect((await root().count()) === 0, "gone from Vender");
    expect(J(JSON.parse(await stored())).includes('"enabled":false'), "stored off");
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, vendor.pin);
    await page.getByText("Carrito (0 artículos)").waitFor();
    expect((await root().count()) === 0, "off for a vendor session as well");
    // hostile or corrupt contents never turn it on
    for (const raw of ["not json", '{"enabled":"true"}', "[1]", '{"enabled":true,"x":1e99,"y":"a"}']) {
      await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, raw]);
      await page.reload();
      await page.getByText("Carrito (0 artículos)").waitFor();
      const on = (await root().count()) > 0;
      if (raw.includes('"enabled":true')) expect(on && inside(await box(), 1024, 768), "valid enable with absurd coordinates: shown inside the window: " + J(await box()));
      else expect(!on, "corrupt value " + raw + " leaves it off");
    }
    await page.evaluate((k) => localStorage.removeItem(k), KEY);
  });

  await test("KEY-14.reduced_motion_and_accessible_names", "e2e", async () => {
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [KEY, J({ enabled: true, minimized: false, x: null, y: null })]);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await pad().waitFor();
    const motion = await page.locator("[data-numpad-root], [data-numpad-root] *").evaluateAll((els) =>
      els.map((e) => getComputedStyle(e)).filter((s) => parseFloat(s.transitionDuration) > 0 || (s.animationName !== "none" && parseFloat(s.animationDuration) > 0)).length
    );
    expect(motion === 0, "the keypad uses no transition or animation: " + motion);
    const names = await page.locator("[data-numpad-root] button").evaluateAll((bs) => bs.map((b) => b.getAttribute("aria-label")));
    expect(names.length === 14 && names.every((n) => n && n.length > 1), "every control has a name: " + J(names));
    expect(await page.locator("[data-numpad-root] button").evaluateAll((bs) => bs.every((b) => b.tabIndex === -1)), "keys are not tab stops (the reader's Enter can never press one)");
    await page.emulateMedia({ reducedMotion: null });
  });

  await test("KEY-15.cleanup_leaves_the_preference_off", "e2e", async () => {
    await page.evaluate((k) => localStorage.removeItem(k), KEY);
    await page.reload();
    await page.getByText("Carrito (0 artículos)").waitFor();
    expect((await root().count()) === 0, "off");
  });
}
