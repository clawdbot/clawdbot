import { spawn } from "node:child_process";
import { appendFileSync, createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  agentOutputHasExpectedOkMarker,
  buildCrossOsReleaseAgentSessionId,
  buildReleaseAgentTurnArgs,
  maybeBuildOptionalAgentTurnSkipResult,
  shouldRetryCrossOsAgentTurnError,
} from "./agent.ts";
import type {
  AgentTurnResult,
  CommandOptions,
  GatewayHandle,
  LaneState,
  ProviderConfig,
} from "./config.ts";
import {
  CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS,
  CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
  CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS,
  CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE,
  buildCrossOsReleaseSmokeMemorySlotConfigArgs,
  buildCrossOsReleaseSmokePluginAllowlist,
  buildReleaseProviderConfigOverride,
  gatewayReadyDeadlineMs,
  installTimeoutMs,
  looksLikeCommitSha,
  resolveExplicitBaselineVersion,
  resolveExpectedDevUpdateRef,
  shouldSkipInstallerDaemonHealthCheck,
} from "./config.ts";
import {
  installedEntryPath,
  normalizeWindowsInstalledCliPath,
  npmCommand,
  resolveInstalledPrefixDirFromCliPath,
} from "./install.ts";
import { readLogFileSize, readLogTextSince } from "./logs.ts";
import {
  canConnectToLoopbackPort,
  resolveCommandSpawnInvocation,
  runCommand,
  runCommandInvocation,
  withAllocatedGatewayPort,
} from "./process.ts";
import { formatError, shellEscapeForSh, sleep } from "./shared.ts";

const INSTALLER_CONNECT_TIMEOUT_SECONDS = 10;
const INSTALLER_REQUEST_TIMEOUT_SECONDS = 120;

export async function resolveInstallerTargetVersion(params: {
  baselineSpec: string;
  logsDir: string;
  suiteName: string;
}) {
  const resolvedVersion = resolveExplicitBaselineVersion(params.baselineSpec);
  if (resolvedVersion) {
    return resolvedVersion;
  }
  const latestResult = await runCommand(npmCommand(), ["view", "openclaw@latest", "version"], {
    logPath: join(params.logsDir, `${params.suiteName}-latest-version.log`),
    timeoutMs: 2 * 60 * 1000,
  });
  const latestVersion = latestResult.stdout.trim();
  if (!latestVersion) {
    throw new Error("npm view openclaw@latest version did not return a version.");
  }
  return latestVersion;
}

function powerShellSingleQuote(value: string) {
  return value.replace(/'/gu, "''");
}

function parseMarkerLine(output: string, marker: string) {
  return output
    .split(/\r?\n/gu)
    .find((line) => line.startsWith(marker))
    ?.slice(marker.length)
    .trim();
}

export function resolveInstalledCliInvocation(
  cliPath: string,
  args: string[] = [],
  options: { platform?: NodeJS.Platform; comSpec?: string; env?: NodeJS.ProcessEnv } = {
    platform: process.platform,
  },
) {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command: cliPath, args, shell: false };
  }
  const normalizedCliPath = normalizeWindowsInstalledCliPath(cliPath);
  if (!/\.cmd$/iu.test(normalizedCliPath)) {
    return { command: normalizedCliPath, args, shell: false };
  }
  const entryPath = installedEntryPath(
    resolveInstalledPrefixDirFromCliPath(normalizedCliPath, platform),
  );
  if (existsSync(entryPath)) {
    return {
      command: process.execPath,
      args: [entryPath, ...args],
      shell: false,
    };
  }
  return resolveCommandSpawnInvocation(normalizedCliPath, args, {
    comSpec: options.comSpec,
    env: options.env,
    platform,
  });
}

async function runPosixShellScript(script: string, options: CommandOptions) {
  return runCommand("/bin/bash", ["-lc", script], options);
}

async function runPowerShellScript(script: string, options: CommandOptions) {
  return runCommand(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    options,
  );
}

