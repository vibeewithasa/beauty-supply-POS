import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildUrl, partsFromUrl, readConfigFile, upgradeLegacyConfig, validParts, writeConfigV2 } from "../../src/backend/config-store.ts";
import { resolveDatabaseUrl } from "../../src/backend/db-config.ts";

// A fake "protected storage": reversible, NOT secret, only to prove the flow. available/fail are switchable.
const fakeCipher = (state = { available: true, failDecrypt: false }) => ({
  state,
  available: () => state.available,
  encrypt(plain) {
    if (!state.available) throw new Error("no encryption");
    return Buffer.from("BLOB:" + [...plain].reverse().join("")).toString("base64");
  },
  decrypt(blob) {
    if (!state.available || state.failDecrypt) throw new Error("cannot decrypt");
    return [...Buffer.from(blob, "base64").toString().replace(/^BLOB:/, "")].reverse().join("");
  },
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "config-store-"));
const PARTS = { host: "localhost", port: 5432, database: "pos_test", user: "pos_runtime" };
const SECRET = "p@ss:w/rd#%9Z space"; // awkward characters on purpose; assembled here, never a real credential

test("the url is built with the password percent-encoded and parses back to the same parts and password", () => {
  const url = buildUrl(PARTS, SECRET);
  assert.ok(url.startsWith("postgresql://pos_runtime:") && url.endsWith("@localhost:5432/pos_test"));
  assert.equal(new URL(url).password.includes("@"), false, "the @ of the password is encoded");
  assert.deepEqual(partsFromUrl(url), { parts: PARTS, password: SECRET });
  assert.deepEqual(partsFromUrl(buildUrl(PARTS, null)), { parts: PARTS, password: null });
  assert.equal(partsFromUrl("http://x/y"), null);
  assert.equal(partsFromUrl("not a url"), null);
});

test("connection parts are validated (no injection through host, database or user)", () => {
  assert.equal(validParts(PARTS), true);
  for (const bad of [{ ...PARTS, host: "" }, { ...PARTS, host: "a b" }, { ...PARTS, host: "h/../x" }, { ...PARTS, port: 0 }, { ...PARTS, port: 70000 }, { ...PARTS, port: 5432.5 }, { ...PARTS, port: "5432" }, { ...PARTS, database: "" }, { ...PARTS, database: "x'; drop" }, { ...PARTS, database: "a/b" }, { ...PARTS, user: "u\nx" }, null, 5]) {
    assert.equal(validParts(bad), false, JSON.stringify(bad));
  }
});

