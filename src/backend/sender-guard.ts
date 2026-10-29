import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Pure decision logic for "who may call privileged IPC". Kept free of Electron
 * imports so it can be unit tested in plain Node.
 */
export type GuardOptions = {
  packaged: boolean;
  /** Exact origin of the dev server, e.g. "http://localhost:5173". */
  devOrigin: string;
  /** Absolute path of the bundled renderer entry (packaged builds only). */
  appIndexPath: string;
};

export function isTrustedUrl(url: string, o: GuardOptions): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (!o.packaged) {
    // Exact origin match: rejects look-alikes such as http://localhost:5173.evil.com,
    // http://localhost:5173@evil.com, other ports/schemes or 127.0.0.1.
    return u.protocol === "http:" && u.origin === o.devOrigin && !u.username && !u.password;
  }
  // Packaged: only the app's own index.html, not any file:// document.
  if (u.protocol !== "file:") return false;
  let p: string;
  try {
    p = fileURLToPath(u);
  } catch {
    return false;
  }
  const norm = (x: string) =>
    process.platform === "win32" ? path.resolve(x).toLowerCase() : path.resolve(x);
  return norm(p) === norm(o.appIndexPath);
}

/** The caller must be the top-level frame of a trusted page (never an iframe). */
export function isTrustedFrame(
  frame: { url: string } | null | undefined,
  mainFrame: unknown,
  o: GuardOptions
): boolean {
  return !!frame && frame === mainFrame && isTrustedUrl(frame.url, o);
}
