# Pilot checklist: Estética Leal

What to do, in order, to run a controlled pilot of Beauty POS on a store PC, and what is NOT verified yet. Everything marked
"tested" was exercised by the automated suites (`npm run test:all`); "NOT tested" is a real gap, not a formality.

Verdicts used in the reports (they are three different things):

* **READY FOR MERGE**: the code passed the checks and may be published in `main`.
* **READY FOR PILOT**: the product may be tried in a controlled, supervised way on a prepared PC.
* **READY FOR STORE**: installation, security, backups, hardware and daily operation meet what was agreed. **Not reached** (see the end).

> For presenting the system on a laptop with fictional data (not a pilot), see `docs/DEMO_INSTALL_LAPTOP.md` and `docs/DEMO_CHECKLIST.md`.

## 1. Preparing a new PC

1. Windows 10/11, a Windows user account for the store (not shared with unrelated users). Keep BitLocker/device encryption on if the PC can be lost.
2. Install **PostgreSQL 12+** (tested with 18) and keep its `postgres` password for the administrator only. Install Node.js 22+ and the project
   (`npm install`) **only on the PC of whoever administers it**: the `scripts` (migrations, backups) are Node scripts (see "Known limits").
3. Create the database (as the PostgreSQL administrator): `CREATE DATABASE beauty_pos;`
4. Prepare its schema explicitly (the app never does it):
   ```bash
   npm run db:migrate                                                  # dry run, changes nothing
   npm run db:migrate -- --apply --confirm-database=beauty_pos
   ```
5. Create the **runtime role** (least privilege: data only, no DDL, no ownership):
   ```bash
   npm run db:roles -- --role pos_runtime
   set POS_RUNTIME_PASSWORD=<at least 12 random characters>
   npm run db:roles -- --role pos_runtime --apply --confirm-database=beauty_pos
   ```
6. Install and start the application (the installer is unsigned, see the blockers below). With no configuration it opens the **first-run setup window**.

## 2. First start (setup window)

1. Enter server (`localhost`), port, database, the **runtime role** and its password. Press *Probar conexión*.
2. Read the checklist it shows: PostgreSQL available and its version; the database exists; **the role's privileges** (a superuser, a database/role creator or an
   owner of tables gets a warning: use the runtime role instead); the **schema version** ("al día" or which migrations are missing, with the command to run);
   whether an administrator exists.
3. If there is no administrator: create the first one (name, PIN of 6 to 8 digits, repeated). It is stored only as a salted hash.
4. *Guardar y reiniciar*. The password is stored **protected by Windows (DPAPI, bound to this Windows user)** in `%APPDATA%\Beauty POS\config.json`; nothing is
   written in clear text, and if Windows cannot protect it nothing is saved. Copying that file to another PC or user does not work (the setup window opens again).
