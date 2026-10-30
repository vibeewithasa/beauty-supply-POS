/**
 * Persistence of the PIN-attempt counter (a small JSON file in the user data folder), so that restarting the application does
 * not give the attempts back. It holds three numbers: no PIN, no hash, no user. Best effort: any read or write problem just
 * means "no persisted state" and never blocks a login. Pure Node (fs/path), unit tested with temporary folders.
 *
 * Honest limit: whoever can delete this file can also read the database or the configuration; it raises the bar for the
 * "kill the app to reset the counter" trick, it is not a defence against an attacker with control of the Windows account.
 */
import fs from "node:fs";
import path from "node:path";
import { sanitizeState } from "./login-limiter.ts";
import type { LimiterConfig, LimiterState } from "./login-limiter.ts";

export const LIMITER_FILE = "auth-limiter.json";

export function loadLimiterState(file: string, now: number, cfg: LimiterConfig): LimiterState | null {
  try {
    return sanitizeState(JSON.parse(fs.readFileSync(file, "utf8")), now, cfg);
  } catch {
    return null;
  }
}

export function saveLimiterState(file: string, state: LimiterState): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { encoding: "utf8" });
    fs.renameSync(tmp, file); // atomic replace: a crash never leaves half a file
  } catch {
    /* best effort */
  }
}
