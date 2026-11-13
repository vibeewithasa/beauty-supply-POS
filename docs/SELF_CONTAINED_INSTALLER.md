# Instalador autónomo de Estética Leal POS (arquitectura de Sprint 07.1)

> **Referencia histórica:** este documento conserva rutas, ejemplos de manifiestos y resultados de las pruebas del instalador **0.8.0/0.8.1**. La versión actual del proyecto es **0.8.2** (`package.json`), cuyo instalador esperado se nombra `Estética Leal POS Setup 0.8.2.exe`. Los números y checksums de esta documentación **no certifican ese nuevo binario**. El teclado opcional, SKU automático, la ausencia de migraciones nuevas y sus pruebas están descritos en `docs/STATUS.md` y `docs/TESTING.md`; ejecutar además la validación física de `docs/DEMO_CHECKLIST.md` antes de distribuir.

Objetivo original: que **un solo archivo** (`Estética Leal POS Setup 0.8.1.exe`) deje la aplicación funcionando en una laptop con Windows, **sin instalar ni administrar PostgreSQL a mano**,
sin Node.js, sin Internet y sin repositorio. Este documento define la arquitectura y los motivos; la guía para quien instala está en `docs/DEMO_INSTALL_LAPTOP.md`.

> Estado honesto: lo descrito aquí como "verificado" se probó con **PostgreSQL real, aislado, en carpetas temporales** de la PC de desarrollo (sin instalar servicios) y con el
> contenido real del instalador. La ejecución del `.exe` (NSIS) y la desinstalación en un Windows limpio **no** se han podido probar: ver la sección "Lo que falta probar".

## 1. Opciones estudiadas

| | A. Binarios oficiales dentro del instalador | B. Instalador oficial de PostgreSQL en modo desatendido | C. Instancia dedicada (`initdb` + `pg_ctl`) |
|---|---|---|---|
| Qué es | Un `.zip` oficial de binarios (sin instalador) que viaja dentro del nuestro | `postgresql-18-windows-x64.exe --mode unattended` ejecutado por nuestro instalador | Un clúster propio creado con las herramientas de A |
| Offline | Sí | Sí si se incluye el instalador (~350 MB) | Sí |
| Permisos | Ninguno propio | **Administrador** (instala servicio, carpeta del sistema y cuenta `postgres`) | Ninguno: corre como el usuario de Windows |
| Convive con un PostgreSQL ajeno | Sí (carpetas y puerto propios) | **Mal**: el instalador oficial detecta/choca con instalaciones, servicios y el puerto 5432 | Sí |
| Desinstalar sin perder datos | Sí | Hay que desinstalar PostgreSQL aparte; riesgo de borrar datos ajenos | Sí: el desinstalador solo quita la app |
| Mantenimiento | Actualizar un zip fijado por hash | Seguir el instalador de EnterpriseDB y sus opciones | Igual que A |
| Tamaño añadido | ~50 MB comprimido | ~350 MB | (usa A) |
| Verificabilidad en esta PC | Total | **No** sin tocar la PC principal (instala un servicio) | Total |

**Decisión: A + C.** Se empaquetan los binarios oficiales (A) y con ellos se crea una instancia independiente y exclusiva de Estética Leal (C). La opción B se descarta: exige
administrador, instala un servicio del sistema, puede chocar con un PostgreSQL ajeno y no se puede verificar sin instalarlo en la PC principal.

### Servicio de Windows vs. proceso del usuario

El requisito original pedía "servicio con inicio automático". Se evaluó y **no se implementó** en esta versión, por estas razones:

* Registrar un servicio exige elevación (UAC) y una cuenta de servicio con acceso a la carpeta de datos; no se puede probar aquí sin instalar un servicio en la PC principal, y un código
  de servicio sin probar es un riesgo que el propietario no debe llevar a una presentación.
* PostgreSQL se rehúsa a correr como Administrador: el proceso del usuario normal es *más* restrictivo (no es SYSTEM, no es administrador, solo toca su propia carpeta).
* Para esta aplicación (una caja en una sola laptop) el servicio no aporta nada que la aplicación no haga: **la aplicación arranca la instancia al abrirse** (`pg_ctl start`, espera a
  que acepte conexiones) y la **apaga limpiamente al cerrarse** (sin procesos huérfanos y sin archivos bloqueados al actualizar o desinstalar). Tras reiniciar Windows, abrir la aplicación la vuelve a levantar sola (PostgreSQL se recupera de un apagado sucio con su
  registro de transacciones; esto se probó matando el proceso a la fuerza).
