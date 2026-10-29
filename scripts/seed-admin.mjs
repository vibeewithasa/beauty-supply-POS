// Creates the first administrator. Run it with `npm run seed:admin` (it needs Node's type stripping to share the
// real hashing module with the application: the npm script passes the flag).
//
// How to provide the initial PIN (there is NO default PIN and the PIN is NEVER printed or logged):
//   1. interactively: run it in a terminal and type the PIN twice (nothing is echoed), or
//   2. non-interactively: set ADMIN_PIN in the environment of that single command, e.g. (PowerShell)
//        $env:ADMIN_PIN = "<6-8 digits>"; npm run seed:admin; Remove-Item Env:ADMIN_PIN
// The PIN must have 6 to 8 digits. ADMIN_NAME (optional) is the display name. The database comes from
// DATABASE_URL (.env). The PIN is stored only as a salted scrypt hash.
import "dotenv/config";
import pg from "pg";
import { hashPin, verifyPin, PIN_NEW_RE } from "../src/backend/pin-hash.ts";

// Same key as USER_ADMIN_LOCK_KEY in src/backend/users-service.ts: serializes with the application's user admin.
const USER_ADMIN_LOCK_KEY = 7_481_201;

function fail(message) {
  console.error(message);
  process.exit(1);
}

async function promptHidden(question) {
  if (!process.stdin.isTTY) return null;
  process.stdout.write(question);
  return await new Promise((resolve) => {
    let buffer = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const onData = (chunk) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(buffer);
        }
        if (c === "\u0003") process.exit(130);
        if (c === "\u007f" || c === "\b") buffer = buffer.slice(0, -1);
        else buffer += c;
      }
    };
    process.stdin.on("data", onData);
  });
}

async function initialPin() {
  if (process.env.ADMIN_PIN !== undefined) return process.env.ADMIN_PIN;
  const first = await promptHidden("PIN inicial del administrador (6 a 8 dígitos): ");
  if (first === null) {
    fail("No hay PIN: ejecuta el comando en una terminal interactiva o define ADMIN_PIN solo para este comando (ver el encabezado de scripts/seed-admin.mjs).");
  }
  const second = await promptHidden("Repite el PIN: ");
  if (first !== second) fail("Los PIN no coinciden. No se creó ningún usuario.");
  return first;
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) fail("DATABASE_URL no está definido. Crea .env primero.");

const name = (process.env.ADMIN_NAME ?? "Admin").trim();
if (name.length < 1 || name.length > 120) fail("ADMIN_NAME debe tener entre 1 y 120 caracteres.");

const pin = await initialPin();
if (!PIN_NEW_RE.test(pin)) fail("El PIN debe tener de 6 a 8 dígitos.");

const client = new pg.Client({ connectionString: DATABASE_URL });
try {
  await client.connect();
  await client.query("BEGIN");
  await client.query("select pg_advisory_xact_lock($1)", [USER_ADMIN_LOCK_KEY]);
  // logical uniqueness across ALL users (active or not): salts differ, so compare by verification
  const { rows } = await client.query("select pin_hash from users");
  for (const row of rows) {
    if (await verifyPin(pin, row.pin_hash)) {
      await client.query("ROLLBACK");
      fail("Ese PIN ya está en uso. No se creó ningún usuario.");
    }
  }
  const pinHash = await hashPin(pin);
  const res = await client.query("insert into users (name, pin_hash, role, active) values ($1, $2, 'admin', true) returning id", [name, pinHash]);
  await client.query("COMMIT");
  console.log(`Usuario administrador creado (id ${res.rows[0].id}).`);
} catch (e) {
  await client.query("ROLLBACK").catch(() => {});
  // never print the connection string, the PIN or the hash
  fail("Error al crear el administrador: " + String(e.code ?? e.name ?? "desconocido"));
} finally {
  await client.end().catch(() => {});
}
