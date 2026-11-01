import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HBA_TEXT, MARKER_FILE, ManagedError, auditClusterConfig, layoutFor, managedConf, randomSecret, readManifest, scrubSecrets, verifyTree, writeManifest } from "../../scripts/lib/managed-pg.mjs";
import { MODES, validateInputs } from "../../scripts/lib/provision.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "pos-unit-mpg-"));

test("layout keeps everything under one root and the superuser secret apart from the application config", () => {
  const l = layoutFor("C:/x/Estetica Leal POS");
  for (const p of [l.manifest, l.adminSecret, l.runtimeBase, l.data, l.logs, l.backups, l.tmp]) assert.ok(p.startsWith(path.resolve("C:/x/Estetica Leal POS")), p);
  assert.notEqual(l.adminSecret, l.manifest);
});

test("the generated configuration listens on loopback only, uses SCRAM and never logs statements", () => {
  const c = managedConf({ port: 55432, logsDir: "C:\\r\\logs\\postgres", timezone: "America/Mexico_City" });
  assert.match(c, /^listen_addresses = '127\.0\.0\.1'$/m);
  assert.match(c, /^port = 55432$/m);
  assert.match(c, /^password_encryption = 'scram-sha-256'$/m);
  assert.match(c, /^log_min_error_statement = panic$/m, "a failed CREATE ROLE must not copy its password into the log");
  assert.match(c, /^log_statement = 'none'$/m);
  assert.match(c, /^log_directory = 'C:\/r\/logs\/postgres'$/m);
  assert.match(c, /timezone = 'America\/Mexico_City'/);
  assert.doesNotMatch(c, /0\.0\.0\.0|\*/);
});