export function buildInstallerSmokeScript(
  params: {
    installerUrl: string;
    installTarget: string;
    platform?: NodeJS.Platform;
  },
  options: {
    connectTimeoutSeconds?: number;
    requestTimeoutSeconds?: number;
  } = {},
) {
  const connectTimeoutSeconds = options.connectTimeoutSeconds ?? INSTALLER_CONNECT_TIMEOUT_SECONDS;
  const requestTimeoutSeconds = options.requestTimeoutSeconds ?? INSTALLER_REQUEST_TIMEOUT_SECONDS;
  if ((params.platform ?? process.platform) === "win32") {
    return `
$installerPath = Join-Path ([System.IO.Path]::GetTempPath()) ("openclaw-installer-" + [guid]::NewGuid().ToString("N") + ".ps1")
try {
  & curl.exe -fsSL --connect-timeout ${connectTimeoutSeconds} --max-time ${requestTimeoutSeconds} -o $installerPath '${powerShellSingleQuote(params.installerUrl)}'
  if ($LASTEXITCODE -ne 0) {
    throw "curl.exe failed to download the OpenClaw installer (exit $LASTEXITCODE)"
  }
  $content = [System.IO.File]::ReadAllText($installerPath, [System.Text.Encoding]::UTF8)
  & ([scriptblock]::Create($content)) -Tag '${powerShellSingleQuote(params.installTarget)}' -NoOnboard
} finally {
  Remove-Item -LiteralPath $installerPath -Force -ErrorAction SilentlyContinue
}
`;
  }

  // Execute only a complete installer: a timed-out response may still contain an executable prefix.
  return [
    "set -euo pipefail",
    'installer_path="$(mktemp "${TMPDIR:-/tmp}/openclaw-installer-XXXXXX")"',
    "trap 'rm -f \"$installer_path\"' EXIT",
    `curl -fsSL --connect-timeout ${connectTimeoutSeconds} --max-time ${requestTimeoutSeconds} -o "$installer_path" '${shellEscapeForSh(params.installerUrl)}'`,
    `bash -- "$installer_path" --version '${shellEscapeForSh(params.installTarget)}' --no-onboard`,
  ].join("\n");
}

export async function runInstallerSmoke(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  installerUrl: string;
  installTarget: string;
  logPath: string;
}) {
  const script = buildInstallerSmokeScript(params);
  if (process.platform === "win32") {
    await runPowerShellScript(script, {
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: installTimeoutMs(),
    });
    return;
  }

  await runPosixShellScript(script, {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: installTimeoutMs(),
  });
}

export function buildWindowsPathBootstrapScript(
  options: { includeCurrentProcessPath?: boolean } = {},
) {
  const includeCurrentProcessPath = options.includeCurrentProcessPath !== false;
  const pathCandidates = includeCurrentProcessPath
    ? "@($userPath, $machinePath, $env:Path)"
    : "@($userPath, $machinePath)";
  return `
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
$segments = New-Object System.Collections.Generic.List[string]
foreach ($candidate in ${pathCandidates}) {
  foreach ($segment in ($candidate -split ';')) {
    if ([string]::IsNullOrWhiteSpace($segment)) {
      continue
    }
    if (-not $segments.Contains($segment)) {
      $segments.Add($segment)
    }
  }
}
$env:Path = [string]::Join(';', $segments)
`.trim();
}

export function buildWindowsFreshShellVersionCheckScript(params: { expectedNeedle?: string } = {}) {
  const expectedNeedle = powerShellSingleQuote(params.expectedNeedle ?? "");
  return `
${buildWindowsPathBootstrapScript()}
$commandPath = $null
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
  $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
}
if ($null -ne $npmCommand) {
  $npmPrefix = (& $npmCommand.Source config get prefix 2>$null | Out-String).Trim()
  if (-not [string]::IsNullOrWhiteSpace($npmPrefix)) {
    $env:Path = "$npmPrefix;$env:Path"
    foreach ($candidate in @(
      (Join-Path $npmPrefix 'openclaw.cmd'),
      (Join-Path $npmPrefix 'openclaw.ps1')
    )) {
      if (Test-Path -LiteralPath $candidate) {
        $commandPath = $candidate
        break
      }
    }
  }
}
if ([string]::IsNullOrWhiteSpace($commandPath)) {
  $cmd = Get-Command openclaw -ErrorAction Stop
  $commandPath = $cmd.Source
}
if ($commandPath -match '(?i)\\.ps1$') {
  $cmdPath = [System.IO.Path]::ChangeExtension($commandPath, '.cmd')
  if (Test-Path -LiteralPath $cmdPath) {
    $commandPath = $cmdPath
  }
}
$version = (& $commandPath --version 2>&1 | Out-String).Trim()
Write-Output "__OPENCLAW_PATH__=$commandPath"
Write-Output $version
if ('${expectedNeedle}'.Length -gt 0 -and $version -notmatch [regex]::Escape('${expectedNeedle}')) {
  throw "version mismatch: expected substring ${expectedNeedle}"
}
`.trim();
}

