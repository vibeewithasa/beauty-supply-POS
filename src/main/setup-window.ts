/**
 * First-run setup window: configure and verify the PostgreSQL connection, check the schema version, prepare the first
 * administrator. It exists only when the application cannot start because the stored connection is missing or unusable
 * (a connection given through DATABASE_URL is the operator's business and never opens it).
 *
 * Security model:
 *  - a page of its own (no network, no navigation) with a dedicated preload that exposes four calls and nothing else; the main
 *    application's renderer never gets them and the regular IPC handlers are NOT registered while this window is open;
 *  - every handler checks that the call comes from this very window's main frame;
 *  - the password is typed here, travels once to the main process and is stored protected by Windows (safeStorage/DPAPI);
 *    it is never returned, never logged and never written in clear text (with no protected storage nothing is saved);
 *  - nothing here runs migrations: a database that misses them is only reported (the operator runs `npm run db:migrate`).
 */
import crypto from "node:crypto";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { configFilePath } from "../backend/config-path";
import { safeCipher } from "../backend/safe-cipher";
import { readConfigFile } from "../backend/config-store";
import { parseConnection, parseFirstAdmin } from "../backend/setup-validation";
import { createFirstAdmin, inspectConnection, saveConfiguration } from "../backend/setup-service";
import { describeUnexpected, guarded } from "../backend/ipc-errors";
import { AuthError, BusinessError } from "../backend/errors";

const CHANNELS = ["setup:getState", "setup:inspect", "setup:save", "setup:createAdmin"] as const;
const allowRemote = () => process.env.POS_ALLOW_REMOTE_DB === "1";

