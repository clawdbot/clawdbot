#!/usr/bin/env -S pnpm tsx
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { posixAgentWorkspaceScript } from "./agent-workspace.ts";
import {
  die,
  ensureValue,
  makeTempDir,
  packageBuildCommitFromTgz,
  packageVersionFromTgz,
  packOpenClaw,
  parseMode,
  parseProvider,
  modelProviderConfigBatchJson,
  resolveParallelsModelTimeoutSeconds,
  resolveHostIp,
  resolveHostPort,
  resolveLatestVersion,
  resolveProviderAuth,
  resolveSnapshot,
  run,
  say,
  shellQuote,
  startHostServer,
  warn,
  writeJson,
  type HostServer,
  type Mode,
  type PackageArtifact,
  type Provider,
  type ProviderAuth,
  type SnapshotInfo,
} from "./common.ts";
import { MacosGuest } from "./guest-transports.ts";
import { runSmokeLane, type SmokeLane, type SmokeLaneStatus } from "./lane-runner.ts";
import { MacosDiscordSmoke } from "./macos-discord.ts";
import { waitForVmStatus } from "./parallels-vm.ts";
import { PhaseRunner } from "./phase-runner.ts";

interface MacosOptions {
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
  skipLatestRefCheck: boolean;
  keepServer: boolean;
  json: boolean;
  discordTokenEnv?: string;
  discordGuildId?: string;
  discordChannelId?: string;
}

interface MacosSummary {
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
    dashboard: string;
    agent: string;
    discord: string;
  };
  upgrade: {
    precheck: string;
    status: string;
    path: string;
    latestVersionInstalled: string;
    mainVersion: string;
    gateway: string;
    dashboard: string;
    agent: string;
    discord: string;
  };
}

const guestPath =
  "/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
const guestOpenClaw = "/opt/homebrew/bin/openclaw";
const guestOpenClawEntry = "/opt/homebrew/lib/node_modules/openclaw/openclaw.mjs";
const guestNode = "/opt/homebrew/bin/node";
const guestNpm = "/opt/homebrew/bin/npm";

const defaultOptions = (): MacosOptions => ({
  discordChannelId: undefined,
  discordGuildId: undefined,
  discordTokenEnv: undefined,
  hostIp: undefined,
  hostPort: 18425,
  hostPortExplicit: false,
  installUrl: "https://openclaw.ai/install.sh",
  installVersion: "",
  json: false,
  keepServer: false,
  latestVersion: "",
  mode: "both",
  modelId: undefined,
  provider: "openai",
  skipLatestRefCheck: false,
  snapshotHint: "macOS 26.3.1 latest",
  targetPackageSpec: "",
  vmName: "macOS Tahoe",
});

function usage(): string {
  return `Usage: bash scripts/e2e/parallels-macos-smoke.sh [options]

Options:
  --vm <name>                Parallels VM name. Default: "macOS Tahoe"
  --snapshot-hint <name>     Snapshot name substring/fuzzy match.
                             Default: "macOS 26.3.1 latest"
  --mode <fresh|upgrade|both>
  --provider <openai|anthropic|minimax>
  --model <provider/model>    Override the model used for the agent-turn smoke.
  --api-key-env <var>        Host env var name for provider API key.
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --install-url <url>        Installer URL for latest release. Default: https://openclaw.ai/install.sh
  --host-port <port>         Host HTTP port for current-main tgz. Default: 18425
  --host-ip <ip>             Override Parallels host IP.
  --latest-version <ver>     Override npm latest version lookup.
  --install-version <ver>    Pin site-installer version/dist-tag for the baseline lane.
  --target-package-spec <npm-spec>
                             Install this npm package tarball instead of packing current main.
  --skip-latest-ref-check    Skip the known latest-release ref-mode precheck in upgrade lane.
  --keep-server              Leave temp host HTTP server running.
  --discord-token-env <var>  Host env var name for Discord bot token.
  --discord-guild-id <id>    Discord guild ID for smoke roundtrip.
  --discord-channel-id <id>  Discord channel ID for smoke roundtrip.
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
`;
}

