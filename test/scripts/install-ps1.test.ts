import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createScriptTestHarness } from "./test-helpers";

const SCRIPT_PATH = "scripts/install.ps1";
const ENTRYPOINT_RE =
  /\r?\n\$mainResults = @\(Main\)\r?\n\$installSucceeded = \$mainResults\.Count -gt 0 -and \$mainResults\[-1\] -eq \$true\r?\nComplete-Install -Succeeded:\$installSucceeded\s*$/m;

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
    "$mainResults = @(Main)",
    "$installSucceeded = $mainResults.Count -gt 0 -and $mainResults[-1] -eq $true",
    "Complete-Install -Succeeded:$installSucceeded",
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
    expect(completeInstallBody).toMatch(/\$PSCommandPath/);
    expect(completeInstallBody).toMatch(/\bexit \$script:InstallExitCode\b/);
    expect(completeInstallBody).toMatch(/\bthrow "OpenClaw installation failed with exit code/);
  });

  it("runs npm install through the resolved command with quiet CI defaults", () => {
    const npmInstallBody = extractFunctionBody(source, "Install-OpenClaw");
    expect(npmInstallBody).toContain("$npmOutput = & (Get-NpmCommandPath) install -g");
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_LOGLEVEL = "error"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_UPDATE_NOTIFIER = "false"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_FUND = "false"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_AUDIT = "false"');
    expect(npmInstallBody).toContain('$env:NPM_CONFIG_SCRIPT_SHELL = "cmd.exe"');
    expect(npmInstallBody).toContain('$env:NODE_LLAMA_CPP_SKIP_DOWNLOAD = "1"');
    expect(npmInstallBody).toContain("$env:NPM_CONFIG_LOGLEVEL = $prevLogLevel");
    expect(npmInstallBody).toContain(
      "$env:NODE_LLAMA_CPP_SKIP_DOWNLOAD = $prevNodeLlamaSkipDownload",
    );
  });

  it("cleans legacy git submodules only from the selected git checkout", () => {
    const gitInstallBody = extractFunctionBody(source, "Install-OpenClawFromGit");
    const mainBody = extractFunctionBody(source, "Main");
    expect(gitInstallBody).toContain("Remove-LegacySubmodule -RepoDir $RepoDir");
    expect(mainBody).not.toContain("Remove-LegacySubmodule");
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
        "$mainResults = @(Main)",
        "$installSucceeded = $mainResults.Count -gt 0 -and $mainResults[-1] -eq $true",
        "Complete-Install -Succeeded:$installSucceeded",
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
