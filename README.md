# Beauty Supply POS

Un sistema de punto de venta profesional y 100% local para distribuidoras de estética. Desarrollado con **Electron + React + PostgreSQL**, funciona completamente offline sin conexión a internet.

## 🎯 Características Principales

### 1. **Autenticación Segura**

- Login con PIN de 4 dígitos
- Roles: Admin y Vendedor
- Rastreo completo de usuario en todas las operaciones
- Hash SHA-256 para almacenamiento seguro

### 2. **Módulo de Ventas** ✅ _Completo_

- Catálogo de productos con búsqueda por nombre, SKU o código
- Carrito dinámico con control de cantidad
- Soporte para lector de códigos de barras
- Métodos de pago: Efectivo y Tarjeta
- Ticket de confirmación con total
- Actualización automática de inventario

### 3. **Gestión de Caja** ✅ _Completo_

- Apertura con monto inicial
- Registro de movimientos (ingresos/retiros)
- Cierre con comparación efectivo esperado vs real
- Historial completo de movimientos

### 4. **Stock / Inventario** ✅ _Completo_

- Tabla de productos: SKU, nombre, precio, stock, estado
- Búsqueda y filtros por estado
- Movimientos: IN, OUT, ADJUST, DELETE
- Cambio de precios con historial
- Eliminación lógica (nunca se borran datos)

### 5. **Devoluciones** ⏳ _En desarrollo_

- Búsqueda de ventas por ID o producto
- Selección de items parcial o total
- Cálculo automático de reembolsos
- Historial completo

### 6. **Reportes** ⏳ _En desarrollo_

- Ventas por día/período
- Análisis por SKU y por usuario
- Inventario actual vs mínimo
- Movimientos de caja
- Exportación a Excel/PDF

### 7. **Admin Dashboard** ⏳ _En desarrollo_

- Gestión de usuarios (crear, editar, eliminar)
- Estadísticas de ventas y desempeño
- Configuración del sistema

## 📊 Estructura de Datos

### Productos

```typescript
{
  id: number;
  sku: string;              // Obligatorio
  name: string;
  price: numeric(12,2);
  stock: integer;
  barcode?: string;
  category?: string;
  status: "active" | "inactive";
  createdAt: timestamp;
  updatedAt: timestamp;
}
```

### Ventas

```typescript
{
  id: number;
  userId: number;
  cashSessionId?: number;
  subtotal: numeric(12,2);
  tax: numeric(12,2);
  total: numeric(12,2);
  paymentMethod: "cash" | "card";
  createdAt: timestamp;
  items: [
    {
      productId: number;
      quantity: integer;
      unitPrice: numeric(12,2);
      subtotal: numeric(12,2);
    }
  ];
}
```

### Sesiones de Caja

```typescript
{
  id: number;
  openedBy: number;
  initialAmount: numeric(12,2);
  currentAmount: numeric(12,2);
  finalAmount?: numeric(12,2);
  status: "open" | "closed";
  movements: [
    {
      type: "IN" | "OUT";
      amount: numeric(12,2);
      reason: string;
      createdAt: timestamp;
    }
  ];
}
```

### Devoluciones

```typescript
{
  id: number;
  saleId: number;
  totalRefund?: numeric(12,2);
  reason: string;
  processedBy: number;
  items: [
    {
      saleItemId: number;
      quantity: integer;
      refundAmount: numeric(12,2);
    }
  ];
}
```

## 🚀 Quick Start

### Requisitos

- **Windows** (7+)
- **Node.js LTS 18+**
- **PostgreSQL** (local en `localhost:5432`)

### Instalación

```bash
# 1. Clonar o descargar el proyecto
cd beauty-supply-POS

# 2. Configurar base de datos
# Crear base de datos PostgreSQL:
createdb beauty_pos

# 3. Crear archivo .env
cp .env.example .env
# Edita .env si es necesario (por defecto apunta a localhost:5432)

# 4. Instalar dependencias
npm install

# 5. (Opcional) Crear usuario admin de prueba
npm run seed:admin
# PIN por defecto: 0000

# 6. Ejecutar en desarrollo
npm run dev
```

### Scripts Disponibles

```bash
# Desarrollo
npm run dev              # Inicia Electron con hot-reload

# Compilación
npm run build            # Build para producción
npm run package          # Genera instalador .exe (Windows)

# Base de datos
npm run db:generate      # Genera migraciones desde schema
npm run db:check         # Verifica inconsistencias
npm run db:migrate       # Aplica migraciones

# Utilidades
npm run seed:admin       # Crea usuario admin (PIN: 0000)
npm run typecheck        # Verifica tipos TypeScript
npm run lint             # Ejecuta ESLint
```

## 🏗️ Arquitectura

