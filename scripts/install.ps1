# OpenClaw Installer for Windows (PowerShell)
# Usage: iwr -useb https://openclaw.ai/install.ps1 | iex
# Or: & ([scriptblock]::Create((iwr -useb https://openclaw.ai/install.ps1))) -NoOnboard

param(
    [ValidateSet("npm", "git")]
    [string]$InstallMethod = "npm",
    [string]$Tag = "latest",
    [string]$GitDir = "$env:USERPROFILE\openclaw",
    [switch]$NoOnboard,
    [switch]$NoGitUpdate,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Colors
$ACCENT = "`e[38;2;255;77;77m"    # coral-bright
$SUCCESS = "`e[38;2;0;229;204m"    # cyan-bright
$WARN = "`e[38;2;255;176;32m"     # amber
$ERROR_COLOR = "`e[38;2;230;57;70m"     # coral-mid
$MUTED = "`e[38;2;90;100;128m"    # text-muted
$NC = "`e[0m"                     # No Color

function Write-Host {
    param([string]$Message, [string]$Level = "info")
    $msg = switch ($Level) {
        "success" { "$SUCCESS✓$NC $Message" }
        "warn" { "$WARN!$NC $Message" }
        "error" { "$ERROR_COLOR✗$NC $Message" }
        default { "$MUTED·$NC $Message" }
    }
    Microsoft.PowerShell.Utility\Write-Host $msg
}

function Write-Banner {
    Write-Host ""
    Write-Host "${ACCENT}  🦞 OpenClaw Installer$NC" -Level info
    Write-Host "${MUTED}  All your chats, one OpenClaw.$NC" -Level info
    Write-Host ""
}

function Get-ExecutionPolicyStatus {
    $policy = Get-ExecutionPolicy
    if ($policy -eq "Restricted" -or $policy -eq "AllSigned") {
        return @{ Blocked = $true; Policy = $policy }
    }
    return @{ Blocked = $false; Policy = $policy }
}

function Test-Admin {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Ensure-ExecutionPolicy {
    $status = Get-ExecutionPolicyStatus
    if ($status.Blocked) {
        Write-Host "PowerShell execution policy is set to: $($status.Policy)" -Level warn
        Write-Host "This prevents scripts like npm.ps1 from running." -Level warn
        Write-Host ""
        
        # Try to set execution policy for current process
        try {
            Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process -ErrorAction Stop
            Write-Host "Set execution policy to RemoteSigned for current process" -Level success
            return $true
        } catch {
            Write-Host "Could not automatically set execution policy" -Level error
            Write-Host ""
            Write-Host "To fix this, run:" -Level info
            Write-Host "  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process" -Level info
            Write-Host ""
            Write-Host "Or run PowerShell as Administrator and execute:" -Level info
            Write-Host "  Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine" -Level info
            return $false
        }
    }
    return $true
}

function Get-NodeVersion {
    try {
        $version = node --version 2>$null
        if ($version) {
            return $version -replace '^v', ''
        }
    } catch { }
    return $null
}

function Get-NpmVersion {
    try {
        $version = npm --version 2>$null
        if ($version) {
            return $version
        }
    } catch { }
    return $null
}

function Install-Node {
    Write-Host "Node.js not found" -Level info
    Write-Host "Installing Node.js..." -Level info
    
    # Try winget first
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "  Using winget..." -Level info
        try {
            winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
            # Refresh PATH
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Host "  Node.js installed via winget" -Level success
            return $true
        } catch {
            Write-Host "  Winget install failed: $_" -Level warn
        }
    }
    
    # Try chocolatey
    if (Get-Command choco -ErrorAction SilentlyContinue) {
        Write-Host "  Using chocolatey..." -Level info
        try {
            choco install nodejs-lts -y 2>&1 | Out-Null
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Host "  Node.js installed via chocolatey" -Level success
            return $true
        } catch {
            Write-Host "  Chocolatey install failed: $_" -Level warn
        }
    }
    
    # Try scoop
    if (Get-Command scoop -ErrorAction SilentlyContinue) {
        Write-Host "  Using scoop..." -Level info
        try {
            scoop install nodejs-lts 2>&1 | Out-Null
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Host "  Node.js installed via scoop" -Level success
            return $true
        } catch {
            Write-Host "  Scoop install failed: $_" -Level warn
        }
    }
    
    Write-Host "Could not install Node.js automatically" -Level error
    Write-Host "Please install Node.js 22+ manually from: https://nodejs.org" -Level info
    return $false
}

function Ensure-Node {
    $nodeVersion = Get-NodeVersion
    if ($nodeVersion) {
        $major = [int]($nodeVersion -split '\.')[0]
        if ($major -ge 22) {
            Write-Host "Node.js v$nodeVersion found" -Level success
            return $true
        }
        Write-Host "Node.js v$nodeVersion found, but need v22+" -Level warn
    }
    return Install-Node
}

function Get-GitVersion {
    try {
        $version = git --version 2>$null
        if ($version) {
            return $version
        }
    } catch { }
    return $null
}

function Install-Git {
    Write-Host "Git not found" -Level info
    
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        Write-Host "  Installing Git via winget..." -Level info
        try {
            winget install Git.Git --accept-package-agreements --accept-source-agreements 2>&1 | Out-Null
            $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
            Write-Host "  Git installed" -Level success
            return $true
        } catch {
            Write-Host "  Winget install failed" -Level warn
        }
    }
    
    Write-Host "Please install Git for Windows from: https://git-scm.com" -Level error
    return $false
}

