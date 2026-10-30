// Cash suite (Sprint 04, block C): closing summaries and the register history, through the real UI. The figures shown
// are checked against PostgreSQL and against the amounts the test itself created. Sessions are produced by real
// checkouts, manual income/withdrawals and real closings; a few legacy-style rows are inserted as fixtures.
// Printing uses the development-only automation (PDF of the real print document); no physical printer was used.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { APP_URL, ui, ipc, expect, closeStrayCash, launchApp } from "../lib/harness.mjs";

const PRINT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pos-cash-print-"));
const MODE_FILE = path.join(PRINT_DIR, "mode.txt");
fs.writeFileSync(MODE_FILE, "pdf");
export const env = { POS_PRINT_MODE_FILE: MODE_FILE, POS_PRINT_PDF_DIR: PRINT_DIR };

const J = JSON.stringify;

export async function run(c) {
  const { db, data, test, runDb, artifacts } = c;
  let page = c.page;
  let relaunched = null;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  const num = (v) => Number(v);
  const money = (v) => `$${num(v).toFixed(2)}`;
  const signed = (v) => (num(v) > 0 ? "+" : "") + money(v);
  const LEAKS = /Failed query|params:|\n\s+at |select |insert |relation "|password|postgres(ql)?:\/\//i;

  const admin = await data.user("CSH_ADMIN", "admin");
  const v1 = await data.user("CSH_V1", "vendor");
  await closeStrayCash(db, admin.id);
  const pA = await data.product("CA", "10.00", 500);
  const pB = await data.product("CB", "4.50", 500);

  const summaryOf = async (sessionId) => {
    const r = await page.evaluate((id) => window.api.cash.getSessionSummary(id), sessionId);
    return r;
  };
  const closeAll = async () => {
    for (let i = 0; i < 5; i++) {
      if ((await page.getByRole("dialog").count()) === 0) return;
      await page.keyboard.press("Escape");
      await page.waitForTimeout(350);
    }
  };
  /** Runs one real shift: open, cash sales, card sales, manual income/withdrawal, close counting `counted(expected)`. */
  const shift = async ({ initial, cash = [], card = [], income = null, withdrawal = null, counted }) => {
    await ui.openCash(page, initial);
    const sessionId = (await one("select id from cash_sessions where closed_at is null")).id;
    for (const [p, q] of cash) await ui.sell(page, { query: p.sku, name: p.name, qty: q, method: "cash" });
    for (const [p, q] of card) await ui.sell(page, { query: p.sku, name: p.name, qty: q, method: "card" });
    await ui.nav(page, "Caja");
    if (income) await ui.cashMovement(page, "Ingreso", income[0], income[1]);
    if (withdrawal) await ui.cashMovement(page, "Retiro", withdrawal[0], withdrawal[1]);
    await page.getByText("Total en Caja").waitFor({ timeout: 8000 });
    const stats = { cash: await ui.statVal(page, "Ventas Efectivo"), card: await ui.statVal(page, "Ventas Tarjeta"), total: await ui.statVal(page, "Total en Caja") };
    const expectedNow = num(stats.total.replace("$", ""));
    await page.getByRole("button", { name: "Cerrar Caja" }).click();
    const d = page.getByRole("dialog");
    await d.getByPlaceholder("Monto real contado").fill(String(counted(expectedNow)));
    await d.getByRole("button", { name: "Cerrar Caja" }).click();
    await page.getByText("No hay sesión de caja abierta").waitFor({ timeout: 6000 });
    return { sessionId, stats, expectedNow };
  };
  const openHistory = async () => {
    await closeAll(); // a failed earlier test must not leave a dialog over the next one
    await ui.nav(page, "Caja");
    await page.getByRole("link", { name: "Historial de sesiones" }).click();
    await page.waitForURL(/#\/cash\/history$/);
    await page.getByRole("heading", { name: "Historial de caja" }).waitFor();
  };
  const openSummary = async (id) => {
    await page.getByRole("button", { name: `Ver sesión ${id}`, exact: true }).click();
    await page.getByRole("dialog").getByText(`Corte de caja #${id}`).first().waitFor();
    return page.getByRole("dialog");
  };

  await test("CSH-00.admin_signs_in", "e2e", async () => {
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
  });

  // ================================================================== sessions made through the real flow
  let A, B, C;
  await test("CSH-01.cash_card_income_withdrawal_and_an_exact_close", "e2e", async () => {
    A = await shift({ initial: 100, cash: [[pA, 3], [pB, 2]], card: [[pA, 4]], income: [50, "Fondo extra"], withdrawal: [30, "Pago a proveedor"], counted: (e) => e });
    // 3*10 + 2*4.5 = 39 cash; 4*10 = 40 card; expected = 100 + 39 + 50 - 30
    expect(A.stats.cash === "$39.00" && A.stats.card === "$40.00" && A.stats.total === "$159.00", "the open-register screen shows the structured totals: " + J(A.stats));
    const mv = await rows("select reason, type, amount, sale_id from cash_movements where session_id=$1 order by id", [A.sessionId]);
    const saleMovements = mv.filter((m) => m.sale_id !== null);
    const manual = mv.filter((m) => m.sale_id === null);
    expect(saleMovements.length === 3 && J(manual.map((m) => [m.type, m.reason])) === J([["IN", "Fondo extra"], ["OUT", "Pago a proveedor"]]), "sale movements carry a sale_id; manual ones do not: " + J(mv.map((m) => [m.reason, m.sale_id])));
    expect(saleMovements.every((m) => /^Venta #\d+/.test(m.reason)), "(reason text kept for people)");
  });
  await test("CSH-02.history_shows_the_closed_session_with_the_exact_figures_and_zero_difference", "e2e", async () => {
    await openHistory();
    const d = await openSummary(A.sessionId);
    expect((await d.getByTestId("cs-initial").innerText()) === "$100.00", "initial");
    expect((await d.getByTestId("cs-cash-sales").innerText()) === "$39.00", "cash sales only");
    expect((await d.getByTestId("cs-card-sales").innerText()) === "$40.00", "card sales shown apart");
    expect((await d.getByTestId("cs-manual-in").innerText()) === "$50.00" && (await d.getByTestId("cs-manual-out").innerText()) === "-$30.00", "manual income and withdrawal");
    expect((await d.getByTestId("cs-expected").innerText()) === "$159.00" && (await d.getByTestId("cs-counted").innerText()) === "$159.00", "expected = counted");
    expect((await d.getByTestId("cs-difference").innerText()) === "$0.00", "exact match");
    expect((await d.getByTestId("cs-sales-count").innerText()) === "3", "3 sales (cash ×2 lines is one sale, card one)");
    await d.getByText("Diferencia (Sin diferencia)").waitFor();
    await d.getByText(`Abrió:`).locator("strong").getByText(admin.name).waitFor();
    // the numbers come from the database: recompute them independently
    const s = await one("select count(*)::int n, coalesce(sum(total) filter (where payment_method='cash'),0)::numeric s1, coalesce(sum(total) filter (where payment_method='card'),0)::numeric s2 from sales where cash_session_id=$1", [A.sessionId]);
    expect(s.n === 3 && num(s.s1) === 39 && num(s.s2) === 40, "independent SQL agrees");
    await closeAll();
  });
  await test("CSH-03.a_positive_difference_is_an_overage", "e2e", async () => {
    await ui.nav(page, "Caja");
    B = await shift({ initial: 50, cash: [[pB, 1]], counted: (e) => e + 7 });
    await openHistory();
    const d = await openSummary(B.sessionId);
    expect((await d.getByTestId("cs-difference").innerText()) === "+$7.00", "difference +$7.00");
    await d.getByText("Diferencia (Sobrante)").waitFor();
    expect(num(B.expectedNow) === 54.5 && (await d.getByTestId("cs-expected").innerText()) === "$54.50" && (await d.getByTestId("cs-counted").innerText()) === "$61.50", "expected 54.50, counted 61.50");
    await closeAll();
  });
  await test("CSH-04.a_negative_difference_is_a_shortage", "e2e", async () => {
    await ui.nav(page, "Caja");
    C = await shift({ initial: 20, cash: [[pA, 1]], card: [[pB, 3]], withdrawal: [5, "Cambio al cliente"], counted: (e) => e - 4.25 });
    await openHistory();
    const d = await openSummary(C.sessionId);
    expect((await d.getByTestId("cs-difference").innerText()) === "-$4.25", "difference -$4.25");
    await d.getByText("Diferencia (Faltante)").waitFor();
    expect((await d.getByTestId("cs-expected").innerText()) === "$25.00" && (await d.getByTestId("cs-card-sales").innerText()) === "$13.50", "expected 20+10-5, card 13.50 apart");
    expect((await d.getByTestId("cs-difference").getAttribute("class")).includes("red"), "shortage is red");
    await closeAll();
  });
  await test("CSH-05.several_sessions_of_the_same_day_listed_newest_first_with_filters_and_pagination", "e2e", async () => {
    // 25 old closed sessions as fixtures (a previous year) to exercise pagination and the date filter
    for (let i = 0; i < 25; i++) {
      await db.query("insert into cash_sessions(opened_by,initial_amount,current_amount,status,opened_at,closed_at,closed_by,final_amount) values($1,'10','10','closed',$2,$3,$1,'10')", [admin.id, new Date(2025, 0, 1 + i, 8), new Date(2025, 0, 1 + i, 20)]);
    }
    await openHistory();
    const table = page.getByRole("table", { name: "Sesiones de caja" });
    const folios = async () => (await table.locator("tbody tr td:first-child").allInnerTexts()).map((t) => num(t.replace("#", "")));
    const total = (await one("select count(*)::int n from cash_sessions")).n;
    await page.getByTestId("cash-history-summary").getByText(new RegExp(`^${total} sesiones · Página 1 de ${Math.ceil(total / 20)}$`)).waitFor();
    const first = await folios();
    expect(J(first) === J((await rows("select id from cash_sessions order by opened_at desc, id desc limit 20")).map((r) => r.id)), "newest first, same order as SQL: " + J(first));
    expect(first.slice(0, 3).join() === [C.sessionId, B.sessionId, A.sessionId].join(), "the three real sessions of today come first, newest first");
    await page.getByRole("button", { name: "Siguiente" }).click();
    await page.getByTestId("cash-history-summary").getByText(/Página 2 de/).waitFor();
    expect((await folios()).length === total - 20, "page 2 has the rest");
    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    await page.locator("#ch-from").fill(iso);
    await page.locator("#ch-to").fill(iso);
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await page.getByTestId("cash-history-summary").getByText(/^3 sesiones · Página 1 de 1$/).waitFor();
    await page.locator("#ch-status").selectOption("open");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await page.getByText("No hay sesiones de caja que coincidan").waitFor();
    await page.locator("#ch-from").fill("2025-01-01");
    await page.locator("#ch-to").fill("2025-01-31");
    await page.locator("#ch-status").selectOption("closed");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await page.getByTestId("cash-history-summary").getByText(/^25 sesiones · Página 2 de 2$|^25 sesiones · Página 1 de 2$/).waitFor();
    await page.locator("#ch-to").fill("2024-12-31");
    await page.locator("#ch-from").fill("2025-02-01");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await page.getByRole("alert").getByText(/no puede ser posterior/).waitFor();
    await page.getByRole("button", { name: "Limpiar", exact: true }).click();
  });
  await test("CSH-06.an_empty_register_history_and_unreconciled_old_data_are_explained", "e2e", async () => {
    // a historic session whose movements were never linked (legacy rows 0008 could not verify): the stored balance disagrees with the records
    const hist = (await one("insert into cash_sessions(opened_by,initial_amount,current_amount,status,opened_at,closed_at,closed_by,final_amount) values($1,'100','180','closed',$2,$3,$1,'180') returning id", [admin.id, new Date(2024, 5, 1, 8), new Date(2024, 5, 1, 20)])).id;
    const sale = (await one("insert into sales(user_id,cash_session_id,total,payment_method,created_at) values($1,$2,'80','cash',$3) returning id", [admin.id, hist, new Date(2024, 5, 1, 10)])).id;
    await db.query("insert into sale_items(sale_id,product_id,quantity,unit_price,subtotal) values($1,$2,8,'10.00','80.00')", [sale, pA.id]);
    await db.query("insert into cash_movements(session_id,user_id,type,amount,reason) values($1,$2,'IN','80','Venta #" + sale + " - Efectivo')", [hist, admin.id]); // text only, no sale_id
    await openHistory();
    await page.locator("#ch-from").fill("2024-01-01");
    await page.locator("#ch-to").fill("2024-12-31");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    const d = await openSummary(hist);
    await d.getByTestId("cs-unreconciled").waitFor();
    expect((await d.getByTestId("cs-expected").innerText()) === "$180.00", "the headline is the register balance the cashier saw");
    expect((await d.getByTestId("cs-unreconciled").innerText()).includes("$260.00"), "and the mismatch with the records ($100 + 80 sales + 80 unlinked income) is shown, not hidden");
    expect(num((await one("select final_amount from cash_sessions where id=$1", [hist])).final_amount) === 180, "nothing was modified");
    await closeAll();
    // empty state: a range with no sessions
    await page.locator("#ch-from").fill("2020-01-01");
    await page.locator("#ch-to").fill("2020-01-02");
    await page.getByRole("button", { name: "Buscar", exact: true }).click();
    await page.getByText("No hay sesiones de caja que coincidan").waitFor();
  });
  await test("CSH-07.returns_of_a_session_are_shown_and_pending_does_not_mean_paid", "e2e", async () => {
    const saleOfA = (await one("select id from sales where cash_session_id=$1 order by id limit 1", [A.sessionId])).id;
    const item = (await one("select id, product_id from sale_items where sale_id=$1 limit 1", [saleOfA]));
    const r = (await one("insert into returns(sale_id,total_refund,refund_status,reason,processed_by) values($1,'20.00','pending','Prueba',$2) returning id", [saleOfA, admin.id])).id;
    await db.query("insert into return_items(return_id,sale_item_id,product_id,quantity,refund_amount) values($1,$2,$3,1,'20.00')", [r, item.id, item.product_id]);
    const cashBefore = await one("select current_amount from cash_sessions where id=$1", [A.sessionId]);
    await openHistory();
    const d = await openSummary(A.sessionId);
    await d.getByText(/Reembolsos PENDIENTES \(1\)/).waitFor();
    expect((await d.getByTestId("cs-returns-pending").innerText()) === "$20.00", "pending refund total");
    await d.getByText(/NO está pagado ni descontado de la caja/).waitFor();
    expect((await d.getByTestId("cs-expected").innerText()) === "$159.00" && (await d.getByTestId("cs-difference").innerText()) === "$0.00", "the register figures did not move because of a pending refund");
    expect(J(await one("select current_amount from cash_sessions where id=$1", [A.sessionId])) === J(cashBefore), "cash untouched");
    await closeAll();
  });

  // ================================================================== printing and export never write
  const snapshot = async () => J(await one("select (select count(*) from sales)::int s, (select count(*) from sale_items)::int i, (select count(*) from cash_movements)::int m, (select coalesce(sum(amount),0) from cash_movements)::text ma, (select coalesce(sum(current_amount),0) from cash_sessions)::text cs, (select count(*) from cash_sessions)::int c, (select count(*) from inventory_movements)::int im, (select coalesce(sum(stock),0) from products)::int st, (select count(*) from returns)::int r"));
  const pdfWidthMm = (file) => {
    const t = fs.readFileSync(file).toString("latin1");
    const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(t);
    return m ? (Number(m[1]) / 72) * 25.4 : null;
  };
  await test("CSH-08.preview_print_and_csv_export_write_nothing", "e2e", async () => {
    const before = await snapshot();
    await openHistory();
    const d = await openSummary(C.sessionId);
    await d.getByRole("button", { name: "Exportar CSV" }).click();
    await page.getByText("CSV generado localmente").first().waitFor({ timeout: 5000 });
    await d.getByRole("button", { name: "Vista imprimible" }).click();
    const doc = page.getByRole("dialog").filter({ hasText: `Corte de caja #${C.sessionId}` }).last();
    const frame = page.frameLocator('iframe[title="Vista previa del corte de caja"]');
    await frame.getByText("Diferencia (Faltante)").waitFor({ timeout: 8000 });
    await frame.getByText("-$4.25").waitFor();
    await frame.getByText("no entran al efectivo").waitFor();
    await doc.getByRole("button", { name: "Imprimir" }).click();
    await page.getByTestId("print-status").getByText(/Corte enviado a imprimir/).waitFor({ timeout: 15000 });
    const f80 = path.join(PRINT_DIR, `cash-summary-${C.sessionId}-80mm.pdf`);
    expect(fs.existsSync(f80) && fs.readFileSync(f80).subarray(0, 5).toString() === "%PDF-", "an 80 mm PDF of the summary was produced");
    expect(Math.abs(pdfWidthMm(f80) - 80) < 2.5, "page width 80 mm: " + pdfWidthMm(f80));
    await closeAll();
    await db.query("update business_settings set paper_width='58' where id=1");
    await ui.nav(page, "Caja");
    await page.getByRole("link", { name: "Historial de sesiones" }).click();
    await page.getByRole("button", { name: `Ver sesión ${C.sessionId}`, exact: true }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Vista imprimible" }).click();
    await page.frameLocator('iframe[title="Vista previa del corte de caja"]').getByText("Diferencia (Faltante)").waitFor({ timeout: 8000 });
    await page.getByRole("dialog").filter({ hasText: `Corte de caja #${C.sessionId}` }).last().getByRole("button", { name: "Imprimir" }).click();
    await page.getByTestId("print-status").getByText(/Corte enviado a imprimir/).waitFor({ timeout: 15000 });
    const f58 = path.join(PRINT_DIR, `cash-summary-${C.sessionId}-58mm.pdf`);
    expect(fs.existsSync(f58) && Math.abs(pdfWidthMm(f58) - 58) < 2.5, "58 mm PDF too");
    await closeAll();
    await db.query("update business_settings set paper_width='80' where id=1");
    expect((await snapshot()) === before, "nothing was written by previewing, printing or exporting");
  });
  await test("CSH-09.cancelled_and_failed_prints_change_nothing", "e2e", async () => {
    const before = await snapshot();
    for (const [mode, text] of [["cancel", /Impresión cancelada/], ["fail", /No se pudo imprimir/]]) {
      fs.writeFileSync(MODE_FILE, mode);
      await openHistory();
      await openSummary(B.sessionId);
      await page.getByRole("dialog").getByRole("button", { name: "Vista imprimible" }).click();
      await page.getByRole("dialog").filter({ hasText: `Corte de caja #${B.sessionId}` }).last().getByRole("button", { name: "Imprimir" }).click();
      await page.getByTestId("print-status").getByText(text).waitFor({ timeout: 10000 });
      await closeAll();
    }
    fs.writeFileSync(MODE_FILE, "pdf");
    expect((await snapshot()) === before, "database untouched");
  });

  // ================================================================== role security
  await test("CSH-10.a_vendor_sees_the_open_session_and_only_their_own_closed_ones", "security", async () => {
    await ipc(page, "api.auth.logout()");
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, v1.pin);
    await page.waitForURL(/#\/sales$/, { timeout: 8000 });
    const V = await shift({ initial: 15, cash: [[pB, 2]], counted: (e) => e });
    // the vendor can open and close the shared register and sees that session
    await openHistory();
    const table = page.getByRole("table", { name: "Sesiones de caja" });
    const folios = (await table.locator("tbody tr td:first-child").allInnerTexts()).map((t) => num(t.replace("#", "")));
    expect(J(folios) === J([V.sessionId]), "the vendor lists only the session they opened and closed: " + J(folios));
    await openSummary(V.sessionId);
    await closeAll();
    for (const id of [A.sessionId, B.sessionId, C.sessionId]) {
      for (const ch of ["getSessionSummary", "previewSummary", "printSummary"]) {
        const r = await ipc(page, `api.cash.${ch}(${id})`);
        expect(r.ok === false && /\[CAJA_NO_ENCONTRADA\]/.test(r.err) && !LEAKS.test(r.err), `${ch}(${id}) of another user's session is "not found": ` + J(r));
      }
    }
    const list = await ipc(page, "api.cash.listSessions({page:1,pageSize:100})");
    expect(list.ok && list.v.rows.every((r) => r.id === V.sessionId) && list.v.total === 1, "IPC list is limited the same way");
    for (const bad of ["'abc'", "-1", "0", "1.5", "{}", "null", "true", "1e20"]) {
      const r = await ipc(page, `api.cash.getSessionSummary(${bad})`);
      expect(r.ok === false && /\[CAJA_INVALIDA\]/.test(r.err) && !LEAKS.test(r.err), `invalid id ${bad}: ` + J(r));
    }
    for (const q of ["{page:0}", "{pageSize:101}", "{status:'x'}", "{from:'2026-13-45'}", "'x'"]) {
      const r = await ipc(page, `api.cash.listSessions(${q})`);
      expect(r.ok === false && !LEAKS.test(r.err), `invalid query ${q} rejected cleanly: ` + J(r));
    }
    // while a session is OPEN, any signed-in user may see it (they already see its totals on the register screen)
    await ui.openCash(page, 5);
    const open = (await one("select id from cash_sessions where closed_at is null")).id;
    const mine = await ipc(page, `api.cash.getSessionSummary(${open})`);
    expect(mine.ok && mine.v.session.status === "open" && mine.v.closing.counted === null && mine.v.closing.difference === null, "the open session shows no closing figures");
    await ui.closeCash(page);
  });
  await test("CSH-11.admin_sees_every_session", "security", async () => {
    await ipc(page, "api.auth.logout()");
    await page.evaluate(() => sessionStorage.clear());
    await page.goto(APP_URL);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    const list = await ipc(page, "api.cash.listSessions({page:1,pageSize:100})");
    expect(list.ok && list.v.total === (await one("select count(*)::int n from cash_sessions")).n, "the administrator lists them all: " + (list.ok ? list.v.total : J(list)));
    const s = await summaryOf(A.sessionId);
    expect(s.sales.cash.total === "39.00" && s.sales.card.total === "40.00" && s.movements.manualIn.total === "50.00" && s.movements.manualOut.total === "30.00" && s.expected.reconciles === true && s.closing.difference === "0.00", "summary of session A as data: " + J(s));
  });
  await test("CSH-12.the_closed_session_survives_an_application_restart", "e2e", async () => {
    await c.app.close();
    relaunched = await launchApp(runDb, db, artifacts, {});
    page = relaunched.page;
    await page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 15000 });
    await ui.login(page, admin.pin);
    await page.waitForURL(/#\/dashboard$/, { timeout: 8000 });
    await openHistory();
    const d = await openSummary(C.sessionId);
    expect((await d.getByTestId("cs-difference").innerText()) === "-$4.25" && (await d.getByTestId("cs-expected").innerText()) === "$25.00", "same figures after the restart");
    await closeAll();
  });
  await test("CSH-13.the_current_register_flow_still_works_after_all_of_this", "e2e", async () => {
    const S = await shift({ initial: 30, cash: [[pA, 1]], counted: (e) => e });
    const r = await one("select status, final_amount from cash_sessions where id=$1", [S.sessionId]);
    expect(r.status === "closed" && num(r.final_amount) === 40, "closed normally: " + J(r));
    expect(S.stats.cash === "$10.00" && S.stats.card === "$0.00", "register screen totals: " + J(S.stats));
  });

  if (relaunched) {
    await relaunched.app.close().catch(() => {});
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(relaunched.userData, { recursive: true, force: true });
  }
  fs.rmSync(PRINT_DIR, { recursive: true, force: true });
  void signed;
  void money;
}
