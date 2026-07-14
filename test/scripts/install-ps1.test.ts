// Install Ps1 tests cover install ps1 script behavior.
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers.js";

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
  const runConcurrentIfPowerShell = powershell ? it.concurrent : it.skip;
  const runPowerShell = (args: string[]) => {
    if (!powershell) {
      throw new Error("PowerShell is not available");
    }
    return spawnSync(powershell, args, { encoding: "utf8" });
  };
  const runPowerShellAsync = (args: string[]) => {
    if (!powershell) {
      throw new Error("PowerShell is not available");
    }
    return new Promise<{ status: number | null; stderr: string; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(powershell, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
          stderr += chunk;
        });
        child.once("error", reject);
        child.once("close", (status) => resolve({ status, stderr, stdout }));
      },
    );
  };
  const batchedPowerShellResults = new Map<string, { error: string; ok: boolean }>();

  beforeAll(() => {
    if (!powershell) {
      return;
    }
    const scriptWithoutEntryPoint = source.replace(ENTRYPOINT_RE, "");
    const cases = [
      {
        name: "node-versions",
        source: [
          scriptWithoutEntryPoint,
          "",
          "$cases = @{",
          "  '22.22.2' = $false",
          "  '22.22.3' = $true",
          "  '23.11.0' = $false",
          "  '24.14.1' = $false",
          "  '24.15.0' = $true",
          "  '25.8.1' = $false",
          "  '25.9.0' = $true",
          "  '26.0.0' = $true",
          "}",
          "foreach ($entry in $cases.GetEnumerator()) {",
          "  $actual = Test-NodeVersionSupported -Version $entry.Key",
          '  if ($actual -ne $entry.Value) { throw "Version=$($entry.Key) Actual=$actual" }',
          "}",
          "",
        ].join("\n"),
      },
      {
        name: "node-sqlite-runtime",
        source: [
          scriptWithoutEntryPoint,
          "",
          "if (-not (Test-NodeSqliteSupported)) { throw 'Bundled SQLite runtime was rejected' }",
          "",
        ].join("\n"),
      },
      {
        name: "native-arm64-git",
        source: [
          scriptWithoutEntryPoint,
          "",
          "$env:PROCESSOR_ARCHITEW6432 = $null",
          "$env:PROCESSOR_ARCHITECTURE = 'ARM64'",
          "function Invoke-RestMethod {",
          "  [pscustomobject]@{",
          "    tag_name = 'v2.54.0.windows.1'",
          "    assets = @(",
          "      [pscustomobject]@{ name = 'MinGit-2.54.0-64-bit.zip'; browser_download_url = 'https://example.test/x64.zip' },",
          "      [pscustomobject]@{ name = 'MinGit-2.54.0-arm64.zip'; browser_download_url = 'https://example.test/arm64.zip' },",
          "      [pscustomobject]@{ name = 'MinGit-2.54.0-busybox-64-bit.zip'; browser_download_url = 'https://example.test/busybox.zip' }",
          "    )",
          "  }",
          "}",
          "$download = Resolve-PortableGitDownload",
          "if ($download.Name -ne 'MinGit-2.54.0-arm64.zip') { throw \"Name=$($download.Name)\" }",
          "if ($download.Url -ne 'https://example.test/arm64.zip') { throw \"Url=$($download.Url)\" }",
          "",
        ].join("\n"),
      },
      {
        name: "emulated-arm64-downloads",
        source: [
          scriptWithoutEntryPoint,
          "",
          "$env:PROCESSOR_ARCHITEW6432 = $null",
          "$env:PROCESSOR_ARCHITECTURE = 'AMD64'",
          "function Get-CimInstance {",
          "  [CmdletBinding()]",
          "  param([string]$ClassName)",
          "  if ($ClassName -eq 'Win32_Processor') { return [pscustomobject]@{ Architecture = 12; Name = 'Cobalt 100' } }",
          "  if ($ClassName -eq 'Win32_ComputerSystem') { return [pscustomobject]@{ SystemType = 'ARM64-based PC' } }",
          '  throw "Unexpected CIM class $ClassName"',
          "}",
          "function Invoke-RestMethod {",
          "  param([string]$Uri, [object]$Headers)",
          "  if ($Uri -eq 'https://nodejs.org/dist/index.json') {",
          "    return @(",
          "      [pscustomobject]@{ version = 'v24.17.0'; files = @('win-arm64-zip', 'win-x64-zip') }",
          "    )",
          "  }",
          "  [pscustomobject]@{",
          "    tag_name = 'v2.54.0.windows.1'",
          "    assets = @(",
          "      [pscustomobject]@{ name = 'MinGit-2.54.0-64-bit.zip'; browser_download_url = 'https://example.test/x64.zip' },",
          "      [pscustomobject]@{ name = 'MinGit-2.54.0-arm64.zip'; browser_download_url = 'https://example.test/arm64.zip' }",
          "    )",
          "  }",
          "}",
          "$nodeDownload = Resolve-PortableNodeDownload",
          "if ($nodeDownload.Name -ne 'node-v24.17.0-win-arm64.zip') { throw \"NodeName=$($nodeDownload.Name)\" }",
          "$gitDownload = Resolve-PortableGitDownload",
          "if ($gitDownload.Name -ne 'MinGit-2.54.0-arm64.zip') { throw \"GitName=$($gitDownload.Name)\" }",
          "",
        ].join("\n"),
      },
      {
        name: "node-options",
        source: [
          scriptWithoutEntryPoint,
          "",
          '$result = Resolve-NodeOptionsWithMinOldSpace -NodeOptions "--trace-warnings --max_old_space_size=8192" -MinOldSpaceMb 8192',
          'if ($result -ne "--trace-warnings --max-old-space-size=8192") { throw "alias result=$result" }',
          '$result = Resolve-NodeOptionsWithMinOldSpace -NodeOptions "--max_old_space_size 8192 --trace-warnings" -MinOldSpaceMb 8192',
          'if ($result -ne "--max-old-space-size=8192 --trace-warnings") { throw "split alias result=$result" }',
          '$result = Resolve-NodeOptionsWithMinOldSpace -NodeOptions "--max-old-space-size=4096" -MinOldSpaceMb 8192',
          'if ($result -ne "--max-old-space-size=8192") { throw "minimum result=$result" }',
          '$result = Resolve-NodeOptionsWithMinOldSpace -NodeOptions "`"--max-old-space-size=12288`"" -MinOldSpaceMb 8192',
          'if ($result -ne "--max-old-space-size=12288") { throw "quoted token result=$result" }',
          '$result = Resolve-NodeOptionsWithMinOldSpace -NodeOptions "--max-old-space-size=`"12288`"" -MinOldSpaceMb 8192',
          'if ($result -ne "--max-old-space-size=12288") { throw "quoted value result=$result" }',
          "",
        ].join("\n"),
      },
      {
        name: "chocolatey-node-upgrade",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Get-Command {",
          "  [CmdletBinding()]",
          "  param([string]$Name)",
          "  if ($Name -eq 'choco') { return $true }",
          "  return $null",
          "}",
          "filter Out-Host { }",
          "function choco {",
          "  $script:chocoArgs = $args -join ' '",
          "  $global:LASTEXITCODE = 0",
          "  Write-Output 'Chocolatey output'",
          "}",
          "function Check-Node { return $true }",
          "$result = @(Install-Node)",
          'if ($result.Count -ne 1 -or $result[0] -ne $true) { throw "Install-Node returned $result" }',
          "if ($script:chocoArgs -ne 'upgrade nodejs-lts -y --install-if-not-installed') {",
          '  throw "Args=$script:chocoArgs"',
          "}",
          "",
        ].join("\n"),
      },
      {
        name: "scoop-node-update",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Get-Command {",
          "  [CmdletBinding()]",
          "  param([string]$Name)",
          "  if ($Name -eq 'scoop') { return $true }",
          "  return $null",
          "}",
          "filter Out-Host { }",
          "$env:Path = 'C:\\session-bin'",
          "$script:scoopCalls = @()",
          "function scoop {",
          "  $script:scoopCalls += ($args -join ' ')",
          "  $global:LASTEXITCODE = 0",
          "  Write-Output 'Scoop output'",
          "}",
          "function Check-Node { return $true }",
          "$result = @(Install-Node)",
          'if ($result.Count -ne 1 -or $result[0] -ne $true) { throw "Install-Node returned $result" }',
          "if (($script:scoopCalls -join '|') -ne 'update|install nodejs-lts|update nodejs-lts') {",
          "  throw \"Calls=$($script:scoopCalls -join '|')\"",
          "}",
          "if (($env:Path -split ';') -notcontains 'C:\\session-bin') { throw \"Path=$env:Path\" }",
          "",
        ].join("\n"),
      },
      {
        name: "package-manager-node-validation-failure",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Get-Command {",
          "  [CmdletBinding()]",
          "  param([string]$Name)",
          "  if ($Name -eq 'choco') { return $true }",
          "  return $null",
          "}",
          "filter Out-Host { }",
          "function choco {",
          "  $global:LASTEXITCODE = 0",
          "  Write-Output 'Chocolatey output'",
          "}",
          "function Check-Node { return $false }",
          "$result = @(Install-Node)",
          'if ($result.Count -ne 1 -or $result[0] -ne $false) { throw "Install-Node returned $result" }',
          "",
        ].join("\n"),
      },
      {
        name: "scriptblock-failure",
        source: [
          scriptWithoutEntryPoint,
          "",
          "function Write-Banner { }",
          "function Ensure-ExecutionPolicy { return $true }",
          "function Check-Node { return $false }",
          "function Install-Node { return $false }",
          "$caught = $false",
          "try {",
          ...ENTRYPOINT_LINES.map((line) => `  ${line}`),
          "} catch {",
          "  if ($_.Exception.Message -ne 'OpenClaw installation failed with exit code 1.') { throw }",
          "  $caught = $true",
          "}",
          "if (-not $caught) { throw 'Install failure did not reach the caller' }",
          "",
        ].join("\n"),
      },
      {
        name: "noisy-git-failure",
        source: [
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
      },
      {
        name: "quiet-main-success",
        source: [
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
      },
      {
        name: "final-boolean-success",
        source: [
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
      },
    ];
    const tempDir = harness.createTempDir("openclaw-install-ps1-batch-");
    const fixtures = cases.map((testCase, index) => {
      const scriptPath = join(tempDir, `case-${index}.ps1`);
      writeFileSync(scriptPath, testCase.source);
      return { name: testCase.name, scriptPath };
    });
    const command = [
      "$ErrorActionPreference = 'Stop'",
      "$cases = @(",
      fixtures
        .map(
          (fixture) =>
            `  @{ Name = ${toPowerShellSingleQuotedLiteral(fixture.name)}; Path = ${toPowerShellSingleQuotedLiteral(fixture.scriptPath)} }`,
        )
        .join(",\n"),
      ")",
      "$results = foreach ($case in $cases) {",
      "  try {",
      "    $null = & ([scriptblock]::Create((Get-Content -LiteralPath $case.Path -Raw))) *>&1",
      "    [pscustomobject]@{ name = $case.Name; ok = $true; error = '' }",
      "  } catch {",
      "    [pscustomobject]@{ name = $case.Name; ok = $false; error = $_.Exception.Message }",
      "  }",
      "}",
      "$results | ConvertTo-Json -Compress",
    ].join("\n");
    const result = runPowerShell(["-NoLogo", "-NoProfile", "-Command", command]);
    if (result.status !== 0) {
      throw new Error(`PowerShell batch failed: ${result.stderr}`);
    }
    const parsed = JSON.parse(result.stdout) as Array<{ error: string; name: string; ok: boolean }>;
    for (const entry of parsed) {
      batchedPowerShellResults.set(entry.name, { error: entry.error, ok: entry.ok });
    }
  });

  function expectBatchedPowerShellCase(name: string): void {
    expect(batchedPowerShellResults.get(name)).toEqual({ error: "", ok: true });
  }

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

  it("checks the full supported Node version range", () => {
    const versionBody = extractFunctionBody(source, "Test-NodeVersionSupported");
    const sqliteBody = extractFunctionBody(source, "Test-NodeSqliteSupported");
    const checkNodeBody = extractFunctionBody(source, "Check-Node");
    expect(versionBody).toContain("$major -eq 22");
    expect(versionBody).toContain("$patch -ge 3");
    expect(versionBody).toContain("$major -eq 24");
    expect(versionBody).toContain("$minor -ge 15");
    expect(versionBody).toContain("$major -eq 25");
    expect(versionBody).toContain("$minor -ge 9");
    expect(versionBody).toContain("$major -gt 25");
    expect(sqliteBody).toContain("SELECT sqlite_version() AS version");
    expect(sqliteBody).toContain("$probe | & node -");
    expect(sqliteBody).not.toContain("& node -e");
    expect(sqliteBody).toContain("patch >= 3");
    expect(checkNodeBody).toContain("Test-NodeVersionSupported -Version $nodeVersion");
    expect(checkNodeBody).toContain("Test-NodeSqliteSupported");
    expect(source).toContain("Please install Node.js 24.15+ manually:");
  });

  runIfPowerShell("accepts only supported Node versions", () => {
    expectBatchedPowerShellCase("node-versions");
    expectBatchedPowerShellCase("node-sqlite-runtime");
  });

  runIfPowerShell("upgrades and validates Node installed by Windows package managers", () => {
    expectBatchedPowerShellCase("chocolatey-node-upgrade");
    expectBatchedPowerShellCase("scoop-node-update");
    expectBatchedPowerShellCase("package-manager-node-validation-failure");
  });

  it("runs npm install through the resolved command with quiet CI defaults", () => {
    const npmInstallBody = extractFunctionBody(source, "Install-OpenClaw");
    expect(npmInstallBody).toContain("$npmOutput = Invoke-NpmCommand -Arguments");
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_LOGLEVEL = "error"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_UPDATE_NOTIFIER = "false"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_FUND = "false"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_AUDIT = "false"');
    expect(npmInstallBody).not.toContain("NPM_CONFIG_SCRIPT_SHELL");
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
    expect(npmInstallBody).toContain("Write-NpmInstallFailureDetails -Output $npmOutput");
    expect(source).toContain("function Get-LatestNpmDebugLogPath {");
    expect(source).toContain("Get-Content -LiteralPath $latestLog -Tail 120");
  });

  it("does not force npm or pnpm lifecycle scripts through cmd.exe", () => {
    const ensurePnpmBody = extractFunctionBody(source, "Ensure-Pnpm");
    const npmInstallBody = extractFunctionBody(source, "Install-OpenClaw");
    const gitInstallBody = extractFunctionBody(source, "Install-OpenClawFromGit");

    expect(ensurePnpmBody).not.toContain("NPM_CONFIG_SCRIPT_SHELL");
    expect(npmInstallBody).not.toContain("NPM_CONFIG_SCRIPT_SHELL");
    expect(gitInstallBody).not.toContain("NPM_CONFIG_SCRIPT_SHELL");
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
    expect(openClawPathBody).toContain('Invoke-NpmCommand -Arguments @("config", "get", "prefix")');
    expect(ensurePnpmBody).toContain(
      'Invoke-CorepackCommand -Arguments @("prepare", $pnpmSpec, "--activate")',
    );
    expect(ensurePnpmBody).toContain('Invoke-NpmCommand -Arguments @("install", "-g", $pnpmSpec)');
    expect(mainBody).toContain('Invoke-NpmCommand -Arguments @("uninstall", "-g", "openclaw")');
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

  it("does not read project npmrc when choosing global install freshness args", () => {
    const rawKeyBody = extractFunctionBody(source, "Test-NpmConfigRawKey");
    expect(rawKeyBody).not.toContain("Get-Location");
    expect(rawKeyBody).not.toContain('Join-Path (Get-Location) ".npmrc"');
  });

  it("preserves the min-release-age probe status before raw npmrc detection", () => {
    const npmInstallBody = extractFunctionBody(source, "Install-OpenClaw");
    const probeStatusCapture = npmInstallBody.indexOf("$minReleaseAgeStatus = $LASTEXITCODE");
    const rawKeyProbe = npmInstallBody.indexOf("Test-NpmConfigRawKey -Key");
    expect(probeStatusCapture).toBeGreaterThan(-1);
    expect(rawKeyProbe).toBeGreaterThan(-1);
    expect(probeStatusCapture).toBeLessThan(rawKeyProbe);
    expect(npmInstallBody).toContain(
      "} elseif ($minReleaseAgeStatus -ne 0 -or -not $minReleaseAge",
    );
    expect(npmInstallBody).toContain(
      'Invoke-NpmCommand -Arguments @("config", "get", "min-release-age", "--global")',
    );
    expect(npmInstallBody).toContain(
      'Invoke-NpmCommand -Arguments @("config", "get", "before", "--global")',
    );
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
    const portableArchitectureBody = extractFunctionBody(source, "Get-WindowsPortableArchitecture");
    const portableGitDownloadBody = extractFunctionBody(source, "Resolve-PortableGitDownload");
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
    expect(portableArchitectureBody).toContain("Win32_Processor");
    expect(portableArchitectureBody).toContain("Architecture -eq 12");
    expect(portableArchitectureBody).toContain("Win32_ComputerSystem");
    expect(portableArchitectureBody).toContain("PROCESSOR_ARCHITEW6432");
    expect(portableArchitectureBody).toContain("PROCESSOR_ARCHITECTURE");
    expect(portableGitDownloadBody).toContain("Get-WindowsPortableArchitecture");
    expect(portableGitDownloadBody).toContain("'^MinGit-.*-arm64\\.zip$'");
    expect(portableGitDownloadBody).toContain("'^MinGit-.*-64-bit\\.zip$'");
  });

  runIfPowerShell("selects native ARM64 MinGit when the release publishes it", () => {
    expectBatchedPowerShellCase("native-arm64-git");
  });

  runIfPowerShell("selects native ARM64 downloads when x64 PowerShell is emulated", () => {
    expectBatchedPowerShellCase("emulated-arm64-downloads");
  });

  it("activates the repo-pinned pnpm version for git installs", () => {
    const pnpmVersionBody = extractFunctionBody(source, "Get-RepoPnpmVersion");
    const pnpmVersionMatchBody = extractFunctionBody(source, "Test-PnpmCommandMatchesVersion");
    const ensurePnpmBody = extractFunctionBody(source, "Ensure-Pnpm");
    const gitInstallBody = extractFunctionBody(source, "Install-OpenClawFromGit");
    const nodeOptionsBody = extractFunctionBody(source, "Resolve-NodeOptionsWithMinOldSpace");
    const mainBody = extractFunctionBody(source, "Main");

    expect(pnpmVersionBody).toContain("package.json");
    expect(pnpmVersionBody).toContain(
      "$packageJson.packageManager -match '^pnpm@(?<version>[^+]+)'",
    );
    expect(pnpmVersionMatchBody).toContain("Push-Location -LiteralPath $RepoDir");
    expect(pnpmVersionMatchBody).toContain("$currentVersion.Trim() -eq $PnpmVersion");
    expect(pnpmVersionMatchBody).toContain("} catch {");
    expect(pnpmVersionMatchBody).toContain("return $false");
    expect(ensurePnpmBody).toContain("Get-RepoPnpmVersion -RepoDir $RepoDir");
    expect(ensurePnpmBody).toContain("$pnpmSpec");
    expect(ensurePnpmBody).toContain(
      "Test-PnpmCommandMatchesVersion -PnpmVersion $pnpmVersion -RepoDir $RepoDir",
    );
    expect(ensurePnpmBody).toContain(
      'Invoke-CorepackCommand -Arguments @("prepare", $pnpmSpec, "--activate")',
    );
    expect(ensurePnpmBody).toContain('Invoke-NpmCommand -Arguments @("install", "-g", $pnpmSpec)');
    expect(ensurePnpmBody).toContain("$pnpmInstalled = ($LASTEXITCODE -eq 0)");
    expect(ensurePnpmBody).toContain("if (-not $pnpmInstalled)");
    expect(ensurePnpmBody).toContain(
      'Invoke-NpmCommand -Arguments @("install", "-g", "--force", $pnpmSpec)',
    );
    expect(gitInstallBody.indexOf("git clone $repoUrl $RepoDir")).toBeLessThan(
      gitInstallBody.indexOf("Ensure-Pnpm -RepoDir $RepoDir"),
    );
    expect(gitInstallBody.indexOf("git -C $RepoDir pull --rebase")).toBeLessThan(
      gitInstallBody.indexOf("Ensure-Pnpm -RepoDir $RepoDir"),
    );
    expect(mainBody).toContain("$gitInstallResults = @(Install-OpenClawFromGit");
    expect(mainBody).toContain("Test-BooleanSuccessResult -Results $gitInstallResults");
    expect(mainBody).toContain("$npmInstallResults = @(Install-OpenClaw)");
    expect(mainBody).toContain("Test-BooleanSuccessResult -Results $npmInstallResults");
    expect(gitInstallBody).toContain("Push-Location -LiteralPath $RepoDir");
    expect(gitInstallBody).toContain("$sourceInstallArgs = @(");
    expect(gitInstallBody).toContain('"--config.node-linker=hoisted"');
    expect(gitInstallBody).toContain('"--config.enable-pre-post-scripts=true"');
    expect(gitInstallBody).toContain('"--config.side-effects-cache=false"');
    expect(gitInstallBody).toContain('"--no-frozen-lockfile"');
    expect(gitInstallBody).not.toContain('"--frozen-lockfile"');
    expect(gitInstallBody).not.toContain('"--filter"');
    expect(gitInstallBody).not.toContain('"--ignore-scripts=true"');
    expect(gitInstallBody).toContain('"--child-concurrency=$env:PNPM_CONFIG_CHILD_CONCURRENCY"');
    expect(gitInstallBody).toContain(
      '"--network-concurrency=$env:PNPM_CONFIG_NETWORK_CONCURRENCY"',
    );
    expect(gitInstallBody).toContain(
      '"--config.workspace-concurrency=$env:PNPM_CONFIG_WORKSPACE_CONCURRENCY"',
    );
    expect(gitInstallBody).toContain("& $pnpmCommand @sourceInstallArgs");
    expect(gitInstallBody).toContain('$env:PNPM_CONFIG_CHILD_CONCURRENCY = "1"');
    expect(gitInstallBody).toContain('$env:PNPM_CONFIG_NETWORK_CONCURRENCY = "4"');
    expect(gitInstallBody).toContain('$env:PNPM_CONFIG_WORKSPACE_CONCURRENCY = "1"');
    expect(gitInstallBody).toContain('$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = "false"');
    expect(gitInstallBody).toContain('$env:PNPM_CONFIG_SIDE_EFFECTS_CACHE = "false"');
    expect(gitInstallBody).toContain('$env:NODE_LLAMA_CPP_POSTINSTALL = "skip"');
    expect(gitInstallBody).toContain("$installSucceeded = ($LASTEXITCODE -eq 0)");
    expect(gitInstallBody).toContain("clearing node_modules and retrying once");
    expect(gitInstallBody).toContain("Remove-Item -Recurse -Force node_modules");
    expect(gitInstallBody).toContain('Write-Host "[!] pnpm install failed for the Git checkout"');
    expect(gitInstallBody).not.toContain("$pnpmCommand rebuild --pending");
    expect(gitInstallBody).not.toContain("scripts/postinstall-bundled-plugins.mjs");
    expect(gitInstallBody).toContain(
      "$env:NODE_OPTIONS = Resolve-NodeOptionsWithMinOldSpace -NodeOptions $prevNodeOptions -MinOldSpaceMb 8192",
    );
    expect(nodeOptionsBody).toContain("--max-old-space-size=$MinOldSpaceMb");
    expect(nodeOptionsBody).toContain("[Math]::Max");
    expect(gitInstallBody).toContain("& $pnpmCommand build");
    expect(gitInstallBody).toContain("$env:NODE_OPTIONS = $prevNodeOptions");
    expect(gitInstallBody).toContain(
      "$env:PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN = $prevPnpmVerifyDepsBeforeRun",
    );
    expect(gitInstallBody).toContain(
      "$env:PNPM_CONFIG_WORKSPACE_CONCURRENCY = $prevPnpmWorkspaceConcurrency",
    );
    expect(gitInstallBody).toContain("$env:NODE_LLAMA_CPP_POSTINSTALL = $prevNodeLlamaPostinstall");
    expect(gitInstallBody).toContain("Add-ToUserPath $binDir");
    expect(gitInstallBody).toContain('Write-Host "[!] pnpm build failed for the Git checkout"');
    expect(gitInstallBody).toContain('$entryPath = Join-Path $RepoDir "dist\\\\entry.js"');
    expect(gitInstallBody).toContain("Test-Path $entryPath");
    expect(gitInstallBody).toContain('Write-Host "[!] OpenClaw build did not produce $entryPath"');
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
    expect(interactiveCommandBody).toContain("$process.ExitCode -ne 0");
    expect(interactiveCommandBody).toContain("failed with exit code");
    expect(mainBody).toContain('Write-Host "Starting setup..." -ForegroundColor Cyan');
    expect(mainBody).toContain("Invoke-InteractiveOpenClawCommand onboard");
  });

  runConcurrentIfPowerShell(
    "fails install when interactive onboarding exits non-zero",
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), "openclaw-install-ps1-"));
      const scriptPath = join(tempDir, "install.ps1");
      try {
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
            "function Get-NpmCommandPath { return 'npm.cmd' }",
            "function Install-OpenClaw { return $true }",
            "function Ensure-OpenClawOnPath { return $true }",
            "function Add-ToUserPath { param([string]$Path) }",
            "function Get-OpenClawCommandPath { return 'cmd.exe' }",
            "function Start-Process {",
            "  param([string]$FilePath, [string[]]$ArgumentList, [switch]$NoNewWindow, [switch]$Wait, [switch]$PassThru)",
            "  [pscustomobject]@{ ExitCode = 17 }",
            "}",
            "$InstallMethod = 'npm'",
            "$NoOnboard = $false",
            "",
            ...ENTRYPOINT_LINES,
            "",
          ].join("\n"),
        );
        chmodSync(scriptPath, 0o755);

        const result = await runPowerShellAsync([
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          scriptPath,
        ]);

        expect(result.status).toBe(1);
        expect(`${result.stdout}\n${result.stderr}`).toContain(
          "openclaw onboard failed with exit code 17",
        );
      } finally {
        rmSync(tempDir, { force: true, recursive: true });
      }
    },
  );

  runConcurrentIfPowerShell("exits non-zero when run as a script file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "openclaw-install-ps1-"));
    const scriptPath = join(tempDir, "install.ps1");
    try {
      writeFileSync(scriptPath, createFailingNodeFixture(source));
      chmodSync(scriptPath, 0o755);

      const result = await runPowerShellAsync([
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
      ]);

      expect(result.status).toBe(1);
    } finally {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  runIfPowerShell("throws without killing the caller when run as a scriptblock", () => {
    expectBatchedPowerShellCase("scriptblock-failure");
  });

  runIfPowerShell("treats noisy Git install false as failure", () => {
    expectBatchedPowerShellCase("noisy-git-failure");
  });

  runIfPowerShell("preserves larger old-space NODE_OPTIONS aliases", () => {
    expectBatchedPowerShellCase("node-options");
  });

  runIfPowerShell("keeps npm chatter out of Main's success return value", () => {
    expectBatchedPowerShellCase("quiet-main-success");
  });

  runIfPowerShell("uses Main's final boolean result when helper output precedes success", () => {
    expectBatchedPowerShellCase("final-boolean-success");
  });
});
