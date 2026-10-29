# Real status, known risks and distribution requirements

Verified against the code and the automated suites (see `docs/TESTING.md`). The root `README.md` still
describes the early MVP and is intentionally not edited here.

## What works (covered by tests that drive the real window and PostgreSQL)

| Area | State |
|---|---|
| Login by PIN, roles (admin/vendor), sessions owned by the Electron main process, revocation, brute-force limiter | implemented and tested |
| Sales (cash / card) priced and totalled in the main process, stock-safe under concurrency | implemented and tested |
| Cash register: one shared register, open/close, income/withdrawal without overdraft, status coherent | implemented and tested |
| Catalog admin: create/update product, inventory movements (signed deltas), audited price changes, logical delete | **backend** implemented and tested; **no screens** yet (inventory/receive/price pages are placeholders) |
| Returns: validated against the sale, no over-return, restock, refund recorded as `pending` | **backend** implemented and tested; **no screen** yet (the returns page is a placeholder) |
| Users: create/update/deactivate, unique PIN, last-admin protection | implemented and tested (existing users page) |
| Dashboard: sales, cash, pending vs paid refunds | implemented; figures shown as-is |
| Reports, receipt/ticket printing, thermal printers, backups, settings | **not implemented** |
| Packaged installer / auto-update | **not production ready** (see below) |

## Contracts worth knowing

- `users:delete` is a **logical deactivation** (history is never orphaned); `users:getAll` lists active users only.
- `products:update` can no longer change `stock` or `price`: use `inventory:addMovement` / `priceChanges:create`.
- `inventory:addMovement`: `amount` is the signed stock delta (IN > 0, OUT < 0, ADJUST signed); `DELETE` is reserved.
- `returns:create`: amounts come from the sale; a client `unitPrice`/`productId` is only a claim. The refund
  starts as `pending`; **the cash register is not touched and nothing marks a refund as paid** (no settlement
  operation exists yet). Deleted products are not restocked (no recovery policy).
- Unexpected errors reach the UI only as `[ERROR_INTERNO]`; details go to the main-process log, redacted.

## Decisions still pending (product)

- Who may read the full sales history and process returns (`sales:getAll`, `sales:getById`, `returns:*` are open
  to any signed-in user today).
- How a pending refund is settled (cash from the register? card reversal? who approves?) and the paid state.
- Whether each user has their own register (today one shared register).
- Taxes and discounts (deliberately absent).
- Policy for returns of deleted products.

## Known risks (not fixed)

- **PIN security (blocks distribution):** PINs are 4 digits hashed with an **unsalted SHA-256**. The limiter slows
  guessing in the app, but anyone who can read the database can recover every PIN instantly.
  *Recommendation before distributing:* store `scrypt`/`argon2id` hashes with a per-user salt (new
  `pin_algo`/`pin_salt` columns), verify legacy SHA-256 hashes on login and upgrade them in place, allow longer
  PINs/passphrases, keep the global limiter, and keep the unique-PIN rule through a keyed lookup hash.
- **Packaged build is broken:** the renderer is built with absolute asset paths and `BrowserRouter`, which fail
  under `file://`. Needs `base: "./"` and `HashRouter`.
- **Configuration in the installer:** `DATABASE_URL` is read from a `.env` that is not packaged; the installer
  needs its own configuration story (and credentials must not ship in the app).
- **Installer assets:** `build/icon.ico` is missing; the updater feed is a `http://localhost` placeholder; no code signing.
- **Electron shell hardening not done:** default application menu (DevTools reachable), no `setWindowOpenHandler`,
  no navigation blocking, no Content-Security-Policy. IPC authorization does not depend on any of these.
- **Dependencies:** `npm audit` reports vulnerabilities (Electron 39.2.5 among them); they need a controlled upgrade.
- **Backups and restore** are not automated; PostgreSQL must be installed and managed on each machine.
- Lighter-weight leftovers: a legacy unused `drizzle/migrations/0001_initial.sql`, duplicate `AppRouter.tsx`,
  the renderer lint is still gentle (warnings only for unused names).

## Requirements before distributing to a real store

1. Replace the PIN storage (above). 2. Fix the packaged renderer and the configuration/installer path.
3. Build the missing screens that make the backend usable (product/inventory/price management, returns).
4. Decide the pending product questions. 5. Dependency upgrade + audit. 6. Backup/restore procedure.
7. Electron shell hardening and code signing/updater.
