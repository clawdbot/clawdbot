#!/usr/bin/env -S pnpm tsx
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { windowsAgentWorkspaceScript } from "./agent-workspace.ts";
import {
  die,
  ensureValue,
  makeTempDir,
  packageBuildCommitFromTgz,
  packageVersionFromTgz,
  packOpenClaw,
  parseMode,
  parseProvider,
  resolveHostIp,
  resolveHostPort,
  resolveLatestVersion,
  resolveParallelsModelTimeoutSeconds,
  resolveWindowsProviderAuth,
  resolveSnapshot,
  run,
  say,
  startHostServer,
  warn,
  writeSummaryMarkdown,
  writeJson,
  type HostServer,
  type Mode,
  type PackageArtifact,
  type Provider,
  type ProviderAuth,
  type SnapshotInfo,
} from "./common.ts";
import { runWindowsBackgroundPowerShell, WindowsGuest } from "./guest-transports.ts";
import { runSmokeLane, type SmokeLane, type SmokeLaneStatus } from "./lane-runner.ts";
import { waitForVmStatus } from "./parallels-vm.ts";
import { PhaseRunner } from "./phase-runner.ts";
import {
  psSingleQuote,
  windowsAgentTurnConfigPatchScript,
  windowsOpenClawResolver,
  windowsScopedEnvFunction,
} from "./powershell.ts";
import { ensureGuestGit, prepareMinGitZip } from "./windows-git.ts";

