# Sprint 08 — Arquitectura y planificación técnica

> **Estado: PROPUESTA PARA REVISIÓN. No se implementó nada, no se creó ninguna migración, no se tocó ninguna base ni se hizo commit.**
> Este documento es la única adición al repositorio (sin versionar). Nada de lo que describe la sección 5 (SQL) se ha ejecutado ni generado con `drizzle-kit`.
> Ningún bloque de las secciones 3, 4 y 5 (migraciones y lógica financiera) debe implementarse hasta la **aprobación explícita** de esta revisión (sección 9, compuertas).

## 0. Verificación previa

| Comprobación | Resultado |
|---|---|
| `git fetch origin` | hecho |
| `origin/main` | `e53ed50` (2026-11-10) «docs(pos): distinguish simulated card sales and refunds from bank transactions» |
| Rama de trabajo | `claude/sprint-08-architecture-f94001`, `HEAD == origin/main` (0 adelante / 0 atrás), árbol limpio |
| Versión en `package.json` | `0.8.1`; no hay tags en el repositorio |
| Migraciones en el repositorio | `0000`–`0009` (`drizzle/meta/_journal.json`, 10 entradas) |
| **Graphify** | `graphify-out/` existe **solo en el checkout principal** (sin versionar) y **no en este worktree**. Su `built_at_commit` es `41bb261` (2026-11-01): **35 commits atrás** de `HEAD` (1 903 nodos). Lo traté como **obsoleto**: sirvió solo para orientarme; cada afirmación de este documento se verificó leyendo el código actual. No ejecuté `graphify update` (escribiría en `graphify-out/`). |

El SHA de conversaciones anteriores **no** se asumió: se comprobó contra el remoto.

---

## 1. Análisis de impacto por componente

### 1.1 Hallazgos que condicionan el diseño (verificados en el código)

| # | Hallazgo | Evidencia | Consecuencia |
|---|---|---|---|
| H1 | `sale_items.product_id` es `NOT NULL` + FK a `products`. | `src/backend/schema.ts:217` | Varios exige migración (o un producto «falso», que se descarta, §3.2). |
| H2 | Varios servicios suponen que toda línea tiene producto. | `pos-service.ts` (`findReplay`, `createSaleTx`), `returns-service.ts` (`registerReturn` lee `line.productId`), `read-service.ts` (`getSaleForReturn`, `salesSummary.byProduct` agrupa por `productId`), `sales-history.ts` (`getSaleDetail` cae a `Producto #${productId}`), `validation.ts` (`parseSaleInput` exige `productId` y rechaza duplicados) | Hay que tocar los 5 archivos. `tsc` marcará el resto al volver nullable la columna (buena red de seguridad). |
| H3 | **`scripts/precheck-integrity.mjs`** cuenta como huérfana toda línea `sale_items` sin producto (`left join products … where p.id is null`) y la marca **BLOCKER**. | `precheck-integrity.mjs`, check «sale_items -> products orphans» | Falso bloqueo si se ejecuta sobre una base ya migrada con Varios. Ajustar a `product_id is not null`. |
| H4 | El carrito y todo el cobro se identifican por `productId`. | `lib/cart.ts` (`CartItem`, `findCartIssues`, `checkoutSignature`), `sales/page.tsx` (`setQuantity`, `removeItem`, `key={item.productId}`) | Una línea Varios no tiene `productId`: hace falta un `lineId` por línea. |
| H5 | `returns:create` es **`authenticated`** (cualquier vendedor): registra la devolución **y devuelve stock** sin PIN ni administrador. `returns:getSaleForReturn` y `returns:getAll` también están abiertos. | `ipc.ts` tabla `ACCESS`; `docs/STATUS.md` «Owner decision pending on access»; fijado por una prueba (`e2e/suites/safety.mjs:117`) | Es exactamente la «ruta de reembolso habitual sin control» que pide cerrar el requisito 4. `createWithRefund`/`settleRefund` ya exigen PIN dentro del handler, pero su `ACCESS` también es `authenticated`. |
| H6 | La disponibilidad «cuánto se puede devolver» sale **solo** de `return_items`. | `returns-service.ts`, `read-service.ts` | Si Cambios guarda sus cantidades en otras tablas, una unidad podría **cambiarse y además reembolsarse**. Hay que unificar el cálculo (§4.4). |
| H7 | El efectivo esperado del cierre se **reconstruye** desde registros estructurados: `sales` en efectivo + movimientos manuales − reembolsos en efectivo. Un cobro nuevo en efectivo que no esté modelado aparecería como «movimiento manual» o descuadraría `expected.reconciles`. | `cash-summary.ts` | El cobro de diferencia de un cambio necesita su propio vínculo (como `refund_settlements.cash_movement_id`). |
| H8 | La app **nunca migra**: `verifyDatabaseSchema` rechaza arrancar con migraciones faltantes (`missing`) o desconocidas (`newer`). El `drizzle` migrator aplica todas las pendientes en **una sola transacción**. | `startup-check.ts`, `scripts/lib/schema-state.mjs`, `docs/OPERATIONS.md` | Un 0.9.0 sobre una base 0.8.x **no arranca** hasta ejecutar «Actualizar estructura» (ventana `--manage`) o `db:migrate --apply`. Un 0.8.x sobre una base migrada tampoco: el *rollback* es restaurar respaldo. |
| H9 | La base real del dueño (`beauty_pos`) estaba en **0000–0006** en la última comprobación; solo se validó 0007–0009 sobre una **copia** (`test:legacy`). | `docs/STATUS.md`, `docs/OPERATIONS.md` | El salto real hacia 0.9.0 serían **cinco** migraciones (0007–0011). Hay que ensayar 0010–0011 también sobre copia. |
| H10 | Los diálogos son Radix modales (`ui/dialog.tsx`, `ui/alert-dialog.tsx`): atrapan el foco, ponen `pointer-events:none` en `body` y ocultan a los hermanos con `aria-hidden`. | `components/ui/dialog.tsx` | Un teclado flotante montado fuera del diálogo **no recibiría clics** cuando «Efectivo recibido» (que está dentro de un diálogo) esté abierto. Es el riesgo técnico nº 1 del teclado (§2.1). |
| H11 | La cantidad del carrito es `<input type="number">`; en ese tipo `selectionStart` es `null`. | `sales/page.tsx:492` | El teclado no puede insertar en el cursor: o se cambia a `type="text" inputMode="numeric"` o se limita a «añadir al final». |
| H12 | El SKU se escribe a mano, es obligatorio (`SKU_RE`), único (`products_sku_unique`) y **editable** en `products:update`; la prueba `catalog.mjs:135-138` fija que se puede cambiar. | `catalog-validation.ts`, `inventory/page.tsx:125,378`, `e2e/suites/catalog.mjs` | Hay que decidir si el SKU pasa a solo lectura (recomendado) y reescribir esas pruebas. |
| H13 | `scripts/db-migrate.mjs` no vuelve a otorgar permisos al rol de runtime; `provision.updateSchema` (ventana `--manage`) **sí** (`regrantRuntimeRole`). Tablas nuevas necesitan `GRANT` para el rol con privilegios mínimos. | `db-ops.mjs` (`runtimeGrantSql`), `provision.mjs` | Documentar `npm run db:roles` tras migrar instalaciones externas; verificarlo en 08B/08C. |
| H14 | Preferencias de «por dispositivo» no existen hoy: `business_settings` es **por instalación/base de datos**, no por equipo. `config.json` es solo del proceso principal. | `settings-service.ts`, `config-store.ts` | La preferencia del teclado no debe ir a la base de datos (§2.1). |

### 1.2 Matriz de impacto

Leyenda de riesgo: 🟢 bajo · 🟡 medio · 🔴 alto (dinero, inventario o datos históricos).

