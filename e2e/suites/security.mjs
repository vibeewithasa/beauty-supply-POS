// Security suite: authentication/authorization enforced by the Electron main process.
// Logins are done through the real login screen. Direct IPC calls are used ONLY to
// prove that unauthorized operations are rejected (never to fake a login).
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { ROOT, APP_URL, ui, ipc, unauthenticated, forbidden, denied, expect, waitFor } from "../lib/harness.mjs";

// The app has no multi-window feature, so a second window is created from the main process with the
// same hardened webPreferences and preload (window.open children do not receive the preload).
async function openSecondWindow(app) {
  const preload = path.join(ROOT, "dist/preload/preload.cjs");
  const [pop] = await Promise.all([
    app.waitForEvent("window"),
    app.evaluate(({ BrowserWindow }, a) => {
      const w = new BrowserWindow({ width: 900, height: 700, webPreferences: { preload: a.preload, contextIsolation: true, nodeIntegration: false } });
      w.loadURL(a.url);
    }, { preload, url: APP_URL + "/sales" }),
  ]);
  await pop.waitForLoadState("domcontentloaded");
  return pop;
}

const CALLS = {
  "products:getAll": "api.products.getAll()",
  "products:findBySkuOrBarcode": "api.products.findBySkuOrBarcode('x')",
  "products:create": "api.products.create({sku:'SEC-X',name:'x',price:'1',stock:1})",
  "products:update": "api.products.update(1,{name:'x'})",
  "products:softDelete": "api.products.softDelete(1,'x')",
  "cash:getActiveSession": "api.cash.getActiveSession()",
  "cash:openSession": "api.cash.openSession(1)",
  "cash:closeSession": "api.cash.closeSession(999999,1)",
  "cash:addMovement": "api.cash.addMovement({sessionId:999999,type:'IN',amount:1,reason:'x'})",
  "cash:getMovements": "api.cash.getMovements(999999)",
  "sales:create": "api.sales.create({items:[],total:0,paymentMethod:'cash',sessionId:null})",
  "sales:getAll": "api.sales.getAll()",
  "sales:getById": "api.sales.getById(999999)",
  "returns:create": "api.returns.create({saleId:999999,items:[],reason:'x'})",
  "returns:getAll": "api.returns.getAll()",
  "users:getAll": "api.users.getAll()",
  "users:create": "api.users.create({name:'SEC-X',role:'admin',pin:'1234'})",
  "users:update": "api.users.update(999999,{name:'x',role:'admin'})",
  "users:delete": "api.users.delete(999999)",
  "inventory:getMovements": "api.inventory.getMovements()",
  "inventory:addMovement": "api.inventory.addMovement({productId:999999,type:'IN',amount:1,reason:'x'})",
  "priceChanges:create": "api.priceChanges.create({productId:999999,oldPrice:1,newPrice:2,reason:'x'})",
  "priceChanges:getAll": "api.priceChanges.getAll()",
  "reports:getSalesByDateRange": "api.reports.getSalesByDateRange('2020-01-01','2035-01-01')",
  "reports:getDeletedProducts": "api.reports.getDeletedProducts()",
  "dashboard:getStats": "api.dashboard.getStats()",
};
const ADMIN_ONLY = [
  "products:create", "products:update", "products:softDelete", "users:getAll", "users:create", "users:update",
  "users:delete", "inventory:getMovements", "inventory:addMovement", "priceChanges:create", "priceChanges:getAll",
  "reports:getSalesByDateRange", "reports:getDeletedProducts", "dashboard:getStats",
];
const VENDOR_READS = [
  "products:getAll", "products:findBySkuOrBarcode", "cash:getActiveSession", "cash:getMovements", "sales:getAll",
  "sales:getById", "returns:getAll",
];

