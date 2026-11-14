# Testing

Everything below is driven from `package.json`. The Electron tests drive the **real application window**
(Playwright for Electron) against a **throwaway PostgreSQL database created for each run**; no existing
database is ever written to, overwritten or dropped.

## Prerequisites

- Windows, Node.js 22.16+, `npm install` done.
- A local PostgreSQL (12+) reachable through `DATABASE_URL` in `.env`. It is only used to locate the server
  and its credentials; the tests create their own `beauty_pos_e2e_<id>` database next to it. A non-local
  server is refused.
- Port **5173** free (or set `E2E_PORT` to another free port, e.g. while `npm run dev` is running). The suites start their
  own Vite and verify they own the port; if something else listens there they fail instead of reusing (or killing) it.
  Each launch uses a private `--user-data-dir`, so it never collides with a running instance of the app.

## Commands

| Command | What it runs | Needs DB / Electron |
|---|---|---|
| `npm run typecheck` | TypeScript, no emit | no |
| `npm run lint` | ESLint (strict on backend/IPC/scripts/tests, lighter on the renderer) | no |
| `npm run build` | tsup (main, preload) + Vite (renderer) | no |
| `npm run test:unit` | pure unit tests (`e2e/unit`), Node type stripping | no |
| `npm run test:security` | IPC authorization, sessions, origins, windows | yes |
| `npm run test:e2e` | UI flows: login, dashboard, stock, cash, sales | yes |
| `npm run test:integration` | sales/cash/inventory integrity, concurrency, rollback | yes |
| `npm run test:catalog` | product/inventory/price operations, races | yes |
| `npm run test:returns` | returns integrity | yes |
| `npm run test:hardening` | sanitized errors, user administration, login limiter | yes |
| `npm run test:pin` | scrypt PINs, legacy upgrade, PIN uniqueness across salts, seed script, users screen | yes |
| `npm run test:screens` | products, receive (IN/OUT/ADJUST), price change + stale detection, returns (partial/over/pending), reports, vendor isolation, driven through the real UI and verified in PostgreSQL | yes |
| `npm run test:cart` | cart confirmations, no toast, double-submit and idempotent checkout, completed-sale modal, search/scanner simulation; since 0.8.1 also the cart surviving Caja/Historial/Devoluciones (vendor and administrator), clearing once on a sale, logout / user change / expired session isolation, stale price-stock-availability, a rejected, an uncertain (answer lost) and an in-flight payment | yes |
| `npm run test:history` | sales history: pagination beyond 100, folio/date/method filters, sold-as-recorded names, returns, vendor isolation, restart | yes |
| `npm run test:receipts` | ticket content, escaping, settings, logo, 80/58 mm PDF output, cancel/failure/retry, permissions | yes |
| `npm run test:fields` | every editable field of the real screens (sales, payment, cash dialogs, returns, inventory, users, settings, history, stock, receive), measured in the window: border / fill / text / placeholder contrast against what is behind the field, focus ring, invalid and disabled looks, at 1024x768 / 1366x768 / 1920x1080 with screenshots; `FIELDS_PHASE=before` only records | yes |
| `npm run test:keypad` | the optional floating numeric keypad of Vender (0.8.2): off by default, enabled from Configuración > Este equipo and persisted per device, integer and decimal fields, replace-on-focus, focus never moved, barcode-reader simulation and physical keyboard, the payment dialog (Radix) with the keypad above it, drag / minimize / restore / reload, held inside the window at 1024x768, 1366x768 and 1920x1080, simulated touch (CDP), administrator and vendor sessions, corrupt storage, reduced motion; screenshots in `e2e-artifacts` | yes |
| `npm run test:sku` | automatic product SKU (0.8.2): the form asks for none, the generated one is shown read-only, a client SKU is refused, 60 concurrent creations through IPC and 200 numbers drawn from 4 sessions never collide (evidence in `sku-concurrency-evidence.json`), old SKUs skipped and preserved, barcode independent, search by SKU / barcode, a sale of a generated SKU, vendor refused | yes |
| `npm run test:ux` | every screen at 1024x768 / 1366x768 / 1920x1080: overflow, clipped tables, dialogs in viewport, labels, receipt legibility; screenshots in `e2e-artifacts` | yes |
| `npm run test:packaged` | launches the packaged exe (`npm run package:dir` first) against a throwaway DB: window, login, modules, sale/cash/return/report, CSP, shell hardening, no credentials in the asar, config sources, close/reopen | yes |
| `npm run test:safety` | legacy sales channels visibility, checkout idempotency (lines compared), connection loss and recovery, safe errors | yes |
| `npm run test:cash` | register history and closing summaries (cash/card, income/withdrawal, +/- difference, restart, roles, print/export without writes) | yes |
| `npm run test:refunds` | authorized refunds through IPC: cash/card, administrator PIN (wrong/seller/inactive/legacy), confirmation, tampering, closed register, no funds, partial/complete/excess, idempotency, double click, concurrency, rollback by injected failure, pending returns, legacy, reconciliation of the ledger and the register | yes |
| `npm run test:refundauth` | brute-force protection of the administrator PIN with a small real limit: lock, recovery, parallel burst, a login does not reset it, the budget is shared with the login (failed logins lock the authorization and vice versa) | yes |
| `npm run test:refundui` | the Devoluciones screen end to end (method, confirmation, PIN dialog, session unchanged, pending payment, filters, voucher, unsure outcome warning), dashboard/reports/cash history/closing summary reconcile, persistence after restarting the app | yes |
| `npm run test:loginsec` | simulated brute force on the PIN login: alternating guesses and own logins, parallel bursts, no enumeration, restart persistence, tampered/corrupt counter file, legacy and scrypt PINs, shared budget with the administrator authorization | yes |
| `npm run test:setup` | first-run setup window, protected `config.json` (real DPAPI), legacy plain-text upgrade, no plain-text fallback, undecryptable password, first administrator, schema never migrated, `--reconfigure` | yes |
| `npm run test:pilot` | one complete store day on a NEW database through the real window (25 steps, see docs/PILOT_CHECKLIST.md), backup with second copy, restore, comparison, and the 1024x768 visual review | yes |
| `npm run test:demo` | laptop rehearsal (`npm run package` first): extracts the NSIS installer, runs the shipped PowerShell tool to create the fictional demo database, configures the extracted app through its setup window and drives the presentation (14 checks, see docs/DEMO_CHECKLIST.md; since 0.8.0 it takes the explicit "my own PostgreSQL" path of the wizard); not part of `test:all` because it needs the installer | yes + installer |
| `npm run test:installer` | the self-contained installer's provisioning against the REAL bundled PostgreSQL in temp folders (no service, no install; fetches/verifies the package first): package hashes and tamper refusal, preflight (foreign PostgreSQL seen, not touched; no space; busy port), demonstration and clean installs, SCRAM/loopback/ACL/process-owner audit, no secret in files or command lines, re-run, hard kill recovery, port moved, ownership proof, failed install rollback and retry, foreign data never deleted, backup+restore, wrong credentials, schema update, minor PostgreSQL update, demo reset rules (29 checks) | yes (read-only on the developer's server) + `vendor/pg-bundle` |
| `npm run test:installer-app` | the extracted NSIS installer driven through the real UI (`npm run package` first): payload contents, wizard (checks, PIN validation, install demo, restart), protected credentials, full presentation on the dedicated instance, close stops PostgreSQL, loopback-only traffic, maintenance window (backup, demo reset), tampered package -> safe failure -> retry, clean install, external connection / 0.7.0 config never triggers the wizard (14 checks) | installer |
| `npm run test:legacy` | restores the newest validated backup of the owner's data into a NEW database, applies 0007-0009 with the explicit commands, proves the old data survived and runs the packaged app on it (SKIP, never PASS, when there is no backup or no package) | yes + package |
| `npm run test:migrations` | migrations from empty and legacy DBs (0007/0008/0009), precheck, drift, the app only verifies the schema (empty / behind / newer / unreachable), the explicit `db:migrate` command | yes |
| `npm run test:ops` | verified backups, restore into a new database (row-by-row comparison), retention, safe errors, Task Scheduler wrapper, least-privilege role (OPS-14: it can draw product SKUs from the id sequence and cannot rewind or alter it) | yes |
| `npm run test:all` | unit + development Electron suites selected by `e2e/run.mjs all` + migrations + ops + legacy + installer provisioning; **not** standalone `test:packaged`, `test:installer-app` or `test:demo` | yes |
| `npm run db:precheck` | read-only pre-flight for the integrity migrations (see below) | DB only |

