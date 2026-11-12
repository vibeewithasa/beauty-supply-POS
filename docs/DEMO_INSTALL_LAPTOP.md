# Estética Leal POS: instalación en una laptop con Windows (instalador autónomo 0.8.1)

Un solo archivo, **`Estética Leal POS Setup 0.8.1.exe`**, deja la aplicación lista para usar o para presentar. **No hay que instalar PostgreSQL, ni Node.js, ni correr scripts.**
**Diseñado para funcionar sin Internet después de la instalación:** el paquete incluye PostgreSQL y las pruebas automatizadas no observaron solicitudes de red ajenas al equipo; **no se comprobó todavía una instalación y jornada completas con la laptop físicamente desconectada**. Antes de prometer una demostración independiente, completar también ese ensayo manual sin Wi-Fi ni Ethernet en un equipo de prueba (abrir, entrar, vender, cerrar caja, generar respaldo, cerrar y volver a abrir) y registrar cualquier dependencia inesperada. Arquitectura y motivos: `docs/SELF_CONTAINED_INSTALLER.md`.

## Qué se verificó y qué no (leer antes de la presentación)

* **Verificado de forma automática en la PC de desarrollo** (`npm run test:installer`, `test:installer-app`, `test:demo`, `test:packaged`): el contenido del instalador (hash de sus 1 029 archivos de PostgreSQL),
  el asistente de primera instalación manejado por la interfaz real, la creación de la base propia con PostgreSQL real, las dos modalidades (demostración y limpia), el reinicio tras apagado brusco,
  las ventas/devoluciones/cajas sobre esa base, el respaldo y la restauración, la actualización, el reinicio de la demostración y el fallo seguro con reintento.
* **NO verificado:** ejecutar el `.exe` con NSIS y desinstalar en un Windows limpio (no hay equipo desechable y no se instaló nada en la PC principal), el reinicio real de Windows, el
  aviso del Firewall (no debería aparecer: solo se escucha en `127.0.0.1`), el antivirus, y la impresora/lector/terminal reales. Esas pruebas se hacen la primera vez en la laptop
  (sección D de `docs/DEMO_CHECKLIST.md`). **Hasta entonces el sistema no debe declararse listo para presentar sin ensayo previo.**

## Qué necesitas

