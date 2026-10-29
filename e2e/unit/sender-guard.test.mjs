import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isTrustedUrl, isTrustedFrame } from "../../src/backend/sender-guard.ts";

const dev = { packaged: false, devOrigin: "http://localhost:5173", appIndexPath: "" };
const appIndex = path.resolve("C:/Program Files/Beauty POS/resources/app.asar/dist/renderer/index.html");
const prod = { packaged: true, devOrigin: "http://localhost:5173", appIndexPath: appIndex };

test("dev: the exact dev origin is trusted (any path/query/hash)", () => {
  for (const u of ["http://localhost:5173", "http://localhost:5173/", "http://localhost:5173/sales?x=1#h"]) {
    assert.equal(isTrustedUrl(u, dev), true, u);
  }
});

test("dev: origins imitating localhost are rejected", () => {
  const bad = [
    "http://localhost:5173.evil.com/", "http://localhost:5173@evil.com/", "http://evil.com/http://localhost:5173/",
    "http://localhost.evil.com:5173/", "http://localhost:5174/", "http://localhost:51733/", "https://localhost:5173/",
    "http://127.0.0.1:5173/", "http://[::1]:5173/", "http://user:pw@localhost:5173/", "ws://localhost:5173/",
    "file:///C:/evil/page.html", "about:blank", "javascript:alert(1)", "data:text/html,x", "", "not a url", "localhost:5173",
  ];
  for (const u of bad) assert.equal(isTrustedUrl(u, dev), false, u);
});

test("packaged: only the app's own index.html is trusted, not arbitrary file:// pages", () => {
  const ok = "file:///C:/Program%20Files/Beauty%20POS/resources/app.asar/dist/renderer/index.html";
  assert.equal(isTrustedUrl(ok, prod), true);
  assert.equal(isTrustedUrl(ok + "#/sales", prod), true, "hash routes of the same document");
  for (const u of [
    "file:///C:/Users/x/evil.html",
    "file:///C:/Program%20Files/Beauty%20POS/resources/app.asar/dist/renderer/other.html",
    "file:///C:/Program%20Files/Beauty%20POS/resources/app.asar/dist/renderer/../../../evil.html",
    "file://evil-host/share/index.html", "http://localhost:5173/", "https://evil.com/", "file:///",
  ]) assert.equal(isTrustedUrl(u, prod), false, u);
});

test("packaged: the dev server origin is no longer trusted", () => {
  assert.equal(isTrustedUrl("http://localhost:5173/", prod), false);
});

test("frames: only the main frame of a trusted page is accepted (iframes rejected)", () => {
  const main = { url: "http://localhost:5173/" };
  const iframe = { url: "http://localhost:5173/" }; // same origin, but a different frame object
  assert.equal(isTrustedFrame(main, main, dev), true);
  assert.equal(isTrustedFrame(iframe, main, dev), false, "same-origin iframe");
  assert.equal(isTrustedFrame(null, main, dev), false);
  assert.equal(isTrustedFrame(undefined, main, dev), false);
  const foreignMain = { url: "http://localhost:5174/" };
  assert.equal(isTrustedFrame(foreignMain, foreignMain, dev), false, "main frame of a foreign origin");
});
