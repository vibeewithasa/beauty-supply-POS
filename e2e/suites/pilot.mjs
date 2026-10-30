// Pilot suite (Sprint 06, block C): one complete day of Estética Leal on a BRAND NEW database, driven through the real window the
// way the store would do it, with every number checked in PostgreSQL:
//   prepare the database -> first-run setup (connection stored protected, first administrator) -> store data -> vendor ->
//   products and inventory -> open the register -> cash and card sales -> history and reprint -> partial return refunded in cash
//   with the administrator PIN -> return refunded by card (done on the terminal, simulated here: the system performs no bank
//   operation) -> reports and reconciliation -> register summary -> close -> restart -> backup -> restore into a new database -> compare.
// Plus the visual review of the main screens at 1024x768 (navigation, forms, modals, validation, touch targets, Pagar visible,
// destructive confirmations, 80/58 mm tickets, reprint, administrator PIN, error states, register flow).
// It never touches any pre-existing database: it creates its own (and a restored copy) and removes them at the end. No physical
// printer, barcode reader or touch screen is involved: printing goes through the development-only PDF automation of the main process.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { ui, ipc, expect, launchApp, createRunDb, prepareRunDb, dropRunDb, connectRunDb, urlFor, sleep, waitFor, containsSecret } from "../lib/harness.mjs";
import { createRuntimeRole, dropRuntimeRole, inspectDatabase, withClient, urlWithDatabase } from "../../scripts/lib/db-ops.mjs";

const PRINT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pos-pilot-print-"));
const MODE_FILE = path.join(PRINT_DIR, "mode.txt");
fs.writeFileSync(MODE_FILE, "pdf");
export const env = { POS_USE_CONFIG_FILE: "1", POS_SETUP_NO_RELAUNCH: "1", POS_PRINT_MODE_FILE: MODE_FILE, POS_PRINT_PDF_DIR: PRINT_DIR };

const J = JSON.stringify;
const num = (v) => Number(v);
const money = (v) => num(v).toFixed(2);

