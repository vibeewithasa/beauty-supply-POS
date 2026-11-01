export type Layout = { root: string; manifest: string; adminSecret: string; runtimeBase: string; data: string; logs: string; backups: string; tmp: string };
export type Manifest = {
  schema: number;
  installId: string;
  createdAt: string;
  appVersion: string;
  state: "provisioning" | "ready" | "failed";
  failedStep?: string;
  steps: string[];
  schemaMigrations?: number;
  postgres: { version: string; major: number; runtimeDir: string; dataDir: string; port: number; systemIdentifier: string | null; superuser: string };
  database: { name: string; runtimeRole: string; mode: "demo" | "clean" };
};
export type PreflightCheck = { id: string; status: "ok" | "warn" | "fail"; message: string };
export type PreflightResult = { ok: boolean; checks: PreflightCheck[]; port: number | null; existing: string; manifest: Manifest | null; freeBytes: number | null };
export class ManagedError extends Error {
  code: string;
  step?: { id: string; label: string };
  logFile?: string | null;
  constructor(code: string, message: string);
}
export const PORT_FIRST: number;
export const PORT_LAST: number;
export function layoutFor(root: string): Layout;
export function readManifest(layout: Layout): Manifest | null;
export function writeManifest(layout: Layout, manifest: Manifest): void;
export function preflight(o: { layout: Layout; bundleDir: string; minFreeBytes?: number; portFirst?: number; portLast?: number }): Promise<PreflightResult>;
export function ensureRunning(o: { layout: Layout; manifest: Manifest; portFirst?: number; portLast?: number }): Promise<{ port: number; portChanged: boolean; alreadyRunning: boolean; runtimeDir: string }>;
export function stopCluster(o: { layout: Layout; runtimeDir: string; mode?: string; timeoutSec?: number }): { wasRunning: boolean };
export function clusterRunning(layout: Layout, runtimeDir: string): boolean;
export function serverLogTail(layout: Layout, secrets?: string[], lines?: number): string;
export function scrubSecrets(text: unknown, secrets: Array<string | undefined | null>): string;
export function randomSecret(bytes?: number): string;
export function secureDirectory(dir: string): void;
export function readBundleManifest(bundleDir: string): { version: string; major: number };
export function connectionUrl(o: { port: number; user: string; password: string; database?: string }): string;
export function adminUrl(o: { port: number; password: string; database?: string }): string;
export function compareVersions(a: string, b: string): number;
export function updateRuntimeIfNewer(o: { layout: Layout; manifest: Manifest; bundleDir: string }): Promise<{ action: "none" | "updated" | "refused" | "rolled-back"; reason?: string; from?: string; to?: string }>;
