// scripts/precheck-integrity.mjs must be strictly read-only. Static guarantees here; the dynamic proof
// (database identical before/after running it on a legacy copy) is e2e/migrations.mjs MIG-03.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = fs.readFileSync(new URL("../../scripts/precheck-integrity.mjs", import.meta.url), "utf8");
const sqlStrings = [...src.matchAll(/"((?:select|insert|update|delete|drop|alter|create|truncate|begin|rollback|commit|grant|set)\b[^"]*)"/gi)].map((m) => m[1]);

test("it opens a READ ONLY transaction and never commits", () => {
  assert.ok(/BEGIN READ ONLY/.test(src));
  assert.ok(/ROLLBACK/.test(src));
  assert.equal(/\bCOMMIT\b/i.test(src), false);
});
test("every SQL statement is a SELECT (or the READ ONLY transaction control)", () => {
  assert.ok(sqlStrings.length >= 17, "found the statements: " + sqlStrings.length);
  for (const q of sqlStrings) assert.match(q, /^(select\b|BEGIN READ ONLY$|ROLLBACK$)/i, q.slice(0, 60));
});
test("it prints counts only: no row contents are selected", () => {
  for (const q of sqlStrings.filter((x) => /^select/i.test(x))) assert.match(q, /count\(|current_database\(\)/i, q.slice(0, 60));
  assert.equal(/select\s+\*/i.test(src), false);
});