test("pg_hba has a single loopback SCRAM rule and the audit rejects trust, md5, wider networks and other methods", () => {
  const dir = tmp();
  try {
    const l = layoutFor(dir);
    fs.mkdirSync(l.data, { recursive: true });
    fs.writeFileSync(path.join(l.data, "postgresql.conf"), "# >>> Estetica Leal POS (managed block: do not edit) >>>\nlisten_addresses = '127.0.0.1'\n# <<< Estetica Leal POS <<<\n");
    fs.writeFileSync(path.join(l.data, "pg_hba.conf"), HBA_TEXT);
    assert.deepEqual(auditClusterConfig(l), []);
    for (const bad of ["host all all 127.0.0.1/32 trust", "host all all 127.0.0.1/32 md5", "host all all 0.0.0.0/0 scram-sha-256", "host all all ::1/128 scram-sha-256", "local all all scram-sha-256", "hostssl all all 127.0.0.1/32 scram-sha-256"]) {
      fs.writeFileSync(path.join(l.data, "pg_hba.conf"), HBA_TEXT + bad + "\n");
      assert.equal(auditClusterConfig(l).length, 1, bad);
    }
    fs.writeFileSync(path.join(l.data, "pg_hba.conf"), HBA_TEXT);
    fs.writeFileSync(path.join(l.data, "postgresql.conf"), "# >>> Estetica Leal POS (managed block: do not edit) >>>\nlisten_addresses = '*'\n# <<< Estetica Leal POS <<<\n");
    assert.equal(auditClusterConfig(l).length, 1, "listening on every interface is flagged");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the manifest is written atomically, read back, and a damaged or foreign file is rejected, not trusted", () => {
  const dir = tmp();
  try {
    const l = layoutFor(path.join(dir, "root"));
    assert.equal(readManifest(l), null);
    const m = { schema: 1, installId: "123e4567-e89b-12d3-a456-426614174000", state: "ready", postgres: { port: 55432 } };
    writeManifest(l, m);
    assert.deepEqual(readManifest(l), m);
    assert.deepEqual(fs.readdirSync(l.root), ["installation.json"], "no temp file left behind");
    for (const bad of ["{not json", JSON.stringify({ ...m, schema: 2 }), JSON.stringify({ ...m, installId: "x" }), JSON.stringify({ ...m, state: "weird" }), JSON.stringify({ ...m, postgres: {} })]) {
      fs.writeFileSync(l.manifest, bad);
      assert.throws(() => readManifest(l), (e) => e instanceof ManagedError && /^MANIFIESTO_/.test(e.code), bad);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scrubSecrets removes passwords, PINs, their URL-encoded form and connection strings", () => {
  const t = scrubSecrets("fallo con S3cr3t! y 482913 en postgres" + "://u:S3cr3t%21@127.0.0.1:55432/db y postgresql" + "://a:b@h/x", ["S3cr3t!", "482913", "ab"]);
  assert.doesNotMatch(t, /S3cr3t|482913|%21|u:S3|a:b@/);
  assert.match(t, /\*\*\*/);
  assert.equal(scrubSecrets("sin nada", [undefined, "", "ab"]), "sin nada", "empty or very short values are ignored");
});

test("random secrets are long, URL-safe and different every time", () => {
  const s = new Set(Array.from({ length: 50 }, () => randomSecret()));
  assert.equal(s.size, 50);
  for (const v of s) assert.match(v, /^[A-Za-z0-9_-]{32}$/);
});

test("verifyTree reports missing, resized, altered and extra files against the bundle manifest", () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, "bin"));
    fs.writeFileSync(path.join(dir, "bin", "a.exe"), "AAAA");
    fs.writeFileSync(path.join(dir, "bin", "b.dll"), "BBBB");
    const sha = (t) => crypto.createHash("sha256").update(t).digest("hex");
    const bm = { files: [{ path: "bin/a.exe", size: 4, sha256: sha("AAAA") }, { path: "bin/b.dll", size: 4, sha256: sha("BBBB") }] };
    assert.deepEqual(verifyTree(dir, bm), []);
    fs.writeFileSync(path.join(dir, "bin", "b.dll"), "BBBX");
    assert.deepEqual(verifyTree(dir, bm), ["hash distinto: bin/b.dll"]);
    fs.writeFileSync(path.join(dir, "bin", "b.dll"), "BB");
    assert.deepEqual(verifyTree(dir, bm), ["tamaño distinto: bin/b.dll"]);
    fs.rmSync(path.join(dir, "bin", "b.dll"));
    fs.writeFileSync(path.join(dir, "bin", "evil.dll"), "x");
    assert.deepEqual(verifyTree(dir, bm).sort(), ["archivo extra: bin/evil.dll", "falta bin/b.dll"]);
    assert.deepEqual(verifyTree(dir, bm, { only: ["bin/a.exe"] }), [], "a quick check looks only at the named files");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("installation inputs: PINs 6-8 digits and different in demonstration mode; name and PIN in clean mode; unknown modes refused", () => {
  assert.doesNotThrow(() => validateInputs("demo", { adminPin: "482913", vendorPin: "715304" }));
  assert.doesNotThrow(() => validateInputs("clean", { adminName: "Ana", adminPin: "482913" }));
  for (const [m, i] of [["demo", { adminPin: "1234", vendorPin: "715304" }], ["demo", { adminPin: "482913", vendorPin: "482913" }], ["clean", { adminName: " ", adminPin: "482913" }], ["clean", { adminName: "A\u0000", adminPin: "482913" }], ["clean", { adminName: "Ana", adminPin: "98765" }], ["clean", { adminName: "x".repeat(121), adminPin: "482913" }], ["root", {}], [undefined, {}]]) {
    assert.throws(() => validateInputs(m, i), undefined, JSON.stringify([m, i]));
  }
});

test("each mode has its own database and role names, and neither is a protected or shared name", () => {
  assert.notEqual(MODES.demo.database, MODES.clean.database);
  assert.notEqual(MODES.demo.role, MODES.clean.role);
  for (const v of Object.values(MODES)) {
    assert.match(v.database, /^[a-z][a-z0-9_]{2,62}$/);
    assert.match(v.role, /^pos_[a-z0-9_]{2,40}$/);
    assert.ok(!["beauty_pos", "beauty_pos_smoke", "postgres"].includes(v.database));
  }
  assert.ok(MARKER_FILE.endsWith(".json"));
});
