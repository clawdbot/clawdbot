[CmdletBinding()]
param(
    [ValidateSet('x64', 'arm64')]
    [string]$Architecture = 'x64',

    [string]$PayloadDirectory,

    [long]$PayloadRunId,

    [string]$PackageVersion,

    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path $PSScriptRoot -Parent
$repository = 'openclaw/openclaw-windows-node'

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory)]
        [scriptblock]$Command,

        [Parameter(Mandatory)]
        [string]$FailureMessage
    )

    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$FailureMessage Exit code: $LASTEXITCODE."
    }
}

if (-not $PackageVersion) {
    $now = Get-Date
    $days = [int]($now.Date - [datetime]'2020-01-01').TotalDays
    $timeComponent = (($now.Hour * 3600) + ($now.Minute * 60) + $now.Second) %
        65536
    $PackageVersion = "0.1.$days.$timeComponent"
}

if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path `
        $repositoryRoot `
        "artifacts\local-msix\$Architecture\$PackageVersion"
}
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$workDirectory = Join-Path $OutputDirectory 'work'

if (Test-Path -LiteralPath $OutputDirectory) {
    throw (
        "The local output directory already exists: $OutputDirectory. " +
        'Choose another -PackageVersion or -OutputDirectory.'
    )
}
New-Item -Path $workDirectory -ItemType Directory -Force | Out-Null

if ($PayloadDirectory) {
    $resolvedPayloadDirectory = (Resolve-Path -LiteralPath $PayloadDirectory).Path
}
else {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($null -eq $gh) {
        throw 'GitHub CLI (gh) is required when -PayloadDirectory is omitted.'
    }

    if ($PayloadRunId -eq 0) {
        $runJson = & gh run list `
            --repo $repository `
            --workflow gateway-msix.yml `
            --branch main `
            --status success `
            --limit 1 `
            --json databaseId
        if ($LASTEXITCODE -ne 0) {
            throw 'Unable to query the latest successful payload workflow.'
        }

        $runs = @($runJson | ConvertFrom-Json)
        if ($runs.Count -ne 1) {
            throw 'No successful payload workflow was found.'
        }
        $PayloadRunId = $runs[0].databaseId
    }

    $resolvedPayloadDirectory = Join-Path $workDirectory 'payload'
    New-Item -Path $resolvedPayloadDirectory -ItemType Directory -Force |
        Out-Null
    Write-Host (
        "Downloading openclaw-gateway-payload-$Architecture from workflow $PayloadRunId."
    )
    Invoke-CheckedCommand `
        -FailureMessage 'Unable to download the payload artifact.' `
        -Command {
            & gh run download $PayloadRunId `
                --repo $repository `
                --name "openclaw-gateway-payload-$Architecture" `
                --dir $resolvedPayloadDirectory
        }
}

$payloadArchive = Join-Path `
    $resolvedPayloadDirectory `
    "app-$Architecture.tar.gz"
$payloadMetadata = Join-Path $resolvedPayloadDirectory 'payload-metadata.json'
foreach ($requiredPath in @($payloadArchive, $payloadMetadata)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required payload input was not found: $requiredPath"
    }
}

Push-Location $repositoryRoot
try {
    Write-Host 'Restoring locked .NET dependencies.'
    Invoke-CheckedCommand `
        -FailureMessage 'Locked dependency restore failed.' `
        -Command {
            & dotnet restore `
                .\src\OpenClaw.Gateway.MSIXHost\OpenClaw.Gateway.MSIXHost.csproj `
                --runtime "win-$Architecture" `
                -p:PublishAot=true `
                -p:IncludePackagingContent=true `
                "-p:Platform=$Architecture"
        }

    $sourceCommit = (& git rev-parse HEAD) -join ''
    if ($LASTEXITCODE -ne 0 -or
        $sourceCommit -notmatch '^[0-9a-fA-F]{40}$') {
        throw 'Unable to resolve the current source commit.'
    }
    $sourceTreeDirty = [bool](& git status --porcelain)
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to inspect the current source tree.'
    }

    Write-Host "Building unsigned MSIX version $PackageVersion."
    & .\scripts\Build-MSIX.ps1 `
        -PayloadDirectory $resolvedPayloadDirectory `
        -Architecture $Architecture `
        -NodeVersion 24.16.0 `
        -PackageVersion $PackageVersion `
        -SourceCommit $sourceCommit `
        -SourceTreeDirty:$sourceTreeDirty `
        -OutputDirectory $OutputDirectory

    $msixPath = Join-Path $OutputDirectory "OpenClawGateway-$Architecture.msix"
    Remove-Item -LiteralPath $workDirectory -Recurse -Force
    Write-Host ''
    Write-Host "Local MSIX is ready: $msixPath"
    Write-Host (
        'Sign the package before installing it with Add-AppxPackage.'
    )
}
finally {
    Pop-Location
}
