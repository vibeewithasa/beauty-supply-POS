import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Gate, authorizeAdminPin } from "../../src/backend/admin-authorization.ts";
import { LoginLimiter } from "../../src/backend/login-limiter.ts";
import { hashPin, verifyPin } from "../../src/backend/pin-hash.ts";

const sha = (p) => createHash("sha256").update(p).digest("hex");
const clock = (start = 1_000_000) => { let t = start; return { now: () => t, advance: (ms) => { t += ms; } }; };
const cfg = { maxAttempts: 3, baseLockMs: 1000, maxLockMs: 8000, resetAfterMs: 60_000 };

// a fake world: three users (one admin, one seller, one inactive admin that is simply absent from the active list)
async function world(extra = {}) {
  const c = clock();
  const limiter = new LoginLimiter(cfg, c.now);
  const users = [
    { id: 1, role: "admin", pinHash: await hashPin("246810") },
    { id: 2, role: "vendor", pinHash: await hashPin("135791") },
    { id: 3, role: "admin", pinHash: sha("1234") }, // legacy SHA-256 administrator
  ];
  const events = { loads: 0, upgraded: [], rejected: 0 };
  const deps = {
    limiter,
    gate: new Gate(),
    loadActiveUsers: async () => { events.loads++; return users; },
    verify: verifyPin,
    onAuthorized: async (admin, pin) => { events.upgraded.push([admin.id, pin.length]); },
    onRejected: () => { events.rejected++; },
    ...extra,
  };
  return { c, limiter, deps, events, users };
}
const code = async (p) => { try { await p; return "OK"; } catch (e) { return e.code ?? e.message; } };

test("an active administrator's PIN authorizes and only the administrator id comes back", async () => {
  const { deps } = await world();
  const r = await authorizeAdminPin(deps, "246810");
  assert.deepEqual(r, { adminId: 1 });
  assert.deepEqual(Object.keys(r), ["adminId"], "nothing else (no PIN, hash or token) leaves the module");
});

test("a legacy 4-digit administrator keeps working", async () => {
  const { deps, events } = await world();
  assert.deepEqual(await authorizeAdminPin(deps, "1234"), { adminId: 3 });
  assert.deepEqual(events.upgraded, [[3, 4]]);
});

test("a wrong PIN, a seller's PIN, an unknown PIN and a malformed PIN fail with the very same error", async () => {
  const { deps } = await world({ limiter: new LoginLimiter({ ...cfg, maxAttempts: 50 }) });
  const results = [];
  for (const pin of ["000000", "135791", "999999", "12", "abcdef", "", null, undefined, 246810, {}, ["246810"]]) {
    try {
      await authorizeAdminPin(deps, pin);
      results.push("OK");
    } catch (e) {
      results.push(e.message);
    }
  }
  assert.equal(new Set(results).size, 1, JSON.stringify(results));
  assert.equal(results[0], "[AUTORIZACION_INVALIDA] PIN de administrador inválido");
});

test("an inactive administrator cannot authorize (only active users are loaded)", async () => {
  const { deps, users } = await world();
  const inactive = { id: 9, role: "admin", pinHash: await hashPin("112233") }; // not in the active list
  assert.ok(!users.includes(inactive));
  assert.equal(await code(authorizeAdminPin(deps, "112233")), "AUTORIZACION_INVALIDA");
});

test("two active users with the same PIN (never expected) authorize nobody", async () => {
  const { deps, users } = await world();
  users.push({ id: 4, role: "admin", pinHash: await hashPin("246810") });
  assert.equal(await code(authorizeAdminPin(deps, "246810")), "AUTORIZACION_INVALIDA");
});

