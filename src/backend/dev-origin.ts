/**
 * Origin of the Vite dev server that the main process loads and trusts for IPC in development.
 * The default is http://localhost:5173. POS_DEV_PORT may change the port, but ONLY in unpackaged builds: a packaged
 * app never reads it, and the trusted origin is still one exact http://localhost:<port> (no other host or scheme).
 * Pure (no Electron), unit tested.
 */
export const DEFAULT_DEV_PORT = 5173;

export function resolveDevPort(env: Record<string, string | undefined>, packaged: boolean): number {
  if (packaged) return DEFAULT_DEV_PORT;
  const raw = env.POS_DEV_PORT;
  if (raw && /^[1-9]\d{3,4}$/.test(raw) && Number(raw) <= 65535) return Number(raw);
  return DEFAULT_DEV_PORT;
}

export const resolveDevOrigin = (env: Record<string, string | undefined>, packaged: boolean) =>
  `http://localhost:${resolveDevPort(env, packaged)}`;
