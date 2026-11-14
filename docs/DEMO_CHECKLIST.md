# Checklist de la demostración en Estética Leal

Para quien presenta. Las instrucciones de instalación están en `docs/DEMO_INSTALL_LAPTOP.md`.
Marca cada punto; lo que dice **(manual)** no se pudo probar en la PC de desarrollo y debe hacerse una vez en la laptop real **antes** del día de la presentación.

## A. Estado verificado (automático)

Con `npm run test:installer` (29), `npm run test:installer-app` (14), `npm run test:demo` (14) y `npm run test:packaged` (16):

* El instalador contiene el paquete probado (mismo `app.asar` byte a byte), el PostgreSQL fijado por hash (1 029 archivos, cada uno comprobado) y sin `.env`, contraseñas, PIN, datos de usuario ni
  archivos de una instalación (`config.json`, `installation.json`, `cluster-admin.json`, `pg_hba.conf`…).
* La aplicación extraída del instalador, sin repositorio, sin `.env`, sin Node.js en el PATH, sin `DATABASE_URL`, sin PostgreSQL instalado para ella: muestra el **asistente**, valida los PIN, crea la base propia
  (PostgreSQL real en una carpeta temporal, escuchando solo en 127.0.0.1, SCRAM, permisos restringidos), guarda las dos contraseñas protegidas con Windows, se reinicia sola y entra con los PIN elegidos.
* Sobre esa base se recorre la presentación completa: historial, ticket, reportes, productos, cajas con faltante de $5.00, apertura de caja, venta con tarjeta por código de barras y en efectivo por nombre,
  devolución autorizada con PIN de administrador, pago de la devolución pendiente, cierre de caja que concilia al centavo, cierre y reapertura (PostgreSQL se detiene y vuelve a arrancar con los datos intactos) y vista restringida del vendedor.
* Instalación limpia (un administrador, sin datos ficticios), reinicio de la demostración con respaldo previo y palabra de confirmación, respaldo y restauración, actualización de estructura con respaldo, actualización de PostgreSQL de versión
  menor, apagado brusco con recuperación, puerto ocupado, espacio insuficiente, paquete alterado, instalación fallida con deshacer seguro y reintento, reinstalación sin duplicar nada, y una configuración 0.7.0 / PostgreSQL externo que nunca dispara el asistente.
* La PC de desarrollo no se tocó: ni su PostgreSQL (se comparó la lista de bases y roles antes y después, y su hora de arranque) ni servicios de Windows.

## B. Antes de salir (en casa)

- [ ] Laptop con Windows actualizado y cargador; batería al 100 %.
- [ ] Instalador copiado y su SHA-256 comprobado (guía, paso 1). Copia extra del instalador en una memoria USB.
- [ ] Aplicación instalada y primer inicio hecho con la modalidad **Demostración** (guía, pasos 2-3); PIN del Administrador Demo y del Vendedor Demo anotados en un lugar privado.
- [ ] Probada una vez la ventana de Mantenimiento: *Crear respaldo ahora* y *Reiniciar la demostración* (guía, pasos 5-6), para saber cuánto tardan (unos segundos).
- [ ] **Reiniciar la demostración justo antes de salir** para que las ventas de ensayo no queden mezcladas.
- [ ] Si se mostrará con proyector o pantalla: resolución 1366x768 o mayor (la aplicación se revisó de 1024x768 a 1920x1080).

## C. Guion de la presentación (15-20 minutos)

