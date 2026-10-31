# Estética Leal POS: instalación de la demostración en una laptop con Windows

Esta guía deja la laptop lista para presentar el sistema con **datos ficticios**. No usa Node.js, VS Code, el repositorio ni `npm run dev`:
solo PostgreSQL + el instalador. Está pensada para la laptop de la persona dueña del proyecto (instalación controlada), no es la distribución comercial.

Qué se verificó y qué no (detalle en `docs/DEMO_CHECKLIST.md`):

* Verificado de forma automática (`npm run test:demo`, 14 comprobaciones): el contenido del instalador, la preparación de la base con la herramienta incluida, la
  ventana de configuración, el recorrido de la presentación con la aplicación extraída del instalador y sin ningún elemento del entorno de desarrollo.
* **NO verificado en la PC de desarrollo:** ejecutar el instalador (`.exe`) y desinstalar. No hay un entorno desechable y no se instaló nada en la PC principal. Esas dos pruebas se hacen
  la primera vez en la laptop (sección 6 del checklist).

## Qué necesitas

| Cosa | Detalle |
|---|---|
| Laptop | Windows 10 u 11 de 64 bits con espacio libre para PostgreSQL (unos cientos de MB) y la aplicación (unos 400 MB instalada). |
| Instalador | `Beauty POS Setup 0.7.0.exe` (unos 120 MB). Se genera con `npm run package` y se encuentra en `release\`. Cópialo con una memoria USB; no está en el repositorio ni en GitHub. |
| PostgreSQL | Se instala en el paso 1 (instalador oficial gratuito). |
| Contraseñas | La de PostgreSQL (la eliges en el paso 1) y dos PIN de 6 a 8 dígitos que eliges en el paso 3. **Nada de esto viene dentro del instalador.** |

## 1. Instalar PostgreSQL (una sola vez)

1. Descarga el instalador de PostgreSQL para Windows (EnterpriseDB) desde `https://www.postgresql.org/download/windows/`. Las pruebas se hicieron con la versión 18; si instalas otra, "Probar conexión" del paso 4 confirma que sirve.
2. Ejecútalo con las opciones por omisión: carpeta de instalación, componentes (PostgreSQL Server, pgAdmin 4 y Command Line Tools; **Stack Builder no hace falta**) y puerto **5432**.
3. Cuando pida la contraseña del superusuario `postgres`, escribe una que recuerdes y **anótala** (se usa en el paso 3). No la compartas ni la guardes en el proyecto.
4. Idioma/"locale": deja el que sugiere. La herramienta del paso 3 se adapta a la codificación del servidor.
5. Termina la instalación. El servicio `postgresql-x64-NN` queda iniciado y se inicia solo con Windows.

Comprobación (opcional): abre pgAdmin 4 e inicia sesión con la contraseña del paso 3; debe mostrar el servidor sin errores.

## 2. Instalar la aplicación

1. Doble clic en `Beauty POS Setup 0.7.0.exe`.
2. Windows SmartScreen puede avisar "Windows protegió su PC" porque el instalador **no está firmado** (no hay certificado de firma de código). Es esperado: **Más información → Ejecutar de todas formas**.
3. La instalación es de un solo clic y por usuario (no pide permisos de administrador). Crea los accesos directos **Estética Leal POS** en el escritorio y en el menú Inicio y abre la aplicación al terminar.
4. Como todavía no hay base configurada, la aplicación muestra la **ventana de configuración** ("Falta la configuración de la base de datos"). **Ciérrala por ahora** (la configuración se hace en el paso 4).

