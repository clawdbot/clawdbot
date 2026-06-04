# OpenClaw Installer for Windows
# Usage: powershell -c "irm https://openclaw.ai/install.ps1 | iex"
#        powershell -c "& ([scriptblock]::Create((irm https://openclaw.ai/install.ps1))) -Tag beta -NoOnboard -DryRun"

param(
    [string]$Tag = "latest",
    [ValidateSet("npm", "git")]
    [string]$InstallMethod = "npm",
    [string]$GitDir,
    [switch]$NoOnboard,
    [switch]$NoGitUpdate,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

$script:InstallExitCode = 0

function Fail-Install {
    param([int]$Code = 1)

    $script:InstallExitCode = $Code
    return $false
}

function Test-BooleanSuccessResult {
    param([object[]]$Results)

    return ($Results.Count -gt 0 -and $Results[-1] -eq $true)
}

function Remove-MatchingQuotes {
    param([string]$Value)

    if ([string]::IsNullOrEmpty($Value) -or $Value.Length -lt 2) {
        return $Value
    }

    $first = $Value[0]
    $last = $Value[$Value.Length - 1]
    if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
        return $Value.Substring(1, $Value.Length - 2)
    }
    return $Value
}

function Resolve-NodeOptionsWithMinOldSpace {
    param(
        [string]$NodeOptions,
        [int]$MinOldSpaceMb = 8192
    )

    $parts = @($NodeOptions -split '\s+' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    $resolved = New-Object System.Collections.Generic.List[string]
    $foundOldSpace = $false
    for ($index = 0; $index -lt $parts.Count; $index++) {
        $part = $parts[$index]
        $normalizedPart = Remove-MatchingQuotes -Value $part
        if ($normalizedPart -match '^--max[-_]old[-_]space[-_]size=(?<value>.+)$') {
            $parsed = 0
            $parsedValue = Remove-MatchingQuotes -Value $Matches["value"]
            if (-not [int]::TryParse($parsedValue, [ref]$parsed)) {
                $parsed = $MinOldSpaceMb
            }
            $foundOldSpace = $true
            $value = [Math]::Max($parsed, $MinOldSpaceMb)
            $resolved.Add("--max-old-space-size=$value")
            continue
        }
        if ($normalizedPart -match '^--max[-_]old[-_]space[-_]size$') {
            $foundOldSpace = $true
            $next = if ($index + 1 -lt $parts.Count) { $parts[$index + 1] } else { $null }
            $parsed = 0
            $parsedNext = Remove-MatchingQuotes -Value $next
            if (-not [int]::TryParse($parsedNext, [ref]$parsed)) {
                $parsed = $MinOldSpaceMb
            }
            $value = [Math]::Max($parsed, $MinOldSpaceMb)
            $resolved.Add("--max-old-space-size=$value")
            if ($next) {
                $index += 1
            }
            continue
        }
        $resolved.Add($part)
    }
    if (-not $foundOldSpace) {
        $resolved.Add("--max-old-space-size=$MinOldSpaceMb")
    }
    return ($resolved -join " ")
}

function Complete-Install {
    param([bool]$Succeeded)

    if ($Succeeded) {
        return
    }

    if ($PSCommandPath) {
        exit $script:InstallExitCode
    }

    throw "OpenClaw installation failed with exit code $($script:InstallExitCode)."
}

Write-Host ""
Write-Host "  OpenClaw Installer" -ForegroundColor Cyan
Write-Host ""

# Check if running in PowerShell
if ($PSVersionTable.PSVersion.Major -lt 5) {
    Write-Host "Error: PowerShell 5+ required" -ForegroundColor Red
    Complete-Install -Succeeded:$false
    return
}

Write-Host "[OK] Windows detected" -ForegroundColor Green

if (-not $PSBoundParameters.ContainsKey("InstallMethod")) {
    if (-not [string]::IsNullOrWhiteSpace($env:OPENCLAW_INSTALL_METHOD)) {
        $InstallMethod = $env:OPENCLAW_INSTALL_METHOD
    }
}
if (-not $PSBoundParameters.ContainsKey("GitDir")) {
    if (-not [string]::IsNullOrWhiteSpace($env:OPENCLAW_GIT_DIR)) {
        $GitDir = $env:OPENCLAW_GIT_DIR
    }
}
if (-not $PSBoundParameters.ContainsKey("NoOnboard")) {
    if ($env:OPENCLAW_NO_ONBOARD -eq "1") {
        $NoOnboard = $true
    }
}
if (-not $PSBoundParameters.ContainsKey("NoGitUpdate")) {
    if ($env:OPENCLAW_GIT_UPDATE -eq "0") {
        $NoGitUpdate = $true
    }
}
if (-not $PSBoundParameters.ContainsKey("DryRun")) {
    if ($env:OPENCLAW_DRY_RUN -eq "1") {
        $DryRun = $true
    }
}

if ([string]::IsNullOrWhiteSpace($GitDir)) {
    $userHome = [Environment]::GetFolderPath("UserProfile")
    $GitDir = (Join-Path $userHome "openclaw")
}

# Check for Node.js
function Check-Node {
    try {
        $nodeVersion = (node -v 2>$null)
        if ($nodeVersion) {
            $versionMatch = [regex]::Match($nodeVersion, '^v(?<major>\d+)\.(?<minor>\d+)\.')
            $major = if ($versionMatch.Success) { [int]$versionMatch.Groups["major"].Value } else { 0 }
            $minor = if ($versionMatch.Success) { [int]$versionMatch.Groups["minor"].Value } else { 0 }
            if (($major -gt 22) -or (($major -eq 22) -and ($minor -ge 19))) {
                Write-Host "[OK] Node.js $nodeVersion found" -ForegroundColor Green
                return $true
            } else {
                Write-Host "[!] Node.js $nodeVersion found, but v22.19+ required" -ForegroundColor Yellow
                return $false
            }
        }
    } catch {
        Write-Host "[!] Node.js not found" -ForegroundColor Yellow
        return $false
    }
    return $false
}

function Get-WindowsNodeArchitecture {
    foreach ($architecture in @($env:PROCESSOR_ARCHITEW6432, $env:PROCESSOR_ARCHITECTURE)) {
        if ($architecture -match "ARM64") {
            return "arm64"
        }
    }
    return "x64"
}

function Get-OpenClawDepsRoot {
    $localAppData = $env:LOCALAPPDATA
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        $localAppData = [Environment]::GetFolderPath("LocalApplicationData")
    }
    if ([string]::IsNullOrWhiteSpace($localAppData)) {
        $localAppData = Join-Path ([Environment]::GetFolderPath("UserProfile")) "AppData\Local"
    }
    return (Join-Path $localAppData "OpenClaw\deps")
}

function Get-PortableNodeRoot {
    return (Join-Path (Get-OpenClawDepsRoot) "portable-node")
}

function Get-PortableNodeCommandPath {
    $root = Get-PortableNodeRoot
    $candidate = Join-Path $root "node.exe"
    if (Test-Path $candidate) {
        return $candidate
    }
    return $null
}

