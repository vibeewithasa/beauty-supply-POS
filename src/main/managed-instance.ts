/**
 * Electron side of the dedicated PostgreSQL instance (docs/SELF_CONTAINED_INSTALLER.md). Main process only.
 *
 *  - where things live (managed root, bundled package, migrations),
 *  - starting the instance at every application start, and stopping it when the application closes,
 *  - storing the two secrets protected by Windows: the application role's password (config.json, as in 0.7.0) and the cluster
 *    superuser's password (cluster-admin.json, used only by explicit maintenance operations, never by the running application).
 * The logic itself (ownership checks, ports, ACLs, cluster control) is in scripts/lib/managed-pg.mjs, which the tests run against a real PostgreSQL.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { configFilePath } from "../backend/config-path";
import { readConfigFile, writeConfigV2 } from "../backend/config-store";
import { safeCipher } from "../backend/safe-cipher";
import { ManagedError, clusterRunning, ensureRunning, layoutFor, readManifest, scrubSecrets, serverLogTail, stopCluster, updateRuntimeIfNewer, writeManifest } from "../../scripts/lib/managed-pg.mjs";
import type { Layout, Manifest } from "../../scripts/lib/managed-pg.mjs";
import type { Connection } from "../../scripts/lib/provision.mjs";

export const FOLDER_NAME = "Estetica Leal POS";

/** %LOCALAPPDATA%\Estetica Leal POS; with an explicit --user-data-dir (tests, custom setups) it lives inside that folder instead. */
export function managedRoot(): string {
  if (app.commandLine.hasSwitch("user-data-dir")) return path.join(app.getPath("userData"), "managed");
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(local, FOLDER_NAME);
}
/** The PostgreSQL package that travels with the application (read only: PostgreSQL runs from a verified copy in the managed root). */
export function bundleDir(): string {
  return app.isPackaged ? path.join(process.resourcesPath, "postgresql") : path.join(app.getAppPath(), "vendor", "pg-bundle");
}
export const migrationsDir = (): string => path.join(app.getAppPath(), "drizzle");
export const bundleAvailable = (): boolean => fs.existsSync(path.join(bundleDir(), "postgresql-bundle.json"));
export const layout = (): Layout => layoutFor(managedRoot());

export type ManagedState =
  | { kind: "none" }
  | { kind: "ready"; manifest: Manifest }
  | { kind: "incomplete"; manifest: Manifest }
  | { kind: "damaged"; reason: string };

export function managedState(): ManagedState {
  try {
    const manifest = readManifest(layout());
    if (!manifest) return { kind: "none" };
    return manifest.state === "ready" ? { kind: "ready", manifest } : { kind: "incomplete", manifest };
  } catch (e) {
    return { kind: "damaged", reason: e instanceof ManagedError ? e.message : "No se pudo leer el registro de la instalación" };
  }
}

// ------------------------------------------------------------------------------------------------ secrets
export function storeAdminPassword(adminPassword: string): void {
  if (!safeCipher.available()) throw new ManagedError("SIN_CIFRADO", "Windows no ofrece almacenamiento protegido para esta cuenta: no se guarda ninguna contraseña en texto plano");
  const blob = safeCipher.encrypt(adminPassword);
  if (safeCipher.decrypt(blob) !== adminPassword) throw new ManagedError("CIFRADO_FALLIDO", "No se pudo verificar la contraseña protegida del clúster");
  const file = layout().adminSecret;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, passwordEncrypted: blob }), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