La aplicación se instala normalmente en `C:\Users\<tu usuario>\AppData\Local\Programs\Beauty POS\`. Sus datos de configuración quedan en `%APPDATA%\Beauty POS\config.json` (contraseña protegida por Windows).

## 3. Preparar la base de demostración (datos ficticios)

1. Abre la carpeta de la aplicación y entra a `resources\tools`: `C:\Users\<tu usuario>\AppData\Local\Programs\Beauty POS\resources\tools`.
2. Doble clic en **`Preparar-Base-Demo.cmd`**. Se abre una ventana de PowerShell y comprueba que PostgreSQL responde.
3. Contesta lo que pide (lo que escribes en los campos de contraseña y PIN no se muestra):

   | Pregunta | Qué escribir |
   |---|---|
   | Contraseña del administrador de PostgreSQL | La del paso 1. |
   | Nombre de la base de demostración | Enter para `beauty_pos_demo`. |
   | PIN del Administrador Demo | 6 a 8 dígitos, dos veces. |
   | PIN del Vendedor Demo | 6 a 8 dígitos, distinto al anterior, dos veces. |
   | Contraseña para el usuario de la aplicación | **Recomendado: escribe una tuya y anótala.** Con Enter se genera una segura que se muestra solo una vez. |

4. Al terminar, la ventana muestra: servidor, puerto, base de datos, usuario (`pos_demo_runtime`) y contraseña del usuario de la aplicación. **Cópialos**: se usan en el paso 4.

Qué hace la herramienta (y qué no):

* Crea una base **nueva**, un usuario de PostgreSQL de **privilegios mínimos** para la aplicación (no puede crear ni borrar tablas) y carga los datos ficticios con el esquema oficial.
* **Nunca modifica una base que ya existe.** Si el nombre ya existe, o es `beauty_pos`/`beauty_pos_smoke`, se niega y no deja nada a medias. Si algo falla en el camino, elimina solo lo que ella misma creó.
* Los PIN **no están en el instalador**: los eliges tú en este paso y solo se guardan como hash (scrypt). Los datos no contienen direcciones, teléfonos, RFC ni logotipo de ningún comercio.

### Qué datos trae la demostración

* 24 productos con SKU `DEMO-…` en 6 categorías (cabello, tratamientos, color, accesorios, uñas, cuidado de la piel); 6 con código de barras interno para probar el lector.
* Tres cajas cerradas de los 3 días anteriores con 12 ventas en efectivo y tarjeta, un retiro, un ingreso y **un faltante de $5.00** en uno de los cierres.
* Dos devoluciones: una **reembolsada en efectivo** (pagada al día siguiente) y una **pendiente de pago** para pagarla en vivo con el PIN del administrador.
* Dos usuarios: **Administrador Demo** y **Vendedor Demo**. Productos con poco stock para el tablero.
* La configuración del negocio queda como la crea el sistema: sin dirección, teléfono ni datos fiscales (se pueden escribir desde *Configuración* si el dueño lo desea).

## 4. Configurar la aplicación

1. Abre **Estética Leal POS** (acceso directo del escritorio). Aparece la ventana de configuración.
2. Escribe: Servidor `localhost`, Puerto `5432`, Base de datos `beauty_pos_demo`, Usuario `pos_demo_runtime` y la contraseña del usuario de la aplicación (paso 3).
3. **Probar conexión.** Debe mostrar la versión de PostgreSQL, "privilegios mínimos", "Esquema al día" y "Ya existe un administrador".
4. **Guardar y reiniciar.** La aplicación se reinicia sola y muestra la pantalla de PIN con el nombre **Estética Leal**.
5. Entra con el PIN del Administrador Demo (verás el tablero) o del Vendedor Demo (va directo a Vender, sin Reportes ni Usuarios).

La contraseña queda protegida con Windows en `config.json`; no se guarda en texto claro ni en el instalador. Para cambiarla más adelante: ejecuta `"…\Beauty POS.exe" --reconfigure`.

## 5. Empezar la demostración de nuevo (dejar los datos como al principio)

Después de ensayar (ventas, devoluciones, cierres) puedes dejar la demostración como nueva. En pgAdmin 4 → *Query Tool* conectado a la base **`postgres`**:

```sql
DROP DATABASE beauty_pos_demo WITH (FORCE);
DROP ROLE pos_demo_runtime;
```

Después vuelve a ejecutar el paso 3 (usa la **misma contraseña** del usuario de la aplicación para no tener que reconfigurar el paso 4). Comprobado: el procedimiento repite exactamente los mismos datos.
No borres ninguna otra base. Si la laptop tiene datos reales de otra instalación, usa otro nombre de base en el paso 3.

## 6. Desinstalar

*Configuración de Windows → Aplicaciones → Estética Leal POS (Beauty POS) → Desinstalar.* El desinstalador **no borra** PostgreSQL ni la base ni `%APPDATA%\Beauty POS` (por diseño: nunca elimina datos). Para quitarlo todo: pasos del apartado 5 y borrar esa carpeta.

## Problemas frecuentes

| Síntoma | Qué hacer |
|---|---|
| "PostgreSQL no responde en localhost:5432" | Servicios de Windows → `postgresql-x64-NN` → Iniciar. Revisa que el puerto sea 5432. |
| "La contraseña de postgres no es correcta" | Es la del paso 1. Si no se recuerda, hay que restablecerla con las herramientas de PostgreSQL (no con esta aplicación). |
| "La base ya existe" | Elige otro nombre o aplica el apartado 5. La herramienta no modifica bases existentes. |
| La ventana de configuración dice "la base de datos no está inicializada" | Se está apuntando a otra base: usa la creada en el paso 3. La aplicación nunca crea tablas por sí sola. |
| PIN incorrecto repetido | Tras varios intentos fallidos el sistema se bloquea un rato (protección contra adivinar el PIN) y lo indica en pantalla. Espera y reintenta; el bloqueo no se pierde reiniciando. |
| SmartScreen bloquea el instalador | Más información → Ejecutar de todas formas (falta firma de código). |

## Para quien genera el instalador (PC de desarrollo)

```bash
npm run package        # compila, empaqueta e instala el generador NSIS: release\Beauty POS Setup 0.7.0.exe
npm run test:demo      # ensayo completo sin instalar nada: extrae el instalador y recorre toda esta guía
```

El instalador no se publica en GitHub ni se distribuye desde el repositorio; se copia a mano a la laptop.