* El diseño aísla todo detrás de `scripts/lib/managed-pg.mjs`: sumar un modo "servicio" más adelante (instalador por equipo) no cambia el resto.

La contrapartida (documentada): si nadie abre la aplicación, PostgreSQL no está corriendo, y **no hay respaldos programados** para esta instancia (limitación pendiente): los respaldos se hacen desde la
ventana de Mantenimiento (`Beauty POS.exe --manage`, o `resources\tools\Mantenimiento.cmd`).

## 2. Origen, licencia y dependencias del PostgreSQL empaquetado

* **Fuente:** `https://get.enterprisedb.com/postgresql/postgresql-18.6-1-windows-x64-binaries.zip`, el archivo de "binarios" que la página oficial `postgresql.org/download/windows`
  enlaza (EnterpriseDB). No está firmado con Authenticode (se comprobó: `NotSigned`), así que la integridad se fija por **SHA-256** en `scripts/postgresql-pin.json`
  (`fbe23da2…252f8c`, 343 808 005 bytes). `scripts/fetch-postgres.mjs` descarga una sola vez (la construcción puede usar Internet), rechaza cualquier archivo con otro hash y prepara el paquete.
  Limitación: el hash se fijó la primera vez que se descargó (no hay hash publicado por el proveedor con el que compararlo); cambiar de versión es una decisión explícita en un commit.
* **Licencia:** PostgreSQL License (permisiva, permite redistribuir). El zip incluye además OpenSSL (Apache-2.0), ICU, libxml2, libxslt, zlib, lz4, zstd, libiconv, libintl, libcurl,
  mingw-w64 pthreads, etc., todos con licencias permisivas. Se incluyen los textos `server_license.txt` y `commandlinetools_3rd_party_licenses.txt` dentro del paquete.
* **No se incluyen** pgAdmin, StackBuilder, documentación, cabeceras, ni los lenguajes procedurales que dependen de Python/Perl/Tcl.
* **Arquitectura:** solo x64. El instalador y la aplicación son x64; en Windows de 32 bits o ARM sin emulación el preflight lo informa y no continúa.
* **Redistribuible de Visual C++:** los binarios dependen de `VCRUNTIME140.dll`, `VCRUNTIME140_1.dll` y `MSVCP140.dll` (VC++ 2015-2022 x64). Un Windows recién instalado puede no
  tenerlos. Se copian **junto a los ejecutables de PostgreSQL** (despliegue "app-local", permitido por Microsoft para esos archivos) desde la copia firmada por Microsoft de la máquina
  de construcción; `fetch-postgres.mjs` comprueba la firma Authenticode de cada uno y registra su versión y hash en el manifiesto. El Universal CRT (`api-ms-win-crt-*`) es parte
  de Windows 10/11.
* **Windows:** 10 (1809 o superior) y 11, también *Home* (no se usa nada de las ediciones Pro: ni servicios, ni políticas de grupo, ni Hyper-V). Server no se considera objetivo.
* **Sin Internet:** el paquete completo viaja dentro del instalador; la instalación y el uso nunca descargan nada.

## 3. Arquitectura en disco

```
C:\Users\<usuario>\AppData\Local\Programs\Beauty POS\      ← la aplicación (NSIS, por usuario, sin administrador)
    resources\postgresql\                                   ← paquete de PostgreSQL + postgresql-bundle.json (hashes). SOLO LECTURA: nunca se ejecuta desde aquí
C:\Users\<usuario>\AppData\Local\Estetica Leal POS\         ← raíz administrada (permisos solo para este usuario)
    installation.json                                       ← manifiesto de propiedad (ver 4)
    cluster-admin.json                                      ← contraseña del superusuario del clúster, protegida con Windows (DPAPI), NO es la de la aplicación
    runtime\18.6-1\bin|lib|share                            ← copia verificada del paquete desde la que se ejecuta PostgreSQL
    data\                                                   ← el clúster (PG_VERSION, base, pg_wal…)
    logs\                                                   ← registro del servidor y del aprovisionamiento (sin secretos)
    backups\                                                ← copias de seguridad
C:\Users\<usuario>\AppData\Roaming\Beauty POS\config.json   ← conexión de la aplicación (contraseña del rol de LA APLICACIÓN, protegida con DPAPI), como en 0.7.0
```