```
┌─────────────────────────────────────────┐
│        Electron Main Process            │
│  - Electron Window                      │
│  - IPC Handlers                         │
│  - Auto-Updates                         │
└─────────────────────────────────────────┘
            ↓        ↑
┌─────────────────────────────────────────┐
│   Backend (Node.js en Electron)         │
│  - Express-like IPC handlers            │
│  - Database connection                  │
│  - Business logic                       │
└─────────────────────────────────────────┘
            ↓        ↑
┌─────────────────────────────────────────┐
│      PostgreSQL (localhost:5432)        │
│  - 11 tablas con relaciones             │
│  - Migraciones automáticas              │
│  - Datos persistentes                   │
└─────────────────────────────────────────┘
            ↑        ↓
┌─────────────────────────────────────────┐
│        React Frontend (Vite)            │
│  - React Router 6                       │
│  - shadcn/ui (52 componentes)           │
│  - Tailwind CSS v3.4                    │
│  - IPC client via contextBridge         │
└─────────────────────────────────────────┘
```

## 🔐 Seguridad

- **IPC Aislado**: Comunicación interna con `contextBridge` (sin puertos públicos)
- **Autenticación PIN**: Hash SHA-256, nunca se almacena en texto plano
- **Roles Basados**: Admin (acceso total) vs Vendedor (solo ventas)
- **Eliminación Lógica**: Nunca se borran datos, solo se marcan como inactivos
- **Auditoría**: Cada operación registra usuario, hora, razón

## 📝 Notas de Actualización

- **Datos Persistentes**: PostgreSQL almacena todo; no se afecta por updates
- **Migraciones Automáticas**: Al iniciar la app, Drizzle ejecuta migraciones pendientes
- **Auto-Updates**: Integrado con `electron-updater`
  - Para testing local: Edita `build.publish.url` en `package.json`
  - Ejemplo: `"url": "file://C:\\PosUpdates"` o `"url": "file://\\\\SERVIDOR\\Actualizaciones"`

## 🛠️ Desarrollo

### Estructura de Carpetas

```
src/
├── main/              # Electron main thread
├── preload/           # Context bridge (IPC seguro)
├── backend/           # Business logic & handlers
│   ├── db.ts         # Conexión PostgreSQL
│   ├── schema.ts     # Definición de tablas (Drizzle)
│   ├── migrate.ts    # Migraciones automáticas
│   └── ipc.ts        # Handlers IPC
├── renderer/          # Frontend React
│   ├── app/          # Páginas principales
│   ├── components/   # Componentes reutilizables
│   └── hooks/        # Custom hooks
├── common/            # Tipos compartidos
└── drizzle/           # Archivos de migración SQL
```

### Agregar Nuevas Páginas

1. Crear componente en `src/renderer/app/[nombre]/page.tsx`
2. Importar en `src/renderer/AppRouter.tsx`
3. Agregar ruta con guardias de autenticación
4. Usar `useNavigate` de React Router

### Agregar Nuevos Handlers IPC

1. Definir en `src/backend/ipc.ts` con `ipcMain.handle()`
2. Agregar tipos en `src/renderer/types/window.d.ts`
3. Usar desde React: `await window.api.moduleName.methodName()`

## 📦 Dependencias Principales

| Paquete      | Versión | Propósito         |
| ------------ | ------- | ----------------- |
| electron     | 30.0.9  | Framework desktop |
| react        | 18.3.1  | UI framework      |
| vite         | 5.4.2   | Build tool        |
| react-router | 6.22.0  | Enrutamiento      |
| drizzle-orm  | 0.33.0  | ORM               |
| pg           | 8.11.3  | Driver PostgreSQL |
| tailwindcss  | 3.4.4   | Utilidades CSS    |
| shadcn/ui    | -       | Componentes UI    |
| typescript   | 5.6.2   | Type safety       |

## ✅ Estado del Proyecto

| Módulo              | Estado       | Detalles                      |
| ------------------- | ------------ | ----------------------------- |
| Login               | ✅ Completo  | PIN auth + roles              |
| Ventas              | ✅ Completo  | Carrito, checkout, inventario |
| Caja                | ✅ Completo  | Apertura, movimientos, cierre |
| Stock               | ✅ Completo  | Listado, búsqueda, estado     |
| Devoluciones        | ⏳ Stub      | Listo para implementar        |
| Reportes            | ⏳ Stub      | Listo para implementar        |
| Admin Dashboard     | ⏳ Stub      | Listo para implementar        |
| Usuarios            | ⏳ Stub      | Listo para implementar        |
| Inventario CRUD     | ⏳ Pendiente | Se puede agregar              |
| Impresoras Térmicas | ⏳ Pendiente | ESC/POS compatible            |

## 🎓 Próximas Mejoras

- [ ] Implementar CRUD completo de inventario
- [ ] Crear reportes con visualización de datos
- [ ] Integración de impresoras térmicas (ESC/POS)
- [ ] Terminales de tarjeta (PSE, Wompi, etc.)
- [ ] Respaldo automático de datos
- [ ] Sincronización en red local (opcional)
- [ ] Multi-sucursal
- [ ] Análisis avanzado de ventas

## 📞 Soporte

Para reportar bugs o sugerencias, contacta al equipo de desarrollo.

---

**Desarrollado para**: Distribuidora de Estética
**Stack**: Electron 30 + React 18 + Vite 5 + PostgreSQL + Drizzle ORM
**Estado**: MVP Funcional ✅
**Última actualización**: Diciembre 2025