export async function run(c) {
  const { test, artifacts } = c;
  const dirs = [PRINT_DIR];
  const dbs = [];
  const restoredDbs = [];
  const roles = [];
  const apps = [];
  const mkTmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
  const pdfWidthMm = (file) => {
    const t = fs.readFileSync(file).toString("latin1");
    const m = /\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(t);
    return m ? (Number(m[1]) / 72) * 25.4 : null;
  };
  const server = new URL(urlFor("postgres"));
  const SERVER = { host: server.hostname, port: server.port || "5432" };
  const secrets = [decodeURIComponent(server.password)];

  // ---- what the store would type
  const ADMIN = { name: "Dueña Estética Leal", pin: crypto.randomInt(0, 10 ** 7).toString().padStart(7, "0") };
  const VENDOR = { name: "Vendedora Mostrador", pin: crypto.randomInt(0, 10 ** 6).toString().padStart(6, "0") };
  if (ADMIN.pin === VENDOR.pin) VENDOR.pin = "908172";
  secrets.push(ADMIN.pin, VENDOR.pin);
  const PRODUCTS = [
    { sku: "PIL-SHA-500", name: "Shampoo Reparador 500 ml", price: "120.00", stock: 20 },
    { sku: "PIL-TIN-71", name: "Tinte Rubio 7.1", price: "85.50", stock: 15 },
    { sku: "PIL-CEP-01", name: "Cepillo Térmico", price: "45.00", stock: 10 },
    { sku: "PIL-GEL-250", name: "Gel Fijador 250 ml", price: "30.00", stock: 12 },
  ];

  let pilotDb, owner, db, userData, L, roleName, rolePassword, restoredDb, backupDir, secondDir;
  const one = async (sql, p) => (await db.query(sql, p)).rows[0];
  const rows = async (sql, p) => (await db.query(sql, p)).rows;
  const P = () => L.page;
  const call = (expr) => ipc(P(), expr);
  const toast = (re) => P().getByText(re).first().waitFor({ timeout: 8000 });
  const closeAll = async () => { for (let i = 0; i < 5; i++) { if ((await P().getByRole("dialog").count()) + (await P().getByRole("alertdialog").count()) === 0) return; await P().keyboard.press("Escape"); await P().waitForTimeout(350); } };
  const signIn = async (pin, landing) => {
    await P().getByText("Ingresa tu PIN para comenzar").waitFor({ timeout: 15000 });
    await ui.login(P(), pin);
    await P().waitForURL(landing, { timeout: 15000 });
  };
  const signOut = async () => { await ui.logout(P()); await P().getByText("Ingresa tu PIN para comenzar").waitFor(); };
  const resize = async (w, h) => {
    await L.app.evaluate(({ BrowserWindow }, s) => { BrowserWindow.getAllWindows()[0].setContentSize(s[0], s[1]); }, [w, h]);
    await P().waitForFunction((s) => Math.abs(window.innerWidth - s[0]) <= 2 && Math.abs(window.innerHeight - s[1]) <= 2, [w, h], { timeout: 5000 }).catch(() => {});
    await P().waitForTimeout(200);
  };
  const startApp = async (extra = {}) => {
    L = await launchApp(pilotDb, db, artifacts, { ...env, ...extra }, { userData, noDatabaseUrl: true });
    apps.push(L.app);
    return L;
  };
  const stopApp = async () => { await L.app.close().catch(() => {}); await sleep(700); };
  const shot = (name) => (L ? P().screenshot({ path: path.join(artifacts, `pilot-${name}.png`) }).catch(() => {}) : Promise.resolve());
  // a failing step leaves a screenshot of the PILOT window (the recorder only knows the harness window)
  const T = (id, kind, fn) => test(id, kind, async () => { try { return await fn(); } catch (e) { await shot("FAIL-" + id.split(".")[0]); throw e; } });
  const snapshot = async (name) => {
    const d = await withClient(urlWithDatabase(urlFor("x"), name), (cl) => inspectDatabase(cl, { rows: true }), "e2e_pilot_inspect");
    return d;
  };
  const figures = async (client) => {
    const q = async (sql) => (await client.query(sql)).rows[0];
    return {
      sales: await q("select count(*)::int n, coalesce(sum(total),0)::text t from sales"),
      cashSales: await q("select coalesce(sum(total),0)::text t from sales where payment_method='cash'"),
      cardSales: await q("select coalesce(sum(total),0)::text t from sales where payment_method='card'"),
      refunds: await q("select count(*)::int n, coalesce(sum(amount),0)::text t, coalesce(sum(amount) filter (where payment_method='cash'),0)::text cash, coalesce(sum(amount) filter (where payment_method='card'),0)::text card from refund_settlements"),
      register: await q("select initial_amount::text i, current_amount::text c, final_amount::text f, status from cash_sessions order by id desc limit 1"),
      stock: (await client.query("select sku, stock from products where sku like 'PIL-%' and sku not like 'PIL-REL-%' order by sku")).rows,
      returns: (await client.query("select refund_status s, count(*)::int n from returns group by 1 order by 1")).rows,
    };
  };

  const cleanup = async () => {
    for (const a of apps) await a.close().catch(() => {});
    try { await db?.end(); } catch { /* closed */ }
    for (const r of roles) await dropRuntimeRole(urlFor("postgres"), r).catch(() => {});
    for (const d of dbs) await dropRunDb(d).catch(() => {});
    for (const d of restoredDbs) {
      if (/^beauty_pos_e2e_pilotrestore[0-9a-f]{6}$/.test(d)) await withClient(urlWithDatabase(urlFor("x"), "postgres"), (a) => a.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`), "e2e_pilot_cleanup").catch(() => {});
    }
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  };

  try {
    // ================================================================== 1. the database
    await T("PIL-01.a_new_database_is_prepared_explicitly_and_starts_empty", "integration", async () => {
      pilotDb = await createRunDb();
      dbs.push(pilotDb);
      await prepareRunDb(pilotDb); // the explicit migration step (the application never migrates)
      owner = urlFor(pilotDb);
      db = await connectRunDb(pilotDb);
      const journal = JSON.parse(fs.readFileSync(path.join(process.cwd(), "drizzle/meta/_journal.json"), "utf8")).entries.length;
      expect((await one("select count(*)::int n from drizzle.__drizzle_migrations")).n === journal, `all ${journal} migrations applied by the explicit step`);
      expect((await one("select (select count(*) from users)::int u, (select count(*) from products)::int p, (select count(*) from sales)::int s")).u === 0, "no users, products or sales yet");
      expect((await one("select name from business_settings")).name === "Estética Leal", "the commercial settings start with the store name only");
      roleName = "pos_pilot_" + crypto.randomBytes(3).toString("hex");
      rolePassword = crypto.randomBytes(12).toString("base64url");
      secrets.push(rolePassword);
      await createRuntimeRole(owner, { role: roleName, password: rolePassword, database: pilotDb });
      roles.push(roleName);
      userData = mkTmp("pos-pilot-ud-");
    });

    // ================================================================== 2. first run: connection and administrator
    await T("PIL-02.first_run_setup_stores_the_connection_protected_and_creates_the_first_administrator", "e2e", async () => {
      const l = await launchApp(pilotDb, db, artifacts, env, { userData, noDatabaseUrl: true, raw: true });
      apps.push(l.app);
      const p = l.page;
      await p.getByRole("heading", { name: "Falta la configuración de la base de datos" }).waitFor({ timeout: 15000 });
      for (const [id, v] of Object.entries({ host: SERVER.host, port: SERVER.port, database: pilotDb, user: roleName, password: rolePassword })) await p.locator("#" + id).fill(v);
      await p.locator("#btn-test").click();
      await p.getByText(/Esquema al día/).waitFor({ timeout: 15000 });
      expect((await p.locator("#checks").innerText()).includes("No hay administradores"), "the setup says there is no administrator");
      await p.locator("#admin-name").fill(ADMIN.name);
      await p.locator("#admin-pin").fill(ADMIN.pin);
      await p.locator("#admin-pin2").fill(ADMIN.pin);
      await p.locator("#btn-admin").click();
      await p.getByText("Administrador creado").waitFor({ timeout: 10000 });
      const exited = new Promise((resolve) => l.app.process().once("exit", resolve));
      await p.locator("#btn-save").click();
      await Promise.race([exited, sleep(15000)]);
      const cfg = JSON.parse(fs.readFileSync(path.join(userData, "config.json"), "utf8"));
      expect(cfg.version === 2 && cfg.passwordEncrypted && !secrets.some((s) => JSON.stringify(cfg).includes(s)), "config.json holds the password protected by Windows");
      const u = await rows("select name, role, active, pin_hash from users");
      expect(u.length === 1 && u[0].role === "admin" && /^scrypt\$/.test(u[0].pin_hash), "one administrator with a salted hash");
      expect(!l.mainLog.some((x) => secrets.some((s) => x.includes(s)) || containsSecret(x)), "no secret in the log");
    });

    await T("PIL-03.the_application_starts_from_the_protected_configuration_and_the_administrator_signs_in", "e2e", async () => {
      await startApp();
      await signIn(ADMIN.pin, /#\/dashboard$/);
      await P().getByText("Dashboard").first().waitFor();
      const who = await one("select distinct usename from pg_stat_activity where datname=$1 and usename=$2", [pilotDb, roleName]);
      expect(who && who.usename === roleName, "the application works with the minimum-privilege role");
      await shot("dashboard-empty");
    });

    // ================================================================== 3. store data, users, catalog, stock
    await T("PIL-04.store_data_is_configured_from_the_settings_screen", "e2e", async () => {
      await ui.nav(P(), "Configuración");
      await P().waitForFunction(() => document.querySelector("#bs-name")?.value === "Estética Leal", null, { timeout: 8000 });
      await P().locator("#bs-address").fill("Av. Reforma 100\nCol. Centro, CDMX");
      await P().locator("#bs-phone").fill("55 1234 5678");
      await P().locator("#bs-whatsapp").fill("+52 55 8765 4321");
      await P().locator("#bs-footer").fill("¡Gracias por visitar Estética Leal!");
      await P().locator("#bs-policy").fill("Cambios dentro de 7 días con ticket.");
      await P().getByRole("button", { name: "Guardar configuración" }).click();
      await toast(/Configuración guardada/);
      const s = await one("select * from business_settings");
      expect(s.name === "Estética Leal" && s.phone === "55 1234 5678" && s.paper_width === "80" && s.updated_by !== null, "persisted: " + J({ name: s.name, phone: s.phone }));
    });

    await T("PIL-05.the_vendor_is_created_from_the_users_screen_with_validation", "e2e", async () => {
      await ui.nav(P(), "Usuarios");
      await P().getByRole("heading", { name: "Gestión de Usuarios" }).waitFor();
      await P().getByRole("button", { name: "Nuevo Usuario" }).click();
      const d = P().getByRole("dialog");
      await d.getByPlaceholder("Nombre completo...").fill(VENDOR.name);
      await d.getByRole("button", { name: "Crear Usuario" }).click();
      await P().getByText("El PIN es obligatorio al crear un usuario").waitFor();
      await d.getByLabel("PIN", { exact: true }).fill("1234");
      await d.getByRole("button", { name: "Crear Usuario" }).click();
      await P().getByText("El PIN debe tener de 6 a 8 dígitos").first().waitFor();
      await d.getByLabel("PIN", { exact: true }).fill(VENDOR.pin);
      await d.getByRole("button", { name: "Vendedor" }).click();
      await d.getByRole("button", { name: "Crear Usuario" }).click();
      await P().getByText("Usuario creado exitosamente").waitFor();
      const v = await one("select role, active, pin_hash from users where name=$1", [VENDOR.name]);
      expect(v && v.role === "vendor" && v.active && /^scrypt\$/.test(v.pin_hash), "vendor persisted with a salted hash");
    });

    await T("PIL-06.products_are_created_with_initial_price_and_stock_and_bad_data_is_refused", "e2e", async () => {
      await ui.nav(P(), "Productos");
      await P().getByRole("heading", { name: "Gestión de Productos" }).waitFor();
      // validation first
      await P().getByRole("button", { name: "Nuevo Producto" }).click();
      let d = P().getByRole("dialog");
      await d.getByLabel("SKU", { exact: true }).fill(PRODUCTS[0].sku);
      await d.getByLabel("Nombre", { exact: true }).fill(PRODUCTS[0].name);
      await d.getByLabel("Precio inicial").fill("-5");
      await d.getByRole("button", { name: "Crear producto" }).click();
      await toast(/importe válido/);
      await P().keyboard.press("Escape");
      for (const p of PRODUCTS) {
        await P().getByRole("button", { name: "Nuevo Producto" }).click();
        d = P().getByRole("dialog");
        await d.getByLabel("SKU", { exact: true }).fill(p.sku);
        await d.getByLabel("Nombre", { exact: true }).fill(p.name);
        await d.getByLabel("Categoría").fill("Piloto");
        await d.getByLabel("Precio inicial").fill(p.price);
        await d.getByLabel("Stock inicial").fill(String(p.stock));
        await d.getByRole("button", { name: "Crear producto" }).click();
        await toast(/Producto creado/);
        await P().getByRole("row", { name: new RegExp(p.sku) }).waitFor();
      }
      // a duplicate SKU is refused
      await P().getByRole("button", { name: "Nuevo Producto" }).click();
      d = P().getByRole("dialog");
      await d.getByLabel("SKU", { exact: true }).fill(PRODUCTS[0].sku);
      await d.getByLabel("Nombre", { exact: true }).fill("Duplicado");
      await d.getByLabel("Precio inicial").fill("1.00");
      await d.getByRole("button", { name: "Crear producto" }).click();
      await toast(/SKU|existe|duplicad/i);
      await P().keyboard.press("Escape");
      const got = await rows("select sku, price::text, stock from products where sku like 'PIL-%' order by sku");
      expect(got.length === 4 && PRODUCTS.every((p) => got.some((g) => g.sku === p.sku && money(g.price) === p.price && g.stock === p.stock)), "four products persisted with their prices and initial stock: " + J(got));
    });

    await T("PIL-07.stock_entries_are_registered_from_the_receive_screen", "e2e", async () => {
      await ui.nav(P(), "Recepción");
      await P().getByLabel("Buscar producto").fill(PRODUCTS[0].sku);
      await P().getByRole("button", { name: `Seleccionar ${PRODUCTS[0].name}` }).click();
      await P().getByLabel("Tipo de movimiento").selectOption("IN");
      await P().getByLabel("Cantidad", { exact: true }).fill("10");
      await P().getByLabel("Motivo", { exact: true }).fill("Recepción de proveedor (piloto)");
      await P().getByRole("button", { name: "Registrar movimiento" }).click();
      await P().getByTestId("movement-result").getByText(/Stock persistido: 30/).waitFor();
      expect((await one("select stock from products where sku=$1", [PRODUCTS[0].sku])).stock === 30, "20 initial + 10 received = 30");
      expect((await one("select count(*)::int n from inventory_movements where reason like 'Recepción de proveedor%'")).n === 1, "one inventory movement");
    });

    // ================================================================== 4. register and sales (the vendor)
    await T("PIL-08.the_vendor_opens_the_register_and_a_second_opening_is_refused", "e2e", async () => {
      await signOut();
      await signIn(VENDOR.pin, /#\/sales$/);
      await ui.openCash(P(), "500.00");
      expect(num((await one("select initial_amount, current_amount from cash_sessions where closed_at is null")).current_amount) === 500, "register opened with 500.00");
      const again = await call("api.cash.openSession(10)");
      expect(again.ok === false && /\[CAJA_YA_ABIERTA\]/.test(again.err), "a second register cannot be opened: " + J(again));
    });

    await T("PIL-09.a_cash_sale_and_a_card_sale_are_completed_through_the_sales_screen", "e2e", async () => {
      await ui.sell(P(), { query: PRODUCTS[0].sku, name: PRODUCTS[0].name, qty: 2, method: "cash" }); // 240.00 cash
      await ui.sell(P(), { query: PRODUCTS[1].sku, name: PRODUCTS[1].name, qty: 2, method: "card" }); // 171.00 card
      await ui.sell(P(), { query: PRODUCTS[2].sku, name: PRODUCTS[2].name, qty: 1, method: "cash" }); //  45.00 cash
      const s = await rows("select id, total::text, payment_method, user_id from sales order by id");
      expect(s.length === 3 && s.map((x) => money(x.total)).join() === "240.00,171.00,45.00" && s.map((x) => x.payment_method).join() === "cash,card,cash", "three sales with server-side totals: " + J(s));
      const reg = await one("select current_amount::text c from cash_sessions where closed_at is null");
      expect(money(reg.c) === "785.00", "cash 500.00 + 240.00 + 45.00 = 785.00; the card sale never touches it: " + reg.c);
      expect((await one("select stock from products where sku=$1", [PRODUCTS[0].sku])).stock === 28, "stock follows the sales");
    });

    await T("PIL-10.pagar_stays_visible_with_a_long_cart_and_destroying_the_cart_needs_a_confirmation", "e2e", async () => {
      await resize(1024, 768);
      const FILL = "ABCDEFGHIJKLMN".split("");
      for (const k of FILL) await db.query("insert into products(sku,name,price,stock,category) values($1,$2,'1.00',100,'Relleno') on conflict do nothing", [`PIL-REL-${k}`, `Relleno de prueba ${k}`]);
      await ui.nav(P(), "Vender");
      await P().reload(); // the sales screen reads the catalogue when it opens: products added behind its back need a reload
      const search = P().getByPlaceholder("Código, SKU o nombre...");
      for (const k of FILL) {
        await search.fill(`PIL-REL-${k}`);
        await P().getByRole("option", { name: new RegExp(`Relleno de prueba ${k}`) }).first().click();
      }
      await P().getByText("Carrito (14 artículos)").waitFor();
      const pay = P().getByRole("button", { name: "Pagar" });
      await pay.waitFor();
      const geo = await pay.evaluate((b) => { const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return { inView: r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth, covered: !(top === b || b.contains(top)), h: Math.round(r.height), w: Math.round(r.width) }; });
      expect(geo.inView && !geo.covered, "Pagar is fully visible and uncovered at 1024x768 with 14 lines: " + J(geo));
      expect(geo.h >= 44, "Pagar is a comfortable touch target: " + geo.h + " px high");
      await shot("sales-long-cart-1024");
      // destroying the cart asks first; cancelling keeps it
      await P().getByRole("button", { name: "Limpiar", exact: true }).click();
      const dlg = P().getByRole("alertdialog");
      await dlg.getByRole("button", { name: "Cancelar" }).click();
      await dlg.waitFor({ state: "hidden" });
      await P().getByText("Carrito (14 artículos)").waitFor();
      await P().getByRole("button", { name: "Limpiar", exact: true }).click();
      await dlg.getByRole("button", { name: "Limpiar carrito" }).click();
      await P().getByText("Carrito vacío").waitFor();
      expect((await one("select count(*)::int n from sales")).n === 3, "nothing was sold by this");
    });

    await T("PIL-11.the_sales_history_lists_the_day_and_a_ticket_is_reprinted_as_a_copy", "e2e", async () => {
      await ui.nav(P(), "Historial");
      const table = P().getByRole("table", { name: "Ventas" });
      await table.waitFor();
      await waitFor(async () => (await table.locator("tbody tr").count()) === 3, 8000);
      expect((await table.locator("tbody tr").count()) === 3, "the three sales of the day are listed");
      const first = (await one("select id from sales order by id limit 1")).id;
      await P().getByRole("button", { name: `Ver venta ${first}`, exact: true }).click();
      await P().getByRole("dialog").getByText(`Venta #${first}`).first().waitFor();
      await P().getByRole("dialog").getByRole("button", { name: "Reimprimir" }).click();
      const frame = P().frameLocator('iframe[title="Vista previa del recibo"]');
      await frame.getByText("ESTÉTICA LEAL").first().waitFor({ timeout: 10000 });
      await frame.getByText("REIMPRESIÓN").waitFor();
      await frame.getByText("Shampoo Reparador 500 ml").waitFor();
      await frame.getByText("No es una factura fiscal").waitFor();
      const before = (await one("select (select count(*) from sales)::int s, (select count(*) from cash_movements)::int c")).s;
      await P().getByRole("dialog").filter({ hasText: `Recibo de la venta #${first}` }).getByRole("button", { name: "Imprimir" }).click();
      await P().getByTestId("print-status").getByText(/Recibo enviado a imprimir/).waitFor({ timeout: 15000 });
      const pdf = path.join(PRINT_DIR, `receipt-${first}-copy-80mm.pdf`);
      const files = fs.readdirSync(PRINT_DIR).filter((f) => f.endsWith(".pdf"));
      expect(files.length >= 1, "a PDF of the real print document was produced: " + files.join());
      const w = pdfWidthMm(path.join(PRINT_DIR, files[0]));
      expect(w && Math.abs(w - 80) < 2.5, "80 mm paper: " + w);
      expect((await one("select count(*)::int n from sales")).n === before, "reprinting wrote nothing");
      void pdf;
      await closeAll();
    });

    await T("PIL-12.manual_cash_in_and_out_are_registered_apart_from_sales", "e2e", async () => {
      await ui.nav(P(), "Caja");
      await P().getByText("Abierta", { exact: true }).waitFor();
      await ui.cashMovement(P(), "Ingreso", 100, "Cambio adicional del banco (piloto)");
      await ui.cashMovement(P(), "Retiro", 50, "Pago a proveedor de limpieza (piloto)");
      const reg = await one("select current_amount::text c from cash_sessions where closed_at is null");
      expect(money(reg.c) === "835.00", "785.00 + 100.00 - 50.00 = 835.00: " + reg.c);
    });

    // ================================================================== 5. refunds (vendor prepares, administrator authorizes)
    const authorizeWith = async (pin, label = "Autorizar y registrar") => {
      await P().locator("#rf-admin-pin").waitFor();
      await P().locator("#rf-admin-pin").fill(pin);
      await P().getByRole("button", { name: label, exact: true }).click();
    };
    const lookup = async (saleId) => {
      await ui.nav(P(), "Devoluciones");
      await P().reload();
      await P().getByLabel("Número de venta").waitFor();
      await P().getByLabel("Número de venta").fill(String(saleId));
      await P().getByRole("button", { name: "Buscar venta" }).click();
      await P().getByRole("heading", { name: `Venta #${saleId}` }).waitFor();
    };
    await T("PIL-13.partial_return_refunded_in_cash_with_the_administrator_pin", "e2e", async () => {
      const s1 = (await one("select id from sales order by id limit 1")).id;
      await lookup(s1);
      await P().getByLabel(`Cantidad a devolver de ${PRODUCTS[0].name}`).fill("1");
      await P().getByLabel("Motivo", { exact: true }).fill("Cliente prefiere otra presentación");
      expect((await P().getByTestId("refund-preview").innerText()) === "$120.00", "calculated total");
      await P().locator("#rf-method-cash").click();
      await P().locator("#rf-confirm").check();
      await P().getByRole("button", { name: "Confirmar devolución y reembolso" }).click();
      // the wrong PIN is refused inline, the vendor's own PIN too
      await authorizeWith("73910462");
      await P().getByTestId("rf-auth-error").waitFor();
      await authorizeWith(VENDOR.pin);
      await P().getByTestId("rf-auth-error").waitFor();
      await authorizeWith(ADMIN.pin);
      await P().getByTestId("return-result").getByText(/PAGADO EN EFECTIVO/).waitFor({ timeout: 10000 });
      const st = await one("select s.payment_method m, s.amount::text a, s.authorized_by, s.processed_by from refund_settlements s join returns r on r.id=s.return_id where r.sale_id=$1", [s1]);
      const ids = Object.fromEntries((await rows("select name, id from users")).map((u) => [u.name, u.id]));
      expect(st.m === "cash" && money(st.a) === "120.00" && st.authorized_by === ids[ADMIN.name] && st.processed_by === ids[VENDOR.name], "cash refund authorized by the administrator, attended by the vendor: " + J(st));
      expect((await call("api.auth.me()")).v.name === VENDOR.name, "the vendor's session is still the vendor's");
      expect(money((await one("select current_amount::text c from cash_sessions where closed_at is null")).c) === "715.00", "835.00 - 120.00 = 715.00");
      expect((await one("select stock from products where sku=$1", [PRODUCTS[0].sku])).stock === 29, "the returned unit is back in stock");
    });

    await T("PIL-14.return_refunded_by_card_after_confirming_the_terminal_refund_without_any_bank_operation", "e2e", async () => {
      const s2 = (await one("select id from sales where payment_method='card'")).id;
      await lookup(s2);
      await P().getByLabel(`Cantidad a devolver de ${PRODUCTS[1].name}`).fill("1");
      await P().getByLabel("Motivo", { exact: true }).fill("Tono no deseado");
      await P().locator("#rf-method-card").click();
      expect(await P().getByRole("button", { name: "Confirmar devolución y reembolso" }).isDisabled(), "without confirming the terminal refund the button stays disabled");
      await P().locator("#rf-reference").fill("TERM-PILOTO-001");
      await P().locator("#rf-confirm").check();
      const sentence = await P().locator("label[for=rf-confirm]").innerText();
      expect(/ya se realizó en la terminal de tarjeta/.test(sentence) && /no ejecuta operaciones bancarias/.test(await P().locator("body").innerText()), "the screen says the refund was already done on the terminal and that the POS performs no bank operation");
      await P().getByRole("button", { name: "Confirmar devolución y reembolso" }).click();
      await authorizeWith(ADMIN.pin);
      await P().getByTestId("return-result").getByText(/PAGADO POR TARJETA/).waitFor({ timeout: 10000 });
      const st = await one("select s.payment_method m, s.amount::text a, s.external_reference r, s.cash_movement_id from refund_settlements s join returns r on r.id=s.return_id where r.sale_id=$1", [s2]);
      expect(st.m === "card" && money(st.a) === "85.50" && st.r === "TERM-PILOTO-001" && st.cash_movement_id === null, "card refund recorded with its terminal reference and no register movement: " + J(st));
      expect(money((await one("select current_amount::text c from cash_sessions where closed_at is null")).c) === "715.00", "the card refund did not change the cash");
      const voucher = await call(`api.returns.previewVoucher(${(await one("select id from returns where sale_id=$1", [s2])).id})`);
      expect(voucher.ok && voucher.v.html.includes("REEMBOLSO PAGADO POR TARJETA") && voucher.v.html.includes("no ejecuta operaciones bancarias"), "the voucher does not claim a bank operation");
    });

    // ================================================================== 6. reports, reconciliation, register summary, closing
    await T("PIL-15.reports_and_dashboard_show_the_day_and_agree_with_postgresql", "e2e", async () => {
      await signOut();
      await signIn(ADMIN.pin, /#\/dashboard$/);
      const f = await figures(db);
      expect(f.sales.n === 3 && money(f.sales.t) === "456.00" && money(f.cashSales.t) === "285.00" && money(f.cardSales.t) === "171.00", "sales: " + J([f.sales, f.cashSales, f.cardSales]));
      expect(f.refunds.n === 2 && money(f.refunds.cash) === "120.00" && money(f.refunds.card) === "85.50", "refunds paid: " + J(f.refunds));
      await ui.nav(P(), "Dashboard");
      await P().getByText("Reembolsos pagados en efectivo (hoy)").waitFor({ timeout: 8000 });
      expect((await ui.statVal(P(), "Reembolsos pagados en efectivo (hoy)")) === "$120.00", "dashboard: cash refunds");
      expect((await ui.statVal(P(), "Reembolsos pagados por tarjeta (hoy)")) === "$85.50", "dashboard: card refunds");
      expect((await ui.statVal(P(), "Reembolsos pendientes de pago")) === "$0.00", "dashboard: nothing owed");
      await ui.nav(P(), "Reportes");
      await P().getByRole("button", { name: "Generar reporte" }).click();
      await P().getByTestId("rp-count").waitFor();
      expect((await P().getByTestId("rp-count").innerText()).trim() === "3", "report: three sales");
      const body = await P().locator("body").innerText();
      expect(body.includes("$456.00") && body.includes("$285.00") && body.includes("$171.00"), "report: total, cash and card");
      expect((await P().getByTestId("rp-paid-cash").innerText()).includes("$120.00") && (await P().getByTestId("rp-paid-card").innerText()).includes("$85.50"), "report: refunds by method");
      await shot("reports");
    });

    await T("PIL-16.the_day_reconciles_to_the_cent_cash_card_stock_and_refunds", "integration", async () => {
      const f = await figures(db);
      // cash: 500.00 opening + 285.00 cash sales + 100.00 in - 50.00 out - 120.00 cash refund = 715.00 ; card is information only
      const expected = 500 + 285 + 100 - 50 - 120;
      expect(num(f.register.c) === expected && expected === 715, `register balance ${f.register.c} = ${expected}`);
      const mv = await one("select coalesce(sum(case when type='IN' then amount else -amount end),0)::text n from cash_movements where session_id=(select id from cash_sessions order by id desc limit 1)");
      expect(num(f.register.i) + num(mv.n) === expected, "initial + every movement = balance");
      expect(JSON.stringify(f.stock.map((s) => [s.sku, s.stock])) === JSON.stringify([["PIL-CEP-01", 9], ["PIL-GEL-250", 12], ["PIL-SHA-500", 29], ["PIL-TIN-71", 14]]), "stock: 30-2+1, 15-2+1, 10-1, 12 untouched: " + J(f.stock));
      expect(J(f.returns) === J([{ s: "paid", n: 2 }]), "both returns are paid, none pending or legacy: " + J(f.returns));
      const stray = await one("select count(*)::int n from returns r where r.refund_status='paid' and not exists (select 1 from refund_settlements s where s.return_id=r.id)");
      expect(stray.n === 0, "every paid return has its settlement");
      expect(num((await one("select count(*)::int n from sales s where s.total <> (select sum(subtotal) from sale_items i where i.sale_id=s.id)")).n) === 0, "every sale equals the sum of its lines");
    });

    await T("PIL-17.the_register_summary_and_its_printable_document_tell_the_same_story_and_the_register_closes_at_zero_difference", "e2e", async () => {
      await ui.nav(P(), "Caja");
      await P().getByTestId("cash-refunds").waitFor();
      expect((await P().getByTestId("cash-refunds").innerText()) === "-$120.00", "Caja shows the cash refund");
      expect((await ui.statVal(P(), "Total en Caja")) === "$715.00", "Total en Caja");
      const sid = (await one("select id from cash_sessions where closed_at is null")).id;
      const sum = await call(`api.cash.getSessionSummary(${sid})`);
      const d = sum.v;
      expect(money(d.sales.cash.total) === "285.00" && money(d.sales.card.total) === "171.00" && money(d.movements.manualIn.total) === "100.00" && money(d.movements.manualOut.total) === "50.00", "summary lines");
      expect(money(d.refunds.cash.total) === "120.00" && money(d.refunds.card.total) === "85.50" && money(d.expected.registerBalance) === "715.00" && d.expected.reconciles, "refunds and expected cash: " + J(d.expected));
      const doc = await call(`api.cash.previewSummary(${sid})`);
      for (const needle of ["Reembolsos en efectivo (1)", "-$120.00", "Reembolsos pagados en esta caja", "Con tarjeta (1)", "$85.50", "$715.00", "no es una factura fiscal"]) expect(doc.v.html.includes(needle), "printable summary has: " + needle);
      // close the register counting exactly what the screen expects
      const counted = await ui.closeCash(P());
      expect(counted === "715.00", "the dialog expects 715.00: " + counted);
      const closed = await one("select status, final_amount::text f, current_amount::text c from cash_sessions where id=$1", [sid]);
      expect(closed.status === "closed" && money(closed.f) === "715.00", "closed at 715.00: " + J(closed));
      const after = await call(`api.cash.getSessionSummary(${sid})`);
      expect(money(after.v.closing.difference) === "0.00", "difference 0.00");
    });

    await T("PIL-18.the_closed_register_appears_in_the_history_and_its_summary_can_be_printed", "e2e", async () => {
      await P().getByRole("link", { name: /Historial de sesiones/ }).click();
      const t = P().getByRole("table", { name: "Sesiones de caja" });
      await t.waitFor();
      const sid = (await one("select id from cash_sessions order by id desc limit 1")).id;
      await P().getByRole("button", { name: `Ver sesión ${sid}`, exact: true }).click();
      await P().getByTestId("cs-cash-refunds").waitFor();
      expect((await P().getByTestId("cs-difference").innerText()) === "$0.00", "difference shown");
      await P().getByRole("button", { name: "Vista imprimible" }).click();
      const dlg = P().getByRole("dialog").filter({ hasText: `Corte de caja #${sid}` }).last();
      await dlg.waitFor();
      await P().frameLocator('iframe[title="Vista previa del corte de caja"]').getByText(`Corte de caja #${sid}`).waitFor({ timeout: 10000 });
      await dlg.getByRole("button", { name: "Imprimir" }).click();
      await P().getByTestId("print-status").getByText(/Corte enviado a imprimir/).waitFor({ timeout: 15000 });
      await closeAll();
    });

    await T("PIL-19.tickets_print_on_58_mm_paper_after_changing_the_setting_and_back_to_80", "e2e", async () => {
      await ui.nav(P(), "Configuración");
      await P().waitForFunction(() => document.querySelector("#bs-name")?.value === "Estética Leal", null, { timeout: 8000 });
      await P().locator("#bs-paper").selectOption("58");
      await P().getByRole("button", { name: "Guardar configuración" }).click();
      await toast(/Configuración guardada/);
      const sale = (await one("select id from sales order by id desc limit 1")).id;
      const prev = await call(`api.receipts.preview(${sale})`);
      expect(prev.v.width === "58" && prev.v.html.includes("width: 48mm"), "the 58 mm layout is used");
      await ui.nav(P(), "Historial");
      await P().locator("#hs-q").fill(String(sale));
      await P().getByRole("button", { name: "Buscar", exact: true }).click();
      await P().getByRole("button", { name: `Ver venta ${sale}`, exact: true }).click();
      await P().getByRole("dialog").getByRole("button", { name: "Ver recibo" }).click();
      await P().getByRole("dialog").filter({ hasText: `Recibo de la venta #${sale}` }).getByRole("button", { name: "Imprimir" }).click();
      await P().getByTestId("print-status").getByText(/Recibo enviado a imprimir/).waitFor({ timeout: 15000 });
      const f58 = path.join(PRINT_DIR, `receipt-${sale}-58mm.pdf`);
      expect(fs.existsSync(f58) && Math.abs(pdfWidthMm(f58) - 58) < 2.5, "a 58 mm PDF was produced");
      await closeAll();
      await ui.nav(P(), "Configuración");
      await P().locator("#bs-paper").selectOption("80");
      await P().getByRole("button", { name: "Guardar configuración" }).click();
      await toast(/Configuración guardada/);
    });

    // ================================================================== 7. restart, persistence, backup, restore, compare
    let before;
    await T("PIL-20.after_restarting_the_application_everything_is_where_it_was", "e2e", async () => {
      before = await figures(db);
      await stopApp();
      await startApp();
      await signIn(ADMIN.pin, /#\/dashboard$/);
      await ui.nav(P(), "Historial");
      const table = P().getByRole("table", { name: "Ventas" });
      await table.waitFor();
      await waitFor(async () => (await table.locator("tbody tr").count()) === 3, 8000);
      expect((await table.locator("tbody tr").count()) === 3, "the three sales are still listed");
      await ui.nav(P(), "Devoluciones");
      await P().getByText("Historial de devoluciones").waitFor();
      await P().locator("[data-testid^=return-state-]").first().waitFor();
      const states = await P().locator("[data-testid^=return-state-]").allInnerTexts();
      expect(J(states.sort()) === J(["PAGADO EN EFECTIVO", "PAGADO POR TARJETA"]), "both refunds still show their paid state: " + J(states));
      await ui.nav(P(), "Caja");
      await P().getByText("No hay sesión de caja abierta").waitFor();
      expect(J(await figures(db)) === J(before), "every figure in PostgreSQL is unchanged by the restart");
      await closeAll();
    });

    await T("PIL-21.the_database_is_backed_up_with_a_verified_second_copy_and_restored_into_a_new_database", "integration", async () => {
      backupDir = mkTmp("pos pilot backup ");
      secondDir = path.join(mkTmp("pos pilot second parent "), "copia externa");
      const cli = (script, args, envx) => {
        const r = spawnSync(process.execPath, [path.join(process.cwd(), "scripts", script), ...args], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ...envx } });
        return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
      };
      const b = cli("db-backup.mjs", ["--out", backupDir, "--label", "piloto", "--second-copy", secondDir], { DATABASE_URL: owner });
      expect(b.code === 0 && /Segunda copia verificada/.test(b.out), "backup with a verified second copy: " + b.out.slice(-250));
      const dump = fs.readdirSync(secondDir).find((f) => f.endsWith(".dump"));
      expect(dump, "the second copy holds the dump");
      restoredDb = "beauty_pos_e2e_pilotrestore" + crypto.randomBytes(3).toString("hex");
      const r = cli("db-restore.mjs", ["--file", path.join(secondDir, dump), "--target", restoredDb], { DATABASE_URL: owner });
      restoredDbs.push(restoredDb);
      expect(r.code === 0 && /tablas y filas=OK, huella del esquema=OK, migraciones aplicadas=OK/.test(r.out), "restored FROM THE SECOND COPY into a new database and verified: " + r.out.slice(-250));
    });

    await T("PIL-22.the_restored_copy_is_identical_and_reconciles_to_the_same_figures", "integration", async () => {
      const a = await snapshot(pilotDb), b = await snapshot(restoredDb);
      expect(J(a.counts) === J(b.counts) && J(a.rowHashes) === J(b.rowHashes) && a.schemaFingerprint === b.schemaFingerprint && a.migrations === b.migrations, "counts, row hashes, schema and migrations are identical");
      const copy = await connectRunDbLike(restoredDb);
      try {
        const fb = await figures(copy);
        expect(J(fb) === J(before), "the restored database reconciles to exactly the same figures: " + J(fb.register));
      } finally { await copy.end(); }
      const log = fs.readFileSync(path.join(backupDir, "backup.log"), "utf8");
      expect(/ OK .*second=verified/.test(log) && !secrets.some((s) => s.length >= 6 && log.includes(s)), "the backup is logged with its result and no secret");
    });

    // ================================================================== 8. visual review of the main screens
    await T("PIL-23.every_main_screen_fits_1024x768_with_one_heading_labelled_controls_and_usable_touch_targets", "e2e", async () => {
      await resize(1024, 768);
      const routes = [["dashboard", null], ["sales", "Punto de Venta"], ["cash", null], ["history", "Historial de ventas"], ["inventory", "Gestión de Productos"], ["receive", null], ["stock", "Consultar Stock"], ["returns", "Devoluciones"], ["reports", "Reportes"], ["users", null], ["settings", "Configuración comercial"]];
      const problems = [];
      const small = new Set();
      for (const [route] of routes) {
        await P().goto(`http://localhost:${process.env.E2E_PORT || 5173}/#/${route}`);
        await P().waitForTimeout(700);
        await P().locator("main").waitFor();
        const m = await P().evaluate(() => {
          const out = { hscroll: document.documentElement.scrollWidth - window.innerWidth, h1: document.querySelectorAll("h1").length, unlabelled: [], small: [] };
          for (const el of document.querySelectorAll("input, select, textarea")) {
            if (el.type === "hidden" || el.type === "file") continue;
            if (!((el.labels && el.labels.length) || el.getAttribute("aria-label") || el.getAttribute("aria-labelledby"))) out.unlabelled.push((el.id || el.placeholder || el.name || el.tagName).toString().slice(0, 30));
          }
          for (const b of document.querySelectorAll("button, a[href]")) {
            const r = b.getBoundingClientRect();
            if (r.width && r.height && (r.height < 36 || r.width < 36)) out.small.push((b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 22));
          }
          return out;
        });
        await shot("screen-" + route);
        if (m.hscroll > 1) problems.push(`${route}: horizontal overflow ${m.hscroll}px`);
        if (m.h1 < 1) problems.push(`${route}: no h1`);
        if (m.unlabelled.length) problems.push(`${route}: unlabelled ${m.unlabelled.join(",")}`);
        m.small.forEach((s) => small.add(s));
      }
      expect(problems.length === 0, "screen problems: " + problems.join(" | "));
      expect(small.size === 0, "every button and link of the visited screens is at least 36 px: " + [...small].slice(0, 8).join(", "));
      return "no control under 36 px on the visited screens";
    });

    await T("PIL-24.the_login_keypad_and_the_payment_and_pin_controls_are_comfortable_touch_targets", "e2e", async () => {
      await signOut();
      const keys = await P().evaluate(() => [...document.querySelectorAll("button")].filter((b) => /^[0-9]$/.test(b.textContent.trim())).map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }));
      expect(keys.length === 10 && keys.every(([w, h]) => w >= 56 && h >= 48), "the ten keypad buttons are at least 56x48 px: " + J(keys));
      const login = await P().getByRole("button", { name: "Iniciar Sesión" }).evaluate((b) => Math.round(b.getBoundingClientRect().height));
      expect(login >= 48, "Iniciar Sesión is " + login + " px high");
      // a wrong PIN is explained, the keypad stays usable and the count of digits is shown
      await ui.login(P(), "000000");
      await P().getByText("PIN incorrecto").waitFor();
      await signIn(ADMIN.pin, /#\/dashboard$/);
    });

    await T("PIL-25.error_and_destructive_flows_are_explained_and_ask_before_acting", "e2e", async () => {
      // deactivating a user asks for a confirmation; cancelling changes nothing
      await ui.nav(P(), "Usuarios");
      const row = P().getByRole("row", { name: new RegExp(VENDOR.name) });
      await row.getByRole("button", { name: "Desactivar" }).click();
      const confirmation = P().getByRole("alertdialog");
      await confirmation.waitFor();
      await confirmation.getByRole("button", { name: "Cancelar" }).click();
      expect((await one("select active from users where name=$1", [VENDOR.name])).active === true, "cancelling kept the vendor active");
      // removing a product from the catalogue asks for a reason and a confirmation
      await ui.nav(P(), "Productos");
      await P().getByLabel("Buscar productos").fill("PIL-REL-N");
      const del = P().getByRole("button", { name: "Eliminar Relleno de prueba N" });
      await del.click();
      const dlg = P().getByRole("alertdialog").or(P().getByRole("dialog"));
      await dlg.first().waitFor();
      await P().keyboard.press("Escape");
      expect((await one("select status from products where sku='PIL-REL-N'")).status === "active", "closing the dialog did not delete anything");
      // selling more than the stock is refused with the stock in the message, and nothing is written
      await signOut();
      await signIn(VENDOR.pin, /#\/sales$/);
      await ui.openCash(P(), "100.00");
      await ui.nav(P(), "Vender");
      const n0 = (await one("select count(*)::int n from sales")).n;
      await P().getByPlaceholder("Código, SKU o nombre...").fill(PRODUCTS[3].sku);
      await P().getByRole("option", { name: new RegExp(PRODUCTS[3].name) }).first().click();
      await P().locator('input[type="number"]').first().fill("99");
      // the screen refuses more than the stock and says how many there are; the quantity does not jump to 99
      await P().getByText("Solo hay 12 unidades disponibles").first().waitFor({ timeout: 8000 });
      expect(num(await P().locator('input[type="number"]').first().inputValue()) <= 12, "the cart quantity stays within the stock");
      await shot("error-state-stock");
      // and the main process refuses it too when the request is forged (checked by the integrity suites; here the stale-screen case)
      const forged = await call(`api.sales.create(${J({ items: [{ productId: (await one("select id from products where sku=$1", [PRODUCTS[3].sku])).id, quantity: 99, unitPrice: 30, subtotal: 2970 }], total: 2970, paymentMethod: "cash", sessionId: (await one("select id from cash_sessions where closed_at is null")).id })})`);
      expect(forged.ok === false && /\[STOCK_INSUFICIENTE\]/.test(forged.err), "the server refuses a sale above the stock: " + J(forged));
      expect((await one("select count(*)::int n from sales")).n === n0, "no sale was recorded");
      await closeAll();
    });
  } finally {
    await cleanup();
  }

  async function connectRunDbLike(name) {
    // the restored copy was created by the CLI, not by createRunDb: verify the connection by name before reading
    const pg = (await import("pg")).default;
    const cl = new pg.Client({ connectionString: urlFor(name, "e2e_pilot_verify") });
    await cl.connect();
    const cur = (await cl.query("select current_database() d")).rows[0].d;
    if (cur !== name || !/^beauty_pos_e2e_pilotrestore[0-9a-f]{6}$/.test(cur)) { await cl.end(); throw new Error("isolation check failed: " + cur); }
    return cl;
  }
}