function Use-PortableNodeIfPresent {
    $nodeExe = Get-PortableNodeCommandPath
    if (-not $nodeExe) {
        return $false
    }

    Add-ToProcessPath (Split-Path -Parent $nodeExe)
    return (Check-Node)
}

function Ensure-PortableNodeOnUserPath {
    $nodeExe = Get-PortableNodeCommandPath
    if (-not $nodeExe) {
        return
    }

    $nodeDir = Split-Path -Parent $nodeExe
    if (Add-ToUserPath $nodeDir) {
        Write-Host "[!] Added $nodeDir to user PATH (restart terminal if node or openclaw is not found)" -ForegroundColor Yellow
    }
}

function Resolve-PortableNodeDownload {
    $architecture = Get-WindowsNodeArchitecture
    $index = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json"
    $release = $index |
        Where-Object { $_.version -match '^v24\.' } |
        Select-Object -First 1

    if (-not $release -or -not $release.version) {
        throw "Could not resolve latest Node.js 24 release metadata."
    }

    $fileKey = "win-$architecture-zip"
    if ($release.files -and -not ($release.files -contains $fileKey)) {
        throw "Node.js $($release.version) does not publish $fileKey."
    }

    $name = "node-$($release.version)-win-$architecture.zip"
    return @{
        Version = $release.version
        Name = $name
        Url = "https://nodejs.org/dist/$($release.version)/$name"
    }
}

function Expand-PortableNodeArchive {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ZipPath,
        [Parameter(Mandatory = $true)]
        [string]$DestinationPath
    )

    $tarCommand = Get-Command tar -ErrorAction SilentlyContinue
    if ($tarCommand -and $tarCommand.Source) {
        New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null
        & $tarCommand.Source -xf $ZipPath -C $DestinationPath --strip-components 1
        if ($LASTEXITCODE -eq 0) {
            return
        }

        $tarExitCode = $LASTEXITCODE
        if (Test-Path $DestinationPath) {
            Remove-Item -Recurse -Force $DestinationPath
        }
        Write-Host "[!] tar extraction failed with exit code $tarExitCode; trying .NET zip extraction." -ForegroundColor Yellow
    }

    $fallbackExtract = Join-Path (Split-Path -Parent $DestinationPath) ("portable-node-extract-" + [guid]::NewGuid().ToString("N"))
    try {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        [System.IO.Compression.ZipFile]::ExtractToDirectory($ZipPath, $fallbackExtract)

        $nodeDir = Get-ChildItem -Path $fallbackExtract -Directory |
            Where-Object { Test-Path (Join-Path $_.FullName "node.exe") } |
            Select-Object -First 1
        if (-not $nodeDir) {
            throw "Node.js archive did not contain node.exe."
        }
        Copy-Item -LiteralPath $nodeDir.FullName -Destination $DestinationPath -Recurse -Force
    } finally {
        if (Test-Path $fallbackExtract) {
            Remove-Item -Recurse -Force $fallbackExtract
        }
    }
}

function Install-PortableNode {
    if (Use-PortableNodeIfPresent) {
        Ensure-PortableNodeOnUserPath
        $nodeVersion = (& node -v 2>$null)
        if ($nodeVersion) {
            Write-Host "[OK] User-local Node.js already available: $nodeVersion" -ForegroundColor Green
        }
        return
    }

    Write-Host "  No package manager found; bootstrapping user-local portable Node.js..." -ForegroundColor Gray

    $download = Resolve-PortableNodeDownload
    $portableRoot = Get-PortableNodeRoot
    $portableParent = Split-Path -Parent $portableRoot
    $tmpZip = Join-Path $env:TEMP $download.Name

    New-Item -ItemType Directory -Force -Path $portableParent | Out-Null
    if (Test-Path $portableRoot) {
        Remove-Item -Recurse -Force $portableRoot
    }

    try {
        Write-Host "  Downloading Node.js $($download.Version)..." -ForegroundColor Gray
        Invoke-WebRequest -UseBasicParsing -Uri $download.Url -OutFile $tmpZip
        Expand-PortableNodeArchive -ZipPath $tmpZip -DestinationPath $portableRoot
    } finally {
        if (Test-Path $tmpZip) {
            Remove-Item -Force $tmpZip
        }
    }

    if (-not (Use-PortableNodeIfPresent)) {
        throw "Portable Node.js bootstrap completed, but node is still unavailable."
    }
    Ensure-PortableNodeOnUserPath

    $nodeVersion = (& node -v 2>$null)
    Write-Host "[OK] User-local Node.js ready: $nodeVersion" -ForegroundColor Green
}

# Install Node.js
function Install-Node {
    Write-Host "[*] Installing Node.js..." -ForegroundColor Yellow

    # Try winget first (Windows 11 / Windows 10 with App Installer)
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "  Using winget..." -ForegroundColor Gray
        winget install OpenJS.NodeJS.LTS --source winget --accept-package-agreements --accept-source-agreements

        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        if (Check-Node) {
            Write-Host "[OK] Node.js installed via winget" -ForegroundColor Green
            return $true
        }
        Write-Host "[!] winget completed, but Node.js is still unavailable in this shell" -ForegroundColor Yellow
        Write-Host "Restart PowerShell and re-run the installer if Node.js was installed successfully." -ForegroundColor Yellow
        return $false
    }

    # Try Chocolatey
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Host "  Using Chocolatey..." -ForegroundColor Gray
        choco install nodejs-lts -y

        # Refresh PATH
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
        Write-Host "[OK] Node.js installed via Chocolatey" -ForegroundColor Green
        return $true
    }

    # Try Scoop
    if (Get-Command scoop -ErrorAction SilentlyContinue) {
        Write-Host "  Using Scoop..." -ForegroundColor Gray
        scoop install nodejs-lts
        Write-Host "[OK] Node.js installed via Scoop" -ForegroundColor Green
        return $true
    }

    try {
        Install-PortableNode
        if (Check-Node) {
            return $true
        }
    } catch {
        Write-Host "[!] Portable Node.js bootstrap failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    # Manual download fallback
    Write-Host ""
    Write-Host "Error: Could not install Node.js automatically." -ForegroundColor Red
    Write-Host ""
    Write-Host "Please install Node.js 22+ manually:" -ForegroundColor Yellow
    Write-Host "  https://nodejs.org/en/download/" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "Or install winget (App Installer) from the Microsoft Store." -ForegroundColor Gray
    return $false
}

# Check for existing OpenClaw installation
function Check-ExistingOpenClaw {
    if (Get-OpenClawCommandPath) {
        Write-Host "[*] Existing OpenClaw installation detected" -ForegroundColor Yellow
        return $true
    }
    return $false
}