5. The setup window never runs migrations and never appears when `DATABASE_URL` is set in the environment (that is the operator's own configuration).

If PostgreSQL is down or refuses the stored credentials, the setup window opens again with the data prefilled (never the password).

## 3. Daily operation

| Moment | What to do | Notes |
|---|---|---|
| Open | Sign in with your PIN; *Caja > Abrir Caja* with the opening cash | One shared register; a second one cannot be opened |
| Sell | *Vender*: search or scan, quantity, *Pagar*, cash or card, *Completar Venta* | Totals and stock are checked again by the server; a retry or double click never charges twice |
| Ticket | *Historial > Ver venta > Reimprimir* (copy) | 80 or 58 mm (Configuración). Non-fiscal ticket. Printing writes nothing |
| Cash in/out | *Caja > Registrar Movimiento* | Withdrawals cannot exceed the cash in the register |
| Return | *Devoluciones*: sale number, quantities, reason, **Efectivo** or **Tarjeta**, tick that the money was ALREADY handed back, *Confirmar devolución y reembolso*, an **administrator types their PIN** | The seller stays signed in. Card = refunded on the card terminal (the POS performs no bank operation); optional terminal reference |
| Return without an administrator | "Registrar la devolución sin reembolso": stock comes back, refund stays PENDIENTE; later *Registrar pago pendiente* with an administrator PIN | |
| Close | *Caja > Cerrar Caja*: count the cash; the dialog shows what is expected | Difference is shown with its sign. *Caja > Historial de sesiones* has the closing summary (print/CSV) |

The administrator PIN is checked in the main process, is never stored or logged, and has its own attempt budget: **5 wrong PINs (login or authorization, the budget is
shared) lock PIN checks for 30 s, doubling up to 15 min**; signing in does not give attempts back; the counter survives restarting the app and forgets itself after
15 quiet minutes (nothing is ever locked permanently). If someone is locked out, wait; do not restart the PC expecting a reset.

## 4. Backups and recovery

```bash
npm run db:backup -- --out "D:\Respaldos POS" --label diario --keep 14 --second-copy "E:\Copia externa"
```

* The **second copy** goes to a location the operator chooses (external drive, USB, folder of another PC of the local network). It is copied and verified with SHA-256,
  never overwrites, nothing is deleted there, **nothing is uploaded to any service** (URLs and cloud-synchronized folders such as OneDrive/Dropbox/Google Drive are refused).
  If the drive is not plugged in, the primary backup still counts and the command exits with code 3: read `backup.log` (date and result of every run).
* Backups hold real sales data and PIN hashes: keep them on encrypted media or in a protected folder, and never in Git or in a shared folder.
* Schedule it (`scripts/db-backup-task.cmd`, `POS_BACKUP_SECOND_DIR` for the second location; see `docs/OPERATIONS.md`) and **test a restore** before relying on it:
  `npm run db:restore -- --file <dump> --target <new_database>` (always into a NEW database).
* Recovery after a failure: stop the POS, restore the latest verified backup (primary or second copy) into a new database and point the application at it: start `"Beauty POS.exe" --reconfigure` (a shortcut with that argument) to open the setup window with the data
  prefilled (never the password), enter the new database name and save. If the stored connection no longer works the setup window opens by itself. Check the data and keep the old database.

## 5. What was verified (automated, on throwaway databases)

* A whole day of Estética Leal on a new database (`npm run test:pilot`, 25 steps): first-run setup with protected configuration and first administrator, store data,
  vendor, products, stock entry, register, cash and card sales, history and reprint, manual cash movements, partial return refunded in cash with the administrator PIN,
  return refunded by card (terminal confirmation simulated), reports, reconciliation to the cent, closing summary, register closed at difference 0, restart,
  backup with second copy, restore into a new database from that second copy, comparison row by row.
* The migration of a **copy of the owner's real data** (the validated backup taken after the manual tests: 9 sales, 3 register sessions, 12 cash movements, 9 inventory
  movements, 2 users) with the pending migrations 0007, 0008 and 0009; the historical rows are byte-identical afterwards and the packaged app shows them (`npm run test:legacy`).
* Login brute force (alternating guesses and own logins, parallel bursts, restarts, tampered counter file), refund authorization, protected configuration and legacy
  plain-text upgrade, setup window, second-copy backups, packaged app smoke test.
* The installer payload (`app.asar`) is byte-identical to the tested unpacked package and contains no credential.

## 6. NOT verified (external limits, stated plainly)

* **NSIS installer install/uninstall:** the installer was generated (unsigned) and its payload compared, but it was **NOT installed or uninstalled**: there is no disposable
  Windows environment on this machine (Windows 11 Home has no Windows Sandbox or Hyper-V) and installing on the owner's PC was not authorized. The clean-install flow,
  Start Menu entry, uninstall and "data preserved after uninstall" are still to be checked in a VM or a spare PC.
* **Physical printer** (thermal 80/58 mm), **barcode reader** and **touch screen**: not tested. Printing was verified only as a PDF of the real print document; touch
  targets only by measuring the controls (keypad 56x48 px or more, Pagar 44 px or more).
* **Code signing certificate and application icon:** none (SmartScreen will warn; the default Electron icon is used). Auto-update is off.
* **Off-site/cloud backups:** deliberately not implemented; the second copy is a local/external location.
* **Admin commands** (migrations, backups, restore, roles) are Node scripts; a PC with only the installed app cannot run them without Node and the `scripts` folder.
* No fiscal invoicing (CFDI), taxes or discounts. Legacy returns (registered before refund control) cannot be paid from the POS.

## 7. Risks to accept or fix before a real store (READY FOR STORE is NOT reached)

1. Run the NSIS install/uninstall test in a disposable environment and sign the installer.
2. Test the real printer, reader and touch screen at the counter.
3. Decide the open product questions (who may read every sale/return, how to resolve legacy returns, per-user registers).
4. Move the admin commands into something a non-technical operator can run, and schedule + verify backups with the second copy on a real drive.
5. Keep PostgreSQL local (never exposed), keep the runtime role, and restrict the Windows account and the backup media.
6. Update the owner's `beauty_pos` deliberately (it is still at migrations 0000-0006 as of the last check): `db:migrate` dry run, then `--apply`. Opening this version on it shows the
   "needs updating" window and changes nothing.
