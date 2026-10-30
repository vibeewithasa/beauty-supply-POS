# Operations: database protection, migrations, backups

Everything here was exercised by `npm run test:migrations`, `npm run test:ops` and `npm run test:packaged` on
throwaway databases (`beauty_pos_e2e_*`) and test roles that those runs create and remove.

## The three rules

1. **The application never changes a database schema.** At startup it only checks (with `SELECT`s) that the database has
   exactly the migrations this version requires. If not, it shows a plain explanation and registers no operation at all
   (no login, no sales). It never creates tables, never runs a migration, even on an empty database.
2. **A schema is changed only by an explicit command** (`npm run db:migrate -- --apply --confirm-database=<name>`), after a
   precheck and a verified backup.
3. **Restores only create a new database.** Nothing in this repository drops, overwrites or restores over an existing
   database (the only `DROP DATABASE` calls are in the tests, on databases the test itself created).

## Daily use in development

`npm run dev` starts the app against the database in `.env`. If the window says *"La base de datos necesita actualizarse"*,
the database is behind this version: follow *Updating a database* below. Nothing was changed by opening the app.

Check at any time (read-only):

```bash
npm run db:status
```

## Updating a database (migrations)

```bash
npm run db:backup -- --label antes-de-actualizar                    # optional extra copy
npm run db:migrate                                                  # report + dry run: changes NOTHING
npm run db:migrate -- --apply --confirm-database=<database-name>   # does the update
```

`--apply` refuses to run unless `--confirm-database` repeats the exact database name (an explicit decision about *that*
database). On a database that already has data it then: runs the read-only integrity precheck (blockers stop everything),
takes a **verified backup** (`pg_dump` + `pg_restore -l` + SHA-256) in `POS_BACKUP_DIR`
(default `%USERPROFILE%\Backups\beauty-pos`, always outside the project), and only then migrates and re-verifies. A brand-new
empty database needs neither. A database from a *newer* version is refused.

### What to do with the owner's `beauty_pos`

Read-only inspection on 2026-10-30 (before this sprint changed anything) showed `beauty_pos` at **7 applied migration rows =
migrations 0000-0006**, with the owner's own manual-test data (9 sales, 3 cash sessions). Migration **0007** (sales history,
receipts, settings), **0008** (cash movement sale link, used by the register history) and, since Sprint 05, **0009** (refund ledger,
`refund_settlements`) are **pending**. With this version,
opening the POS on it shows the "needs updating" window and changes nothing. Update it deliberately:

```bash
npm run db:migrate                                          # review the plan
npm run db:migrate -- --apply --confirm-database=beauty_pos
```