function Check-Git {
    try {
        $null = Get-Command git -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Add-ToProcessPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PathEntry
    )

    if ([string]::IsNullOrWhiteSpace($PathEntry)) {
        return
    }

    $currentEntries = @($env:Path -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($currentEntries | Where-Object { $_ -ieq $PathEntry }) {
        return
    }

    $env:Path = "$PathEntry;$env:Path"
}

function Add-ToUserPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$PathEntry
    )

    if ([string]::IsNullOrWhiteSpace($PathEntry)) {
        return $false
    }

    Add-ToProcessPath $PathEntry

    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    $userEntries = @($userPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    if ($userEntries | Where-Object { $_ -ieq $PathEntry }) {
        return $false
    }

    $newUserPath = if ([string]::IsNullOrWhiteSpace($userPath)) {
        $PathEntry
    } else {
        "$userPath;$PathEntry"
    }
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    return $true
}

function Get-PortableGitRoot {
    return (Join-Path (Get-OpenClawDepsRoot) "portable-git")
}

function Get-PortableGitCommandPath {
    $root = Get-PortableGitRoot
    foreach ($candidate in @(
        (Join-Path $root "mingw64\bin\git.exe"),
        (Join-Path $root "cmd\git.exe"),
        (Join-Path $root "bin\git.exe"),
        (Join-Path $root "git.exe")
    )) {
        if (Test-Path $candidate) {
            return $candidate
        }
    }
    return $null
}

function Use-PortableGitIfPresent {
    $gitExe = Get-PortableGitCommandPath
    if (-not $gitExe) {
        return $false
    }

    foreach ($pathEntry in (Get-PortableGitPathEntries)) {
        Add-ToProcessPath $pathEntry
    }
    if (Check-Git) {
        return $true
    }
    return $false
}

function Get-PortableGitPathEntries {
    $gitExe = Get-PortableGitCommandPath
    if (-not $gitExe) {
        return @()
    }

    $portableRoot = Get-PortableGitRoot
    $pathEntries = @(
        (Join-Path $portableRoot "mingw64\bin"),
        (Join-Path $portableRoot "usr\bin"),
        (Split-Path -Parent $gitExe)
    )
    return ($pathEntries | Where-Object { Test-Path $_ } | Select-Object -Unique)
}

function Ensure-PortableGitOnUserPath {
    $added = @()
    foreach ($pathEntry in (Get-PortableGitPathEntries)) {
        if (Add-ToUserPath $pathEntry) {
            $added += $pathEntry
        }
    }

    if ($added.Count -gt 0) {
        Write-Host "[!] Added user-local Git to user PATH (restart terminal if git or git-backed updates are not found)" -ForegroundColor Yellow
    }
}

function Resolve-PortableGitDownload {
    $releaseApi = "https://api.github.com/repos/git-for-windows/git/releases/latest"
    $headers = @{
        "User-Agent" = "openclaw-installer"
        "Accept" = "application/vnd.github+json"
    }
    $release = Invoke-RestMethod -Uri $releaseApi -Headers $headers
    if (-not $release -or -not $release.assets) {
        throw "Could not resolve latest git-for-windows release metadata."
    }

    $asset = $release.assets |
        Where-Object { $_.name -match '^MinGit-.*-64-bit\.zip$' -and $_.name -notmatch 'busybox' } |
        Select-Object -First 1

    if (-not $asset) {
        throw "Could not find a MinGit zip asset in the latest git-for-windows release."
    }

    return @{
        Tag = $release.tag_name
        Name = $asset.name
        Url = $asset.browser_download_url
    }
}

function Install-PortableGit {
    if (Use-PortableGitIfPresent) {
        Ensure-PortableGitOnUserPath
        $portableVersion = (& git --version 2>$null)
        if ($portableVersion) {
            Write-Host "[OK] User-local Git already available: $portableVersion" -ForegroundColor Green
        }
        return
    }

    Write-Host "[*] Git not found; bootstrapping user-local portable Git..." -ForegroundColor Yellow

    $download = Resolve-PortableGitDownload
    $portableRoot = Get-PortableGitRoot
    $portableParent = Split-Path -Parent $portableRoot
    $tmpZip = Join-Path $env:TEMP $download.Name
    $tmpExtract = Join-Path $env:TEMP ("openclaw-portable-git-" + [guid]::NewGuid().ToString("N"))

    New-Item -ItemType Directory -Force -Path $portableParent | Out-Null
    if (Test-Path $portableRoot) {
        Remove-Item -Recurse -Force $portableRoot
    }
    if (Test-Path $tmpExtract) {
        Remove-Item -Recurse -Force $tmpExtract
    }
    New-Item -ItemType Directory -Force -Path $tmpExtract | Out-Null

    try {
        Write-Host "  Downloading $($download.Tag)..." -ForegroundColor Gray
        Invoke-WebRequest -Uri $download.Url -OutFile $tmpZip
        Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
        Move-Item -Path (Join-Path $tmpExtract "*") -Destination $portableRoot -Force
    } finally {
        if (Test-Path $tmpZip) {
            Remove-Item -Force $tmpZip
        }
        if (Test-Path $tmpExtract) {
            Remove-Item -Recurse -Force $tmpExtract
        }
    }

    if (-not (Use-PortableGitIfPresent)) {
        throw "Portable Git bootstrap completed, but git is still unavailable."
    }
    Ensure-PortableGitOnUserPath

    $portableVersion = (& git --version 2>$null)
    Write-Host "[OK] User-local Git ready: $portableVersion" -ForegroundColor Green
}

function Ensure-Git {
    if (Check-Git) { return $true }
    if (Use-PortableGitIfPresent) {
        Ensure-PortableGitOnUserPath
        return $true
    }
    try {
        Install-PortableGit
        if (Check-Git) {
            return $true
        }
    } catch {
        Write-Host "[!] Portable Git bootstrap failed: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "Error: Git is required to install OpenClaw." -ForegroundColor Red
    Write-Host "Auto-bootstrap of user-local Git did not succeed." -ForegroundColor Yellow
    Write-Host "Install Git for Windows manually, then re-run this installer:" -ForegroundColor Yellow
    Write-Host "  https://git-scm.com/download/win" -ForegroundColor Cyan
    return $false
}

function Get-OpenClawCommandPath {
    $openclawCmd = Get-Command openclaw.cmd -ErrorAction SilentlyContinue
    if ($openclawCmd -and $openclawCmd.Source) {
        return $openclawCmd.Source
    }

    $openclaw = Get-Command openclaw -ErrorAction SilentlyContinue
    if ($openclaw -and $openclaw.Source) {
        return $openclaw.Source
    }

    return $null
}

function Invoke-OpenClawCommand {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    $commandPath = Get-OpenClawCommandPath
    if (-not $commandPath) {
        throw "openclaw command not found on PATH."
    }

    & $commandPath @Arguments
}

function Invoke-InteractiveOpenClawCommand {
    param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]]$Arguments
    )

    $commandPath = Get-OpenClawCommandPath
    if (-not $commandPath) {
        throw "openclaw command not found on PATH."
    }

    $process = Start-Process -FilePath $commandPath -ArgumentList $Arguments -NoNewWindow -Wait -PassThru
    if ($process.ExitCode -ne 0) {
        throw "openclaw $($Arguments -join ' ') failed with exit code $($process.ExitCode)."
    }
}

