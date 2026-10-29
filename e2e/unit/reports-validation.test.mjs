import test from "node:test";
import assert from "node:assert/strict";
import { parseReportRange, MAX_REPORT_DAYS } from "../../src/backend/reports-validation.ts";

const code = (re) => (e) => re.test(e.message);

test("a valid range becomes local-day boundaries [from, to+1)", () => {
  const r = parseReportRange({ from: "2026-03-01", to: "2026-03-07" });
  assert.equal(r.days, 7);
  assert.equal(r.start.getDate(), 1);
  assert.equal(r.endExclusive.getDate(), 8);
  assert.equal(parseReportRange({ from: "2026-03-05", to: "2026-03-05" }).days, 1);
  assert.equal(parseReportRange({ from: "2026-02-28", to: "2026-03-01" }).days, 2);
});
test("malformed or impossible dates are rejected", () => {
  for (const bad of ["", "2026-3-1", "2026/03/01", "01-03-2026", "2026-13-01", "2026-02-30", "2026-04-31", "1999-12-31", "2101-01-01", "abc", null, undefined, 20260301]) {
    assert.throws(() => parseReportRange({ from: bad, to: "2026-03-07" }), code(/FECHA_INVALIDA/), String(bad));
    assert.throws(() => parseReportRange({ from: "2026-03-01", to: bad }), code(/FECHA_INVALIDA/), String(bad));
  }
  for (const bad of [null, undefined, "x", [], 5]) assert.throws(() => parseReportRange(bad), code(/FECHA_INVALIDA/));
});
test("inverted and oversized ranges are rejected", () => {
  assert.throws(() => parseReportRange({ from: "2026-03-07", to: "2026-03-01" }), code(/RANGO_INVALIDO/));
  assert.equal(parseReportRange({ from: "2026-01-01", to: "2026-12-31" }).days, 365);
  assert.throws(() => parseReportRange({ from: "2025-01-01", to: "2026-03-01" }), code(/RANGO_INVALIDO/));
  assert.equal(MAX_REPORT_DAYS, 366);
});
test("leap days are valid dates", () => {
  assert.equal(parseReportRange({ from: "2028-02-29", to: "2028-02-29" }).days, 1);
  assert.throws(() => parseReportRange({ from: "2027-02-29", to: "2027-03-01" }), code(/FECHA_INVALIDA/));
});