1. **Entrada.** Mostrar la pantalla de PIN con *Estética Leal*. Entrar como **Vendedor Demo**: solo ve Vender, Caja, Historial, Devoluciones y Ver Stock (sin Reportes ni Usuarios).
2. **Caja.** *Caja → Abrir Caja* con un fondo (por ejemplo $500.00). Explicar que no se vende sin caja abierta.
3. **Venta en efectivo.** *Vender*: buscar por nombre ("Shampoo"), subir la cantidad, *Pagar → Efectivo → Completar Venta*. Mostrar la confirmación y el ticket.
4. **Venta con tarjeta y lector (simulados).** Escribir en el buscador el código de barras de un producto con código (por ejemplo el del Shampoo Hidratante: se muestra en *Productos*) para simular el lector. Seleccionar **Tarjeta** con datos ficticios y aclarar que **el POS no procesa ni confirma cargos bancarios**: la operación en una terminal externa debe verificarse por separado. No realizar un cargo real durante esta demostración.
5. **Historial y ticket.** *Historial*: buscar la venta, abrirla, *Ver recibo* (vista previa del ticket, "No es una factura fiscal"). Reimprimir solo si hay impresora (ver D).
6. **Movimientos de caja.** *Registrar Movimiento*: un retiro con razón. Mostrar que el total esperado cambia.
7. **Cierre de caja.** *Cerrar Caja*, contar el efectivo, ver la diferencia. Mostrar *Historial de sesiones*: tres días anteriores, uno con faltante de $5.00.
8. **Cambiar de usuario** (*Salir*) y entrar como **Administrador Demo**.
9. **Devoluciones (solo datos ficticios).** Buscar una venta de esta presentación, devolver una pieza, método efectivo y **simular** la entrega de dinero, indicando que el POS registra la confirmación del operador pero no transfiere efectivo por sí mismo. **Autorizar con el PIN del administrador** (el vendedor no puede autorizar solo) y mostrar el comprobante. No registrar una devolución de tarjeta como pagada hasta que el reembolso exista en la terminal externa.
10. **Devolución pendiente.** En la lista de devoluciones hay una **PENDIENTE** de la demostración: *Registrar pago* → efectivo → PIN del administrador. Explicar que "registrar" una devolución no significa que se pagó.
11. **Inventario.** *Productos* (alta/edición, cambio de precio con historial), *Recepción* (entrada de mercancía), *Ver Stock* (poco stock resaltado).
12. **Reportes.** Elegir *Desde* tres días atrás y *Generar reporte*: ventas por método y por producto, devoluciones pagadas y pendientes, exportar CSV.
13. **Tablero.** Ventas del día, productos con poco stock, reembolsos pendientes.
14. **Usuarios y Configuración.** Usuarios (PIN de 6 a 8 dígitos, nunca se muestran). Configuración: datos del negocio para el ticket (**vacíos a propósito**: preguntar al dueño qué datos desea imprimir; no se inventó ninguno).

Cosas que conviene decir con honestidad: el sistema es una versión de demostración sin firma de código; **está diseñado para funcionar sin Internet** con su PostgreSQL local, pero una jornada completa en una laptop físicamente desconectada **sigue pendiente de comprobarse** (ver `docs/DEMO_INSTALL_LAPTOP.md`); los datos de demostración son ficticios; la impresora, el lector y la terminal bancaria reales se prueban en la siguiente etapa. Antes de prometer una presentación sin conectividad, probar en la laptop, sin Wi-Fi ni Ethernet, iniciar sesión, vender, cerrar caja, generar un respaldo y reiniciar la aplicación, documentando el resultado.

## 0.8.2: comprobaciones adicionales antes de presentar

Estas pruebas son **manuales** para la nueva versión; `npm run test:keypad` y `npm run test:sku` prueban los comportamientos automatizados, pero no demuestran compatibilidad con el lector ni con una pantalla táctil física.

- [ ] **SKU automático:** con una base exclusivamente ficticia, crear un producto sin introducir SKU; verificar que aparece un identificador `EL-` generado, que no se puede editar después y que el código de barras opcional funciona de forma independiente. Reabrir Productos, buscar por el SKU y registrar una venta de prueba. Comprobar que los SKU previos permanecen intactos al actualizar desde una copia 0.8.1.
- [ ] **Teclado opcional:** confirmar que está desactivado inicialmente; con un administrador ir a `Configuración → Este equipo`, habilitarlo y comprobar que aparece `123` en Vender. Capturar cantidad entera y efectivo con dos decimales, mover/minimizar el panel y verificarlo a 1024×768 y a la resolución real del equipo. Comprobar que no escribe en PIN ni en el buscador de códigos, que el teclado físico sigue funcionando, y que cambiar de usuario no modifica la preferencia del equipo.
- [ ] **Integridad de actualización:** usar una instalación **desechable**, copia verificada fuera del equipo, y comprobar ventas, folios, PIN, configuración y SKU anteriores antes/después. La versión 0.8.2 no agrega migraciones; si Mantenimiento solicita cambios de esquema inesperados, detener la prueba y diagnosticarlo antes de continuar.

## D. Pruebas manuales en la laptop real (no automatizables aquí)

Orden recomendado, con el resultado esperado. Anotar fecha y resultado. **Mientras estas pruebas no se hagan, el estado es "listo para integrar", no "listo para presentar autónomo".**