function Resolve-CommandPath {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Candidates
    )

    foreach ($candidate in $Candidates) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command -and $command.Source) {
            return $command.Source
        }
    }

    return $null
}

function Get-NpmCommandPath {
    $path = Resolve-CommandPath -Candidates @("npm.cmd", "npm.exe", "npm")
    if (-not $path) {
        throw "npm not found on PATH."
    }
    return $path
}

function Get-CorepackCommandPath {
    return (Resolve-CommandPath -Candidates @("corepack.cmd", "corepack.exe", "corepack"))
}

function Get-PnpmCommandPath {
    return (Resolve-CommandPath -Candidates @("pnpm.cmd", "pnpm.exe", "pnpm"))
}

function Get-WindowsCommandSafeDirectory {
    $userHome = [Environment]::GetFolderPath("UserProfile")
    if (-not [string]::IsNullOrWhiteSpace($userHome) -and (Test-Path $userHome)) {
        return $userHome
    }
    if (-not [string]::IsNullOrWhiteSpace($env:TEMP) -and (Test-Path $env:TEMP)) {
        return $env:TEMP
    }
    return $null
}

function Invoke-CommandFromWindowsSafeDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CommandPath,
        [string[]]$Arguments = @()
    )

    $safeDir = Get-WindowsCommandSafeDirectory
    $pushedLocation = $false
    try {
        if (-not [string]::IsNullOrWhiteSpace($safeDir)) {
            Push-Location -LiteralPath $safeDir
            $pushedLocation = $true
        }
        & $CommandPath @Arguments
    } finally {
        if ($pushedLocation) {
            Pop-Location
        }
    }
}

function Invoke-NpmCommand {
    param([string[]]$Arguments = @())
    Invoke-CommandFromWindowsSafeDirectory -CommandPath (Get-NpmCommandPath) -Arguments $Arguments
}

function Invoke-CorepackCommand {
    param([string[]]$Arguments = @())
    $corepackCommand = Get-CorepackCommandPath
    if (-not $corepackCommand) {
        throw "corepack not found on PATH."
    }
    Invoke-CommandFromWindowsSafeDirectory -CommandPath $corepackCommand -Arguments $Arguments
}

function Get-NpmGlobalBinCandidates {
    param(
        [string]$NpmPrefix
    )

    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($NpmPrefix)) {
        $candidates += $NpmPrefix
        $candidates += (Join-Path $NpmPrefix "bin")
    }
    if (-not [string]::IsNullOrWhiteSpace($env:APPDATA)) {
        $candidates += (Join-Path $env:APPDATA "npm")
    }

    return $candidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
}

function Ensure-OpenClawOnPath {
    if (Get-OpenClawCommandPath) {
        return $true
    }

    $npmPrefix = $null
    try {
        $npmPrefix = (Invoke-NpmCommand -Arguments @("config", "get", "prefix") 2>$null).Trim()
    } catch {
        $npmPrefix = $null
    }

    $npmBins = Get-NpmGlobalBinCandidates -NpmPrefix $npmPrefix
    foreach ($npmBin in $npmBins) {
        if (-not (Test-Path (Join-Path $npmBin "openclaw.cmd"))) {
            continue
        }

        if (Add-ToUserPath $npmBin) {
            Write-Host "[!] Added $npmBin to user PATH (restart terminal if command not found)" -ForegroundColor Yellow
        }
        return $true
    }

    Write-Host "[!] openclaw is not on PATH yet." -ForegroundColor Yellow
    Write-Host "Restart PowerShell or add the npm global install folder to PATH." -ForegroundColor Yellow
    if ($npmBins.Count -gt 0) {
        Write-Host "Expected path (one of):" -ForegroundColor Gray
        foreach ($npmBin in $npmBins) {
            Write-Host "  $npmBin" -ForegroundColor Cyan
        }
    } else {
        Write-Host "Hint: run \"npm config get prefix\" to find your npm global path." -ForegroundColor Gray
    }
    return $false
}

function Get-RepoPnpmVersion {
    param([string]$RepoDir)

    if ([string]::IsNullOrWhiteSpace($RepoDir)) {
        return $null
    }

    $packageJsonPath = Join-Path $RepoDir "package.json"
    if (-not (Test-Path $packageJsonPath)) {
        return $null
    }

    try {
        $packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
        if ($packageJson.packageManager -match '^pnpm@(?<version>[^+]+)') {
            return $Matches["version"]
        }
        if ($packageJson.devEngines -and $packageJson.devEngines.packageManager) {
            $packageManager = $packageJson.devEngines.packageManager
            if ($packageManager.name -eq "pnpm" -and -not [string]::IsNullOrWhiteSpace($packageManager.version)) {
                return $packageManager.version
            }
        }
    } catch {
        return $null
    }

    return $null
}

function Test-PnpmCommandMatchesVersion {
    param(
        [string]$PnpmVersion,
        [string]$RepoDir
    )

    $pnpmCommand = Get-PnpmCommandPath
    if (-not $pnpmCommand) {
        return $false
    }
    if ([string]::IsNullOrWhiteSpace($PnpmVersion)) {
        return $true
    }

    $pushedLocation = $false
    try {
        if (-not [string]::IsNullOrWhiteSpace($RepoDir) -and (Test-Path $RepoDir)) {
            Push-Location -LiteralPath $RepoDir
            $pushedLocation = $true
        }
        $currentVersion = (& $pnpmCommand --version 2>$null)
        return ($LASTEXITCODE -eq 0 -and $currentVersion -and $currentVersion.Trim() -eq $PnpmVersion)
    } catch {
        return $false
    } finally {
        if ($pushedLocation) {
            Pop-Location
        }
    }
}

function Ensure-Pnpm {
    param([string]$RepoDir)

    $pnpmVersion = Get-RepoPnpmVersion -RepoDir $RepoDir
    $pnpmSpec = if ([string]::IsNullOrWhiteSpace($pnpmVersion)) { "pnpm@latest" } else { "pnpm@$pnpmVersion" }

    if (Test-PnpmCommandMatchesVersion -PnpmVersion $pnpmVersion -RepoDir $RepoDir) {
        return
    }
    $corepackCommand = Get-CorepackCommandPath
    if ($corepackCommand) {
        try {
            Invoke-CorepackCommand -Arguments @("enable") | Out-Null
            Invoke-CorepackCommand -Arguments @("prepare", $pnpmSpec, "--activate") | Out-Null
            if (Test-PnpmCommandMatchesVersion -PnpmVersion $pnpmVersion -RepoDir $RepoDir) {
                Write-Host "[OK] pnpm installed via corepack ($pnpmSpec)" -ForegroundColor Green
                return
            }
        } catch {
            # fallthrough to npm install
        }
    }
    Write-Host "[*] Installing pnpm..." -ForegroundColor Yellow
    $prevScriptShell = $env:NPM_CONFIG_SCRIPT_SHELL
    $env:NPM_CONFIG_SCRIPT_SHELL = "cmd.exe"
    try {
        $pnpmInstalled = $false
        try {
            Invoke-NpmCommand -Arguments @("install", "-g", $pnpmSpec)
            $pnpmInstalled = ($LASTEXITCODE -eq 0)
        } catch {
            $pnpmInstalled = $false
        }
        if (-not $pnpmInstalled) {
            Write-Host "[!] pnpm install hit an existing or broken shim; retrying with --force" -ForegroundColor Yellow
            Invoke-NpmCommand -Arguments @("install", "-g", "--force", $pnpmSpec)
        }
    } finally {
        $env:NPM_CONFIG_SCRIPT_SHELL = $prevScriptShell
    }
    if (-not (Test-PnpmCommandMatchesVersion -PnpmVersion $pnpmVersion -RepoDir $RepoDir)) {
        throw "pnpm install completed, but $pnpmSpec is not first on PATH."
    }
    Write-Host "[OK] pnpm installed" -ForegroundColor Green
}