| Componente | Teclado (08A) | SKU (08A) | Varios (08B) | Cambios (08C) |
|---|---|---|---|---|
| `renderer/app/sales` | 🟡 `data-numpad` en cantidad y efectivo recibido; cantidad a `inputMode` | — | 🟡 botón «Varios», diálogo, líneas por `lineId`, cobro | — |
| `renderer/lib/cart*.ts(x)` | — | — | 🟡 `CartItem` unión + `lineId`; `findCartIssues`/`applyCartIssues`/`checkoutSignature` | — |
| `renderer/app/settings` | 🟢 tarjeta «Este equipo» | — | — | 🟢 texto de política (opcional) |
| `renderer/app/inventory` | — | 🟢 quitar campo SKU; mostrarlo de solo lectura | — | — |
| `renderer/app/returns` | — | — | — | 🔴 pasa a «Reembolsos (excepcional)», solo admin |
| `renderer/app/exchanges` *(nuevo)* | — | — | — | 🔴 pantalla completa |
| `renderer/components/pos-navbar.tsx`, `App.tsx` | — | — | — | 🟡 «Devoluciones» → «Cambios»; `/returns` solo admin |
| `backend/catalog-service.ts`, `catalog-validation.ts` | — | 🟡 generador de SKU; rechazar `sku` del cliente | — | — |
| `backend/pos-service.ts`, `validation.ts` | — | — | 🔴 líneas `catalog`/`misc` en `createSaleTx` y `findReplay` | — |
| `backend/schema.ts` + `drizzle/0010` | — | — | 🔴 `product_id` nullable, `line_kind` | — |
| `backend/schema.ts` + `drizzle/0011` | — | — | — | 🔴 3 tablas nuevas |
| `backend/returns-service.ts`, `read-service.ts` | — | — | 🟡 rechazar líneas Varios | 🔴 sumar cantidades de cambios al «ya devuelto» |
| `backend/exchange-service.ts` *(nuevo)*, `exchange-validation.ts`, `exchange-policy.ts`, `exchange-voucher.ts` | — | — | — | 🔴 |
| `backend/ipc.ts` + `preload.ts` | — | — | 🟢 mismo canal `sales:create`, forma ampliada | 🔴 canales `exchanges:*` + endurecer `returns:*` |
| `backend/sales-history.ts`, `receipt-service.ts`, `receipt.ts` | — | — | 🟡 `kind`, nombre «como se vendió», sin SKU | 🟡 `exchanges` en el detalle de la venta |
| `backend/cash-summary.ts`, `cash-report.ts`, `cash-query.ts` | — | — | 🟢 solo ventas (ya agregadas por `sales.total`) | 🔴 cobros por cambio en efectivo esperado |
| `backend/read-service.ts` `salesSummary`, `ipc.ts` `dashboard:getStats` | — | — | 🟡 `byProduct` excluye Varios + fila «Varios» | 🟡 sección «Cambios» |
| `renderer/app/reports`, `dashboard`, `cash-history`, CSV | — | — | 🟡 | 🟡 |
| `scripts/precheck-integrity.mjs`, `scripts/lib/demo-*.mjs` | — | — | 🟡 H3 | 🟢 |
| `e2e/*` (unit, suites, `migrations`, `legacy`, `installer-app`) | 🟡 | 🟡 (H12) | 🟡 | 🔴 (H5: `safety`, `security`, `refunds*`) |
| Instalador / `--manage` / backups | 🟢 sin cambios | 🟢 | 🟡 una migración | 🟡 una migración; ensayo de actualización |

**Sin impacto (verificado):** `closeCashSession`, `openCashSession`, `addCashMovement` (operan sobre `cash_sessions.current_amount`, no sobre líneas); `login`, limitador de PIN, `admin-authorization.ts` (se **reutiliza** tal cual); impresión (`runPrint`); respaldo/restauración.

---

## 2. Propuesta UX

### 2.1 Teclado numérico flotante (Vender)

**Dónde vive la preferencia.** `localStorage` del renderer, clave `pos.numpad.v1` = `{ enabled, minimized, x, y }`. Es **por equipo y por perfil de Windows** (Electron guarda el almacenamiento en `userData`), sin IPC, sin base de datos y **sin migración**. Todas las lecturas/escrituras dentro de `try/catch` (si falla, queda desactivado). Por defecto `enabled=false`. *Descartado:* `business_settings` (es por instalación, no por equipo — H14) y `config.json` (requeriría canal IPC nuevo para un dato sin valor de seguridad).

**Activarlo.** Configuración (`/settings`, ya es solo admin) → nueva tarjeta **«Este equipo»** con un interruptor «Teclado numérico en Vender», con efecto inmediato y **fuera** del formulario «Guardar» de datos comerciales (no es un dato comercial). Texto: «Solo afecta a este equipo. No cambia la configuración del negocio.» *(Decisión D8: ¿debe poder activarlo un vendedor? hoy `/settings` es solo admin.)*

**Comportamiento.**
- Se monta **solo** en la ruta `/sales` (dentro de `POSLayout`), `position: fixed`, `z-index` por encima de Radix (`z-50`) → `z-[60]`.
- Teclas: `0-9`, `.` (solo en campos decimales), `⌫`, `C` (borrar campo). **No hay tecla Intro** (evita cobros/altas accidentales; cobrar sigue siendo un botón explícito).
- Cabecera con asa para **arrastrar** (Pointer Events, `touch-action:none`, funciona con dedo), botón **minimizar** (queda una ficha «123» de 48 px en su última posición) y cerrar (vuelve a «desactivado» en esta sesión sin tocar la preferencia). Posición limitada al viewport y reajustada al redimensionar (objetivo de diseño 1024×768, ya usado por `test:pilot`).
- Objetivos táctiles ≥ 48 px; contraste como el de los campos de 0.8.1 (≥ 3:1); respeta `prefers-reduced-motion`.

**Qué campos acepta — lista explícita, no inferencia.** Cada campo permitido lleva `data-numpad="integer|decimal"`. Inicialmente: cantidad del carrito, «Efectivo recibido», y los campos de **Varios** (cantidad y precio). El teclado **nunca** se ata a un campo por tener `inputMode`. Quedan fuera por construcción: el buscador `#pos-search` (lector de códigos), cualquier `type="password"`/PIN, `readonly`/`disabled`, y cualquier cosa dentro de `[data-numpad-ignore]`.

**Reglas de no interferencia.**
1. **Lector de códigos.** Las teclas usan `onPointerDown/onMouseDown preventDefault` y `tabIndex={-1}`: **no roban el foco**. Si un botón del teclado quedara enfocado, el `Intro` que envía el lector pulsaría esa tecla; por eso no son tabulables. El teclado físico sigue operando todos los campos, así que no se pierde accesibilidad de teclado.
2. **Teclado físico.** Nunca se hace `preventDefault` de teclas reales.
3. **Diálogos (H10).** El teclado recuerda el último campo elegible (`ref`) y vuelve a enfocarlo tras cada pulsación. Para que un clic en el teclado no cierre el diálogo ni lo bloquee se requiere: `style="pointer-events:auto"`, y `onInteractOutside`/`onPointerDownOutside` de los diálogos de Vender que ignoren objetivos dentro de `[data-numpad-root]` (los diálogos de cobro ya personalizan `onInteractOutside`). Radix pondrá el teclado en `aria-hidden` mientras haya un modal: es aceptable porque el campo sigue operable con el teclado físico, y se documenta. **Este es el primer paso de 08A (spike con prueba real, NUM-05) antes de construir el resto.**
4. **Autenticación.** No existe en `/sales` ningún campo de PIN; el teclado no se monta en `/`, ni en diálogos de autorización de otras rutas. Al cerrar sesión o expirar, `POSLayout` se desmonta y el teclado con él.
5. **Inserción.** Para que React reciba el cambio se asigna con el *setter* nativo del prototipo y se dispara `input`. La cantidad del carrito pasa de `type="number"` a `type="text" inputMode="numeric"` (H11).
6. **Lógica pura y probada.** `lib/numpad.ts` (sin React): `applyKey(value, key, mode) → value` (un solo `.`, máx. 2 decimales en dinero, sin ceros a la izquierda, tope de longitud). Se prueba con `node --test` como el resto de `e2e/unit`.

### 2.2 SKU automático (Productos)

- El formulario de **alta** ya no tiene campo SKU. Al crear: «Producto creado · SKU `EL-000124`».
- En **edición** el SKU se muestra como texto de solo lectura (nadie pierde el dato); `products:update` rechaza `sku` (`SKU_NO_MODIFICABLE`). *(Decisión D9 — alternativa: permitir que un admin lo cambie.)*
- Código de barras: sigue siendo campo opcional e independiente, sin cambios. (Observación, fuera de alcance: no hay unicidad de código de barras; con dos productos con el mismo código, `findBySkuOrBarcode` devuelve uno al azar.)
- La búsqueda de Vender, Productos y Recepción sigue buscando por SKU.

### 2.3 Varios (Vender)

- Botón **«Varios»** (icono `PlusSquare`) bajo la tarjeta «Escanear o Buscar», mismo ancho, ≥ 48 px. Con `Alt+V` como atajo opcional. **No** toca el foco del buscador salvo para devolvérselo al cerrar (ya existe `returnFocus`).
- Cada pulsación abre un **diálogo** (no persistente entre pulsaciones): **Cantidad** (entero, por defecto 1), **Precio unitario** (`> 0`, 2 decimales), **Descripción** (opcional, ≤ 80 caracteres). Muestra el subtotal en vivo. «Agregar» → **una línea independiente** al carrito; «Agregar y otro» reabre vacío. Enter confirma; Esc cancela.
- La línea se ve como `Varios — {descripción}` con una insignia «Varios» y sin SKU ni tope de existencias. Cantidad ±, quitar, igual que las demás; el **precio no se edita en línea** (quitar y volver a capturar: menos superficie de error).
- No se piden existencias ni se crea ningún producto; el aviso «catálogo cambió» ignora estas líneas.
- Historial, ticket y reportes muestran «Varios: …» con el texto exacto capturado.

### 2.4 Cambios (reemplaza Devoluciones en la operación diaria)

