/**
 * Expected business failures. The message always starts with a stable code in
 * brackets so the renderer can react (e.g. refresh the catalog) without parsing prose:
 *   "[STOCK_INSUFICIENTE] Stock insuficiente para ..."
 */
export class BusinessError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`[${code}] ${message}`);
    this.code = code;
  }
}

/** PostgreSQL error code, also when the driver error is wrapped (drizzle puts it in `cause`). */
export function pgErrorCode(e: unknown): string | undefined {
  const err = e as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = err?.code ?? err?.cause?.code;
  return typeof code === "string" ? code : undefined;
}