# Install OpenClaw
function Resolve-LocalNpmPackagePath {
    param([string]$PackagePath)

    try {
        return (Resolve-Path -LiteralPath $PackagePath -ErrorAction Stop).ProviderPath
    } catch {
        return [System.IO.Path]::GetFullPath($PackagePath)
    }
}

function Resolve-LocalNpmPackageInstallSpec {
    param([string]$InstallSpec)

    if ([string]::IsNullOrWhiteSpace($InstallSpec)) {
        return $InstallSpec
    }
    if ($InstallSpec -match '^file:(?<path>.+)$') {
        $filePath = $Matches["path"]
        if (
            $filePath -match '^/' -or
            $filePath -match '^\\\\' -or
            $filePath -match '^[A-Za-z]:[\\/]'
        ) {
            return $InstallSpec
        }
        return ([System.Uri](Resolve-LocalNpmPackagePath -PackagePath $filePath)).AbsoluteUri
    }
    if (
        $InstallSpec -match '^https?:' -or
        $InstallSpec -match '^(git\+|github:)' -or
        $InstallSpec -match '^[A-Za-z]:[\\/]' -or
        $InstallSpec -match '^\\\\'
    ) {
        return $InstallSpec
    }
    if ($InstallSpec -notmatch '^\.\.?[\\/]' -and $InstallSpec -notmatch '\.tgz$') {
        return $InstallSpec
    }

    try {
        return (Resolve-LocalNpmPackagePath -PackagePath $InstallSpec)
    } catch {
        return $InstallSpec
    }
}

function Resolve-NpmOpenClawInstallSpec {
    param(
        [string]$PackageName,
        [string]$RequestedTag
    )

    if ([string]::IsNullOrWhiteSpace($RequestedTag)) {
        return "$PackageName@latest"
    }

    $trimmedTag = $RequestedTag.Trim()
    if (
        $trimmedTag -match '^(https?|file):' -or
        $trimmedTag -match '^(git\+|github:)' -or
        $trimmedTag -match '^[A-Za-z]:[\\/]' -or
        $trimmedTag -match '^\\\\' -or
        $trimmedTag -match '^\.\.?[\\/]' -or
        $trimmedTag -match '\.tgz($|[?#])'
    ) {
        return (Resolve-LocalNpmPackageInstallSpec -InstallSpec $trimmedTag)
    }

    return "$PackageName@$trimmedTag"
}

function Test-OpenClawSourcePackageInstallSpec {
    param([string]$RequestedTag)

    if ([string]::IsNullOrWhiteSpace($RequestedTag)) {
        return $false
    }

    $normalizedTag = $RequestedTag.Trim().ToLowerInvariant()
    if ($normalizedTag.StartsWith("openclaw@")) {
        $normalizedTag = $normalizedTag.Substring("openclaw@".Length)
    }

    if ($normalizedTag -eq "main") {
        return $true
    }
    if ($normalizedTag -match '^github:openclaw/openclaw($|[#/])') {
        return $true
    }

    if ($normalizedTag.StartsWith("git+")) {
        $normalizedTag = $normalizedTag.Substring("git+".Length)
    }
    return (
        $normalizedTag -match '^https?://github\.com/openclaw/openclaw(\.git)?($|[?#])' -or
        $normalizedTag -match '^ssh://git@github\.com[:/]openclaw/openclaw(\.git)?($|[?#])' -or
        $normalizedTag -match '^git://github\.com/openclaw/openclaw(\.git)?($|[?#])' -or
        $normalizedTag -match '^git@github\.com:openclaw/openclaw(\.git)?($|[?#])'
    )
}

