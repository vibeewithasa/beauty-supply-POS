// Guard against credentials in versioned files. It reads the local .env (if there is one) only to compare;
// it never prints a secret, only the offending file names.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import dotenv from "dotenv";

const root = path.resolve(import.meta.dirname, "../..");
const sh = (c) => execSync(c, { cwd: root, encoding: "utf8", maxBuffer: 1e8 }).split("\n").filter(Boolean);
const files = [...new Set([...sh("git ls-files"), ...sh("git ls-files --others --exclude-standard")])]
  .filter((f) => !f.startsWith(".serena/") && !/\.(png|jpe?g|ico|woff2?)$/i.test(f) && fs.existsSync(path.join(root, f)));
const credConn = /postgres(?:ql)?:\/\/[^\s"'`:@/]+:[^\s"'`@]+@/;

test("no versioned file contains a credential-bearing connection string (only .env.example may)", () => {
  const offenders = files.filter((f) => f !== ".env.example" && credConn.test(fs.readFileSync(path.join(root, f), "utf8")));
  assert.deepEqual(offenders, []);
});

test("neither the local DATABASE_URL nor its password appear in any versioned file", { skip: !fs.existsSync(path.join(root, ".env")) && "no local .env to compare with" }, () => {
  const env = dotenv.parse(fs.readFileSync(path.join(root, ".env")));
  const url = env.DATABASE_URL ?? "";
  let pw = "";
  try { pw = decodeURIComponent(new URL(url).password); } catch { /* not a URL */ }
  const offenders = files.filter((f) => { const t = fs.readFileSync(path.join(root, f), "utf8"); return (url && t.includes(url)) || (pw.length > 2 && t.includes(pw)); });
  assert.deepEqual(offenders, [], "a file contains the local database credentials");
});

test(".env and the E2E artifacts are git-ignored and untracked", () => {
  const tracked = sh("git ls-files");
  assert.ok(!tracked.some((f) => /(^|\/)\.env$/.test(f) || f.startsWith("e2e-artifacts/") || /\.dump$/.test(f)));
  const ignored = execSync("git check-ignore .env e2e-artifacts", { cwd: root, encoding: "utf8" });
  assert.match(ignored, /\.env/);
  assert.match(ignored, /e2e-artifacts/);
});

test("E2E suites never log or hard-code credentials: they read them at runtime and scrub logs", () => {
  const harness = fs.readFileSync(path.join(root, "e2e/lib/harness.mjs"), "utf8");
  assert.match(harness, /export function scrub/);
  assert.match(harness, /process\.env\.DATABASE_URL/);
  assert.doesNotMatch(harness, /password\s*[:=]\s*["'][^"']+["']/i);
});
