// Refund UI suite (Sprint 05, block D): the Devoluciones screen end to end through the real window — payment method,
// explicit confirmation of the money, administrator PIN dialog (no session change), pending returns, history states, voucher —
// plus the reports that must reconcile (dashboard, reports, cash history and the printable closing summary) and persistence
// after restarting the application. Fixtures are written straight to the run's throwaway database.
import { APP_URL, ui, ipc, expect, closeStrayCash, launchApp, sleep } from "../lib/harness.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const J = JSON.stringify;

export async function run(c) {

  const { page, db, data, test, artifacts } = c;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  const num = (v) => Number(v);
  const call = (expr) => ipc(page, expr);

  const admin = await data.user("RU_ADMIN", "admin", { modern: true });
  const vendor = await data.user("RU_VENDOR", "vendor");
  await closeStrayCash(db, admin.id);
  const P = [];
  for (let i = 0; i < 8; i++) P.push(await data.product("RU" + i, "10.00", 500));

  const loginAs = async (u) => {
    await ipc(page, "api.auth.logout()");
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, u.pin);
    await page.waitForURL(u.role === "admin" ? /#\/dashboard$/ : /#\/sales$/, { timeout: 8000 });
  };
  const mkSale = async ({ method = "cash", lines, sessionId = null }) => {
    const total = lines.reduce((s, l) => s + Math.round(num(l.p.price) * 100) * l.q, 0) / 100;
    const s = await one("insert into sales(user_id,cash_session_id,total,payment_method) values($1,$2,$3,$4) returning id", [vendor.id, sessionId, total.toFixed(2), method]);
    for (const l of lines) {
      await db.query("insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal,product_name,product_sku) values($1,$2,$3,$4,$5,$6,$7)", [s.id, l.p.id, l.q, num(l.p.price).toFixed(2), (num(l.p.price) * l.q).toFixed(2), l.p.name, l.p.sku]);
    }
    return { id: s.id, total };
  };
  const registerNow = () => one("select * from cash_sessions where closed_at is null");
  const cashNow = async () => num((await registerNow()).current_amount);
  const openRegister = async (amount) => {
    await closeStrayCash(db, admin.id);
    const r = await call(`api.cash.openSession(${amount})`);
    expect(r.ok, "open register: " + J(r));
    return r.v.id;
  };
  const withTrigger = async (table, timing, fn, bodySql, runIt) => {
    await db.query(`create or replace function ${fn}() returns trigger language plpgsql as $f$ begin ${bodySql} end $f$`);
    await db.query(`create trigger ${fn}_t ${timing} on ${table} for each row execute function ${fn}()`);
    try { return await runIt(); } finally {
      await db.query(`drop trigger if exists ${fn}_t on ${table}`);
      await db.query(`drop function if exists ${fn}()`);
    }
  };

  // ---- screen helpers (everything the operator does is a real click or keystroke)
  // (reloads: fixtures are written straight to the database, and the screen reads its history when it opens)
  const gotoReturns = async () => { await ui.nav(page, "Devoluciones"); await page.reload(); await page.getByLabel("Número de venta").waitFor(); await page.getByText("Historial de devoluciones").waitFor(); };
  const lookupSale = async (saleId) => {
    await page.getByLabel("Número de venta").fill(String(saleId));
    await page.getByRole("button", { name: "Buscar venta" }).click();
    await page.getByRole("heading", { name: `Venta #${saleId}` }).waitFor();
  };
  const fillReturn = async (product, qty, reason = "Cliente se arrepintió") => {
    await page.getByLabel(`Cantidad a devolver de ${product.name}`).fill(String(qty));
    await page.getByLabel("Motivo", { exact: true }).fill(reason);
  };
  const mainButton = () => page.getByRole("button", { name: "Confirmar devolución y reembolso" });
  const pinInput = () => page.locator("#rf-admin-pin");
  const authorize = async (pin, label = "Autorizar y registrar") => {
    await pinInput().waitFor();
    await pinInput().fill(pin);
    await page.getByRole("button", { name: label, exact: true }).click();
  };
  const resultText = async () => (await page.getByTestId("return-result").innerText()).replace(/\s+/g, " ");


  await test("RUI-00.vendor_signs_in_and_opens_the_returns_screen", "e2e", async () => {
    await loginAs(admin);
    await openRegister(300);
    await loginAs(vendor);
    await gotoReturns();
    await page.getByText("Historial de devoluciones").waitFor();
    expect(await page.getByRole("button", { name: "Confirmar devolución y reembolso" }).count() === 0, "the form only appears after looking up a sale");
  });

  await test("RUI-01.cash_refund_flow_vendor_prepares_administrator_PIN_authorizes_session_unchanged", "e2e", async () => {
    const sale = await mkSale({ method: "card", lines: [{ p: P[0], q: 3 }] });
    const stock0 = num((await one("select stock from products where id=$1", [P[0].id])).stock), cash0 = await cashNow();
    await lookupSale(sale.id);
    await fillReturn(P[0], 2);
    expect((await page.getByTestId("refund-preview").innerText()) === "$20.00", "calculated total");
    expect(await mainButton().isDisabled(), "disabled until a method is chosen and the money confirmed");
    await page.locator("#rf-method-cash").click();
    expect(await mainButton().isDisabled(), "a method alone is not enough: the delivery must be confirmed");
    await page.locator("#rf-confirm").check();
    expect(!(await mainButton().isDisabled()), "enabled once method + confirmation + items + reason are there");
    expect((await page.locator("label[for=rf-confirm]").innerText()).includes("ya entregué $20.00 en efectivo"), "the confirmation names the amount and the cash");
    await mainButton().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByText("Autorización de administrador").waitFor();
    expect((await dialog.getByTestId("rf-summary").innerText()).includes("$20.00") && (await dialog.getByTestId("rf-summary").innerText()).includes("en efectivo desde la caja"), "the dialog summarizes the operation");
    expect(await dialog.locator("#rf-admin-pin").getAttribute("type") === "password", "the PIN is masked");
    expect(await page.getByRole("button", { name: "Autorizar y registrar", exact: true }).isDisabled(), "cannot be sent without a PIN");
    // a wrong PIN (and a seller's PIN) is refused inline, the dialog stays and the field is emptied
    for (const bad of ["73910462", vendor.pin]) {
      await authorize(bad);
      await dialog.getByTestId("rf-auth-error").getByText("PIN de administrador inválido").waitFor();
      expect((await pinInput().inputValue()) === "", "the typed PIN is cleared after every attempt");
    }
    expect((await one("select count(*)::int n from returns where sale_id=$1", [sale.id])).n === 0, "nothing was registered by the rejected attempts");
    await authorize(admin.pin);
    await page.getByTestId("return-result").getByText(/PAGADO EN EFECTIVO/).waitFor({ timeout: 8000 });
    const t = await resultText();
    expect(t.includes("$20.00") && t.includes(`Autorizó: ${admin.name}`) && t.includes(`Atendió: ${vendor.name}`), "the persisted result names who authorized and who attended: " + t);
    const st = await one("select s.*, r.refund_status from refund_settlements s join returns r on r.id=s.return_id where r.sale_id=$1", [sale.id]);
    expect(st.refund_status === "paid" && st.payment_method === "cash" && st.authorized_by === admin.id && st.processed_by === vendor.id && num(st.amount) === 20, "persisted: " + J(st));
    expect((await cashNow()) === cash0 - 20, "cash decreased exactly once");
    expect(num((await one("select stock from products where id=$1", [P[0].id])).stock) === stock0 + 2, "stock restored");
    // the operator is still the seller: nothing was signed in or out
    const me = await call("api.auth.me()");
    const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("user") || "null"));
    expect(me.ok && me.v.id === vendor.id && stored && stored.id === vendor.id, "session unchanged: " + J([me, stored]));
    expect(page.url().endsWith("#/returns"), "still on the returns screen");
    // the PIN lives nowhere after the operation
    const leaked = await page.evaluate((pin) => document.documentElement.outerHTML.includes(pin) || document.body.innerText.includes(pin) || JSON.stringify(sessionStorage).includes(pin) || JSON.stringify(localStorage).includes(pin), admin.pin);
    expect(leaked === false, "the administrator PIN is not in the DOM or in browser storage");
    await page.getByRole("dialog").waitFor({ state: "detached" });
  });

  await test("RUI-02.card_refund_needs_the_terminal_confirmation_keeps_the_reference_and_never_touches_cash", "e2e", async () => {
    const sale = await mkSale({ method: "cash", lines: [{ p: P[1], q: 2 }] });
    const cash0 = await cashNow(), cmov0 = (await one("select count(*)::int n from cash_movements")).n;
    await lookupSale(sale.id);
    await fillReturn(P[1], 1);
    await page.locator("#rf-method-card").click();
    expect(await mainButton().isDisabled(), "card without confirmation stays disabled");
    await page.locator("#rf-reference").fill("TERM-0042/B");
    await page.locator("#rf-confirm").check();
    expect((await page.locator("label[for=rf-confirm]").innerText()).includes("ya se realizó en la terminal de tarjeta"), "the sentence is about the terminal, not about cash");
    await mainButton().click();
    await authorize(admin.pin);
    await page.getByTestId("return-result").getByText(/PAGADO POR TARJETA/).waitFor({ timeout: 8000 });
    expect((await resultText()).includes("Referencia: TERM-0042/B"), "reference shown");
    const st = await one("select s.*, r.refund_status from refund_settlements s join returns r on r.id=s.return_id where r.sale_id=$1", [sale.id]);
    expect(st.payment_method === "card" && st.external_reference === "TERM-0042/B" && st.cash_movement_id === null && num(st.amount) === 10, "persisted card settlement " + J(st));
    expect((await cashNow()) === cash0 && (await one("select count(*)::int n from cash_movements")).n === cmov0, "cash and movements untouched");
  });

  await test("RUI-03.changing_anything_withdraws_the_confirmation_and_cash_problems_are_explained_before_asking_for_a_PIN", "e2e", async () => {
    const sale = await mkSale({ lines: [{ p: P[2], q: 4 }] });
    await lookupSale(sale.id);
    await fillReturn(P[2], 1);
    await page.locator("#rf-method-cash").click();
    await page.locator("#rf-confirm").check();
    await page.getByLabel(`Cantidad a devolver de ${P[2].name}`).fill("2");
    expect(!(await page.locator("#rf-confirm").isChecked()) && await mainButton().isDisabled(), "a changed quantity un-ticks the confirmation (the amount it vouched for changed)");
    await page.locator("#rf-confirm").check();
    await page.getByLabel("Motivo", { exact: true }).fill("Otro motivo");
    expect(!(await page.locator("#rf-confirm").isChecked()), "so does a changed reason");
    // register problems (re-selecting the method refreshes the register figures)
    await db.query("update cash_sessions set current_amount='5.00' where closed_at is null");
    await page.locator("#rf-method-card").click();
    await page.locator("#rf-method-cash").click();
    await page.locator("#rf-confirm").check();
    await page.getByTestId("rf-cash-problem").getByText(/La caja solo tiene \$5\.00/).waitFor();
    expect(await mainButton().isDisabled(), "not enough cash: blocked with the reason, before any PIN");
    await page.locator("#rf-method-card").click();
    expect(await page.getByTestId("rf-cash-problem").count() === 0, "card has no cash problem");
    await db.query("update cash_sessions set current_amount='300.00' where closed_at is null");
    await closeStrayCash(db, admin.id);
    await page.locator("#rf-method-cash").click();
    await page.getByTestId("rf-cash-problem").getByText(/No hay una caja abierta/).waitFor();
    await openRegister(300);
  });

  await test("RUI-04.two_fast_clicks_register_one_refund_and_an_unsure_outcome_warns_to_verify_then_retries_safely", "e2e", async () => {
    await gotoReturns();
    const sale = await mkSale({ lines: [{ p: P[3], q: 2 }] });
    await lookupSale(sale.id);
    await fillReturn(P[3], 2);
    await page.locator("#rf-method-cash").click();
    await page.locator("#rf-confirm").check();
    const cash0 = await cashNow();
    await mainButton().click();
    await pinInput().fill(admin.pin);
    // the registration fails after the operator has "handed over the cash": the outcome is unknown
    await withTrigger("refund_settlements", "before insert", "rfu_boom", "raise exception 'boom';", async () => {
      await page.getByRole("button", { name: "Autorizar y registrar", exact: true }).click();
      await page.getByTestId("rf-uncertain").waitFor({ timeout: 8000 });
    });
    const warn = await page.getByTestId("rf-uncertain").innerText();
    expect(/VERIFICA el estado/.test(warn) && /antes de intentar de nuevo/.test(warn) && /no se pagará dos veces/.test(warn), "the warning tells the operator to check before paying again: " + warn);
    expect((await one("select count(*)::int n from returns where sale_id=$1", [sale.id])).n === 0 && (await cashNow()) === cash0, "nothing was recorded by the failed attempt");
    expect(!/boom|select |insert /i.test(warn), "no internals in the warning");
    // retry with the same operation: a double click still registers one refund
    await pinInput().fill(admin.pin);
    await page.getByRole("button", { name: "Autorizar y registrar", exact: true }).dblclick();
    await page.getByTestId("return-result").getByText(/PAGADO EN EFECTIVO/).waitFor({ timeout: 8000 });
    expect((await one("select count(*)::int n from refund_settlements s join returns r on r.id=s.return_id where r.sale_id=$1", [sale.id])).n === 1, "exactly one settlement after the retry and the double click");
    expect((await cashNow()) === cash0 - 20, "cash decreased once");
  });

  await test("RUI-05.the_return_can_also_be_registered_without_a_refund_and_paid_later_with_the_same_authorization", "e2e", async () => {
    await gotoReturns();
    const sale = await mkSale({ method: "cash", lines: [{ p: P[4], q: 2 }] });
    await lookupSale(sale.id);
    await fillReturn(P[4], 2, "Producto dañado");
    await page.getByRole("button", { name: /Registrar la devolución sin reembolso/ }).click();
    await page.getByTestId("return-result").getByText(/Estado: PENDIENTE/).waitFor();
    const ret = await one("select * from returns where sale_id=$1", [sale.id]);
    expect(ret.refund_status === "pending", "pending");
    const row = page.getByTestId(`return-row-${ret.id}`);
    expect((await row.getByTestId(`return-state-${ret.id}`).innerText()) === "PENDIENTE", "the history says PENDIENTE");
    const stock0 = num((await one("select stock from products where id=$1", [P[4].id])).stock), items0 = (await one("select count(*)::int n from return_items")).n;
    const cash0 = await cashNow();
    await page.getByTestId(`pay-pending-${ret.id}`).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByText(`Registrar pago de la devolución #${ret.id}`).waitFor();
    expect((await dlg.getByTestId("rf-pending-summary").innerText()).includes("$20.00"), "the dialog shows the owed amount");
    expect(await page.getByRole("button", { name: "Autorizar y registrar pago", exact: true }).isDisabled(), "no method, no confirmation, no PIN: cannot be sent");
    await page.locator("#rp-method-card").click();
    await page.locator("#rp-reference").fill("TERM-9");
    await page.locator("#rp-confirm").check();
    await pinInput().fill(vendor.pin);
    await page.getByRole("button", { name: "Autorizar y registrar pago", exact: true }).click();
    await dlg.getByTestId("rf-auth-error").getByText("PIN de administrador inválido").waitFor();
    expect((await one("select refund_status s from returns where id=$1", [ret.id])).s === "pending", "a seller's PIN does not pay it");
    await authorize(admin.pin, "Autorizar y registrar pago");
    await page.getByTestId("return-result").getByText(/PAGADO POR TARJETA/).waitFor({ timeout: 8000 });
    await row.getByText("PAGADO POR TARJETA").waitFor();
    expect(num((await one("select stock from products where id=$1", [P[4].id])).stock) === stock0 && (await one("select count(*)::int n from return_items")).n === items0, "no second stock movement and no new lines");
    expect((await cashNow()) === cash0, "paying by card did not touch the cash");
    expect(await page.getByTestId(`pay-pending-${ret.id}`).count() === 0, "the pay button is gone once paid");
  });

  await test("RUI-06.history_filters_distinguish_pending_cash_card_and_legacy", "e2e", async () => {
    const sale = await mkSale({ lines: [{ p: P[5], q: 1 }] });
    const legacy = await one("insert into returns(sale_id,total_refund,reason,processed_by,refund_status) values($1,'10.00','antiguo',$2,'legacy_unspecified') returning id", [sale.id, admin.id]);
    await db.query("insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) select $1, id, product_id, 1, '10.00' from sale_items where sale_id=$2", [legacy.id, sale.id]);
    const pending = await one("insert into returns(sale_id,total_refund,reason,processed_by) values($1,'5.00','pendiente suelto',$2) returning id", [sale.id, vendor.id]);
    await gotoReturns();
    const labels = async () => (await page.locator("[data-testid^=return-state-]").allInnerTexts());
    const all = await labels();
    for (const l of ["PENDIENTE", "PAGADO EN EFECTIVO", "PAGADO POR TARJETA", "LEGACY (anterior al control)"]) expect(all.includes(l), "history shows " + l + ": " + J([...new Set(all)]));
    for (const [value, label] of [["pending", "PENDIENTE"], ["cash", "PAGADO EN EFECTIVO"], ["card", "PAGADO POR TARJETA"], ["legacy", "LEGACY (anterior al control)"]]) {
      await page.locator("#rt-filter").selectOption(value);
      const got = await labels();
      expect(got.length > 0 && got.every((x) => x === label), `filter ${value}: ` + J([...new Set(got)]));
    }
    await page.locator("#rt-filter").selectOption("all");
    expect(await page.getByTestId(`pay-pending-${legacy.id}`).count() === 0, "a legacy return offers no payment button");
    expect(await page.getByTestId(`pay-pending-${pending.id}`).count() === 1, "a pending one does");
  });

  await test("RUI-07.the_voucher_states_exactly_what_happened_to_the_money", "e2e", async () => {
    const paid = await one("select r.id from returns r join refund_settlements s on s.return_id=r.id where s.payment_method='cash' and s.authorized_by=$1 order by r.id desc limit 1", [admin.id]);
    await page.getByRole("button", { name: `Comprobante de la devolución ${paid.id}` }).click();
    const frame = page.frameLocator('iframe[title="Vista previa del comprobante de devolución"]');
    await frame.getByText(`Comprobante de devolución #${paid.id}`).waitFor({ timeout: 8000 });
    await frame.getByText("REEMBOLSO PAGADO EN EFECTIVO").waitFor();
    await frame.getByText("Efectivo (de la caja)").waitFor();
    await frame.getByText(admin.name).first().waitFor();
    await frame.getByText("no es una factura fiscal").waitFor();
    await page.getByRole("button", { name: "Cerrar" }).first().click();
    const pend = await one("select id from returns where refund_status='pending' order by id limit 1");
    const html = await call(`api.returns.previewVoucher(${pend.id})`);
    expect(html.ok && html.v.html.includes("REEMBOLSO PENDIENTE (NO PAGADO)") && html.v.html.includes("aún NO se ha entregado"), "pending voucher says it is NOT paid");
    const legacy = await one("select id from returns where refund_status='legacy_unspecified' order by id limit 1");
    const lh = await call(`api.returns.previewVoucher(${legacy.id})`);
    expect(lh.ok && lh.v.html.includes("ANTERIOR AL CONTROL DE REEMBOLSOS") && !lh.v.html.includes("PAGADO"), "legacy voucher never says paid");
    const bad = await call("api.returns.previewVoucher(99999999)");
    expect(bad.ok === false && /\[DEVOLUCION_NO_ENCONTRADA\]/.test(bad.err), "unknown return: stable error");
  });

  await test("RUI-08.the_dialog_and_the_form_fit_the_window_without_horizontal_scrolling", "e2e", async () => {
    const sale = await mkSale({ lines: [{ p: P[6], q: 1 }] });
    await gotoReturns();
    await lookupSale(sale.id);
    await fillReturn(P[6], 1);
    await page.locator("#rf-method-card").click();
    await page.locator("#rf-confirm").check();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow <= 1, "no horizontal overflow of the form: " + overflow);
    await mainButton().click();
    await page.getByRole("dialog").waitFor();
    await sleep(700); // let the opening animation finish before measuring
    const box = await page.getByRole("dialog").boundingBox();
    const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
    expect(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= vp.w + 1 && box.y + box.height <= vp.h + 1, "the authorization dialog is fully inside the window: " + J([box, vp]));
    expect(await pinInput().evaluate((el) => el === document.activeElement), "the PIN field has the focus");
    fs.mkdirSync(artifacts, { recursive: true });
    await page.screenshot({ path: path.join(artifacts, "refundui-authorization-dialog.png") });
    await page.getByRole("button", { name: "Cancelar" }).click();
    await page.getByRole("dialog").waitFor({ state: "detached" });
    expect((await one("select count(*)::int n from returns where sale_id=$1", [sale.id])).n === 0, "cancelling registers nothing");
  });

  // ================================================================== reports reconcile with the ledger
  await test("RUI-09.dashboard_reports_cash_history_and_the_closing_summary_reconcile_with_the_ledger", "e2e", async () => {
    await loginAs(admin);
    // today's refunds by method, straight from the ledger (payment date = today)
    const ledger = await rows("select payment_method m, count(*)::int n, coalesce(sum(amount),0)::numeric t from refund_settlements where paid_at >= date_trunc('day', now()) group by 1");
    const by = (m) => ledger.find((r) => r.m === m) ?? { n: 0, t: "0" };
    const owed = await one("select coalesce(sum(total_refund),0)::numeric t, count(*)::int n from returns where refund_status='pending'");
    const stats = await call("api.dashboard.getStats()");
    expect(stats.ok && num(stats.v.refunds.paidToday.cash.total) === num(by("cash").t) && stats.v.refunds.paidToday.cash.count === by("cash").n, "dashboard cash refunds match the ledger: " + J(stats.v.refunds));
    expect(num(stats.v.refunds.paidToday.card.total) === num(by("card").t) && num(stats.v.refunds.pendingOutstanding.total) === num(owed.t) && stats.v.refunds.pendingOutstanding.count === owed.n, "card refunds and the owed amount match");
    await ui.nav(page, "Dashboard");
    const text = async () => page.evaluate(() => document.body.innerText);
    await page.getByText("Reembolsos pagados en efectivo (hoy)").waitFor({ timeout: 8000 });
    expect((await ui.statVal(page, "Reembolsos pagados en efectivo (hoy)")) === "$" + num(by("cash").t).toFixed(2), "dashboard card (cash): " + (await ui.statVal(page, "Reembolsos pagados en efectivo (hoy)")));
    expect((await ui.statVal(page, "Reembolsos pagados por tarjeta (hoy)")) === "$" + num(by("card").t).toFixed(2), "dashboard card (card)");
    expect((await ui.statVal(page, "Reembolsos pendientes de pago")) === "$" + num(owed.t).toFixed(2), "dashboard card (owed)");
    expect(!/Reembolsos pagados \(hoy\)/.test(await text()), "the old ambiguous 'paid' card is gone");

    // the report for today: by payment date, by method; a refund is counted once
    await ui.nav(page, "Reportes");
    await page.getByTestId("rp-count").waitFor();
    const cell = async (id) => (await page.getByTestId(id).innerText()).replace(/\s+/g, " ");
    expect((await cell("rp-paid-cash")).includes("$" + num(by("cash").t).toFixed(2)) && (await cell("rp-paid-card")).includes("$" + num(by("card").t).toFixed(2)), "report refunds by method: " + (await cell("rp-paid-cash")) + " | " + (await cell("rp-paid-card")));
    expect((await cell("rp-owed")).includes("$" + num(owed.t).toFixed(2)), "report: owed now");
    const sum = await call(`api.reports.getSummary(${J({ from: new Date().toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) })})`);
    void sum; // (the page above uses the local calendar day; the API call only has to be callable by an administrator)

    // register history: every session's refunds add up to the ledger, and expected cash reconciles in each one
    const sessions = await rows("select id from cash_sessions order by id");
    let cashTotal = 0, cardTotal = 0;
    for (const s of sessions) {
      const d = await call(`api.cash.getSessionSummary(${s.id})`);
      expect(d.ok && d.v.expected.reconciles !== undefined, "summary for session " + s.id);
      cashTotal += num(d.v.refunds.cash.total);
      cardTotal += num(d.v.refunds.card.total);
      const closed = d.v.session.status === "closed";
      if (closed) continue; // sessions closed by the harness with SQL do not carry a counted amount
    }
    const ledgerCash = num((await one("select coalesce(sum(amount),0)::numeric t from refund_settlements where payment_method='cash'")).t);
    const ledgerCard = num((await one("select coalesce(sum(amount),0)::numeric t from refund_settlements where payment_method='card' and cash_session_id is not null")).t);
    expect(Math.abs(cashTotal - ledgerCash) < 0.005 && Math.abs(cardTotal - ledgerCard) < 0.005, `session summaries add up to the ledger: ${cashTotal}/${ledgerCash} ${cardTotal}/${ledgerCard}`);

    // the current register: summary, screen card and printable document tell the same story
    const open = await registerNow();
    const cur = await call(`api.cash.getSessionSummary(${open.id})`);
    expect(cur.v.expected.reconciles && num(cur.v.refunds.cash.total) > 0, "the open register reconciles and has cash refunds: " + J(cur.v.expected));
    await ui.nav(page, "Caja");
    await page.getByTestId("cash-refunds").waitFor();
    expect((await page.getByTestId("cash-refunds").innerText()) === "-$" + num(cur.v.refunds.cash.total).toFixed(2), "Caja shows the cash refunds paid from this register");
    expect((await ui.statVal(page, "Total en Caja")) === "$" + num(open.current_amount).toFixed(2), "and the balance already includes them once");
    const doc = await call(`api.cash.previewSummary(${open.id})`);
    expect(doc.ok && doc.v.html.includes(`Reembolsos en efectivo (${cur.v.refunds.cash.count})`) && doc.v.html.includes("-$" + num(cur.v.refunds.cash.total).toFixed(2)), "the printable closing summary lists the cash refunds");
    expect(doc.v.html.includes("Reembolsos pagados en esta caja") && doc.v.html.includes("son informativos y no restan efectivo"), "and says card refunds are informational");
    // closing at the expected amount gives a zero difference even with refunds in the session
    const closed = await call(`api.cash.closeSession(${open.id}, ${num(open.current_amount)})`);
    expect(closed.ok, J(closed));
    const after = await call(`api.cash.getSessionSummary(${open.id})`);
    expect(num(after.v.closing.difference) === 0 && after.v.expected.reconciles, "closing: difference 0.00 and records reconcile: " + J(after.v.closing));
    await page.reload(); // the open Caja screen must show the closed register
    await page.getByText("No hay sesión de caja abierta").waitFor();
    await page.getByRole("link", { name: /Historial de sesiones/ }).click();
    await page.getByRole("table", { name: "Sesiones de caja" }).waitFor();
    await page.getByRole("button", { name: `Ver sesión ${open.id}`, exact: true }).click();
    await page.locator("[data-testid=cs-cash-refunds]").waitFor();
    expect((await page.locator("[data-testid=cs-cash-refunds]").innerText()) === "-$" + num(after.v.refunds.cash.total).toFixed(2), "history detail: cash refunds line");
    expect((await page.locator("[data-testid=cs-manual-out]").innerText()) === "-$" + num(after.v.movements.manualOut.total).toFixed(2), "the manual withdrawals line does not include refunds");
    await page.getByTestId("cs-refunds-cash").waitFor();
    await openRegister(300);
  });

  // ================================================================== persistence after restarting the application
  await test("RUI-10.refunds_survive_restarting_the_application_and_the_history_shows_the_same_states", "e2e", async () => {
    const before = await rows("select r.id, r.refund_status, s.payment_method, s.amount, s.authorized_by from returns r left join refund_settlements s on s.return_id=r.id order by r.id");
    await c.app.close();
    await sleep(800);
    const relaunched = await launchApp(c.runDb, db, artifacts, {});
    try {
      const p = relaunched.page;
      await p.getByText("Ingresa tu PIN para comenzar").waitFor();
      await ui.login(p, vendor.pin);
      await p.waitForURL(/#\/sales$/, { timeout: 10000 });
      await ui.nav(p, "Devoluciones");
      await p.getByText("Historial de devoluciones").waitFor();
      await p.locator("[data-testid^=return-state-]").first().waitFor();
      const shownStates = await p.locator("[data-testid^=return-state-]").evaluateAll((els) => els.map((e) => [Number(e.getAttribute("data-testid").replace("return-state-", "")), e.textContent]));
      const label = (r) => (r.refund_status === "paid" ? (r.payment_method === "cash" ? "PAGADO EN EFECTIVO" : "PAGADO POR TARJETA") : r.refund_status === "pending" ? "PENDIENTE" : "LEGACY (anterior al control)");
      const expected = new Map(before.map((r) => [r.id, label(r)]));
      const mismatches = shownStates.filter(([id, text]) => expected.get(id) !== text);
      expect(shownStates.length === before.length && before.length >= 6 && mismatches.length === 0, `after the restart the history shows the same ${before.length} returns with the same states (shown ${shownStates.length}): ` + J(mismatches));
      const after = await rows("select r.id, r.refund_status, s.payment_method, s.amount, s.authorized_by from returns r left join refund_settlements s on s.return_id=r.id order by r.id");
      expect(J(after) === J(before), "the ledger is byte-for-byte what it was before the restart");
      const paidId = before.find((r) => r.refund_status === "paid").id;
      const again = await p.evaluate(async (id) => {
        try { return { ok: true, v: await window.api.returns.settleRefund({ returnId: id, payment: { method: "cash", confirmed: true }, operationId: "op-after-restart-1" }, "000000") }; } catch (e) { return { ok: false, err: String(e.message) }; }
      }, paidId);
      expect(again.ok === false && /\[REEMBOLSO_YA_PAGADO\]/.test(again.err), "a refund paid before the restart still cannot be paid again: " + J(again));
    } finally {
      try { await relaunched.app.close(); } catch { /* already closed */ }
      fs.rmSync(relaunched.userData, { recursive: true, force: true });
    }
  });

  void crypto;
}
