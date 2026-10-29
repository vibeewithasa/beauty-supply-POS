/**
 * Business errors from the main process look like "[STOCK_INSUFICIENTE] Stock insuficiente para ...",
 * wrapped by Electron as "Error invoking remote method 'x': Error: [CODE] text".
 */
export function describeIpcError(error: unknown, fallback: string): { code: string | null; message: string } {
  const raw = String((error as { message?: unknown })?.message ?? error ?? "");
  const m = /\[([A-Z_]+)\]\s*([^\n]*)/.exec(raw);
  return m ? { code: m[1], message: m[2] } : { code: null, message: fallback };
}
