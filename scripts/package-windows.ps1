$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
$unpacked = Join-Path $repoRoot 'release/win-unpacked'
$bundle = Join-Path $unpacked 'resources/localis-bundle'
$model = Join-Path $bundle 'models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf'
$launcher = Join-Path $bundle 'localis-engine.exe'
$server = Join-Path $bundle 'localis-runtime/llama-server.exe'
$setupScript = Join-Path $PSScriptRoot 'localis-installer.iss'

foreach ($required in @($unpacked, $model, $launcher, $server, $setupScript)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf) -and -not (Test-Path -LiteralPath $required -PathType Container)) {
    throw "Required Windows packaging input is missing: $required"
  }
}
if ((Get-Item -LiteralPath $model).Length -lt 1GB) {
  throw 'The bundled LamV1.0 model is unexpectedly small; refusing to produce an incomplete installer.'
}

$iscc = [string]$env:ISCC_PATH
if (-not $iscc -or -not (Test-Path -LiteralPath $iscc -PathType Leaf)) {
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Inno Setup 6/ISCC.exe') }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6/ISCC.exe') }
  $command = Get-Command 'ISCC.exe' -ErrorAction SilentlyContinue
  if ($command) { $candidates += $command.Source }
  $iscc = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $iscc) {
  throw 'Inno Setup 6.6.0 or later is required to create the single-file installer. Install Inno Setup 6.7.3 or set ISCC_PATH to ISCC.exe.'
}

$versionText = [string](Get-Item -LiteralPath $iscc).VersionInfo.ProductVersion
if (-not $versionText) { $versionText = [string](Get-Item -LiteralPath $iscc).VersionInfo.FileVersion }
$match = [regex]::Match($versionText, '\d+\.\d+(?:\.\d+)?')
if (-not $match.Success -or ([version]$match.Value) -lt [version]'6.6.0') {
  throw "Inno Setup 6.6.0 or later is required for a single-file installer containing LamV1.0. Found: $versionText"
}

Write-Host "Packaging Localis $version with Inno Setup $($match.Value)."
Push-Location $PSScriptRoot
try {
  $versionDefine = "/DAppVersion=`"$version`""
  & $iscc $versionDefine 'localis-installer.iss'
  if ($LASTEXITCODE -ne 0) { throw "Inno Setup compilation failed with exit code $LASTEXITCODE." }
} finally {
  Pop-Location
}

$output = Join-Path $repoRoot "release/Localis-Setup-$version.exe"
if (-not (Test-Path -LiteralPath $output -PathType Leaf)) { throw "Inno Setup did not create the expected installer: $output" }
$installerBytes = (Get-Item -LiteralPath $output).Length
if ($installerBytes -ge 4GB) { throw 'The single-file installer reached the Windows executable size ceiling; reduce the bundled payload before release.' }

$manifestPath = Join-Path $bundle 'engine-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'Bundled engine manifest is missing.' }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$manifestModel = [string]$manifest.modelName
$manifestHash = [string]$manifest.modelSha256
if ($manifestModel -ne 'LamV1.0' -or [string]::IsNullOrWhiteSpace($manifestHash)) { throw 'Bundled model manifest is invalid.' }

# Free the unpacked copy before extracting the large self-contained installer in the smoke test.
Remove-Item -LiteralPath $unpacked -Recurse -Force
$temporaryRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
$smokeInstall = Join-Path $temporaryRoot "Localis-smoke-$PID"
try {
  $arguments = "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=`"$smokeInstall`""
  $installProcess = Start-Process -FilePath $output -ArgumentList $arguments -Wait -PassThru
  if ($installProcess.ExitCode -ne 0) { throw "Installer smoke test failed with exit code $($installProcess.ExitCode)." }
  $installedBundle = Join-Path $smokeInstall 'resources/localis-bundle'
  $installedFiles = @(
    (Join-Path $installedBundle 'localis-engine.exe'),
    (Join-Path $installedBundle 'localis-runtime/llama-server.exe'),
    (Join-Path $installedBundle 'engine-manifest.json'),
    (Join-Path $installedBundle 'models/Qwen3-4B-Instruct-2507-Q4_K_M.gguf')
  )
  foreach ($file in $installedFiles) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Installer smoke test did not find bundled asset: $file" }
  }
  $installedModel = (Get-FileHash -LiteralPath $installedFiles[3] -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installedModel -ne ([string]$manifest.modelSha256).ToLowerInvariant()) { throw 'Installed LamV1.0 model SHA-256 does not match the pinned manifest.' }
} finally {
  $uninstaller = Join-Path $smokeInstall 'unins000.exe'
  if (Test-Path -LiteralPath $uninstaller -PathType Leaf) {
    $uninstallProcess = Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART' -Wait -PassThru
    if ($uninstallProcess.ExitCode -ne 0) { Write-Warning "Installer smoke-test cleanup returned exit code $($uninstallProcess.ExitCode)." }
  }
  if (Test-Path -LiteralPath $smokeInstall) { Remove-Item -LiteralPath $smokeInstall -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host "Self-contained Windows installer built and installation-verified: $output ($([math]::Round($installerBytes / 1GB, 2)) GiB)."
