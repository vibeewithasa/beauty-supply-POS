import test from "node:test";
import assert from "node:assert/strict";
import { toCents, centsFromDb, centsToDb, MAX_CENTS } from "../../src/backend/money.ts";

const rejects = (fn, re = /IMPORTE_INVALIDO/) => assert.throws(fn, re);

test("toCents: exact conversion, including classic float traps", () => {
  assert.equal(toCents(65, "x"), 6500);
  assert.equal(toCents(10.5, "x"), 1050);
  assert.equal(toCents(0.1 + 0.2, "x"), 30); // 0.30000000000000004
  assert.equal(toCents(1.15, "x"), 115);
  assert.equal(toCents(19.99, "x"), 1999);
  assert.equal(toCents("12.3", "x"), 1230);
  assert.equal(toCents("0.07", "x"), 7);
  assert.equal(toCents(0, "x"), 0);
});

test("toCents: rejects NaN, Infinity, negatives, extra decimals, junk and out of range", () => {
  for (const v of [NaN, Infinity, -Infinity, -1, -0.01, 0.001, 1.005, "1.234", "abc", "", "-5", "1e3", null, undefined, {}, [], true]) {
    rejects(() => toCents(v, "x"));
  }
  rejects(() => toCents((MAX_CENTS + 1) / 100, "x"));
  assert.equal(toCents(MAX_CENTS / 100, "x"), MAX_CENTS);
});

test("toCents: allowZero:false requires a positive amount", () => {
  rejects(() => toCents(0, "monto", { allowZero: false }));
  assert.equal(toCents(0.01, "monto", { allowZero: false }), 1);
});

test("centsFromDb / centsToDb round trip numeric(12,2) strings", () => {
  for (const s of ["0.00", "0.07", "65.00", "10.50", "9999999999.99"]) assert.equal(centsToDb(centsFromDb(s)), s);
  assert.equal(centsFromDb("65"), 6500);
  assert.equal(centsFromDb("-4.50"), -450);
  assert.equal(centsToDb(-450), "-4.50");
  assert.equal(centsToDb(5), "0.05");
  assert.throws(() => centsToDb(1.5));
});

test("sums of cents stay exact where floats drift", () => {
  const prices = ["0.10", "0.20", "19.99", "0.07"];
  const cents = prices.map(centsFromDb).reduce((a, b) => a + b, 0);
  assert.equal(cents, 2036);
  assert.equal(centsToDb(cents * 3), "61.08");
});
