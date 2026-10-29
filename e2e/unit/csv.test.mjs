import test from "node:test";
import assert from "node:assert/strict";
import { csvCell, toCsv } from "../../src/renderer/lib/csv.ts";

test("plain values, numbers and empties", () => {
  assert.equal(csvCell("abc"), "abc");
  assert.equal(csvCell(12.5), "12.5");
  assert.equal(csvCell(-3), "-3", "negative numbers are numbers");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});
test("quotes, commas, semicolons and line breaks are escaped", () => {
  assert.equal(csvCell('di "hola"'), '"di ""hola"""');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("a;b"), '"a;b"');
  assert.equal(csvCell("a\nb"), '"a\nb"');
});
test("formula injection is neutralized", () => {
  for (const evil of ["=1+1", "+SUM(A1)", "-2+3", "@cmd", "\t=1"]) assert.ok(csvCell(evil).startsWith("'") || csvCell(evil).startsWith("\"'"), evil);
  assert.equal(csvCell("normal = text"), "normal = text");
});
test("rows are CRLF separated and end with a newline", () => {
  assert.equal(toCsv([["a", "b"], [1, "x,y"]]), 'a,b\r\n1,"x,y"\r\n');
});