export async function run(c) {
  const { page, app, db, data, test } = c;
  const resetToLogin = async (p = page) => {
    await ipc(p, "api.auth.logout()");
    await p.evaluate(() => sessionStorage.clear()); // cleanup only; logins below are always visual
    await p.goto(APP_URL);
    await p.getByText("Ingresa tu PIN para comenzar").waitFor();
  };
  const me = async (p = page) => (await ipc(p, "api.auth.me()")).v;
  const userCount = async () => (await db.query("select count(*)::int n from users")).rows[0].n;

  const admin = await data.user("ADMIN", "admin");
  const vendor = await data.user("VENDOR", "vendor");
  const product = await data.product("SEC", 10, 5);

  // ---- A. unauthenticated ------------------------------------------------
  await test("A1.public_login_with_unknown_pin_returns_null", "security", async () => {
    const r = await ipc(page, `api.auth.login('${await data.newPin()}')`);
    expect(r.ok && r.v === null, JSON.stringify(r));
  });
  await test("A2.public_me_without_session_is_null", "security", async () => {
    expect((await me()) === null, "me() must be null before login");
  });
  await test("A3.all_26_protected_channels_rejected_without_session", "security", async () => {
    const before = await userCount();
    const leaks = [];
    for (const [ch, expr] of Object.entries(CALLS)) { const r = await ipc(page, expr); if (!unauthenticated(r)) leaks.push(`${ch}:${r.ok ? "ALLOWED" : r.err}`); }
    expect(leaks.length === 0, "not rejected as 'Sesión no válida': " + leaks.join(" | "));
    expect((await userCount()) === before, "no user created");
    return `${Object.keys(CALLS).length} channels rejected`;
  });

  // ---- B. vendor ---------------------------------------------------------
  await test("B1.vendor_visual_login", "security", async () => {
    await ui.login(page, vendor.pin);
    await page.waitForURL("**/sales", { timeout: 8000 });
    const m = await me();
    expect(m && m.id === vendor.id && m.role === "vendor", "main reports vendor session: " + JSON.stringify(m));
  });
  await test("B2.vendor_allowed_operations_work", "security", async () => {
    const bad = [];
    for (const ch of VENDOR_READS) { const r = await ipc(page, CALLS[ch]); if (!r.ok) bad.push(ch + ":" + r.err); }
    expect(bad.length === 0, bad.join(" | "));
  });
  await test("B3.vendor_rejected_on_all_14_admin_channels", "security", async () => {
    const before = await userCount();
    const leaks = [];
    for (const ch of ADMIN_ONLY) { const r = await ipc(page, CALLS[ch]); if (!forbidden(r)) leaks.push(`${ch}:${r.ok ? "ALLOWED" : r.err}`); }
    expect(leaks.length === 0, "vendor reached admin channels (or got a session error instead of 'No autorizado'): " + leaks.join(" | "));
    expect((await userCount()) === before, "user table unchanged");
    expect(new URL(page.url()).pathname === "/sales", "a role denial must NOT send the user to the login: " + page.url());
    expect((await me()) !== null, "session still alive after role denials");
  });
  await test("B4.vendor_cannot_create_admin_or_change_roles_or_delete_users", "security", async () => {
    const created = await ipc(page, "api.users.create({name:'E2E_SEC_ESCALATED',role:'admin',pin:'4321'})");
    const promoted = await ipc(page, `api.users.update(${vendor.id},{name:'x',role:'admin'})`);
    const demoted = await ipc(page, `api.users.update(${admin.id},{name:'x',role:'vendor'})`);
    const deleted = await ipc(page, `api.users.delete(${admin.id})`);
    expect([created, promoted, demoted, deleted].every(forbidden), "all four must be denied with 'No autorizado'");
    const rows = (await db.query("select id, role from users where id = any($1)", [[vendor.id, admin.id]])).rows;
    expect(rows.find((r) => r.id === vendor.id).role === "vendor" && rows.find((r) => r.id === admin.id).role === "admin", "roles unchanged");
    expect((await db.query("select count(*)::int n from users where name='E2E_SEC_ESCALATED'")).rows[0].n === 0, "no escalated user");
  });
  await test("B5.client_supplied_userId_is_ignored", "security", async () => {
    const s = await ipc(page, "api.cash.openSession(5)");
    expect(s.ok, "vendor opens cash: " + s.err);
    const sid = s.v.id;
    const mv = await ipc(page, `api.cash.addMovement({sessionId:${sid},type:'IN',amount:1,reason:'forged',userId:${admin.id},role:'admin'})`);
    const sale = await ipc(page, `api.sales.create({items:[{productId:${product.id},quantity:1,unitPrice:10,subtotal:10}],total:10,paymentMethod:'card',sessionId:${sid},userId:${admin.id}})`);
    expect(mv.ok && sale.ok, "operations should work");
    const u1 = (await db.query("select user_id from cash_movements where id=$1", [mv.v.id])).rows[0].user_id;
    const u2 = (await db.query("select user_id from sales where id=$1", [sale.v.id])).rows[0].user_id;
    expect(u1 === vendor.id && u2 === vendor.id, `recorded users ${u1}/${u2}, expected ${vendor.id}`);
    expect((await db.query("select opened_by from cash_sessions where id=$1", [sid])).rows[0].opened_by === vendor.id, "opened_by");
    await ipc(page, `api.cash.closeSession(${sid},0)`);
  });
  await test("B6.reload_keeps_vendor_privileges_unchanged", "security", async () => {
    await page.reload();
    await page.waitForURL("**/sales", { timeout: 8000 });
    const m = await me();
    expect(m && m.role === "vendor", "still vendor after reload");
    expect(forbidden(await ipc(page, CALLS["users:getAll"])), "users:getAll still denied");
  });
  await test("B7.url_navigation_to_admin_route_redirects_vendor", "security", async () => {
    await page.goto(APP_URL + "/users");
    await page.waitForURL("**/sales", { timeout: 8000 });
    expect((await me()).role === "vendor", "no escalation");
  });
  await test("B8.logout_invalidates_session_in_main", "security", async () => {
    await ui.logout(page);
    await page.getByText("Ingresa tu PIN para comenzar").waitFor();
    expect((await me()) === null, "me() null after logout");
    expect(unauthenticated(await ipc(page, CALLS["products:getAll"])), "products:getAll rejected after logout");
  });

  // ---- C. administrator --------------------------------------------------
  await test("C1.admin_visual_login", "security", async () => {
    await ui.login(page, admin.pin);
    await page.waitForURL("**/dashboard", { timeout: 8000 });
    expect((await me()).role === "admin", "admin session");
  });
  await test("C2.admin_operations_authorized", "security", async () => {
    const created = await ipc(page, "api.users.create({name:'E2E_SEC_VENDOR2',role:'vendor',pin:'" + (await data.newPin()) + "'})");
    expect(created.ok, "create vendor: " + created.err);
    const upd = await ipc(page, `api.users.update(${created.v.id},{name:'E2E_SEC_VENDOR2',role:'vendor'})`);
    const list = await ipc(page, "api.users.getAll()");
    const prod = await ipc(page, "api.products.create({sku:'E2E-SEC-NEW-" + c.runId + "',name:'x',price:'1.00',stock:1})");
    const dash = await ipc(page, "api.dashboard.getStats()");
    const rep = await ipc(page, "api.reports.getDeletedProducts()");
    const del = await ipc(page, `api.users.delete(${created.v.id})`);
    const bad = Object.entries({ upd, list, prod, dash, rep, del }).filter(([, r]) => !r.ok).map(([k, r]) => k + ":" + r.err);
    expect(bad.length === 0, bad.join(" | "));
  });
  await test("C3.admin_cannot_delete_own_account", "security", async () => {
    const r = await ipc(page, `api.users.delete(${admin.id})`);
    expect(r.ok === false, "must be rejected");
    expect((await db.query("select 1 from users where id=$1", [admin.id])).rowCount === 1, "admin still exists");
  });
  await test("C4.invalid_role_is_rejected", "security", async () => {
    const r = await ipc(page, "api.users.create({name:'E2E_SEC_BADROLE',role:'superuser',pin:'" + (await data.newPin()) + "'})");
    expect(r.ok === false, "invalid role must be rejected");
  });
  await test("C5.non_auth_errors_do_not_log_the_user_out", "security", async () => {
    const p = await data.product("C5", "5.00", 1);
    const r = await ipc(page, `api.products.softDelete(${p.id},'c5')`); // fails with a DB error (known BUG-2)
    expect(r.ok === false && !denied(r), "expected a non-auth failure: " + JSON.stringify(r));
    expect(new URL(page.url()).pathname === "/dashboard", "stays on the dashboard: " + page.url());
    expect((await me()) !== null, "session intact");
  });
  await ui.logout(page);
  await page.getByText("Ingresa tu PIN para comenzar").waitFor();

  // ---- D. inactive / revoked users --------------------------------------
  await test("D1.inactive_user_cannot_login_visual", "security", async () => {
    const inactive = await data.user("INACTIVE", "vendor", { active: false });
    await ui.login(page, inactive.pin);
    await page.getByText("PIN incorrecto").waitFor({ timeout: 5000 });
    expect((await me()) === null, "no session");
    const r = await ipc(page, `api.auth.login('${inactive.pin}')`);
    expect(r.ok && r.v === null, "api login also null");
  });
  await test("D2.deactivation_revokes_live_session_and_cannot_be_resurrected", "security", async () => {
    const u = await data.user("REVOKE", "admin");
    await resetToLogin();
    await ui.login(page, u.pin);
    await page.waitForURL("**/dashboard", { timeout: 8000 });
    await ui.nav(page, "Caja");
    await page.getByText("No hay sesión de caja abierta").waitFor();
    expect(!denied(await ipc(page, CALLS["products:getAll"])), "works before revocation");
    await db.query("update users set active=false where id=$1", [u.id]);
    // UI path first: the mounted cash screen performs a call, the main process answers 'Sesión no válida'
    // and the app must send the user to the login without a reload.
    await page.getByRole("button", { name: "Abrir Caja" }).click();
    const d = page.getByRole("dialog");
    await d.getByPlaceholder("Monto inicial").fill("10");
    await d.getByRole("button", { name: "Abrir Caja" }).click();
    await page.getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 8000 });
    expect((await db.query("select count(*)::int n from cash_sessions where opened_by=$1", [u.id])).rows[0].n === 0, "the revoked user opened no cash session");
    expect((await page.evaluate(() => sessionStorage.getItem("user"))) === null, "client cache cleared");
    expect(unauthenticated(await ipc(page, CALLS["products:getAll"])), "products:getAll rejected after deactivation");
    expect(unauthenticated(await ipc(page, CALLS["users:getAll"])), "users:getAll rejected after deactivation");
    expect((await me()) === null, "me() null");
    await db.query("update users set active=true where id=$1", [u.id]);
    expect((await me()) === null, "reactivating the account must not restore the revoked session");
    expect(unauthenticated(await ipc(page, CALLS["products:getAll"])), "still no session after reactivation");
  });
  await test("D3.role_downgrade_applies_immediately", "security", async () => {
    const u = await data.user("DOWNGRADE", "admin");
    await resetToLogin();
    await ui.login(page, u.pin);
    await page.waitForURL("**/dashboard", { timeout: 8000 });
    expect(!denied(await ipc(page, CALLS["users:getAll"])), "admin before");
    await db.query("update users set role='vendor' where id=$1", [u.id]);
    expect(forbidden(await ipc(page, CALLS["users:getAll"])), "users:getAll 'No autorizado' after downgrade");
    expect(!denied(await ipc(page, CALLS["products:getAll"])), "vendor-level access remains");
    await page.getByRole("link", { name: "Usuarios", exact: true }).click({ noWaitAfter: true, timeout: 8000 }); // stale admin link; the route guard asks the main process
    await page.waitForURL("**/sales", { timeout: 8000 });
    expect((await me()).role === "vendor", "downgraded user keeps a (vendor) session: a role change is not a login loss");
  });
  await test("D4.deleted_user_loses_session", "security", async () => {
    const u = await data.user("DELETED", "admin");
    await resetToLogin();
    await ui.login(page, u.pin);
    await page.waitForURL("**/dashboard", { timeout: 8000 });
    await db.query("delete from users where id=$1", [u.id]);
    expect(unauthenticated(await ipc(page, CALLS["products:getAll"])), "rejected after row deleted");
  });

  // ---- E. window/session scoping ----------------------------------------
  await test("E1.second_window_is_not_authorized_by_first", "security", async () => {
    const v = await data.user("WIN1", "vendor");
    await resetToLogin();
    await ui.login(page, v.pin);
    await page.waitForURL("**/sales", { timeout: 8000 });
    const pop = await openSecondWindow(app);
    c.watch(pop);
    const hasApi = await waitFor(async () => pop.evaluate(() => !!window.api), 8000);
    expect(hasApi, "popup has the preload API (same hardened webPreferences)");
    expect((await me(pop)) === null, "popup me() must be null (the main-process session belongs to the first window only)");
    expect(unauthenticated(await ipc(pop, CALLS["products:getAll"])), "popup IPC rejected");
    const left = await waitFor(async () => !new URL(pop.url()).pathname.startsWith("/sales"), 8000);
    expect(left, "popup UI is sent to login: " + pop.url());
    // second window logs in as another user; the first window must be unaffected
    const a = await data.user("WIN2ADMIN", "admin");
    await ui.login(pop, a.pin);
    await pop.waitForURL("**/dashboard", { timeout: 8000 });
    expect((await me(pop)).role === "admin", "popup is admin");
    expect((await me()).id === v.id, "first window is still the vendor");
    expect(forbidden(await ipc(page, CALLS["users:getAll"])), "first window still denied");
    expect(!denied(await ipc(pop, CALLS["users:getAll"])), "popup allowed");
    await pop.close();
    const pop2 = await openSecondWindow(app);
    await waitFor(async () => pop2.evaluate(() => !!window.api), 8000);
    expect((await me(pop2)) === null, "a window opened after another one closed starts unauthenticated");
    await pop2.close();
  });

  // ---- F. origin / frame / surface -------------------------------------
  const pageApi = (p) => p.evaluate(() => typeof window.api);
  await test("F1.api_surface_is_the_expected_closed_set", "security", async () => {
    await resetToLogin();
    const r = await page.evaluate(() => ({
      top: Object.keys(window.api).sort(), auth: Object.keys(window.api.auth).sort(),
      raw: [typeof window.ipcRenderer, typeof window.require, typeof window.process, typeof window.electron],
    }));
    expect(JSON.stringify(r.top) === JSON.stringify(["auth", "cash", "dashboard", "inventory", "priceChanges", "products", "reports", "returns", "sales", "users"]), "top-level api: " + r.top);
    expect(JSON.stringify(r.auth) === JSON.stringify(["login", "logout", "me"]), "auth api: " + r.auth);
    expect(r.raw.every((t) => t === "undefined"), "raw Electron/Node globals exposed: " + r.raw);
  });
  await test("F2.iframe_gets_no_api", "security", async () => {
    const v = await data.user("IFRAME", "vendor");
    await ui.login(page, v.pin);
    await page.waitForURL("**/sales", { timeout: 8000 });
    const t = await page.evaluate(() => new Promise((resolve) => {
      const f = document.createElement("iframe");
      f.src = "http://localhost:5173/";
      f.onload = () => resolve(typeof f.contentWindow.api);
      document.body.appendChild(f);
    }));
    expect(t === "undefined", "the preload API must not be injected into subframes, got " + t);
    return "same-origin iframe has no window.api; the main-frame check itself is covered by unit tests (sender-guard)";
  });
  const foreign = http.createServer((q, s) => { s.setHeader("content-type", "text/html"); s.end("<html><body>foreign page</body></html>"); });
  await new Promise((r) => foreign.listen(0, "localhost", r));
  const fport = foreign.address().port;
  const tmpHtml = path.join(os.tmpdir(), `e2e-foreign-${c.runId}.html`);
  fs.writeFileSync(tmpHtml, "<html><body>local file</body></html>");
  for (const [label, url] of [["localhost_other_port", `http://localhost:${fport}/`], ["arbitrary_file_url", pathToFileURL(tmpHtml).href]]) {
    await test(`F3.untrusted_origin_cannot_call_even_with_a_live_session::${label}`, "security", async () => {
      await resetToLogin();
      const v = await data.user("ORIGIN_" + label.slice(0, 5), "admin");
      await ui.login(page, v.pin);
      await page.waitForURL("**/dashboard", { timeout: 8000 });
      expect(!denied(await ipc(page, CALLS["users:getAll"])), "admin session works on the app origin");
      await page.goto(url); // same window, same main-process session, foreign document (the preload still runs there)
      expect((await pageApi(page)) === "object", "precondition: the preload runs on the foreign page");
      const attempts = { me: await ipc(page, "api.auth.me()"), logout: await ipc(page, "api.auth.logout()"), users: await ipc(page, CALLS["users:getAll"]), products: await ipc(page, CALLS["products:getAll"]), login: await ipc(page, "api.auth.login('" + v.pin + "')") };
      const leaked = Object.entries(attempts).filter(([, r]) => !forbidden(r)).map(([k, r]) => k + ":" + (r.ok ? "ALLOWED" : r.err));
      expect(leaked.length === 0, "foreign origin reached IPC: " + leaked.join(" | "));
      await page.goto(APP_URL);
      expect((await me()) === null, "leaving the app origin dropped the session (no resurrection on return)");
    });
  }
  foreign.close();
  fs.rmSync(tmpHtml, { force: true });
  await test("F4.forged_client_storage_does_not_grant_privileges", "security", async () => {
    await resetToLogin();
    const v = await data.user("FORGE", "vendor");
    await ui.login(page, v.pin);
    await page.waitForURL("**/sales", { timeout: 8000 });
    // tampering attempt (not a login): pretend to be an admin in the client-side cache
    await page.evaluate(() => sessionStorage.setItem("user", JSON.stringify({ id: 1, name: "forged", role: "admin" })));
    expect(forbidden(await ipc(page, CALLS["users:getAll"])), "main ignores the forged cache");
    await page.goto(APP_URL + "/users");
    await page.waitForURL("**/sales", { timeout: 8000 });
    const cached = await page.evaluate(() => JSON.parse(sessionStorage.getItem("user") || "{}"));
    expect(cached.role === "vendor" && cached.name === v.name, "route guard overwrote the forged cache with the main-process identity: " + JSON.stringify(cached));
  });
  await resetToLogin().catch(() => {});
}