| Cosa | Detalle |
|---|---|
| Laptop | Windows 10 (1809 o superior) u 11, de 64 bits, con **2 GB libres** como mínimo (la aplicación ocupa unos 500 MB y la base propia unos 100 MB al inicio). Sirve Windows Home. |
| Instalador | `Estética Leal POS Setup 0.8.1.exe`, **148 430 341 bytes (141,6 MiB)**. SHA-256 `6c88e8d53019152555ccd1bc82bd481e8e94b7b1874a0e14126313cc6d1e3f5f` (se vuelve a calcular al generar uno nuevo). Se genera con `npm run package` y queda en `release\`. No está en el repositorio ni en GitHub. |
| Permisos | Una cuenta normal de Windows. **No pide administrador** y no instala servicios. |
| Contraseñas | Solo los PIN que tú eliges durante la instalación. Las contraseñas de la base las genera el sistema, son aleatorias y se guardan protegidas por Windows. |

## 1. Copiar el instalador

Cópialo a la laptop con una memoria USB. Comprueba que no se dañó (PowerShell):

```powershell
Get-FileHash "$env:USERPROFILE\Downloads\Estética Leal POS Setup 0.8.1.exe" -Algorithm SHA256
```

El resultado debe coincidir con el SHA-256 **del mismo instalador aprobado**. El valor de la tabla describe el artefacto 0.8.1 documentado; **no es una huella universal de la versión 0.8.1**. Volver a ejecutar `npm run package`, cambiar un recurso o cambiar el entorno de empaquetado puede producir otro `.exe` y otro hash incluso con el mismo nombre. Si el archivo se volvió a generar, la persona responsable debe registrar y transmitir su nuevo SHA-256 por un canal independiente antes de copiarlo a la laptop. No fuerces una coincidencia ni desactives verificaciones.

## 2. Instalar la aplicación

1. **Antes de ejecutar**, confirma que el instalador proviene del responsable del proyecto y que su SHA-256 coincide exactamente con el del artefacto aprobado (paso 1). Un nombre de archivo o un hash obtenido de la misma fuente no prueban por sí solos su autenticidad. Doble clic en el instalador. Windows SmartScreen puede avisar "Windows protegió su PC" porque **el instalador no está firmado**. No omitas automáticamente esa advertencia: si la procedencia o la huella no están verificadas, detente. Solo en el ensayo controlado con el archivo verificado, el responsable puede decidir **Más información → Ejecutar de todas formas**.
2. Es de un solo clic y por usuario (no pide administrador). Crea los accesos **Estética Leal POS** en el escritorio y en el menú Inicio y abre la aplicación.
   Se instala en `C:\Users\<tu usuario>\AppData\Local\Programs\Beauty POS\`.

## 3. Primer inicio: el asistente

Como todavía no hay base de datos, aparece **"Bienvenido a Estética Leal POS"**:

1. **Comprobaciones** (automáticas): Windows de 64 bits y versión, espacio libre, PostgreSQL incluido en el instalador, si hay **otro PostgreSQL** en el equipo (no se usa ni se toca) y el **puerto**.
   * El sistema usa su propio PostgreSQL, **solo para este equipo** (`127.0.0.1`), en el puerto **55432**; si está ocupado usa el siguiente libre (55433-55450) y lo recuerda. No se abre nada en el Firewall.
   * Si falta espacio o el equipo no es compatible, el botón **Instalar** queda deshabilitado y se explica por qué.
2. **¿Cómo quieres empezar?**
   * **Demostración:** datos ficticios (24 productos, 3 días de ventas y cajas, 12 ventas, 2 devoluciones, un faltante de $5.00). Eliges **dos PIN** (6 a 8 dígitos): Administrador Demo y Vendedor Demo, distintos.
   * **Instalación limpia:** sin productos ni ventas. Escribes el nombre de la persona administradora y su PIN. Los demás usuarios se crean después desde *Usuarios*.
   Cada PIN se escribe dos veces. No hay PIN predeterminados y los PIN no vienen en el instalador.
3. **Instalar.** Se muestran los pasos (comprobaciones, copia verificada de PostgreSQL, creación de la instancia, inicio, base y datos, configuración protegida, verificación). Tarda unos 10-20 segundos.
4. La aplicación **se reinicia sola** y muestra la pantalla de PIN con *Estética Leal*. Entra con el PIN que elegiste.

**Una vez hecha la elección, no se cambia de una modalidad a la otra:** una instalación limpia nunca recibe datos ficticios encima, y una instalación con ventas reales jamás se "reinicia como demostración".

Si algo falla, la ventana dice **en qué paso** y por qué; lo que se alcanzó a crear se deshizo (nada preexistente se toca); el diagnóstico (sin contraseñas ni PIN) queda en
`%LOCALAPPDATA%\Estetica Leal POS\logs\provision-….log`; pulsa **Reintentar**.

## 4. Presentar

El guion está en `docs/DEMO_CHECKLIST.md`, sección C. El Vendedor Demo ve solo Vender, Caja, Historial, Devoluciones y Ver Stock; el Administrador Demo ve todo.

## 5. Repetir la demostración (dejar los datos como al principio)

Doble clic en `C:\Users\<tu usuario>\AppData\Local\Programs\Beauty POS\resources\tools\Mantenimiento.cmd` (o `"Beauty POS.exe" --manage`). Se abre la ventana de **Mantenimiento**:

* **Reiniciar la demostración** (solo existe en instalaciones de demostración): elige PIN nuevos, escribe `REINICIAR` y confirma. Antes se crea un **respaldo verificado** (`backups\`); luego se borra solo la base de
  demostración que este instalador creó, se carga de nuevo y la aplicación se cierra. Ábrela otra vez y entra con los PIN nuevos. Tarda unos segundos.
* En una instalación **limpia** esa opción no aparece.

## 6. Respaldos y estructura de la base

En la misma ventana de Mantenimiento:

* **Crear respaldo ahora:** una copia verificada (`pg_dump` + comprobación) en `%LOCALAPPDATA%\Estetica Leal POS\backups\`, con su resumen y huella SHA-256. Cópiala además a otra ubicación (memoria USB).
* **Actualizar estructura:** solo se habilita cuando una versión nueva de la aplicación trae cambios de estructura; siempre hace antes un respaldo verificado. La aplicación normal **nunca** modifica la estructura sola.
* Restaurar un respaldo: **todavía no hay botón** (la contraseña administrativa de la base solo la puede leer la aplicación). Los respaldos son archivos estándar de PostgreSQL y la restauración, siempre hacia una base **nueva**, está implementada y probada en las herramientas del proyecto; hoy la hace un técnico (`docs/OPERATIONS.md`). Guarda tus respaldos fuera de la laptop.

## 7. Si algo no funciona

| Síntoma | Qué hacer |
|---|---|
| "No se pudo iniciar la base de datos…" al abrir | Cierra y abre otra vez. Si persiste, el detalle está en `%LOCALAPPDATA%\Estetica Leal POS\logs\postgres\` (sin contraseñas). No borres la carpeta `data`. |
| Otro programa tomó el puerto | La aplicación elige sola otro puerto libre y actualiza su configuración. |
| "Los archivos de PostgreSQL de esta instalación no son los originales" | Un antivirus o una persona modificó la copia. Reinstala la aplicación (el instalador restituye el paquete) y abre de nuevo; los datos no se tocan. |
| "La contraseña … no se puede leer con esta cuenta de Windows" | La configuración está protegida para la cuenta de Windows que instaló. Entra con esa cuenta; con otra cuenta use *Usar un PostgreSQL que ya tengo* o restaure un respaldo. |
| SmartScreen bloquea el instalador | Más información → Ejecutar de todas formas (falta firma de código). |
| PIN incorrecto repetido | Tras varios intentos fallidos el sistema se bloquea un rato; espera y reintenta. El bloqueo no se pierde reiniciando. |

## 8. Actualizar la aplicación sin perder datos

Ejecuta el instalador nuevo encima (no hace falta desinstalar). Reemplaza solo la aplicación: la base, los usuarios, los PIN, los respaldos y las contraseñas **no se tocan**. Si la versión nueva
trae un PostgreSQL de la misma versión mayor (por ejemplo 18.6 → 18.9) se adopta sola, de forma segura (se conserva el anterior si el nuevo no arranca); un cambio de versión mayor **no** se hace solo.
Si trae cambios de estructura, la aplicación avisa y se aplican desde Mantenimiento, con respaldo previo.

## 9. Desinstalar

*Configuración de Windows → Aplicaciones → Estética Leal POS (Beauty POS) → Desinstalar* quita **solo la aplicación y los accesos directos**. **Se conservan** la base de datos y su carpeta
(`%LOCALAPPDATA%\Estetica Leal POS\`: `data`, `runtime`, `logs`, `backups`) y la configuración (`%APPDATA%\Beauty POS\`). Reinstalar después reconecta con todo.

* La base de datos es un proceso de tu cuenta (no un servicio de Windows): se detiene al cerrar la aplicación, al cerrar sesión o al apagar el equipo. Si desinstalaste con la aplicación abierta, ciérrala antes.
* Para **retirar todo** (irreversible; antes haz un respaldo y cópialo): ver "Retirar una instalación" en `docs/OPERATIONS.md`. No hay un botón que lo haga: es un procedimiento manual a propósito.

## 10. Con un PostgreSQL que ya tienes, o con una instalación 0.7.0

* Si ya existía una configuración (`%APPDATA%\Beauty POS\config.json`, de la versión 0.7.0 o hecha a mano) la aplicación **la respeta**: no muestra el asistente y no crea otra base.
* Para usar un PostgreSQL propio en una instalación nueva, en el asistente pulsa **Usar un PostgreSQL que ya tengo (avanzado)** y escribe las credenciales (usa un usuario de privilegios mínimos).
* El procedimiento anterior (`resources\tools\Preparar-Base-Demo.cmd`, que prepara datos ficticios en un PostgreSQL instalado aparte) sigue incluido para ese caso.

## 11. Para quien genera el instalador (PC de desarrollo)

```bash
npm run package            # descarga (una vez) y verifica PostgreSQL, compila y genera release\Estética Leal POS Setup 0.8.1.exe
npm run test:installer     # 29 comprobaciones del aprovisionamiento contra PostgreSQL real, en carpetas temporales
npm run test:installer-app # 14 comprobaciones: extrae el instalador y maneja el asistente con la interfaz real
npm run test:demo          # ensayo con un PostgreSQL externo (ruta avanzada)
```

El instalador no se publica en GitHub ni se distribuye desde el repositorio; se copia a mano a la laptop.

## Limitaciones pendientes

* Sin firma de código (aviso de SmartScreen) y sin actualización automática.
* La instancia de PostgreSQL no es un servicio de Windows: arranca al abrir la aplicación y se detiene al cerrarla. No hay respaldos programados para esta instancia (se hacen desde Mantenimiento).
* El icono "EL" es provisional; los datos comerciales (logotipo, dirección, teléfono, RFC) los define el dueño en *Configuración*.
* Impresora, lector de códigos y terminal bancaria sin probar con equipo físico.
