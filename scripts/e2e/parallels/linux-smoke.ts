#!/usr/bin/env -S pnpm tsx
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { posixAgentWorkspaceScript } from "./agent-workspace.ts";
import {
  die,
  ensureValue,
  makeTempDir,
  packageBuildCommitFromTgz,
  packageVersionFromTgz,
  packOpenClaw,
  parseBoolEnv,
  parseMode,
  parseProvider,
  modelProviderConfigBatchJson,
  repoRoot,
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
  writeSummaryMarkdown,
  type HostServer,
  type Mode,
  type PackageArtifact,
  type Provider,
  type ProviderAuth,
  type SnapshotInfo,
} from "./common.ts";
import { LinuxGuest } from "./guest-transports.ts";
import { runSmokeLane, type SmokeLane, type SmokeLaneStatus } from "./lane-runner.ts";
import { resolveUbuntuVmName, waitForVmStatus } from "./parallels-vm.ts";
import { PhaseRunner } from "./phase-runner.ts";

interface LinuxOptions {
  vmName: string;
  vmNameExplicit: boolean;
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
  keepServer: boolean;
  json: boolean;
}

interface LinuxSummary {
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
  daemon: string;
  freshMain: {
    status: string;
    version: string;
    gateway: string;
    agent: string;
  };
  upgrade: {
    status: string;
    latestVersionInstalled: string;
    mainVersion: string;
    gateway: string;
    agent: string;
  };
}

const defaultOptions = (): LinuxOptions => ({
  apiKeyEnv: undefined,
  hostIp: undefined,
  hostPort: 18427,
  hostPortExplicit: false,
  installUrl: "https://openclaw.ai/install.sh",
  installVersion: "",
  json: false,
  keepServer: false,
  latestVersion: "",
  mode: "both",
  modelId: undefined,
  provider: "openai",
  snapshotHint: "fresh",
  targetPackageSpec: "",
  vmName: "Ubuntu 24.04.3 ARM64",
  vmNameExplicit: false,
});

function usage(): string {
  return `Usage: bash scripts/e2e/parallels-linux-smoke.sh [options]

Options:
  --vm <name>                Parallels VM name. Default: "Ubuntu 24.04.3 ARM64"
                             Falls back to the closest Ubuntu VM when omitted and unavailable.
  --snapshot-hint <name>     Snapshot name substring/fuzzy match. Default: "fresh"
  --mode <fresh|upgrade|both>
  --provider <openai|anthropic|minimax>
                             Provider auth/model lane. Default: openai
  --model <provider/model>    Override the model used for the agent-turn smoke.
  --api-key-env <var>        Host env var name for provider API key.
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --install-url <url>        Installer URL for latest release. Default: https://openclaw.ai/install.sh
  --host-port <port>         Host HTTP port for current-main tgz. Default: 18427
  --host-ip <ip>             Override Parallels host IP.
  --latest-version <ver>     Override npm latest version lookup.
  --install-version <ver>    Pin site-installer version/dist-tag for the baseline lane.
  --target-package-spec <npm-spec>
                             Install this npm package tarball instead of packing current main.
  --keep-server              Leave temp host HTTP server running.
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
`;
}

