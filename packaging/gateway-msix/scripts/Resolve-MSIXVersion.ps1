[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$PackageVersion
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($PackageVersion -notmatch '^([0-9]{4})\.([0-9]+)\.([0-9]+)$') {
    throw "Official Gateway MSIX signing requires a stable OpenClaw version: $PackageVersion"
}

$components = @(
    [int]$Matches[1],
    [int]$Matches[2],
    [int]$Matches[3],
    0
)
if ($components | Where-Object { $_ -lt 0 -or $_ -gt 65535 }) {
    throw "OpenClaw version cannot be represented as an MSIX version: $PackageVersion"
}

$components -join '.'
