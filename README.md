# Beauty POS

Aplicación POS local para distribuidora de estética. Arquitectura fija: Electron (un solo .exe), React + Vite + Tailwind, backend Node dentro de Electron, PostgreSQL local vía localhost, ORM Drizzle, migraciones automáticas al iniciar, y auto-actualización con electron-updater.

## Requisitos

- Windows
- Node.js LTS 18+
- PostgreSQL local ejecutando en `localhost` (cree una base llamada `beauty_pos`)

## Configuración

1. Copia `.env.example` a `.env` y ajusta `DATABASE_URL`.
2. Instala dependencias.
3. (Opcional) Crea un usuario admin para pruebas: `npm run seed:admin` (PIN por defecto: 0000).
4. Inicia en modo desarrollo.

## Scripts

- `npm run dev`: inicia renderer (Vite), compila main/preload y abre Electron.
- `npm run build`: compila renderer + main/preload y genera `dist/renderer`.
- `npm run package`: genera instalador `.exe` (Windows/NSIS).
- `npm run db:generate`: genera migraciones (Drizzle) a partir del esquema.
- `npm run seed:admin`: crea usuario admin con PIN `0000` (ajustable con `ADMIN_PIN`).

## Notas de actualización

- Los datos viven en PostgreSQL y no se tocan durante updates.
- Al iniciar, la app ejecuta migraciones Drizzle automáticamente.
- electron-updater está integrado. Para entorno sin internet, puede publicarse en una carpeta local o ruta de red usando `generic provider` (por ejemplo `file://\\SERVIDOR\PosUpdates` o una carpeta local). Ajusta el campo `build.publish.url` en `package.json`.

## Seguridad

- IPC interno con `contextBridge` (sin puertos abiertos).
- Autenticación por PIN (hash SHA-256).

# BeautySupplyPOS

BeautySupplyPOS is a fully local Point of Sale system designed for beauty supply distributors. It provides complete control over sales, inventory, cash sessions, product management, returns, and operational logs — all running in a single Electron application with a modern React interface and a secure PostgreSQL backend.
