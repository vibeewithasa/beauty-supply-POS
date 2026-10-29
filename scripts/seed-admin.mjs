import 'dotenv/config';
import crypto from 'node:crypto';
import { Pool } from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL no está definido. Crea .env primero.');
  process.exit(1);
}

const ADMIN_NAME = process.env.ADMIN_NAME || 'Admin';
// No default PIN: use ADMIN_PIN or get a random one (printed once). A well-known PIN must never ship.
const ADMIN_PIN = process.env.ADMIN_PIN || String(crypto.randomInt(0, 10000)).padStart(4, '0');
if (!/^d{4}$/.test(ADMIN_PIN)) {
  console.error('ADMIN_PIN debe tener exactamente 4 dígitos.');
  process.exit(1);
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(pin).digest('hex');
}

async function main() {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const pinHash = hashPin(ADMIN_PIN);

  const checkRes = await pool.query('SELECT id FROM users WHERE pin_hash = $1 LIMIT 1', [pinHash]);
  if (checkRes.rows.length > 0) {
    console.log('Ya existe un usuario con ese PIN. No se creó otro.');
    await pool.end();
    return;
  }

  await pool.query(
    `INSERT INTO users (name, pin_hash, role, active) VALUES ($1, $2, 'admin', true)`,
    [ADMIN_NAME, pinHash]
  );
  console.log(`Usuario admin creado. PIN=${ADMIN_PIN}`);
  await pool.end();
}

main().catch((e) => {
  console.error('Error al crear admin:', e);
  process.exit(1);
});
