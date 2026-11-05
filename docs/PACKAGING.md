# Packaging and database configuration (Windows)

## Build

```bash
npm run package:dir   # unpacked app: release/win-unpacked/Beauty POS.exe  (used by the smoke test)
npm run fetch:postgres # downloads (once) and verifies the pinned PostgreSQL package into vendor/pg-bundle (git-ignored; also run by package)
npm run package       # NSIS installer in release/ (unsigned, see below): release/Estética Leal POS Setup <version>.exe
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

1. `DATABASE_URL` in the process environment (the operator's own configuration; it is never stored and never opens the setup window).
2. Packaged app: `config.json` in the user data folder (`%APPDATA%\Beauty POS\config.json`), written by the **first-run setup window** and **protected by Windows**:
   `{ "version": 2, "host", "port", "database", "user", "passwordEncrypted": "<DPAPI blob>" }`. Only the password is secret and it is encrypted with Electron
   `safeStorage` (Windows DPAPI): it can only be decrypted by the same Windows user on the same machine. A **legacy plain-text file**
   (`{ "databaseUrl": "<connection URL>" }`) is still read and is **upgraded in place** at the first start (the new file is verified to decrypt to the same
   password before it replaces the old one; no backup copy of the plain text is made).
   Development: `.env` in the working directory (a packaged app never reads `.env`). `POS_USE_CONFIG_FILE=1` makes a development build use `config.json`
   instead (tests only).

Rules and risks:

* The host must be loopback (`localhost`, `127.0.0.1`, `::1`). A LAN server requires an explicit `POS_ALLOW_REMOTE_DB=1`.
  Never expose PostgreSQL to the internet.
* Encrypting the password does **not** replace least privilege: whoever runs as that Windows user can still use the application's own connection. Use a
  dedicated PostgreSQL role with only data privileges (`npm run db:roles`, see `docs/OPERATIONS.md`: the app no longer migrates, so its runtime login
  needs no DDL), a strong unique password, and a Windows account used only by the store.
* **Fail-safe:** with no protected storage available nothing is saved (never a plain-text fallback); an existing file is left exactly as it was. A password that the
  current Windows account cannot decrypt (another user, another PC, a copied profile) opens the setup window with the data prefilled. `safeStorage` only works once the
  app is ready, so the database module is loaded after that (`main.ts`).
* Without a valid configuration the app opens the **setup window** (own preload with four calls; no application channel is registered; it never migrates). A bad
  `DATABASE_URL` shows an explanation window instead. `"Beauty POS.exe" --reconfigure` opens the setup window again to point the app at another database.
* The connection string and password are redacted from logs and from errors that reach the renderer.

First run: create the database in PostgreSQL, prepare its schema with the explicit command (`npm run db:migrate -- --apply
--confirm-database=<name>`: the app does NOT create or migrate it and the setup window only reports what is missing), create the runtime role
(`npm run db:roles`), start the app: the setup window tests the connection, reports PostgreSQL's version, the role's privileges and the schema version,
creates the first administrator (6 to 8 digit PIN) and stores the connection protected by Windows. `npm run seed:admin` remains available for headless setups.
The full procedure is in `docs/PILOT_CHECKLIST.md`.

## Installer status (NSIS)

* `npm run package:dir` (unpacked) is what `test:packaged` drives (16 checks, including the protected configuration and the setup window).
* (Version 0.1.0 history) The **NSIS installer was generated** with `electron-builder --win nsis` into a temporary folder (outside the repository, deleted afterwards): `Beauty POS Setup 0.1.0.exe`,
  about 120 MB, unsigned, default Electron icon. Its payload was extracted (without installing) and `resources/app.asar` is **byte-identical** to the one the packaged tests ran
  against (SHA-256 `ac4d880d…`), with no `.env`, `config.json`, dump or credential inside. Generating it downloaded the NSIS build tools into the electron-builder cache.
* **It was NOT installed or uninstalled.** There is no disposable Windows environment on the development PC (Windows 11 Home: no Windows Sandbox, no Hyper-V) and installing on the
  owner's Windows was not authorized. Clean install, first start from an installed copy, Start Menu entry, uninstall and "PostgreSQL data preserved after uninstall" are **pending**
  (run them in a VM or a spare PC). The NSIS configuration is one-click, per-user. Installers are never published or distributed from this repository.

## Self-contained installer (Sprint 07.1, version 0.8.0; 0.8.1 is the same installer with two screen fixes)

* `npm run package` now also carries a **PostgreSQL 18 package** (official EnterpriseDB binaries, pinned by SHA-256 in `scripts/postgresql-pin.json`, pruned, with the Visual C++ runtime DLLs
  next to them and a per-file hash manifest) as `resources\postgresql`. The package is fetched from the Internet **at build time only**, never when installing; `vendor/` is git-ignored (no binaries in Git).
* The installer is `release/Estética Leal POS Setup 0.8.1.exe` (NSIS, one-click, per-user, no administrator, `appId` unchanged so 0.7.0 installs update in place). It is about 142 MiB.
* With nothing configured, the first start opens the **installation wizard** (demonstration or clean) that creates a dedicated PostgreSQL instance under `%LOCALAPPDATA%\Estetica Leal POS`; an existing
  `config.json` (0.7.0 or an explicit external PostgreSQL) is respected and never triggers it. Details and decisions: `docs/SELF_CONTAINED_INSTALLER.md`; laptop guide: `docs/DEMO_INSTALL_LAPTOP.md`.
* `resources\tools` also carries `Mantenimiento.cmd` (the maintenance window) and the 0.7.0 `Preparar-Base-Demo.cmd/.ps1` (for a PostgreSQL the operator installed separately).
* Tests that need the installer: `npm run test:installer-app` (extracts it and drives the wizard through the real UI), `npm run test:demo` (the external-PostgreSQL rehearsal), both without installing anything.
  The NSIS install/uninstall themselves still require a real Windows machine.

## Known external blockers

* **Code signing:** the installer and exe are unsigned in the documented test builds, so Windows SmartScreen may warn and
  auto-update should not be trusted as a signed release. The current `package.json` sets `build.win.signAndEditExecutable: true`;
  this is a build option, **not** evidence that an unsigned build acquired a signature. A distribution build needs an actual
  code-signing certificate and verification of the resulting executable and installer signatures (for example with
  `Get-AuthenticodeSignature` in PowerShell). Do not represent test artifacts as signed.
* **Application icon:** a provisional "EL" mark (`assets/brand/icon.png`, generated by `node scripts/make-app-icon.mjs`) is embedded in the exe and the shortcuts. It is **not** the store's logo: replace the PNG when real artwork exists.
* PostgreSQL is no longer a prerequisite: the installer carries its own (see above). A store server shared by several machines, or a managed PostgreSQL, is still an explicit external connection (advanced path).