## What `test:all` does not certify

The current `package.json` runs unit tests, `e2e/run.mjs all`, migrations, operations, legacy-copy checks and installer provisioning through `npm run test:all`. **It does not invoke** `test:packaged`, `test:installer-app` or `test:demo` as part of that command. These require their own prerequisites and commands, including a built package or installer. Passing `test:all` must not be reported as proof of the extracted installer UI, an NSIS install/uninstall, a Windows reboot or connected physical hardware. See `docs/DEMO_CHECKLIST.md` for the manual boundaries.

## Reading results

Statuses: `PASS`, `FAIL`, `KNOWN_FAIL`, `UNEXPECTED_PASS`, `SKIP`, `WARN`.

- A test tagged with a documented open bug is `KNOWN_FAIL` only if it fails with that bug's exact symptom;
  any other failure (setup error, timeout, different message) is a real `FAIL`. A known-bug test that starts
  passing is `UNEXPECTED_PASS` and makes the run exit non-zero. Today there are no open known bugs.
- Exit codes: `0` ok, `1` failure or fatal error, `2` bad usage, `3` an `UNEXPECTED_PASS`.
- `isolation.*` and `renderer.console_errors` entries are environment checks, counted separately from tests
  in the summary (`tests` vs `infraChecks`).
- Logs, screenshots and `results.json` go to `e2e-artifacts/<run>/` (git-ignored).
- The regular Electron browser suite may report a packaged-app placeholder as `SKIP`; that placeholder is **not** the packaged validation. `npm run test:packaged` is a separate command that launches `release/win-unpacked/Beauty POS.exe` after `npm run package:dir` and exercises the packaged renderer and shell. Neither that check nor `test:installer-app` proves a real NSIS install/uninstall on another Windows machine. When reporting results, distinguish development Electron suites, unpacked-package tests, extracted-installer tests and manual installation evidence.