export function buildWindowsDevUpdateToolchainCheckScript() {
  return `
${buildWindowsPathBootstrapScript()}
function Resolve-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($null -eq $command) {
    return $null
  }
  $commandPath = $command.Source
  if ($commandPath -match '(?i)\\.ps1$') {
    $cmdPath = [System.IO.Path]::ChangeExtension($commandPath, '.cmd')
    if (Test-Path -LiteralPath $cmdPath) {
      $commandPath = $cmdPath
    }
  }
  return $commandPath
}
$pnpmPath = Resolve-CommandPath 'pnpm'
if ($null -ne $pnpmPath) {
  Write-Output "__UPDATE_TOOL__=pnpm"
  Write-Output "__UPDATE_TOOL_PATH__=$pnpmPath"
  & $pnpmPath --version
  return
}
$corepackPath = Resolve-CommandPath 'corepack'
if ($null -ne $corepackPath) {
  Write-Output "__UPDATE_TOOL__=corepack"
  Write-Output "__UPDATE_TOOL_PATH__=$corepackPath"
  & $corepackPath --version
  return
}
$npmPath = Resolve-CommandPath 'npm'
if ($null -ne $npmPath) {
  Write-Output "__UPDATE_TOOL__=npm"
  Write-Output "__UPDATE_TOOL_PATH__=$npmPath"
  & $npmPath --version
  return
}
throw 'Neither pnpm, corepack, nor npm is discoverable from the reconstructed Windows PATH.'
`.trim();
}

