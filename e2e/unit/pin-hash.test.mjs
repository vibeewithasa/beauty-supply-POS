import test from "node:test";
import assert from "node:assert/strict";
import { createHash, scryptSync } from "node:crypto";
import { hashPin, verifyPin, needsUpgrade, isLegacyHash, isScryptHash, SCRYPT_PARAMS, PIN_NEW_RE, PIN_LOGIN_RE, PIN_LEGACY_RE } from "../../src/backend/pin-hash.ts";

const sha = (p) => createHash("sha256").update(p).digest("hex");

test("hash format: scrypt with documented parameters, random salt per hash, nothing in clear", async () => {
  const h = await hashPin("246810");
  const parts = h.split("$");
  assert.equal(parts.length, 6);
  assert.deepEqual(parts.slice(0, 4), ["scrypt", String(SCRYPT_PARAMS.N), String(SCRYPT_PARAMS.r), String(SCRYPT_PARAMS.p)]);
  assert.ok(!h.includes("246810"));
  assert.ok(isScryptHash(h) && !isLegacyHash(h));
  const h2 = await hashPin("246810");
  assert.notEqual(h, h2, "same PIN, different salt, different hash");
  assert.notEqual(parts[4], h2.split("$")[4]);
  assert.equal(Buffer.from(parts[4], "base64url").length, SCRYPT_PARAMS.saltLen);
});

test("verify: correct and wrong PINs, both formats", async () => {
  const h = await hashPin("654321");
  assert.equal(await verifyPin("654321", h), true);
  for (const wrong of ["654322", "65432", "6543210", "", "abcdef"]) assert.equal(await verifyPin(wrong, h), false, wrong);
  assert.equal(await verifyPin("1234", sha("1234")), true, "legacy SHA-256 still verifies");
  assert.equal(await verifyPin("1235", sha("1234")), false);
});

test("the same PIN under different salts verifies against each hash independently", async () => {
  const [a, b] = [await hashPin("424242"), await hashPin("424242")];
  assert.notEqual(a, b);
  assert.ok((await verifyPin("424242", a)) && (await verifyPin("424242", b)));
});

test("malformed or hostile stored values never verify and never throw", async () => {
  const bad = [
    "", "x", "scrypt$", "scrypt$1$2$3$4$5", "scrypt$16384$8$1$AAAA$AAAA", "md5$abc", sha("1").toUpperCase(),
    "scrypt$3$8$1$" + "A".repeat(22) + "$" + "A".repeat(43),
    "scrypt$" + 2 ** 30 + "$8$1$" + "A".repeat(22) + "$" + "A".repeat(43),
    "scrypt$16384$99$1$" + "A".repeat(22) + "$" + "A".repeat(43),
    "scrypt$16384$8$99$" + "A".repeat(22) + "$" + "A".repeat(43),
  ];
  for (const s of bad) assert.equal(await verifyPin("246810", s), false, s.slice(0, 30));
});

test("needsUpgrade: legacy and weaker scrypt hashes, not current ones", async () => {
  assert.equal(needsUpgrade(sha("1234")), true);
  assert.equal(needsUpgrade(await hashPin("246810")), false);
  const salt = Buffer.alloc(16, 7);
  const weak = ["scrypt", 8192, 8, 1, salt.toString("base64url"), scryptSync("246810", salt, 32, { N: 8192, r: 8, p: 1 }).toString("base64url")].join("$");
  assert.equal(needsUpgrade(weak), true);
  assert.equal(await verifyPin("246810", weak), true, "old parameters still verify, so they can be upgraded in place");
  assert.equal(needsUpgrade("garbage"), false);
});

test("PIN policy regexes", () => {
  for (const ok of ["246810", "2468101", "24681012"]) assert.ok(PIN_NEW_RE.test(ok));
  for (const bad of ["1234", "24681", "246810121", "24681a", "", " 246810", "١٢٣٤٥٦"]) assert.ok(!PIN_NEW_RE.test(bad), bad);
  assert.ok(PIN_LEGACY_RE.test("0000") && !PIN_LEGACY_RE.test("00000"));
  for (const ok of ["1234", "24681", "246810", "24681012"]) assert.ok(PIN_LOGIN_RE.test(ok));
  for (const bad of ["123", "246810121", "12a4"]) assert.ok(!PIN_LOGIN_RE.test(bad));
});