/** The cluster superuser's password, for explicit maintenance only. Throws when this Windows account cannot decrypt it. */
export function readAdminPassword(): string {
  try {
    const j = JSON.parse(fs.readFileSync(layout().adminSecret, "utf8")) as { passwordEncrypted?: string };
    if (!j.passwordEncrypted) throw new Error("empty");
    return safeCipher.decrypt(j.passwordEncrypted);
  } catch {
    throw new ManagedError("SECRETO_ILEGIBLE", "La contraseña administrativa guardada no se puede leer con esta cuenta de Windows.");
  }
}
/** config.json for the application (same v2 format and DPAPI protection as 0.7.0). */
export function storeConnection(c: Connection): void {
  const r = writeConfigV2(configFilePath(), { host: c.host, port: c.port, database: c.database, user: c.user }, c.password, safeCipher);
  if (!r.ok) throw new ManagedError(r.code, r.message);
}
export function removeStoredConnection(): void {
  fs.rmSync(configFilePath(), { force: true });
}

// ------------------------------------------------------------------------------------------------ lifecycle
let startedByUs = false;

export type StartResult = { ok: true; portChanged: boolean } | { ok: false; headline: string; detail: string };

/** Starts the instance (every application start). If its port was taken by another program, another is chosen and the stored connection follows. */
export async function startManagedInstance(): Promise<StartResult> {
  const l = layout();
  let manifest: Manifest | null;
  try {
    manifest = readManifest(l);
  } catch (e) {
    return { ok: false, headline: "No se pudo abrir la instalación", detail: e instanceof Error ? e.message : "registro ilegible" };
  }
  if (!manifest || manifest.state !== "ready") return { ok: false, headline: "La instalación no está completa", detail: "Vuelve a abrir la aplicación para terminar la preparación." };
  try {
    // a newer application may carry a newer PostgreSQL of the same major version; a different major is refused (never automatic)
    const upd = await updateRuntimeIfNewer({ layout: l, manifest, bundleDir: bundleDir() });
    if (upd.action === "updated") console.log(`MANAGED_RUNTIME_UPDATED: ${upd.from} -> ${upd.to}`);
    else if (upd.action !== "none") console.error(`MANAGED_RUNTIME_${upd.action.toUpperCase()}: ${upd.reason ?? ""}`);
    const r = await ensureRunning({ layout: l, manifest });
    if (!r.alreadyRunning) startedByUs = true;
    if (r.portChanged) followPort(l, manifest, r.port);
    return { ok: true, portChanged: r.portChanged };
  } catch (e) {
    const tail = serverLogTail(l, []);
    console.error("MANAGED_START_FAILED:", (e as { code?: string }).code ?? "", (e as Error).message);
    if (tail) console.error("MANAGED_LOG_TAIL:\n" + tail);
    const message = e instanceof ManagedError ? e.message : "PostgreSQL no pudo iniciar.";
    return {
      ok: false,
      headline: "No se pudo iniciar la base de datos de Estética Leal POS",
      detail: `${scrubSecrets(message, [])} Detalle técnico en: ${path.join(l.logs, "postgres")}`,
    };
  }
}

function followPort(l: Layout, manifest: Manifest, port: number): void {
  manifest.postgres.port = port;
  writeManifest(l, manifest);
  const cfg = readConfigFile(configFilePath());
  if (cfg.kind !== "v2" || !cfg.passwordEncrypted) return;
  const password = safeCipher.decrypt(cfg.passwordEncrypted);
  const r = writeConfigV2(configFilePath(), { ...cfg.parts, port }, password, safeCipher);
  if (!r.ok) throw new ManagedError(r.code, r.message);
}

/** Clean shutdown of the instance this application started (so no postgres.exe is left behind after closing or uninstalling). */
export function stopManagedInstanceIfOurs(): void {
  if (!startedByUs) return;
  startedByUs = false;
  try {
    const l = layout();
    const manifest = readManifest(l);
    if (!manifest) return;
    const runtimeDir = path.join(l.root, manifest.postgres.runtimeDir);
    if (clusterRunning(l, runtimeDir)) stopCluster({ layout: l, runtimeDir, mode: "fast", timeoutSec: 20 });
  } catch (e) {
    console.error("MANAGED_STOP_FAILED:", e instanceof Error ? e.message : "unknown");
  }
}