Navegación: «Devoluciones» → **«Cambios»** (`/exchanges`, todos los usuarios). El antiguo `/returns` pasa a **«Reembolsos (excepcional)»**, solo admin, con aviso «La tienda trabaja con cambios. Usa esta pantalla solo para reembolsos autorizados o consulta histórica.» Ninguna tabla ni dato histórico se elimina.

Flujo en una pantalla, de arriba abajo:
1. **Venta original** — folio + Enter (misma mecánica que hoy). Muestra fecha, vendedor, método y total.
2. **Artículo(s) que regresa** — tabla: producto, vendido, ya cambiado/devuelto, **disponible para cambio**, cantidad a regresar, **estado** (`Revendible` / `Dañado`). Las líneas Varios aparecen deshabilitadas («Varios: sin inventario, no aplica cambio»). Un producto eliminado solo admite «Dañado».
3. **Artículo(s) nuevo(s)** — mismo buscador/escáner que Vender; cantidad ≤ existencias. Se muestran al **precio actual del catálogo**.
4. **Resumen en vivo**: *Crédito* (a precio **de la venta original**) · *Nuevo total* · **Diferencia**:
   - igual → «Sin cobro adicional»;
   - mayor → «Cobrar $X» + método (Efectivo/Tarjeta), «Confirmo que el cliente ya pagó la diferencia» y, para tarjeta, referencia opcional;
   - menor → **bloqueo** en rojo: «El artículo nuevo vale menos. Este caso aún no tiene política: consulta al administrador.» (sin reembolso automático).
5. **Motivo** (obligatorio) → **«Confirmar cambio»** → diálogo de **PIN de administrador** (se reutiliza `AuthorizationDialog` de `refund-payment.tsx`) → resultado con **Comprobante** (imprimible, no fiscal).
6. **Historial de cambios** debajo (folio, venta, fecha, crédito, nuevo, diferencia, método, atendió/autorizó, comprobante).

Mensajes ante resultado incierto: igual que Reembolsos hoy («Reintentar con esta misma pantalla es seguro: usa la misma operación»), apoyado en idempotencia.

---

## 3. Diseño transaccional de **Varios**

### 3.1 Contrato

`sales:create` conserva el canal y la firma. Cada elemento de `items` es una unión discriminada; **sin `kind` = `catalog`** (compatibilidad con clientes y pruebas actuales):

```ts
type SaleItemInput =
  | { kind: "catalog"; productId: number; quantity: number; unitPrice; subtotal }          // como hoy
  | { kind: "misc"; quantity: number; unitPrice; subtotal; description?: string }          // nuevo
```

Validación (`parseSaleInput`, pura y con pruebas): `kind` ∈ {catalog, misc}; el duplicado de `productId` se sigue rechazando **solo entre líneas catalog**; Varios puede repetirse (cada pulsación es una línea); `quantity` entero 1…`MAX_QUANTITY`; `unitPrice` **> 0** (`toCents(..., {allowZero:false})`) y `≤ MAX_CENTS`; `subtotal = unit × qty` recalculado y **comparado**; `description` recortada, ≤ 80, sin caracteres de control, por defecto `"Varios"`; campos desconocidos rechazados; el conjunto sigue limitado a `MAX_ITEMS = 200` y el total a `MAX_CENTS`.

### 3.2 Alternativas de modelado

| Opción | Veredicto |
|---|---|
| **A. `product_id` nullable + `line_kind` + `CHECK`** | **Recomendada.** Aditiva, sin tocar filas existentes, el nombre «como se vendió» (`product_name`) ya existe. |
| B. Producto comodín «VARIOS» en `products` | **Descartada.** Contradice «no inventar registros de inventario»: aparece en listados de stock, tiene `stock` y `CHECK`s, ensucia reportes y `products:getAll`. |
| C. Tabla aparte `misc_sale_items` | **Descartada.** Obliga a `UNION` en historial, tickets, reportes y devoluciones; duplica lógica. |

### 3.3 Transacción (`createSaleTx`, mismos locks y orden que hoy)

```
BEGIN
  lockOpenSession(sessionId)                              -- FOR UPDATE (serialización existente)
  ids = productIds de líneas catalog                      -- PROTEGER el caso «solo Varios»: no consultar con lista vacía
  rows = SELECT … FOR UPDATE ORDER BY id (solo si ids ≠ ∅)
  por cada línea catalog: validaciones actuales (activo, stock, precio, subtotal)
  por cada línea misc:    unit/subtotal ya validados; NO se consulta ni bloquea ningún producto
  total = Σ subtotales (catalog + misc) ; comparar con input.total ; ≤ MAX_CENTS
  INSERT sales
  por cada línea catalog: INSERT sale_items (line_kind='catalog', product_id, nombre/sku como se vendió)
                          UPDATE products stock (condicional) ; INSERT inventory_movements OUT   -- sin cambios
  por cada línea misc:    INSERT sale_items (line_kind='misc', product_id NULL, product_name=descripcion||'Varios', product_sku NULL)
                          (SIN update de stock, SIN inventory_movements)
  caja: efectivo → current_amount += total + cash_movement IN (sale_id) ; tarjeta → movimiento informativo 0.00   -- sin cambios
COMMIT
```

Una venta **solo de Varios** es válida y no toca ninguna fila de `products`.

### 3.4 Idempotencia

`operationId` y el índice único `sales_operation_id_unique` siguen igual. `findReplay` compara hoy `productId:cantidad:precio`; la firma pasa a ser por línea:
`c:{productId}:{qty}:{cents}` o `m:{descripción}:{qty}:{cents}`, **ordenadas** (multiconjunto: dos líneas Varios idénticas son legítimas). En el cliente, `checkoutSignature` usa la misma forma con `lineId`/contenido; el `operationId` se conserva ante un resultado incierto y se libera ante un rechazo definitivo (lógica actual de `cart-context.tsx`, sin cambios).

### 3.5 Integración, componente por componente

| Área | Comportamiento con Varios |
|---|---|
| **Carrito** | `CartItem = CatalogItem \| MiscItem`, ambos con `lineId` (`p:{id}` / `m:{uuid}`) que sustituye a `productId` como clave, en `setQuantity`, `removeItem` y `key`. `findCartIssues`/`applyCartIssues` **dejan pasar** las líneas misc. `unitsInCart`, totales y el badge del navbar las cuentan. |
| **Cobro** | Igual: el total es la suma; efectivo recibido/cambio es solo una ayuda. |
| **Caja y cierre** | `sales.total` ya incluye Varios, así que `cash-summary`, `closeCashSession` y la conciliación **no cambian**. Verificar con prueba que `expected.reconciles` sigue en `true`. |
| **Historial** | `getSaleDetail` devuelve `kind` y `name` desde `product_name`; `productId`/`catalog*` quedan `null`. `sales:list` (`itemCount`) suma cantidades: sin cambios. |
| **Ticket** | `receipt-service` ya admite `sku: null`; se imprime `Varios — {descripción}` con cantidad × precio. El texto se sigue escapando en `receipt.ts`. |
| **Reportes / dashboard** | `salesSummary.byProduct` filtra `product_id is not null` y se añade `misc: {count, units, total}`. Los totales y por método (desde `sales`) no cambian. Exportación CSV incluye la fila «Varios». |
| **Devoluciones / cambios** | `registerReturn` y `getSaleForReturn` marcan la línea `returnable:false` y la rechazan con `ITEM_VARIO_NO_DEVOLVIBLE` **antes** de leer `line.productId`. Cambios ídem. *(D6.)* |
| **Inventario** | Ningún movimiento ni stock. Verificado por prueba (conteo de `inventory_movements` y suma de stock antes/después). |
| **Seguridad** | El precio de una línea Varios lo declara el cliente (no hay catálogo contra el cual compararlo). Controles propuestos: precio > 0, topes de cantidad/importe, descripción saneada, columna «Varios» visible en el historial y total «Varios» en reportes (auditoría). *(D5: umbral que exija PIN de administrador; tope por línea.)* |

---

## 4. Diseño transaccional de **Cambios**

### 4.1 Principios

1. **Un cambio no es una venta ni un reembolso.** Tiene sus propias tablas; **no** escribe en `sales`/`sale_items` ni en `returns` (evita contaminar «Reembolsos pendientes» del dashboard y de los reportes).
2. **Inmutable y auditable.** No hay edición ni cancelación de un cambio en v1 (D11); cualquier corrección es una operación administrativa nueva.
3. **Fail-closed en autorización.** v1 exige PIN de administrador para **todo** cambio (D1); la regla vive en una función pura (`exchange-policy.ts`) que se puede relajar después sin tocar la transacción.
4. **Nada monetario viene del renderer.** Crédito, nuevo total y diferencia se calculan en main; el cliente solo envía la **diferencia que vio** como reclamación para detectar pantallas viejas (`DIFERENCIA_DESACTUALIZADA`), como `claimedUnitPriceCents` hoy.
5. **Mismos locks y mismo orden global** que Reembolsos (documentado al inicio de `refund-service.ts`).

