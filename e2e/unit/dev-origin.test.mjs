import test from "node:test";
import assert from "node:assert/strict";
import { resolveDevOrigin, resolveDevPort } from "../../src/backend/dev-origin.ts";

test("default dev origin is http://localhost:5173", () => {
  assert.equal(resolveDevOrigin({}, false), "http://localhost:5173");
});
test("POS_DEV_PORT changes the port in development only", () => {
  assert.equal(resolveDevOrigin({ POS_DEV_PORT: "5183" }, false), "http://localhost:5183");
  assert.equal(resolveDevOrigin({ POS_DEV_PORT: "5183" }, true), "http://localhost:5173", "a packaged app ignores it");
});
test("anything that is not a plain port number is ignored", () => {
  for (const bad of ["", "abc", "80", "5173.evil.com", "5173@evil.com", "65536", "-1", "0123", "5173/x", " 5183"]) {
    assert.equal(resolveDevPort({ POS_DEV_PORT: bad }, false), 5173, bad);
  }
});
