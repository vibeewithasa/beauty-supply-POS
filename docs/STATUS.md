# Real status, known risks and distribution requirements

Verified against the code and the automated suites (see `docs/TESTING.md`). The root `README.md` still
describes the early MVP and is intentionally not edited here.

## What works (covered by tests that drive the real window and PostgreSQL)

| Area | State |
|---|---|
| Login by PIN, roles (admin/vendor), sessions owned by the Electron main process, revocation, brute-force limiter | implemented and tested |
| Sales (cash / card) priced and totalled in the main process, stock-safe under concurrency | implemented and tested. Checkout is **idempotent** (`operationId`), guarded against double submit, and every line stores the product name/SKU as sold |
| Sales history (`/history`): folio/date/method search, server-side pagination, persisted detail with returns, receipt preview and reprint (a vendor sees only their own sales) | implemented and tested |
| Receipts: Estética Leal commercial (non-fiscal) ticket, 80 mm / 58 mm, preview, print and reprint from the main process; commercial settings screen (`/settings`, admin) | implemented and tested without a physical printer (print output checked as a PDF of the real print document) |
| Cash register history (`/cash/history`, from Caja): sessions with filters, closing summary (cash vs card sales apart, manual income/withdrawals, expected, counted, signed difference, related returns), CSV and printable 80/58 mm | implemented and tested (`test:cash`). A vendor sees the open session and the ones they opened/closed |
| Cash register: one shared register, open/close, income/withdrawal without overdraft, status coherent | implemented and tested |
| Catalog admin: create/update product, inventory movements (signed deltas), audited price changes, logical delete | implemented and tested, with screens: **Productos** (`/inventory`: list/search, create with initial price+stock, edit, price change with history, logical delete) and **Recepción** (`/receive`: IN/OUT/ADJUST with reason and history) |
| Returns and refunds (Sprint 05, `docs/REFUNDS.md`): validated against the sale, no over-return, restock; the refund is paid in **cash from the register** or on the **card terminal** with an **administrator PIN** (checked in main, operator's session untouched), explicit confirmation that the money was handed back, atomically with the return; old pending returns can be paid the same way; legacy returns stay legacy | implemented and tested (`test:refunds`, `test:refundauth`, `test:refundui`, unit, migration 0009). Screen `/returns`: **PENDIENTE / PAGADO EN EFECTIVO / PAGADO POR TARJETA / LEGACY**, "Registrar pago pendiente", printable voucher |
| Users: create/update/deactivate, unique PIN, last-admin protection | implemented and tested (existing users page) |
| Dashboard: sales, cash, refunds owed vs paid in cash vs paid by card (by payment date) | implemented and tested |
| Reports (`/reports`, admin): gross sales, by payment method, top products, returns by refund status, local CSV export; dates validated in main (max 366 days). No profit/cost/tax figures (not recorded) | implemented and tested |
| Thermal-printer hardware validation, CFDI/fiscal invoicing, backups | **not implemented / not tested on hardware** |
| Packaged Windows app (unpacked build, `npm run package:dir`) | works: window, login, every module, sale/cash/return/report, close and reopen, verified by `npm run test:packaged` (see `docs/PACKAGING.md`). **Installer unsigned; auto-update disabled** |

## Contracts worth knowing

- `users:delete` is a **logical deactivation** (history is never orphaned); `users:getAll` lists active users only.
- `products:update` can no longer change `stock` or `price`: use `inventory:addMovement` / `priceChanges:create`.
- `inventory:addMovement`: `amount` is the signed stock delta (IN > 0, OUT < 0, ADJUST signed); `DELETE` is reserved.
- `returns:create`: amounts come from the sale; a client `unitPrice`/`productId` is only a claim. The refund
  starts as `pending`; **it does not touch the register and does not mark anything as paid**. Paying is a separate, authorized operation:
  `returns:createWithRefund` (new return + payment) and `returns:settleRefund` (pending return), both with an administrator PIN, an explicit
  "money handed back" confirmation and an `operationId` (idempotent). Deleted products are not restocked (no recovery policy).
- Migration 0009 is additive: `refund_settlements` (one row per paid return; cash links its register movement, card never touches cash). It
  starts empty and marks nothing as paid. Cash summaries exclude refund movements from "manual withdrawals".
- Read channels added for the screens: `products:listAdmin` (admin, includes inactive/deleted), `returns:getSaleForReturn`
  (authenticated, informational: `returns:create` re-validates under locks), `reports:getSummary` (admin).
- `sales:list` / `sales:getDetail` / `receipts:preview` / `receipts:print` are authenticated, but an administrator sees every sale and a
  vendor only their own (a sale they may not see is reported as "not found"). `settings:*` and `receipts:listPrinters` are admin-only.
  The renderer sends only a sale id to the receipt channels: the document is built in main from PostgreSQL.
- Printing writes nothing to the database. Print automation (`POS_PRINT_MODE_FILE`) and `POS_DEV_PORT` exist only in
  unpackaged builds.
- Migration 0008 is additive: `cash_movements.sale_id` (NULL for manual movements), filled for old rows only when the sale exists, is in the same register and the amount matches its payment method. Cash summaries use it instead of the movement text.
- Migration 0007 is additive: `sales.operation_id`, `sale_items.product_name/product_sku` (NULL on old sales, never back-filled),
  `business_settings` (one row, name "Estética Leal", everything else empty).
- Unexpected errors reach the UI only as `[ERROR_INTERNO]`; details go to the main-process log, redacted.

## Decisions still pending (product)

- Who may read the full sales history and process returns (`sales:getAll`, `sales:getById`, `returns:*` are open
  to any signed-in user today).
- (decided in Sprint 05) How a pending refund is settled: cash from the register or card terminal, approved with an administrator PIN. Still open: how to
  resolve `legacy_unspecified` returns (the POS refuses to pay them: it cannot know whether they were already paid).
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
- **Dependencies (Sprint 04):** the 45 findings (2 critical, 32 high) were reduced to **4 moderate, all dev tooling**; `npm audit --omit=dev`
  reports **0**. Applied: `npm audit fix` (semver-compatible: drizzle-orm 0.45.4, electron-updater, vite, postcss and transitives),
  **Electron 39.2.5 -> 45.1.0**, **react-router-dom 6 -> 7.18**, **electron-builder 24 -> 26.18**, drizzle-kit 0.31.11, and the **unused `zod`
  dependency was removed** (nothing imports it). Every upgrade was validated with the full suites and the packaged smoke test. Left: `drizzle-kit`
  (via `@esbuild-kit/*` -> esbuild's dev-server advisory): dev-only generator, and npm's only "fix" is a downgrade to 0.18.1 that this
  project cannot use. Nothing was applied with `--force`. Remaining non-security majors (React 19, Vite plugin 6, lucide 1.x, eslint 10...) were not touched.
- **Operational safety (Sprint 04):** the app never migrates a database (it verifies the schema and refuses to run otherwise); migrations,
  verified backups, restore into a new database and a least-privilege runtime role are explicit commands (`docs/OPERATIONS.md`).
  Open items: backups have no off-site copy, the admin commands are Node scripts (a store with only the installer needs them delivered),
  `config.json` still keeps the password in clear text (use the runtime role; DPAPI storage is future work).
- **Owner decision pending on access:** `returns:getAll`, `returns:getSaleForReturn` and `returns:create` are still open to every signed-in
  user (a vendor can look up, and return against, another seller's sale). Documented and pinned by a test, not changed. Paying a refund is not
  open: it needs an administrator PIN.
- **Refund PIN (Sprint 05):** the administrator authorization has its own attempt budget (a successful login does not reset it). The pre-existing login
  counter can still be reset by any successful login, so a signed-in user could alternate guesses at an administrator PIN through the login screen;
  only longer PINs and the lock slow that down. The system records what the operator confirms about the physical delivery of money; it cannot verify it.
  Cash refunds are taken from the register open at payment time, not necessarily the session of the sale. No physical printer was tested for the voucher.
- **Backups:** verified manual and schedulable (Task Scheduler wrapper) backups exist; nothing copies them off the machine. PostgreSQL must be installed and managed on each machine.
- Lighter-weight leftovers: a legacy unused `drizzle/migrations/0001_initial.sql`,
  the renderer lint is still gentle (warnings only for unused names).

## Requirements before distributing to a real store

1. (done) PIN storage is salted scrypt. 2. (done) Packaged renderer and configuration path.
3. (done) Screens for product/inventory/price management, returns and reports.
4. Decide the pending product questions. 5. Dependency upgrade + audit. 6. Backup/restore procedure.
7. (done) Electron shell hardening. Still open: code signing certificate and a trusted update channel.
