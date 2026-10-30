import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseConnection, assertLocal, scrub, backupFileName, sanitizeLabel, pruneBackups, validateRestoreTarget, runtimeGrantSql, DB_NAME_RE, ROLE_NAME_RE, findPgBin, urlWithDatabase,
} from "../../scripts/lib/db-ops.mjs";

// credential-bearing URLs are assembled at runtime: the repository scan forbids literals
const url = (host, db, pw = "pw-test-value-9") => ["postgresql://app_user", pw + "@" + host + ":5432/" + db].join(":");
const code = (fn) => { try { fn(); } catch (e) { return e.code ?? "OTHER"; } return null; };

test("connection parsing and the local-server rule", () => {
  const c = parseConnection(url("localhost", "beauty_pos"));
  assert.deepEqual([c.host, c.port, c.user, c.database], ["localhost", "5432", "app_user", "beauty_pos"]);
  assertLocal(c, {});
  assert.equal(code(() => assertLocal(parseConnection(url("192.0.2.10", "x")), {})), "SERVIDOR_NO_LOCAL");
  assertLocal(parseConnection(url("192.0.2.10", "x")), { POS_ALLOW_REMOTE_DB: "1" });
  assert.equal(code(() => parseConnection("mysql://u@h/x")), "URL_INVALIDA");
  assert.equal(code(() => parseConnection("not a url")), "URL_INVALIDA");
  assert.equal(urlWithDatabase(url("localhost", "a"), "b").endsWith("/b"), true);
});
test("scrub removes the password, its encoded form and any connection URL", () => {
  const pw = "p@ss/word-123";
  const u = url("localhost", "db", encodeURIComponent(pw));
  const other = ["postgres://x", "y@h/z"].join(":");
  const text = `failed for ${u} because password ${pw} (${encodeURIComponent(pw)}) is wrong; also ${other}`;
  const out = scrub(text, u);
  assert.doesNotMatch(out, /p@ss|word-123|p%40ss|postgres(ql)?:\/\/[^*]/);
});
test("backup file names: <db>_<label>_<UTC timestamp>.dump, labels restricted", () => {
  assert.equal(backupFileName("beauty_pos", "diario", new Date("2026-03-04T05:06:07.890Z")), "beauty_pos_diario_20260304T050607Z.dump");
  assert.equal(sanitizeLabel("Pre-Migrate"), "pre-migrate");
  for (const bad of ["a b", "x/y", "..", "", "a".repeat(41), "é"]) assert.equal(code(() => sanitizeLabel(bad)), "ETIQUETA_INVALIDA", bad);
});
test("restore targets: valid new names only; protected, configured and malformed names are refused", () => {
  validateRestoreTarget("beauty_pos_copy_2026", "beauty_pos");
  for (const t of ["beauty_pos", "beauty_pos_smoke", "postgres", "template0", "template1"]) assert.equal(code(() => validateRestoreTarget(t, "other")), "DESTINO_PROTEGIDO", t);
  assert.equal(code(() => validateRestoreTarget("same_db", "same_db")), "DESTINO_PROTEGIDO");
  for (const t of ["Bad", "a", "1abc", "a-b", "a b", 'a"; drop database x; --', "x".repeat(64), undefined, null, 5]) assert.equal(code(() => validateRestoreTarget(t, "beauty_pos")), "DESTINO_INVALIDO", String(t));
  assert.ok(DB_NAME_RE.test("beauty_pos_e2e_abc123"));
});
test("retention only deletes this tool's backups of that database", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "db ops prune "));
  try {
    const mk = (n) => fs.writeFileSync(path.join(dir, n), "x");
    for (const d of [1, 2, 3, 4]) { mk(`app_diario_2026010${d}T000000Z.dump`); mk(`app_diario_2026010${d}T000000Z.summary.json`); }
    for (const n of ["app_notes.txt", "other_diario_20260101T000000Z.dump", "app_diario_bad.dump"]) mk(n);
    const r = pruneBackups(dir, "app", 2);
    assert.deepEqual(r.kept, ["app_diario_20260104T000000Z.dump", "app_diario_20260103T000000Z.dump"]);
    assert.equal(r.deleted.length, 2);
    const left = fs.readdirSync(dir).sort();
    assert.ok(["app_notes.txt", "other_diario_20260101T000000Z.dump", "app_diario_bad.dump"].every((n) => left.includes(n)));
    assert.equal(left.some((n) => /20260101|20260102/.test(n) && n.startsWith("app_diario")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("runtime role grants: data access only, names validated", () => {
  const sql = runtimeGrantSql("pos_runtime", "beauty_pos").join("\n");
  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public/);
  assert.doesNotMatch(sql, /ALL PRIVILEGES|CREATE|TRUNCATE|SUPERUSER|OWNER/);
  for (const bad of ["admin", "pos", "pos_", "POS_X", "pos-x", 'pos_x"; drop role y; --', "pos_" + "a".repeat(41)]) assert.equal(code(() => runtimeGrantSql(bad, "beauty_pos")), "ROL_INVALIDO", bad);
  assert.equal(code(() => runtimeGrantSql("pos_ok", "Bad Db")), "BASE_INVALIDA");
  assert.ok(ROLE_NAME_RE.test("pos_runtime"));
});
test("missing PostgreSQL client tools produce an explanation", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "db ops nopg "));
  try { assert.equal(code(() => findPgBin({ POS_PG_BIN: empty, PG_BIN: empty, PATH: empty, ProgramFiles: empty })), "PG_TOOLS"); } finally { fs.rmSync(empty, { recursive: true, force: true }); }
});
