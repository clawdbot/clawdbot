[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$commit = '1111111111111111111111111111111111111111'
$packageVersion = '2026.8.1'
$msixVersion = '2026.8.1.0'
$repository = 'https://github.com/openclaw/openclaw'
$publisher = 'CN=OpenClaw Foundation, O=OpenClaw Foundation, L=Mill Valley, S=California, C=US'
$testRoot = Join-Path $env:TEMP "openclaw-msix-signing-$([guid]::NewGuid().ToString('N'))"

function Assert-Fails {
    param(
        [Parameter(Mandatory)]
        [scriptblock]$Action,

        [Parameter(Mandatory)]
        [string]$MessagePattern
    )

    try {
        & $Action
    }
    catch {
        if ($_.Exception.Message -notmatch $MessagePattern) {
            throw "Expected '$MessagePattern'; received: $($_.Exception.Message)"
        }
        return
    }
    throw "Expected failure matching '$MessagePattern'."
}

function New-TestArtifact {
    param(
        [Parameter(Mandatory)]
        [ValidateSet('x64', 'arm64')]
        [string]$Architecture,

        [string]$ResolvedCommit = $commit,

        [string]$PackageName = 'OpenClaw.Gateway'
    )

    $directory = Join-Path $testRoot $Architecture
    $staging = Join-Path $testRoot ".$Architecture-package"
    $payloadDirectory = Join-Path $staging 'payload'
    New-Item -Path $directory, $payloadDirectory -ItemType Directory -Force |
        Out-Null

    $archiveName = "app-$Architecture.tar.gz"
    $archivePath = Join-Path $payloadDirectory $archiveName
    [IO.File]::WriteAllText($archivePath, "payload-$Architecture")
    $payloadHash = (
        Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    [ordered]@{
        repository = $repository
        requestedRef = $ResolvedCommit
        resolvedCommit = $ResolvedCommit
        packageVersion = $packageVersion
        architecture = $Architecture
        archive = $archiveName
        sha256 = $payloadHash
    } | ConvertTo-Json |
        Set-Content `
            -LiteralPath (Join-Path $payloadDirectory 'payload-metadata.json') `
            -Encoding utf8

    @"
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">
  <Identity Name="$PackageName"
            Publisher="$publisher"
            Version="$msixVersion"
            ProcessorArchitecture="$Architecture" />
</Package>
"@ | Set-Content `
        -LiteralPath (Join-Path $staging 'AppxManifest.xml') `
        -Encoding utf8

    $msixName = "OpenClawGateway-$Architecture.msix"
    $msixPath = Join-Path $directory $msixName
    [IO.Compression.ZipFile]::CreateFromDirectory($staging, $msixPath)
    Remove-Item -LiteralPath $staging -Recurse -Force

    [ordered]@{
        packagingRepository = $repository
        packagingCommit = $commit
        sourceTreeDirty = $false
        payloadRepository = $repository
        payloadRequestedRef = $ResolvedCommit
        payloadResolvedCommit = $ResolvedCommit
        architecture = $Architecture
        archive = $msixName
        sha256 = (
            Get-FileHash -LiteralPath $msixPath -Algorithm SHA256
        ).Hash.ToLowerInvariant()
        signed = $false
        packageVersion = $msixVersion
        publisher = $publisher
    } | ConvertTo-Json |
        Set-Content `
            -LiteralPath (Join-Path $directory 'msix-metadata.json') `
            -Encoding utf8
}

function Invoke-Validation {
    & (Join-Path $PSScriptRoot 'Test-SigningInputs.ps1') `
        -ArtifactsDirectory $testRoot `
        -ReleaseTag "v$packageVersion" `
        -RepositoryCommit $commit `
        -PackageVersion $packageVersion
}

try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    New-Item -Path $testRoot -ItemType Directory | Out-Null
    New-TestArtifact -Architecture x64
    New-TestArtifact -Architecture arm64
    Invoke-Validation

    Assert-Fails -MessagePattern 'does not match' -Action {
        & (Join-Path $PSScriptRoot 'Test-SigningInputs.ps1') `
            -ArtifactsDirectory $testRoot `
            -ReleaseTag 'v2026.8.2' `
            -RepositoryCommit $commit `
            -PackageVersion $packageVersion
    }

    Remove-Item -LiteralPath $testRoot -Recurse -Force
    New-Item -Path $testRoot -ItemType Directory | Out-Null
    New-TestArtifact -Architecture x64
    New-TestArtifact -Architecture arm64 -ResolvedCommit ('2' * 40)
    Assert-Fails -MessagePattern 'not eligible' -Action { Invoke-Validation }

    Remove-Item -LiteralPath $testRoot -Recurse -Force
    New-Item -Path $testRoot -ItemType Directory | Out-Null
    New-TestArtifact -Architecture x64 -PackageName 'Contoso.Unrelated'
    New-TestArtifact -Architecture arm64
    Assert-Fails -MessagePattern 'manifest identity' -Action { Invoke-Validation }

    Assert-Fails -MessagePattern 'stable OpenClaw version' -Action {
        & (Join-Path $PSScriptRoot 'Resolve-MSIXVersion.ps1') `
            -PackageVersion '2026.8.1-beta.1'
    }

    Write-Host 'Gateway MSIX release signing tests passed.'
}
finally {
    Remove-Item -LiteralPath $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
