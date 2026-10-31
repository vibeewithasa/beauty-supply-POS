# Checklist de la demostración en Estética Leal

Para quien presenta. Las instrucciones de instalación están en `docs/DEMO_INSTALL_LAPTOP.md`.
Marca cada punto; lo que dice **(manual)** no se pudo probar en la PC de desarrollo y debe hacerse una vez en la laptop real **antes** del día de la presentación.

## A. Estado verificado (automático, `npm run test:demo` + resto de suites)

* El instalador contiene exactamente el paquete probado (mismo `app.asar` byte a byte), la herramienta de preparación de la base y sus archivos de ayuda; sin `.env`, sin
  contraseñas, sin PIN ni hashes de PIN (los PIN se eligen al preparar la base).
* La preparación de la base con la herramienta incluida (PowerShell + el propio programa como motor, sin Node.js) crea una base nueva, un usuario de PostgreSQL de privilegios
  mínimos y los datos ficticios; los importes cuadran al centavo con la definición del conjunto de datos; rechaza datos inválidos y nombres de bases existentes sin dejar residuos.
* La aplicación extraída del instalador, sin repositorio, sin `.env`, sin Node.js en el PATH y sin `npm run dev`: abre la ventana de configuración, la configura, se reinicia sola,
  muestra la identidad **Estética Leal** y recorre: tablero, reportes con el rango de la demostración, productos, stock, historial, ticket, historial de cajas (con el faltante de $5.00),
  apertura de caja, venta con tarjeta por código de barras, venta en efectivo por nombre, devolución autorizada con PIN de administrador, pago de la devolución pendiente, cierre de caja,
  reinicio con los datos intactos y vista restringida del vendedor.

## B. Antes de salir (en casa)

- [ ] Laptop con Windows actualizado y cargador; batería al 100 %.
- [ ] PostgreSQL instalado, contraseña del superusuario anotada en un lugar privado (no en el proyecto).
- [ ] Aplicación instalada y configurada con la base `beauty_pos_demo` (guía, pasos 1-4).
- [ ] PIN del Administrador Demo y del Vendedor Demo anotados en un lugar privado.
- [ ] Probado el apartado 5 de la guía (reiniciar la demostración) una vez, para saber cuánto tarda (unos segundos).
- [ ] Reiniciar la demostración **justo antes de salir** para que las ventas de ensayo no queden mezcladas.
- [ ] Si se mostrará con proyector o pantalla: resolución 1366x768 o mayor (la aplicación se revisó de 1024x768 a 1920x1080).
- [ ] Copia del instalador en una memoria USB por si hay que reinstalar.

## C. Guion de la presentación (15-20 minutos)

1. **Entrada.** Mostrar la pantalla de PIN con *Estética Leal*. Entrar como **Vendedor Demo**: solo ve Vender, Caja, Historial, Devoluciones y Ver Stock (sin Reportes ni Usuarios).
2. **Caja.** *Caja → Abrir Caja* con un fondo (por ejemplo $500.00). Explicar que no se vende sin caja abierta.
3. **Venta en efectivo.** *Vender*: buscar por nombre ("Shampoo"), subir la cantidad, *Pagar → Efectivo → Completar Venta*. Mostrar la confirmación y el ticket.
4. **Venta con tarjeta y lector.** Escribir en el buscador el código de barras de un producto con código (por ejemplo el del Shampoo Hidratante: se muestra en *Productos*) para simular el lector. Pagar con tarjeta.
5. **Historial y ticket.** *Historial*: buscar la venta, abrirla, *Ver recibo* (vista previa del ticket, "No es una factura fiscal"). Reimprimir solo si hay impresora (ver D).
6. **Movimientos de caja.** *Registrar Movimiento*: un retiro con razón. Mostrar que el total esperado cambia.
7. **Cierre de caja.** *Cerrar Caja*, contar el efectivo, ver la diferencia. Mostrar *Historial de sesiones*: tres días anteriores, uno con faltante de $5.00.
8. **Cambiar de usuario** (*Salir*) y entrar como **Administrador Demo**.
9. **Devoluciones.** Buscar una venta de esta presentación, devolver una pieza, método efectivo, confirmar que se entregó el dinero y **autorizar con el PIN del administrador** (el vendedor no puede autorizar solo). Mostrar el comprobante.
10. **Devolución pendiente.** En la lista de devoluciones hay una **PENDIENTE** de la demostración: *Registrar pago* → efectivo → PIN del administrador. Explicar que "registrar" una devolución no significa que se pagó.
11. **Inventario.** *Productos* (alta/edición, cambio de precio con historial), *Recepción* (entrada de mercancía), *Ver Stock* (poco stock resaltado).
12. **Reportes.** Elegir *Desde* tres días atrás y *Generar reporte*: ventas por método y por producto, devoluciones pagadas y pendientes, exportar CSV.
13. **Tablero.** Ventas del día, productos con poco stock, reembolsos pendientes.
14. **Usuarios y Configuración.** Usuarios (PIN de 6 a 8 dígitos, nunca se muestran). Configuración: datos del negocio para el ticket (**vacíos a propósito**: preguntar al dueño qué datos desea imprimir; no se inventó ninguno).

