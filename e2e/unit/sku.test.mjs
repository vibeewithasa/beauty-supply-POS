import test from "node:test";
import assert from "node:assert/strict";
import { formatSku, SKU_PREFIX } from "../../src/backend/sku.ts";

test("formatSku: EL- plus six digits", () => {
  assert.equal(formatSku(1), "EL-000001");
  assert.equal(formatSku(42), "EL-000042");
  assert.equal(formatSku(999999), "EL-999999");
  assert.equal(SKU_PREFIX, "EL-");
});

test("formatSku: ids past six digits grow instead of wrapping or truncating", () => {
  assert.equal(formatSku(1000000), "EL-1000000");
  assert.ok(formatSku(Number.MAX_SAFE_INTEGER).length <= 64);
});

test("formatSku: distinct ids give distinct SKUs and every one is accepted by the legacy SKU alphabet", () => {
  const seen = new Set();
  for (let i = 1; i <= 5000; i++) {
    const s = formatSku(i);
    assert.ok(!seen.has(s));
    seen.add(s);
    assert.match(s, /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,63}$/);
  }
});

test("formatSku: rejects ids that are not positive safe integers", () => {
  for (const bad of [0, -1, 1.5, NaN, Infinity, "1", null, undefined, 2 ** 60]) assert.throws(() => formatSku(bad));
});