function Resolve-NpmConfigPath {
    param([string]$RawPath)
    if ([string]::IsNullOrWhiteSpace($RawPath) -or $RawPath -eq "null" -or $RawPath -eq "undefined") {
        return $null
    }
    if (($RawPath.StartsWith("~/") -or $RawPath.StartsWith("~\")) -and -not [string]::IsNullOrWhiteSpace($HOME)) {
        return (Join-Path $HOME $RawPath.Substring(2))
    }
    if (($RawPath.StartsWith('${HOME}/') -or $RawPath.StartsWith('${HOME}\')) -and -not [string]::IsNullOrWhiteSpace($HOME)) {
        return (Join-Path $HOME $RawPath.Substring(8))
    }
    return $RawPath
}

function Test-NpmConfigFileKey {
    param(
        [string]$Path,
        [string]$Key
    )
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }
    $escapedKey = [regex]::Escape($Key)
    return [bool](Select-String -LiteralPath $Path -Pattern "^\s*$escapedKey\s*=" -Quiet)
}

function Test-NpmConfigRawKey {
    param([string]$Key)
    $files = New-Object System.Collections.Generic.List[string]
    $userConfig = if ($env:NPM_CONFIG_USERCONFIG) { $env:NPM_CONFIG_USERCONFIG } else { $env:npm_config_userconfig }
    if ($userConfig) {
        $resolvedUserConfig = Resolve-NpmConfigPath $userConfig
        if ($resolvedUserConfig) { $files.Add($resolvedUserConfig) }
    } elseif (-not [string]::IsNullOrWhiteSpace($HOME)) {
        $files.Add((Join-Path $HOME ".npmrc"))
    }

    $globalConfig = if ($env:NPM_CONFIG_GLOBALCONFIG) { $env:NPM_CONFIG_GLOBALCONFIG } else { $env:npm_config_globalconfig }
    if ($globalConfig) {
        $resolvedGlobalConfig = Resolve-NpmConfigPath $globalConfig
        if ($resolvedGlobalConfig) { $files.Add($resolvedGlobalConfig) }
    }

    $detectedGlobalConfig = (Invoke-NpmCommand -Arguments @("config", "get", "globalconfig", "--global") 2>$null)
    if ($LASTEXITCODE -eq 0) {
        $resolvedDetectedGlobalConfig = Resolve-NpmConfigPath $detectedGlobalConfig
        if ($resolvedDetectedGlobalConfig) { $files.Add($resolvedDetectedGlobalConfig) }
    }

    foreach ($file in ($files | Select-Object -Unique)) {
        if (Test-NpmConfigFileKey -Path $file -Key $Key) {
            return $true
        }
    }
    return $false
}

function Install-OpenClaw {
    if ([string]::IsNullOrWhiteSpace($Tag)) {
        $Tag = "latest"
    }
    if (Test-OpenClawSourcePackageInstallSpec -RequestedTag $Tag) {
        Write-Host "Error: npm installs do not support OpenClaw GitHub source targets like '$Tag'." -ForegroundColor Red
        Write-Host "Use -InstallMethod git -Tag main for the moving main checkout, or use latest, beta, an exact version, or a built .tgz package." -ForegroundColor Yellow
        return $false
    }
    if (-not (Ensure-Git)) {
        return $false
    }

    # Use openclaw package for beta, openclaw for stable
    $packageName = "openclaw"
    if ($Tag -eq "beta" -or $Tag -match "^beta\.") {
        $packageName = "openclaw"
    }
    $installSpec = Resolve-NpmOpenClawInstallSpec -PackageName $packageName -RequestedTag $Tag
    Write-Host "[*] Installing OpenClaw ($installSpec)..." -ForegroundColor Yellow
    $freshnessArgs = @("--min-release-age=0")
    $minReleaseAge = (Invoke-NpmCommand -Arguments @("config", "get", "min-release-age", "--global") 2>$null)
    $minReleaseAgeStatus = $LASTEXITCODE
    if (Test-NpmConfigRawKey -Key "min-release-age") {
        $freshnessArgs = @("--min-release-age=0")
    } elseif ($minReleaseAgeStatus -ne 0 -or -not $minReleaseAge -or $minReleaseAge.Trim() -eq "null" -or $minReleaseAge.Trim() -eq "undefined") {
        $beforeValue = (Invoke-NpmCommand -Arguments @("config", "get", "before", "--global") 2>$null)
        if ($LASTEXITCODE -eq 0 -and $beforeValue -and $beforeValue.Trim() -ne "null" -and $beforeValue.Trim() -ne "undefined") {
            $freshnessArgs = @("--before=$((Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ"))")
        }
    }
    $prevLogLevel = $env:NPM_CONFIG_LOGLEVEL
    $prevUpdateNotifier = $env:NPM_CONFIG_UPDATE_NOTIFIER
    $prevFund = $env:NPM_CONFIG_FUND
    $prevAudit = $env:NPM_CONFIG_AUDIT
    $prevScriptShell = $env:NPM_CONFIG_SCRIPT_SHELL
    $prevNodeLlamaSkipDownload = $env:NODE_LLAMA_CPP_SKIP_DOWNLOAD
    $prevBefore = $env:NPM_CONFIG_BEFORE
    $prevMinReleaseAge = $env:NPM_CONFIG_MIN_RELEASE_AGE
    $env:NPM_CONFIG_LOGLEVEL = "error"
    $env:NPM_CONFIG_UPDATE_NOTIFIER = "false"
    $env:NPM_CONFIG_FUND = "false"
    $env:NPM_CONFIG_AUDIT = "false"
    $env:NPM_CONFIG_SCRIPT_SHELL = "cmd.exe"
    $env:NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1"
    Remove-Item Env:NPM_CONFIG_BEFORE -ErrorAction SilentlyContinue
    Remove-Item Env:NPM_CONFIG_MIN_RELEASE_AGE -ErrorAction SilentlyContinue
    try {
        $npmOutput = Invoke-NpmCommand -Arguments (@("install", "-g") + $freshnessArgs + @("$installSpec")) 2>&1
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[!] npm install failed" -ForegroundColor Red
            if ($npmOutput -match "spawn git" -or $npmOutput -match "ENOENT.*git") {
                Write-Host "Error: git is missing from PATH." -ForegroundColor Red
                Write-Host "Install Git for Windows, then reopen PowerShell and retry:" -ForegroundColor Yellow
                Write-Host "  https://git-scm.com/download/win" -ForegroundColor Cyan
            } else {
                Write-Host "Re-run with verbose output to see the full error:" -ForegroundColor Yellow
                Write-Host '  powershell -c "irm https://openclaw.ai/install.ps1 | iex"' -ForegroundColor Cyan
            }
            $npmOutput | ForEach-Object { Write-Host $_ }
            return $false
        }
    } finally {
        $env:NPM_CONFIG_LOGLEVEL = $prevLogLevel
        $env:NPM_CONFIG_UPDATE_NOTIFIER = $prevUpdateNotifier
        $env:NPM_CONFIG_FUND = $prevFund
        $env:NPM_CONFIG_AUDIT = $prevAudit
        $env:NPM_CONFIG_SCRIPT_SHELL = $prevScriptShell
        $env:NODE_LLAMA_CPP_SKIP_DOWNLOAD = $prevNodeLlamaSkipDownload
        $env:NPM_CONFIG_BEFORE = $prevBefore
        $env:NPM_CONFIG_MIN_RELEASE_AGE = $prevMinReleaseAge
    }
    Write-Host "[OK] OpenClaw installed" -ForegroundColor Green
    return $true
}

# Install OpenClaw from GitHub
function Install-OpenClawFromGit {
    param(
        [string]$RepoDir,
        [switch]$SkipUpdate
    )
    if (-not (Ensure-Git)) {
        return $false
    }

    $repoUrl = "https://github.com/openclaw/openclaw.git"
    Write-Host "[*] Installing OpenClaw from GitHub ($repoUrl)..." -ForegroundColor Yellow

    if (-not (Test-Path $RepoDir)) {
        git clone $repoUrl $RepoDir
    }

    if (-not $SkipUpdate) {
        # PowerShell 7+ surfaces native-command stderr as terminating errors when
        # $ErrorActionPreference=Stop, so git's normal "From <url>" progress line
        # would abort the script. Swallow failures here — pull is best-effort.
        $dirty = $null
        try { $dirty = git -C $RepoDir status --porcelain 2>$null } catch {}
        if (-not $dirty) {
            try { git -C $RepoDir pull --rebase 2>$null } catch {}
        } else {
            Write-Host "[!] Repo is dirty; skipping git pull" -ForegroundColor Yellow
        }
    } else {
        Write-Host "[!] Git update disabled; skipping git pull" -ForegroundColor Yellow
    }
    Ensure-Pnpm -RepoDir $RepoDir

    Remove-LegacySubmodule -RepoDir $RepoDir

    $prevPnpmScriptShell = $env:NPM_CONFIG_SCRIPT_SHELL
    $prevPnpmChildConcurrency = $env:PNPM_CONFIG_CHILD_CONCURRENCY
    $prevPnpmNetworkConcurrency = $env:PNPM_CONFIG_NETWORK_CONCURRENCY
    $prevPnpmWorkspaceConcurrency = $env:PNPM_CONFIG_WORKSPACE_CONCURRENCY
    $prevPnpmVerifyDepsBeforeRun = $env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN
    $prevPnpmSideEffectsCache = $env:PNPM_CONFIG_SIDE_EFFECTS_CACHE
    $prevNodeOptions = $env:NODE_OPTIONS
    $pnpmCommand = Get-PnpmCommandPath
    if (-not $pnpmCommand) {
        throw "pnpm not found after installation."
    }
    $env:NPM_CONFIG_SCRIPT_SHELL = "cmd.exe"
    $env:PNPM_CONFIG_CHILD_CONCURRENCY = "1"
    $env:PNPM_CONFIG_NETWORK_CONCURRENCY = "4"
    $env:PNPM_CONFIG_WORKSPACE_CONCURRENCY = "1"
    $env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = "false"
    $env:PNPM_CONFIG_SIDE_EFFECTS_CACHE = "false"
    $pushedRepoLocation = $false
    try {
        Push-Location -LiteralPath $RepoDir
        $pushedRepoLocation = $true
        $sourceInstallArgs = @(
            "install",
            "--prefer-offline",
            "--config.node-linker=hoisted",
            "--config.engine-strict=false",
            "--config.enable-pre-post-scripts=true",
            "--config.side-effects-cache=false",
            "--no-frozen-lockfile",
            "--child-concurrency=$env:PNPM_CONFIG_CHILD_CONCURRENCY",
            "--network-concurrency=$env:PNPM_CONFIG_NETWORK_CONCURRENCY",
            "--config.workspace-concurrency=$env:PNPM_CONFIG_WORKSPACE_CONCURRENCY"
        )
        & $pnpmCommand @sourceInstallArgs
        $installSucceeded = ($LASTEXITCODE -eq 0)
        if (-not $installSucceeded) {
            Write-Host "[!] pnpm install failed for the Git checkout; clearing node_modules and retrying once" -ForegroundColor Yellow
            Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
            & $pnpmCommand @sourceInstallArgs
            $installSucceeded = ($LASTEXITCODE -eq 0)
        }
        if (-not $installSucceeded) {
            Write-Host "[!] pnpm install failed for the Git checkout" -ForegroundColor Red
            return $false
        }
        if (-not (& $pnpmCommand ui:build)) {
            Write-Host "[!] UI build failed; continuing (CLI may still work)" -ForegroundColor Yellow
        }
        $env:NODE_OPTIONS = Resolve-NodeOptionsWithMinOldSpace -NodeOptions $prevNodeOptions -MinOldSpaceMb 8192
        & $pnpmCommand build
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[!] pnpm build failed for the Git checkout" -ForegroundColor Red
            return $false
        }
    } finally {
        if ($pushedRepoLocation) {
            Pop-Location
        }
        $env:NPM_CONFIG_SCRIPT_SHELL = $prevPnpmScriptShell
        $env:PNPM_CONFIG_CHILD_CONCURRENCY = $prevPnpmChildConcurrency
        $env:PNPM_CONFIG_NETWORK_CONCURRENCY = $prevPnpmNetworkConcurrency
        $env:PNPM_CONFIG_WORKSPACE_CONCURRENCY = $prevPnpmWorkspaceConcurrency
        $env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = $prevPnpmVerifyDepsBeforeRun
        $env:PNPM_CONFIG_SIDE_EFFECTS_CACHE = $prevPnpmSideEffectsCache
        $env:NODE_OPTIONS = $prevNodeOptions
    }

    $entryPath = Join-Path $RepoDir "dist\\entry.js"
    if (-not (Test-Path $entryPath)) {
        Write-Host "[!] OpenClaw build did not produce $entryPath" -ForegroundColor Red
        return $false
    }

    $binDir = Join-Path $env:USERPROFILE ".local\\bin"
    if (-not (Test-Path $binDir)) {
        New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    }
    $cmdPath = Join-Path $binDir "openclaw.cmd"
    $cmdContents = "@echo off`r`nnode ""$entryPath"" %*`r`n"
    Set-Content -Path $cmdPath -Value $cmdContents -NoNewline

    if (Add-ToUserPath $binDir) {
        Write-Host "[!] Added $binDir to user PATH (restart terminal if command not found)" -ForegroundColor Yellow
    }

    Write-Host "[OK] OpenClaw wrapper installed to $cmdPath" -ForegroundColor Green
    Write-Host "[i] This checkout uses pnpm. For deps, run: pnpm install (avoid npm install in the repo)." -ForegroundColor Gray
    return $true
}