Cosas que conviene decir con honestidad: el sistema es una versión de demostración sin firma de código; funciona sin Internet; la información de la demostración es ficticia; la impresora, el lector y la terminal bancaria reales se prueban en la siguiente etapa.

## D. Pruebas manuales en la laptop real (no automatizables aquí)

Orden recomendado, con el resultado esperado. Anotar fecha y resultado.

1. **(manual) Instalación real con el `.exe`.** Doble clic → SmartScreen "Más información → Ejecutar de todas formas" → se instala sin pedir administrador → aparecen los accesos directos *Estética Leal POS* (escritorio y menú Inicio) → la aplicación abre con el icono "EL" y la ventana de configuración.
2. **(manual) Desinstalación.** *Aplicaciones → Estética Leal POS (Beauty POS) → Desinstalar*: quita la aplicación y los accesos; la base y `%APPDATA%\Beauty POS` quedan (esperado). Reinstalar sobre lo anterior: la aplicación sigue conectada a la base sin reconfigurar.
3. **(manual) Instalación de PostgreSQL** siguiendo la guía en una laptop limpia (opciones del instalador de EnterpriseDB, servicio iniciado, puerto 5432).
4. **(manual) `Preparar-Base-Demo.cmd` con doble clic** (el ensayo automático ejecuta el mismo `.ps1` sin preguntas; la parte interactiva —campos ocultos de contraseña y PIN, repetir el PIN— solo se puede ver en una ventana real).
   Probar un PIN de 5 dígitos, PIN distintos que no coinciden, y que al terminar la ventana muestra el usuario y la contraseña de la aplicación.
5. **(manual) Primer arranque** con la ventana de configuración: probar conexión → guardar → reinicio automático → pantalla de PIN.
6. **(manual) Reinicio de Windows**: abrir la aplicación sin tocar nada; el servicio de PostgreSQL debe haber arrancado solo y entrar con PIN.
7. **(manual) Pantalla real de la laptop:** escala de pantalla (125 %/150 %) y resolución; que nada se corte en el módulo Vender y en el diálogo de pago. Si tiene pantalla táctil, teclado numérico táctil del PIN.
8. **(manual, opcional) Impresora:** una impresión de ticket (80 mm o 58 mm) y de comprobante de devolución en la impresora que se vaya a usar; sin impresora, la vista previa funciona y la impresión se prueba en la siguiente etapa.
9. **(manual, opcional) Lector de código de barras** (si hay uno): escanear un producto con código; los productos de la demostración tienen códigos internos (prefijo 20) que se pueden imprimir en una etiqueta de prueba.
10. **(manual) Windows Defender / antivirus:** confirmar que no pone en cuarentena el instalador ni la aplicación (no está firmado). Si lo hace, añadir una excepción para la carpeta de instalación.

## E. Lo que NO es esta demostración (decirlo antes de que lo pregunten)

* No está firmada con certificado de código (aparece el aviso de SmartScreen) y no se actualiza sola.
* No incluye datos reales ni datos comerciales inventados de Estética Leal (logotipo, dirección, teléfono, RFC): el icono "EL" es provisional y esos datos los define el dueño en *Configuración*.
* La impresión real, el lector y la terminal bancaria no se han probado con equipo físico.
* No es la distribución comercial: faltan decisiones de producto pendientes (ver `docs/STATUS.md`).
