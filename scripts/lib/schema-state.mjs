// Which migrations a database has, compared with the ones this version of the application requires.
// Pure and dependency free (node built-ins only): used by the Electron main process at startup (to REFUSE to run on
// a database that is not up to date, never to change it), by the administrative scripts and by the tests.
//
// A migration is identified by the same hash drizzle records in drizzle.__drizzle_migrations: the SHA-256 of the
// .sql file content. The journal (drizzle/meta/_journal.json) is the list of migrations the app requires.
//
// Line endings: drizzle hashes the file BYTES, so the same migration checked out with LF (CI, Linux, the repository's .gitattributes)
// or with CRLF (a Windows checkout with core.autocrlf=true) has two different hashes. A database migrated from one checkout must not
// be rejected by an app packaged from the other, so each migration is recognised by its raw hash, its LF form AND its CRLF form.
// (Only line endings are normalised: any other change to a migration still changes the hash and is still refused.)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{ idx: number, tag: string, when: number, hash: string, hashes?: string[] }} JournalEntry
 * @typedef {{ status: "ok" | "missing" | "newer" | "uninitialized", required: number, applied: number, missing: string[], unknown: number }} SchemaState
 */

/** @returns {JournalEntry[]} */
export function readJournal(migrationsFolder) {
  const journal = JSON.parse(fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"));
  const sha = (text) => crypto.createHash("sha256").update(text).digest("hex");
  return journal.entries.map((e) => {
    const text = fs.readFileSync(path.join(migrationsFolder, e.tag + ".sql"), "utf8");
    const lf = text.replace(/\r\n/g, "\n");
    const raw = sha(text);
    return { idx: e.idx, tag: e.tag, when: e.when, hash: raw, hashes: [...new Set([raw, sha(lf), sha(lf.replace(/\n/g, "\r\n"))])] };
  });
}

/**
 * @param {JournalEntry[]} journal what this version requires
 * @param {{ hash: string }[] | null} applied rows of drizzle.__drizzle_migrations, or null when that table does not exist
 * @returns {SchemaState}
 */
export function evaluateSchema(journal, applied) {
  const required = journal.length;
  if (applied === null) return { status: "uninitialized", required, applied: 0, missing: journal.map((j) => j.tag), unknown: 0 };
  const variants = (j) => j.hashes ?? [j.hash];
  const have = new Set(applied.map((r) => r.hash));
  const known = new Set(journal.flatMap(variants));
  const missing = journal.filter((j) => !variants(j).some((h) => have.has(h))).map((j) => j.tag);
  const unknown = applied.filter((r) => !known.has(r.hash)).length;
  // Rows this version does not know mean the database was upgraded by a NEWER version: running on it is unsafe.
  if (unknown > 0) return { status: "newer", required, applied: applied.length, missing, unknown };
  if (applied.length === 0) return { status: "uninitialized", required, applied: 0, missing, unknown };
  return { status: missing.length ? "missing" : "ok", required, applied: applied.length, missing, unknown };
}

/** Reads the applied migrations with a plain SELECT. null = no drizzle schema/table yet (never created or wrong database). */
export async function readApplied(queryable) {
  const exists = await queryable.query("select to_regclass('drizzle.__drizzle_migrations') is not null as ok");
  if (!exists.rows[0].ok) return null;
  const r = await queryable.query("select hash from drizzle.__drizzle_migrations");
  return r.rows;
}

/** @returns {Promise<SchemaState>} read-only: only SELECTs. */
export async function checkSchema(queryable, migrationsFolder) {
  return evaluateSchema(readJournal(migrationsFolder), await readApplied(queryable));
}

/** Safe, user-facing explanation (no connection details, no SQL). */
export function describeSchemaState(state) {
  switch (state.status) {
    case "ok":
      return null;
    case "missing":
      return {
        headline: "La base de datos necesita actualizarse",
        detail: `Faltan ${state.missing.length} actualización(es) de la base de datos (${state.missing.join(", ")}). La aplicación no las aplica por sí sola: quien administra el sistema debe hacer un respaldo, la comprobación previa y ejecutar el comando de actualización (docs/OPERATIONS.md).`,
      };
    case "uninitialized":
      return {
        headline: "La base de datos no está inicializada",
        detail: "La base indicada no tiene la estructura del sistema. La aplicación no la crea por sí sola: prepara la base con el comando de actualización documentado (docs/OPERATIONS.md) o revisa que la configuración apunte a la base correcta.",
      };
    case "newer":
      return {
        headline: "La base de datos es más nueva que esta aplicación",
        detail: "La base fue actualizada por una versión más reciente del sistema. Instala la versión actual de la aplicación; no se realizó ninguna operación.",
      };
    default:
      return { headline: "No se pudo comprobar la base de datos", detail: "Revisa que PostgreSQL esté activo y que la configuración sea correcta." };
  }
}
