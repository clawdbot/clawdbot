#!/usr/bin/env -S pnpm tsx
// Windows Smoke script supports OpenClaw repository automation.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { windowsAgentWorkspaceScript } from "./agent-workspace.ts";
import {
  die,
  ensureValue,
  currentRunningSnapshotInfo,
  makeTempDir,
  parseMode,
  parseTcpPort,
  parseProvider,
  readPositiveIntEnv,
  resolveLatestVersion,
  resolveParallelsModelTimeoutSeconds,
  resolveWindowsProviderAuth,
  resolveSnapshot,
  run,
  say,
  shouldSkipSnapshotRestore,
  validateSnapshotRestoreMode,
  warn,
  withProgressOnStderr,
  writeSummaryMarkdown,
  writeJson,
  type Mode,
  type PackageArtifact,
  type Provider,
  type ProviderAuth,
  type SnapshotInfo,
} from "./common.ts";
import { runWindowsBackgroundPowerShell, WindowsGuest } from "./guest-transports.ts";
import { startHostServer } from "./host-server.ts";
import { ensureVmRunning } from "./parallels-vm.ts";
import { PhaseRunner } from "./phase-runner.ts";
import {
  windowsCodexPlatformPackageRepairFunction,
  windowsProviderOnlyPluginIsolationScript,
} from "./plugin-isolation.ts";
import {
  psSingleQuote,
  windowsAgentTurnConfigPatchScript,
  windowsOpenClawResolver,
  windowsScopedEnvFunction,
} from "./powershell.ts";
import {
  buildCommonSmokeSummary,
  expectedPackageBuildCommit,
  expectedPackageTargetVersion,
  extractLastOpenClawVersion,
  packAndServeSmokeArtifact,
  printSmokeTargetSummary,
  SmokeRunController,
  type SmokeHostOptions,
  type SmokeRunOptions,
} from "./smoke-common.ts";
import { ensureGuestGit, prepareMinGitZip } from "./windows-git.ts";

interface WindowsOptions extends SmokeHostOptions, SmokeRunOptions {
  vmName: string;
  apiKeyEnv?: string;
  modelId?: string;
  installUrl: string;
  latestVersion?: string;
  upgradeFromPackedMain: boolean;
  skipLatestRefCheck: boolean;
}

interface WindowsSummary {
  vm: string;
  snapshotHint: string;
  snapshotId: string;
  mode: Mode;
  provider: Provider;
  latestVersion: string;
  installVersion: string;
  targetPackageSpec: string;
  currentHead: string;
  runDir: string;
  freshMain: {
    status: string;
    version: string;
    gateway: string;
    agent: string;
  };
  upgrade: {
    precheck: string;
    status: string;
    latestVersionInstalled: string;
    mainVersion: string;
    gateway: string;
    agent: string;
  };
}

const WINDOWS_PACKAGE_INSTALL_TIMEOUT_SECONDS = 900;
const WINDOWS_PACKAGE_INSTALL_TIMEOUT_MS = WINDOWS_PACKAGE_INSTALL_TIMEOUT_SECONDS * 1000;

const defaultOptions = (): WindowsOptions => ({
  hostIp: undefined,
  hostPort: 18426,
  hostPortExplicit: false,
  installUrl: "https://openclaw.ai/install.ps1",
  installVersion: "",
  json: false,
  keepServer: false,
  latestVersion: "",
  mode: "both",
  modelId: undefined,
  npmRegistry: undefined,
  provider: "openai",
  skipLatestRefCheck: false,
  snapshotHint: "pre-openclaw-native-e2e-2026-03-12",
  targetPackageSpec: "",
  upgradeFromPackedMain: false,
  vmName: "Windows 11",
});

const windowsPortableGitPathScript = `$portableGit = Join-Path (Join-Path (Join-Path $env:LOCALAPPDATA 'OpenClaw\\deps') 'portable-git') ''
$env:PATH = "$portableGit\\cmd;$portableGit\\mingw64\\bin;$portableGit\\usr\\bin;$env:PATH"
where.exe git.exe`;