function parseArgs(argv: string[]): LinuxOptions {
  const options = defaultOptions();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--":
        break;
      case "--vm":
        options.vmName = ensureValue(argv, i, arg);
        options.vmNameExplicit = true;
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

class LinuxSmoke {
  private auth: ProviderAuth;
  private disableBonjour = parseBoolEnv(process.env.OPENCLAW_PARALLELS_LINUX_DISABLE_BONJOUR);
  private hostIp = "";
  private hostPort = 0;
  private server: HostServer | null = null;
  private runDir = "";
  private tgzDir = "";
  private artifact: PackageArtifact | null = null;
  private latestVersion = "";
  private snapshot!: SnapshotInfo;
  private phases!: PhaseRunner;
  private guest!: LinuxGuest;

  private status = {
    daemon: "systemd-user-unavailable",
    freshAgent: "skip",
    freshGateway: "skip",
    freshMain: "skip",
    freshVersion: "skip",
    latestInstalledVersion: "skip",
    upgrade: "skip",
    upgradeAgent: "skip",
    upgradeGateway: "skip",
    upgradeVersion: "skip",
  };

  constructor(private options: LinuxOptions) {
    this.auth = resolveProviderAuth({
      apiKeyEnv: options.apiKeyEnv,
      modelId: options.modelId,
      provider: options.provider,
    });
  }

  async run(): Promise<void> {
    this.runDir = await makeTempDir("openclaw-parallels-linux.");
    this.phases = new PhaseRunner(this.runDir);
    this.tgzDir = await makeTempDir("openclaw-parallels-linux-tgz.");
    try {
      this.options.vmName = this.resolveVmName();
      this.snapshot = resolveSnapshot(this.options.vmName, this.options.snapshotHint);
      this.guest = new LinuxGuest(this.options.vmName, this.phases);
      this.latestVersion = resolveLatestVersion(this.options.latestVersion);
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

      this.artifact = await packOpenClaw({
        destination: this.tgzDir,
        packageSpec: this.options.targetPackageSpec,
        requireControlUi: false,
      });
      this.server = await startHostServer({
        artifactPath: this.artifact.path,
        dir: this.tgzDir,
        hostIp: this.hostIp,
        label: this.artifactLabel(),
        port: this.hostPort,
      });
      this.hostPort = this.server.port;

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
      }
      if (!this.options.keepServer) {
        await rm(this.tgzDir, { force: true, recursive: true }).catch(() => undefined);
      }
    }
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

  private artifactLabel(): string {
    return this.options.targetPackageSpec ? "target package tgz" : "current main tgz";
  }

  private resolveVmName(): string {
    return resolveUbuntuVmName(this.options.vmName, this.options.vmNameExplicit);
  }

  private async runFreshLane(): Promise<void> {
    await this.phase("fresh.restore-snapshot", 180, () => this.restoreSnapshot());
    await this.phase("fresh.bootstrap-guest", 600, () => this.bootstrapGuest());
    await this.phase("fresh.preflight", 90, () => this.logGuestPreflight());
    await this.phase("fresh.install-latest-bootstrap", 420, () => this.installLatestRelease());
    await this.phase("fresh.install-main", 420, () =>
      this.installMainTgz("openclaw-main-fresh.tgz"),
    );
    this.status.freshVersion = await this.extractLastVersion("fresh.install-main");
    await this.phase("fresh.verify-main-version", 90, () => this.verifyTargetVersion());
    await this.phase("fresh.onboard-ref", 180, () => this.runRefOnboard());
    await this.phase("fresh.inject-bad-plugin", 90, () => this.injectBadPluginFixture());
    await this.phase("fresh.gateway-start", 240, () => this.startGatewayBackground());
    await this.phase("fresh.bad-plugin-diagnostic", 90, () =>
      this.verifyBadPluginDiagnostic("fresh"),
    );
    await this.phase("fresh.gateway-status", 240, () => this.verifyGatewayStatus());
    this.status.freshGateway = "pass";
    await this.phase(
      "fresh.first-local-agent-turn",
      Number(process.env.OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S || 1500),
      () => this.verifyLocalTurn(),
    );
    this.status.freshAgent = "pass";
  }

  private async runUpgradeLane(): Promise<void> {
    await this.phase("upgrade.restore-snapshot", 180, () => this.restoreSnapshot());
    await this.phase("upgrade.bootstrap-guest", 600, () => this.bootstrapGuest());
    await this.phase("upgrade.preflight", 90, () => this.logGuestPreflight());
    await this.phase("upgrade.install-latest", 420, () => this.installLatestRelease());
    this.status.latestInstalledVersion = await this.extractLastVersion("upgrade.install-latest");
    await this.phase("upgrade.verify-latest-version", 90, () =>
      this.verifyVersionContains(this.latestVersion),
    );
    await this.phase("upgrade.install-main", 420, () =>
      this.installMainTgz("openclaw-main-upgrade.tgz"),
    );
    this.status.upgradeVersion = await this.extractLastVersion("upgrade.install-main");
    await this.phase("upgrade.verify-main-version", 90, () => this.verifyTargetVersion());
    await this.phase("upgrade.inject-bad-plugin", 90, () => this.injectBadPluginFixture());
    await this.phase("upgrade.onboard-ref", 180, () => this.runRefOnboard());
    await this.phase("upgrade.gateway-start", 240, () => this.startGatewayBackground());
    await this.phase("upgrade.bad-plugin-diagnostic", 90, () =>
      this.verifyBadPluginDiagnostic("upgrade"),
    );
    await this.phase("upgrade.gateway-status", 240, () => this.verifyGatewayStatus());
    this.status.upgradeGateway = "pass";
    await this.phase(
      "upgrade.first-local-agent-turn",
      Number(process.env.OPENCLAW_PARALLELS_LINUX_AGENT_TIMEOUT_S || 1500),
      () => this.verifyLocalTurn(),
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

  private remainingPhaseTimeoutMs(): number | undefined {
    return this.phases.remainingTimeoutMs();
  }

  private logGuestPreflight(): void {
    this.guestBash(String.raw`set -euo pipefail
printf 'preflight.user=%s\n' "$(whoami)"
printf 'preflight.home=%s\n' "$HOME"
printf 'preflight.path=%s\n' "$PATH"
printf 'preflight.umask=%s\n' "$(umask)"
printf 'preflight.npmRoot=%s\n' "$(npm root -g 2>/dev/null || true)"`);
  }

  private log(text: string): void {
    this.phases.append(text);
  }

  private guestExec(args: string[], options: { check?: boolean; timeoutMs?: number } = {}): string {
    return this.guest.exec(args, options);
  }

  private guestBash(script: string): string {
    return this.guest.bash(script);
  }

  private waitForGuestReady(timeoutSeconds = 180): void {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      if (
        run("prlctl", ["exec", this.options.vmName, "/usr/bin/env", "HOME=/root", "/bin/true"], {
          check: false,
          quiet: true,
          timeoutMs: this.remainingPhaseTimeoutMs(),
        }).status === 0
      ) {
        return;
      }
      run("sleep", ["2"], { quiet: true });
    }
    die(`guest did not become ready in ${this.options.vmName}`);
  }

  private restoreSnapshot(): void {
    say(`Restore snapshot ${this.options.snapshotHint} (${this.snapshot.id})`);
    run("prlctl", ["snapshot-switch", this.options.vmName, "--id", this.snapshot.id], {
      quiet: true,
    });
    if (this.snapshot.state === "poweroff") {
      waitForVmStatus(this.options.vmName, "stopped", 180);
      say(`Start restored poweroff snapshot ${this.snapshot.name}`);
      run("prlctl", ["start", this.options.vmName], { quiet: true });
    }
    this.waitForGuestReady();
  }

  private bootstrapGuest(): void {
    const hostNow = `@${Math.floor(Date.now() / 1000)}`;
    this.guestExec(["date", "-u", "-s", hostNow]);
    this.guestExec(["hwclock", "--systohc"], { check: false });
    this.guestExec(["timedatectl", "set-ntp", "true"], { check: false });
    this.guestExec(["systemctl", "restart", "systemd-timesyncd"], { check: false });
    this.guestExec([
      "apt-get",
      "-o",
      "Acquire::Check-Date=false",
      "-o",
      "DPkg::Lock::Timeout=300",
      "update",
    ]);
    this.guestExec([
      "apt-get",
      "-o",
      "DPkg::Lock::Timeout=300",
      "install",
      "-y",
      "curl",
      "ca-certificates",
    ]);
  }

  private installLatestRelease(): void {
    this.guestExec(["curl", "-fsSL", this.options.installUrl, "-o", "/tmp/openclaw-install.sh"]);
    if (this.options.installVersion) {
      this.guestExec([
        "/usr/bin/env",
        "OPENCLAW_NO_ONBOARD=1",
        "bash",
        "/tmp/openclaw-install.sh",
        "--version",
        this.options.installVersion,
        "--no-onboard",
      ]);
    } else {
      this.guestExec([
        "/usr/bin/env",
        "OPENCLAW_NO_ONBOARD=1",
        "bash",
        "/tmp/openclaw-install.sh",
        "--no-onboard",
      ]);
    }
    this.guestExec(["openclaw", "--version"]);
  }

  private installMainTgz(tempName: string): void {
    if (!this.artifact || !this.server) {
      die("package artifact/server missing");
    }
    const tgzUrl = this.server.urlFor(this.artifact.path);
    this.guestExec(["curl", "-fsSL", tgzUrl, "-o", `/tmp/${tempName}`]);
    this.guestExec(["npm", "install", "-g", `/tmp/${tempName}`, "--no-fund", "--no-audit"]);
    this.guestExec(["openclaw", "--version"]);
  }

  private async verifyTargetVersion(): Promise<void> {
    if (!this.artifact) {
      die("package artifact missing");
    }
    if (this.options.targetPackageSpec) {
      const version = this.artifact.version || (await packageVersionFromTgz(this.artifact.path));
      this.verifyVersionContains(version);
      return;
    }
    const commit =
      this.artifact.buildCommitShort ||
      (await packageBuildCommitFromTgz(this.artifact.path)).slice(0, 7);
    this.verifyVersionContains(commit);
  }

  private verifyVersionContains(needle: string): void {
    const version = this.guestExec(["openclaw", "--version"]);
    if (!version.includes(needle)) {
      throw new Error(`version mismatch: expected substring ${needle}`);
    }
  }

  private runRefOnboard(): void {
    this.guestExec([
      "/usr/bin/env",
      `${this.auth.apiKeyEnv}=${this.auth.apiKeyValue}`,
      "openclaw",
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
      "--skip-skills",
      "--skip-health",
      "--accept-risk",
      "--json",
    ]);
  }

  private injectBadPluginFixture(): void {
    this.guestBash(String.raw`set -euo pipefail
plugin_dir=/root/.openclaw/test-bad-plugin
mkdir -p "$plugin_dir"
cat >"$plugin_dir/package.json" <<'JSON'
{"name":"@openclaw/test-bad-plugin","version":"1.0.0","openclaw":{"extensions":["./index.cjs"],"setupEntry":"./setup-entry.cjs"}}
JSON
cat >"$plugin_dir/openclaw.plugin.json" <<'JSON'
{"id":"test-bad-plugin","configSchema":{"type":"object","additionalProperties":false,"properties":{}},"channels":["test-bad-plugin"]}
JSON
cat >"$plugin_dir/index.cjs" <<'JS'
module.exports = { id: "test-bad-plugin", register() {} };
JS
cat >"$plugin_dir/setup-entry.cjs" <<'JS'
module.exports = {
  kind: "bundled-channel-setup-entry",
  loadSetupPlugin() {
    throw new Error("boom: bad plugin smoke fixture");
  },
};
JS
python3 - <<'PY'
import json
from pathlib import Path
config_path = Path("/root/.openclaw/openclaw.json")
config = json.loads(config_path.read_text()) if config_path.exists() else {}
plugins = config.setdefault("plugins", {})
load = plugins.setdefault("load", {})
paths = load.setdefault("paths", [])
plugin_dir = "/root/.openclaw/test-bad-plugin"
if plugin_dir not in paths:
    paths.append(plugin_dir)
allow = plugins.get("allow")
if not isinstance(allow, list):
    allow = plugins["allow"] = ["openai"]
for plugin_id in ("test-bad-plugin", "openai"):
    if plugin_id not in allow:
        allow.append(plugin_id)
config_path.write_text(json.dumps(config, indent=2) + "\n")
PY`);
  }

  private startGatewayBackground(): void {
    const bonjourEnv = this.disableBonjour ? " OPENCLAW_DISABLE_BONJOUR=1" : "";
    this.guestBash(
      String.raw`pkill -f "openclaw gateway run" >/dev/null 2>&1 || true
rm -f /tmp/openclaw-parallels-linux-gateway.log
setsid sh -lc ` +
        shellQuote(
          `exec env OPENCLAW_HOME=/root OPENCLAW_STATE_DIR=/root/.openclaw OPENCLAW_CONFIG_PATH=/root/.openclaw/openclaw.json OPENCLAW_ALLOW_ROOT=1${bonjourEnv} ${this.auth.apiKeyEnv}=${shellQuote(
            this.auth.apiKeyValue,
          )} openclaw gateway run --bind loopback --port 18789 --force >/tmp/openclaw-parallels-linux-gateway.log 2>&1`,
        ) +
        String.raw` >/dev/null 2>&1 < /dev/null &`,
    );
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      if (this.showGatewayStatusCompat(false)) {
        return;
      }
      run("sleep", ["2"], { quiet: true });
    }
    throw new Error("gateway did not become ready");
  }

  private showGatewayStatusCompat(check = true): boolean {
    const help = this.guestExec(["openclaw", "gateway", "status", "--help"], { check: false });
    const args = help.includes("--require-rpc")
      ? ["openclaw", "gateway", "status", "--deep", "--require-rpc"]
      : ["openclaw", "gateway", "status", "--deep"];
    const result = run(
      "prlctl",
      ["exec", this.options.vmName, "/usr/bin/env", "HOME=/root", "OPENCLAW_ALLOW_ROOT=1", ...args],
      {
        check: false,
        quiet: true,
        timeoutMs: this.remainingPhaseTimeoutMs(),
      },
    );
    this.log(result.stdout);
    this.log(result.stderr);
    if (check && result.status !== 0) {
      throw new Error("gateway status failed");
    }
    return result.status === 0;
  }

  private verifyGatewayStatus(): void {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const result = run(
        "prlctl",
        [
          "exec",
          this.options.vmName,
          "/usr/bin/env",
          "HOME=/root",
          "OPENCLAW_ALLOW_ROOT=1",
          "openclaw",
          "gateway",
          "status",
          "--deep",
          "--require-rpc",
          "--timeout",
          "15000",
        ],
        { check: false, quiet: true, timeoutMs: this.remainingPhaseTimeoutMs() },
      );
      this.log(result.stdout);
      this.log(result.stderr);
      if (result.status === 0) {
        return;
      }
      if (attempt < 8) {
        warn(`gateway-status retry ${attempt}`);
        run("sleep", ["5"], { quiet: true });
      }
    }
    throw new Error("gateway status did not become RPC-ready");
  }

  private async verifyBadPluginDiagnostic(lane: "fresh" | "upgrade"): Promise<void> {
    const warning =
      "channel plugin manifest declares test-bad-plugin without channelConfigs metadata";
    const gatewayStartLog = await readFile(
      path.join(this.runDir, `${lane}.gateway-start.log`),
      "utf8",
    );
    if (!gatewayStartLog.includes(warning)) {
      throw new Error(`bad plugin diagnostic missing: ${warning}`);
    }
    this.log(warning);
    this.guestBash(String.raw`set -euo pipefail
python3 - <<'PY'
import json
from pathlib import Path
config_path = Path("/root/.openclaw/openclaw.json")
config = json.loads(config_path.read_text()) if config_path.exists() else {}
plugins = config.setdefault("plugins", {})
load = plugins.setdefault("load", {})
paths = load.get("paths")
if isinstance(paths, list):
    load["paths"] = [path for path in paths if path != "/root/.openclaw/test-bad-plugin"]
allow = plugins.get("allow")
if isinstance(allow, list):
    plugins["allow"] = [plugin_id for plugin_id in allow if plugin_id != "test-bad-plugin"]
config_path.write_text(json.dumps(config, indent=2) + "\n")
PY
rm -rf /root/.openclaw/test-bad-plugin`);
  }

  private verifyLocalTurn(): void {
    this.guestExec(["openclaw", "models", "set", this.auth.modelId]);
    const modelProviderConfigBatch = modelProviderConfigBatchJson(this.auth.modelId, "linux");
    if (modelProviderConfigBatch) {
      this.guestBash(`provider_config_batch="$(mktemp)"
cat >"$provider_config_batch" <<'JSON'
${modelProviderConfigBatch}
JSON
openclaw config set --batch-file "$provider_config_batch" --strict-json
rm -f "$provider_config_batch"`);
    }
    this.guestExec([
      "openclaw",
      "config",
      "set",
      "agents.defaults.skipBootstrap",
      "true",
      "--strict-json",
    ]);
    this.guestExec(["openclaw", "config", "set", "tools.profile", "minimal"]);
    this.prepareAgentWorkspace();
    this.guestBash(
      `agent_ok=false
for attempt in 1 2; do
  session_id="parallels-linux-smoke"
  if [ "$attempt" -gt 1 ]; then session_id="parallels-linux-smoke-retry-$attempt"; fi
  rm -f "$HOME/.openclaw/agents/main/sessions/$session_id.jsonl"
  output_file="$(mktemp)"
  set +e
  /usr/bin/env OPENCLAW_ALLOW_ROOT=1 ${shellQuote(`${this.auth.apiKeyEnv}=${this.auth.apiKeyValue}`)} openclaw agent --local --agent main --session-id "$session_id" --message ${shellQuote(
    "Reply with exact ASCII text OK only.",
  )} --thinking minimal --timeout ${resolveParallelsModelTimeoutSeconds("linux")} --json >"$output_file" 2>&1
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

  private prepareAgentWorkspace(): void {
    this.guestBash(posixAgentWorkspaceScript("Parallels Linux smoke test assistant."));
  }

  private async extractLastVersion(phaseId: string): Promise<string> {
    const text = await readFile(path.join(this.runDir, `${phaseId}.log`), "utf8").catch(() => "");
    return [...text.matchAll(/OpenClaw [^\r\n]+ \([0-9a-f]{7,}\)/g)].at(-1)?.[0] ?? "";
  }

  private async writeSummary(): Promise<string> {
    const summaryPath = path.join(this.runDir, "summary.json");
    const summary: LinuxSummary = {
      currentHead:
        this.artifact?.buildCommitShort ||
        run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim(),
      daemon: this.status.daemon,
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
        status: this.status.upgrade,
      },
      vm: this.options.vmName,
    };
    await writeJson(summaryPath, summary);
    await writeSummaryMarkdown({
      lines: [
        `- vm: ${summary.vm}`,
        `- target: ${summary.targetPackageSpec || "current main"}`,
        `- daemon: ${summary.daemon}`,
        `- fresh: ${summary.freshMain.status} ${summary.freshMain.version}`,
        `- fresh gateway/agent: ${summary.freshMain.gateway}/${summary.freshMain.agent}`,
        `- upgrade: ${summary.upgrade.status} ${summary.upgrade.mainVersion}`,
        `- logs: ${summary.runDir}`,
      ],
      summaryPath,
      title: "Linux Parallels Smoke",
    });
    return summaryPath;
  }

  private printSummary(summaryPath: string): void {
    process.stdout.write("\nSummary:\n");
    if (this.options.targetPackageSpec) {
      process.stdout.write(`  target-package: ${this.options.targetPackageSpec}\n`);
    }
    if (this.options.installVersion) {
      process.stdout.write(`  baseline-install-version: ${this.options.installVersion}\n`);
    }
    process.stdout.write(`  daemon: ${this.status.daemon}\n`);
    process.stdout.write(`  fresh-main: ${this.status.freshMain} (${this.status.freshVersion})\n`);
    process.stdout.write(
      `  latest->main: ${this.status.upgrade} (${this.status.upgradeVersion})\n`,
    );
    process.stdout.write(`  logs: ${this.runDir}\n`);
    process.stdout.write(`  summary: ${summaryPath}\n`);
  }
}

const options = parseArgs(process.argv.slice(2));
await mkdir(repoRoot, { recursive: true });
await new LinuxSmoke(options).run();