1. **(manual) Instalación real con el `.exe`.** Antes de ejecutarlo, confirmar la procedencia y comparar el SHA-256 con el artefacto aprobado según `docs/DEMO_INSTALL_LAPTOP.md` (un hash aislado no prueba legitimidad). Si SmartScreen muestra una advertencia, **no omitirla automáticamente**: investigar cualquier discrepancia. Solo quien controla el ensayo, después de validar el archivo, puede decidir continuar. Comprobar después que se instala sin pedir administrador, aparecen los accesos *Estética Leal POS* y la aplicación abre con el icono provisional "EL" y el asistente.
2. **(manual) Asistente en un Windows limpio, sin PostgreSQL instalado:** modalidad Demostración, PIN distintos → pasos en verde → reinicio automático → pantalla de PIN. Anotar cuánto tarda y que no apareció ningún aviso del Firewall ni petición de administrador.
3. **(manual) Equipo con otro PostgreSQL instalado (5432):** el asistente lo menciona, usa el puerto 55432 y no cambia nada del otro.
4. **(manual) Reinicio de Windows:** abrir la aplicación sin tocar nada; la base arranca sola y se entra con el PIN. Probar también apagar Windows con la aplicación abierta (apagado sin cerrar) y volver a abrirla.
5. **(manual) Desinstalación:** *Aplicaciones → Estética Leal POS (Beauty POS) → Desinstalar*: quita la aplicación y los accesos; `%LOCALAPPDATA%\Estetica Leal POS` y `%APPDATA%\Beauty POS` quedan (esperado). Reinstalar encima: entra sin asistente y con los datos.
6. **(manual) Instalación limpia en otra cuenta de Windows o equipo:** un administrador, sin productos ni ventas; crear un vendedor desde *Usuarios*.
7. **(manual) Mantenimiento:** *Crear respaldo ahora*, *Reiniciar la demostración* (PIN nuevos) y comprobar que se vuelve a entrar.
8. **(manual) Pantalla real de la laptop:** escala de pantalla (125 %/150 %) y resolución; que nada se corte en el módulo Vender y en el diálogo de pago. Si tiene pantalla táctil, teclado numérico táctil del PIN.
9. **(manual, opcional) Impresora:** una impresión de ticket (80 mm o 58 mm) y de comprobante de devolución en la impresora que se vaya a usar; sin impresora, la vista previa funciona.
10. **(manual, opcional) Lector de código de barras:** escanear un producto con código; los de la demostración tienen códigos internos (prefijo 20).
11. **(manual) Windows Defender / antivirus:** confirmar que el instalador, la aplicación y `postgres.exe` no son puestos en cuarentena. Si aparece una detección, **no agregar exclusiones generales** para `%LOCALAPPDATA%\Estetica Leal POS`, la carpeta de instalación ni el antivirus completo. Detener el ensayo, comprobar la procedencia y el SHA-256 exacto del instalador (`docs/DEMO_INSTALL_LAPTOP.md`), conservar el nombre de la detección y analizarla antes de continuar. Solo un responsable del equipo puede evaluar una excepción puntual, documentada y temporal tras verificar el archivo; un hash coincidente por sí solo no demuestra seguridad.
12. **(manual, 0.8.1) Actualizar encima de la 0.8.0, solo en un entorno desechable:** preparar una instalación de prueba con **ventas ficticias**, crear un respaldo verificado y guardar una segunda copia fuera del equipo antes de ejecutar `Estética Leal POS Setup 0.8.1.exe`. No ensayar la actualización por primera vez sobre la caja ni sobre la base de ventas de una tienda real. Esperado: no aparece el asistente, se entra con los mismos PIN, ventas y usuarios siguen, y no se crea otra carpeta de datos. Comprobar los folios y totales anteriores **antes y después** y confirmar que la copia es recuperable; si algo falla, detener el ensayo sin borrar datos ni intentar rebajar el esquema. Probar además: agregar productos, ir a Caja y volver (el carrito sigue igual), y que "Número de venta" y "Cantidad a devolver" en Devoluciones se ven antes de enfocarlos (también al 125 %/150 % de escala).

## E. Lo que NO es esta demostración (decirlo antes de que lo pregunten)

* No está firmada con certificado de código (aparece el aviso de SmartScreen) y no se actualiza sola.
* No incluye datos reales ni datos comerciales inventados de Estética Leal (logotipo, dirección, teléfono, RFC): el icono "EL" es provisional y esos datos los define el dueño en *Configuración*.
* La impresión real, el lector y la terminal bancaria no se han probado con equipo físico.
* No es la distribución comercial: faltan decisiones de producto pendientes (ver `docs/STATUS.md`).
* La base de datos no es un servicio de Windows ni tiene respaldos programados: se enciende con la aplicación y los respaldos se hacen desde Mantenimiento.
