# Packaging and database configuration (Windows)

## Build

```bash
npm run package:dir   # unpacked app: release/win-unpacked/Beauty POS.exe  (used by the smoke test)
npm run package       # NSIS installer in release/ (unsigned, see below)
npm run test:packaged # launches the packaged exe against a throwaway database and drives it through the UI
```

`release/` is git-ignored. The package contains `dist/` (main, preload, renderer), `drizzle/` (migrations) and the
production `node_modules`. It never contains `.env`, credentials or source maps (`test:packaged` asserts this).

## Renderer under `file://`

* Vite builds with `base: "./"` and the app uses `HashRouter` (routes look like `index.html#/sales`), so assets and
  navigation work from `app.asar`.
* The IPC origin check (`sender-guard.ts`) accepts exactly `<app path>/dist/renderer/index.html` (hash ignored) in a
  packaged build, and exactly `http://localhost:5173` in development. Any other document is rejected.

## Shell hardening (main process)

* `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, DevTools disabled and no application menu when packaged.
* `window.open`, `<webview>` and navigation/redirects to anything but the app's own page are blocked.
* All web permission requests (camera, notifications, geolocation, ...) are denied.
* The packaged `index.html` carries a Content-Security-Policy (`default-src 'self'`, no `unsafe-eval`, no inline scripts).
  The dev server has no CSP (Vite hot reload needs inline scripts), so CSP is only exercised by the packaged tests.
* Auto-update is **off**. It only runs if `POS_UPDATE_FEED_URL` is set to an `https://` feed, and updates should only be
  trusted once the installer is code-signed. The old placeholder feed (`http://localhost/updates`) was removed.

## Database configuration

The connection string is **never packaged**. It is resolved at startup, in this order:

1. `DATABASE_URL` in the process environment.
2. Packaged app: `config.json` in the user data folder (`%APPDATA%\Beauty POS\config.json`):
   `{ "databaseUrl": "<PostgreSQL connection URL: role, password, localhost:5432, database name>" }` (same format as
   `DATABASE_URL` in `.env.example`).
   Development: `.env` in the working directory (a packaged app never reads `.env`).

Rules and risks:

* The host must be loopback (`localhost`, `127.0.0.1`, `::1`). A LAN server requires an explicit `POS_ALLOW_REMOTE_DB=1`.
  Never expose PostgreSQL to the internet.
* `config.json` stores the password in plain text, readable by that Windows user (and administrators). Use a dedicated
  PostgreSQL role with only the privileges the app needs (it runs migrations, so it needs DDL on its own database), a
  strong unique password, and restrict the folder to the store's Windows account. Do not reuse a shared password.
* Without a valid configuration the app shows a "configuration missing" window, registers no IPC handler and runs no query.
* The connection string and password are redacted from logs and from errors that reach the renderer.

First run: create the database and role in PostgreSQL, write `config.json` (or set `DATABASE_URL`), start the app (it
applies the migrations), then create the first administrator with `npm run seed:admin` (see `docs/STATUS.md`).

## Known external blockers

* **Code signing:** the installer and exe are unsigned, so Windows SmartScreen warns and auto-update is not trustworthy.
  A code-signing certificate is required for distribution (`signAndEditExecutable` is disabled so the unsigned test build
  does not need the signing toolchain).
* **Application icon:** no `build/icon.ico` exists; the default Electron icon is used.
* PostgreSQL must be installed and running on the store's machine/server; the installer does not provision it.
