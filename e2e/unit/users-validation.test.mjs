import test from "node:test";
import assert from "node:assert/strict";
import { parseUserCreate, parseUserUpdate, parseUserId } from "../../src/backend/users-validation.ts";

const code = (re) => (e) => re.test(e.message);
const ok = (o = {}) => ({ name: "  Ana  ", role: "vendor", pin: "1234", ...o });

test("create: normalizes a valid user", () => {
  assert.deepEqual(parseUserCreate(ok()), { name: "Ana", role: "vendor", pin: "1234" });
  assert.equal(parseUserCreate(ok({ role: "admin" })).role, "admin");
  assert.equal(parseUserCreate(ok({ pin: "0000" })).pin, "0000", "format only: weak-PIN policy is a product decision");
});

test("create: names, roles and pins", () => {
  for (const name of ["", "  ", "x".repeat(121), "a\u0000b", "a\nb", 5, null, undefined]) assert.throws(() => parseUserCreate(ok({ name })), code(/NOMBRE_INVALIDO/));
  for (const role of ["superuser", "ADMIN", "", null, undefined, 1]) assert.throws(() => parseUserCreate(ok({ role })), code(/ROL_INVALIDO/));
  for (const pin of ["123", "99999", "abcd", "12 4", "١٢٣٤", 1234, null, undefined, "1234 ", " 1234"]) assert.throws(() => parseUserCreate(ok({ pin })), code(/PIN_INVALIDO/), String(pin));
});

test("create/update: only name, role and pin exist in the contract", () => {
  for (const extra of [{ active: false }, { id: 1 }, { pinHash: "x" }, { isAdmin: true }, { createdAt: "x" }]) {
    assert.throws(() => parseUserCreate(ok(extra)), code(/CAMPO_NO_PERMITIDO/));
    assert.throws(() => parseUserUpdate(ok(extra)), code(/CAMPO_NO_PERMITIDO/));
  }
  for (const bad of [null, undefined, 5, "x", []]) {
    assert.throws(() => parseUserCreate(bad), code(/USUARIO_INVALIDO/));
    assert.throws(() => parseUserUpdate(bad), code(/USUARIO_INVALIDO/));
  }
});

test("update: pin is optional (undefined/null/empty keep the current one) but validated when sent", () => {
  assert.equal(parseUserUpdate({ name: "A", role: "admin" }).pin, null);
  assert.equal(parseUserUpdate({ name: "A", role: "admin", pin: "" }).pin, null);
  assert.equal(parseUserUpdate({ name: "A", role: "admin", pin: null }).pin, null);
  assert.equal(parseUserUpdate({ name: "A", role: "admin", pin: "4321" }).pin, "4321");
  assert.throws(() => parseUserUpdate({ name: "A", role: "admin", pin: "99" }), code(/PIN_INVALIDO/));
  assert.throws(() => parseUserUpdate({ role: "admin" }), code(/NOMBRE_INVALIDO/));
  assert.throws(() => parseUserUpdate({ name: "A" }), code(/ROL_INVALIDO/));
});

test("user ids", () => {
  assert.equal(parseUserId(7), 7);
  for (const v of [0, -1, 1.5, "1", null, undefined, NaN]) assert.throws(() => parseUserId(v), code(/USUARIO_INVALIDO/));
});
