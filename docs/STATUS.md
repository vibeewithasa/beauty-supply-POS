# Real status, known risks and distribution requirements

Verified against the code and the automated suites (see `docs/TESTING.md`). The root `README.md` still
describes the early MVP and is intentionally not edited here.

## What works (covered by tests that drive the real window and PostgreSQL)

| Area | State |
|---|---|
| Login by PIN, roles (admin/vendor), sessions owned by the Electron main process, revocation, brute-force limiter | implemented and tested |
| Sales (cash / card) priced and totalled in the main process, stock-safe under concurrency | implemented and tested |
| Cash register: one shared register, open/close, income/withdrawal without overdraft, status coherent | implemented and tested |
| Catalog admin: create/update product, inventory movements (signed deltas), audited price changes, logical delete | implemented and tested, with screens: **Productos** (`/inventory`: list/search, create with initial price+stock, edit, price change with history, logical delete) and **Recepción** (`/receive`: IN/OUT/ADJUST with reason and history) |
| Returns: validated against the sale, no over-return, restock, refund recorded as `pending` | implemented and tested, with screen (`/returns`: sale lookup, returned/remaining quantities, amount preview, confirmation, history). Shown as **PENDIENTE DE REEMBOLSO**; no button settles it |
| Users: create/update/deactivate, unique PIN, last-admin protection | implemented and tested (existing users page) |
| Dashboard: sales, cash, pending vs paid refunds | implemented; figures shown as-is |
| Reports (`/reports`, admin): gross sales, by payment method, top products, returns by refund status, local CSV export; dates validated in main (max 366 days). No profit/cost/tax figures (not recorded) | implemented and tested |
| Receipt/ticket printing, thermal printers, backups, settings | **not implemented** |
| Packaged Windows app (unpacked build, `npm run package:dir`) | works: window, login, every module, sale/cash/return/report, close and reopen, verified by `npm run test:packaged` (see `docs/PACKAGING.md`). **Installer unsigned; auto-update disabled** |

## Contracts worth knowing

- `users:delete` is a **logical deactivation** (history is never orphaned); `users:getAll` lists active users only.
- `products:update` can no longer change `stock` or `price`: use `inventory:addMovement` / `priceChanges:create`.
- `inventory:addMovement`: `amount` is the signed stock delta (IN > 0, OUT < 0, ADJUST signed); `DELETE` is reserved.
- `returns:create`: amounts come from the sale; a client `unitPrice`/`productId` is only a claim. The refund
  starts as `pending`; **the cash register is not touched and nothing marks a refund as paid** (no settlement
  operation exists yet). Deleted products are not restocked (no recovery policy).
- Read channels added for the screens: `products:listAdmin` (admin, includes inactive/deleted), `returns:getSaleForReturn`
  (authenticated, informational: `returns:create` re-validates under locks), `reports:getSummary` (admin).
- Unexpected errors reach the UI only as `[ERROR_INTERNO]`; details go to the main-process log, redacted.

## Decisions still pending (product)

- Who may read the full sales history and process returns (`sales:getAll`, `sales:getById`, `returns:*` are open
  to any signed-in user today).
- How a pending refund is settled (cash from the register? card reversal? who approves?) and the paid state.
- Whether each user has their own register (today one shared register).
- Taxes and discounts (deliberately absent).
- Policy for returns of deleted products.

## Known risks (not fixed)

- **PIN security (improved, still a risk):** new and changed PINs have 6 to 8 digits and are stored as **salted scrypt**
  (`scrypt$N$r$p$salt$key`, N=2^14, r=8, p=1, 16-byte random salt per user, constant-time comparison;
  `src/backend/pin-hash.ts`). Existing accounts keep their **4-digit unsalted SHA-256** hash until their first
  successful login, which upgrades it in place (compare-and-swap, never blocks the login). Until each legacy user has
  logged in once, their PIN is still SHA-256 in the database. A 6-8 digit PIN is still a small space: an attacker who
  can read the database can brute-force it offline (scrypt only makes that slower), so the global login limiter and
  protecting the database/host matter more than the hash. Login verifies against every active user (the PIN is the
  only identifier), so its cost grows with the number of users. Logical PIN uniqueness (also for inactive users) is
  enforced by the application under an advisory lock: salted hashes make the unique index on `pin_hash` useless for
  that purpose (it remains as a harmless guard for legacy hashes). *Next steps:* longer passphrases or a username +
  PIN login, force a PIN change for legacy accounts, raise the scrypt cost if the user count stays small.
- **First administrator:** `npm run seed:admin` has no default PIN: type it twice in a terminal (not echoed) or set
  `ADMIN_PIN` for that single command; it is never printed or logged.
- **Packaged build:** fixed (`base: "./"`, `HashRouter`, CSP in the built `index.html`, shell hardening). The CSP is only
  exercised by the packaged tests (the dev server has none).
- **Database configuration in the package:** nothing is packaged. `DATABASE_URL` from the environment or `config.json` in
  the user data folder (loopback hosts only unless `POS_ALLOW_REMOTE_DB=1`). `config.json` holds the password in plain
  text: use a dedicated low-privilege PostgreSQL role (details in `docs/PACKAGING.md`).
- **Installer assets:** no code-signing certificate (SmartScreen warning, updates not trustworthy) and no `build/icon.ico`.
  Auto-update only runs with an explicit `POS_UPDATE_FEED_URL` (https).
- **Dependencies (reviewed, NOT upgraded):** `npm audit --omit=dev` reports 18 findings (17 high, 1 moderate) in
  electron 39.2.5, electron-updater, drizzle-orm, react-router(-dom), postcss, zod and transitive packages
  (lodash, minimatch, nanoid, picomatch, js-yaml...). Whole-tree audit: 45 (2 critical, mostly build tooling).
  They need a controlled upgrade with the full suite as the safety net (Electron, drizzle-orm and react-router first);
  `npm audit fix --force` would jump zod to a new major and was not run.
- **Backups and restore** are not automated; PostgreSQL must be installed and managed on each machine.
- Lighter-weight leftovers: a legacy unused `drizzle/migrations/0001_initial.sql`, duplicate `AppRouter.tsx`,
  the renderer lint is still gentle (warnings only for unused names).

## Requirements before distributing to a real store

1. (done) PIN storage is salted scrypt. 2. (done) Packaged renderer and configuration path.
3. (done) Screens for product/inventory/price management, returns and reports.
4. Decide the pending product questions. 5. Dependency upgrade + audit. 6. Backup/restore procedure.
7. (done) Electron shell hardening. Still open: code signing certificate and a trusted update channel.