# Run doctor for migrations (safe, non-interactive)
function Run-Doctor {
    Write-Host "[*] Running doctor to migrate settings..." -ForegroundColor Yellow
    try {
        Invoke-OpenClawCommand doctor --non-interactive
    } catch {
        # Ignore errors from doctor
    }
    Write-Host "[OK] Migration complete" -ForegroundColor Green
}

function Test-GatewayServiceLoaded {
    try {
        $statusJson = (Invoke-OpenClawCommand daemon status --json 2>$null)
        if ([string]::IsNullOrWhiteSpace($statusJson)) {
            return $false
        }
        $parsed = $statusJson | ConvertFrom-Json
        if ($parsed -and $parsed.service -and $parsed.service.loaded) {
            return $true
        }
    } catch {
        return $false
    }
    return $false
}

function Refresh-GatewayServiceIfLoaded {
    if (-not (Get-OpenClawCommandPath)) {
        return
    }
    if (-not (Test-GatewayServiceLoaded)) {
        return
    }

    Write-Host "[*] Refreshing loaded gateway service..." -ForegroundColor Yellow
    try {
        Invoke-OpenClawCommand gateway install --force | Out-Null
    } catch {
        Write-Host "[!] Gateway service refresh failed; continuing." -ForegroundColor Yellow
        return
    }

    try {
        Invoke-OpenClawCommand gateway restart | Out-Null
        Invoke-OpenClawCommand gateway status --json | Out-Null
        Write-Host "[OK] Gateway service refreshed" -ForegroundColor Green
    } catch {
        Write-Host "[!] Gateway service restart failed; continuing." -ForegroundColor Yellow
    }
}

function Get-LegacyRepoDir {
    if (-not [string]::IsNullOrWhiteSpace($env:OPENCLAW_GIT_DIR)) {
        return $env:OPENCLAW_GIT_DIR
    }
    $userHome = [Environment]::GetFolderPath("UserProfile")
    return (Join-Path $userHome "openclaw")
}

function Remove-LegacySubmodule {
    param(
        [string]$RepoDir
    )
    if ([string]::IsNullOrWhiteSpace($RepoDir)) {
        $RepoDir = Get-LegacyRepoDir
    }
    $legacyDir = Join-Path $RepoDir "Peekaboo"
    if (Test-Path $legacyDir) {
        Write-Host "[!] Removing legacy submodule checkout: $legacyDir" -ForegroundColor Yellow
        Remove-Item -Recurse -Force $legacyDir
    }
}

