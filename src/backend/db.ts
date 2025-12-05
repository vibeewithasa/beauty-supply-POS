import "dotenv/config";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.warn("DATABASE_URL is not set. Please configure .env");
}

// Configurar PostgreSQL para usar la zona horaria local del sistema
export const pool = new Pool({
  connectionString,
});

// Configurar la zona horaria de la sesión al conectarse
pool.on("connect", async (client) => {
  try {
    // Obtener la zona horaria local del sistema
    const offset = -new Date().getTimezoneOffset(); // Offset en minutos (negativo porque getTimezoneOffset devuelve inverso)
    const hours = Math.floor(offset / 60);
    const minutes = Math.abs(offset % 60);
    const sign = hours >= 0 ? "+" : "-";
    const absHours = Math.abs(hours);
    const timezone = `${sign}${absHours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
    
    await client.query(`SET timezone = '${timezone}'`);
    console.log(`PostgreSQL timezone configurado a: ${timezone}`);
  } catch (err) {
    console.error("Error setting timezone:", err);
  }
});

export const db = drizzle(pool);
