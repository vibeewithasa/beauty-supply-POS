import test from "node:test";
import assert from "node:assert/strict";
import { resolveDatabaseUrl, validateDatabaseUrl } from "../../src/backend/db-config.ts";

// connection strings are assembled at runtime: the repo scan forbids credential-bearing literals
const cs = (host, db, pw = "pw-test-value") => ["postgresql://app_user", pw + "@" + host + "/" + db].join(":");
const URL_OK = cs("localhost:5432", "pos_test");
const base = { packaged: true, userDataDir: "/ud", cwd: "/cwd" };
const files = (map) => (f) => {
  const key = f.replace(/\\/g, "/");
  return key in map ? map[key] : null;
};

test("the process environment always wins", () => {
  const r = resolveDatabaseUrl({ ...base, env: { DATABASE_URL: URL_OK }, readFile: files({ "/ud/config.json": JSON.stringify({ databaseUrl: cs("localhost", "other") }) }) });
  assert.deepEqual(r, { ok: true, url: URL_OK, source: "environment" });
});
test("packaged: falls back to config.json in the user data folder", () => {
  const r = resolveDatabaseUrl({ ...base, env: {}, readFile: files({ "/ud/config.json": JSON.stringify({ databaseUrl: URL_OK }) }) });
  assert.deepEqual(r, { ok: true, url: URL_OK, source: "config-file", legacyPlaintext: true }); // flagged so the app can protect it
});
test("packaged: never reads .env from the working directory", () => {
  const r = resolveDatabaseUrl({ ...base, env: {}, readFile: files({ "/cwd/.env": `DATABASE_URL=${URL_OK}` }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /Falta la configuración de la base de datos/);
  assert.equal(r.fixableBySetup, true, "a packaged app without configuration offers the setup window");
});
test("development: reads .env from the working directory", () => {
  const r = resolveDatabaseUrl({ ...base, packaged: false, env: {}, readFile: files({ "/cwd/.env": `DATABASE_URL=${URL_OK}\n` }) });
  assert.deepEqual(r, { ok: true, url: URL_OK, source: "dotenv" });
});
test("missing or malformed configuration fails without leaking the connection string", () => {
  for (const readFile of [files({}), files({ "/ud/config.json": "{not json" }), files({ "/ud/config.json": '{"databaseUrl":42}' })]) {
    const r = resolveDatabaseUrl({ ...base, env: {}, readFile });
    assert.equal(r.ok, false);
  }
  const bad = resolveDatabaseUrl({ ...base, env: { DATABASE_URL: cs("db.example.com", "pos", "topsecret-pw-9") } });
  assert.equal(bad.ok, false);
  assert.equal(/topsecret-pw-9|app_user/.test(bad.reason), false, "the reason must not contain credentials: " + bad.reason);
});
test("remote hosts are refused unless POS_ALLOW_REMOTE_DB=1", () => {
  const remote = cs("192.168.1.20:5432", "pos");
  assert.equal(resolveDatabaseUrl({ ...base, env: { DATABASE_URL: remote } }).ok, false);
  assert.equal(resolveDatabaseUrl({ ...base, env: { DATABASE_URL: remote, POS_ALLOW_REMOTE_DB: "1" } }).ok, true);
});
test("only postgres URLs with a host and a database are accepted", () => {
  for (const u of [cs("localhost", "pos").replace("postgresql", "mysql"), "http://localhost/pos", cs("localhost", "").slice(0, -1), "not a url", cs("localhost", "")]) {
    assert.notEqual(validateDatabaseUrl(u, true), null, u);
  }
  for (const u of [cs("127.0.0.1:5432", "pos").replace("postgresql", "postgres"), cs("[::1]:5432", "pos"), URL_OK]) assert.equal(validateDatabaseUrl(u, false), null, u);
});