* **¿Por qué se ejecuta desde una copia en `runtime\` y no desde la carpeta de instalación?** Porque un `postgres.exe` en marcha bloquea sus archivos: si corriera desde
  `Programs\Beauty POS`, actualizar o desinstalar la aplicación fallaría o dejaría la carpeta a medias. Con la copia, la aplicación se puede actualizar y desinstalar sin tocar la instancia.
* **Datos fuera de la carpeta de instalación**, en `Local` (no `Roaming`: un clúster no debe sincronizarse con un perfil de red). Con `--user-data-dir` (pruebas, instalaciones a medida)
  la raíz administrada va dentro de esa carpeta.
* **Permisos NTFS:** la raíz se crea sin herencia, con control total solo para el usuario actual, `SYSTEM` y Administradores (`icacls`). Las pruebas lo auditan (ni `Users`, ni
  `Everyone`, ni `Authenticated Users`).

## 4. Propiedad de los recursos (manifiesto)

`installation.json` (escritura atómica) identifica **únicamente** lo que creó este instalador:

```json
{ "schema": 1, "installId": "<uuid>", "createdAt": "…", "appVersion": "0.8.0",
  "postgres": { "version": "18.6-1", "major": 18, "runtimeDir": "runtime\\18.6-1", "dataDir": "data", "port": 55432,
                "systemIdentifier": "<identificador de pg_controldata>", "superuser": "pos_cluster_admin" },
  "database": { "name": "beauty_pos_demo", "runtimeRole": "pos_demo_runtime", "mode": "demo" },
  "state": "ready", "steps": ["…"], "schemaMigrations": 10 }