export async function verifyFreshShellCommand(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  expectedNeedle: string;
  logPath: string;
}) {
  if (process.platform === "win32") {
    const script = buildWindowsFreshShellVersionCheckScript({
      expectedNeedle: params.expectedNeedle,
    });
    const result = await runPowerShellScript(script, {
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
    const cliPath = normalizeWindowsInstalledCliPath(
      parseMarkerLine(result.stdout, "__OPENCLAW_PATH__=") ?? "",
    );
    if (!cliPath) {
      throw new Error("Failed to resolve installed openclaw path from fresh Windows shell.");
    }
    return {
      cliPath,
      versionOutput: `${result.stdout}\n${result.stderr}`.trim(),
    };
  }

  const script = [
    "set -euo pipefail",
    'if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi',
    "command -v openclaw >/dev/null 2>&1",
    'printf "__OPENCLAW_PATH__=%s\\n" "$(command -v openclaw)"',
    "openclaw --version",
  ].join("\n");
  const result = await runPosixShellScript(script, {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  const cliPath = parseMarkerLine(result.stdout, "__OPENCLAW_PATH__=");
  const versionOutput = `${result.stdout}\n${result.stderr}`.trim();
  if (!cliPath) {
    throw new Error("Failed to resolve installed openclaw path from fresh POSIX shell.");
  }
  if (params.expectedNeedle && !versionOutput.includes(params.expectedNeedle)) {
    throw new Error(
      `Installed CLI version did not contain expected substring ${params.expectedNeedle}.`,
    );
  }
  return { cliPath, versionOutput };
}

export async function runInstalledCli(params: {
  cliPath: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  timeoutMs?: number;
  check?: boolean;
}) {
  const invocation = resolveInstalledCliInvocation(params.cliPath, params.args, {
    env: params.env,
    platform: process.platform,
  });
  return runCommandInvocation(invocation, {
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: params.timeoutMs,
    check: params.check ?? true,
  });
}

export async function resolveInstalledGatewayStopArgs(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const help = await runInstalledCli({
    cliPath: params.cliPath,
    args: ["gateway", "stop", "--help"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 15_000,
  });
  return buildGatewayStopArgsFromHelpText(`${help.stdout}\n${help.stderr}`);
}

async function readInstalledUpdateStatus(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  return runInstalledCli({
    cliPath: params.cliPath,
    args: ["update", "status", "--json"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
}

export async function ensureDevUpdateGitInstall(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  cliPath: string;
  logsDir: string;
  requestedRef: string;
}) {
  const updateStatus = await readInstalledUpdateStatus({
    cliPath: params.cliPath,
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: join(params.logsDir, "dev-update-status.log"),
  });
  // The dev-update lane must prove that `openclaw update --channel dev` landed on
  // the expected git checkout. Falling back to a manual repair here would hide
  // updater regressions and turn the suite into a false green.
  verifyDevUpdateStatus(updateStatus.stdout, { ref: params.requestedRef });
  return { cliPath: params.cliPath };
}

export async function runOnboardWithInstalledCli(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  providerConfig: ProviderConfig;
  installDaemon: boolean;
  logPath: string;
  allocateGatewayPort?: boolean;
}) {
  const runOnboard = async () => {
    const args = buildReleaseOnboardArgs({
      authChoice: params.providerConfig.authChoice,
      gatewayPort: params.lane.gatewayPort,
      installDaemon: params.installDaemon,
      skipHealth: !params.installDaemon || shouldSkipInstallerDaemonHealthCheck(),
    });
    await runInstalledCli({
      cliPath: params.cliPath,
      args,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 10 * 60 * 1000,
    });
  };
  if (params.allocateGatewayPort === false) {
    if (params.lane.gatewayPort <= 0) {
      throw new Error("Installed onboarding requires a reserved gateway port.");
    }
    await runOnboard();
    return;
  }
  await withAllocatedGatewayPort(params.lane, runOnboard);
}

export function buildReleaseOnboardArgs(params: {
  authChoice: string;
  gatewayPort: number;
  installDaemon?: boolean;
  skipHealth?: boolean;
}) {
  const args: string[] = [
    "onboard",
    "--non-interactive",
    "--mode",
    "local",
    "--auth-choice",
    params.authChoice,
    "--secret-input-mode",
    "ref",
    "--gateway-port",
    String(params.gatewayPort),
    "--gateway-bind",
    "loopback",
    "--skip-skills",
    "--skip-bootstrap",
    "--accept-risk",
    "--json",
  ];
  if (params.installDaemon) {
    args.push("--install-daemon");
  }
  if (params.skipHealth) {
    args.push("--skip-health");
  }
  return args;
}

export async function startManualGatewayFromInstalledCli(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}): Promise<GatewayHandle> {
  mkdirSync(dirname(params.logPath), { recursive: true });
  const gatewayLog = createWriteStream(params.logPath, { flags: "a" });
  const invocation = resolveInstalledCliInvocation(
    params.cliPath,
    ["gateway", "run", "--bind", "loopback", "--port", String(params.lane.gatewayPort), "--force"],
    {
      env: params.env,
      platform: process.platform,
    },
  );
  const child = spawn(invocation.command, invocation.args, {
    cwd: params.lane.homeDir,
    env: params.env,
    shell: invocation.shell,
    stdio: ["ignore", "pipe", "pipe"],
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    windowsHide: true,
  });
  child.stdout?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  child.stderr?.on("data", (chunk) => {
    gatewayLog.write(chunk);
  });
  let logClosed = false;
  const closeLog = async () => {
    if (logClosed) {
      return;
    }
    logClosed = true;
    await new Promise<void>((resolvePromise) => {
      gatewayLog.once("error", () => resolvePromise());
      gatewayLog.end(() => resolvePromise());
    });
  };
  child.once("close", () => {
    void closeLog();
  });
  child.once("error", () => {
    void closeLog();
  });
  return { child, closeLog, logPath: params.logPath };
}

async function resolveInstalledGatewayStatusArgs(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  requireRpc?: boolean;
}) {
  const requireRpc = params.requireRpc !== false;
  try {
    const help = await runInstalledCli({
      cliPath: params.cliPath,
      args: ["gateway", "status", "--help"],
      cwd: params.cwd,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 15_000,
      check: false,
    });
    return buildGatewayStatusArgsFromHelpText(`${help.stdout}\n${help.stderr}`, { requireRpc });
  } catch (error) {
    appendGatewayStatusHelpProbeFallback(params.logPath, error);
    return buildGatewayStatusArgsFromHelpText("--require-rpc", { requireRpc });
  }
}

export function buildGatewayStatusArgsFromHelpText(
  helpText: string,
  options: { requireRpc?: boolean } = {},
) {
  const requireRpc = options.requireRpc !== false;
  if (requireRpc && helpText.includes("--require-rpc")) {
    return [
      "gateway",
      "status",
      "--require-rpc",
      "--timeout",
      String(CROSS_OS_GATEWAY_STATUS_RPC_TIMEOUT_MS),
    ];
  }
  return ["gateway", "status"];
}

export function buildGatewayStopArgsFromHelpText(helpText: string) {
  if (helpText.includes("--force")) {
    return ["gateway", "stop", "--force"];
  }
  return ["gateway", "stop"];
}

export function appendGatewayStatusHelpProbeFallback(logPath: string, error: unknown) {
  appendFileSync(
    logPath,
    `${new Date().toISOString()} gateway status help probe failed; assuming current --require-rpc support: ${formatError(error)}\n`,
  );
}

export async function waitForInstalledGateway(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const statusArgs = await resolveInstalledGatewayStatusArgs({
    cliPath: params.cliPath,
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
  });
  const deadline = Date.now() + gatewayReadyDeadlineMs();
  while (Date.now() < deadline) {
    const result = await runInstalledCli({
      cliPath: params.cliPath,
      args: statusArgs,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
      check: false,
    });
    if (result.exitCode === 0) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(`Gateway did not become ready on port ${params.lane.gatewayPort}.`);
}

export async function waitForInstalledGatewayToStop(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const statusArgs = await resolveInstalledGatewayStatusArgs({
    cliPath: params.cliPath,
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    requireRpc: false,
  });
  const deadline = Date.now() + gatewayReadyDeadlineMs();
  while (Date.now() < deadline) {
    await runInstalledCli({
      cliPath: params.cliPath,
      args: statusArgs,
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: CROSS_OS_GATEWAY_STATUS_COMMAND_TIMEOUT_MS,
      check: false,
    });
    const portReachable = await canConnectToLoopbackPort(params.lane.gatewayPort);
    if (!portReachable) {
      return;
    }
    await sleep(2_000);
  }
  throw new Error(
    `Managed gateway did not stop on port ${params.lane.gatewayPort} before manual fallback.`,
  );
}

export async function ensureManagedGatewayReady(params: {
  lane: LaneState;
  cliPath: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  try {
    await waitForInstalledGateway(params);
    return;
  } catch {
    await runInstalledCli({
      cliPath: params.cliPath,
      args: ["gateway", "start"],
      cwd: params.lane.homeDir,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
      check: false,
    });
  }
  await waitForInstalledGateway(params);
}

export async function runInstalledModelsSet(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  providerConfig: ProviderConfig;
  logPath: string;
}) {
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["models", "set", params.providerConfig.model],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  const providerConfigOverride = buildReleaseProviderConfigOverride(params.providerConfig);
  if (providerConfigOverride) {
    await runInstalledCli({
      cliPath: params.cliPath,
      args: [
        "config",
        "set",
        `models.providers.${params.providerConfig.extensionId}`,
        JSON.stringify(providerConfigOverride),
        "--strict-json",
        "--merge",
      ],
      cwd: params.cwd,
      env: params.env,
      logPath: params.logPath,
      timeoutMs: 2 * 60 * 1000,
    });
  }
  await runInstalledCli({
    cliPath: params.cliPath,
    args: [
      "config",
      "set",
      "plugins.allow",
      JSON.stringify(buildCrossOsReleaseSmokePluginAllowlist(params.providerConfig)),
      "--strict-json",
    ],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: buildCrossOsReleaseSmokeMemorySlotConfigArgs(),
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "agents.defaults.skipBootstrap", "true", "--strict-json"],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  await runInstalledCli({
    cliPath: params.cliPath,
    args: ["config", "set", "tools.profile", CROSS_OS_RELEASE_SMOKE_TOOLS_PROFILE],
    cwd: params.cwd,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
}

export async function runInstalledAgentTurn(params: {
  cliPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
  logPath: string;
}): Promise<AgentTurnResult> {
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const sessionId = buildCrossOsReleaseAgentSessionId(params.label, attempt);
    try {
      const logOffset = readLogFileSize(params.logPath);
      const result = await runInstalledCli({
        cliPath: params.cliPath,
        args: buildReleaseAgentTurnArgs(sessionId),
        cwd: params.cwd,
        env: params.env,
        logPath: params.logPath,
        timeoutMs: (CROSS_OS_AGENT_TURN_TIMEOUT_SECONDS + 60) * 1000,
      });
      const logText = readLogTextSince(params.logPath, logOffset);
      if (!agentOutputHasExpectedOkMarker(result.stdout, { logText })) {
        throw new Error("Agent output did not contain the expected OK marker.");
      }
      return result;
    } catch (error) {
      lastError = error;
      const skipped = maybeBuildOptionalAgentTurnSkipResult(error, params.logPath, {
        attempt,
        maxAttempts: 2,
      });
      if (skipped) {
        return skipped;
      }
      if (attempt >= 2 || !shouldRetryCrossOsAgentTurnError(error)) {
        throw error;
      }
      appendFileSync(
        params.logPath,
        `\n[release-checks] retrying installed agent turn after retryable live failure: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  throw lastError;
}

export function verifyDevUpdateStatus(stdout: string, options: { ref?: string } = {}) {
  let payload;
  try {
    payload = JSON.parse(stdout) as {
      update?: { installKind?: string; git?: { branch?: string; sha?: string } };
      channel?: { value?: string; channel?: string };
      installKind?: string;
      git?: { branch?: string; sha?: string };
    };
  } catch {
    payload = null;
  }
  const expectedRef = resolveExpectedDevUpdateRef(options.ref);
  const update = payload?.update ?? payload;
  const installKind = update?.installKind ?? null;
  const branch = update?.git?.branch ?? null;
  const sha = update?.git?.sha ?? null;
  const channelValue = payload?.channel?.value ?? payload?.channel?.channel ?? null;
  if (installKind !== "git") {
    throw new Error(
      `Dev update did not land on a git install. Found ${installKind ?? "<missing>"}.`,
    );
  }
  if (channelValue !== "dev") {
    throw new Error(
      `Dev update status did not report channel=dev. Found ${channelValue ?? "<missing>"}.`,
    );
  }
  if (looksLikeCommitSha(expectedRef)) {
    const normalizedSha = typeof sha === "string" ? sha.toLowerCase() : "";
    const normalizedExpectedRef = expectedRef.toLowerCase();
    if (!normalizedSha || !normalizedSha.startsWith(normalizedExpectedRef)) {
      throw new Error(
        `Dev update status did not report sha=${expectedRef}. Found ${sha ?? "<missing>"}.`,
      );
    }
    return;
  }
  if (branch !== expectedRef) {
    throw new Error(
      `Dev update status did not report branch=${expectedRef}. Found ${branch ?? "<missing>"}.`,
    );
  }
}

export async function verifyWindowsDevUpdateToolchain(params: {
  lane: LaneState;
  env: NodeJS.ProcessEnv;
  logPath: string;
}) {
  const script = buildWindowsDevUpdateToolchainCheckScript();
  const result = await runPowerShellScript(script, {
    cwd: params.lane.homeDir,
    env: params.env,
    logPath: params.logPath,
    timeoutMs: 2 * 60 * 1000,
  });
  if (!parseMarkerLine(result.stdout, "__UPDATE_TOOL__=")) {
    throw new Error(
      "No Windows update bootstrap tool (pnpm, corepack, or npm) was discoverable after the dev update.",
    );
  }
}
