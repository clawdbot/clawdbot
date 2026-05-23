import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers";

const SCRIPT_PATH = "scripts/install.ps1";
const ENTRYPOINT_RE =
  /\r?\n\$mainResults = @\(Main\)\r?\n\$installSucceeded = Test-BooleanSuccessResult -Results \$mainResults\r?\nComplete-Install -Succeeded:\$installSucceeded\s*$/m;
const ENTRYPOINT_LINES = [
  "$mainResults = @(Main)",
  "$installSucceeded = Test-BooleanSuccessResult -Results $mainResults",
  "Complete-Install -Succeeded:$installSucceeded",
];

function extractFunctionBody(source: string, name: string): string {
  const match = source.match(
    new RegExp(`^function ${name} \\{\\r?\\n([\\s\\S]*?)^\\}\\r?\\n`, "m"),
  );
  if (match?.[1] === undefined) {
    throw new Error(`Missing PowerShell function body ${name}`);
  }
  return match[1];
}

function findPowerShell(): string | undefined {
  for (const candidate of ["pwsh", "powershell"]) {
    const result = spawnSync(
      candidate,
      ["-NoLogo", "-NoProfile", "-Command", "$PSVersionTable.PSVersion"],
      {
        encoding: "utf8",
      },
    );
    if (result.status === 0) {
      return candidate;
    }
  }
  return undefined;
}

function toPowerShellSingleQuotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function createFailingNodeFixture(source: string): string {
  const scriptWithoutEntryPoint = source.replace(ENTRYPOINT_RE, "");
  expect(scriptWithoutEntryPoint).not.toBe(source);

  return [
    scriptWithoutEntryPoint,
    "",
    "function Write-Banner { }",
    "function Ensure-ExecutionPolicy { return $true }",
    "function Check-Node { return $false }",
    "function Install-Node { return $false }",
    "",
    ...ENTRYPOINT_LINES,
    "",
  ].join("\n");
}