## Confirming the legacy-data migration actually ran

`npm run test:all` invokes `test:legacy`, but the legacy-copy scenario can report `SKIP` when no validated backup or suitable package is available. An overall command finishing successfully is **not** proof that a real historical-data copy was migrated and opened. To claim that coverage, review the dedicated `test:legacy` output for a genuine `PASS`, verify the relevant backup/package prerequisites, and retain the run's evidence outside source control. Never substitute the active `beauty_pos` database or a real production backup for a throwaway E2E database, and never add database dumps or PIN-related data to Git.

## Environment knobs (tests only)

| Variable | Effect |
|---|---|
| `E2E_KEEP_DB=1` | keep the run's database for inspection (it is dropped otherwise) |
| `E2E_LEGACY_DUMP` | path of a `pg_dump -Fc` of a legacy database for the upgrade test (`SKIP` if missing) |
| `PG_BIN` | PostgreSQL `bin` folder (for `pg_restore`) |
| `E2E_DATABASE_URL` | alternative local server/credentials for the tests |
| `POS_LOGIN_MAX_ATTEMPTS`, `POS_LOGIN_LOCK_MS`, `POS_LOGIN_MAX_LOCK_MS`, `POS_LOGIN_RESET_MS` | PIN limiter limits (attempts, lock, maximum lock, quiet period that forgets failures), honored **only in development builds** (ignored when packaged). A success never gives attempts back, so the suites wait for the quiet period instead of "logging in to reset" |
| `POS_USE_CONFIG_FILE=1`, `POS_SETUP_NO_RELAUNCH=1`, `POS_TEST_CIPHER_UNAVAILABLE=1` | development-only knobs for the setup tests: use `config.json` instead of `.env`, quit instead of relaunching after saving, simulate a machine without protected storage (ignored when packaged) |
| `E2E_BACKUP_DIR` | folder with the validated backups used by `test:legacy` (default `%USERPROFILE%\Backups\beauty-pos`) |

