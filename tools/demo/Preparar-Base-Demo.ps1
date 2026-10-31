# Estetica Leal POS - Preparacion de la base de demostracion (Windows PowerShell 5.1+)
#
# Crea en el PostgreSQL LOCAL de esta laptop una base NUEVA con datos FICTICIOS, el usuario de la aplicacion (privilegios minimos)
# y dos usuarios de demostracion cuyos PIN eliges tu ahora. Nunca modifica una base existente.
# Usa el propio programa instalado como motor (no hace falta Node.js ni el repositorio).
#
# Uso normal: doble clic en Preparar-Base-Demo.cmd (esta carpeta). Para automatizar, define antes las variables POS_* (ver
# scripts/demo-setup.mjs) y POS_DEMO_NONINTERACTIVE=1: entonces no pregunta nada.
param([string]$Database = "")

$ErrorActionPreference = "Stop"
$interactive = $env:POS_DEMO_NONINTERACTIVE -ne "1"
$appDir = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$exe = Join-Path $appDir "Beauty POS.exe"
$tool = Join-Path $appDir "resources\app.asar\dist\tools\demo-setup.cjs"

function Fail([string]$msg) {
  Write-Host ""
  Write-Host "ERROR: $msg" -ForegroundColor Red
  if ($interactive) { [void](Read-Host "Presiona Enter para cerrar") }
  exit 1
}
function Read-Secret([string]$label) {
  $s = Read-Host -Prompt $label -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Read-Pin([string]$who) {
  while ($true) {
    $a = Read-Secret "PIN del $who (6 a 8 digitos)"
    if ($a -notmatch '^\d{6,8}$') { Write-Host "  El PIN debe tener de 6 a 8 digitos." -ForegroundColor Yellow; continue }
    $b = Read-Secret "Repite el PIN del $who"
    if ($a -ne $b) { Write-Host "  No coinciden. Intenta de nuevo." -ForegroundColor Yellow; continue }
    return $a
  }
}

Write-Host ""
Write-Host "== Estetica Leal POS - preparacion de la base de demostracion ==" -ForegroundColor Cyan
if (-not (Test-Path $exe)) { Fail "No encuentro 'Beauty POS.exe' junto a esta carpeta ($exe). Ejecuta este archivo desde la carpeta de la aplicacion instalada." }

$pgHost = if ($env:POS_PG_HOST) { $env:POS_PG_HOST } else { "localhost" }
$pgPort = if ($env:POS_PG_PORT) { [int]$env:POS_PG_PORT } else { 5432 }
$tcp = New-Object Net.Sockets.TcpClient
try {
  $iar = $tcp.BeginConnect($pgHost, $pgPort, $null, $null)
  if (-not $iar.AsyncWaitHandle.WaitOne(3000) -or -not $tcp.Connected) { throw "sin respuesta" }
} catch {
  Fail "PostgreSQL no responde en ${pgHost}:${pgPort}. Instalalo (docs\DEMO_INSTALL_LAPTOP.md, paso 1) o inicia su servicio (Servicios de Windows > postgresql-x64-NN) y vuelve a ejecutar esto."
} finally { $tcp.Close() }
Write-Host "PostgreSQL responde en ${pgHost}:${pgPort}." -ForegroundColor Green

if ($interactive) {
  Write-Host ""
  Write-Host "Se creara una base NUEVA (nunca se toca una existente). Contesta lo siguiente:"
  if (-not $env:POS_PG_ADMIN_PASSWORD) { $env:POS_PG_ADMIN_PASSWORD = Read-Secret "Contrasena del administrador de PostgreSQL (la que elegiste al instalarlo)" }
  if (-not $Database -and -not $env:POS_DEMO_DATABASE) {
    $d = Read-Host "Nombre de la base de demostracion [beauty_pos_demo]"
    if ($d) { $env:POS_DEMO_DATABASE = $d }
  }
  if (-not $env:POS_DEMO_ADMIN_PIN) { $env:POS_DEMO_ADMIN_PIN = Read-Pin "Administrador Demo" }
  while (-not $env:POS_DEMO_VENDOR_PIN -or $env:POS_DEMO_VENDOR_PIN -eq $env:POS_DEMO_ADMIN_PIN) {
    $env:POS_DEMO_VENDOR_PIN = Read-Pin "Vendedor Demo (distinto al del administrador)"
  }
  if (-not $env:POS_DEMO_RUNTIME_PASSWORD) {
    $rp = Read-Secret "Contrasena para el usuario de la aplicacion (Enter = generar una segura)"
    if ($rp) { $env:POS_DEMO_RUNTIME_PASSWORD = $rp }
  }
}
if ($Database) { $env:POS_DEMO_DATABASE = $Database }

Write-Host ""
$env:ELECTRON_RUN_AS_NODE = "1"
try {
  & $exe $tool 2>&1 | ForEach-Object { Write-Host $_ }
  $code = $LASTEXITCODE
} finally {
  # nothing secret stays in this window's environment
  foreach ($n in "ELECTRON_RUN_AS_NODE", "POS_PG_ADMIN_PASSWORD", "POS_DEMO_ADMIN_PIN", "POS_DEMO_VENDOR_PIN", "POS_DEMO_RUNTIME_PASSWORD") { Remove-Item "Env:$n" -ErrorAction SilentlyContinue }
}
if ($code -ne 0) { Fail "La preparacion no termino (codigo $code). Lee el mensaje de arriba; no quedo nada a medias." }
Write-Host ""
if ($interactive) { [void](Read-Host "Listo. Presiona Enter para cerrar esta ventana") }
exit 0
