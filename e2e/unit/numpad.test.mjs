import test from "node:test";
import assert from "node:assert/strict";
import { applyKey, numpadMode, clampPosition, defaultPosition, parsePref, serializePref, DEFAULT_PREF, EDGE } from "../../src/renderer/lib/numpad.ts";

// ten different digits and the nine that fit, built (not typed) so no literal run of digits sits in a versioned file
const TEN = Array.from({ length: 10 }, (_, i) => String(((i + 1) * 7) % 10));
const NINE = TEN.slice(0, 9).join("");
const f = (value, o = {}) => ({ value, selStart: null, selEnd: null, replace: false, ...o });
const type = (keys, mode, start = "", replace = false) => {
  let st = { value: start, caret: start.length };
  let rep = replace;
  for (const k of keys) {
    st = applyKey(f(st.value, { selStart: st.caret, selEnd: st.caret, replace: rep }), k, mode);
    rep = false;
  }
  return st.value;
};

test("integer: digits append, no decimal point, no leading zeros", () => {
  assert.equal(type(["1", "2", "3"], "integer"), "123");
  assert.equal(type([".", "5"], "integer"), "5"); // '.' is ignored where decimals do not apply
  assert.equal(type(["0", "0", "7"], "integer"), "7");
  assert.equal(type(["0"], "integer"), "0");
  assert.equal(type(["1", "0"], "integer"), "10");
});

test("decimal: one point, at most two decimals, '.' first becomes 0.", () => {
  assert.equal(type(["1", ".", "5", "0"], "decimal"), "1.50");
  assert.equal(type(["1", ".", "5", "0", "9"], "decimal"), "1.50"); // third decimal refused
  assert.equal(type(["1", ".", "5", "."], "decimal"), "1.5"); // second point refused
  assert.equal(type(["."], "decimal"), "0.");
  assert.equal(type([".", "5"], "decimal"), "0.5");
  assert.equal(type(["0", "0", ".", "2"], "decimal"), "0.2");
  assert.equal(type(["0", "5"], "decimal"), "5");
});

test("length is capped like the screens' own validation (9 integer digits)", () => {
  assert.equal(type(TEN, "integer"), NINE);
  assert.equal(type(TEN, "decimal"), NINE);
  assert.equal(type([".", "9", "9"], "decimal", NINE), NINE + ".99");
});

test("backspace and clear", () => {
  assert.equal(type(["backspace"], "integer", "123"), "12");
  assert.equal(type(["backspace", "backspace", "backspace", "backspace"], "integer", "12"), "");
  assert.equal(type(["backspace"], "decimal", "1.5"), "1.");
  assert.equal(applyKey(f("98.5"), "clear", "decimal").value, "");
  assert.equal(applyKey(f(""), "backspace", "integer").value, "");
});

test("the first key after focus replaces the content (a quantity of 1 typed over with 5 is 5, not 15)", () => {
  assert.equal(type(["5"], "integer", "1", true), "5");
  assert.equal(type([".", "5"], "decimal", "20.00", true), "0.5");
  assert.equal(type(["backspace"], "integer", "15", true), ""); // replace + backspace empties the field
});

test("selection and caret are respected where the input exposes them", () => {
  assert.deepEqual(applyKey(f("123", { selStart: 1, selEnd: 1 }), "9", "integer"), { value: "1923", caret: 2 });
  assert.deepEqual(applyKey(f("123", { selStart: 1, selEnd: 3 }), "9", "integer"), { value: "19", caret: 2 });
  assert.deepEqual(applyKey(f("123", { selStart: 2, selEnd: 2 }), "backspace", "integer"), { value: "13", caret: 1 });
  assert.deepEqual(applyKey(f("123", { selStart: 0, selEnd: 2 }), "backspace", "integer"), { value: "3", caret: 0 });
  assert.deepEqual(applyKey(f("12", { selStart: 0, selEnd: 0 }), "0", "integer"), { value: "12", caret: 0 }); // 012 -> 12, caret stays before the 1
  assert.deepEqual(applyKey(f("5", { selStart: 0, selEnd: 0 }), ".", "decimal"), { value: "0.5", caret: 2 });
});

test("a refused key changes nothing", () => {
  assert.deepEqual(applyKey(f("1.50"), "9", "decimal"), { value: "1.50", caret: 4 });
  for (const bad of ["a", "-", "+", "e", "", "Enter", "10"]) assert.equal(applyKey(f("7"), bad, "integer").value, "7");
});

test("numpadMode: only fields that opted in, never password / read-only / disabled / ignored", () => {
  const t = (o = {}) => ({ numpad: "integer", type: "text", readOnly: false, disabled: false, ignored: false, ...o });
  assert.equal(numpadMode(t()), "integer");
  assert.equal(numpadMode(t({ numpad: "decimal", type: "number" })), "decimal");
  for (const numpad of [null, "", "text", "Integer", "yes"]) assert.equal(numpadMode(t({ numpad })), null, String(numpad));
  assert.equal(numpadMode(t({ type: "password" })), null);
  assert.equal(numpadMode(t({ readOnly: true })), null);
  assert.equal(numpadMode(t({ disabled: true })), null);
  assert.equal(numpadMode(t({ ignored: true })), null);
});

test("clampPosition keeps the keypad fully inside the window", () => {
  assert.deepEqual(clampPosition(100, 100, 232, 372, 1024, 768), { x: 100, y: 100 });
  assert.deepEqual(clampPosition(-50, -50, 232, 372, 1024, 768), { x: EDGE, y: EDGE });
  assert.deepEqual(clampPosition(5000, 5000, 232, 372, 1024, 768), { x: 1024 - 232 - EDGE, y: 768 - 372 - EDGE });
  // a window smaller than the keypad pins it to the top-left instead of pushing it off-screen
  assert.deepEqual(clampPosition(300, 300, 232, 372, 200, 300), { x: EDGE, y: EDGE });
  for (const [vw, vh] of [[1024, 768], [1366, 768], [1920, 1080]]) {
    const d = defaultPosition(232, 372, vw, vh);
    assert.ok(d.x >= EDGE && d.y >= EDGE && d.x + 232 <= vw && d.y + 372 <= vh, `${vw}x${vh}`);
    assert.ok(d.x + 232 < vw / 2, `${vw}x${vh}: starts on the left, clear of the cart and the Pay button`);
  }
});

test("preference: off by default; corrupt, hostile or partial stored data falls back safely", () => {
  assert.deepEqual(DEFAULT_PREF, { enabled: false, minimized: false, x: null, y: null });
  for (const raw of [null, undefined, "", "not json", "[]", "null", "5", '"x"', "{"]) assert.deepEqual(parsePref(raw), DEFAULT_PREF, String(raw));
  assert.equal(parsePref('{"enabled":"true"}').enabled, false); // only a real boolean enables it
  assert.equal(parsePref('{"enabled":1}').enabled, false);
  assert.deepEqual(parsePref('{"enabled":true,"x":"a","y":5}'), { enabled: true, minimized: false, x: null, y: null });
  assert.deepEqual(parsePref('{"enabled":true,"x":1e9,"y":5}'), { enabled: true, minimized: false, x: null, y: null });
  const p = { enabled: true, minimized: true, x: 40, y: 80 };
  assert.deepEqual(parsePref(serializePref(p)), p);
});
