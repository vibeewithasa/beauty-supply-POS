/**
 * First-installation wizard: prepares the dedicated PostgreSQL instance, the database (demonstration or clean), the two roles and the
 * first users, and stores the connection protected by Windows. It runs in the main process AS THE WINDOWS USER who will use the
 * application (so the protected storage belongs to them), never elevated.
 *
 * Security model (same as the connection setup window):
 *  - its own page (no network, no navigation) and its own preload with three calls; the application's IPC handlers are NOT registered
 *    while it is open, so nothing here or there can reach the other;
 *  - every handler checks that the call comes from this window's main frame;
 *  - PINs are typed here, go once to the main process, are hashed (scrypt) in the database and are never logged or returned;
 *  - this is the only place besides `--manage` where the schema is applied: the regular application never migrates.
 */
import crypto from "node:crypto";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { safeCipher } from "../backend/safe-cipher";
import { describeUnexpected, guarded } from "../backend/ipc-errors";
import { AuthError, BusinessError } from "../backend/errors";
import { layoutFor, preflight, scrubSecrets, stopCluster } from "../../scripts/lib/managed-pg.mjs";
import { MODES, provisionManagedInstance } from "../../scripts/lib/provision.mjs";
import type { CleanInput, DemoInput, Mode } from "../../scripts/lib/provision.mjs";
import { bundleDir, managedRoot, migrationsDir, removeStoredConnection, storeAdminPassword, storeConnection } from "./managed-instance";
import { showSetupWindow } from "./setup-window";

const CHANNELS = ["install:getState", "install:run", "install:advanced"] as const;