describe("install.ps1 failure handling", () => {
  const harness = createScriptTestHarness();
  const source = readFileSync(SCRIPT_PATH, "utf8");
  const powershell = findPowerShell();
  const runIfPowerShell = powershell ? it : it.skip;
  const runPowerShell = (args: string[]) => {
    if (!powershell) {
      throw new Error("PowerShell is not available");
    }
    return spawnSync(powershell, args, { encoding: "utf8" });
  };

  it("does not exit directly from inside Main", () => {
    const mainBody = extractFunctionBody(source, "Main");
    expect(mainBody).not.toMatch(/\bexit\b/i);
    expect(mainBody).toContain("return (Fail-Install)");
  });

  it("keeps failure termination in the top-level completion handler", () => {
    const completeInstallBody = extractFunctionBody(source, "Complete-Install");
    const booleanSuccessBody = extractFunctionBody(source, "Test-BooleanSuccessResult");
    expect(completeInstallBody).toMatch(/\$PSCommandPath/);
    expect(completeInstallBody).toMatch(/\bexit \$script:InstallExitCode\b/);
    expect(completeInstallBody).toMatch(/\bthrow "OpenClaw installation failed with exit code/);
    expect(booleanSuccessBody).toContain("$Results.Count -gt 0");
    expect(source).toContain("$installSucceeded = Test-BooleanSuccessResult -Results $mainResults");
  });

  it("runs npm install through the resolved command with quiet CI defaults", () => {
    const npmInstallBody = extractFunctionBody(source, "Install-OpenClaw");
    expect(npmInstallBody).toContain("$npmOutput = Invoke-NpmCommand -Arguments");
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_LOGLEVEL = "error"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_UPDATE_NOTIFIER = "false"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_FUND = "false"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_AUDIT = "false"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_SCRIPT_SHELL = "cmd.exe"');
    expect(npmInstallBody).toContain('$freshnessArgs = @("--min-release-age=0")');
    expect(npmInstallBody).toContain("Remove-Item Env:NPM_CONFIG_BEFORE");
    expect(npmInstallBody).toContain("Remove-Item Env:NPM_CONFIG_MIN_RELEASE_AGE");
    expect(npmInstallBody).toContain('$env:NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1"');
    expect(npmInstallBody).toContain(
      [
        "$npmOutput = Invoke-NpmCommand -Arguments",
        '(@("install", "-g") + $freshnessArgs + @("$installSpec"))',
      ].join(" "),
    );
    expect(npmInstallBody).toContain("$env:NPM_CONFIG_LOGLEVEL = $prevLogLevel");
    expect(npmInstallBody).toContain("$env:NPM_CONFIG_BEFORE = $prevBefore");
    expect(npmInstallBody).toContain(
      "$env:NODE_LLAMA_CPP_SKIP_DOWNLOAD = $prevNodeLlamaSkipDownload",
    );
  });

  it("runs Windows command shims from a Windows-local cwd", () => {
    const commandSafeBody = extractFunctionBody(source, "Invoke-CommandFromWindowsSafeDirectory");
    const npmCommandBody = extractFunctionBody(source, "Invoke-NpmCommand");
    const corepackCommandBody = extractFunctionBody(source, "Invoke-CorepackCommand");
    const openClawPathBody = extractFunctionBody(source, "Ensure-OpenClawOnPath");
    const ensurePnpmBody = extractFunctionBody(source, "Ensure-Pnpm");
    const mainBody = extractFunctionBody(source, "Main");

    expect(commandSafeBody).toContain("Get-WindowsCommandSafeDirectory");
    expect(commandSafeBody).toContain("Push-Location -LiteralPath $safeDir");
    expect(commandSafeBody).toContain("& $CommandPath @Arguments");
    expect(commandSafeBody).toContain("Pop-Location");
    expect(npmCommandBody).toContain("Invoke-CommandFromWindowsSafeDirectory");
    expect(corepackCommandBody).toContain("Invoke-CommandFromWindowsSafeDirectory");
    expect(openClawPathBody).toContain(
      'Invoke-NpmCommand -Arguments @("config", "get", "prefix")',
    );
    expect(ensurePnpmBody).toContain(
      'Invoke-CorepackCommand -Arguments @("prepare", $pnpmSpec, "--activate")',
    );
    expect(ensurePnpmBody).toContain('Invoke-NpmCommand -Arguments @("install", "-g", $pnpmSpec)');
    expect(mainBody).toContain(
      'Invoke-NpmCommand -Arguments @("uninstall", "-g", "openclaw")',
    );
    expect(mainBody).toContain(
      'Invoke-NpmCommand -Arguments @("list", "-g", "--depth", "0", "--json")',
    );
  });

  it("rejects OpenClaw GitHub source targets for npm installs", () => {
    const npmInstallBody = extractFunctionBody(source, "Install-OpenClaw");
    const sourceTargetBody = extractFunctionBody(source, "Test-OpenClawSourcePackageInstallSpec");
    expect(sourceTargetBody).toContain('$normalizedTag -eq "main"');
    expect(sourceTargetBody).toContain("^github:openclaw/openclaw");
    expect(npmInstallBody).toContain("Test-OpenClawSourcePackageInstallSpec -RequestedTag $Tag");
    expect(npmInstallBody).toContain("npm installs do not support OpenClaw GitHub source targets");
    expect(npmInstallBody).toContain("-InstallMethod git -Tag main");
  });

  it("preserves caller-relative local tarball install specs before safe-cwd npm calls", () => {
    const resolveSpecBody = extractFunctionBody(source, "Resolve-NpmOpenClawInstallSpec");
    const localSpecBody = extractFunctionBody(source, "Resolve-LocalNpmPackageInstallSpec");
    const localPathBody = extractFunctionBody(source, "Resolve-LocalNpmPackagePath");

    expect(resolveSpecBody).toContain(
      "Resolve-LocalNpmPackageInstallSpec -InstallSpec $trimmedTag",
    );
    expect(localSpecBody).toContain("$InstallSpec -match '^file:(?<path>.+)$'");
    expect(localSpecBody).toContain("Resolve-LocalNpmPackagePath -PackagePath $filePath");
    expect(localSpecBody).toContain(").AbsoluteUri");
    expect(localSpecBody).toContain("$InstallSpec -notmatch '^\\.\\.?[\\\\/]'");
    expect(localSpecBody).toContain("$InstallSpec -notmatch '\\.tgz$'");
    expect(localPathBody).toContain("Resolve-Path -LiteralPath $PackagePath");
    expect(localPathBody).toContain("[System.IO.Path]::GetFullPath($PackagePath)");
  });

  it("falls back to a user-local portable Node.js bootstrap when package managers are absent", () => {
    const installNodeBody = extractFunctionBody(source, "Install-Node");
    const portableNodeBody = extractFunctionBody(source, "Install-PortableNode");
    const portableNodeRootBody = extractFunctionBody(source, "Get-PortableNodeRoot");
    const portableNodePathBody = extractFunctionBody(source, "Ensure-PortableNodeOnUserPath");
    const userPathBody = extractFunctionBody(source, "Add-ToUserPath");
    const depsRootBody = extractFunctionBody(source, "Get-OpenClawDepsRoot");
    const resolveNodeBody = extractFunctionBody(source, "Resolve-PortableNodeDownload");
    const expandNodeBody = extractFunctionBody(source, "Expand-PortableNodeArchive");

    expect(installNodeBody).toContain("Install-PortableNode");
    expect(installNodeBody).toContain("Portable Node.js bootstrap failed");
    expect(installNodeBody).toContain("Error: Could not install Node.js automatically.");
    expect(depsRootBody).toContain("OpenClaw\\deps");
    expect(portableNodeRootBody).toContain("portable-node");
    expect(portableNodeBody).toContain("Ensure-PortableNodeOnUserPath");
    expect(portableNodeBody).toContain(
      "Expand-PortableNodeArchive -ZipPath $tmpZip -DestinationPath $portableRoot",
    );
    expect(portableNodeBody).not.toContain("Copy-Item");
    expect(portableNodeBody).not.toContain('Join-Path $nodeDir.FullName "*"');
    expect(portableNodePathBody).toContain("Add-ToUserPath $nodeDir");
    expect(userPathBody).toContain(
      '[Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")',
    );
    expect(portableNodeBody).toContain("Invoke-WebRequest -UseBasicParsing");
    expect(portableNodeBody).toContain("Expand-PortableNodeArchive");
    expect(portableNodeBody).not.toContain("Expand-Archive");
    expect(portableNodeBody).not.toContain("New-Item -ItemType Directory -Force -Path $tmpExtract");
    expect(expandNodeBody).toContain("Get-Command tar");
    expect(expandNodeBody).toContain("-xf $ZipPath -C $DestinationPath --strip-components 1");
    expect(expandNodeBody).toContain(
      "Copy-Item -LiteralPath $nodeDir.FullName -Destination $DestinationPath -Recurse -Force",
    );
    expect(expandNodeBody).toContain("System.IO.Compression.ZipFile");
    expect(resolveNodeBody).toContain("https://nodejs.org/dist/index.json");
    expect(resolveNodeBody).toContain("win-$architecture-zip");
    expect(resolveNodeBody).toContain("node-$($release.version)-win-$architecture.zip");
  });

  it("persists user-local portable Git for future git-backed updates", () => {
    const portableGitRootBody = extractFunctionBody(source, "Get-PortableGitRoot");
    const portableGitBody = extractFunctionBody(source, "Install-PortableGit");
    const portableGitPathEntriesBody = extractFunctionBody(source, "Get-PortableGitPathEntries");
    const portableGitPathBody = extractFunctionBody(source, "Ensure-PortableGitOnUserPath");
    const usePortableGitBody = extractFunctionBody(source, "Use-PortableGitIfPresent");
    const ensureGitBody = extractFunctionBody(source, "Ensure-Git");

    expect(portableGitRootBody).toContain("Get-OpenClawDepsRoot");
    expect(portableGitPathEntriesBody).toContain("mingw64\\bin");
    expect(portableGitPathEntriesBody).toContain("usr\\bin");
    expect(portableGitPathEntriesBody).toContain("Split-Path -Parent $gitExe");
    expect(usePortableGitBody).toContain("foreach ($pathEntry in (Get-PortableGitPathEntries))");
    expect(portableGitBody).toContain("Ensure-PortableGitOnUserPath");
    expect(ensureGitBody).toContain("Ensure-PortableGitOnUserPath");
    expect(portableGitPathBody).toContain("Add-ToUserPath $pathEntry");
    expect(portableGitPathBody).toContain("git-backed updates");
  });

  it("activates the repo-pinned pnpm version for git installs", () => {
    const pnpmVersionBody = extractFunctionBody(source, "Get-RepoPnpmVersion");
    const pnpmVersionMatchBody = extractFunctionBody(source, "Test-PnpmCommandMatchesVersion");
    const ensurePnpmBody = extractFunctionBody(source, "Ensure-Pnpm");
    const gitInstallBody = extractFunctionBody(source, "Install-OpenClawFromGit");
    const mainBody = extractFunctionBody(source, "Main");

    expect(pnpmVersionBody).toContain("package.json");
    expect(pnpmVersionBody).toContain("$packageJson.packageManager -match '^pnpm@(?<version>[^+]+)'");
    expect(pnpmVersionMatchBody).toContain("Push-Location -LiteralPath $RepoDir");
    expect(pnpmVersionMatchBody).toContain("$currentVersion.Trim() -eq $PnpmVersion");
    expect(ensurePnpmBody).toContain("Get-RepoPnpmVersion -RepoDir $RepoDir");
    expect(ensurePnpmBody).toContain("$pnpmSpec");
    expect(ensurePnpmBody).toContain(
      "Test-PnpmCommandMatchesVersion -PnpmVersion $pnpmVersion -RepoDir $RepoDir",
    );
    expect(ensurePnpmBody).toContain(
      'Invoke-CorepackCommand -Arguments @("prepare", $pnpmSpec, "--activate")',
    );
    expect(ensurePnpmBody).toContain('Invoke-NpmCommand -Arguments @("install", "-g", $pnpmSpec)');
    expect(gitInstallBody.indexOf("git clone $repoUrl $RepoDir")).toBeLessThan(
      gitInstallBody.indexOf("Ensure-Pnpm -RepoDir $RepoDir"),
    );
    expect(gitInstallBody.indexOf("git -C $RepoDir pull --rebase")).toBeLessThan(
      gitInstallBody.indexOf("Ensure-Pnpm -RepoDir $RepoDir"),
    );
    expect(mainBody).toContain("$gitInstallResults = @(Install-OpenClawFromGit");
    expect(mainBody).toContain(
      "Test-BooleanSuccessResult -Results $gitInstallResults",
    );
    expect(mainBody).toContain("$npmInstallResults = @(Install-OpenClaw)");
    expect(mainBody).toContain(
      "Test-BooleanSuccessResult -Results $npmInstallResults",
    );
    expect(gitInstallBody).toContain("Push-Location -LiteralPath $RepoDir");
    expect(gitInstallBody).toContain("& $pnpmCommand install");
    expect(gitInstallBody).toContain(
      'Write-Host "[!] pnpm install failed for the Git checkout"',
    );
    expect(gitInstallBody).toContain("& $pnpmCommand build");
    expect(gitInstallBody).toContain(
      'Write-Host "[!] pnpm build failed for the Git checkout"',
    );
    expect(gitInstallBody).toContain('$entryPath = Join-Path $RepoDir "dist\\\\entry.js"');
    expect(gitInstallBody).toContain("Test-Path $entryPath");
    expect(gitInstallBody).toContain(
      'Write-Host "[!] OpenClaw build did not produce $entryPath"',
    );
    expect(gitInstallBody).toContain('node ""$entryPath"" %*');
    expect(gitInstallBody).not.toContain("& $pnpmCommand -C $RepoDir install");
    expect(gitInstallBody).not.toContain('node ""$RepoDir\\\\dist\\\\entry.js"" %*');
  });

  it("cleans legacy git submodules only from the selected git checkout", () => {
    const gitInstallBody = extractFunctionBody(source, "Install-OpenClawFromGit");
    const mainBody = extractFunctionBody(source, "Main");
    expect(gitInstallBody).toContain("Remove-LegacySubmodule -RepoDir $RepoDir");
    expect(mainBody).not.toContain("Remove-LegacySubmodule");
  });

  it("launches interactive onboarding outside Main's captured output", () => {
    const interactiveCommandBody = extractFunctionBody(source, "Invoke-InteractiveOpenClawCommand");
    const mainBody = extractFunctionBody(source, "Main");
    expect(interactiveCommandBody).toContain("Start-Process");
    expect(interactiveCommandBody).toContain("-NoNewWindow");
    expect(interactiveCommandBody).toContain("-Wait");
    expect(interactiveCommandBody).toContain("-PassThru");
    expect(mainBody).toContain('Write-Host "Starting setup..." -ForegroundColor Cyan');
    expect(mainBody).toContain("Invoke-InteractiveOpenClawCommand onboard");
  });

  runIfPowerShell("exits non-zero when run as a script file", () => {
    const tempDir = harness.createTempDir("openclaw-install-ps1-");
    const scriptPath = join(tempDir, "install.ps1");
    writeFileSync(scriptPath, createFailingNodeFixture(source));
    chmodSync(scriptPath, 0o755);

    const result = runPowerShell([
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ]);

    expect(result.status).toBe(1);
  });

  runIfPowerShell("throws without killing the caller when run as a scriptblock", () => {
    const tempDir = harness.createTempDir("openclaw-install-ps1-");
    const scriptPath = join(tempDir, "install.ps1");
    writeFileSync(scriptPath, createFailingNodeFixture(source));
    chmodSync(scriptPath, 0o755);

    const command = [
      "try {",
      `  & ([scriptblock]::Create((Get-Content -LiteralPath ${toPowerShellSingleQuotedLiteral(scriptPath)} -Raw)))`,
      "} catch {",
      '  Write-Output "caught=$($_.Exception.Message)"',
      "}",
      'Write-Output "alive-after-install"',
    ].join("\n");
    const result = runPowerShell(["-NoLogo", "-NoProfile", "-Command", command]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("caught=OpenClaw installation failed with exit code 1.");
    expect(result.stdout).toContain("alive-after-install");
  });

  runIfPowerShell("treats noisy Git install false as failure", () => {
    const tempDir = harness.createTempDir("openclaw-install-ps1-");
    const scriptPath = join(tempDir, "install.ps1");
    const scriptWithoutEntryPoint = source.replace(ENTRYPOINT_RE, "");
    writeFileSync(
      scriptPath,
      [
        scriptWithoutEntryPoint,
        "",
        "function Write-Banner { }",
        "function Ensure-ExecutionPolicy { return $true }",
        "function Check-Node { return $true }",
        "function Check-ExistingOpenClaw { return $false }",
        "function Get-NpmCommandPath { return $null }",
        "function Install-OpenClawFromGit {",
        "  Write-Output 'pnpm stdout before failure'",
        "  return $false",
        "}",
        "function Ensure-OpenClawOnPath { throw 'should not continue after failed git install' }",
        "$InstallMethod = 'git'",
        "$GitDir = 'C:\\\\openclaw-test'",
        "$NoOnboard = $true",
        "$result = Main",
        'if ($result -ne $false) { throw "Main returned $result" }',
        'if ($script:InstallExitCode -ne 1) { throw "InstallExitCode=$script:InstallExitCode" }',
        "",
      ].join("\n"),
    );
    chmodSync(scriptPath, 0o755);

    const result = runPowerShell(["-NoLogo", "-NoProfile", "-Command", `. ${toPowerShellSingleQuotedLiteral(scriptPath)}`]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  runIfPowerShell("keeps npm chatter out of Main's success return value", () => {
    const tempDir = harness.createTempDir("openclaw-install-ps1-");
    const scriptPath = join(tempDir, "install.ps1");
    const scriptWithoutEntryPoint = source.replace(ENTRYPOINT_RE, "");
    writeFileSync(
      scriptPath,
      [
        scriptWithoutEntryPoint,
        "",
        "function Write-Banner { }",
        "function Ensure-ExecutionPolicy { return $true }",
        "function Check-Node { return $true }",
        "function Check-ExistingOpenClaw { return $false }",
        "function Add-ToPath { param([string]$Path) }",
        "function Install-OpenClaw { Write-Output 'npm stdout'; return $true }",
        "function Ensure-OpenClawOnPath { return $true }",
        "function Refresh-GatewayServiceIfLoaded { }",
        "function Invoke-OpenClawCommand { return 'OpenClaw test-version' }",
        "$NoOnboard = $true",
        "$result = Main",
        "if ($result -is [array]) { throw 'Main returned an array' }",
        'if ($result -ne $true) { throw "Main returned $result" }',
        "",
      ].join("\n"),
    );
    chmodSync(scriptPath, 0o755);

    const result = runPowerShell([
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  runIfPowerShell("uses Main's final boolean result when helper output precedes success", () => {
    const tempDir = harness.createTempDir("openclaw-install-ps1-");
    const scriptPath = join(tempDir, "install.ps1");
    const scriptWithoutEntryPoint = source.replace(ENTRYPOINT_RE, "");
    writeFileSync(
      scriptPath,
      [
        scriptWithoutEntryPoint,
        "",
        "function Write-Banner { }",
        "function Ensure-ExecutionPolicy { return $true }",
        "function Check-Node { return $true }",
        "function Check-ExistingOpenClaw { return $false }",
        "function Add-ToPath { param([string]$Path) }",
        "function Install-OpenClaw {",
        "  Write-Output 'native chatter'",
        "  return $true",
        "}",
        "function Ensure-OpenClawOnPath { return $true }",
        "function Refresh-GatewayServiceIfLoaded { }",
        "function Invoke-OpenClawCommand { return 'OpenClaw test-version' }",
        "$NoOnboard = $true",
        ...ENTRYPOINT_LINES,
        "",
      ].join("\n"),
    );
    chmodSync(scriptPath, 0o755);

    const result = runPowerShell([
      "-NoLogo",
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath,
    ]);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