test("failures lock, a correct PIN is refused while locked, and the lock expires", async () => {
  const { deps, c, events } = await world();
  for (let i = 0; i < 3; i++) assert.equal(await code(authorizeAdminPin(deps, "000000")), "AUTORIZACION_INVALIDA");
  assert.equal(events.rejected, 3);
  const loads = events.loads;
  const locked = await authorizeAdminPin(deps, "246810").catch((e) => e);
  assert.equal(locked.code, "AUTORIZACION_BLOQUEADA");
  assert.match(locked.message, /Espera 1 s/);
  assert.equal(events.loads, loads, "while locked the users are not even read");
  c.advance(1001);
  assert.deepEqual(await authorizeAdminPin(deps, "246810"), { adminId: 1 }, "recovered after the lock");
  // the success gave nothing back: one more failure and the lock is back (and longer)
  assert.equal(await code(authorizeAdminPin(deps, "000000")), "AUTORIZACION_INVALIDA");
  assert.equal(await code(authorizeAdminPin(deps, "246810")), "AUTORIZACION_BLOQUEADA", "still counting from the earlier failures");
  c.advance(60_001 + 2000);
  assert.deepEqual(await authorizeAdminPin(deps, "246810"), { adminId: 1 }, "after a quiet period everything starts again");
});

test("the budget is one for the whole installation: it does not depend on which PIN or user is being guessed", async () => {
  const { deps } = await world();
  // three different wrong guesses (a seller's PIN, an unknown PIN, a malformed one) spend the same budget
  for (const pin of [ "135791", "555555", "abc" ]) assert.equal(await code(authorizeAdminPin(deps, pin)), "AUTORIZACION_INVALIDA");
  assert.equal(await code(authorizeAdminPin(deps, "246810")), "AUTORIZACION_BLOQUEADA", "the right PIN is refused: the lock is not per user");
});

test("a burst of parallel guesses cannot exceed the attempt budget (no check-then-act race)", async () => {
  const { deps, events } = await world();
  const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => code(authorizeAdminPin(deps, String(100000 + i)))));
  assert.equal(burst.filter((r) => r === "AUTORIZACION_INVALIDA").length, 3, "exactly maxAttempts guesses were evaluated");
  assert.equal(burst.filter((r) => r === "AUTORIZACION_BLOQUEADA").length, 9);
  assert.equal(events.loads, 3);
});

test("a burst that contains the right PIN cannot use it after the budget is gone", async () => {
  const { deps } = await world();
  const pins = ["000001", "000002", "000003", "246810", "000004"];
  const out = await Promise.all(pins.map((p) => code(authorizeAdminPin(deps, p))));
  assert.deepEqual(out, ["AUTORIZACION_INVALIDA", "AUTORIZACION_INVALIDA", "AUTORIZACION_INVALIDA", "AUTORIZACION_BLOQUEADA", "AUTORIZACION_BLOQUEADA"]);
});

test("a failing hash upgrade never rejects a valid PIN", async () => {
  const { deps } = await world({ onAuthorized: async () => { throw new Error("db down"); } });
  assert.deepEqual(await authorizeAdminPin(deps, "1234"), { adminId: 3 });
});

test("the PIN never appears in any error, and errors carry no user information", async () => {
  const { deps } = await world();
  for (const pin of ["135791", "000000"]) {
    const e = await authorizeAdminPin(deps, pin).catch((x) => x);
    assert.ok(!String(e.message).includes(pin) && !String(e.stack).includes(pin));
  }
});

test("the gate runs tasks one at a time, in order, and survives a failing task", async () => {
  const gate = new Gate();
  const log = [];
  const slow = (n, ms, fail) => gate.run(async () => { log.push("start" + n); await new Promise((r) => setTimeout(r, ms)); log.push("end" + n); if (fail) throw new Error("x"); return n; });
  const [a, b, c] = await Promise.allSettled([slow(1, 20, true), slow(2, 5), slow(3, 1)]);
  assert.deepEqual(log, ["start1", "end1", "start2", "end2", "start3", "end3"]);
  assert.equal(a.status, "rejected");
  assert.equal(b.value, 2);
  assert.equal(c.value, 3);
});