interface WindowsOptions {
  vmName: string;
  snapshotHint: string;
  mode: Mode;
  provider: Provider;
  apiKeyEnv?: string;
  modelId?: string;
  installUrl: string;
  hostPort: number;
  hostPortExplicit: boolean;
  hostIp?: string;
  latestVersion?: string;
  installVersion?: string;
  targetPackageSpec?: string;
  upgradeFromPackedMain: boolean;
  skipLatestRefCheck: boolean;
  keepServer: boolean;
  json: boolean;
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
  --skip-latest-ref-check    Skip latest-release ref-mode precheck.
  --keep-server              Leave temp host HTTP server running.
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
`;
}

function parseArgs(argv: string[]): WindowsOptions {
  const options = defaultOptions();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--":
        break;
      case "--vm":
        options.vmName = ensureValue(argv, i, arg);
        i++;
        break;
      case "--snapshot-hint":
        options.snapshotHint = ensureValue(argv, i, arg);
        i++;
        break;
      case "--mode":
        options.mode = parseMode(ensureValue(argv, i, arg));
        i++;
        break;
      case "--provider":
        options.provider = parseProvider(ensureValue(argv, i, arg));
        i++;
        break;
      case "--model":
        options.modelId = ensureValue(argv, i, arg);
        i++;
        break;
      case "--api-key-env":
      case "--openai-api-key-env":
        options.apiKeyEnv = ensureValue(argv, i, arg);
        i++;
        break;
      case "--install-url":
        options.installUrl = ensureValue(argv, i, arg);
        i++;
        break;
      case "--host-port":
        options.hostPort = Number(ensureValue(argv, i, arg));
        options.hostPortExplicit = true;
        i++;
        break;
      case "--host-ip":
        options.hostIp = ensureValue(argv, i, arg);
        i++;
        break;
      case "--latest-version":
        options.latestVersion = ensureValue(argv, i, arg);
        i++;
        break;
      case "--install-version":
        options.installVersion = ensureValue(argv, i, arg);
        i++;
        break;
      case "--upgrade-from-packed-main":
        options.upgradeFromPackedMain = true;
        break;
      case "--target-package-spec":
        options.targetPackageSpec = ensureValue(argv, i, arg);
        i++;
        break;
      case "--skip-latest-ref-check":
        options.skipLatestRefCheck = true;
        break;
      case "--keep-server":
        options.keepServer = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(usage());
        process.exit(0);
      default:
        die(`unknown arg: ${arg}`);
    }
  }
  return options;
}

class WindowsSmoke {
  private auth: ProviderAuth;
  private hostIp = "";
  private hostPort = 0;
  private runDir = "";
  private tgzDir = "";
  private server: HostServer | null = null;
  private artifact: PackageArtifact | null = null;
  private minGitZipPath = "";
  private latestVersion = "";
  private installVersion = "";
  private targetExpectVersion = "";
  private snapshot!: SnapshotInfo;
  private phases!: PhaseRunner;
  private guest!: WindowsGuest;

  private status = {
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

  constructor(private options: WindowsOptions) {
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
      this.snapshot = resolveSnapshot(this.options.vmName, this.options.snapshotHint);
      this.latestVersion = resolveLatestVersion(this.options.latestVersion);
      this.installVersion = this.options.installVersion || this.latestVersion;
      this.hostIp = resolveHostIp(this.options.hostIp);
      this.hostPort = await resolveHostPort(
        this.options.hostPort,
        this.options.hostPortExplicit,
        defaultOptions().hostPort,
      );

      say(`VM: ${this.options.vmName}`);
      say(`Snapshot hint: ${this.options.snapshotHint}`);
      say(`Resolved snapshot: ${this.snapshot.name} [${this.snapshot.state}]`);
      say(`Latest npm version: ${this.latestVersion}`);
      say(
        `Current head: ${run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim()}`,
      );
      say(`Run logs: ${this.runDir}`);

      this.minGitZipPath = await prepareMinGitZip(this.tgzDir);
      if (this.needsHostTgz()) {
        this.artifact = await packOpenClaw({
          destination: this.tgzDir,
          packageSpec: this.options.targetPackageSpec,
          requireControlUi: false,
        });
        if (this.options.targetPackageSpec) {
          this.targetExpectVersion =
            this.artifact.version || (await packageVersionFromTgz(this.artifact.path));
        }
        this.server = await startHostServer({
          artifactPath: this.artifact.path,
          dir: this.tgzDir,
          hostIp: this.hostIp,
          label: this.artifactLabel(),
          port: this.hostPort,
        });
        this.hostPort = this.server.port;
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

      if (this.options.mode === "fresh" || this.options.mode === "both") {
        await this.runLane("fresh", async () => this.runFreshLane());
      }
      if (this.options.mode === "upgrade" || this.options.mode === "both") {
        await this.runLane("upgrade", async () => this.runUpgradeLane());
      }

      const summaryPath = await this.writeSummary();
      if (this.options.json) {
        process.stdout.write(await readFile(summaryPath, "utf8"));
      } else {
        this.printSummary(summaryPath);
      }
      if (this.status.freshMain === "fail" || this.status.upgrade === "fail") {
        process.exitCode = 1;
      }
    } finally {
      if (!this.options.keepServer) {
        await this.server?.stop().catch(() => undefined);
        await rm(this.tgzDir, { force: true, recursive: true }).catch(() => undefined);
      }
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

  private async runLane(name: "fresh" | "upgrade", fn: () => Promise<void>): Promise<void> {
    await runSmokeLane(name, fn, (lane, status) => this.setLaneStatus(lane, status));
  }

  private setLaneStatus(name: SmokeLane, status: SmokeLaneStatus): void {
    if (name === "fresh") {
      this.status.freshMain = status;
    } else {
      this.status.upgrade = status;
    }
  }

  private async runFreshLane(): Promise<void> {
    await this.phase("fresh.restore-snapshot", 240, () => this.restoreSnapshot());
    await this.phase("fresh.wait-for-user", 240, () => this.waitForGuestReady());
    await this.phase("fresh.ensure-git", 1200, () =>
      ensureGuestGit({ guest: this.guest, minGitZipPath: this.minGitZipPath, server: this.server }),
    );
    await this.phase("fresh.preflight", 120, () => this.logGuestPreflight(true));
    await this.phase("fresh.install-main", 420, () => this.installMain("openclaw-main-fresh.tgz"));
    this.status.freshVersion = await this.extractLastVersion("fresh.install-main");
    await this.phase("fresh.verify-main-version", 120, () => this.verifyTargetVersion());
    await this.phase("fresh.onboard-ref", 720, () => this.runRefOnboard());
    await this.phase("fresh.gateway-restart", 420, () => this.gatewayAction("restart"));
    await this.phase("fresh.gateway-status", 420, () => this.verifyGatewayReachable());
    this.status.freshGateway = "pass";
    await this.phase(
      "fresh.first-agent-turn",
      Number(process.env.OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S || 2700),
      () => this.verifyTurn(),
    );
    this.status.freshAgent = "pass";
  }

  private async runUpgradeLane(): Promise<void> {
    await this.phase("upgrade.restore-snapshot", 240, () => this.restoreSnapshot());
    await this.phase("upgrade.wait-for-user", 240, () => this.waitForGuestReady());
    await this.phase("upgrade.ensure-git", 1200, () =>
      ensureGuestGit({ guest: this.guest, minGitZipPath: this.minGitZipPath, server: this.server }),
    );
    await this.phase("upgrade.preflight", 120, () => this.logGuestPreflight(false));
    if (this.options.targetPackageSpec || this.options.upgradeFromPackedMain) {
      await this.phase("upgrade.install-baseline-package", 420, () =>
        this.installMain("openclaw-main-upgrade.tgz"),
      );
      this.status.latestInstalledVersion = await this.extractLastVersion(
        "upgrade.install-baseline-package",
      );
      await this.phase("upgrade.verify-baseline-package-version", 120, () =>
        this.verifyTargetVersion(),
      );
    } else {
      await this.phase("upgrade.install-baseline", 420, () => this.installLatestRelease());
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
    await this.phase(
      "upgrade.update-dev",
      Number(process.env.OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S || 1200),
      () => this.runDevChannelUpdate(),
    );
    this.status.upgradeVersion = await this.extractLastVersion("upgrade.update-dev");
    await this.phase("upgrade.verify-dev-channel", 120, () => this.verifyDevChannelUpdate());
    await this.phase("upgrade.gateway-stop", 420, () => this.gatewayAction("stop"));
    await this.phase("upgrade.onboard-ref", 720, () => this.runRefOnboard());
    await this.phase("upgrade.gateway-restart", 420, () => this.gatewayAction("restart"));
    await this.phase("upgrade.gateway-status", 420, () => this.verifyGatewayReachable());
    this.status.upgradeGateway = "pass";
    await this.phase(
      "upgrade.first-agent-turn",
      Number(process.env.OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S || 2700),
      () => this.verifyTurn(),
    );
    this.status.upgradeAgent = "pass";
  }

  private async phase(
    name: string,
    timeoutSeconds: number,
    fn: () => Promise<void> | void,
  ): Promise<void> {
    await this.phases.phase(name, timeoutSeconds, fn);
  }

  private remainingPhaseTimeoutMs(fallbackMs?: number): number | undefined {
    return this.phases.remainingTimeoutMs(fallbackMs);
  }

  private async phaseReturns(
    name: string,
    timeoutSeconds: number,
    fn: () => Promise<void> | void,
  ): Promise<boolean> {
    return await this.phases.phaseReturns(name, timeoutSeconds, fn);
  }

  private log(text: string): void {
    this.phases.append(text);
  }

  private guestExec(args: string[], options: { check?: boolean; timeoutMs?: number } = {}): string {
    return this.guest.exec(args, options);
  }

  private guestPowerShell(
    script: string,
    options: { check?: boolean; timeoutMs?: number } = {},
  ): string {
    return this.guest.powershell(`${windowsOpenClawResolver}\n${script}`, options);
  }

  private restoreSnapshot(): void {
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
    if (this.snapshot.state === "poweroff") {
      waitForVmStatus(this.options.vmName, "stopped", 240);
      say(`Start restored poweroff snapshot ${this.snapshot.name}`);
      run("prlctl", ["start", this.options.vmName], { quiet: true });
    }
  }

  private waitForVmNotRestoring(timeoutSeconds: number): void {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const status = run("prlctl", ["status", this.options.vmName], {
        check: false,
        quiet: true,
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

  private installLatestRelease(): void {
    const versionArg = this.installVersion ? ` -Tag ${psSingleQuote(this.installVersion)}` : "";
    this.guestPowerShell(
      `$ErrorActionPreference = 'Stop'
$script = Invoke-RestMethod -Uri ${psSingleQuote(this.options.installUrl)}
& ([scriptblock]::Create($script))${versionArg} -NoOnboard
if ($LASTEXITCODE -ne 0) { throw "installer failed with exit code $LASTEXITCODE" }
Invoke-OpenClaw --version
if ($LASTEXITCODE -ne 0) { throw "openclaw --version failed with exit code $LASTEXITCODE" }`,
      { timeoutMs: 420_000 },
    );
  }

  private installMain(tempName: string): void {
    if (!this.artifact || !this.server) {
      die("package artifact/server missing");
    }
    const tgzUrl = this.server.urlFor(this.artifact.path);
    this.guestPowerShell(
      `$ErrorActionPreference = 'Stop'
$tgz = Join-Path $env:TEMP ${psSingleQuote(tempName)}
curl.exe -fsSL ${psSingleQuote(tgzUrl)} -o $tgz
npm.cmd install -g $tgz --no-fund --no-audit --loglevel=error
if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
Invoke-OpenClaw --version
if ($LASTEXITCODE -ne 0) { throw "openclaw --version failed with exit code $LASTEXITCODE" }`,
      { timeoutMs: 420_000 },
    );
  }

  private async verifyTargetVersion(): Promise<void> {
    if (this.options.targetPackageSpec) {
      this.verifyVersionContains(this.targetExpectVersion);
      return;
    }
    if (!this.artifact) {
      die("package artifact missing");
    }
    const commit =
      this.artifact.buildCommitShort ||
      (await packageBuildCommitFromTgz(this.artifact.path)).slice(0, 7);
    this.verifyVersionContains(commit);
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
if ($LASTEXITCODE -ne 0) { throw "openclaw onboard failed with exit code $LASTEXITCODE" }`,
      720_000,
    );
  }

  private async guestPowerShellBackground(
    label: string,
    script: string,
    timeoutMs: number,
  ): Promise<void> {
    await runWindowsBackgroundPowerShell({
      append: (chunk) =>
        this.log(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")),
      beforeLaunchAttempt: () => this.waitForGuestReady(120),
      label,
      onLaunchRetry: warn,
      script: `${windowsOpenClawResolver}\n${script}`,
      timeoutMs,
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
      { timeoutMs: Number(process.env.OPENCLAW_PARALLELS_WINDOWS_UPDATE_TIMEOUT_S || 1200) * 1000 },
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
    const recoveryAfter =
      Number(process.env.OPENCLAW_PARALLELS_WINDOWS_GATEWAY_RECOVERY_AFTER_S || 180) * 1000;
    const start = Date.now();
    while (Date.now() < deadline) {
      const probe = this.guestPowerShell(
        "Invoke-OpenClaw gateway probe --url ws://127.0.0.1:18789 --timeout 30000 --json",
        { check: false, timeoutMs: 60_000 },
      );
      if (/"ok"\s*:\s*true/.test(probe)) {
        return;
      }
      if (!recoveryTried && Date.now() - start >= recoveryAfter) {
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
    'minimal',
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
      Number(process.env.OPENCLAW_PARALLELS_WINDOWS_AGENT_TIMEOUT_S || 2700) * 1000,
    );
  }

  private async extractLastVersion(phaseName: string): Promise<string> {
    const log = await readFile(path.join(this.runDir, `${phaseName}.log`), "utf8").catch(() => "");
    const matches = [...log.matchAll(/OpenClaw\s+([0-9][^\s]*)/gi)];
    return matches.at(-1)?.[1] ?? "";
  }

  private async writeSummary(): Promise<string> {
    const summary: WindowsSummary = {
      currentHead:
        this.artifact?.buildCommitShort ||
        run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim(),
      freshMain: {
        agent: this.status.freshAgent,
        gateway: this.status.freshGateway,
        status: this.status.freshMain,
        version: this.status.freshVersion,
      },
      installVersion: this.options.installVersion || "",
      latestVersion: this.latestVersion,
      mode: this.options.mode,
      provider: this.options.provider,
      runDir: this.runDir,
      snapshotHint: this.options.snapshotHint,
      snapshotId: this.snapshot.id,
      targetPackageSpec: this.options.targetPackageSpec || "",
      upgrade: {
        agent: this.status.upgradeAgent,
        gateway: this.status.upgradeGateway,
        latestVersionInstalled: this.status.latestInstalledVersion,
        mainVersion: this.status.upgradeVersion,
        precheck: this.status.upgradePrecheck,
        status: this.status.upgrade,
      },
      vm: this.options.vmName,
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

  private printSummary(summaryPath: string): void {
    process.stdout.write("\nSummary:\n");
    if (this.options.targetPackageSpec) {
      process.stdout.write(`  target-package: ${this.options.targetPackageSpec}\n`);
    }
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

await new WindowsSmoke(parseArgs(process.argv.slice(2))).run().catch((error: unknown) => {
  die(error instanceof Error ? error.message : String(error));
});
