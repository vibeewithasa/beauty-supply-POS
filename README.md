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

### Additional modules (in progress)
- Full and partial returns
- Sales and inventory reports
- Administration dashboard
- User administration and extended inventory management
- Receipt printer support

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

- Windows for the packaged desktop application
- Node.js and npm compatible with the project's dependencies
- A locally running PostgreSQL instance

This project is designed to operate locally. PostgreSQL is a local service and must still be installed and running.

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

Apply the database migrations and start the app:

```bash
npm run db:migrate
npm run dev
```

For local development, `npm run seed:admin` can provision a sample administrator account. **Never reuse development credentials or default PINs in a real deployment.**

## Available scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the desktop application in development mode |
| `npm run build` | Build the application |
| `npm run package` | Package a Windows installer |
| `npm run db:generate` | Generate database migrations |
| `npm run db:check` | Check migration consistency |
| `npm run db:migrate` | Apply migrations |
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

## Roadmap

- [ ] Complete return and refund workflows
- [ ] Expand analytics and exportable reports
- [ ] Improve inventory administration
- [ ] Add compatible thermal receipt printer support
- [ ] Implement and validate automated backups
- [ ] Explore optional multi-location functionality

## Project information

**Purpose:** Local POS software for beauty supply businesses  
**Current stage:** Active development  
**License:** No root `LICENSE` file is currently present. Confirm rights to the source code and third-party assets before selecting or applying a license.