function usage(): string {
  return `Usage: bash scripts/e2e/parallels-windows-smoke.sh [options]

Options:
  --vm <name>                Parallels VM name. Default: "Windows 11"
  --snapshot-hint <name>     Snapshot name substring/fuzzy match.
                             Default: "pre-openclaw-native-e2e-2026-03-12"
  --mode <fresh|upgrade|both>
  --provider <openai|anthropic|minimax>
  --model <provider/model>    Override the model used for the agent-turn smoke.
  --api-key-env <var>        Host env var name for provider API key.
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --install-url <url>        Installer URL for latest release. Default: https://openclaw.ai/install.ps1
  --host-port <port>         Host HTTP port for current-main tgz. Default: 18426
  --host-ip <ip>             Override Parallels host IP.
  --latest-version <ver>     Override npm latest version lookup.
  --install-version <ver>    Pin site-installer version/dist-tag for the baseline lane.
  --upgrade-from-packed-main
                             Upgrade lane: install packed current-main npm tgz as baseline,
                             then run openclaw update --channel dev.
  --target-package-spec <npm-spec>
                             Install this npm package tarball instead of packing current main.
  --npm-registry <url>       Registry used for target package installs.
  --skip-latest-ref-check    Skip latest-release ref-mode precheck.
  --keep-server              Leave temp host HTTP server running.
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
`;
}

export function parseArgs(argv: string[]): WindowsOptions {
  const args = stripLeadingPackageManagerSeparator(argv);
  const options = defaultOptions();
  const valueHandlers: Record<string, (value: string) => void> = {
    "--api-key-env": (value) => {
      options.apiKeyEnv = value;
    },
    "--host-ip": (value) => {
      options.hostIp = value;
    },
    "--host-port": (value) => {
      options.hostPort = parseTcpPort(value, "--host-port");
      options.hostPortExplicit = true;
    },
    "--install-url": (value) => {
      options.installUrl = value;
    },
    "--install-version": (value) => {
      options.installVersion = value;
    },
    "--latest-version": (value) => {
      options.latestVersion = value;
    },
    "--model": (value) => {
      options.modelId = value;
    },
    "--npm-registry": (value) => {
      options.npmRegistry = value;
    },
    "--openai-api-key-env": (value) => {
      options.apiKeyEnv = value;
    },
    "--provider": (value) => {
      options.provider = parseProvider(value);
    },
    "--snapshot-hint": (value) => {
      options.snapshotHint = value;
    },
    "--target-package-spec": (value) => {
      options.targetPackageSpec = value;
    },
    "--vm": (value) => {
      options.vmName = value;
    },
    "--mode": (value) => {
      options.mode = parseMode(value);
    },
  };
  const flagHandlers: Record<string, () => void> = {
    "--json": () => {
      options.json = true;
    },
    "--keep-server": () => {
      options.keepServer = true;
    },
    "--skip-latest-ref-check": () => {
      options.skipLatestRefCheck = true;
    },
    "--upgrade-from-packed-main": () => {
      options.upgradeFromPackedMain = true;
    },
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      break;
    }
    const valueHandler = valueHandlers[arg];
    if (valueHandler) {
      valueHandler(ensureValue(args, i, arg));
      i++;
      continue;
    }
    const flagHandler = flagHandlers[arg];
    if (flagHandler) {
      flagHandler();
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(usage());
      process.exit(0);
    }
    die(`unknown arg: ${arg}`);
  }
  return options;
}

