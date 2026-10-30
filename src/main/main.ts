import { app, BrowserWindow, Menu, session } from "electron";
import path from "path";
import { resolveDevOrigin } from "../backend/dev-origin";
import { isTrustedUrl } from "../backend/sender-guard";
import { showSetupWindow } from "./setup-window";

// NOTE: nothing that opens the database (db.ts, auth, ipc, startup-check) is imported statically: the connection string may be
// protected by Windows (safeStorage), which only works after the app is ready. They are imported inside the ready handler.
const isDev = !app.isPackaged;
const trustedUrl = (url: string) =>
  isTrustedUrl(url, {
    packaged: app.isPackaged,
    devOrigin: resolveDevOrigin(process.env, app.isPackaged),
    appIndexPath: path.join(app.getAppPath(), "dist", "renderer", "index.html"),
  });
let mainWindow: BrowserWindow | null = null;

// Ensure single instance: a second launch focuses the existing window instead of opening another one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

// ---------------------------------------------------------------- shell hardening
// Applies to every window and frame this app ever creates (including the startup-failure window).
app.on("web-contents-created", (_event, contents) => {
  // window.open / target=_blank: never create windows; external pages are not opened from inside the POS.
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  // Only the app's own page may be navigated to. blob: is the renderer's own CSV download.
  const blockForeign = (event: { preventDefault(): void }, url: string) => {
    if (!trustedUrl(url) && !url.startsWith("blob:")) event.preventDefault();
  };
  contents.on("will-navigate", blockForeign);
  contents.on("will-redirect", blockForeign);
  contents.on("will-attach-webview", (event) => event.preventDefault());
});

function denyAllPermissions() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: isDev, // no DevTools in a packaged build
    },
  });
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (isDev) {
    await win.loadURL(resolveDevOrigin(process.env, app.isPackaged));
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexPath = path.join(app.getAppPath(), "dist", "renderer", "index.html");
    await win.loadFile(indexPath);
  }
}

// Shown instead of the app when the mandatory configuration or schema could not be prepared. It has no preload and
// no IPC handler is registered, so nothing can read or write the database from this window.
function showStartupFailure(headline: string, detail: string) {
  const win = new BrowserWindow({
    width: 640,
    height: 360,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, devTools: isDev },
  });
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><meta charset="utf-8"><title>Beauty POS - Error</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<body style="font-family:sans-serif;margin:32px"><h2>${esc(headline)}</h2>
<p>La aplicación no puede operar de forma segura. No se realizó ninguna operación.</p>
<p>${esc(detail)}</p>
<p>Contacta a soporte y conserva el registro de la aplicación. Cierra esta ventana para salir.</p></body>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

/**
 * Updates are OFF unless an operator explicitly provides an https feed (POS_UPDATE_FEED_URL). There is no default
 * feed: the former placeholder pointed at http://localhost/updates. Note that updates are only trustworthy once the
 * installer is code-signed (see docs/PACKAGING.md).
 */
async function maybeCheckForUpdates() {
  const feed = process.env.POS_UPDATE_FEED_URL ?? "";
  if (!app.isPackaged || !/^https:\/\/[^\s]+$/.test(feed)) return;
  try {
    const { autoUpdater } = await import("electron-updater");
    autoUpdater.autoDownload = false;
    autoUpdater.setFeedURL({ provider: "generic", url: feed });
    await autoUpdater.checkForUpdates();
  } catch (e) {
    console.error("Update check failed:", e instanceof Error ? e.message : "unknown error");
  }
}

app.on("ready", async () => {
  denyAllPermissions();
  if (!isDev) Menu.setApplicationMenu(null);

  const { dbConfig } = await import("../backend/db");

  if (!dbConfig.ok) {
    console.error("STARTUP_ABORTED: database configuration missing or invalid. IPC handlers not registered.");
    // a stored (or missing) configuration can be fixed from the setup window; a bad DATABASE_URL belongs to the operator
    if (dbConfig.fixableBySetup) showSetupWindow("Falta la configuración de la base de datos", dbConfig.reason);
    else showStartupFailure("Falta la configuración de la base de datos", dbConfig.reason);
    return;
  }
  // The application never creates or migrates a schema: it only verifies it (see backend/startup-check.ts).
  console.log("Iniciando aplicación...");
  const { verifyDatabaseSchema } = await import("../backend/startup-check");
  const schema = await verifyDatabaseSchema(app.getAppPath());
  if (!schema.ok) {
    console.error("STARTUP_ABORTED: database schema is not the one this version requires. IPC handlers not registered.");
    // PostgreSQL unreachable or refusing the stored credentials: the setup window can fix a stored connection.
    // A missing/newer schema is never fixed from here (the app does not migrate): explanation only.
    if (schema.kind === "connection" && dbConfig.source === "config-file") {
      showSetupWindow(schema.headline, "No se pudo abrir la base de datos con la conexión guardada. Revisa que PostgreSQL esté activo y vuelve a configurar la conexión.");
    } else {
      showStartupFailure(schema.headline, schema.detail);
    }
    return;
  }
  console.log("Base de datos lista.");

  const { registerIpcHandlers } = await import("../backend/ipc");
  registerIpcHandlers();
  console.log("IPC handlers registrados.");

  await createWindow();
  console.log("Ventana creada.");

  void maybeCheckForUpdates();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});
