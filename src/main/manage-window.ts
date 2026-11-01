/**
 * Maintenance window of a self-contained installation: `"Beauty POS.exe" --manage`.
 *
 * It is the ONLY place (besides the first-installation wizard) where the schema is changed, a backup is made on demand or the
 * demonstration is started over. Everything here goes through scripts/lib/provision.mjs, which proves the instance is this
 * installation's own before doing anything and refuses to touch a clean (real) installation's data as a demonstration.
 *
 *  - own page and own preload, the application's IPC is not registered while it is open;
 *  - every handler checks the call comes from this window's main frame;
 *  - the cluster superuser's password is read here (DPAPI) and never sent to the page.
 */
import crypto from "node:crypto";
import path from "node:path";
import { app, BrowserWindow, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import { describeUnexpected, guarded } from "../backend/ipc-errors";
import { AuthError, BusinessError } from "../backend/errors";
import { scrubSecrets } from "../../scripts/lib/managed-pg.mjs";
import { RESET_CONFIRMATION, backupManaged, managedStatus, resetDemo, updateSchema } from "../../scripts/lib/provision.mjs";
import { managedRoot, migrationsDir, readAdminPassword, storeAdminPassword, storeConnection } from "./managed-instance";

const CHANNELS = ["manage:getState", "manage:backup", "manage:updateSchema", "manage:resetDemo"] as const;

function pageHtml(nonce: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>Estética Leal POS - Mantenimiento</title>
<style>
body{font-family:"Segoe UI",Arial,sans-serif;margin:0;background:#f4f5f4;color:#1c2b27}
main{max-width:700px;margin:20px auto;padding:0 20px 40px}
h1{font-size:22px;margin:0 0 4px} h2{font-size:16px;margin:22px 0 8px}
label{display:block;font-weight:600;font-size:14px;margin:10px 0 4px}
input{width:100%;box-sizing:border-box;padding:9px 10px;font-size:15px;border:1px solid #9aa5a1;border-radius:6px}
.row{display:flex;gap:12px}.row>div{flex:1}
button{margin-top:12px;padding:10px 16px;font-size:15px;font-weight:600;border:0;border-radius:6px;background:#23392f;color:#fff;cursor:pointer}
button.danger{background:#a32121}
button:disabled{opacity:.45;cursor:not-allowed}
dl{display:grid;grid-template-columns:180px 1fr;gap:4px 12px;background:#fff;border:1px solid #d5dad8;border-radius:8px;padding:12px;font-size:14px}
dt{font-weight:600} dd{margin:0;word-break:break-all}
li{list-style:none;padding:6px 10px;margin:4px 0;border-radius:6px;background:#fff;border:1px solid #d5dad8;font-size:14px}
ul{padding:0}
li.done{border-left:5px solid #2e7d32} li.running{border-left:5px solid #b26a00} li.failed{border-left:5px solid #c62828}
.note{font-size:13px;color:#44514d} #msg{margin-top:12px;font-weight:600} .err{color:#c62828}.good{color:#2e7d32}
</style></head><body><main>
<h1>Mantenimiento de Estética Leal POS</h1>
<p class="note">Aquí se hacen las operaciones administrativas de la base de datos propia de esta instalación. La aplicación normal nunca las hace sola.</p>
<h2>Estado</h2>
<dl id="state"><dt>Cargando</dt><dd>...</dd></dl>
<h2>Respaldo</h2>
<p class="note">Crea una copia verificada de la base en la carpeta de respaldos. No detiene la aplicación.</p>
<button id="btn-backup">Crear respaldo ahora</button>
<h2>Actualizar la estructura de la base</h2>
<p class="note">Solo se aplica cuando la aplicación trae cambios que la base aún no tiene, y siempre después de un respaldo verificado.</p>
<button id="btn-update" disabled>Actualizar estructura</button>
<section id="demo-reset" hidden>
<h2>Reiniciar la demostración</h2>
<p class="note">Borra las ventas de ensayo y vuelve a cargar los datos ficticios. Antes se crea un respaldo. Los PIN se eligen de nuevo. Solo existe en instalaciones de demostración: una instalación limpia nunca se convierte en demostración.</p>
<div class="row"><div><label for="admin-pin">PIN nuevo del Administrador Demo</label><input id="admin-pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>
<div><label for="admin-pin2">Repite el PIN</label><input id="admin-pin2" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div></div>
<div class="row"><div><label for="vendor-pin">PIN nuevo del Vendedor Demo</label><input id="vendor-pin" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div>
<div><label for="vendor-pin2">Repite el PIN</label><input id="vendor-pin2" type="password" inputmode="numeric" maxlength="8" autocomplete="off"></div></div>
<label for="confirm">Escribe ${RESET_CONFIRMATION} para confirmar</label><input id="confirm" autocomplete="off">
<button id="btn-reset" class="danger">Reiniciar la demostración</button>
</section>
<ul id="steps"></ul>
<p id="msg" role="status"></p>
</main>
<script nonce="${nonce}">
(() => {
  const $ = (id) => document.getElementById(id);
  const api = window.manageApi;
  const msg = (t, c) => { $("msg").textContent = t; $("msg").className = c || ""; };
  const fail = (e) => String((e && e.message) || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "").replace(/^\\[[A-Z_]+\\] /, "");
  const busy = (v) => { for (const b of document.querySelectorAll("button")) b.disabled = v || (b.id === "btn-update" && !canUpdate); };
  let canUpdate = false;
  api.onStep((s) => {
    let row = document.querySelector("[data-step='" + s.id + "']");
    if (!row) { row = document.createElement("li"); row.dataset.step = s.id; $("steps").appendChild(row); }
    row.className = s.status; row.textContent = (s.status === "done" ? "Listo: " : s.status === "failed" ? "Falló: " : "En curso: ") + s.label;
  });
  const render = (s) => {
    const rows = [["Tipo", s.mode === "demo" ? "Demostración" : "Instalación limpia"], ["Base de datos", s.database], ["Puerto (solo este equipo)", String(s.port)], ["PostgreSQL", s.postgresVersion],
      ["Estructura", s.schema.status === "ok" ? "al día (" + s.schema.applied + " de " + s.schema.required + ")" : s.schema.status === "newer" ? "más nueva que esta aplicación" : "pendiente: " + s.schema.applied + " de " + s.schema.required],
      ["Respaldos", s.backups.count + " en " + s.backups.folder + (s.backups.latest ? " (último: " + s.backups.latest + ")" : "")], ["Datos", s.dataFolder]];
    const dl = $("state"); dl.textContent = "";
    for (const [k, v] of rows) { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; dl.append(dt, dd); }
    canUpdate = s.schema.status === "missing" || s.schema.status === "uninitialized";
    $("btn-update").disabled = !canUpdate; $("demo-reset").hidden = s.mode !== "demo";
  };
  const refresh = () => api.getState().then(render).catch((e) => msg(fail(e), "err"));
  refresh();
  const run = async (label, fn) => {
    busy(true); msg(label, ""); $("steps").textContent = "";
    try { const r = await fn(); await refresh(); return r; } catch (e) { msg(fail(e), "err"); return null; } finally { busy(false); }
  };
  $("btn-backup").addEventListener("click", async () => { const r = await run("Creando el respaldo...", () => api.backup()); if (r) msg("Respaldo verificado: " + r.file, "good"); });
  $("btn-update").addEventListener("click", async () => { const r = await run("Respaldando y actualizando...", () => api.updateSchema()); if (r) msg(r.changed ? "Estructura actualizada. Respaldo previo: " + r.backup : "No había nada que actualizar.", "good"); });
  $("btn-reset").addEventListener("click", async () => {
    if ($("admin-pin").value !== $("admin-pin2").value || $("vendor-pin").value !== $("vendor-pin2").value) { msg("Los PIN repetidos no coinciden.", "err"); return; }
    const request = { adminPin: $("admin-pin").value, vendorPin: $("vendor-pin").value, confirm: $("confirm").value };
    const r = await run("Reiniciando la demostración...", () => api.resetDemo(request));
    for (const k of ["admin-pin", "admin-pin2", "vendor-pin", "vendor-pin2", "confirm"]) $(k).value = "";
    if (r) msg("Demostración reiniciada. Respaldo previo: " + r.backup + ". La aplicación se cerrará; ábrela de nuevo.", "good");
  });
})();
</script></body></html>`;
}

export function showManageWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 780,
    height: 900,
    title: "Estética Leal POS - Mantenimiento",
    webPreferences: {
      preload: path.join(__dirname, "../preload/manage-preload.cjs"),
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
    if (busy) e.preventDefault();
  });
  const fromThisWindow = (event: IpcMainInvokeEvent) =>
    !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith("data:text/html");
  const handle = (channel: (typeof CHANNELS)[number], fn: (arg: unknown) => Promise<unknown> | unknown) =>
    ipcMain.handle(channel, (event, arg) =>
      guarded(
        channel,
        async () => {
          if (!fromThisWindow(event)) throw new AuthError("No autorizado");
          if (busy) throw new BusinessError("OCUPADO", "Hay una operación en curso");
          busy = true;
          try {
            return await fn(arg);
          } finally {
            busy = false;
          }
        },
        (line) => console.error(line),
        []
      )
    );
  const send = (s: unknown) => {
    if (!win.isDestroyed()) win.webContents.send("manage:step", s);
  };
  const common = () => ({ root: managedRoot(), adminPassword: readAdminPassword() });

  handle("manage:getState", () => managedStatus({ ...common(), migrationsDir: migrationsDir() }));
  handle("manage:backup", async () => {
    const r = await backupManaged({ ...common(), label: "manual" });
    return { file: path.basename(r.file) };
  });
  handle("manage:updateSchema", async () => {
    const r = await updateSchema({ ...common(), migrationsDir: migrationsDir() });
    return { changed: r.changed, backup: r.backup ? path.basename(r.backup) : null };
  });
  handle("manage:resetDemo", async (arg) => {
    const o = typeof arg === "object" && arg !== null ? (arg as Record<string, unknown>) : {};
    const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : "");
    const input = { adminPin: str(o.adminPin, 8), vendorPin: str(o.vendorPin, 8) };
    const c = common();
    try {
      const r = await resetDemo({
        ...c,
        confirm: str(o.confirm, 20),
        input,
        migrationsDir: migrationsDir(),
        persist: async ({ connection, adminPassword }) => {
          storeAdminPassword(adminPassword);
          storeConnection(connection);
        },
        onStep: send,
      });
      setTimeout(() => app.quit(), 1500);
      return { backup: path.basename(r.backup) };
    } catch (e) {
      throw new BusinessError((e as { code?: string }).code ?? "REINICIO", scrubSecrets((e as Error).message, [input.adminPin, input.vendorPin, c.adminPassword]));
    }
  });

  win.on("closed", () => {
    for (const ch of CHANNELS) ipcMain.removeHandler(ch);
  });
  const nonce = crypto.randomBytes(16).toString("base64");
  void win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(pageHtml(nonce))).catch((e) => console.error(describeUnexpected("manage:load", e)));
  return win;
}
