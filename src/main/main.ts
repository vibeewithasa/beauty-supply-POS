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

app.on("ready", async () => {
  try {
    await createDbAndRunMigrations(app);
  } catch (err) {
    console.error("DB migration error:", err);
  }

  registerIpcHandlers();

  await createWindow();

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
