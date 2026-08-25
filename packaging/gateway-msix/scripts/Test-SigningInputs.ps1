[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$ArtifactsDirectory,

    [Parameter(Mandatory)]
    [ValidatePattern('^v[0-9]{4}\.[0-9]+\.[0-9]+$')]
    [string]$ReleaseTag,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9a-fA-F]{40}$')]
    [string]$RepositoryCommit,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9]{4}\.[0-9]+\.[0-9]+$')]
    [string]$PackageVersion
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$repository = 'https://github.com/openclaw/openclaw'
$publisher = 'CN=OpenClaw Foundation, O=OpenClaw Foundation, L=Mill Valley, S=California, C=US'
$expectedCommit = $RepositoryCommit.ToLowerInvariant()
$expectedMsixVersion = & (Join-Path $PSScriptRoot 'Resolve-MSIXVersion.ps1') `
    -PackageVersion $PackageVersion

if ($ReleaseTag -ne "v$PackageVersion") {
    throw "Release tag $ReleaseTag does not match OpenClaw version $PackageVersion."
}

function Read-ZipEntryText {
    param(
        [Parameter(Mandatory)]
        [IO.Compression.ZipArchive]$Archive,

        [Parameter(Mandatory)]
        [string]$Path
    )

    $entries = @($Archive.Entries | Where-Object FullName -eq $Path)
    if ($entries.Count -ne 1) {
        throw "Expected one '$Path' entry; found $($entries.Count)."
    }

    $stream = $entries[0].Open()
    $reader = [IO.StreamReader]::new($stream)
    try {
        $reader.ReadToEnd()
    }
    finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Get-ZipEntrySha256 {
    param(
        [Parameter(Mandatory)]
        [IO.Compression.ZipArchive]$Archive,

        [Parameter(Mandatory)]
        [string]$Path
    )

    $entries = @($Archive.Entries | Where-Object FullName -eq $Path)
    if ($entries.Count -ne 1) {
        throw "Expected one '$Path' entry; found $($entries.Count)."
    }

    $stream = $entries[0].Open()
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        [Convert]::ToHexString($sha256.ComputeHash($stream)).ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

$resolvedArtifactsDirectory = (Resolve-Path -LiteralPath $ArtifactsDirectory).Path
foreach ($architecture in @('x64', 'arm64')) {
    $directory = Join-Path $resolvedArtifactsDirectory $architecture
    $metadataPath = Join-Path $directory 'msix-metadata.json'
    if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
        throw "Missing $architecture MSIX metadata: $metadataPath"
    }

    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    $msixFiles = @(Get-ChildItem -LiteralPath $directory -Filter '*.msix' -File)
    if ($msixFiles.Count -ne 1) {
        throw "Expected one unsigned $architecture MSIX; found $($msixFiles.Count)."
    }

    $msix = $msixFiles[0]
    if (
        $metadata.packagingRepository -ne $repository -or
        $metadata.packagingCommit -ine $expectedCommit -or
        $metadata.sourceTreeDirty -ne $false -or
        $metadata.payloadRepository -ne $repository -or
        $metadata.payloadRequestedRef -ine $expectedCommit -or
        $metadata.payloadResolvedCommit -ine $expectedCommit -or
        $metadata.architecture -ne $architecture -or
        $metadata.archive -ne $msix.Name -or
        $metadata.packageVersion -ne $expectedMsixVersion -or
        $metadata.publisher -ne $publisher -or
        $metadata.signed -ne $false
    ) {
        throw "The $architecture MSIX metadata is not eligible for release signing."
    }

    $actualMsixHash = (
        Get-FileHash -LiteralPath $msix.FullName -Algorithm SHA256
    ).Hash.ToLowerInvariant()
    if ($actualMsixHash -ne ([string]$metadata.sha256).ToLowerInvariant()) {
        throw "The $architecture MSIX hash does not match its metadata."
    }

    $packageArchive = [IO.Compression.ZipFile]::OpenRead($msix.FullName)
    try {
        [xml]$manifest = Read-ZipEntryText `
            -Archive $packageArchive `
            -Path 'AppxManifest.xml'
        $identity = $manifest.SelectSingleNode(
            "/*[local-name()='Package']/*[local-name()='Identity']"
        )
        if (
            $null -eq $identity -or
            $identity.Name -ne 'OpenClaw.Gateway' -or
            $identity.Publisher -ne $publisher -or
            $identity.ProcessorArchitecture -ne $architecture -or
            $identity.Version -ne $expectedMsixVersion
        ) {
            throw "The $architecture MSIX manifest identity is unexpected."
        }

        $payloadMetadata = Read-ZipEntryText `
            -Archive $packageArchive `
            -Path 'payload/payload-metadata.json' |
            ConvertFrom-Json
        if (
            $payloadMetadata.repository -ne $repository -or
            $payloadMetadata.requestedRef -ine $expectedCommit -or
            $payloadMetadata.resolvedCommit -ine $expectedCommit -or
            $payloadMetadata.packageVersion -ne $PackageVersion -or
            $payloadMetadata.architecture -ne $architecture -or
            $payloadMetadata.archive -ne "app-$architecture.tar.gz"
        ) {
            throw "The embedded $architecture payload metadata is not release eligible."
        }

        $payloadHash = Get-ZipEntrySha256 `
            -Archive $packageArchive `
            -Path "payload/$($payloadMetadata.archive)"
        if ($payloadHash -ne ([string]$payloadMetadata.sha256).ToLowerInvariant()) {
            throw "The embedded $architecture payload hash is invalid."
        }
    }
    finally {
        $packageArchive.Dispose()
    }
}

Write-Host (
    "Authorized Gateway MSIX signing for $ReleaseTag at $expectedCommit " +
    "with package version $expectedMsixVersion."
)
