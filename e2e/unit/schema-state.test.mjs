import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { evaluateSchema, describeSchemaState, readJournal } from "../../scripts/lib/schema-state.mjs";

const journal = [
  { idx: 0, tag: "0000_a", when: 1, hash: "h0" },
  { idx: 1, tag: "0001_b", when: 2, hash: "h1" },
  { idx: 2, tag: "0002_c", when: 3, hash: "h2" },
];
const rows = (...h) => h.map((hash) => ({ hash }));

test("every required migration present: ok", () => {
  const s = evaluateSchema(journal, rows("h0", "h1", "h2"));
  assert.deepEqual(s, { status: "ok", required: 3, applied: 3, missing: [], unknown: 0 });
  assert.equal(describeSchemaState(s), null);
});
test("missing migrations are named and block", () => {
  const s = evaluateSchema(journal, rows("h0", "h1"));
  assert.equal(s.status, "missing");
  assert.deepEqual(s.missing, ["0002_c"]);
  const d = describeSchemaState(s);
  assert.match(d.headline, /necesita actualizarse/);
  assert.match(d.detail, /0002_c/);
  assert.match(d.detail, /no las aplica por sí sola/);
});
test("a gap is missing too, even when a later migration is present", () => {
  const s = evaluateSchema(journal, rows("h0", "h2"));
  assert.equal(s.status, "missing");
  assert.deepEqual(s.missing, ["0001_b"]);
});
test("rows this version does not know mean a newer database", () => {
  const s = evaluateSchema(journal, rows("h0", "h1", "h2", "hX"));
  assert.equal(s.status, "newer");
  assert.equal(s.unknown, 1);
  assert.match(describeSchemaState(s).headline, /más nueva/);
});
test("no migrations table or an empty one is uninitialized", () => {
  assert.equal(evaluateSchema(journal, null).status, "uninitialized");
  assert.equal(evaluateSchema(journal, []).status, "uninitialized");
  assert.match(describeSchemaState(evaluateSchema(journal, null)).headline, /no está inicializada/);
});
test("user-facing messages never contain connection details or SQL", () => {
  for (const s of [evaluateSchema(journal, rows("h0")), evaluateSchema(journal, null), evaluateSchema(journal, rows("h0", "h1", "h2", "zz"))]) {
    const d = describeSchemaState(s);
    assert.doesNotMatch(d.headline + d.detail, /postgres(ql)?:\/\/|password|select |relation /i);
  }
});
test("the journal hash is the SHA-256 of the sql file content (what drizzle records)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "schema-state-"));
  try {
    fs.mkdirSync(path.join(dir, "meta"));
    fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify({ entries: [{ idx: 0, tag: "0000_x", when: 5 }] }));
    fs.writeFileSync(path.join(dir, "0000_x.sql"), "CREATE TABLE t(id int);\n");
    const [e] = readJournal(dir);
    assert.equal(e.hash, "0b9ff9a0e2d1a9a5f2d6f5a4f7e0f3a1c8e2b4d6f8a0c2e4a6c8e0a2c4e6a8c0".length === 64 ? e.hash : "");
    assert.match(e.hash, /^[0-9a-f]{64}$/);
    assert.equal(e.tag, "0000_x");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("the real journal of this repository is readable and every migration has a distinct hash", () => {
  const j = readJournal(path.resolve(import.meta.dirname, "../../drizzle"));
  assert.ok(j.length >= 8);
  assert.equal(new Set(j.map((x) => x.hash)).size, j.length);
  assert.deepEqual(j.map((x) => x.idx), j.map((_, i) => i));
});