function pageHtml(nonce: string, headline: string, reason: string): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>Beauty POS - Configuración inicial</title>
<style>
body{font-family:"Segoe UI",Arial,sans-serif;margin:0;background:#f4f5f4;color:#1c2b27}
main{max-width:640px;margin:24px auto;padding:0 20px 40px}
h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:24px 0 8px}
p.lead{margin:0 0 16px;color:#44514d}
label{display:block;font-weight:600;font-size:14px;margin:10px 0 4px}
input{width:100%;box-sizing:border-box;padding:9px 10px;font-size:15px;border:1px solid #9aa5a1;border-radius:6px}
.row{display:flex;gap:12px}.row>div{flex:1}.row>div.narrow{flex:0 0 110px}
button{margin-top:14px;padding:11px 18px;font-size:15px;font-weight:600;border:0;border-radius:6px;background:#23392f;color:#fff;cursor:pointer}
button.secondary{background:#fff;color:#23392f;border:1px solid #23392f}
button:disabled{opacity:.45;cursor:not-allowed}
ul{list-style:none;padding:0;margin:8px 0}
li{padding:7px 10px;margin:4px 0;border-radius:6px;background:#fff;border:1px solid #d5dad8;font-size:14px}
li.ok{border-left:5px solid #2e7d32} li.warn{border-left:5px solid #b26a00} li.bad{border-left:5px solid #c62828}
.note{font-size:13px;color:#44514d} #msg{margin-top:12px;font-weight:600}
.err{color:#c62828}.good{color:#2e7d32}
</style></head><body><main>
<h1 id="title">${esc(headline)}</h1>
<p class="lead" id="reason">${esc(reason)}</p>
<h2>1. Conexión a PostgreSQL</h2>
<p class="note">Usa el usuario de la aplicación (idealmente un rol de privilegios mínimos, creado con <code>npm run db:roles</code>), no el administrador de PostgreSQL. La contraseña se guarda protegida por Windows, ligada a esta cuenta de usuario.</p>
<div class="row"><div><label for="host">Servidor</label><input id="host" value="localhost" autocomplete="off"></div>
<div class="narrow"><label for="port">Puerto</label><input id="port" value="5432" inputmode="numeric" autocomplete="off"></div></div>
<label for="database">Base de datos</label><input id="database" value="beauty_pos" autocomplete="off">
<label for="user">Usuario</label><input id="user" autocomplete="off">
<label for="password">Contraseña</label><input id="password" type="password" autocomplete="off">
<button id="btn-test">Probar conexión</button>
<h2>2. Resultado</h2><ul id="checks"><li class="warn">Aún no se ha probado la conexión.</li></ul>
<button id="btn-save" disabled>Guardar y reiniciar</button>
<section id="admin-section" hidden>
<h2>3. Primer administrador</h2>
<p class="note">La base no tiene administradores. El PIN debe tener de 6 a 8 dígitos; se guarda solo como un hash con sal.</p>
<label for="admin-name">Nombre</label><input id="admin-name" autocomplete="off">
<div class="row"><div><label for="admin-pin">PIN</label><input id="admin-pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>
<div><label for="admin-pin2">Repite el PIN</label><input id="admin-pin2" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div></div>
<button id="btn-admin" class="secondary">Crear administrador</button>
</section>
<p id="msg" role="status"></p>
<p class="note">Esta ventana no aplica migraciones. Si faltan, ejecútalas con <code>npm run db:migrate</code> (ver docs/OPERATIONS.md) y abre la aplicación de nuevo.</p>
</main>
<script nonce="${nonce}">
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.setupApi;
  const msg = (text, cls) => { $("msg").textContent = text; $("msg").className = cls || ""; };
  const conn = () => ({ host: $("host").value, port: $("port").value, database: $("database").value, user: $("user").value, password: $("password").value });
  let tested = false;
  const invalidate = () => { tested = false; $("btn-save").disabled = true; $("admin-section").hidden = true; };
  for (const id of ["host", "port", "database", "user", "password"]) $(id).addEventListener("input", invalidate);
  const li = (cls, text) => { const e = document.createElement("li"); e.className = cls; e.textContent = text; return e; };
  const fail = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^\\[[A-Z_]+\\] /, "");
  api.getState().then((s) => {
    if (s.defaults) for (const k of Object.keys(s.defaults)) if (s.defaults[k] !== undefined && $(k)) $(k).value = s.defaults[k];
    if (!s.encryption) msg("Windows no ofrece almacenamiento protegido para esta cuenta: no se podrá guardar la contraseña.", "err");
  }).catch(() => {});
  $("btn-test").addEventListener("click", async () => {
    $("btn-test").disabled = true; msg("Probando...", "");
    try {
      const r = await api.inspect(conn());
      const list = $("checks"); list.textContent = "";
      if (!r.ok) { list.appendChild(li("bad", r.message)); invalidate(); msg("", ""); return; }
      list.appendChild(li("ok", "PostgreSQL disponible (versión " + r.server.version + ")" + (r.server.supported ? "" : " - se recomienda 12 o superior")));
      list.appendChild(li("ok", "La base de datos existe y el usuario puede conectarse"));
      if (r.role.level === "minimum") list.appendChild(li("ok", "El usuario " + r.role.name + " tiene privilegios mínimos"));
      else for (const w of r.role.warnings) list.appendChild(li("warn", w));
      if (r.schema.status === "ok") list.appendChild(li("ok", "Esquema al día: " + r.schema.applied + " de " + r.schema.required + " migraciones"));
      else list.appendChild(li("bad", (r.schema.headline || "Esquema no listo") + ". " + (r.schema.detail || "")));
      if (r.admin.exists === true) list.appendChild(li("ok", "Ya existe un administrador"));
      else if (r.admin.exists === false) list.appendChild(li("warn", "No hay administradores: crea el primero abajo"));
      tested = true; $("btn-save").disabled = false;
      $("admin-section").hidden = r.admin.exists !== false;
      msg("", "");
    } catch (e) { invalidate(); msg(fail(e), "err"); } finally { $("btn-test").disabled = false; }
  });
  $("btn-save").addEventListener("click", async () => {
    if (!tested) return;
    $("btn-save").disabled = true; msg("Guardando...", "");
    try {
      await api.save(conn());
      $("password").value = "";
      msg("Configuración guardada. La aplicación se reiniciará.", "good");
    } catch (e) { $("btn-save").disabled = false; msg(fail(e), "err"); }
  });
  $("btn-admin").addEventListener("click", async () => {
    if ($("admin-pin").value !== $("admin-pin2").value) { msg("Los PIN no coinciden.", "err"); return; }
    $("btn-admin").disabled = true; msg("Creando administrador...", "");
    try {
      await api.createAdmin({ connection: conn(), name: $("admin-name").value, pin: $("admin-pin").value });
      $("admin-pin").value = ""; $("admin-pin2").value = ""; $("admin-section").hidden = true;
      msg("Administrador creado. Guarda la configuración para empezar.", "good");
    } catch (e) { msg(fail(e), "err"); } finally { $("btn-admin").disabled = false; }
  });
})();
</script></body></html>`;
}

/** Opens the setup window and wires its handlers. Resolves nothing: the app either restarts or the operator closes it. */
export function showSetupWindow(headline: string, reason: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 860,
    title: "Beauty POS - Configuración inicial",
    webPreferences: {
      preload: path.join(__dirname, "../preload/setup-preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });
  win.removeMenu();

  const fromThisWindow = (event: IpcMainInvokeEvent) =>
    !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith("data:text/html");
  const handle = (channel: (typeof CHANNELS)[number], fn: (arg: unknown) => Promise<unknown> | unknown) =>
    ipcMain.handle(channel, (event, arg) =>
      guarded(
        channel,
        async () => {
          if (!fromThisWindow(event)) throw new AuthError("No autorizado"); // generic: not a window of the setup flow
          return fn(arg);
        },
        (line) => console.error(line),
        []
      )
    );

  handle("setup:getState", () => {
    const stored = readConfigFile(configFilePath());
    const defaults = stored.kind === "v2" ? { host: stored.parts.host, port: String(stored.parts.port), database: stored.parts.database, user: stored.parts.user } : undefined;
    return { encryption: safeCipher.available(), defaults };
  });
  handle("setup:inspect", (arg) => inspectConnection(parseConnection(arg, allowRemote()), app.getAppPath()));
  handle("setup:createAdmin", (arg) => createFirstAdmin(parseFirstAdmin(arg, allowRemote()), app.getAppPath()));
  handle("setup:save", async (arg) => {
    const conn = parseConnection(arg, allowRemote());
    // never save a connection that does not work: re-check it, then store it protected
    const probe = await inspectConnection(conn, app.getAppPath());
    if (!probe.ok) throw new BusinessError("CONEXION_FALLIDA", probe.message);
    const saved = saveConfiguration(configFilePath(), conn, safeCipher);
    if (!saved.ok) throw new BusinessError(saved.code, saved.message);
    console.log("CONFIG_SAVED: the connection was stored protected by Windows");
    // a graceful quit (not exit): Chromium persists the key that protects the password (os_crypt) while shutting down, and the
    // next start must be able to decrypt what was just saved
    setTimeout(() => {
      if (!(process.env.POS_SETUP_NO_RELAUNCH === "1" && !app.isPackaged)) app.relaunch();
      app.quit();
    }, 600);
    return { ok: true };
  });

  win.on("closed", () => {
    for (const ch of CHANNELS) ipcMain.removeHandler(ch);
  });
  const nonce = crypto.randomBytes(16).toString("base64");
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(pageHtml(nonce, headline, reason))).catch((e) => console.error(describeUnexpected("setup:load", e)));
  return win;
}