### 4.2 Reglas de negocio

| Caso | Resultado |
|---|---|
| Nuevo total **=** crédito | Sin cobro; se registra el cambio. |
| Nuevo total **>** crédito | Cobro de la diferencia, en efectivo (a caja) o tarjeta (terminal externa), con confirmación explícita de que ya se cobró. |
| Nuevo total **<** crédito | **Se rechaza** (`CAMBIO_VALOR_MENOR`). Nada se registra, nada se reembolsa. Queda como decisión comercial D2. En BD, `CHECK (surcharge = new_total − returned_total AND surcharge ≥ 0)` lo hace **imposible por construcción**. |
| Crédito | A **precio pagado** (`sale_items.unit_price`), no al de catálogo de hoy. |
| Nuevo precio | Al **precio actual** del catálogo (como Vender). |
| Cantidad disponible | `vendido − devuelto (return_items) − cambiado (exchange_returned_items)`, calculado **bajo el bloqueo de la venta**. |
| Línea Varios | No cambiable (D6). |
| Producto original eliminado | Solo «Dañado» (no se repone stock a un producto eliminado: misma política que `registerReturn`). |
| Producto nuevo | Debe estar `active` y con stock suficiente **neto** (ver 4.3). |

### 4.3 Transacción `createExchange(operatorId, authorize, adminPin, data)`

Orden global de bloqueos: `advisory(op) → cash_session → sale → sale_items asc → products asc`.

```
parse (sin tocar BD)  ->  replay previo (mismo operationId ya resuelto ⇒ devolver resultado guardado)
authorize(adminPin)   ->  fuera de la transacción, antes de escribir (igual que createReturnWithRefund)
BEGIN
  pg_advisory_xact_lock("exchange:"+operationId)  ; re-comprobar replay bajo el lock
  session = SELECT … FROM cash_sessions WHERE closed_at IS NULL FOR UPDATE     -- exige caja abierta: CAJA_REQUERIDA
  sale    = SELECT … FROM sales WHERE id FOR UPDATE ; VENTA_NO_ENCONTRADA
  lines   = SELECT … FROM sale_items WHERE id IN (…) ORDER BY id FOR UPDATE
            validar: pertenecen a la venta, kind='catalog', claimed* coinciden
  already = Σ return_items.quantity + Σ exchange_returned_items.quantity   (helper compartido, ver 4.4)
  productIds = unión(productos de líneas devueltas, productos nuevos) ORDER BY id
  products = SELECT … FOR UPDATE ORDER BY id
  validar por línea devuelta: qty ≤ vendido − already ; (eliminado ⇒ solo 'damaged')
  validar por producto: stock + (Σ devuelto 'resellable') − (Σ nuevo) ≥ 0   -- neto, evita falsos rechazos al cambiar por el mismo producto
  credit = Σ (unit_price de la venta × qty) ; new = Σ (precio actual × qty)
  if new < credit  -> CAMBIO_VALOR_MENOR
  surcharge = new − credit ; if claimedSurcharge ≠ surcharge -> DIFERENCIA_DESACTUALIZADA
  if surcharge > 0: exigir payment {method, confirmed:true, reference?}
                    efectivo: UPDATE cash_sessions SET current_amount += surcharge ; INSERT cash_movements IN (reason "Cobro por cambio #…")
                    tarjeta : sin movimiento de caja
  INSERT exchanges (…, cash_session_id, cash_movement_id, operation_id, authorized_by, processed_by)
  INSERT exchange_returned_items (…)  ; por cada 'resellable': UPDATE products SET stock = stock + qty ; INSERT inventory_movements IN "Cambio #X (venta #Y): recibido"
                                          por cada 'damaged'  : sin stock (queda registrado en la línea)
  INSERT exchange_new_items (… nombre/SKU como se entregó) ; UPDATE products SET stock = stock − qty WHERE stock ≥ qty ; INSERT inventory_movements OUT "Cambio #X: entregado"
COMMIT
```

- **Sin deadlocks:** compra→(sesión→productos); reembolso→(sesión→venta→líneas→productos); cambio→(sesión→venta→líneas→productos); devolución simple→(venta→líneas→productos). Ningún flujo toma estas filas en orden inverso a otro.
- **Atomicidad:** inventario, caja y registro del cambio son una sola transacción; un fallo revierte todo.
- **Idempotencia:** `operation_id` `NOT NULL UNIQUE` (todo cambio es idempotente). `findReplay` exige mismo operador, venta, motivo, líneas devueltas+estado, líneas nuevas y pago; otra cosa con el mismo id ⇒ `OPERACION_DUPLICADA`. Una carrera de dos envíos idénticos pierde en el índice único (`23505`) y recibe el resultado del ganador, como hoy.
- **Cierre de caja:** el cambio toma el `FOR UPDATE` de la sesión ⇒ se serializa con ventas, movimientos y cierre; una sesión que cierra no puede recibir un cobro por cambio.

### 4.4 Unificar «cantidad ya devuelta» (H6)

Un solo helper (`returnedQuantities(tx, saleItemIds)`) suma `return_items` **y** `exchange_returned_items`, y lo usan `registerReturn`, `getSaleForReturn` y `createExchange`. Es el **único cambio en lógica financiera existente** (una suma adicional); se cubre con pruebas de no regresión de Reembolsos y con una prueba cruzada «cambiada ⇒ no reembolsable y viceversa» (EXC-12).

### 4.5 Efectivo, tarjeta y reportes

- `cash-summary`: se excluyen de «ingresos manuales» los movimientos que sean `exchanges.cash_movement_id`; el efectivo esperado suma los cobros de cambio en efectivo de la sesión; nueva sección `exchanges {count, returnedTotal, newTotal, cash, card}`; `reconciles` se sigue calculando. Mismo tratamiento en `cash-report.ts` (cierre impreso) y CSV.
- Los cobros con **tarjeta** son informativos en el cierre (igual que ventas con tarjeta y reembolsos por tarjeta): la app **no** realiza operaciones bancarias (consistente con el último commit de documentación).
- `salesSummary`/dashboard: sección **«Cambios»**: cantidad, crédito, nuevo total, diferencia cobrada por método. Definición explícita: **«Ventas brutas» no cambia**; **«Ingreso cobrado» = ventas + diferencias de cambios** (D10: si el ranking por producto debe incluir lo entregado en cambios).
- Historial de la venta: `getSaleDetail` añade `exchanges[]` (cambios hechos sobre ella).

### 4.6 Comprobante

`exchange-voucher.ts` (puro, probado, mismo modelo de seguridad que `return-voucher.ts`: HTML escapado, CSP sin scripts, 80/58 mm). Contiene: negocio, **«COMPROBANTE DE CAMBIO #N»**, venta original (folio/fecha), artículos que regresan (con estado), artículos que se lleva, crédito / nuevo total / **diferencia cobrada** (método y referencia), atendió / autorizó, motivo, leyenda «Documento interno · No es una factura fiscal». Vista previa e impresión por `previewVoucher/printVoucher` (impresión no escribe en BD).

### 4.7 Canales IPC

| Canal | Acceso | Notas |
|---|---|---|
| `exchanges:lookupSale` | authenticated | Solo lectura; por folio (sin listado); devuelve disponibilidad real y `returnable` por línea. Visibilidad D7. |
| `exchanges:create` | authenticated **+ PIN admin verificado en main** | `authorizeAdmin(pin, ctx.user.id)` reutilizado; limitador de intentos compartido; el PIN nunca se guarda ni se devuelve. |
| `exchanges:list` / `exchanges:getDetail` | authenticated (admin todo; vendedor lo que atendió) | Historial. |
| `exchanges:previewVoucher` / `exchanges:printVoucher` | authenticated (misma visibilidad) | |
| `returns:create` | **admin + PIN** (nueva firma `create(data, adminPin)`) | Era `authenticated` sin PIN (H5). Hoy repone stock sin autorización. |
| `returns:createWithRefund`, `returns:settleRefund` | **admin** (el PIN ya se exige) | Defensa en profundidad. |
| `returns:getSaleForReturn`, `returns:getAll`, `returns:previewVoucher`, `returns:printVoucher` | **admin** (consulta histórica y obligaciones legales) | Recomendado; D-listada. El vendedor deja de poder buscar reembolsos. |

Sin tablas eliminadas, sin canales eliminados: se **restringen**. Se actualizan `ipc-policy.test.mjs`, `safety.mjs:117`, `security.mjs` y los suites `refunds*`/`returns` (que hoy asumen apertura).

---

## 5. Migraciones necesarias (borradores para revisión — NO generadas, NO aplicadas)

Se generarían con `drizzle-kit generate` a partir de `schema.ts`; las tablas de abajo muestran la intención y los `CHECK`. Convención del repositorio: SQL con comentarios, sin *backfills* destructivos, índices parciales con `where`.

### 5.1 `0010_sale_items_misc_lines` (08B)