# Main installation flow
function Main {
    if ($InstallMethod -ne "npm" -and $InstallMethod -ne "git") {
        Write-Host "Error: invalid -InstallMethod (use npm or git)." -ForegroundColor Red
        return (Fail-Install -Code 2)
    }

    if ($DryRun) {
        Write-Host "[OK] Dry run" -ForegroundColor Green
        Write-Host "[OK] Install method: $InstallMethod" -ForegroundColor Green
        if ($InstallMethod -eq "git") {
            Write-Host "[OK] Git dir: $GitDir" -ForegroundColor Green
            if ($NoGitUpdate) {
                Write-Host "[OK] Git update: disabled" -ForegroundColor Green
            } else {
                Write-Host "[OK] Git update: enabled" -ForegroundColor Green
            }
        }
        if ($NoOnboard) {
            Write-Host "[OK] Onboard: skipped" -ForegroundColor Green
        }
        return $true
    }

    # Check for existing installation
    $isUpgrade = Check-ExistingOpenClaw

    # Step 1: Node.js
    if (-not (Check-Node)) {
        if (-not (Install-Node)) {
            return (Fail-Install)
        }

        # Verify installation
        if (-not (Check-Node)) {
            Write-Host ""
            Write-Host "Error: Node.js installation may require a terminal restart" -ForegroundColor Red
            Write-Host "Please close this terminal, open a new one, and run this installer again." -ForegroundColor Yellow
            return (Fail-Install)
        }
    }

    $finalGitDir = $null

    # Step 2: OpenClaw
    if ($InstallMethod -eq "git") {
        try {
            $npmCommand = Get-NpmCommandPath
            if ($npmCommand) {
                Invoke-NpmCommand -Arguments @("uninstall", "-g", "openclaw") 2>$null | Out-Null
                Write-Host "[OK] Removed npm global install if present" -ForegroundColor Green
            }
        } catch { }
        $finalGitDir = $GitDir
        $gitInstallResults = @(Install-OpenClawFromGit -RepoDir $GitDir -SkipUpdate:$NoGitUpdate)
        if (-not (Test-BooleanSuccessResult -Results $gitInstallResults)) {
            return (Fail-Install)
        }
    } else {
        $gitWrapper = Join-Path (Join-Path $env:USERPROFILE ".local\\bin") "openclaw.cmd"
        if (Test-Path $gitWrapper) {
            Remove-Item -Force $gitWrapper
            Write-Host "[OK] Removed git wrapper (switching to npm)" -ForegroundColor Green
        }
        $npmInstallResults = @(Install-OpenClaw)
        if (-not (Test-BooleanSuccessResult -Results $npmInstallResults)) {
            return (Fail-Install)
        }
    }

    if (-not (Ensure-OpenClawOnPath)) {
        Write-Host "Install completed, but OpenClaw is not on PATH yet." -ForegroundColor Yellow
        Write-Host "Open a new terminal, then run: openclaw doctor" -ForegroundColor Cyan
        return
    }

    Refresh-GatewayServiceIfLoaded

    # Step 3: Run doctor for migrations if upgrading or git install
    if ($isUpgrade -or $InstallMethod -eq "git") {
        Run-Doctor
    }

    $installedVersion = $null
    try {
        $installedVersion = (Invoke-OpenClawCommand --version 2>$null).Trim()
    } catch {
        $installedVersion = $null
    }
    if (-not $installedVersion) {
        try {
            $npmList = Invoke-NpmCommand -Arguments @("list", "-g", "--depth", "0", "--json") 2>$null | ConvertFrom-Json
            if ($npmList -and $npmList.dependencies -and $npmList.dependencies.openclaw -and $npmList.dependencies.openclaw.version) {
                $installedVersion = $npmList.dependencies.openclaw.version
            }
        } catch {
            $installedVersion = $null
        }
    }

    Write-Host ""
    if ($installedVersion) {
        Write-Host "OpenClaw installed successfully ($installedVersion)!" -ForegroundColor Green
    } else {
        Write-Host "OpenClaw installed successfully!" -ForegroundColor Green
    }
    Write-Host ""
    if ($isUpgrade) {
        $updateMessages = @(
            "Leveled up! New skills unlocked. You're welcome.",
            "Fresh code, same lobster. Miss me?",
            "Back and better. Did you even notice I was gone?",
            "Update complete. I learned some new tricks while I was out.",
            "Upgraded! Now with 23% more sass.",
            "I've evolved. Try to keep up.",
            "New version, who dis? Oh right, still me but shinier.",
            "Patched, polished, and ready to pinch. Let's go.",
            "The lobster has molted. Harder shell, sharper claws.",
            "Update done! Check the changelog or just trust me, it's good.",
            "Reborn from the boiling waters of npm. Stronger now.",
            "I went away and came back smarter. You should try it sometime.",
            "Update complete. The bugs feared me, so they left.",
            "New version installed. Old version sends its regards.",
            "Firmware fresh. Brain wrinkles: increased.",
            "I've seen things you wouldn't believe. Anyway, I'm updated.",
            "Back online. The changelog is long but our friendship is longer.",
            "Upgraded! Peter fixed stuff. Blame him if it breaks.",
            "Molting complete. Please don't look at my soft shell phase.",
            "Version bump! Same chaos energy, fewer crashes (probably)."
        )
        Write-Host (Get-Random -InputObject $updateMessages) -ForegroundColor Gray
        Write-Host ""
    } else {
        $completionMessages = @(
            "Ahh nice, I like it here. Got any snacks? ",
            "Home sweet home. Don't worry, I won't rearrange the furniture.",
            "I'm in. Let's cause some responsible chaos.",
            "Installation complete. Your productivity is about to get weird.",
            "Settled in. Time to automate your life whether you're ready or not.",
            "Cozy. I've already read your calendar. We need to talk.",
            "Finally unpacked. Now point me at your problems.",
            "cracks claws Alright, what are we building?",
            "The lobster has landed. Your terminal will never be the same.",
            "All done! I promise to only judge your code a little bit."
        )
        Write-Host (Get-Random -InputObject $completionMessages) -ForegroundColor Gray
        Write-Host ""
    }

    if ($InstallMethod -eq "git") {
        Write-Host "Source checkout: $finalGitDir" -ForegroundColor Cyan
        Write-Host "Wrapper: $env:USERPROFILE\\.local\\bin\\openclaw.cmd" -ForegroundColor Cyan
        Write-Host ""
    }

    if ($isUpgrade) {
        Write-Host "Upgrade complete. Run " -NoNewline
        Write-Host "openclaw doctor" -ForegroundColor Cyan -NoNewline
        Write-Host " to check for additional migrations."
    } else {
        if ($NoOnboard) {
            Write-Host "Skipping onboard (requested). Run " -NoNewline
            Write-Host "openclaw onboard" -ForegroundColor Cyan -NoNewline
            Write-Host " later."
        } else {
            Write-Host "Starting setup..." -ForegroundColor Cyan
            Write-Host ""
            Invoke-InteractiveOpenClawCommand onboard
        }
    }

    return $true
}

$mainResults = @(Main)
$installSucceeded = Test-BooleanSuccessResult -Results $mainResults
Complete-Install -Succeeded:$installSucceeded
