// Run with: npm run test:unit  (Node type stripping loads the .ts module directly)
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SessionStore } from "../../src/backend/session-store.ts";

const trusted = (u) => u.startsWith("http://localhost:5173/");
// Fake WebContents: only `id`, `once` and `on` are used by the store.
const sender = (id) => Object.assign(new EventEmitter(), { id });

test("a session is bound to its own window id", () => {
  const s = new SessionStore();
  s.start(sender(1), 42, trusted);
  assert.equal(s.get(1), 42);
  assert.equal(s.get(2), undefined, "another window is not authorized implicitly");
});

test("destroying the window releases its session", () => {
  const s = new SessionStore();
  const w = sender(7);
  s.start(w, 5, trusted);
  w.emit("destroyed");
  assert.equal(s.get(7), undefined);
  assert.equal(s.size, 0);
});

test("logout (end) invalidates the session", () => {
  const s = new SessionStore();
  s.start(sender(3), 9, trusted);
  s.end(3);
  assert.equal(s.get(3), undefined);
});

test("a new login replaces the previous user and does not stack listeners", () => {
  const s = new SessionStore();
  const w = sender(4);
  s.start(w, 1, trusted);
  s.start(w, 2, trusted);
  assert.equal(s.get(4), 2);
  assert.equal(w.listenerCount("destroyed"), 1);
  assert.equal(w.listenerCount("did-navigate"), 1);
});

test("sessions of different windows are independent", () => {
  const s = new SessionStore();
  const a = sender(1), b = sender(2);
  s.start(a, 10, trusted);
  s.start(b, 20, trusted);
  a.emit("destroyed");
  assert.equal(s.get(1), undefined);
  assert.equal(s.get(2), 20);
});

test("navigating to an untrusted URL drops the session; trusted navigation keeps it", () => {
  const s = new SessionStore();
  const w = sender(5);
  s.start(w, 8, trusted);
  w.emit("did-navigate", {}, "http://localhost:5173/sales");
  assert.equal(s.get(5), 8, "reload/trusted navigation keeps the session");
  w.emit("did-navigate", {}, "http://localhost:5174/");
  assert.equal(s.get(5), undefined, "foreign origin drops the session");
});

test("after destroy a window id can log in again with fresh hooks", () => {
  const s = new SessionStore();
  const w = sender(6);
  s.start(w, 1, trusted);
  w.emit("destroyed");
  const w2 = sender(6);
  s.start(w2, 2, trusted);
  assert.equal(s.get(6), 2);
  assert.equal(w2.listenerCount("destroyed"), 1);
});