function parseArgs(argv: string[]): MacosOptions {
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
      case "--discord-token-env":
        options.discordTokenEnv = ensureValue(argv, i, arg);
        i++;
        break;
      case "--discord-guild-id":
        options.discordGuildId = ensureValue(argv, i, arg);
        i++;
        break;
      case "--discord-channel-id":
        options.discordChannelId = ensureValue(argv, i, arg);
        i++;
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

class MacosSmoke {
  private auth: ProviderAuth;
  private discordToken = "";
  private hostIp = "";
  private hostPort = 0;
  private server: HostServer | null = null;
  private runDir = "";
  private tgzDir = "";
  private artifact: PackageArtifact | null = null;
  private targetExpectVersion = "";
  private latestVersion = "";
  private installVersion = "";
  private snapshot!: SnapshotInfo;
  private phases!: PhaseRunner;
  private guest!: MacosGuest;
  private discord: MacosDiscordSmoke | null = null;
  private guestUser = "";
  private guestTransport: "current-user" | "sudo" = "current-user";

  private status = {
    freshAgent: "skip",
    freshDashboard: "skip",
    freshDiscord: "skip",
    freshGateway: "skip",
    freshMain: "skip",
    freshVersion: "skip",
    latestInstalledVersion: "skip",
    upgrade: "skip",
    upgradeAgent: "skip",
    upgradeDashboard: "skip",
    upgradeDiscord: "skip",
    upgradeGateway: "skip",
    upgradePrecheck: "skip",
    upgradeVersion: "skip",
  };

  constructor(private options: MacosOptions) {
    this.auth = resolveProviderAuth({
      apiKeyEnv: options.apiKeyEnv,
      modelId: options.modelId,
      provider: options.provider,
    });
    this.validateDiscord();
  }

  async run(): Promise<void> {
    this.runDir = await makeTempDir("openclaw-parallels-macos.");
    this.phases = new PhaseRunner(this.runDir);
    this.guest = new MacosGuest(
      {
        getTransport: () => this.guestTransport,
        getUser: () => this.guestUser,
        path: guestPath,
        resolveDesktopHome: (user) => this.resolveDesktopHome(user),
        vmName: this.options.vmName,
      },
      this.phases,
    );
    this.discord = this.createDiscordSmoke();
    this.tgzDir = await makeTempDir("openclaw-parallels-macos-tgz.");
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
      say(
        `Discord smoke: ${this.discordEnabled() ? `guild=${this.options.discordGuildId} channel=${this.options.discordChannelId}` : "disabled"}`,
      );
      say(`Run logs: ${this.runDir}`);

      if (await this.needsHostTgz()) {
        this.artifact = await packOpenClaw({
          destination: this.tgzDir,
          packageSpec: this.options.targetPackageSpec,
          requireControlUi: true,
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
      } else if (this.targetInstallsDirectly()) {
        this.targetExpectVersion = run(
          "npm",
          [
            "view",
            this.options.targetPackageSpec || "",
            "version",
            "--userconfig",
            path.join(this.tgzDir, "npmrc"),
          ],
          { quiet: true },
        ).stdout.trim();
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
      await this.cleanupDiscordMessages().catch(() => undefined);
      await this.stopVmAfterSuccessfulDiscordSmoke().catch(() => undefined);
    }
  }

  private validateDiscord(): void {
    if (
      !this.options.discordTokenEnv &&
      !this.options.discordGuildId &&
      !this.options.discordChannelId
    ) {
      return;
    }
    if (!this.options.discordTokenEnv) {
      die("--discord-token-env is required when Discord smoke args are set");
    }
    if (!this.options.discordGuildId) {
      die("--discord-guild-id is required when Discord smoke args are set");
    }
    if (!this.options.discordChannelId) {
      die("--discord-channel-id is required when Discord smoke args are set");
    }
    this.discordToken = process.env[this.options.discordTokenEnv] ?? "";
    if (!this.discordToken) {
      die(`${this.options.discordTokenEnv} is required for Discord smoke`);
    }
  }

  private discordEnabled(): boolean {
    return Boolean(
      this.discordToken && this.options.discordGuildId && this.options.discordChannelId,
    );
  }

  private createDiscordSmoke(): MacosDiscordSmoke | null {
    if (!this.discordEnabled()) {
      return null;
    }
    return new MacosDiscordSmoke({
      config: {
        channelId: this.options.discordChannelId || "",
        guildId: this.options.discordGuildId || "",
        token: this.discordToken,
      },
      guest: this.guest,
      guestNode,
      guestOpenClaw,
      guestOpenClawEntry,
      runDir: this.runDir,
      vmName: this.options.vmName,
    });
  }

  private targetInstallsDirectly(): boolean {
    const spec = this.options.targetPackageSpec;
    return Boolean(spec && !/^(https?:|file:|\/|\.\/|\.\.\/|.*\.tgz$)/.test(spec));
  }

  private async needsHostTgz(): Promise<boolean> {
    if (!this.options.targetPackageSpec) {
      return true;
    }
    return !this.targetInstallsDirectly();
  }

  private artifactLabel(): string {
    if (this.targetInstallsDirectly()) {
      return "target package spec";
    }
    return this.options.targetPackageSpec ? "target package tgz" : "current main tgz";
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
    await this.phase("fresh.restore-snapshot", 780, () => this.restoreSnapshot());
    await this.phase("fresh.reset-state", 180, () => this.resetState());
    await this.phase("fresh.install-main", this.targetInstallsDirectly() ? 420 : 420, () =>
      this.installMain("openclaw-main-fresh.tgz"),
    );
    this.status.freshVersion = await this.extractLastVersion("fresh.install-main");
    await this.phase("fresh.verify-main-version", 60, () => this.verifyTargetVersion());
    await this.phase("fresh.verify-bundle-permissions", 180, () => this.verifyBundlePermissions());
    await this.phase("fresh.onboard-ref", 180, () => this.runRefOnboard());
    await this.phase("fresh.gateway-start", 180, () => this.startManualGatewayIfNeeded());
    await this.phase("fresh.gateway-status", 180, () => this.verifyGateway());
    this.status.freshGateway = "pass";
    await this.phase("fresh.dashboard-load", 180, () => this.verifyDashboardLoad());
    this.status.freshDashboard = "pass";
    await this.phase(
      "fresh.first-agent-turn",
      Number(process.env.OPENCLAW_PARALLELS_MACOS_AGENT_TIMEOUT_S || 2700),
      () => this.verifyTurn(),
    );
    this.status.freshAgent = "pass";
    if (this.discordEnabled()) {
      this.status.freshDiscord = "fail";
      await this.phase("fresh.discord-config", 600, () => this.configureDiscord());
      await this.phase("fresh.discord-roundtrip", 180, () => this.runDiscordRoundtrip("fresh"));
      this.status.freshDiscord = "pass";
    }
  }

  private async runUpgradeLane(): Promise<void> {
    await this.phase("upgrade.restore-snapshot", 780, () => this.restoreSnapshot());
    await this.phase("upgrade.reset-state", 180, () => this.resetState());
    await this.phase("upgrade.install-latest", 420, () => this.installLatestRelease());
    this.status.latestInstalledVersion = await this.extractLastVersion("upgrade.install-latest");
    await this.phase("upgrade.verify-latest-version", 60, () =>
      this.verifyVersionContains(this.installVersion),
    );
    if (this.options.skipLatestRefCheck) {
      this.status.upgradePrecheck = "skipped";
    } else if (
      await this.phaseReturns("upgrade.latest-ref-precheck", 180, () =>
        this.captureLatestRefFailure(),
      )
    ) {
      this.status.upgradePrecheck = "latest-ref-pass";
    } else {
      this.status.upgradePrecheck = "latest-ref-fail";
    }
    if (this.options.targetPackageSpec) {
      await this.phase("upgrade.install-main", this.targetInstallsDirectly() ? 420 : 420, () =>
        this.installMain("openclaw-main-upgrade.tgz"),
      );
      this.status.upgradeVersion = await this.extractLastVersion("upgrade.install-main");
      await this.phase("upgrade.verify-main-version", 60, () => this.verifyTargetVersion());
      await this.phase("upgrade.verify-bundle-permissions", 180, () =>
        this.verifyBundlePermissions(),
      );
    } else {
      await this.phase(
        "upgrade.update-dev",
        Number(process.env.OPENCLAW_PARALLELS_MACOS_UPDATE_DEV_TIMEOUT_S || 1800),
        () => this.runDevChannelUpdate(),
      );
      this.status.upgradeVersion = await this.extractLastVersion("upgrade.update-dev");
      await this.phase("upgrade.verify-dev-channel", 60, () => this.verifyDevChannelUpdate());
    }
    await this.phase("upgrade.onboard-ref", 180, () => this.runRefOnboard());
    await this.phase("upgrade.gateway-start", 180, () => this.startManualGatewayIfNeeded());
    await this.phase("upgrade.gateway-status", 180, () => this.verifyGateway());
    this.status.upgradeGateway = "pass";
    await this.phase("upgrade.dashboard-load", 180, () => this.verifyDashboardLoad());
    this.status.upgradeDashboard = "pass";
    await this.phase(
      "upgrade.first-agent-turn",
      Number(process.env.OPENCLAW_PARALLELS_MACOS_AGENT_TIMEOUT_S || 2700),
      () => this.verifyTurn(),
    );
    this.status.upgradeAgent = "pass";
    if (this.discordEnabled()) {
      this.status.upgradeDiscord = "fail";
      await this.phase("upgrade.discord-config", 600, () => this.configureDiscord());
      await this.phase("upgrade.discord-roundtrip", 180, () => this.runDiscordRoundtrip("upgrade"));
      this.status.upgradeDiscord = "pass";
    }
  }

  private async phase(
    name: string,
    timeoutSeconds: number,
    fn: () => Promise<void> | void,
  ): Promise<void> {
    await this.phases.phase(name, timeoutSeconds, fn);
  }

  private remainingPhaseTimeoutMs(): number | undefined {
    return this.phases.remainingTimeoutMs();
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

  private guestExec(
    args: string[],
    options: { check?: boolean; env?: Record<string, string> } = {},
  ): string {
    return this.guest.exec(args, options);
  }

  private guestSh(script: string, env: Record<string, string> = {}): string {
    return this.guest.sh(script, env);
  }

  private waitForCurrentUser(timeoutSeconds = 360): void {
    const prlctlDeadline = Date.now() + 45_000;
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < prlctlDeadline && Date.now() < deadline) {
      const result = run("prlctl", ["exec", this.options.vmName, "--current-user", "whoami"], {
        check: false,
        quiet: true,
        timeoutMs: this.remainingPhaseTimeoutMs(),
      });
      const user = result.stdout.trim().replaceAll("\r", "").split("\n").at(-1) ?? "";
      if (result.status === 0 && /^[A-Za-z0-9._-]+$/.test(user)) {
        this.guestUser = user;
        this.guestTransport = "current-user";
        return;
      }
      run("sleep", ["2"], { quiet: true });
    }
    const fallback = this.resolveDesktopUser();
    if (fallback) {
      this.guestUser = fallback;
      this.guestTransport = "sudo";
      warn(
        `desktop user unavailable via Parallels --current-user; using root sudo fallback for ${fallback}`,
      );
      return;
    }
    while (Date.now() < deadline) {
      const result = run("prlctl", ["exec", this.options.vmName, "--current-user", "whoami"], {
        check: false,
        quiet: true,
        timeoutMs: this.remainingPhaseTimeoutMs(),
      });
      const user = result.stdout.trim().replaceAll("\r", "").split("\n").at(-1) ?? "";
      if (result.status === 0 && /^[A-Za-z0-9._-]+$/.test(user)) {
        this.guestUser = user;
        this.guestTransport = "current-user";
        return;
      }
      run("sleep", ["2"], { quiet: true });
    }
    throw new Error("guest current user did not become available");
  }

  private resolveDesktopUser(): string {
    const consoleUser =
      run("prlctl", ["exec", this.options.vmName, "/usr/bin/stat", "-f", "%Su", "/dev/console"], {
        check: false,
        quiet: true,
      })
        .stdout.trim()
        .replaceAll("\r", "")
        .split("\n")
        .at(-1) ?? "";
    if (
      /^[A-Za-z0-9._-]+$/.test(consoleUser) &&
      consoleUser !== "root" &&
      consoleUser !== "loginwindow"
    ) {
      return consoleUser;
    }
    const users = run(
      "prlctl",
      ["exec", this.options.vmName, "/usr/bin/dscl", ".", "-list", "/Users", "NFSHomeDirectory"],
      {
        check: false,
        quiet: true,
      },
    ).stdout.replaceAll("\r", "");
    for (const line of users.split("\n")) {
      const [user, home] = line.trim().split(/\s+/);
      if (
        user &&
        home?.startsWith("/Users/") &&
        !user.startsWith("_") &&
        user !== "Shared" &&
        user !== ".localized"
      ) {
        return user;
      }
    }
    return "";
  }

  private resolveDesktopHome(user: string): string {
    const output = run(
      "prlctl",
      [
        "exec",
        this.options.vmName,
        "/usr/bin/dscl",
        ".",
        "-read",
        `/Users/${user}`,
        "NFSHomeDirectory",
      ],
      { check: false, quiet: true },
    ).stdout.replaceAll("\r", "");
    const match = /^NFSHomeDirectory:\s+(.+)$/m.exec(output);
    return match?.[1]?.trim() || `/Users/${user}`;
  }

  private restoreSnapshot(): void {
    say(`Restore snapshot ${this.options.snapshotHint} (${this.snapshot.id})`);
    let restored = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = run(
        "prlctl",
        ["snapshot-switch", this.options.vmName, "--id", this.snapshot.id, "--skip-resume"],
        { check: false, quiet: true, timeoutMs: 360_000 },
      );
      this.log(result.stdout);
      this.log(result.stderr);
      if (result.status === 0) {
        restored = true;
        break;
      }
      warn(`snapshot-switch attempt ${attempt} failed (rc=${result.status})`);
      const status = run("prlctl", ["status", this.options.vmName], {
        check: false,
        quiet: true,
      }).stdout;
      if (status.includes(" running") || status.includes(" suspended")) {
        run("prlctl", ["stop", this.options.vmName, "--kill"], { check: false, quiet: true });
        waitForVmStatus(this.options.vmName, "stopped", 360);
      }
      run("sleep", ["3"], { quiet: true });
    }
    if (!restored) {
      throw new Error("snapshot restore failed");
    }
    const status = run("prlctl", ["status", this.options.vmName], {
      check: false,
      quiet: true,
      timeoutMs: 60_000,
    }).stdout;
    if (this.snapshot.state === "poweroff" || status.includes(" stopped")) {
      waitForVmStatus(this.options.vmName, "stopped", 360);
      say(`Start restored poweroff snapshot ${this.snapshot.name}`);
      run("prlctl", ["start", this.options.vmName], { quiet: true });
    } else if (status.includes(" suspended")) {
      say(`Resume restored snapshot ${this.snapshot.name}`);
      run("prlctl", ["start", this.options.vmName], { quiet: true });
    }
    this.waitForCurrentUser();
  }

  private resetState(): void {
    this.guestSh(String.raw`/usr/bin/pkill -f 'openclaw.*gateway run' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw-gateway' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw.mjs gateway' >/dev/null 2>&1 || true
rm -rf "$HOME/.openclaw"
rm -f /tmp/openclaw-parallels-macos-gateway.log`);
  }

  private installLatestRelease(): void {
    this.guestSh(
      `export OPENCLAW_NO_ONBOARD=1
curl -fsSL ${shellQuote(this.options.installUrl)} -o /tmp/openclaw-install.sh
bash /tmp/openclaw-install.sh --version ${shellQuote(this.installVersion)}
${guestOpenClaw} --version`,
    );
  }

  private installMain(tempName: string): void {
    if (this.targetInstallsDirectly()) {
      this
        .guestSh(`printf 'install-source: registry-spec %s\\n' ${shellQuote(this.options.targetPackageSpec || "")}
${guestNpm} install -g ${shellQuote(this.options.targetPackageSpec || "")}
${guestOpenClaw} --version`);
      return;
    }
    if (!this.artifact || !this.server) {
      die("package artifact/server missing");
    }
    const tgzUrl = this.server.urlFor(this.artifact.path);
    this.guestSh(`printf 'install-source: host-tgz %s\\n' ${shellQuote(tgzUrl)}
curl -fsSL ${shellQuote(tgzUrl)} -o /tmp/${tempName}
${guestNpm} install -g /tmp/${tempName}
${guestOpenClaw} --version`);
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
    const version = this.guestExec([guestOpenClaw, "--version"]);
    if (!version.includes(needle)) {
      throw new Error(`version mismatch: expected substring ${needle}`);
    }
  }

  private verifyBundlePermissions(): void {
    this.guestSh(String.raw`set -eu
root=$(/opt/homebrew/bin/npm root -g)
check_path() {
  path="$1"
  [ -e "$path" ] || return 0
  perm=$(/usr/bin/stat -f '%OLp' "$path")
  perm_oct=$((8#$perm))
  if (( perm_oct & 0002 )); then
    echo "world-writable install artifact: $path ($perm)" >&2
    exit 1
  fi
}
check_path "$root/openclaw"
check_path "$root/openclaw/extensions"
if [ -d "$root/openclaw/extensions" ]; then
  while IFS= read -r -d '' extension_dir; do
    check_path "$extension_dir"
  done < <(/usr/bin/find "$root/openclaw/extensions" -mindepth 1 -maxdepth 1 -type d -print0)
fi`);
  }

  private runRefOnboard(): void {
    const daemonFlag = this.guestTransport === "sudo" ? "--skip-health" : "--install-daemon";
    this.guestExec([
      "/usr/bin/env",
      `${this.auth.apiKeyEnv}=${this.auth.apiKeyValue}`,
      guestOpenClaw,
      "onboard",
      "--non-interactive",
      "--mode",
      "local",
      "--auth-choice",
      this.auth.authChoice,
      "--secret-input-mode",
      "ref",
      "--gateway-port",
      "18789",
      "--gateway-bind",
      "loopback",
      daemonFlag,
      "--skip-skills",
      "--accept-risk",
      "--json",
    ]);
  }

  private captureLatestRefFailure(): void {
    this.runRefOnboard();
    this.showGatewayStatusCompat();
  }

  private ensureGuestPnpm(): void {
    this.guestSh(String.raw`set -eu
bootstrap_root=/tmp/openclaw-smoke-pnpm-bootstrap
bootstrap_bin="$bootstrap_root/node_modules/.bin"
if [ -x "$bootstrap_bin/pnpm" ]; then
  echo "bootstrap-pnpm: reuse"
  "$bootstrap_bin/pnpm" --version
  exit 0
fi
echo "bootstrap-pnpm: install"
rm -rf "$bootstrap_root"
mkdir -p "$bootstrap_root"
/opt/homebrew/bin/node /opt/homebrew/bin/npm install --prefix "$bootstrap_root" --no-save pnpm@10
"$bootstrap_bin/pnpm" --version`);
  }

  private runDevChannelUpdate(): void {
    this.ensureGuestPnpm();
    const home = this.guestHome();
    this.guestSh(
      `set -eu
rm -rf ${shellQuote(`${home}/openclaw`)}
export PATH=${shellQuote(`/tmp/openclaw-smoke-pnpm-bootstrap/node_modules/.bin:${guestPath}`)}
${guestNode} - <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const configPath = path.join(process.env.HOME || ${JSON.stringify(home)}, ".openclaw", "openclaw.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
config.update = { ...(config.update || {}), channel: "dev" };
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
JS
/usr/bin/env NODE_OPTIONS=--max-old-space-size=4096 OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1 OPENCLAW_DISABLE_BUNDLED_PLUGINS=1 ${guestNode} ${guestOpenClawEntry} update --channel dev --yes --json
${guestNode} ${guestOpenClawEntry} --version
${guestNode} ${guestOpenClawEntry} update status --json`,
    );
  }

  private verifyDevChannelUpdate(): void {
    const status = this.guestExec([guestNode, guestOpenClawEntry, "update", "status", "--json"]);
    for (const needle of ['"installKind": "git"', '"value": "dev"', '"branch": "main"']) {
      if (!status.includes(needle)) {
        throw new Error(`dev update status missing ${needle}`);
      }
    }
  }

  private startManualGatewayIfNeeded(): void {
    if (this.guestTransport !== "sudo") {
      return;
    }
    const home = this.guestHome();
    this.guestSh(
      `set -euo pipefail
trap '' HUP
/usr/bin/pkill -f 'openclaw.*gateway run' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw-gateway' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw.mjs gateway' >/dev/null 2>&1 || true
/usr/bin/env HOME=${shellQuote(home)} USER=${shellQuote(this.guestUser)} LOGNAME=${shellQuote(this.guestUser)} PATH=${shellQuote(guestPath)} ${shellQuote(
        `${this.auth.apiKeyEnv}=${this.auth.apiKeyValue}`,
      )} OPENCLAW_HOME=${shellQuote(home)} OPENCLAW_STATE_DIR=${shellQuote(`${home}/.openclaw`)} OPENCLAW_CONFIG_PATH=${shellQuote(
        `${home}/.openclaw/openclaw.json`,
      )} ${guestNode} ${guestOpenClawEntry} gateway run --bind loopback --port 18789 --force </dev/null >/tmp/openclaw-parallels-macos-gateway.log 2>&1 &
sleep 1`,
    );
  }

  private verifyGateway(): void {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const result = this.guestOpenClaw(
        ["gateway", "status", "--deep", "--require-rpc", "--timeout", "15000"],
        false,
      );
      if (result) {
        return;
      }
      if (attempt < 8) {
        warn(`gateway-status retry ${attempt}`);
        run("sleep", ["5"], { quiet: true });
      }
    }
    throw new Error("gateway status did not become RPC-ready");
  }

  private showGatewayStatusCompat(): void {
    const help = this.guestExec([guestOpenClaw, "gateway", "status", "--help"], { check: false });
    const args = help.includes("--require-rpc")
      ? ["gateway", "status", "--deep", "--require-rpc"]
      : ["gateway", "status", "--deep"];
    if (!this.guestOpenClaw(args, false)) {
      throw new Error("gateway status failed");
    }
  }

  private guestOpenClaw(args: string[], check: boolean): boolean {
    const result = run(
      "prlctl",
      [
        "exec",
        this.options.vmName,
        ...(this.guestTransport === "sudo"
          ? [
              "/usr/bin/sudo",
              "-H",
              "-u",
              this.guestUser,
              "/usr/bin/env",
              `HOME=${this.guestHome()}`,
              `PATH=${guestPath}`,
            ]
          : ["--current-user", "/usr/bin/env", `PATH=${guestPath}`]),
        guestOpenClaw,
        ...args,
      ],
      { check: false, quiet: true, timeoutMs: this.remainingPhaseTimeoutMs() },
    );
    this.log(result.stdout);
    this.log(result.stderr);
    if (check && result.status !== 0) {
      throw new Error(`openclaw ${args.join(" ")} failed`);
    }
    return result.status === 0;
  }

  private verifyDashboardLoad(): void {
    this.guestSh(String.raw`set -eu
deadline=$((SECONDS + 120))
while [ $SECONDS -lt $deadline ]; do
  if curl -fsSL --connect-timeout 2 --max-time 5 http://127.0.0.1:18789/ >/tmp/openclaw-dashboard-smoke.html 2>/dev/null; then
    grep -F '<title>OpenClaw Control</title>' /tmp/openclaw-dashboard-smoke.html >/dev/null &&
      grep -F '<openclaw-app></openclaw-app>' /tmp/openclaw-dashboard-smoke.html >/dev/null &&
      exit 0
  fi
  sleep 1
done
echo "dashboard HTML did not become ready" >&2
exit 1`);
  }

  private verifyTurn(): void {
    this.guestExec([guestNode, guestOpenClawEntry, "models", "set", this.auth.modelId]);
    const modelProviderConfigBatch = modelProviderConfigBatchJson(this.auth.modelId, "macos");
    if (modelProviderConfigBatch) {
      this.guestSh(`provider_config_batch="$(mktemp)"
cat >"$provider_config_batch" <<'JSON'
${modelProviderConfigBatch}
JSON
${shellQuote(guestNode)} ${shellQuote(
        guestOpenClawEntry,
      )} config set --batch-file "$provider_config_batch" --strict-json
rm -f "$provider_config_batch"`);
    }
    this.guestExec([
      guestNode,
      guestOpenClawEntry,
      "config",
      "set",
      "agents.defaults.skipBootstrap",
      "true",
      "--strict-json",
    ]);
    this.guestExec([guestNode, guestOpenClawEntry, "config", "set", "tools.profile", "minimal"]);
    this.guestSh(
      `${posixAgentWorkspaceScript("Parallels macOS smoke test assistant.")}
agent_ok=false
for attempt in 1 2; do
  session_id="parallels-macos-smoke"
  if [ "$attempt" -gt 1 ]; then session_id="parallels-macos-smoke-retry-$attempt"; fi
  rm -f "$HOME/.openclaw/agents/main/sessions/$session_id.jsonl"
  output_file="$(mktemp)"
  set +e
  /usr/bin/env ${shellQuote(`${this.auth.apiKeyEnv}=${this.auth.apiKeyValue}`)} ${guestNode} ${guestOpenClawEntry} agent --local --agent main --session-id "$session_id" --message ${shellQuote(
    "Reply with exact ASCII text OK only.",
  )} --thinking minimal --timeout ${resolveParallelsModelTimeoutSeconds("macos")} --json >"$output_file" 2>&1
  rc=$?
  set -e
  cat "$output_file"
  if [ "$rc" -ne 0 ]; then
    rm -f "$output_file"
    exit "$rc"
  fi
  if grep -Eq '"finalAssistant(Raw|Visible)Text"[[:space:]]*:[[:space:]]*"OK"' "$output_file"; then
    agent_ok=true
    rm -f "$output_file"
    break
  fi
  rm -f "$output_file"
  if [ "$attempt" -lt 2 ]; then
    echo "agent turn attempt $attempt finished without OK response; retrying"
    sleep 3
  fi
done
if [ "$agent_ok" != true ]; then
  echo "openclaw agent finished without OK response" >&2
  exit 1
fi`,
    );
  }

  private configureDiscord(): void {
    this.discord?.configure();
  }

  private async runDiscordRoundtrip(phase: "fresh" | "upgrade"): Promise<void> {
    if (!this.discord) {
      throw new Error("Discord smoke is not configured");
    }
    await this.discord.runRoundtrip(phase);
  }

  private async cleanupDiscordMessages(): Promise<void> {
    await this.discord?.cleanupMessages();
  }

  private async stopVmAfterSuccessfulDiscordSmoke(): Promise<void> {
    this.discord?.stopVmAfterSuccessfulSmoke(this.status.freshDiscord, this.status.upgradeDiscord);
  }

  private guestHome(): string {
    if (!this.guestUser) {
      this.waitForCurrentUser();
    }
    return this.guestTransport === "sudo"
      ? this.resolveDesktopHome(this.guestUser)
      : this.guestExec(["/usr/bin/id", "-P"]).split(":")[8] || `/Users/${this.guestUser}`;
  }

  private async extractLastVersion(phaseName: string): Promise<string> {
    const log = await readFile(path.join(this.runDir, `${phaseName}.log`), "utf8").catch(() => "");
    const matches = [...log.matchAll(/openclaw\s+([0-9][^\s]*)/g)];
    return matches.at(-1)?.[1] ?? "";
  }

  private upgradeSummaryLabel(): string {
    return this.options.targetPackageSpec ? "latest->target-package" : "latest->dev";
  }

  private async writeSummary(): Promise<string> {
    const summary: MacosSummary = {
      currentHead:
        this.artifact?.buildCommitShort ||
        run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim(),
      freshMain: {
        agent: this.status.freshAgent,
        dashboard: this.status.freshDashboard,
        discord: this.status.freshDiscord,
        gateway: this.status.freshGateway,
        status: this.status.freshMain,
        version: this.status.freshVersion,
      },
      installVersion: this.installVersion,
      latestVersion: this.latestVersion,
      mode: this.options.mode,
      provider: this.options.provider,
      runDir: this.runDir,
      snapshotHint: this.options.snapshotHint,
      snapshotId: this.snapshot.id,
      targetPackageSpec: this.options.targetPackageSpec || "",
      upgrade: {
        agent: this.status.upgradeAgent,
        dashboard: this.status.upgradeDashboard,
        discord: this.status.upgradeDiscord,
        gateway: this.status.upgradeGateway,
        latestVersionInstalled: this.status.latestInstalledVersion,
        mainVersion: this.status.upgradeVersion,
        path: this.upgradeSummaryLabel(),
        precheck: this.status.upgradePrecheck,
        status: this.status.upgrade,
      },
      vm: this.options.vmName,
    };
    const summaryPath = path.join(this.runDir, "summary.json");
    await writeJson(summaryPath, summary);
    return summaryPath;
  }

  private printSummary(summaryPath: string): void {
    process.stdout.write("\nSummary:\n");
    if (this.options.targetPackageSpec) {
      process.stdout.write(`  target-package: ${this.options.targetPackageSpec}\n`);
    }
    if (this.installVersion) {
      process.stdout.write(`  baseline-install-version: ${this.installVersion}\n`);
    }
    process.stdout.write(
      `  fresh-main: ${this.status.freshMain} (${this.status.freshVersion}) discord=${this.status.freshDiscord}\n`,
    );
    process.stdout.write(
      `  latest precheck: ${this.status.upgradePrecheck} (${this.status.latestInstalledVersion})\n`,
    );
    process.stdout.write(
      `  ${this.upgradeSummaryLabel()}: ${this.status.upgrade} (${this.status.upgradeVersion}) discord=${this.status.upgradeDiscord}\n`,
    );
    process.stdout.write(`  logs: ${this.runDir}\n`);
    process.stdout.write(`  summary: ${summaryPath}\n`);
  }
}

await new MacosSmoke(parseArgs(process.argv.slice(2))).run().catch((error: unknown) => {
  die(error instanceof Error ? error.message : String(error));
});