test("writing stores the password ONLY encrypted and what is on disk decrypts back", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  const cipher = fakeCipher();
  assert.deepEqual(writeConfigV2(file, PARTS, SECRET, cipher), { ok: true });
  const text = fs.readFileSync(file, "utf8");
  assert.equal(text.includes(SECRET), false, "no plain-text password in the file");
  assert.equal(text.includes(encodeURIComponent(SECRET)), false, "nor an encoded one");
  assert.equal(/databaseUrl|postgres(ql)?:\/\//.test(text), false, "no connection string in the file");
  const cfg = readConfigFile(file);
  assert.equal(cfg.kind, "v2");
  assert.deepEqual(cfg.parts, PARTS);
  assert.equal(cipher.decrypt(cfg.passwordEncrypted), SECRET);
  assert.deepEqual(fs.readdirSync(dir), ["config.json"], "no temporary file is left behind");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("without protected storage nothing is written (never a plain-text fallback) and an existing file is untouched", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  const cipher = fakeCipher({ available: false, failDecrypt: false });
  const r = writeConfigV2(file, PARTS, SECRET, cipher);
  assert.equal(r.ok, false);
  assert.equal(r.code, "NO_ENCRYPTION");
  assert.equal(fs.existsSync(file), false, "no file at all");
  fs.writeFileSync(file, '{"keep":"me"}');
  assert.equal(writeConfigV2(file, PARTS, SECRET, cipher).ok, false);
  assert.equal(fs.readFileSync(file, "utf8"), '{"keep":"me"}', "the previous file survives a refused write");
  // a password-less connection (trust authentication) needs no encryption
  assert.deepEqual(writeConfigV2(file, PARTS, null, cipher), { ok: true });
  assert.equal(readConfigFile(file).passwordEncrypted, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a failing or lying cipher is caught by the read-back verification and nothing is replaced", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  fs.writeFileSync(file, '{"databaseUrl":"postgresql://a@localhost/x"}');
  const lying = { available: () => true, encrypt: () => Buffer.from("garbage").toString("base64"), decrypt: () => "something else" };
  const r = writeConfigV2(file, PARTS, SECRET, lying);
  assert.equal(r.ok, false);
  assert.equal(r.code, "VERIFY_FAILED");
  assert.equal(fs.readFileSync(file, "utf8"), '{"databaseUrl":"postgresql://a@localhost/x"}', "the old file is intact");
  assert.deepEqual(fs.readdirSync(dir), ["config.json"], "the temporary file was removed");
  const throwing = { available: () => true, encrypt: () => { throw new Error("dpapi failed"); }, decrypt: () => "" };
  assert.equal(writeConfigV2(file, PARTS, SECRET, throwing).code, "NO_ENCRYPTION");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("readConfigFile tells none / invalid / legacy / v2 apart and never throws", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  assert.equal(readConfigFile(file).kind, "none");
  for (const bad of ["", "{", "null", "[]", "5", '{"nothing":1}', '{"version":2}', '{"version":2,"host":"h","port":1,"database":"d","user":"u","passwordEncrypted":"not base64!"}', '{"version":2,"host":"a b","port":1,"database":"d","user":"u"}']) {
    fs.writeFileSync(file, bad);
    assert.equal(readConfigFile(file).kind, "invalid", JSON.stringify(bad));
  }
  fs.writeFileSync(file, JSON.stringify({ databaseUrl: " postgresql://u@localhost/d " }));
  assert.deepEqual(readConfigFile(file), { kind: "legacy", url: "postgresql://u@localhost/d" });
  assert.equal(readConfigFile(file, () => { throw new Error("EACCES"); }).kind, "invalid");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a legacy plain-text file is upgraded in place, keeping the very same connection", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  const cipher = fakeCipher();
  const legacyUrl = buildUrl(PARTS, SECRET);
  fs.writeFileSync(file, JSON.stringify({ databaseUrl: legacyUrl }));
  assert.deepEqual(upgradeLegacyConfig(file, cipher), { status: "upgraded" });
  assert.equal(fs.readFileSync(file, "utf8").includes(SECRET), false, "the password is no longer in clear text anywhere in the file");
  const resolved = resolveDatabaseUrl({ env: {}, packaged: true, userDataDir: dir, cwd: "/x", cipher });
  assert.deepEqual(resolved, { ok: true, url: legacyUrl, source: "config-file" }, "same connection after the upgrade");
  assert.deepEqual(upgradeLegacyConfig(file, cipher), { status: "not-legacy" }, "idempotent");
  assert.deepEqual(fs.readdirSync(dir), ["config.json"], "no backup copy of the plain text was made");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the legacy file is kept (never lost, never half-written) when protection is not possible", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  const legacy = JSON.stringify({ databaseUrl: buildUrl(PARTS, SECRET) });
  fs.writeFileSync(file, legacy);
  assert.deepEqual(upgradeLegacyConfig(file, fakeCipher({ available: false, failDecrypt: false })), { status: "kept-plaintext", reason: "NO_ENCRYPTION" });
  assert.equal(fs.readFileSync(file, "utf8"), legacy);
  fs.writeFileSync(file, JSON.stringify({ databaseUrl: "mysql://nope" }));
  assert.deepEqual(upgradeLegacyConfig(file, fakeCipher()), { status: "kept-plaintext", reason: "FAILED" });
  assert.equal(fs.readFileSync(file, "utf8"), JSON.stringify({ databaseUrl: "mysql://nope" }));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("resolving a v2 file: decrypts, fails safely when it cannot, never leaks the secret in a reason", () => {
  const dir = tmp();
  const file = path.join(dir, "config.json");
  const cipher = fakeCipher();
  writeConfigV2(file, PARTS, SECRET, cipher);
  const ok = resolveDatabaseUrl({ env: {}, packaged: true, userDataDir: dir, cwd: "/x", cipher });
  assert.equal(ok.ok, true);
  assert.equal(ok.source, "config-file");
  assert.deepEqual(partsFromUrl(ok.url), { parts: PARTS, password: SECRET });
  for (const broken of [fakeCipher({ available: true, failDecrypt: true }), fakeCipher({ available: false, failDecrypt: false }), undefined]) {
    const r = resolveDatabaseUrl({ env: {}, packaged: true, userDataDir: dir, cwd: "/x", cipher: broken });
    assert.equal(r.ok, false);
    assert.equal(r.fixableBySetup, true);
    assert.match(r.reason, /no se puede descifrar con esta cuenta de Windows/);
    assert.equal(r.reason.includes(SECRET) || r.reason.includes("BLOB"), false, "no secret in the reason");
  }
  // the process environment still wins and is never stored
  const env = resolveDatabaseUrl({ env: { DATABASE_URL: buildUrl(PARTS, "other-secret-1") }, packaged: true, userDataDir: dir, cwd: "/x", cipher });
  assert.equal(env.source, "environment");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("POS_USE_CONFIG_FILE makes a development build use config.json instead of .env, and is the only difference", () => {
  const dir = tmp();
  const cipher = fakeCipher();
  writeConfigV2(path.join(dir, "config.json"), PARTS, SECRET, cipher);
  const readFile = (f) => (f.replace(/\\/g, "/").endsWith("/.env") ? "DATABASE_URL=postgresql://x@localhost/from_dotenv\n" : fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
  const dev = resolveDatabaseUrl({ env: {}, packaged: false, userDataDir: dir, cwd: "/cwd", readFile, cipher });
  assert.equal(dev.source, "dotenv");
  const viaFile = resolveDatabaseUrl({ env: { POS_USE_CONFIG_FILE: "1" }, packaged: false, userDataDir: dir, cwd: "/cwd", readFile, cipher });
  assert.equal(viaFile.source, "config-file");
  assert.equal(new URL(viaFile.url).pathname, "/pos_test");
  fs.rmSync(dir, { recursive: true, force: true });
});