function pageHtml(nonce: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>Estética Leal POS - Primera instalación</title>
<style>
body{font-family:"Segoe UI",Arial,sans-serif;margin:0;background:#f4f5f4;color:#1c2b27}
main{max-width:680px;margin:20px auto;padding:0 20px 40px}
h1{font-size:23px;margin:0 0 4px} h2{font-size:16px;margin:22px 0 8px}
p.lead{margin:0 0 14px;color:#44514d}
label{display:block;font-weight:600;font-size:14px;margin:10px 0 4px}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:9px 10px;font-size:15px;border:1px solid #9aa5a1;border-radius:6px}
.row{display:flex;gap:12px}.row>div{flex:1}
.choice{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;margin:6px 0;border:1px solid #c9d0cd;border-radius:8px;background:#fff;cursor:pointer}
.choice input{margin-top:4px}.choice b{display:block}.choice span{font-size:13px;color:#44514d}
button{margin-top:14px;padding:11px 18px;font-size:15px;font-weight:600;border:0;border-radius:6px;background:#23392f;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#23392f;border:1px solid #23392f}
button:disabled{opacity:.45;cursor:not-allowed}
ul{list-style:none;padding:0;margin:8px 0}
li{padding:7px 10px;margin:4px 0;border-radius:6px;background:#fff;border:1px solid #d5dad8;font-size:14px}
li.ok,li.done{border-left:5px solid #2e7d32} li.warn,li.running{border-left:5px solid #b26a00} li.bad,li.failed,li.fail{border-left:5px solid #c62828}
.note{font-size:13px;color:#44514d} #msg{margin-top:12px;font-weight:600}
.err{color:#c62828}.good{color:#2e7d32}
</style></head><body><main>
<h1>Bienvenido a Estética Leal POS</h1>
<p class="lead">Vamos a preparar el sistema en este equipo. No necesitas instalar nada más y no hace falta Internet.</p>
<h2>1. Comprobaciones</h2>
<ul id="checks"><li class="warn">Comprobando este equipo...</li></ul>
<h2>2. ¿Cómo quieres empezar?</h2>
<label class="choice"><input type="radio" name="mode" id="mode-demo" value="demo" checked><div><b>Demostración</b><span>Datos ficticios (productos, ventas, cajas y devoluciones de ejemplo) para presentar el sistema. Se eligen dos PIN.</span></div></label>
<label class="choice"><input type="radio" name="mode" id="mode-clean" value="clean"><div><b>Instalación limpia</b><span>Para empezar a trabajar: sin productos ni ventas. Se crea la persona administradora con su PIN.</span></div></label>
<section id="demo-fields">
<div class="row"><div><label for="admin-pin-d">PIN del Administrador Demo (6 a 8 dígitos)</label><input id="admin-pin-d" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>
<div><label for="admin-pin-d2">Repite el PIN</label><input id="admin-pin-d2" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div></div>
<div class="row"><div><label for="vendor-pin">PIN del Vendedor Demo (distinto)</label><input id="vendor-pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>
<div><label for="vendor-pin2">Repite el PIN</label><input id="vendor-pin2" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div></div>
</section>
<section id="clean-fields" hidden>
<label for="admin-name">Nombre de la persona administradora</label><input id="admin-name" type="text" autocomplete="off" maxlength="120">
<div class="row"><div><label for="admin-pin-c">PIN (6 a 8 dígitos)</label><input id="admin-pin-c" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>
<div><label for="admin-pin-c2">Repite el PIN</label><input id="admin-pin-c2" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div></div>
</section>
<p class="note">Los PIN no se guardan en ningún archivo ni vienen en el instalador: solo se guarda un resumen cifrado en la base de datos. Anótalos en un lugar seguro.</p>
<button id="btn-install" disabled>Instalar</button>
<h2>3. Progreso</h2>
<ul id="steps"><li class="warn">Aún no ha empezado.</li></ul>
<p id="msg" role="status"></p>
<button id="btn-retry" class="secondary" hidden>Reintentar</button>
<button id="btn-advanced" class="secondary">Usar un PostgreSQL que ya tengo (avanzado)</button>
<p class="note">La base de datos de Estética Leal POS es propia y se queda en esta cuenta de Windows, aparte de cualquier otro PostgreSQL del equipo; no se abre a la red.</p>
</main>
<script nonce="${nonce}">
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.installApi;
  const msg = (text, cls) => { $("msg").textContent = text; $("msg").className = cls || ""; };
  const li = (cls, text) => { const e = document.createElement("li"); e.className = cls; e.textContent = text; return e; };
  const fail = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^\\[[A-Z_]+\\] /, "");
  let pre = null, busy = false;
  const mode = () => (document.querySelector("input[name=mode]:checked") || {}).value;
  const sync = () => {
    const demo = mode() === "demo";
    $("demo-fields").hidden = !demo; $("clean-fields").hidden = demo;
    $("btn-install").disabled = busy || !pre || !pre.ok;
  };
  for (const r of document.querySelectorAll("input[name=mode]")) r.addEventListener("change", sync);
  api.onStep((s) => {
    const list = $("steps");
    if (list.dataset.placeholder !== "no") { list.textContent = ""; list.dataset.placeholder = "no"; }
    let row = list.querySelector("[data-step='" + s.id + "']");
    if (!row) { row = li("running", ""); row.dataset.step = s.id; list.appendChild(row); }
    row.className = s.status;
    row.textContent = (s.status === "done" ? "Listo: " : s.status === "failed" ? "Falló: " : "En curso: ") + s.label;
  });
  api.getState().then((s) => {
    pre = s.preflight;
    const list = $("checks"); list.textContent = "";
    for (const c of s.preflight.checks) list.appendChild(li(c.status, c.message));
    if (!s.encryption) { list.appendChild(li("fail", "Windows no ofrece almacenamiento protegido para esta cuenta: no se puede guardar la contraseña de forma segura.")); pre = { ok: false }; }
    sync();
  }).catch((e) => { $("checks").textContent = ""; $("checks").appendChild(li("fail", fail(e))); });
  const run = async () => {
    const demo = mode() === "demo";
    const request = demo
      ? { mode: "demo", adminPin: $("admin-pin-d").value, adminPin2: $("admin-pin-d2").value, vendorPin: $("vendor-pin").value, vendorPin2: $("vendor-pin2").value }
      : { mode: "clean", adminName: $("admin-name").value, adminPin: $("admin-pin-c").value, adminPin2: $("admin-pin-c2").value };
    if (request.adminPin !== request.adminPin2 || (demo && request.vendorPin !== request.vendorPin2)) { msg("Los PIN repetidos no coinciden.", "err"); return; }
    busy = true; sync(); $("btn-retry").hidden = true; $("steps").textContent = ""; $("steps").dataset.placeholder = "no"; msg("Instalando... esto tarda unos segundos.", "");
    try {
      const r = await api.run(request);
      for (const k of ["admin-pin-d", "admin-pin-d2", "vendor-pin", "vendor-pin2", "admin-pin-c", "admin-pin-c2"]) $(k).value = "";
      if (r.ok) { msg("Listo. Estética Leal POS se reiniciará para empezar.", "good"); return; }
      msg("No se pudo terminar en el paso \\"" + r.stepLabel + "\\": " + r.message + (r.logFile ? " (registro: " + r.logFile + ")" : "") + " Lo que se alcanzó a crear se deshizo; no se tocó nada más.", "err");
      busy = false; $("btn-retry").hidden = false; sync();
    } catch (e) { busy = false; msg(fail(e), "err"); sync(); }
  };
  $("btn-install").addEventListener("click", run);
  $("btn-retry").addEventListener("click", () => { $("btn-retry").hidden = true; msg("Revisa los datos y vuelve a pulsar Instalar.", ""); sync(); });
  $("btn-advanced").addEventListener("click", () => { api.advanced().catch(() => {}); });
})();
</script></body></html>`;
}

type InstallRequest = { mode: Mode; input: DemoInput | CleanInput };

function parseRequest(arg: unknown): InstallRequest {
  const bad = (m: string) => new BusinessError("DATOS_INVALIDOS", m);
  if (typeof arg !== "object" || arg === null) throw bad("Datos de instalación inválidos");
  const o = arg as Record<string, unknown>;
  const allowed = ["mode", "adminPin", "adminPin2", "vendorPin", "vendorPin2", "adminName"];
  if (Object.keys(o).some((k) => !allowed.includes(k))) throw bad("Datos de instalación inválidos");
  const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : "");
  if (o.mode !== "demo" && o.mode !== "clean") throw bad("Elige demostración o instalación limpia");
  if (str(o.adminPin, 8) !== str(o.adminPin2, 8)) throw bad("Los PIN repetidos no coinciden");
  if (o.mode === "demo") {
    if (str(o.vendorPin, 8) !== str(o.vendorPin2, 8)) throw bad("Los PIN repetidos no coinciden");
    return { mode: "demo", input: { adminPin: str(o.adminPin, 8), vendorPin: str(o.vendorPin, 8) } };
  }
  return { mode: "clean", input: { adminName: str(o.adminName, 120), adminPin: str(o.adminPin, 8) } };
}

export function showInstallWizard(): BrowserWindow {
  const win = new BrowserWindow({
    width: 760,
    height: 900,
    title: "Estética Leal POS - Primera instalación",
    webPreferences: {
      preload: path.join(__dirname, "../preload/install-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  win.removeMenu();
  let busy = false;
  win.on("close", (e) => {
    if (busy) e.preventDefault(); // never abandon the installation half way
  });

  const fromThisWindow = (event: IpcMainInvokeEvent) =>
    !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith("data:text/html");
  const handle = (channel: (typeof CHANNELS)[number], fn: (arg: unknown) => Promise<unknown> | unknown) =>
    ipcMain.handle(channel, (event, arg) =>
      guarded(
        channel,
        async () => {
          if (!fromThisWindow(event)) throw new AuthError("No autorizado");
          return fn(arg);
        },
        (line) => console.error(line),
        []
      )
    );

  handle("install:getState", async () => {
    const pf = await preflight({ layout: layoutFor(managedRoot()), bundleDir: bundleDir() });
    return { encryption: safeCipher.available(), preflight: { ok: pf.ok, checks: pf.checks } };
  });

  handle("install:run", async (arg) => {
    if (busy) throw new BusinessError("OCUPADO", "La instalación ya está en curso");
    const { mode, input } = parseRequest(arg);
    busy = true;
    const secrets = [(input as DemoInput).adminPin, (input as DemoInput).vendorPin];
    try {
      const r = await provisionManagedInstance({
        root: managedRoot(),
        bundleDir: bundleDir(),
        migrationsDir: migrationsDir(),
        mode,
        input,
        appVersion: app.getVersion(),
        onStep: (s) => {
          if (!win.isDestroyed()) win.webContents.send("install:step", s);
        },
        persist: async ({ connection, adminPassword }) => {
          storeAdminPassword(adminPassword);
          storeConnection(connection);
        },
        unpersist: async () => removeStoredConnection(),
      });
      console.log(`INSTALL_DONE: ${MODES[mode].label}, port ${r.connection.port}`);
      // the relaunched application starts the instance itself (and stops it when it closes); leave nothing running in between
      try {
        stopCluster({ layout: r.layout, runtimeDir: path.join(r.layout.root, r.manifest.postgres.runtimeDir), mode: "fast" });
      } catch (e) {
        console.error("INSTALL_STOP_FAILED:", e instanceof Error ? e.message : "unknown");
      }
      // graceful quit (not exit): Chromium persists the key that protects the stored password while shutting down
      setTimeout(() => {
        busy = false;
        if (!(process.env.POS_SETUP_NO_RELAUNCH === "1" && !app.isPackaged)) app.relaunch();
        app.quit();
      }, 1200);
      return { ok: true };
    } catch (e) {
      busy = false;
      const err = e as { code?: string; message?: string; step?: { id: string; label: string }; logFile?: string | null };
      console.error("INSTALL_FAILED:", err.code ?? "", err.step?.id ?? "", scrubSecrets(err.message ?? "", secrets));
      return {
        ok: false,
        code: err.code ?? "FALLO",
        stepLabel: err.step?.label ?? "Instalación",
        message: scrubSecrets(err.message ?? "Error inesperado", secrets),
        logFile: err.logFile ?? null,
      };
    }
  });

  handle("install:advanced", () => {
    if (busy) throw new BusinessError("OCUPADO", "La instalación está en curso");
    setTimeout(() => {
      showSetupWindow("Conexión a un PostgreSQL existente", "Configura la conexión a un PostgreSQL que ya tienes (avanzado). Usa un usuario de privilegios mínimos; la contraseña se guarda protegida por Windows.");
      win.close();
    }, 0);
    return { ok: true };
  });

  win.on("closed", () => {
    for (const ch of CHANNELS) ipcMain.removeHandler(ch);
  });
  const nonce = crypto.randomBytes(16).toString("base64");
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(pageHtml(nonce))).catch((e) => console.error(describeUnexpected("install:load", e)));
  return win;
}