## Applying migrations to an existing database

The application **never** migrates a database: at startup it only verifies the schema and refuses to run (no IPC handler
registered) when migrations are missing, the database is empty, or it comes from a newer version. Use the explicit commands
(full procedure, backups and restore in `docs/OPERATIONS.md`):

1. `npm run db:backup` (optional extra copy; `db:migrate --apply` takes its own verified backup on a database with data).
2. `npm run db:migrate`: report and dry run, including the read-only integrity precheck. Any `BLOCKER` must be resolved by the
   operator; nothing is repaired automatically. Legacy sessions closed with `status='open'` are reconciled by 0004 and existing
   returns are marked `legacy_unspecified` (never `paid`) by 0005.
3. `npm run db:migrate -- --apply --confirm-database=<name>`.

The E2E runners create and migrate their own throwaway database (`beauty_pos_e2e_<id>`) and never touch another one.

## Writing tests that do not race the screen (lessons of the 0.8.0 verification)

Intermittent failures of `npm run test:all` were traced to three test-side races, each reproduced before it was fixed (none was a product defect):

* **Waiting on something already on screen.** A result box or list from the previous step is still visible while the next action is saved, so waiting for "any result" returns immediately (SCR-12: the wait returned in 22 ms). Wait for a state only THIS action produces (`Ya devuelto completo`), then read PostgreSQL. In a list that may still be unfiltered, open a row by its exact name (`exact: true`: `Ver venta 1` is a prefix of 10, 11, 12).
* **Typing while the application moves the focus.** After a product is added the sales screen returns the focus to the search box a tick later (`focusSearch`); a quantity typed inside that tick lands in the search box (a 150-sale probe lost 6 quantities, the `input` event of the lost value had `type=text`). Use `ui.setCartQuantity`, which waits for that focus return.
* **`waitForFunction` in the packaged page.** It evaluates a string, which the packaged CSP refuses; poll with `page.evaluate` instead.

Not causes (tested): saturating all 16 cores, covering the test window with an opaque window, a re-optimization of Vite's dependencies, leftover processes or ports.

## LOG-03 (hardening): one intermittent failure, investigated during Sprint 08A

**Symptom.** Once, in a full `npm run test:all`, `hardening/LOG-03.lock_after_repeated_failures_refuses_even_the_right_pin` failed with `locator.waitFor: Timeout 4000ms exceeded` (waiting for «Demasiados intentos» after a login attempt through the real screen). Every other check of the run passed.

**What the evidence shows.** The test needs the final attempt to meet a lock that lasts 5 s (`POS_LOGIN_LOCK_MS`) from the third failed attempt. The main-process log of the failing run holds 5 `LOGIN_BLOQUEADO` refusals where every passing run holds 6: exactly the final attempt of LOG-03 was not refused by a lock. So the attempt did not find an active lock, and the only way the sequence can do that is by taking more than 5 s after the third failure. Measured, that window is normally about 0.65 s (0.5 s to the failures, 0.15 s of API calls, page reload and PIN clicks); 1.7 s inside the run that precedes it in `test:all`.

**What was tried to reproduce it.** Nine runs after the failure, all passing: LOG-03 alone three times on the feature branch, three times on a detached worktree of `origin/main` (own database, port 5174), under full CPU load (16 busy processes: 1.5 s, no failure), after the exact suites that precede it in `test:all`, and inside a complete `test:all` (exit 0, 1294 s). The failure was **not reproduced**, so the cause of the one stall of more than 4 s (the test machine, not the code under test) is not proven; nothing in LOG-03, the login screen or the limiter was touched by Sprint 08A (the suite does not create products and the keypad is not mounted on the login screen).

**Change.** The test now reports what it could not see: how long after the lock started the last attempt ended, the lock window and the text on the screen, instead of a bare timeout. The timeout, the lock length and the assertions are unchanged. If it fails again, that message separates «the machine stalled» (elapsed > 5000 ms) from «the screen did not react to a live lock» (elapsed well inside the window).
