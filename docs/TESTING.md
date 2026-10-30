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
| `npm run test:cart` | cart confirmations, no toast, double-submit and idempotent checkout, completed-sale modal, search/scanner simulation | yes |
| `npm run test:history` | sales history: pagination beyond 100, folio/date/method filters, sold-as-recorded names, returns, vendor isolation, restart | yes |
| `npm run test:receipts` | ticket content, escaping, settings, logo, 80/58 mm PDF output, cancel/failure/retry, permissions | yes |
| `npm run test:ux` | every screen at 1024x768 / 1366x768 / 1920x1080: overflow, clipped tables, dialogs in viewport, labels, receipt legibility; screenshots in `e2e-artifacts` | yes |
| `npm run test:packaged` | launches the packaged exe (`npm run package:dir` first) against a throwaway DB: window, login, modules, sale/cash/return/report, CSP, shell hardening, no credentials in the asar, config sources, close/reopen | yes |
| `npm run test:migrations` | migrations from empty and legacy DBs, precheck, drift, startup abort | yes |
| `npm run test:all` | unit + every Electron suite + migrations | yes |
| `npm run db:precheck` | read-only pre-flight for the integrity migrations (see below) | DB only |

## Reading results

Statuses: `PASS`, `FAIL`, `KNOWN_FAIL`, `UNEXPECTED_PASS`, `SKIP`, `WARN`.

- A test tagged with a documented open bug is `KNOWN_FAIL` only if it fails with that bug's exact symptom;
  any other failure (setup error, timeout, different message) is a real `FAIL`. A known-bug test that starts
  passing is `UNEXPECTED_PASS` and makes the run exit non-zero. Today there are no open known bugs.
- Exit codes: `0` ok, `1` failure or fatal error, `2` bad usage, `3` an `UNEXPECTED_PASS`.
- `isolation.*` and `renderer.console_errors` entries are environment checks, counted separately from tests
  in the summary (`tests` vs `infraChecks`).
- Logs, screenshots and `results.json` go to `e2e-artifacts/<run>/` (git-ignored).
- The packaged build is **not** exercised (`SKIP`): production coverage is not claimed.

## Environment knobs (tests only)

| Variable | Effect |
|---|---|
| `E2E_KEEP_DB=1` | keep the run's database for inspection (it is dropped otherwise) |
| `E2E_LEGACY_DUMP` | path of a `pg_dump -Fc` of a legacy database for the upgrade test (`SKIP` if missing) |
| `PG_BIN` | PostgreSQL `bin` folder (for `pg_restore`) |
| `E2E_DATABASE_URL` | alternative local server/credentials for the tests |
| `POS_LOGIN_MAX_ATTEMPTS`, `POS_LOGIN_LOCK_MS`, `POS_LOGIN_MAX_LOCK_MS` | login limiter limits, honored **only in development builds** (ignored when packaged) |

## Applying migrations to an existing database

The application runs pending migrations at startup and **refuses to run** (no IPC handler registered) if they
fail. Migrations 0004-0006 add constraints, so data that violates them makes the migration roll back as a
whole. Before starting the app against an existing database:

1. `pg_dump -Fc` backup.
2. `npm run db:precheck -- --database=<name>` (read-only). Any `BLOCKER` must be resolved by the operator;
   nothing is repaired automatically. Legacy sessions closed with `status='open'` are reconciled by 0004 and
   existing returns are marked `legacy_unspecified` (never `paid`) by 0005.
3. Start the application (or `npm run db:migrate`).
