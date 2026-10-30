// Static consistency: every IPC channel registered in main has an explicit access policy, nothing is
// registered outside the wrapper, and the preload only exposes channels that exist (deny by default).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL("../../" + p, import.meta.url), "utf8");
const ipc = read("src/backend/ipc.ts");
const auth = read("src/backend/auth.ts");
const preload = read("src/preload/preload.ts");

const policy = (() => {
  const block = ipc.match(/const ACCESS[^{]*\{([\s\S]*?)\n\};/)[1];
  return Object.fromEntries([...block.matchAll(/"([\w:]+)":\s*"(admin|authenticated)"/g)].map((m) => [m[1], m[2]]));
})();
const handled = [...ipc.matchAll(/\bhandle\(\s*"([\w:]+)"/g)].map((m) => m[1]);
const publicCh = [...auth.matchAll(/publicHandle\("([\w:]+)"/g)].map((m) => m[1]);
const used = [...preload.matchAll(/invoke\("([\w:]+)"/g)].map((m) => m[1]);

test("every handler registered in ipc.ts has a policy and vice versa", () => {
  assert.deepEqual([...handled].sort(), Object.keys(policy).sort());
  assert.equal(handled.length, 36);
});
test("admin-only channels are exactly the expected 19", () => {
  const admin = Object.entries(policy).filter(([, v]) => v === "admin").map(([k]) => k);
  assert.equal(admin.length, 19);
  for (const ch of admin) assert.match(ch, /^(products:(create|update|softDelete|listAdmin)|users:|inventory:|priceChanges:|reports:|dashboard:|settings:|receipts:listPrinters)/);
});
test("the only public channels are auth:login/me/logout and every registration goes through an error-guarded wrapper", () => {
  assert.deepEqual([...publicCh].sort(), ["auth:login", "auth:logout", "auth:me"]);
  assert.equal(/ipcMain\.handle/.test(ipc), false, "ipc.ts must register only through the secure wrapper");
  assert.equal([...auth.matchAll(/ipcMain\.handle\(/g)].length, 2, "auth.ts: exactly two raw registrations (secureHandle and publicHandle)");
  assert.ok([...auth.matchAll(/guarded\(/g)].length >= 2, "both wrappers run their handler inside guarded()");
});
test("the preload exposes no channel without a handler, and every handler is reachable", () => {
  const known = new Set([...Object.keys(policy), ...publicCh]);
  for (const ch of used) assert.ok(known.has(ch), "preload uses unknown channel " + ch);
  assert.deepEqual([...new Set(used)].sort(), [...known].sort());
});
test("the preload never exposes raw ipcRenderer", () => {
  assert.equal(/exposeInMainWorld\("[^"]+",\s*ipcRenderer/.test(preload), false);
});