function stripLeadingPackageManagerSeparator(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

class WindowsSmoke extends SmokeRunController<WindowsOptions> {
  private auth: ProviderAuth;
  private agentTimeoutSeconds = readPositiveIntEnv(
    "OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S",
    2700,
  );
  private updateTimeoutSeconds = readPositiveIntEnv(
    "OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S",
    1200,
  );
  private gatewayRecoveryAfterMs =
    readPositiveIntEnv("OPENCLAW_PARALLELS_WINDOWS_GATEWAY_RECOVERY_AFTER_S", 180) * 1000;
  private artifact: PackageArtifact | null = null;
  private minGitZipPath = "";
  private latestVersion = "";
  private installVersion = "";
  private snapshot!: SnapshotInfo;
  private phases!: PhaseRunner;
  private guest!: WindowsGuest;

  protected status = {
    freshAgent: "skip",
    freshGateway: "skip",
    freshMain: "skip",
    freshVersion: "skip",
    latestInstalledVersion: "skip",
    upgrade: "skip",
    upgradeAgent: "skip",
    upgradeGateway: "skip",
    upgradePrecheck: "skip",
    upgradeVersion: "skip",
  };

  constructor(options: WindowsOptions) {
    super(options);
    this.auth = resolveWindowsProviderAuth({
      apiKeyEnv: options.apiKeyEnv,
      modelId: options.modelId,
      provider: options.provider,
    });
  }

  async run(): Promise<void> {
    this.runDir = await makeTempDir("openclaw-parallels-windows.");
    this.phases = new PhaseRunner(this.runDir);
    this.guest = new WindowsGuest(this.options.vmName, this.phases);
    this.tgzDir = await makeTempDir("openclaw-parallels-windows-tgz.");
    try {
      validateSnapshotRestoreMode(this.options.mode, "Windows smoke");
      this.snapshot = shouldSkipSnapshotRestore()
        ? currentRunningSnapshotInfo(this.options.vmName)
        : resolveSnapshot(this.options.vmName, this.options.snapshotHint);
      this.latestVersion = resolveLatestVersion(this.options.latestVersion);
      this.installVersion = this.options.installVersion || this.latestVersion;
      await this.prepareHost(
        defaultOptions().hostPort,
        this.latestVersion,
        this.snapshot,
        this.options.vmName,
      );

      this.minGitZipPath = await prepareMinGitZip(this.tgzDir);
      if (this.needsHostTgz()) {
        [this.artifact, this.server, this.hostPort] = await packAndServeSmokeArtifact(
          this.tgzDir,
          this.options.targetPackageSpec,
          this.hostIp,
          this.hostPort,
          this.artifactLabel(),
        );
      }
      if (!this.server) {
        this.server = await startHostServer({
          artifactPath: this.minGitZipPath,
          dir: this.tgzDir,
          hostIp: this.hostIp,
          label: "Windows smoke artifacts",
          port: this.hostPort,
        });
        this.hostPort = this.server.port;
      }

      await this.runLanesAndFinish();
    } finally {
      await this.cleanupArtifacts();
    }
  }

  private needsHostTgz(): boolean {
    return (
      this.options.mode === "fresh" ||
      this.options.mode === "both" ||
      this.options.upgradeFromPackedMain ||
      Boolean(this.options.targetPackageSpec)
    );
  }

  private artifactLabel(): string {
    if (
      !this.options.targetPackageSpec &&
      this.options.mode === "upgrade" &&
      !this.options.upgradeFromPackedMain
    ) {
      return "Windows smoke artifacts";
    }
    if (this.options.targetPackageSpec) {
      return "baseline package tgz";
    }
    if (this.options.upgradeFromPackedMain) {
      return "packed main tgz";
    }
    return "current main tgz";
  }

  private upgradeSummaryLabel(): string {
    if (this.options.targetPackageSpec) {
      return "target-package->dev";
    }
    return this.options.upgradeFromPackedMain ? "packed-main->dev" : "latest->dev";
  }

  protected async runFreshLane(): Promise<void> {
    await this.phase("fresh.restore-snapshot", 240, () => this.restoreSnapshot());
    await this.phase("fresh.wait-for-user", 240, () => this.waitForGuestReady());
    await this.phase("fresh.ensure-git", 1200, () =>
      ensureGuestGit({ guest: this.guest, minGitZipPath: this.minGitZipPath, server: this.server }),
    );
    await this.phase("fresh.preflight", 120, () => this.logGuestPreflight(true));
    await this.phase("fresh.install-main", WINDOWS_PACKAGE_INSTALL_TIMEOUT_SECONDS, () =>
      this.installMain("openclaw-main-fresh.tgz"),
    );
    this.status.freshVersion = await this.extractLastVersion("fresh.install-main");
    await this.phase("fresh.verify-main-version", 120, () => this.verifyTargetVersion());
    await this.phase("fresh.onboard-ref", 720, () => this.runRefOnboard());
    await this.phase("fresh.gateway-restart", 420, () => this.gatewayAction("restart"));
    await this.phase("fresh.gateway-status", 420, () => this.verifyGatewayReachable());
    this.status.freshGateway = "pass";
    await this.phase("fresh.first-agent-turn", this.agentTimeoutSeconds, () => this.verifyTurn());
    this.status.freshAgent = "pass";
  }

  protected async runUpgradeLane(): Promise<void> {
    await this.phase("upgrade.restore-snapshot", 240, () => this.restoreSnapshot());
    await this.phase("upgrade.wait-for-user", 240, () => this.waitForGuestReady());
    await this.phase("upgrade.ensure-git", 1200, () =>
      ensureGuestGit({ guest: this.guest, minGitZipPath: this.minGitZipPath, server: this.server }),
    );
    await this.phase("upgrade.preflight", 120, () => this.logGuestPreflight(false));
    if (this.options.targetPackageSpec || this.options.upgradeFromPackedMain) {
      await this.phase(
        "upgrade.install-baseline-package",
        WINDOWS_PACKAGE_INSTALL_TIMEOUT_SECONDS,
        () => this.installMain("openclaw-main-upgrade.tgz"),
      );
      this.status.latestInstalledVersion = await this.extractLastVersion(
        "upgrade.install-baseline-package",
      );
      await this.phase("upgrade.verify-baseline-package-version", 120, () =>
        this.verifyTargetVersion(),
      );
    } else {
      await this.phase("upgrade.install-baseline", WINDOWS_PACKAGE_INSTALL_TIMEOUT_SECONDS, () =>
        this.installLatestRelease(),
      );
      this.status.latestInstalledVersion = await this.extractLastVersion(
        "upgrade.install-baseline",
      );
      await this.phase("upgrade.verify-baseline-version", 120, () =>
        this.verifyVersionContains(this.installVersion),
      );
    }
    if (this.options.skipLatestRefCheck) {
      this.status.upgradePrecheck = "skipped";
    } else if (
      await this.phaseReturns("upgrade.latest-ref-precheck", 720, () =>
        this.captureLatestRefFailure(),
      )
    ) {
      this.status.upgradePrecheck = "latest-ref-pass";
    } else {
      this.status.upgradePrecheck = "latest-ref-fail";
    }
    await this.phase("upgrade.gateway-stop-before-update", 420, () => this.gatewayAction("stop"));
    await this.phase("upgrade.update-dev", this.updateTimeoutSeconds, () =>
      this.runDevChannelUpdate(),
    );
    this.status.upgradeVersion = await this.extractLastVersion("upgrade.update-dev");
    await this.phase("upgrade.verify-dev-channel", 120, () => this.verifyDevChannelUpdate());
    await this.phase("upgrade.gateway-stop", 420, () => this.gatewayAction("stop"));
    await this.phase("upgrade.onboard-ref", 720, () => this.runRefOnboard());
    await this.phase("upgrade.gateway-restart", 420, () => this.gatewayAction("restart"));
    await this.phase("upgrade.gateway-status", 420, () => this.verifyGatewayReachable());
    this.status.upgradeGateway = "pass";
    await this.phase("upgrade.first-agent-turn", this.agentTimeoutSeconds, () => this.verifyTurn());
    this.status.upgradeAgent = "pass";
  }

  private phase = async (name: string, timeoutSeconds: number, fn: () => Promise<void> | void) =>
    await this.phases.phase(name, timeoutSeconds, fn);

  private remainingPhaseTimeoutMs = (fallbackMs?: number): number | undefined =>
    this.phases.remainingTimeoutMs(fallbackMs);

  private phaseReturns = async (
    name: string,
    timeoutSeconds: number,
    fn: () => Promise<void> | void,
  ): Promise<boolean> => await this.phases.phaseReturns(name, timeoutSeconds, fn);

  private log = (text: string): void => this.phases.append(text);

  private guestPowerShell(
    script: string,
    options: { check?: boolean; timeoutMs?: number } = {},
  ): string {
    return this.guest.powershell(`${windowsOpenClawResolver}\n${script}`, options);
  }

  private restoreSnapshot(): void {
    if (shouldSkipSnapshotRestore()) {
      say(`Skip snapshot restore; using current running VM ${this.options.vmName}`);
      return;
    }
    this.waitForVmNotRestoring(240);
    say(`Restore snapshot ${this.options.snapshotHint} (${this.snapshot.id})`);
    let restored = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = run(
        "prlctl",
        ["snapshot-switch", this.options.vmName, "--id", this.snapshot.id],
        {
          check: false,
          quiet: true,
          timeoutMs: this.remainingPhaseTimeoutMs(),
        },
      );
      this.log(result.stdout);
      this.log(result.stderr);
      if (result.status === 0) {
        restored = true;
        break;
      }
      if (result.stdout.includes("restoring") || result.stderr.includes("restoring")) {
        warn(`snapshot-switch retry ${attempt}: VM is still restoring`);
        this.waitForVmNotRestoring(240);
        continue;
      }
      throw new Error(`snapshot-switch failed with exit code ${result.status}`);
    }
    if (!restored) {
      throw new Error("snapshot-switch failed after restoring-state retries");
    }
    this.waitForVmNotRestoring(240);
    ensureVmRunning(this.options.vmName, 240, {
      probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000),
      transitionTimeoutMs: () => this.remainingPhaseTimeoutMs(120_000),
    });
  }

  private waitForVmNotRestoring(timeoutSeconds: number): void {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const status = run("prlctl", ["status", this.options.vmName], {
        check: false,
        quiet: true,
        timeoutMs: this.remainingPhaseTimeoutMs(30_000),
      }).stdout;
      if (!status.includes(" restoring")) {
        return;
      }
      run("sleep", ["5"], { quiet: true });
    }
    throw new Error(`VM ${this.options.vmName} did not leave restoring state`);
  }

  private waitForGuestReady(timeoutSeconds = 240): void {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const result = run(
        "prlctl",
        ["exec", this.options.vmName, "--current-user", "cmd.exe", "/d", "/s", "/c", "echo ready"],
        {
          check: false,
          quiet: true,
          timeoutMs: this.remainingPhaseTimeoutMs(),
        },
      );
      if (result.status === 0) {
        return;
      }
      run("sleep", ["3"], { quiet: true });
    }
    throw new Error("Windows guest did not become ready");
  }

  private logGuestPreflight(cleanOpenClaw: boolean): void {
    const cleanScript = cleanOpenClaw
      ? "npm.cmd uninstall -g openclaw --no-fund --no-audit --loglevel=error 2>$null; $global:LASTEXITCODE = 0"
      : "";
    this.guestPowerShell(
      `$ErrorActionPreference = 'Continue'
cmd.exe /d /s /c whoami
Write-Host "USERPROFILE=$env:USERPROFILE"
Write-Host "PATH=$env:PATH"
npm.cmd root -g
${cleanScript}`,
      { check: false, timeoutMs: 120_000 },
    );
  }

  private installLatestRelease(): Promise<void> {
    const versionArg = this.installVersion ? ` -Tag ${psSingleQuote(this.installVersion)}` : "";
    return this.guestPowerShellBackground(
      "install-latest",
      `$ErrorActionPreference = 'Stop'
$script = Invoke-RestMethod -Uri ${psSingleQuote(this.options.installUrl)} -TimeoutSec 120
& ([scriptblock]::Create($script))${versionArg} -NoOnboard
if ($LASTEXITCODE -ne 0) { throw "installer failed with exit code $LASTEXITCODE" }
Invoke-OpenClaw --version
      if ($LASTEXITCODE -ne 0) { throw "openclaw --version failed with exit code $LASTEXITCODE" }`,
      this.remainingPhaseTimeoutMs(WINDOWS_PACKAGE_INSTALL_TIMEOUT_MS) ??
        WINDOWS_PACKAGE_INSTALL_TIMEOUT_MS,
    );
  }

  private installMain(tempName: string): Promise<void> {
    if (!this.artifact || !this.server) {
      die("package artifact/server missing");
    }
    const tgzUrl = this.server.urlFor(this.artifact.path);
    const registryScript = this.options.npmRegistry
      ? `$env:NPM_CONFIG_REGISTRY = ${psSingleQuote(this.options.npmRegistry)}`
      : "";
    return this.guestPowerShellBackground(
      `install-main-${tempName.replaceAll(/[^A-Za-z0-9_-]/g, "-")}`,
      `$ErrorActionPreference = 'Stop'
$tgz = Join-Path $env:TEMP ${psSingleQuote(tempName)}
curl.exe -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 ${psSingleQuote(tgzUrl)} -o $tgz
${registryScript}
npm.cmd install -g $tgz --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
Invoke-OpenClaw --version
      if ($LASTEXITCODE -ne 0) { throw "openclaw --version failed with exit code $LASTEXITCODE" }`,
      this.remainingPhaseTimeoutMs(WINDOWS_PACKAGE_INSTALL_TIMEOUT_MS) ??
        WINDOWS_PACKAGE_INSTALL_TIMEOUT_MS,
    );
  }

  private async verifyTargetVersion(): Promise<void> {
    if (this.options.targetPackageSpec) {
      if (!this.artifact) {
        die("package artifact missing");
      }
      this.verifyVersionContains(await expectedPackageTargetVersion(this.artifact));
      return;
    }
    if (!this.artifact) {
      die("package artifact missing");
    }
    this.verifyVersionContains(await expectedPackageBuildCommit(this.artifact));
  }

  private verifyVersionContains(needle: string): void {
    const version = this.guestPowerShell("Invoke-OpenClaw --version");
    if (!version.includes(needle)) {
      throw new Error(`version mismatch: expected substring ${needle}`);
    }
  }

  private async captureLatestRefFailure(): Promise<void> {
    await this.runRefOnboard();
    this.showGatewayStatusCompat();
  }

  private runRefOnboard(): Promise<void> {
    return this.guestPowerShellBackground(
      "ref-onboard",
      `$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false
Set-Item -Path ('Env:' + ${psSingleQuote(this.auth.apiKeyEnv)}) -Value ${psSingleQuote(this.auth.apiKeyValue)}
Invoke-OpenClaw onboard --non-interactive --mode local --auth-choice ${psSingleQuote(this.auth.authChoice)} --secret-input-mode ref --gateway-port 18789 --gateway-bind loopback --install-daemon --skip-skills --skip-health --accept-risk --json
if ($LASTEXITCODE -ne 0) { throw "openclaw onboard failed with exit code $LASTEXITCODE" }
${this.windowsPluginIsolationScript()}`,
      720_000,
    );
  }

  private windowsPluginIsolationScript(): string {
    return windowsProviderOnlyPluginIsolationScript({
      fallbackPluginId: this.options.provider,
      modelId: this.auth.modelId,
    });
  }

  private async guestPowerShellBackground(
    label: string,
    script: string,
    timeoutMs: number,
  ): Promise<void> {
    await runWindowsBackgroundPowerShell({
      append: (chunk) =>
        this.log(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")),
      beforeLaunchAttempt: () => {
        ensureVmRunning(this.options.vmName, 120);
        this.waitForGuestReady(120);
      },
      label,
      onLaunchRetry: warn,
      script: `${windowsOpenClawResolver}\n${script}`,
      timeoutMs: this.remainingPhaseTimeoutMs(timeoutMs) ?? timeoutMs,
      vmName: this.options.vmName,
    });
  }

  private runDevChannelUpdate(): void {
    this.guestPowerShell(
      `$ErrorActionPreference = 'Stop'
${windowsPortableGitPathScript}
$configPath = Join-Path $env:USERPROFILE '.openclaw\\openclaw.json'
$config = Get-Content $configPath -Raw | ConvertFrom-Json
if ($null -eq $config.update) {
  $config | Add-Member -MemberType NoteProperty -Name update -Value ([pscustomobject]@{})
}
$config.update | Add-Member -Force -MemberType NoteProperty -Name channel -Value 'dev'
$config | ConvertTo-Json -Depth 100 | Set-Content -Path $configPath -Encoding utf8
${windowsScopedEnvFunction}
$script:OpenClawUpdateExit = 0
Invoke-WithScopedEnv @{ OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS = '1'; OPENCLAW_DISABLE_BUNDLED_PLUGINS = '1' } {
  Invoke-OpenClaw update --channel dev --yes --json
  $script:OpenClawUpdateExit = $LASTEXITCODE
}
if ($script:OpenClawUpdateExit -ne 0) { throw "openclaw update failed with exit code $script:OpenClawUpdateExit" }
Invoke-OpenClaw --version
Invoke-OpenClaw update status --json`,
      { timeoutMs: this.updateTimeoutSeconds * 1000 },
    );
  }

  private verifyDevChannelUpdate(): void {
    const status = this.guestPowerShell(
      `${windowsPortableGitPathScript}
Invoke-OpenClaw update status --json`,
    );
    for (const needle of ['"installKind": "git"', '"value": "dev"', '"branch": "main"']) {
      if (!status.includes(needle)) {
        throw new Error(`dev update status missing ${needle}`);
      }
    }
  }

  private gatewayAction(action: "restart" | "stop"): Promise<void> {
    return this.guestPowerShellBackground(
      `gateway-${action}`,
      `$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false
Invoke-OpenClaw gateway ${action}
if ($LASTEXITCODE -ne 0) { throw "gateway ${action} failed with exit code $LASTEXITCODE" }`,
      420_000,
    );
  }

  private verifyGatewayReachable(): void {
    const deadline = Date.now() + 420_000;
    let attempt = 1;
    let recoveryTried = false;
    const start = Date.now();
    while (Date.now() < deadline) {
      const probe = this.guestPowerShell(
        "Invoke-OpenClaw gateway probe --url ws://127.0.0.1:18789 --timeout 30000 --json",
        { check: false, timeoutMs: 60_000 },
      );
      if (/"ok"\s*:\s*true/.test(probe)) {
        return;
      }
      if (!recoveryTried && Date.now() - start >= this.gatewayRecoveryAfterMs) {
        warn(
          `gateway-reachable recovery: gateway start after ${Math.floor((Date.now() - start) / 1000)}s`,
        );
        this.guestPowerShell("Invoke-OpenClaw gateway start", {
          check: false,
          timeoutMs: 120_000,
        });
        recoveryTried = true;
      }
      warn(`gateway-reachable retry ${attempt}`);
      attempt++;
      run("sleep", ["5"], { quiet: true });
    }
    throw new Error("gateway did not become reachable");
  }

  private showGatewayStatusCompat(): void {
    const help = this.guestPowerShell("Invoke-OpenClaw gateway status --help", {
      check: false,
    });
    const suffix = help.includes("--require-rpc") ? "--deep --require-rpc" : "--deep";
    this.guestPowerShell(`Invoke-OpenClaw gateway status ${suffix}`);
  }

  private verifyTurn(): Promise<void> {
    return this.guestPowerShellBackground(
      "agent-turn",
      `$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false
${windowsPortableGitPathScript}
${windowsAgentTurnConfigPatchScript(this.auth.modelId)}
${windowsAgentWorkspaceScript("Parallels Windows smoke test assistant.")}
${windowsCodexPlatformPackageRepairFunction()}
Set-Item -Path ('Env:' + ${psSingleQuote(this.auth.apiKeyEnv)}) -Value ${psSingleQuote(this.auth.apiKeyValue)}
$agentOk = $false
for ($attempt = 1; $attempt -le 2; $attempt++) {
  $sessionId = if ($attempt -eq 1) { 'parallels-windows-smoke' } else { "parallels-windows-smoke-retry-$attempt" }
  $sessionsDir = Join-Path $env:USERPROFILE '.openclaw\\agents\\main\\sessions'
  $sessionPath = Join-Path $sessionsDir "$sessionId.jsonl"
  Remove-Item $sessionPath -Force -ErrorAction SilentlyContinue
  $args = @(
    'agent',
    '--local',
    '--agent',
    'main',
    '--session-id',
    $sessionId,
    '--message',
    'Reply with exact ASCII text OK only.',
    '--thinking',
    'off',
    '--timeout',
    '${resolveParallelsModelTimeoutSeconds("windows")}',
    '--json'
  )
  $output = Invoke-OpenClaw @args 2>&1
  $agentExitCode = $LASTEXITCODE
  if ($null -ne $output) { $output | ForEach-Object { $_ } }
  if ($agentExitCode -eq 0 -and ($output | Out-String) -match '"finalAssistant(Raw|Visible)Text":\\s*"OK"') {
    $agentOk = $true
    break
  }
  if ($agentExitCode -ne 0 -and $attempt -lt 2 -and (Repair-MissingCodexPlatformPackage -Output $output)) {
    Write-Host "agent turn attempt $attempt hit a missing Codex platform package; retrying"
    continue
  }
  if ($attempt -lt 2) {
    Write-Host "agent turn attempt $attempt failed or finished without OK response; retrying"
    Start-Sleep -Seconds 3
    continue
  }
  if ($agentExitCode -ne 0) {
    throw "agent failed with exit code $agentExitCode"
  }
}
if (-not $agentOk) { throw 'openclaw agent finished without OK response' }`,
      this.agentTimeoutSeconds * 1000,
    );
  }

  private async extractLastVersion(phaseName: string): Promise<string> {
    return await extractLastOpenClawVersion(this.runDir, phaseName, /OpenClaw\s+([0-9][^\s]*)/gi);
  }

  protected async writeSummary(): Promise<string> {
    const common = buildCommonSmokeSummary({
      artifact: this.artifact,
      latestVersion: this.latestVersion,
      options: this.options,
      runDir: this.runDir,
      snapshot: this.snapshot,
      status: this.status,
      vmName: this.options.vmName,
    });
    const summary: WindowsSummary = {
      ...common,
      upgrade: {
        ...common.upgrade,
        precheck: this.status.upgradePrecheck,
      },
    };
    const summaryPath = path.join(this.runDir, "summary.json");
    await writeJson(summaryPath, summary);
    await writeSummaryMarkdown({
      lines: [
        `- vm: ${summary.vm}`,
        `- target package: ${summary.targetPackageSpec || "local-main"}`,
        `- fresh: ${summary.freshMain.status} (${summary.freshMain.version}), gateway=${summary.freshMain.gateway}, agent=${summary.freshMain.agent}`,
        `- upgrade: ${summary.upgrade.status} (${summary.upgrade.mainVersion}), precheck=${summary.upgrade.precheck}, gateway=${summary.upgrade.gateway}, agent=${summary.upgrade.agent}`,
        `- logs: ${summary.runDir}`,
      ],
      summaryPath,
      title: "Parallels Windows Smoke",
    });
    return summaryPath;
  }

  protected printSummary(summaryPath: string): void {
    process.stdout.write("\nSummary:\n");
    printSmokeTargetSummary({ ...this.options, includeInstallVersion: false });
    if (this.options.upgradeFromPackedMain) {
      process.stdout.write("  upgrade-from-packed-main: yes\n");
    }
    if (this.options.installVersion) {
      process.stdout.write(`  baseline-install-version: ${this.options.installVersion}\n`);
    }
    process.stdout.write(`  fresh-main: ${this.status.freshMain} (${this.status.freshVersion})\n`);
    process.stdout.write(
      `  ${this.upgradeSummaryLabel()} precheck: ${this.status.upgradePrecheck} (${this.status.latestInstalledVersion})\n`,
    );
    process.stdout.write(
      `  ${this.upgradeSummaryLabel()}: ${this.status.upgrade} (${this.status.upgradeVersion})\n`,
    );
    process.stdout.write(`  logs: ${this.runDir}\n`);
    process.stdout.write(`  summary: ${summaryPath}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const runSmoke = () => new WindowsSmoke(options).run();
  const runPromise = options.json ? withProgressOnStderr(runSmoke) : runSmoke();
  await runPromise.catch((error: unknown) => {
    die(error instanceof Error ? error.message : String(error));
  });
}
