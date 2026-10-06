$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = Split-Path -Parent $PSScriptRoot
$assetRoot = Join-Path $repoRoot 'release-assets'
$runtimeDir = Join-Path $assetRoot 'localis-runtime'
$modelDir = Join-Path $assetRoot 'models'
$tempRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'localis-engine-build'
$serverZip = Join-Path $tempRoot 'llama-server.zip'
$cudaZip = Join-Path $tempRoot 'llama-cuda-runtime.zip'
$modelFile = Join-Path $modelDir 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'

$llamaRelease = 'b11438'
$serverUrl = "https://github.com/ggml-org/llama.cpp/releases/download/$llamaRelease/llama-b11438-bin-win-cuda-13.4-x64.zip"
$serverSha256 = 'f05da20ea7d7cd07166d5bb08fc0319a156a0f439ab5da64b51f1a19818beb3b'
$cudaUrl = 'https://github.com/ggml-org/llama.cpp/releases/download/b11438/cudart-llama-bin-win-cuda-13.4-x64.zip'
$cudaSha256 = '738f8c251ac22b70c3ae6f83a10cf222725df0395246a2cf58f32bdb85fbe668'
$modelRevision = '18727206c51467496bfba014368bd0a30e97f411'
$modelUrl = "https://huggingface.co/unsloth/Qwen3-4B-Instruct-2507-GGUF/resolve/$modelRevision/Qwen3-4B-Instruct-2507-Q4_K_M.gguf?download=true"
$modelSha256 = '3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597'

function Invoke-VerifiedDownload([string] $Url, [string] $Destination, [string] $ExpectedSha256) {
  Write-Host "Downloading $Url"
  & curl.exe --fail --location --retry 4 --retry-all-errors --connect-timeout 30 --output $Destination $Url
  if ($LASTEXITCODE -ne 0) { throw "Download failed with curl exit code $LASTEXITCODE: $Url" }
  $actual = (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
    throw "SHA-256 mismatch for $Destination. Expected $ExpectedSha256, got $actual."
  }
  Write-Host "SHA-256 verified: $actual"
}

New-Item -ItemType Directory -Force -Path $tempRoot, $runtimeDir, $modelDir | Out-Null
Remove-Item -LiteralPath $runtimeDir -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null

Invoke-VerifiedDownload $serverUrl $serverZip $serverSha256
Invoke-VerifiedDownload $cudaUrl $cudaZip $cudaSha256
Invoke-VerifiedDownload $modelUrl $modelFile $modelSha256

$serverExtract = Join-Path $tempRoot 'server-extract'
$cudaExtract = Join-Path $tempRoot 'cuda-extract'
Remove-Item -LiteralPath $serverExtract, $cudaExtract -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $serverZip -DestinationPath $serverExtract -Force
Expand-Archive -LiteralPath $cudaZip -DestinationPath $cudaExtract -Force

$serverExecutable = Get-ChildItem -LiteralPath $serverExtract -Filter 'llama-server.exe' -File -Recurse | Select-Object -First 1
if (-not $serverExecutable) { throw 'Pinned llama.cpp archive did not contain llama-server.exe.' }
Get-ChildItem -LiteralPath $serverExecutable.Directory.FullName -Force | Copy-Item -Destination $runtimeDir -Recurse -Force
Get-ChildItem -LiteralPath $cudaExtract -Force | Copy-Item -Destination $runtimeDir -Recurse -Force
if (-not (Test-Path (Join-Path $runtimeDir 'llama-server.exe'))) {
  throw 'Could not stage llama-server.exe and its runtime files.'
}

$nativeBuild = Join-Path $tempRoot 'native-build'
cmake -S (Join-Path $repoRoot 'native/localis-engine') -B $nativeBuild -A x64
if ($LASTEXITCODE -ne 0) { throw 'CMake configuration for the Localis C++ engine failed.' }
cmake --build $nativeBuild --config Release --parallel 2
if ($LASTEXITCODE -ne 0) { throw 'C++ engine compilation failed.' }
$engineExecutable = Join-Path $nativeBuild 'Release/localis-engine.exe'
if (-not (Test-Path $engineExecutable)) { throw 'C++ engine executable was not produced.' }
Copy-Item -LiteralPath $engineExecutable -Destination (Join-Path $assetRoot 'localis-engine.exe') -Force

$licenseUrl = "https://huggingface.co/Qwen/Qwen3-4B-Instruct-2507/resolve/1b4199c4f36b0cef378bfb12390c18780c18af4c/LICENSE"
Invoke-WebRequest -Uri $licenseUrl -OutFile (Join-Path $modelDir 'LICENSE-Qwen3.txt') -MaximumRedirection 10
@{
  modelName = 'LamV1.0'
  engine = 'Localis C++ hardware-aware launcher + llama.cpp CUDA backend'
  llamaCppRelease = $llamaRelease
  llamaServerSha256 = $serverSha256
  cudaRuntimeSha256 = $cudaSha256
  model = 'Qwen3-4B-Instruct-2507 Q4_K_M'
  modelRepository = 'unsloth/Qwen3-4B-Instruct-2507-GGUF'
  modelRevision = $modelRevision
  modelFile = [System.IO.Path]::GetFileName($modelFile)
  modelSha256 = $modelSha256
  modelLicense = 'Apache-2.0; see LICENSE-Qwen3.txt'
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $assetRoot 'engine-manifest.json') -Encoding utf8

Remove-Item -LiteralPath $serverZip, $cudaZip, $serverExtract, $cudaExtract -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'Verified Localis C++ engine, CUDA runtime and Qwen3 model are ready for packaging.'
