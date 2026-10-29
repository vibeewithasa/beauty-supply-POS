import { app, BrowserWindow } from "electron";
import path from "path";
import { autoUpdater } from "electron-updater";
import { createDbAndRunMigrations } from "../backend/migrate";
import { registerIpcHandlers } from "../backend/ipc";

// Ensure single instance
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const isDev = !app.isPackaged;

async function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  if (isDev) {
    await win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    const indexPath = path.join(
      app.getAppPath(),
      "dist",
      "renderer",
      "index.html"
    );
    await win.loadFile(indexPath);
  }
}

// Shown instead of the app when the mandatory schema could not be prepared. It has no preload and no
// IPC handler is registered, so nothing can read or write the database from this window.
function showStartupFailure() {
  const win = new BrowserWindow({
    width: 640,
    height: 320,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  const html = `<!doctype html><meta charset="utf-8"><title>Beauty POS - Error</title>
<body style="font-family:sans-serif;margin:32px"><h2>No se pudo preparar la base de datos</h2>
<p>La aplicación no puede operar de forma segura. No se realizó ninguna operación.</p>
<p>Contacta a soporte y conserva el registro de la aplicación. Cierra esta ventana para salir.</p></body>`;
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
}

app.on("ready", async () => {
  try {
    console.log("Iniciando aplicación...");
    await createDbAndRunMigrations(app);
    console.log("Base de datos lista.");
  } catch (err) {
    // Never run on a database whose required schema/constraints are not in place.
    console.error("DB migration error:", err);
    console.error("STARTUP_ABORTED: IPC handlers not registered.");
    showStartupFailure();
    return;
  }

  registerIpcHandlers();
  console.log("IPC handlers registrados.");

  await createWindow();
  console.log("Ventana creada.");

  try {
    autoUpdater.checkForUpdatesAndNotify();
  } catch (e) {
    // Ignore updater errors silently per requirements
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("second-instance", () => {
  // No-op; single instance already ensured
});
