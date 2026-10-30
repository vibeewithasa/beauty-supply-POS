/**
 * Error boundary for the IPC layer (pure: no Electron, no DB, unit tested).
 *
 * Only BusinessError (coded, safe messages) and AuthError (fixed messages) may reach the renderer
 * verbatim. Anything else is an unexpected failure: the details (SQL, parameters, stack, paths) are
 * logged in the main process, redacted, and the renderer only gets a stable generic error.
 */
import { AuthError, BusinessError } from "./errors.ts";

export const INTERNAL_ERROR_CODE = "ERROR_INTERNO";
export const INTERNAL_ERROR_MESSAGE = `[${INTERNAL_ERROR_CODE}] Ocurrió un error interno y la operación no se completó. Si se repite, contacta a soporte.`;

export const isPublicError = (e: unknown): boolean => e instanceof BusinessError || e instanceof AuthError;

export const internalError = (): Error => new Error(INTERNAL_ERROR_MESSAGE);

/** Removes credentials and query parameters from text that is about to be logged. */
export function redact(text: string, secrets: string[] = []): string {
  let t = String(text);
  for (const s of secrets) if (s && s.length > 2) t = t.split(s).join("***");
  return t
    .replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://***")
    .replace(/^(\s*params:).*$/gim, "$1 <redacted>")
    .replace(/\b[0-9a-f]{64}\b/gi, "<hash>")
    .replace(/scrypt\$[^\s,"')]+/gi, "<hash>")
    .replace(/(password|passwd|pwd|pin_hash|pinHash)(["']?\s*[:=]\s*)["']?[^\s,"')]+/gi, "$1$2<redacted>");
}

/** One redacted, size-limited log entry for an unexpected error (full detail stays in the main log only). */
export function describeUnexpected(channel: string, e: unknown, secrets: string[] = []): string {
  const err = e as { message?: unknown; stack?: unknown; cause?: { message?: unknown } } | null;
  const message = String(err?.message ?? e);
  const cause = err?.cause?.message ? ` | cause: ${String(err.cause.message)}` : "";
  const stack = String(err?.stack ?? "").split("\n").slice(1, 7).join("\n");
  return redact(`[ipc] unexpected error in ${channel}: ${message}${cause}\n${stack}`, secrets).slice(0, 4000);
}

/**
 * Runs `fn`; public errors pass through untouched, everything else is logged (redacted) and replaced by
 * the generic [ERROR_INTERNO] error.
 */
export async function guarded<T>(
  channel: string,
  fn: () => Promise<T> | T,
  log: (line: string) => void,
  secrets: string[] = []
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (isPublicError(e)) throw e;
    log(describeUnexpected(channel, e, secrets));
    throw internalError();
  }
}