```sql
-- Varios: líneas de venta sin producto de catálogo. Aditiva; las filas existentes quedan 'catalog'.
ALTER TABLE "sale_items" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD COLUMN "line_kind" text DEFAULT 'catalog' NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_line_kind_check" CHECK (
  ("line_kind" = 'catalog' AND "product_id" IS NOT NULL)
  OR ("line_kind" = 'misc' AND "product_id" IS NULL AND "product_name" IS NOT NULL AND "product_sku" IS NULL));
```

- `text` + `CHECK` en lugar de `ENUM`: evita la limitación de `ALTER TYPE … ADD VALUE` en transacción (ya documentada en `schema.ts` para `'deleted'`).
- La FK a `products` se conserva (un `NULL` no la viola). Todas las filas actuales cumplen el `CHECK` por construcción (`product_id` era `NOT NULL`).
- Bloqueo breve de `sale_items` (tabla pequeña). Un solo `ALTER … DROP NOT NULL` es solo catálogo.
- **No hay migración «hacia abajo»** (Drizzle no las tiene): la reversión es restaurar el respaldo previo (§7).

### 5.2 `0011_exchanges` (08C)

```sql
CREATE TABLE "exchanges" (
  "id" serial PRIMARY KEY NOT NULL,
  "sale_id" integer NOT NULL,
  "reason" text NOT NULL,
  "processed_by" integer NOT NULL,           -- quien atendió
  "authorized_by" integer NOT NULL,          -- administrador del PIN
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "cash_session_id" integer NOT NULL,        -- caja abierta al momento (exigida)
  "returned_total" numeric(12,2) NOT NULL,   -- crédito (precio pagado)
  "new_total" numeric(12,2) NOT NULL,        -- precio actual de lo entregado
  "surcharge" numeric(12,2) NOT NULL,        -- diferencia cobrada
  "payment_method" "payment_method",         -- enum existente (sin ALTER TYPE)
  "cash_movement_id" integer,
  "external_reference" varchar(64),
  "operation_id" text NOT NULL,
  CONSTRAINT "exchanges_amounts_non_negative" CHECK ("returned_total" >= 0 AND "new_total" >= 0),
  CONSTRAINT "exchanges_surcharge_exact" CHECK ("surcharge" >= 0 AND "surcharge" = "new_total" - "returned_total"),
  CONSTRAINT "exchanges_payment_coherent" CHECK (
    ("surcharge" = 0 AND "payment_method" IS NULL AND "cash_movement_id" IS NULL AND "external_reference" IS NULL)
    OR ("surcharge" > 0 AND "payment_method" = 'cash' AND "cash_movement_id" IS NOT NULL AND "external_reference" IS NULL)
    OR ("surcharge" > 0 AND "payment_method" = 'card' AND "cash_movement_id" IS NULL))
);
-- FKs: sale_id→sales, processed_by/authorized_by→users, cash_session_id→cash_sessions, cash_movement_id→cash_movements
CREATE UNIQUE INDEX "exchanges_operation_id_unique" ON "exchanges" ("operation_id");
CREATE UNIQUE INDEX "exchanges_cash_movement_unique" ON "exchanges" ("cash_movement_id") WHERE "cash_movement_id" IS NOT NULL;
CREATE INDEX "exchanges_sale_idx" ON "exchanges" ("sale_id");
CREATE INDEX "exchanges_session_idx" ON "exchanges" ("cash_session_id");
CREATE INDEX "exchanges_created_at_idx" ON "exchanges" ("created_at");

CREATE TABLE "exchange_returned_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "exchange_id" integer NOT NULL,            -- FK → exchanges
  "sale_item_id" integer NOT NULL,           -- FK → sale_items
  "product_id" integer NOT NULL,             -- FK → products
  "quantity" integer NOT NULL,
  "unit_credit" numeric(12,2) NOT NULL,
  "credit_amount" numeric(12,2) NOT NULL,
  "item_condition" text NOT NULL,
  CONSTRAINT "exchange_returned_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "exchange_returned_amounts_non_negative" CHECK ("unit_credit" >= 0 AND "credit_amount" >= 0),
  CONSTRAINT "exchange_returned_condition_check" CHECK ("item_condition" IN ('resellable','damaged'))
);
CREATE UNIQUE INDEX "exchange_returned_exchange_item_unique" ON "exchange_returned_items" ("exchange_id","sale_item_id");
CREATE INDEX "exchange_returned_sale_item_idx" ON "exchange_returned_items" ("sale_item_id");

CREATE TABLE "exchange_new_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "exchange_id" integer NOT NULL,            -- FK → exchanges
  "product_id" integer NOT NULL,             -- FK → products
  "quantity" integer NOT NULL,
  "unit_price" numeric(12,2) NOT NULL,
  "subtotal" numeric(12,2) NOT NULL,
  "product_name" text NOT NULL,              -- como se entregó
  "product_sku" text NOT NULL,
  CONSTRAINT "exchange_new_quantity_positive" CHECK ("quantity" > 0),
  CONSTRAINT "exchange_new_amounts_non_negative" CHECK ("unit_price" >= 0 AND "subtotal" >= 0)
);
CREATE UNIQUE INDEX "exchange_new_exchange_product_unique" ON "exchange_new_items" ("exchange_id","product_id");
```

- **Solo tablas nuevas vacías**: ningún dato existente cambia; **no se elimina ni se altera `returns`, `return_items` ni `refund_settlements`**.
- Reutiliza el enum `payment_method` y `text`+`CHECK` (sin `ALTER TYPE`).
- Tras migrar: `GRANT` al rol de runtime (H13). El ensayo debe incluir un usuario de runtime con privilegios mínimos.

### 5.3 SKU y teclado: sin migración

- **SKU:** sin tabla ni secuencia nuevas. `createProduct` toma el id con `SELECT nextval('products_id_seq')`, inserta con ese `id` y `sku = 'EL-' || lpad(id, 6, '0')` en la **misma transacción**. La unicidad la garantiza el id (secuencia) y `products_sku_unique`; si un SKU manual antiguo ya ocupa ese texto (`23505`), se reintenta con el siguiente id (máx. 5 intentos, luego error de negocio). No sobrescribe ni reasigna SKU existentes. Los huecos de numeración son aceptables. *(D9: prefijo/formato.)*
- **Teclado:** `localStorage` (§2.1).

### 5.4 Cambios de herramientas asociados

`scripts/precheck-integrity.mjs` (H3), `e2e/migrations.mjs` (nuevos MIG-xx y huella de datos), `e2e/unit/schema-state.test.mjs` y cualquier cuenta fija «10 migraciones», `scripts/lib/demo-seed.mjs` (opcional: una venta con Varios en los datos de demostración).

---

## 6. Plan de pruebas automatizadas

Convenciones existentes: `node --test e2e/unit` (puro, importa `.ts` con `--experimental-strip-types`); suites que lanzan la app real con **base aislada** creada y destruida por la corrida (`e2e/run.mjs`); `e2e/migrations.mjs`, `e2e/legacy.mjs`, `e2e/installer-app.mjs`. Nada se ejecuta contra `beauty_pos` ni bases protegidas (`PROTECTED_DATABASES`). **Ninguna prueba se desactiva**; las que fijan el comportamiento antiguo (H5, H12) se **reescriben** con la nueva política y se explica en el PR.

### 6.1 Unitarias (puras, sin BD)

| ID | Qué prueba |
|---|---|
| NUM-01 | `applyKey`: dígitos, un solo `.`, máx. 2 decimales, sin ceros a la izquierda, tope de longitud, `⌫`, `C`, modo entero rechaza `.` |
| NUM-02 | Elegibilidad: solo `data-numpad`; nunca `#pos-search`, `password`, `readonly`, `disabled`, `[data-numpad-ignore]` |
| NUM-03 | Persistencia: lectura corrupta/`localStorage` que lanza ⇒ desactivado; posición fuera de pantalla ⇒ se limita |
| SKU-01 | Formato `EL-000124`; rellenado; id grande; el generador **rechaza** `sku` del cliente |
| VAR-01 | `parseSaleInput`: `kind` ausente=catalog; misc válida; `unitPrice` 0/negativo/>3 decimales; cantidad 0/decimal; descripción vacía→"Varios", >80, control; duplicados catalog sí, misc no; campos extra; 200 líneas |
| VAR-02 | Firma de `findReplay`: multiconjunto con Varios idénticos; orden indiferente; catalog vs misc no colisionan |
| VAR-03 | `lib/cart.ts`: `findCartIssues`/`applyCartIssues` ignoran misc; `checkoutSignature` distingue líneas |
| EXC-01 | `parseExchangeInput`: líneas, estados, `claimedSurcharge`, `operationId`, campos extra, pago obligatorio solo con diferencia > 0 |
| EXC-02 | `exchange-policy`: igual/mayor/menor; PIN siempre (v1); producto eliminado ⇒ solo dañado |
| EXC-03 | Cálculo en centavos: crédito a precio pagado, nuevo a precio actual, diferencia exacta, desbordes (`MAX_CENTS`) |
| EXC-04 | `exchange-voucher`: escape de HTML, CSP, 80/58 mm, estados, sin diferencia / con efectivo / con tarjeta |
| IPC-01 | `ipc-policy`: toda `exchanges:*` y `returns:*` con la política nueva; ningún canal sin entrada |
| MIG-U | `schema-state` con 12 entradas; `precheck` ya no marca Varios como huérfano |

