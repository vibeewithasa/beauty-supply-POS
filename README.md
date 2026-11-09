# Beauty Supply POS

A desktop point-of-sale (POS) application for beauty supply distributors. Built with **Electron, React, TypeScript, Drizzle ORM, and PostgreSQL**, it is designed for local operation without relying on a hosted backend.

> **Development status:** This is an evolving project. Some features described below are implemented, while others are planned or under development. Refer to the current source code and tests for the latest behavior.

## Key features

### Sales
- Product search by name, SKU, or barcode
- Shopping cart with quantity management
- Cash and card payment workflows
- Sales receipts and inventory updates

### Cash register
- Open a cash session with an initial balance
- Record cash deposits and withdrawals
- Close a session and reconcile expected and counted cash
- Review cash movement history

### Inventory
- Product catalog with pricing, stock, and status
- Search and filtering
- Stock adjustments and movement tracking
- Price-change history and soft-deletion workflows

### Returns and refunds
- Full and partial returns with stock reconciliation
- Refunds paid in cash or recorded as paid by card, authorized with an active administrator PIN
- Pending refunds tracked separately from paid and legacy returns; no automatic bank operation

### History, reports, and receipts
- Searchable sales history, receipt preview and reprinting
- Commercial (non-fiscal) receipts in 80 mm and 58 mm formats
- Reports with sales, returns, payment breakdowns, and CSV export
- Dashboard, user administration, and audited inventory operations

Physical printer, barcode scanner, touch-screen, and card-terminal integration still require hardware validation. See [verified feature status](docs/STATUS.md).

## Technology stack

| Layer | Technology |
| --- | --- |
| Desktop shell | Electron |
| UI | React, TypeScript, Vite |
| Styling | Tailwind CSS, shadcn/ui |
| Data | PostgreSQL, Drizzle ORM |
| Desktop communication | Electron IPC / preload bridge |
| Packaging | electron-builder |

## Requirements

**Developing from source** requires Windows, Node.js and npm compatible with `package.json`, and a local PostgreSQL instance configured in `.env`.

**Installing the 0.8.1 Windows application** is different: the self-contained installer includes a dedicated PostgreSQL 18 instance and does not require a separate Node.js or PostgreSQL installation. It runs locally and offline after installation. The packaged installer has been rehearsed against an isolated PostgreSQL instance, but installing and uninstalling the NSIS executable on a clean Windows laptop still needs manual verification. See [laptop installation](docs/DEMO_INSTALL_LAPTOP.md).

## Getting started

Clone the repository, then run:

```bash
cd beauty-supply-POS
npm install
```

Create a local PostgreSQL database and configure the environment:

```bash
createdb beauty_pos
cp .env.example .env
```

Update `.env` with your local database settings. On Windows PowerShell, you can use `Copy-Item .env.example .env` instead of `cp`.

Inspect the migration plan, then explicitly apply it to the intended development database before starting:

```bash
npm run db:migrate
npm run db:migrate -- --apply --confirm-database=beauty_pos
npm run dev
```

The first command is a **read-only dry run**, not an installation step that updates the schema. The second command is an explicit schema change: review its target first, and follow [the migration and backup procedure](docs/OPERATIONS.md) for any database containing data. Never apply migrations to another database by accident.

For source-based local development, `npm run seed:admin` creates an administrator using the database configured by `DATABASE_URL`. It has **no default PIN**: run it in an interactive terminal to enter a new 6–8 digit PIN twice (input is hidden). A noninteractive run requires `ADMIN_PIN` for that invocation only; clear it from the environment afterward and never put it in source control or a shared terminal transcript. This command is not needed for the self-contained installer, whose wizard creates the first administrator. See `scripts/seed-admin.mjs` and [operations](docs/OPERATIONS.md).

## Available scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the desktop application in development mode |
| `npm run build` | Build the application |
| `npm run package` | Package a Windows installer |
| `npm run db:generate` | Generate database migrations |
| `npm run db:check` | Check migration consistency |
| `npm run db:migrate` | Inspect pending migrations without applying them; use `-- --apply --confirm-database=<name>` only after review |
| `npm run seed:admin` | Seed a local development administrator |
| `npm run typecheck` | Run TypeScript checks |
| `npm run lint` | Run ESLint |

## Architecture

The Electron main process hosts application lifecycle logic and connects to the local PostgreSQL database through the application's backend modules. The React renderer displays the user interface. The preload layer provides a controlled IPC bridge between the renderer and the main process.

```text
React renderer (Vite)
        |
        | Preload / IPC bridge
        v
Electron main process + application services
        |
        v
PostgreSQL (local database)
```

Key source directories:

- `src/main/` — Electron main process
- `src/preload/` — preload and renderer bridge
- `src/backend/` — application logic and database access
- `src/renderer/` — React user interface
- `src/common/` — shared types
- `drizzle/` — database migrations

## Security and operational notes

- Keep database credentials in local environment files, not in version control.
- Verify the authentication and IPC authorization implementation before production use.
- Seeded development users and test PINs are not production credentials.
- Review migration and backup procedures before storing business data.
- This README is a project overview, not a security certification.

## Demonstration on a laptop

`npm run package` builds a **self-contained** Windows installer (`release/Estética Leal POS Setup <version>.exe`): it carries a pinned official PostgreSQL and its first-start wizard prepares a dedicated,
local-only database (demonstration or clean) with no manual PostgreSQL work. `docs/DEMO_INSTALL_LAPTOP.md` is the laptop guide, `docs/SELF_CONTAINED_INSTALLER.md` the architecture and `docs/DEMO_CHECKLIST.md`
the presentation checklist. `npm run test:installer` and `npm run test:installer-app` rehearse it against a real PostgreSQL and the extracted installer without installing anything on the machine.

## Roadmap

Implemented refund settlement, printable commercial receipts, CSV reports, local backup/restore tools, and inventory administration are tracked in [feature status](docs/STATUS.md); they should not be mistaken for future-only work.

- [ ] Validate physical thermal printers (80/58 mm), barcode readers, and touch screens on target hardware
- [ ] Complete a clean Windows install/uninstall rehearsal on a separate laptop
- [ ] Decide how to resolve legacy returns with unknown refund status
- [ ] Decide on discounts, tax handling, and any fiscal-invoicing requirements
- [ ] Define backup scheduling and external-copy policy for the self-contained installer
- [ ] Evaluate multi-location support only if operational requirements justify it

## Project information

**Purpose:** Local POS software for beauty supply businesses  
**Current stage:** Active development  
**License:** [MIT License](LICENSE) applies to code owned by the copyright holder. Third-party assets may have separate rights and are not automatically covered by this license.
