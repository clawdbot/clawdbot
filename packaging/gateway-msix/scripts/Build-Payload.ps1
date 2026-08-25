[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$PackageDirectory,

    [Parameter(Mandatory)]
    [ValidateSet('x64', 'arm64')]
    [string]$Architecture,

    [Parameter(Mandatory)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'

$package = @(Get-ChildItem -Path $PackageDirectory -Filter '*.tgz' -File)
if ($package.Count -ne 1) {
    throw "Expected exactly one .tgz package in '$PackageDirectory'; found $($package.Count)."
}

$sourceMetadataPath = Join-Path $PackageDirectory 'source.json'
if (-not (Test-Path $sourceMetadataPath -PathType Leaf)) {
    throw "Missing source metadata: $sourceMetadataPath"
}

$stagingDirectory = Join-Path $env:RUNNER_TEMP "openclaw-stage-$Architecture"
Remove-Item $stagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
New-Item $stagingDirectory -ItemType Directory | Out-Null
New-Item $OutputDirectory -ItemType Directory -Force | Out-Null

$previousArch = $env:npm_config_arch
$previousTargetArch = $env:npm_config_target_arch
try {
    $env:npm_config_arch = $Architecture
    $env:npm_config_target_arch = $Architecture

    & npm install `
        --install-strategy=nested `
        --omit=dev `
        --no-audit `
        --no-fund `
        --os=win32 `
        --cpu=$Architecture `
        --prefix $stagingDirectory `
        $package[0].FullName

    if ($LASTEXITCODE -ne 0) {
        throw "npm install failed with exit code $LASTEXITCODE."
    }
}
finally {
    $env:npm_config_arch = $previousArch
    $env:npm_config_target_arch = $previousTargetArch
}

$installedPackage = Join-Path $stagingDirectory 'node_modules\openclaw'
foreach ($requiredPath in @('package.json', 'openclaw.mjs', 'dist')) {
    $path = Join-Path $installedPackage $requiredPath
    if (-not (Test-Path $path)) {
        throw "Staged package is missing required path: $path"
    }
}

if ($Architecture -eq 'x64') {
    Push-Location $installedPackage
    try {
        & node .\openclaw.mjs --version
        if ($LASTEXITCODE -ne 0) {
            throw "OpenClaw payload smoke test failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

$archiveName = "app-$Architecture.tar.gz"
$archivePath = Join-Path $OutputDirectory $archiveName
Remove-Item $archivePath -Force -ErrorAction SilentlyContinue

& tar -czf $archivePath -C $installedPackage .
if ($LASTEXITCODE -ne 0) {
    throw "tar failed with exit code $LASTEXITCODE."
}

$hash = (Get-FileHash $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $archiveName" | Set-Content (Join-Path $OutputDirectory "$archiveName.sha256") -Encoding ascii

$sourceMetadata = Get-Content $sourceMetadataPath -Raw | ConvertFrom-Json
[ordered]@{
    repository       = $sourceMetadata.repository
    requestedRef     = $sourceMetadata.requestedRef
    resolvedCommit   = $sourceMetadata.resolvedCommit
    packageVersion   = $sourceMetadata.packageVersion
    architecture     = $Architecture
    archive          = $archiveName
    sha256           = $hash
    nodeVersion      = (& node --version)
    npmVersion       = (& npm --version)
} | ConvertTo-Json | Set-Content (Join-Path $OutputDirectory 'payload-metadata.json') -Encoding utf8

$size = (Get-Item $archivePath).Length / 1MB
Write-Host ("Created {0} ({1:N1} MiB)" -f $archivePath, $size)