function Ensure-Git {
    $gitVersion = Get-GitVersion
    if ($gitVersion) {
        Write-Host "$gitVersion found" -Level success
        return $true
    }
    return Install-Git
}

function Read-TrimmedFileText {
    param([string]$Path)

    if (!(Test-Path -LiteralPath $Path)) {
        return ""
    }

    return ((Get-Content -LiteralPath $Path -Raw) -replace "(\r?\n)+$", "")
}

function ConvertTo-PowerShellSingleQuotedLiteral {
    param([string]$Value)

    return "'" + ($Value -replace "'", "''") + "'"
}

function Invoke-NativeCommandCapture {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$Arguments = @()
    )

    $stdoutPath = [System.IO.Path]::GetTempFileName()
    $stderrPath = [System.IO.Path]::GetTempFileName()

    try {
        $startFilePath = $FilePath
        $startArguments = $Arguments

        if ($FilePath -match '(?i)\.(cmd|bat)$') {
            # Start-Process cannot directly redirect stdio for command shims like
            # npm.cmd. Run them inside a nested PowerShell so the shim executes
            # normally while stdout/stderr still flow back to these temp files.
            $commandParts = @(
                ConvertTo-PowerShellSingleQuotedLiteral -Value $FilePath
            )
            foreach ($argument in $Arguments) {
                $commandParts += ConvertTo-PowerShellSingleQuotedLiteral -Value $argument
            }
            $commandScript = "& " + ($commandParts -join " ") + "`nexit `$LASTEXITCODE"
            $startFilePath = "powershell.exe"
            $startArguments = @(
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                $commandScript
            )
        }

        $process = Start-Process -FilePath $startFilePath `
            -ArgumentList $startArguments `
            -Wait `
            -PassThru `
            -RedirectStandardOutput $stdoutPath `
            -RedirectStandardError $stderrPath

        return @{
            ExitCode = $process.ExitCode
            Stdout = Read-TrimmedFileText -Path $stdoutPath
            Stderr = Read-TrimmedFileText -Path $stderrPath
        }
    } finally {
        Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
    }
}

function Install-OpenClawNpm {
    param([string]$Target = "latest")

    $installSpec = Resolve-PackageInstallSpec -Target $Target
    
    Write-Host "Installing OpenClaw ($installSpec)..." -Level info
    
    try {
        # Run npm out-of-process so warning chatter on stderr does not get
        # promoted into a terminating PowerShell error while the install succeeds.
        $installResult = Invoke-NativeCommandCapture -FilePath "npm.cmd" -Arguments @(
            "install",
            "-g",
            $installSpec,
            "--no-fund",
            "--no-audit"
        )
        if ($installResult.Stdout) {
            Microsoft.PowerShell.Utility\Write-Host $installResult.Stdout
        }
        if ($installResult.Stderr) {
            Microsoft.PowerShell.Utility\Write-Host $installResult.Stderr
        }
        if ($installResult.ExitCode -ne 0) {
            Write-Host "npm install failed with exit code $($installResult.ExitCode)" -Level error
            return $false
        }
        Write-Host "OpenClaw installed" -Level success
        return $true
    } catch {
        Write-Host "npm install failed: $_" -Level error
        return $false
    }
}

function Install-OpenClawGit {
    param([string]$RepoDir, [switch]$Update)
    
    Write-Host "Installing OpenClaw from git..." -Level info
    
    if (!(Test-Path $RepoDir)) {
        Write-Host "  Cloning repository..." -Level info
        git clone https://github.com/openclaw/openclaw.git $RepoDir 2>&1
    } elseif ($Update) {
        Write-Host "  Updating repository..." -Level info
        git -C $RepoDir pull --rebase 2>&1
    }
    
    # Install pnpm if not present
    if (!(Get-Command pnpm -ErrorAction SilentlyContinue)) {
        Write-Host "  Installing pnpm..." -Level info
        npm install -g pnpm 2>&1
    }
    
    # Install dependencies
    Write-Host "  Installing dependencies..." -Level info
    pnpm install --dir $RepoDir 2>&1
    
    # Build
    Write-Host "  Building..." -Level info
    pnpm --dir $RepoDir build 2>&1
    
    # Create wrapper
    $wrapperDir = "$env:USERPROFILE\.local\bin"
    if (!(Test-Path $wrapperDir)) {
        New-Item -ItemType Directory -Path $wrapperDir -Force | Out-Null
    }

    $entryPath = Join-Path $RepoDir "dist\entry.js"
    @"
@echo off
node "$entryPath" %*
"@ | Out-File -FilePath "$wrapperDir\openclaw.cmd" -Encoding ASCII -Force
    Add-ToPath -Path $wrapperDir
    
    Write-Host "OpenClaw installed" -Level success
    return $true
}

function Test-ExplicitPackageInstallSpec {
    param([string]$Target)

    if ([string]::IsNullOrWhiteSpace($Target)) {
        return $false
    }

    return $Target.Contains("://") -or
        $Target.Contains("#") -or
        $Target -match '^(file|github|git\+ssh|git\+https|git\+http|git\+file|npm):'
}

function Resolve-PackageInstallSpec {
    param([string]$Target = "latest")

    $trimmed = $Target.Trim()
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
        return "openclaw@latest"
    }
    if ($trimmed.ToLowerInvariant() -eq "main") {
        return "github:openclaw/openclaw#main"
    }
    if (Test-ExplicitPackageInstallSpec -Target $trimmed) {
        return $trimmed
    }
    return "openclaw@$trimmed"
}

function Add-ToPath {
    param([string]$Path)
    
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentPath -notlike "*$Path*") {
        [Environment]::SetEnvironmentVariable("Path", "$currentPath;$Path", "User")
        Write-Host "Added $Path to user PATH" -Level info
    }
}

$script:InstallExitCode = 0

function Fail-Install {
    param([int]$Code = 1)

    $script:InstallExitCode = $Code
    return $false
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

# Main
function Main {
    Write-Banner
    
    Write-Host "Windows detected" -Level success
    
    # Check and handle execution policy FIRST, before any npm calls
    if (!(Ensure-ExecutionPolicy)) {
        Write-Host ""
        Write-Host "Installation cannot continue due to execution policy restrictions" -Level error
        return (Fail-Install)
    }
    
    if (!(Ensure-Node)) {
        return (Fail-Install)
    }
    
    if ($InstallMethod -eq "git") {
        if (!(Ensure-Git)) {
            return (Fail-Install)
        }
        
        if ($DryRun) {
            Write-Host "[DRY RUN] Would install OpenClaw from git to $GitDir" -Level info
        } else {
            try {
                npm uninstall -g openclaw 2>$null | Out-Null
            } catch { }
            if (!(Install-OpenClawGit -RepoDir $GitDir -Update:(-not $NoGitUpdate))) {
                return (Fail-Install)
            }
        }
    } else {
        # npm method
        if (!(Ensure-Git)) {
            Write-Host "Git is required for npm installs. Please install Git and try again." -Level warn
        }
        
        if ($DryRun) {
            Write-Host "[DRY RUN] Would install OpenClaw via npm ($((Resolve-PackageInstallSpec -Target $Tag)))" -Level info
        } else {
            $gitWrapper = "$env:USERPROFILE\.local\bin\openclaw.cmd"
            if (Test-Path $gitWrapper) {
                Remove-Item -Force $gitWrapper
                Write-Host "Removed git wrapper (switching to npm)" -Level info
            }
            if (!(Install-OpenClawNpm -Target $Tag)) {
                return (Fail-Install)
            }
        }
    }
    
    # Try to add npm global bin to PATH
    try {
        $prefixResult = Invoke-NativeCommandCapture -FilePath "npm.cmd" -Arguments @(
            "config",
            "get",
            "prefix"
        )
        $npmPrefix = $prefixResult.Stdout
        if ($prefixResult.ExitCode -eq 0 -and $npmPrefix) {
            Add-ToPath -Path "$npmPrefix"
        }
    } catch { }
    
    if (!$NoOnboard -and !$DryRun) {
        Write-Host ""
        Write-Host "Run 'openclaw onboard' to complete setup" -Level info
    }
    
    Write-Host ""
    Write-Host "🦞 OpenClaw installed successfully!" -Level success
    return $true
}

$mainResults = @(Main)
$installSucceeded = $mainResults.Count -gt 0 -and $mainResults[-1] -eq $true
Complete-Install -Succeeded:$installSucceeded