**Validated on a copy (Sprint 06, `npm run test:legacy`).** The newest validated backup (`beauty_pos_sprint04_after-user-manual-tests_20261030T051158.dump`, taken after the
owner's manual tests; its SHA-256 matches its summary) was restored into a NEW disposable database, and the whole update was run there with the real commands: the dry run
reported exactly `0007`, `0008` and `0009` as missing and changed nothing; `--apply` refused to run without the exact database name, took a verified pre-migration backup
and applied them. The counts the backup itself recorded were checked, not assumed: **9 sales, 3 register sessions, 12 cash movements, 9 inventory movements, 2 users
(one scrypt, one legacy SHA-256), 1 product, 0 returns**. After the migration every historical table is byte-identical (compared without the columns the migrations add),
every foreign key has no orphan, every sale equals the sum of its lines, the 3 sessions reconcile to the cent, **9 of the 12 cash movements were linked to their sale** (the
other 3 are manual movements), the business settings row is the default one, the refund ledger is empty and nothing became "paid". The packaged application then opened that
copy and showed the history, a receipt, the three register sessions and a report whose totals equal SQL; a scrypt test admin and a legacy-hash test vendor (added to the COPY)
both signed in and the legacy hash was upgraded. `beauty_pos` itself was not opened by that test, and the backup files were only read (SHA-256 and timestamps compared).
Remember it is **not** applied to `beauty_pos`: that is your decision.

## Backups

```bash
npm run db:backup                                       # manual, to POS_BACKUP_DIR or %USERPROFILE%\Backups\beauty-pos
npm run db:backup -- --out "D:\Respaldos POS" --label diario --keep 14
```

* File: `<database>_<label>_<UTC timestamp>.dump` (PostgreSQL custom format) plus `<same name>.summary.json` (row counts,
  schema fingerprint, applied migrations, size, SHA-256). Never overwritten. Credentials are never written anywhere.
* The destination must be outside the project; backups contain real data and never go to Git (`*.dump` and the folder are
  not part of the repository).
* `--keep N` keeps the newest N backups **made by this tool for this database** and deletes older ones with their
  summaries. Other files in the folder are never touched.
* Exit code 0 only when the dump was verified; otherwise non-zero and a safe message. Paths with spaces are supported.

### Second copy (external location)

```bash
npm run db:backup -- --out "D:\Respaldos POS" --label diario --keep 14 --second-copy "E:\Copia externa"
set POS_BACKUP_SECOND_DIR=E:\Copia externa            # or this variable (used by scripts/db-backup-task.cmd)
```

* The second location is chosen **by the operator**: an external drive, a USB stick, or a folder of another PC of the local network. The tool only COPIES there.
  It uploads nothing to any service, **refuses URLs** (`https://`, `s3://`, ...) and the **folders that cloud clients synchronize** (OneDrive, Dropbox, Google Drive, iCloud,
  MEGA, Nextcloud; `POS_ALLOW_SYNCED_FOLDER=1` overrides it under your responsibility), the **same place** as the primary and a folder **inside the project**.
* Every file (the dump and its summary) is copied to a `.partial` name, **verified with SHA-256**, and only then renamed. A file that already exists is never replaced (the same
  content is recognised as already there; different content is reported and kept). **Nothing is ever deleted** from the second location (`--keep` only prunes the primary one).
* If the location is not there (drive unplugged) or not writable: the primary backup still counts and is complete, the second copy is reported as `unavailable`, and the command
  exits with code **3** (so Task Scheduler shows it). A refused or failed second copy exits 3 as well. Exit 0 means primary AND second copy verified.
* Every run appends a dated line to `backup.log` next to the primary backups: `OK <db> <file> <size> sha256=... second=verified|unavailable|failed dir=...`.
* **Recovery from the second copy** is tested: `npm run db:restore -- --file "E:\Copia externa\<dump>" --target <new_db>` checks the SHA-256 against the summary copied next to it and
  compares rows, migrations and schema; a corrupted copy is refused with `CHECKSUM` and no database is left behind.
* **Privacy and protection of backups.** A backup holds the whole database: customers' purchases, users' names and the PIN hashes (old accounts may still carry an unsalted SHA-256 hash
  until they log in once). Keep the external media encrypted (BitLocker To Go) or physically controlled, never share the folder, never put it in Git, and remember that the
  primary backups are also on the PC. There is no off-site/cloud copy by design.

### Scheduling (Windows Task Scheduler)

`scripts/db-backup-task.cmd` runs a daily-labelled backup, keeps 14, and appends the output to `task.log` in the backup folder.
From an administrator or normal prompt (adjust the time):

```bat
schtasks /Create /TN "Beauty POS backup" /SC DAILY /ST 22:30 /RL LIMITED /F ^
  /TR "\"C:\Projects\beauty-supply-POS\scripts\db-backup-task.cmd\""
schtasks /Run /TN "Beauty POS backup"
```

Requirements: Node.js on the machine, the project folder with `node_modules`, `.env` with `DATABASE_URL`, and the PostgreSQL
client tools (`pg_dump`/`pg_restore`; or set `POS_PG_BIN`). Check `task.log` and `backup.log` regularly: a failed run is
logged as `FALLO` and Task Scheduler shows a non-zero result. **Use the second copy** (see above): a backup on the same disk does not survive the disk.

### Restoring (always into a NEW database)

```bash
npm run db:restore -- --file "C:\Users\me\Backups\beauty-pos\beauty_pos_diario_20261030T223000Z.dump" --target beauty_pos_recuperada
```

It checks the checksum against the `.summary.json`, creates `beauty_pos_recuperada` (it must not exist; `beauty_pos`,
`beauty_pos_smoke`, `postgres`, templates and the configured database are refused), restores, and compares row counts,
migrations and the schema fingerprint. If anything fails it drops only the database it just created.

To go back to a recovered copy: stop the POS, point `DATABASE_URL` (`.env` or `config.json`) at the new database name, start
the POS, and check the data. **Keep the old database** until you are sure; deleting it is a manual, deliberate decision.

### If something goes wrong

| Situation | What to do |
|---|---|
| The POS says the database needs updating | Normal after installing a newer version: back up, `db:migrate` dry run, then `--apply` |
| The POS says the database is newer | You are running an older app: install the current version. Do not "fix" the database |
| `db:migrate --apply` fails | Nothing half-applied (one transaction). The verified pre-migration backup path is printed; restore it into a new database if needed |
| Wrong data written / disaster | Stop the POS, restore the latest verified backup into a new database, point the POS at it |
| Backup task fails | Read `backup.log`/`task.log`; typical causes: PostgreSQL stopped, wrong credentials, disk full, missing `pg_dump` (set `POS_PG_BIN`) |
| PostgreSQL restarts while the POS runs | The pool drops the lost connections and reconnects on the next operation; the app does not crash |

## Credentials and least privilege

* Packaged app: `DATABASE_URL` in the environment, or `%APPDATA%\Beauty POS\config.json` (see `docs/PACKAGING.md`). Since Sprint 06 the password in `config.json`
  is **encrypted with Windows (safeStorage / DPAPI), bound to the Windows user**, written by the first-run setup window; a legacy plain-text file is upgraded in place.
  Copying the file or the profile to another user or PC does not work. Any process running AS that Windows user can still use the application's connection: that is why the role below matters.
* Because the app no longer migrates, its runtime connection does not need to own or alter anything. Create a login that can only
  read and write data:

```bash
npm run db:roles -- --role pos_runtime                       # prints the plan, changes nothing
set POS_RUNTIME_PASSWORD=<at least 12 random characters>
npm run db:roles -- --role pos_runtime --apply --confirm-database=<database-name>
```

  Then use that login in `DATABASE_URL`/`config.json`; keep the owner login only for `db:migrate`/`db:backup`/`db:restore`.
  After every migration run `npm run db:roles -- --role pos_runtime --regrant --confirm-database=<name>` so new tables are covered.
  The role **cannot** create/alter/drop tables, truncate, forge or edit migration rows, or create roles/databases (verified by
  `OPS-07` and, with the packaged app, `PK-14`). The tool never alters a role it did not create and never takes the password from the command line.
* The setup window checks the role it is given: a superuser, a role that can create databases or roles, or an owner of tables gets a warning (it can still be saved, the operator decides).
  The administrator's `postgres` password and the owner login are for `db:migrate`, `db:backup`, `db:restore` and `db:roles` only; they are never typed into the application.
* The PIN-attempt counter (login and administrator authorization share it) is persisted in `%APPDATA%\Beauty POS\auth-limiter.json` (three numbers, no PIN or user); deleting it
  resets the counter, which is a limit of any local file: the real defences are PostgreSQL's own protection and the Windows account.

## Databases that must never be used by tests

`beauty_pos`, `beauty_pos_smoke`, the preserved `beauty_pos_e2e_mvt8e0lo9825` / `beauty_pos_e2e_mvt8xx9l9133`, and any database
with real data. The E2E runners create their own `beauty_pos_e2e_<id>` database, migrate it explicitly
(`prepareRunDb`, which refuses a database it did not create or that already has tables), and drop only that one. `DATABASE_URL`
is used by the tests only to find the local server and its credentials. Run the tests next to a developer session with
`E2E_PORT=5183`.

## Known limits

* The administrative commands are Node scripts: a store machine that has only the installed app needs the project's `scripts`
  folder and Node.js (or an operator who does). Bundling them with the installer is future work.
* Backups are as good as their second copy; there is no cloud/off-site step here.