### 6.2 Integración (app real + PostgreSQL aislado)

**Varios (`e2e/suites/misc.mjs`, nueva):** VAR-10 venta mixta catalog+misc (totales, `sale_items`, stock solo de catalog, **cero** `inventory_movements` para misc); VAR-11 venta solo misc (no toca `products`); VAR-12 efectivo y tarjeta (caja y movimientos correctos); VAR-13 **idempotencia** (mismo `operationId` ⇒ misma venta; mismo id con otras líneas ⇒ `OPERACION_DUPLICADA`; doble envío concurrente); VAR-14 rechazos (precio 0, descripción con control, subtotal/total alterado) sin dejar filas; VAR-15 cierre de caja concilia (`reconciles=true`, diferencia 0) y cierre vs venta concurrente; VAR-16 historial, ticket (PDF de impresión) y reportes (`byProduct` sin Varios + fila «Varios»; totales = suma de `sales`); VAR-17 `returns`/Cambios sobre línea misc ⇒ `ITEM_VARIO_NO_DEVOLVIBLE`; VAR-18 aislamiento: un vendedor solo ve sus ventas Varios.

**Cambios (`e2e/suites/exchanges.mjs`, nueva):** EXC-10 igual valor sin cobro (stock +/−, movimientos, `exchanges` y líneas); EXC-11 mayor valor en efectivo (caja +diferencia, movimiento IN enlazado, `current_amount`, cierre concilia) y en tarjeta (sin movimiento); EXC-12 **cruce con Reembolsos** (cambiada ⇒ no reembolsable; reembolsada ⇒ no cambiable; sumas ≤ vendido); EXC-13 menor valor ⇒ `CAMBIO_VALOR_MENOR` y **nada** escrito; EXC-14 estado «Dañado» (stock no sube) y producto eliminado; EXC-15 stock insuficiente / producto inactivo / mismo producto (neto); EXC-16 **PIN**: sin PIN, PIN erróneo, PIN de vendedor, administrador desactivado, bloqueo por intentos (misma cuota que login); EXC-17 **idempotencia** (réplica exacta devuelve lo mismo; mismo id con otro contenido ⇒ rechazo; doble clic); EXC-18 **concurrencia** (dos cambios sobre la misma línea: gana uno; cambio vs venta del mismo producto; cambio vs cierre de caja; sin deadlock con reembolso simultáneo); EXC-19 caja cerrada ⇒ `CAJA_REQUERIDA`; EXC-20 comprobante (vista previa/impresión no escribe en BD) e historial; EXC-21 **atomicidad** (fallo forzado a mitad ⇒ todo revierte); EXC-22 precios obsoletos ⇒ `DIFERENCIA_DESACTUALIZADA`.

**Endurecimiento de `returns:*` (reescrituras):** SEC-R1 vendedor **no** puede `returns:create`/`getSaleForReturn`/`getAll`; admin sí, con PIN; SEC-R2 reembolsos históricos siguen consultables por admin; SEC-R3 devoluciones/pagos pendientes y `legacy_unspecified` siguen intactos y pagables según las reglas actuales.

**Teclado y SKU:** SKU-10 alta sin SKU ⇒ SKU generado único y estable; 20 altas concurrentes ⇒ 20 SKU distintos; colisión con un SKU manual `EL-00xxxx` preexistente ⇒ reintento; SKU manual antiguo intacto; código de barras independiente/opcional; edición no cambia el SKU; SKU-11 `products:update` con `sku` ⇒ `SKU_NO_MODIFICABLE`.

### 6.3 E2E de interfaz (Playwright vía el arnés actual, 1024×768)

NUM-10 el teclado no aparece por defecto; se activa en Configuración y persiste tras reiniciar; NUM-11 escribe en cantidad, efectivo recibido y campos de Varios; NUM-12 **no** aparece en el buscador ni en campos de PIN; un código escaneado (tecleo rápido + Enter) sigue agregando el producto; NUM-13 arrastrar, minimizar, restaurar, límites de pantalla; NUM-14 **con el diálogo de cobro abierto** el teclado recibe clics, el diálogo no se cierra y el foco permanece en el campo (H10); NUM-15 el teclado físico sigue funcionando; NUM-16 cerrar sesión lo desmonta. VAR-20 flujo completo: «Varios» → carrito → cobro → ticket → historial; EXC-30 flujo completo de cambio con PIN y comprobante, y los tres estados de diferencia; EXC-31 navegación: vendedor sin acceso a «Reembolsos», admin sí.

### 6.4 Migraciones y compatibilidad (`e2e/migrations.mjs`, `e2e/legacy.mjs`, `e2e/installer-app.mjs`)

MIG-18/19: BD vacía aplica 0000–0011; `CHECK`s rechazan filas incoherentes; **huella de datos** (conteo + md5 por tabla, como hoy) idéntica tras 0010 y 0011 sobre una base 0009 poblada; `schema-state` ⇒ `missing` para 0009, `ok` para 0011, `newer` para una base 0011 con app 0.8.x simulada. LEG-xx: la **copia** de la base real (0000–0006) migra 0007–0011 con los comandos reales (simulación, respaldo verificado, `--apply`) y conserva 9 ventas / 3 sesiones / 12 movimientos de caja. APP-15: payload 0.9.0 sobre carpeta usada por 0.8.1 ⇒ detecta esquema faltante, la ventana de mantenimiento actualiza con respaldo y la app arranca con los datos intactos. `test:all` debe seguir pasando entero.

---

## 7. Plan de compatibilidad y recuperación

### 7.1 Matriz de escenarios

| # | Escenario | Qué ocurre | Control |
|---|---|---|---|
| 1 | Instalación **nueva** 0.9.0 | Se aplican 0000–0011 | `test:installer` |
| 2 | **0.8.1 → 0.9.0** (instancia administrada, esquema 0009) | La app **no arranca** y muestra «La base de datos necesita actualizarse» (faltan 0010, 0011). En `--manage` → «Actualizar estructura»: **respaldo verificado `pre-migracion`** → migra (una transacción) → re-otorga permisos → verifica | APP-15 (nuevo) + ensayo manual en Windows aislado (aún pendiente, `docs/DEMO_CHECKLIST.md`) |
| 3 | **0.8.0 → 0.9.0** | Idéntico al 2: 0.8.0 y 0.8.1 tienen el **mismo esquema** (0000–0009); 0.8.1 no migró. No hay paso intermedio | mismo |
| 4 | Base externa del dueño (`beauty_pos`, 0000–0006) | Cinco migraciones pendientes (0007–0011). **No se toca**; se ensaya en **copia** con `db:migrate` (simulación → `--apply`) | `test:legacy` ampliado; decisión del dueño de cuándo |
| 5 | **08A sola (0.8.2)** | Sin migración: reinstalar sobre 0.8.1 y listo; *rollback* = reinstalar 0.8.1 | `test:installer-app` (patrón APP-14) |
| 6 | **Retroceso 0.9.0 → 0.8.x** | **No soportado en caliente**: 0.8.x rechaza la base (`newer`). Recuperación = restaurar el respaldo `pre-migracion` en una **base nueva**, reconfigurar y reinstalar 0.8.1. **Se pierden las operaciones posteriores a la migración** | procedimiento en `OPERATIONS.md`; ensayo en copia |
| 7 | Migración interrumpida | Una sola transacción: nada a medias; se conserva el respaldo | ya probado (`db:migrate --apply fails`) |
| 8 | Devoluciones **pendientes** / `legacy_unspecified` existentes | Se conservan; `settleRefund` (admin + PIN) sigue funcionando; `legacy` sigue sin poder pagarse desde el POS | SEC-R3 |
| 9 | Datos previos de ventas (sin `product_name`/`sku`) | Siguen mostrando el nombre de catálogo marcado «catalog» (comportamiento 0007) | prueba de historial existente |
| 10 | Caja **abierta** durante la actualización | Evitar: se actualiza con la caja **cerrada** y tras el cierre del día | checklist |

### 7.2 Procedimiento recomendado de actualización (real)

1. Cerrar la caja del día; cerrar la app. 2. **Respaldo verificado** en dos ubicaciones (`db:backup --second-copy` / «Respaldo» de `--manage`); comprobar SHA-256 y `pg_restore -l`. 3. **Ensayar el mismo respaldo restaurado en una base nueva y desechable** con `db:migrate` (simulación y `--apply`) y revisar conteos. 4. Instalar 0.9.0 sobre la instalación. 5. `--manage` → «Actualizar estructura» (o `db:migrate --apply --confirm-database=<nombre>` en externas + `npm run db:roles` si hay rol de runtime). 6. Comprobar: login, venta de prueba **en una caja de prueba**, Varios, un cambio, cierre y conciliación. 7. Conservar el respaldo previo al menos 30 días.