```

La propiedad no se afirma por nombres de carpeta o puertos: se exige que coincidan (1) el `installId` dentro de `data\estetica-leal-managed.json`, (2) el *identificador de sistema*
del clúster (`pg_controldata`, único por `initdb`) con el del manifiesto, y (3) en una instancia en marcha, `pg_control_system().system_identifier`. Encender la instancia exige (1) y (2); toda operación de mantenimiento sobre una instalación
terminada (respaldo, actualizar estructura, reiniciar la demostración) exige las tres, y reiniciar la demostración exige además que la base lleve la marca de "demostración gestionada por esta instalación" (comentario de la base con el
`installId`). Deshacer un intento de instalación fallido exige la marca (1) con el `installId` de ese intento: una carpeta de datos sin esa marca nunca se borra.
Un PostgreSQL ajeno nunca cumple esas condiciones, así que nunca se modifica ni se elimina.

## 5. Configuración del clúster y seguridad

* `listen_addresses = '127.0.0.1'` (solo loopback; nunca se abren puertos en el firewall; escuchar solo en loopback no dispara el aviso del Firewall de Windows, a confirmar en la laptop).
* Puerto preferido 55432; si está ocupado (se comprueba enlazándolo de verdad) 55433-55450; el puerto elegido se guarda en el manifiesto y se **vuelve a comprobar en cada arranque**.
  Si el puerto elegido lo ocupa otro programa, se busca otro libre, se actualiza la configuración protegida y el manifiesto, y el clúster arranca ahí.
* `initdb -A scram-sha-256` con superusuario propio (`pos_cluster_admin`, no `postgres`); `pg_hba.conf` se reescribe con **solo** `host … 127.0.0.1/32 scram-sha-256` y se verifica que
  no haya `trust`. `password_encryption = scram-sha-256`.
* Codificación UTF-8 con proveedor `builtin` `C.UTF-8` (independiente de los idiomas instalados en Windows, orden por bytes, mayúsculas/acentos correctos en `ILIKE`; se probó).
* Contraseñas aleatorias (criptográficas): superusuario del clúster y rol de la aplicación son distintas. La del superusuario va a un archivo temporal (`--pwfile`) dentro de la
  raíz protegida, se **borra y se verifica el borrado**; nunca viaja en argumentos de procesos. La del rol de la aplicación solo se envía por SQL y se guarda con DPAPI en
  `config.json`. Las herramientas `pg_dump`/`pg_restore` reciben la contraseña por variable de entorno, como ya hacía `db-ops.mjs`.
* Rol de la aplicación con privilegios mínimos (sin DDL, sin crear bases ni roles): el mismo mecanismo de `db-roles` de sprints anteriores.
* DPAPI: lo escribe el proceso de la aplicación **ya ejecutándose como el usuario que la usará** (no el instalador elevado), de modo que ese usuario siempre puede descifrarlo.
* La aplicación normal sigue sin migrar al arrancar. Solo el asistente de primera instalación (ventana propia, sin el IPC de la aplicación) y la ventana de mantenimiento
  (`--manage`, con respaldo verificado previo) aplican el esquema.

## 6. Flujo de instalación

1. **Instalador (NSIS, un clic, por usuario).** Copia la aplicación y abre Estética Leal POS. No pide administrador, no registra servicios, no abre puertos. (Se evaluó un instalador
   asistido con páginas propias: los PIN tendrían que pasar por NSIS y por variables del instalador, y esas páginas no se pueden probar sin ejecutar el `.exe`; se prefirió un asistente
   dentro de la aplicación, que corre como el usuario correcto y sí se prueba automáticamente.)
2. **Asistente de primera instalación** (solo si no hay configuración ni instancia): preflight (§7) → elegir *Demostración* o *Instalación limpia* → PIN(es) (demo: administrador y
   vendedor; limpia: nombre y PIN del administrador) → progreso por pasos → la aplicación se reinicia sola y muestra la pantalla de PIN. Opción avanzada: "Usar un PostgreSQL existente"
   abre la ventana de conexión de 0.7.0 (credenciales explícitas, rol con privilegios mínimos).
3. **Arranques siguientes:** la aplicación comprueba la propiedad (§4), enciende la instancia si no corre (re-elige puerto si lo perdió), verifica el esquema y abre.

Fallo en cualquier paso: la ventana muestra **qué paso falló**, el diagnóstico (sin secretos) queda en `logs\provision-*.log`, y se deshace **solo** lo creado por esa ejecución (clúster
parcial, runtime copiado, manifiesto en estado `provisioning`); nada preexistente se toca. "Reintentar" repite desde cero; un manifiesto `provisioning` sin datos se reconoce como propio
y se limpia, uno `ready` nunca se toca.

## 7. Preflight

Comprueba y muestra: Windows x64 y versión; espacio libre (se exige 2 GB en la unidad de datos); si la carpeta administrada ya existe y a quién pertenece; PostgreSQL ajeno
(servicios `postgresql*` de Windows y programas escuchando en 5432); puertos candidatos; instalaciones previas (`config.json` de 0.7.0, manifiesto existente); capacidad de DPAPI. Un
PostgreSQL ajeno **no** es un obstáculo ni se usa: se informa y se continúa con la instancia dedicada en otro puerto. Una instancia dañada o sin permisos produce un diagnóstico, no una reparación a ciegas.

## 8. Ciclo de vida

* **Reinstalar / ejecutar el instalador otra vez:** reemplaza la aplicación; el asistente no aparece porque ya hay configuración; no se crean otro clúster, otra base ni otro rol.
* **Actualizar:** la aplicación nueva reutiliza la instancia. Si trae el mismo PostgreSQL, nada cambia; si trae una *versión menor* más nueva, se copia junto a la anterior y se
  cambia al detener la instancia (compatible a nivel de datos); un cambio de versión *mayor* se rechaza (requiere `pg_upgrade`, un procedimiento aparte). Un esquema más viejo que el de la
  aplicación no se migra solo: aparece el aviso y la ventana `--manage` exige un respaldo verificado antes de "Actualizar estructura".
* **Desinstalar:** quita la aplicación y los accesos directos. **Conserva** la raíz administrada, el clúster, las bases, los respaldos y `config.json` (`deleteAppDataOnUninstall: false`; el
  desinstalador de NSIS no conoce la carpeta `Estetica Leal POS`). La instancia se detiene al cerrar la aplicación; si se desinstala con la aplicación abierta o se la mató a la fuerza, puede seguir
  encendida hasta cerrar sesión o apagar Windows. Cómo detenerla o retirarla sin perder datos está en `docs/OPERATIONS.md`. Una eliminación completa es un procedimiento aparte, con
  respaldo previo y confirmación escrita, y solo actúa sobre recursos que cumplen la propiedad de §4.
* **Demostración vs. limpia:** el modo se fija al instalar. Una instalación con datos jamás recibe datos ficticios encima; "Reiniciar demostración" es una acción explícita de `--manage`,
  solo sobre una base marcada como demostración gestionada, con respaldo previo y confirmación escrita.

## 9. Qué cubre cada prueba

Los 25 escenarios pedidos para este sprint y el estado real de cada uno (INST = `npm run test:installer`, 29 comprobaciones con PostgreSQL real en carpetas temporales; APP = `npm run test:installer-app`, 14, con el instalador extraído y la interfaz real):

| # | Escenario | Estado |
|---|---|---|
| 01 | Windows sin PostgreSQL | **No reproducible aquí** (esta PC tiene su propio PostgreSQL 18). El diseño no lo usa; falta probarlo en un Windows limpio (checklist D2). |
| 02 | Windows con PostgreSQL en 5432 | INST-03 (servicio ajeno detectado, no tocado), INST-27 (sus bases, roles y hora de arranque idénticos), APP-02 |
| 03 | Puerto 55432 ocupado | INST-05, INST-13 (lo toma otro programa con la instancia apagada) |
| 04 | Instancia antigua del POS | APP-13 (config.json existente / PostgreSQL externo: sin asistente ni instancia propia); INST-16/17 (restos de un intento previo) |
| 05 | Primera instalación, modo demo | INST-06/07/08, APP-04/05/06/07/08 |
| 06 | Primera instalación, modo limpio | INST-19/20, APP-12 |
| 07 | Segundo arranque sin internet | APP-09, APP-10 (ninguna conexión fuera de este equipo), INST-26 (el código de instalación no tiene cliente HTTP). **No** se probó con la red físicamente desconectada. |
| 08 | Reinicio de Windows y servicio | INST-12 (proceso matado a la fuerza: recuperación sin perder lo confirmado). **No hay servicio** (ver §1); el reinicio real de Windows es manual (D4). |
| 09 | Instalador ejecutado de nuevo | INST-11 (cero cambios, nunca siembra encima). La repetición del `.exe` NSIS: manual. |
| 10 | Actualización conservando datos | INST-23 (estructura con respaldo previo), INST-24c (PostgreSQL de versión menor, mayor rechazada, build roto descartado). La actualización NSIS encima: manual. |
| 11 | Instalación fallida con rollback seguro | INST-16/17/18, APP-11 (paso nombrado, nada queda, reintento) |
| 12 | Credenciales inválidas | INST-22 |
| 13 | Falta de elevación | **No aplica por diseño**: INST-09 demuestra que todo corre sin elevación y como el usuario normal. |
| 14 | Espacio insuficiente | INST-04 |
| 15 | PostgreSQL detenido | INST-12, INST-14 (detenido + arranque), INST-15 |
| 16 | Desinstalación conservando datos | INST-25 (sin la carpeta de la aplicación la instancia sigue usable). El desinstalador NSIS: manual. |
| 17 | Reinstalación y reconexión | INST-25, APP-09 |
| 18 | Ventas y devoluciones | APP-08 |
| 19 | Historial y conciliación de caja | APP-07, APP-08 |
| 20 | Respaldos y restauración | INST-21, APP-10b |
| 21 | Ausencia de secretos en paquete y logs | INST-10, APP-01 (instalador), APP-05 (disco), APP-10b |
| 22 | Compatibilidad con 0.7.0 | APP-13, `test:packaged` (PK-09, PK-15), `test:demo` |
| 23 | Hash del paquete incorporado | INST-01/02/15, APP-01, APP-11 |
| 24 | Permisos de carpetas y procesos | INST-09, APP-05 (SID de las ACL, propietario del proceso, solo 127.0.0.1) |
| 25 | Bases ajenas sin modificar | INST-27 (+ `beauty_pos` y las E2E preservadas no se abren para escritura) |

## 10. Lo que falta probar (físico)

Ver `docs/DEMO_CHECKLIST.md` sección D. En resumen: ejecutar el `.exe` en un Windows limpio (SmartScreen, accesos directos, primera apertura), el asistente completo allí, reinicio de Windows,
desinstalar/reinstalar, aviso (o ausencia) del Firewall, antivirus, y hardware (impresora, lector, terminal).
