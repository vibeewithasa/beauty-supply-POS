import test from "node:test";
import assert from "node:assert/strict";
import { AuthError, BusinessError } from "../../src/backend/errors.ts";
import { guarded, redact, describeUnexpected, isPublicError, INTERNAL_ERROR_MESSAGE } from "../../src/backend/ipc-errors.ts";

const sqlError = () => {
  const e = new Error('Failed query: insert into "cash_movements" ("id", "pin_hash") values (default, $1)\nparams: 1234,5f4dcc3b5aa765d61d8327deb882cf995f4dcc3b5aa765d61d8327deb882cf99');
  e.cause = new Error("connect to " + ["postgres:", "", "admin:s3cr3t@localhost:5432/beauty_pos"].join("/") + " failed"); // built at runtime: no credential-looking literal in the source
  return e;
};

test("business and auth errors pass through untouched", async () => {
  const b = new BusinessError("STOCK_INSUFICIENTE", "no hay");
  const a = new AuthError("Sesión no válida");
  for (const e of [b, a]) {
    await assert.rejects(guarded("x", () => { throw e; }, () => assert.fail("must not log")), (got) => got === e);
    assert.ok(isPublicError(e));
  }
});

test("an unexpected error becomes the stable generic error and is logged, redacted", async () => {
  const lines = [];
  await assert.rejects(guarded("sales:create", async () => { throw sqlError(); }, (l) => lines.push(l), ["s3cr3t"]), (got) => {
    assert.equal(got.message, INTERNAL_ERROR_MESSAGE);
    assert.match(got.message, /^\[ERROR_INTERNO\]/);
    assert.doesNotMatch(got.message, /insert|cash_movements|postgres|params|s3cr3t/i);
    return true;
  });
  assert.equal(lines.length, 1);
  const log = lines[0];
  assert.match(log, /unexpected error in sales:create/);
  assert.match(log, /cash_movements/, "keeps the SQL object name for diagnostics");
  assert.doesNotMatch(log, /s3cr3t|postgres:\/\/admin|1234|5f4dcc3b/, "no credentials, parameters or hashes: " + log);
  assert.match(log, /params: <redacted>/);
});

test("non-Error throwables are handled too", async () => {
  for (const thrown of ["boom", 42, null, undefined, { code: "23505" }]) {
    await assert.rejects(guarded("c", () => { throw thrown; }, () => {}), (got) => got.message === INTERNAL_ERROR_MESSAGE);
  }
});

test("a successful call returns its value (sync and async)", async () => {
  assert.equal(await guarded("c", () => 5, () => {}), 5);
  assert.equal(await guarded("c", async () => "ok", () => {}), "ok");
});

test("redact removes URLs, parameters, hashes, password-like assignments and listed secrets", () => {
  const t = redact("url=" + ["postgres:", "", "u:p@h/db"].join("/") + " pwd=hunter2 password: abc123 pin_hash=deadbeef\nparams: 1,2,3\nsecretvalue here", ["secretvalue"]);
  for (const leaked of ["u:p@h", "hunter2", "abc123", "deadbeef", "1,2,3", "secretvalue"]) assert.ok(!t.includes(leaked), leaked + " leaked in: " + t);
  assert.ok(redact("a".repeat(64)).includes("<hash>"));
  assert.equal(redact("nothing sensitive"), "nothing sensitive");
});

test("the log entry is size-limited", () => {
  assert.ok(describeUnexpected("c", new Error("x".repeat(20000))).length <= 4000);
});
