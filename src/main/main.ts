import { app, BrowserWindow, Menu, session } from "electron";
import path from "path";
import { dbConfig } from "../backend/db";
import { createDbAndRunMigrations } from "../backend/migrate";
import { registerIpcHandlers } from "../backend/ipc";
import { trustedUrl } from "../backend/auth";

const isDev = !app.isPackaged;
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
    await win.loadURL("http://localhost:5173");
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

  if (!dbConfig.ok) {
    console.error("STARTUP_ABORTED: database configuration missing or invalid. IPC handlers not registered.");
    showStartupFailure("Falta la configuración de la base de datos", dbConfig.reason);
    return;
  }
  try {
    console.log("Iniciando aplicación...");
    await createDbAndRunMigrations(app);
    console.log("Base de datos lista.");
  } catch (err) {
    // Never run on a database whose required schema/constraints are not in place.
    console.error("DB migration error:", err);
    console.error("STARTUP_ABORTED: IPC handlers not registered.");
    showStartupFailure("No se pudo preparar la base de datos", "Revisa que PostgreSQL esté activo y que la configuración sea correcta.");
    return;
  }

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
