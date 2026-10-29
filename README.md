# Beauty Supply POS

A desktop point-of-sale system for beauty supply operations, built with **Electron, React, TypeScript, and PostgreSQL**. It is designed around a local-first workflow: sales and inventory operate against a local PostgreSQL database without requiring a hosted service.

> **Status:** In active development. The security model and release-readiness are being reviewed. Do not assume this repository is ready to handle real business operations without a separate deployment and security assessment.

## Features

| Area | Scope |
| --- | --- |
| Sales | Product lookup, cart, checkout, and sales history |
| Inventory | Product catalog, stock movements, and price changes |
| Cash management | Opening, cash movements, closing, and reconciliation |
| Access control | PIN-based sign-in and role-specific workflows |
| Returns | Under development |
| Reports and administration | Under development |

The implementation may change as ongoing security and end-to-end testing work is completed.

## Technology

- **Desktop:** Electron with isolated preload/IPC integration
- **Frontend:** React, TypeScript, Vite, Tailwind CSS
- **Data:** Local PostgreSQL with Drizzle ORM and SQL migrations
- **Tooling:** tsup, ESLint, TypeScript, electron-builder

## Local development

Requirements: a supported Windows development environment, Node.js, npm, and a running local PostgreSQL database.

```bash
npm install
npm run dev
```

The application requires database setup and environment configuration. Consult the repository's example environment files and migration scripts before starting the application. Do not commit local `.env` files or real business data.

Useful commands:

```bash
npm run typecheck
npm run lint
npm run build
npm run db:check
```

Database migrations are state-changing operations. Review the intended target database and migration scripts before using `npm run db:migrate`.

## Architecture

```text
Electron main process
  └─ IPC handlers / application services
       └─ Local PostgreSQL database
Electron preload bridge
  └─ React renderer (Vite)
```

Electron, application services, and the React renderer have distinct responsibilities. Security-sensitive IPC and session behavior is an active area of review.

## Project boundaries

This is a desktop application, **not** a remotely hosted checkout service. Publishing a landing page or demonstration would not expose the production point-of-sale application or its local database.

## Licensing and assets

The repository does not currently include a standalone `LICENSE` file. Licensing and ownership must be verified before permission to redistribute or reuse the project is granted. A package metadata field is not a substitute for reviewing applicable rights, dependencies, and assets.