### 7.3 Garantías de datos

No se elimina ni altera ninguna tabla/columna histórica; 0010 solo relaja `NOT NULL` y añade una columna con valor por defecto; 0011 solo añade tablas vacías; no hay *backfills* ni reinterpretación de estados (`legacy_unspecified` nunca pasa a `paid`).

---

## 8. Riesgos y decisiones comerciales pendientes

### 8.1 Decisiones que necesito del dueño / revisión (con recomendación por defecto)

| ID | Decisión | Recomendación v1 |
|---|---|---|
| **D1** | ¿Todo cambio exige PIN de administrador? | **Sí** (fail-closed). La política es una función pura: si el volumen lo pide, se puede permitir a vendedores un cambio **igual/mayor, revendible, ≤ N días** y dejar el PIN solo para excepciones. |
| **D2** | **Cambio de menor valor** (pendiente por mandato) | Bloqueado. Opciones futuras: saldo a favor/vale; reembolso excepcional con PIN (ya existe en Reembolsos); diferencia entregada en efectivo. |
| D3 | Plazo para cambios y prueba de compra (ticket obligatorio / solo folio) | Solo folio en v1; el plazo se muestra como aviso, no se bloquea. Decidir días y si se vuelve regla. |
| D4 | Artículo **dañado**: ¿se da crédito completo? | Con PIN del admin, sí; no repone stock. Decidir si se quiere un contador de «mermas». |
| **D5** | Varios: ¿quién puede, tope por línea y umbral de PIN? | Cualquier usuario autenticado; tope = `MAX_CENTS`; reporte visible de totales Varios. Decidir un umbral (p. ej. «≥ $X pide PIN»). |
| D6 | ¿Varios es cambiable? | No (no hay inventario ni producto al que reponer). |
| D7 | ¿Un vendedor puede buscar por folio una venta de **otro** vendedor para un cambio? | Sí por folio (la tienda comparte caja y cualquiera atiende), nunca listados; el PIN de admin es el control. |
| D8 | ¿El vendedor puede activar el teclado, y en qué pantallas? | Solo admin en Configuración (hoy `/settings` es admin) y solo en **Vender**; ampliar a Cambios después. |
| D9 | SKU: prefijo/formato y si queda **solo lectura** | `EL-000124`; solo lectura. |
| D10 | Reportes: ¿lo entregado en cambios cuenta en el ranking por producto? ¿definición de «ingreso neto»? | Ranking solo con ventas; «Ingreso cobrado» = ventas + diferencias; sección aparte de Cambios. |
| D11 | Anular un cambio | Fuera de v1 (inmutable); una corrección es una operación administrativa nueva. |
| D12 | Resolución de reembolsos `legacy_unspecified` | Sigue pendiente desde Sprint 05. |
| D13 | Tras instalar 0.9.0 la app solo avisa «actualizar la base»: ¿abrir Mantenimiento automáticamente? | Pequeña mejora en 08C, sin migrar sola. |
| D14 | Texto de política de cambio en el ticket (`returnPolicy`) y términos de la tienda | Revisar redacción «devolución» → «cambio». |

### 8.2 Riesgos técnicos

| Riesgo | Mitigación |
|---|---|
| Teclado dentro de diálogos Radix (H10) | Spike inicial con prueba real (NUM-14); `pointer-events:auto`, `onInteractOutside`, foco por `ref`; si no es viable, plan B: renderizarlo **dentro** del `DialogContent` activo. |
| Teclado vs lector de códigos | Sin foco propio, `tabIndex=-1`, lista blanca de campos, nunca en el buscador; prueba de escaneo (NUM-12). |
| Regresión en lógica financiera existente al unificar «ya devuelto» (H6) | Cambio mínimo en un helper, con pruebas de no regresión de `test:returns`/`refunds`/`refundauth`/`refundui` y la prueba cruzada EXC-12. |
| Descuadre de caja por el cobro de diferencia (H7) | Vínculo estructurado `cash_movement_id`; `cash-summary` y `cash-report` actualizados en el **mismo** PR; prueba de conciliación (EXC-11). |
| Cobro con tarjeta «registrado» sin cobrarse | Confirmación explícita del operador + referencia; el POS no realiza operaciones bancarias (mismo criterio que Reembolsos). |
| Cierre de `returns:*` rompe pruebas/flujos que asumían apertura | Reescritura explícita y documentada; ningún canal desaparece. |
| Línea Varios con precio libre (fraude/error) | Límites, auditoría en historial y reportes, D5. |
| Carrito solo-Varios y consultas con lista vacía | Rama explícita; VAR-11. |
| Rol de runtime sin permisos sobre tablas nuevas (H13) | `regrant` en `--manage`; `db:roles` documentado; prueba con rol de privilegios mínimos. |
| Hash de migraciones con CRLF/LF | `schema-state` ya acepta ambos; verificar al generar 0010/0011 en Windows. |
| Base real a 5 migraciones de distancia (H9) | Ensayo en copia, respaldo verificado, ventana con caja cerrada. |
| Instalador sin firmar, hardware sin validar, ensayo NSIS pendiente | Ya listado en `STATUS.md`; esta entrega **no** lo resuelve: 0.9.0 sigue sin estar «listo para tienda» hasta cerrarlo. |
| Dependencias de Drizzle: tipos `productId: number \| null` se propagan | Es deseable: `tsc` revela cada consumidor; `npm run typecheck` es criterio de aceptación. |

---

## 9. Bloques ejecutables: Sprint 08A, 08B, 08C

Reglas comunes (se repiten en cada bloque): partir de `origin/main` **recién sincronizado** (`git fetch origin`; anotar el SHA; **no asumir** el de este documento, `e53ed50`); rama propia desde ahí; **sin** tocar `beauty_pos` ni bases protegidas; **sin** migrar datos reales; no desactivar ni debilitar pruebas; no instalar dependencias sin justificar; no generar instalador; PR separado por sprint. Orden: **08A → 08B → 08C**, cada uno mergeado antes de empezar el siguiente. **Compuertas:** 08A puede arrancar tras aprobar las secciones 2.1, 2.2 y 5.3; **08B y 08C requieren aprobación expresa de las secciones 3–5** antes de escribir migraciones o lógica financiera.

### 9.1 Sprint 08A — Teclado numérico flotante + SKU automático (sin migración, sin lógica financiera)

```text
PROYECTO: BEAUTY SUPPLY POS — ESTÉTICA LEAL · SPRINT 08A
ENTORNO: C:\Projects\beauty-supply-POS · Windows nativo · Claude Code · Ponytail Full

PRE-VUELO (obligatorio, antes de editar):
1. git fetch origin ; registrar el SHA de origin/main (no asumir uno anterior). Crear la rama
   sprint-08a-keypad-sku desde ese SHA. Árbol limpio.
2. Leer docs/SPRINT_08_ARCHITECTURE.md (secciones 1, 2.1, 2.2, 5.3, 6) — es el contrato.
3. Graphify: graphify-out/ puede estar obsoleto; comprobar built_at_commit contra HEAD y, si está
   obsoleto, usarlo solo para orientarse y verificar en el código.

ALCANCE (solo esto):
A) Teclado numérico flotante en Vender.
   - PASO 1 (spike, antes de lo demás): demostrar con una prueba real que un elemento fijo con
     pointer-events:auto recibe clics y mantiene el foco en "Efectivo recibido" con el Dialog de cobro
     abierto (Radix), sin cerrarlo. Si no es viable, usar el plan B de la sección 8.2 y avisar.
   - lib/numpad.ts (puro: applyKey) y componente montado solo en /sales dentro de POSLayout.
   - Preferencia en localStorage "pos.numpad.v1" {enabled,minimized,x,y}, try/catch, desactivado por defecto.
   - Interruptor en Configuración (tarjeta "Este equipo", efecto inmediato, fuera del formulario comercial).
   - Campos permitidos SOLO con data-numpad="integer|decimal": cantidad del carrito (pasar a type=text
     inputMode=numeric) y "Efectivo recibido". Nunca #pos-search ni campos de PIN.
   - Botones sin foco (tabIndex -1, preventDefault en pointerdown), sin tecla Intro; arrastrar,
     minimizar, límites de viewport, z-index sobre Radix, objetivos >= 48 px.
B) SKU automático.
   - catalog-service.createProduct: id con nextval('products_id_seq'), sku = 'EL-' + id a 6 dígitos
     en la MISMA transacción; reintento (máx. 5) ante 23505 por colisión con un SKU manual antiguo.
   - parseProductCreate rechaza "sku" del cliente; parseProductUpdate rechaza "sku" (SKU_NO_MODIFICABLE).
   - Productos: quitar el campo SKU del alta; mostrarlo de solo lectura al editar; el código de barras
     sigue opcional e independiente. NO modificar SKU existentes. SIN migración.
   - Reescribir (no borrar) las pruebas de e2e/suites/catalog.mjs que asumían SKU del cliente (líneas ~27-158).

PRUEBAS (ver sección 6): NUM-01..03, SKU-01 (unit); SKU-10/11 (integración); NUM-10..16 (UI).
Ejecutar: npm run typecheck ; npm run lint ; npm run test:unit ; npm run test:catalog ; npm run test:screens ;
npm run test:fields ; npm run test:cart ; y luego npm run test:all. Informar cada resultado tal cual (FAIL/SKIP incluidos).

NO HACER: migraciones, cambios en pos-service/returns/refund, nuevas dependencias, instalador, commits sin pedirlo.
ENTREGABLE: cambios + resumen de qué se verificó y qué NO (hardware: pantalla táctil real y lector físico).
```

### 9.2 Sprint 08B — Ventas «Varios» (migración 0010 + lógica de venta) — requiere aprobación de §3 y §5.1

```text
PROYECTO: BEAUTY SUPPLY POS — ESTÉTICA LEAL · SPRINT 08B (VARIOS)
PRE-VUELO: git fetch origin ; SHA de origin/main anotado (08A ya integrada) ; rama sprint-08b-misc-lines.
Leer docs/SPRINT_08_ARCHITECTURE.md (secciones 1.1 H1-H4, 3, 5.1, 6, 7). COMPUERTA: no escribir la migración
sin aprobación explícita de la revisión arquitectónica.

ALCANCE:
1. Esquema y migración: schema.ts (saleItems.productId nullable, lineKind) + `drizzle-kit generate`
   → 0010 conforme a 5.1 (revisar el SQL generado y los comentarios; CRLF/LF; journal; snapshot).
   NO aplicarla a ninguna base existente: solo a bases desechables de prueba.
2. validation.ts: unión catalog|misc (sin kind = catalog); límites de 3.1.
3. pos-service.ts: createSaleTx/findReplay según 3.3 y 3.4. Proteger el carrito solo-Varios. Ningún stock
   ni inventory_movements para misc.
4. Consumidores: sales-history.getSaleDetail/legacySaleById (kind, nombre vendido), receipt-service,
   read-service (getSaleForReturn marca returnable:false; salesSummary.byProduct excluye misc + fila Varios),
   returns-service.registerReturn (ITEM_VARIO_NO_DEVOLVIBLE ANTES de leer productId), dashboard si aplica,
   scripts/precheck-integrity.mjs (H3). Dejar que `npm run typecheck` guíe el resto.
5. Renderer: CartItem unión con lineId (lib/cart.ts, cart-context, sales/page), botón "Varios" bajo la
   búsqueda + diálogo (cantidad, precio, descripción) con data-numpad, líneas con insignia "Varios",
   historial/ticket/reportes. Quitar/cantidad por lineId.
6. Pruebas: VAR-01..03 (unit), VAR-10..18 (integración, e2e/suites/misc.mjs registrada en e2e/run.mjs y
   package.json), VAR-20 (UI), MIG-18 en e2e/migrations.mjs (BD vacía, 0009→0010 con huella de datos,
   CHECKs), actualizar cuentas de migraciones.
7. Documentación: STATUS.md/TESTING.md/OPERATIONS.md (nueva migración, regrant del rol de runtime).

CRITERIOS DE ACEPTACIÓN: venta mixta y solo-Varios correctas; idempotencia incl. doble envío concurrente;
cierre de caja concilia; stock e inventario sin cambios por líneas Varios; ningún historial alterado;
huella de datos idéntica tras 0010; typecheck/lint/test:all en verde, informados tal cual.
NO HACER: tocar Cambios/Reembolsos más allá de rechazar líneas Varios; migrar beauty_pos; subir versión.
```

### 9.3 Sprint 08C — Cambios de producto (migración 0011 + lógica financiera + autorización) — requiere aprobación de §4, §5.2 y D1/D2

```text
PROYECTO: BEAUTY SUPPLY POS — ESTÉTICA LEAL · SPRINT 08C (CAMBIOS)
PRE-VUELO: git fetch origin ; SHA anotado (08A y 08B ya integradas) ; rama sprint-08c-exchanges.
Leer docs/SPRINT_08_ARCHITECTURE.md completo. COMPUERTA: no escribir 0011 ni exchange-service.ts sin
aprobación explícita de las secciones 4 y 5.2 y de las decisiones D1 (PIN) y D2 (valor menor).

ALCANCE:
1. Esquema: 0011 conforme a 5.2 (exchanges, exchange_returned_items, exchange_new_items). Solo tablas
   nuevas: NO alterar returns/return_items/refund_settlements. Probar solo en bases desechables.
2. Backend (puro primero, con pruebas): exchange-validation.ts, exchange-policy.ts, exchange-voucher.ts.
3. exchange-service.ts: createExchange según 4.3 (orden de locks: advisory → sesión → venta → líneas → productos),
   idempotencia, autorización inyectada (authorizeAdmin reutilizado), exigir caja abierta, neto de stock.
   Helper compartido returnedQuantities (4.4) usado también por registerReturn y getSaleForReturn.
4. Caja/reportes: cash-summary, cash-report, salesSummary, dashboard, getSaleDetail.exchanges, CSV (4.5).
5. IPC (4.7): exchanges:lookupSale/create/list/getDetail/previewVoucher/printVoucher; endurecer returns:*
   (returns:create → admin + PIN; el resto admin). Actualizar preload.ts y ACCESS. Ningún canal se elimina.
6. Renderer: /exchanges (flujo 2.4), navbar "Cambios", /returns → "Reembolsos (excepcional)" solo admin,
   Reembolsos conserva sus datos y consulta histórica. Reutilizar AuthorizationDialog y DocumentDialog.
7. Pruebas: EXC-01..04 (unit), EXC-10..22 (integración, e2e/suites/exchanges.mjs), SEC-R1..R3, EXC-30/31 (UI),
   MIG-19 + LEG-xx (copia legacy 0000-0006 → 0011) + APP-15 (0.8.1→0.9.0 con actualización de estructura).
   Reescribir (no borrar) safety.mjs:117, security.mjs, ipc-policy.test.mjs y suites refunds* según la nueva política.
8. Documentación: STATUS.md (decisiones D1-D14 tomadas), OPERATIONS.md (procedimiento 7.2 y retroceso 7.1-6),
   TESTING.md, REFUNDS.md (reembolso pasa a excepcional), nueva docs/EXCHANGES.md.

CRITERIOS DE ACEPTACIÓN: los tres casos de valor (igual/mayor/menor) según 4.2; sin duplicados por idempotencia;
caja concilia con cobros en efectivo; stock y movimientos correctos (incl. dañado y producto eliminado);
ninguna ruta de reembolso habitual sin autorización; datos históricos y estados legacy intactos; test:all en verde.
Informar PASS/FAIL/SKIP tal cual; declarar qué NO se verificó (impresora, terminal, instalador NSIS real).
CIERRE: preparar (sin publicar) el cambio de versión a 0.9.0 y la lista de verificación de actualización (7.2).
NO HACER: migrar beauty_pos, generar instalador, subir etiqueta/versión sin aprobación.
```

---

## 10. Recomendación de versión final

| Entrega | Versión | Motivo |
|---|---|---|
| **08A** (teclado + SKU) | **0.8.2** | Sin cambio de esquema: se instala sobre 0.8.0/0.8.1 sin «Actualizar estructura» y se revierte reinstalando 0.8.1. Se puede entregar a la sucursal en cuanto pase la validación en pantalla táctil/lector. |
| **08B + 08C** (Varios + Cambios) | **0.9.0** | Cambio de comportamiento del negocio (devoluciones → cambios), esquema nuevo (0010, 0011) que **impide el retroceso en caliente**: es un salto *minor*. Se entregan **juntas** en una sola ventana de actualización con **un** respaldo. |
| No usar **1.0.0** todavía | — | Siguen abiertos instalador firmado, ensayo NSIS en Windows aislado, impresora/lector/pantalla táctil reales y decisiones pendientes (`STATUS.md`). |

Reglas: no subir `package.json` hasta el cierre de 08C (y 0.8.2 al cierre de 08A); no fusionar 08B a una rama de distribución sin 08C; ninguna versión se declara «lista para tienda» por pasar `test:all` (distinguir verificado en laboratorio de verificado físicamente, como ya exige `docs/TESTING.md`).

---

## Anexo — Qué no se verificó en esta etapa

- No se ejecutó ninguna suite (`test:*`): esta actividad no cambia código, por lo que correrlas no validaría nada de lo propuesto. Las referencias a pruebas existentes (p. ej. `safety.mjs:117`, `catalog.mjs:135-138`) se leyeron, no se ejecutaron.
- No se generó ni aplicó ningún SQL; el de §5 es un borrador y puede variar al pasar por `drizzle-kit`.
- No se comprobó el comportamiento real de Radix con el teclado (H10): es la primera tarea de 08A.
- No se abrió ninguna base de datos (ni protegida ni desechable) ni se tocó `graphify-out/`.
