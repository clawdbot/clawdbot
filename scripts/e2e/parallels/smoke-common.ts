// Smoke Common helper supports OpenClaw script workflows.
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { PROCESS_NODE_VERSION_CHECK } from "../../../node-version.mjs";
import { stripLeadingPackageManagerSeparator } from "../../lib/arg-utils.mts";
import { resolveProviderConfig } from "../../lib/cross-os-release-checks/config.ts";
import { parseTcpPort } from "./env-limits.ts";
import { extractLastOpenClawVersionFromLog } from "./filesystem.ts";
import { run, say, die, shellQuote } from "./host-command.ts";
import {
  resolveHostIp,
  resolveHostPort,
  startHostServer,
  startNpmRegistryServer,
} from "./host-server.ts";
import { runSmokeLane, type SmokeLane, type SmokeLaneStatus } from "./lane-runner.ts";
import {
  packageBuildCommitFromTgz,
  packageVersionFromTgz,
  packOpenClaw,
} from "./package-artifact.ts";
import { ensureValue, parseMode, parseProvider } from "./provider-auth.ts";
import type { HostServer, Mode, PackageArtifact, Provider, SnapshotInfo } from "./types.ts";

interface SmokeHostOptions {
  hostIp?: string;
  hostPort: number;
  hostPortExplicit: boolean;
}

interface SmokeRunOptions {
  installVersion?: string;
  json: boolean;
  keepServer: boolean;
  mode: Mode;
  npmRegistry?: string;
  provider: Provider;
  snapshotHint: string;
  targetPackageSpec?: string;
}

export interface SmokeCliOptions extends SmokeHostOptions, SmokeRunOptions {
  apiKeyEnv?: string;
  installUrl: string;
  latestVersion?: string;
  modelId?: string;
  vmName: string;
}

type SmokeCliParserConfig<TOptions extends SmokeCliOptions> = {
  flagHandlers?: Record<string, (options: TOptions) => void>;
  usage: () => string;
  valueHandlers?: Record<string, (options: TOptions, value: string) => void>;
};

export function parseSmokeCliArgs<TOptions extends SmokeCliOptions>(
  argv: string[],
  options: TOptions,
  config: SmokeCliParserConfig<TOptions>,
): TOptions {
  const args = stripLeadingPackageManagerSeparator(argv);
  const valueHandlers: Record<string, (value: string) => void> = {
    "--api-key-env": (value) => (options.apiKeyEnv = value),
    "--host-ip": (value) => (options.hostIp = value),
    "--host-port": (value) => {
      options.hostPort = parseTcpPort(value, "--host-port");
      options.hostPortExplicit = true;
    },
    "--install-url": (value) => (options.installUrl = value),
    "--install-version": (value) => (options.installVersion = value),
    "--latest-version": (value) => (options.latestVersion = value),
    "--mode": (value) => (options.mode = parseMode(value)),
    "--model": (value) => (options.modelId = value),
    "--npm-registry": (value) => (options.npmRegistry = value),
    "--openai-api-key-env": (value) => (options.apiKeyEnv = value),
    "--provider": (value) => (options.provider = parseProvider(value)),
    "--snapshot-hint": (value) => (options.snapshotHint = value),
    "--target-package-spec": (value) => (options.targetPackageSpec = value),
    "--vm": (value) => (options.vmName = value),
  };
  for (const [flag, handler] of Object.entries(config.valueHandlers ?? {})) {
    valueHandlers[flag] = (value) => handler(options, value);
  }
  const flagHandlers: Record<string, () => void> = {
    "--json": () => (options.json = true),
    "--keep-server": () => (options.keepServer = true),
  };
  for (const [flag, handler] of Object.entries(config.flagHandlers ?? {})) {
    flagHandlers[flag] = () => handler(options);
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      die(`missing argument at index ${index}`);
    }
    if (arg === "--") {
      break;
    }
    const valueHandler = Object.hasOwn(valueHandlers, arg) ? valueHandlers[arg] : undefined;
    if (valueHandler) {
      valueHandler(ensureValue(args, index, arg));
      index += 1;
      continue;
    }
    const flagHandler = Object.hasOwn(flagHandlers, arg) ? flagHandlers[arg] : undefined;
    if (flagHandler) {
      flagHandler();
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(config.usage());
      process.exit(0);
    }
    die(`unknown arg: ${arg}`);
  }
  return options;
}

interface SmokeLaneStatuses {
  freshAgent: string;
  freshGateway: string;
  freshMain: string;
  freshVersion: string;
  latestInstalledVersion: string;
  upgrade: string;
  upgradeAgent: string;
  upgradeGateway: string;
  upgradeVersion: string;
}

interface CommonSmokeSummary {
  currentHead: string;
  freshMain: {
    agent: string;
    gateway: string;
    status: string;
    version: string;
  };
  installVersion: string;
  latestVersion: string;
  mode: Mode;
  provider: Provider;
  runDir: string;
  snapshotHint: string;
  snapshotId: string;
  targetPackageSpec: string;
  upgrade: {
    agent: string;
    gateway: string;
    latestVersionInstalled: string;
    mainVersion: string;
    status: string;
  };
  vm: string;
}

export abstract class SmokeRunController<TOptions extends SmokeRunOptions & SmokeHostOptions> {
  protected hostIp = "";
  protected hostPort = 0;
  protected options: TOptions;
  protected runDir = "";
  protected server: HostServer | null = null;
  protected tgzDir = "";

  protected constructor(options: TOptions) {
    this.options = options;
  }

  protected abstract runFreshLane(): Promise<void>;
  protected abstract runUpgradeLane(): Promise<void>;
  protected abstract writeSummary(): Promise<string>;
  protected abstract printSummary(summaryPath: string): void;
  protected abstract status: Pick<SmokeLaneStatuses, "freshMain" | "upgrade">;

  protected async prepareHost(
    defaultPort: number,
    latestVersion: string,
    snapshot: SnapshotInfo,
    vmName: string,
  ): Promise<void> {
    [this.hostIp, this.hostPort] = await prepareSmokeRunHost(
      this.options,
      defaultPort,
      latestVersion,
      this.runDir,
      snapshot,
      this.options.snapshotHint,
      vmName,
    );
  }

  protected async runLanesAndFinish(): Promise<void> {
    await runSmokeLanesAndFinish(
      this.options.mode,
      this.options.json,
      this.status,
      async () => this.runFreshLane(),
      async () => this.runUpgradeLane(),
      async () => this.writeSummary(),
      (pathLocal) => this.printSummary(pathLocal),
    );
  }

  protected async cleanupArtifacts(): Promise<void> {
    await cleanupSmokeArtifacts({
      keepServer: this.options.keepServer,
      server: this.server,
      tgzDir: this.tgzDir,
    });
  }
}

async function resolveSmokeHostConfig(
  options: SmokeHostOptions,
  defaultPort: number,
): Promise<{ hostIp: string; hostPort: number }> {
  return {
    hostIp: resolveHostIp(options.hostIp),
    hostPort: await resolveHostPort(options.hostPort, options.hostPortExplicit, defaultPort),
  };
}

async function prepareSmokeRunHost(
  options: SmokeHostOptions,
  defaultPort: number,
  latestVersion: string,
  runDir: string,
  snapshot: SnapshotInfo,
  snapshotHint: string,
  vmName: string,
): Promise<readonly [hostIp: string, hostPort: number]> {
  const host = await resolveSmokeHostConfig(options, defaultPort);
  logSmokeRunStart({
    latestVersion,
    runDir,
    snapshot,
    snapshotHint,
    vmName,
  });
  return [host.hostIp, host.hostPort];
}

function logSmokeRunStart(input: {
  latestVersion: string;
  runDir: string;
  snapshot: SnapshotInfo;
  snapshotHint: string;
  vmName: string;
}): void {
  say(`VM: ${input.vmName}`);
  say(`Snapshot hint: ${input.snapshotHint}`);
  say(`Resolved snapshot: ${input.snapshot.name} [${input.snapshot.state}]`);
  say(`Latest npm version: ${input.latestVersion}`);
  say(`Current head: ${currentGitHeadShort()}`);
  say(`Run logs: ${input.runDir}`);
}

export function npmRegistryEnv(registry?: string): Record<string, string> {
  return registry ? { NPM_CONFIG_REGISTRY: registry, npm_config_registry: registry } : {};
}

export function posixStopGatewayScript(managedCommand?: string): string {
  // Embedded turns require exclusive state ownership. Unmanaged stop sends
  // SIGTERM without waiting; Darwin pads the run loop's process title with spaces.
  const stop = managedCommand
    ? `gateway_stop_args=(gateway stop)
if ${managedCommand} gateway stop --help | grep -Eq '^[[:space:]]+--force([[:space:]]|$)'; then
  gateway_stop_args+=(--force)
fi
${managedCommand} "\${gateway_stop_args[@]}"`
    : "pkill -f '^openclaw-gateway([[:space:]]|$)' || [ \"$?\" -eq 1 ]";
  return `${stop}
gateway_stop_deadline=$((SECONDS + 30))
while pgrep -f '^openclaw-gateway([[:space:]]|$)' >/dev/null; do
  if [ "$SECONDS" -ge "$gateway_stop_deadline" ]; then
    echo "gateway did not release state ownership before the local agent turn" >&2
    exit 1
  fi
  sleep 1
done`;
}

export async function startSmokeArtifactServer(input: {
  artifact: PackageArtifact;
  dir: string;
  hostIp: string;
  label: string;
  port: number;
}): Promise<HostServer> {
  const server = await startHostServer({
    artifactPath: input.artifact.path,
    dir: input.dir,
    hostIp: input.hostIp,
    label: input.label,
    port: input.port,
  });
  if (!input.artifact.registryPackages?.length) {
    return server;
  }
  try {
    const registry = await startNpmRegistryServer({
      hostIp: input.hostIp,
      packages: [
        {
          name: "openclaw",
          version: await expectedPackageTargetVersion(input.artifact),
          tarballPath: input.artifact.path,
        },
        ...input.artifact.registryPackages,
      ],
    });
    return {
      ...server,
      registry: { url: registry.url, hostUrl: registry.hostUrl },
      stop: async () => {
        try {
          await server.stop();
        } finally {
          await registry.stop();
        }
      },
    };
  } catch (error) {
    await server.stop().catch(() => undefined);
    throw error;
  }
}

export async function packAndServeSmokeArtifact(
  tgzDir: string,
  packageSpec: string | undefined,
  hostIp: string,
  hostPort: number,
  label: string,
  requireControlUi: boolean,
  provider: Provider,
): Promise<readonly [artifact: PackageArtifact, server: HostServer, hostPort: number]> {
  const providerConfig = resolveProviderConfig(provider);
  if (!providerConfig) {
    die(`missing release smoke configuration for provider: ${provider}`);
  }
  const artifact = await packOpenClaw({
    destination: tgzDir,
    packageSpec,
    requireControlUi,
    requiredCompanionPackages: providerConfig.requiredCompanionPackages,
  });
  const server = await startSmokeArtifactServer({
    artifact,
    dir: tgzDir,
    hostIp,
    label,
    port: hostPort,
  });
  return [artifact, server, server.port];
}

export function ensureSmokeGuestRuntime(input: {
  runShell: (script: string) => string;
  bootstrap: () => void;
}): void {
  const nodeCheck = shellQuote(`process.exit(${PROCESS_NODE_VERSION_CHECK} ? 0 : 1)`);
  const ready = input.runShell(`if node -e ${nodeCheck} >/dev/null 2>&1 &&
  npm --version >/dev/null 2>&1 && git --version >/dev/null 2>&1; then
  printf 'ready\\n'
fi`);
  if (ready.trim() === "ready") {
    say("Reuse supported guest Node, npm, and Git; install candidate directly");
    return;
  }
  // Older pristine snapshots have no Node/npm; retain their installer bootstrap.
  say("Bootstrap missing or unsupported guest runtime prerequisites");
  input.bootstrap();
}

export async function installSmokeRuntimeCompanions(input: {
  provider: Provider;
  readCli: (args: string[]) => string;
  installCli: (args: string[]) => Promise<void> | void;
}): Promise<void> {
  const providerConfig = resolveProviderConfig(input.provider);
  if (!providerConfig) {
    throw new Error(`missing release smoke configuration for provider: ${input.provider}`);
  }
  if (providerConfig.requiredCompanionPackages.length === 0) {
    return;
  }
  const help = input.readCli(["plugins", "install", "--help"]);
  // Stable 2026.7.1-2 predates capability consent and provisions its own
  // companion version during onboarding; it must not receive the newer flag.
  if (!/^\s+--accept-capabilities(?:\s|$)/mu.test(help)) {
    say("Installed CLI predates capability consent; using its onboarding contract");
    return;
  }
  const version = input
    .readCli(["--version"])
    .match(/^OpenClaw\s+(\d{4}\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?)(?:\s|$)/mu)?.[1];
  if (!version) {
    throw new Error("could not resolve installed OpenClaw version for runtime companions");
  }
  // Candidate registries bind reviewed companion artifacts to the core version.
  // Only the selected provider's required packages receive explicit consent.
  for (const packageName of providerConfig.requiredCompanionPackages) {
    say(`Install reviewed runtime companion: ${packageName}@${version}`);
    await input.installCli([
      "plugins",
      "install",
      `npm:${packageName}@${version}`,
      "--pin",
      "--accept-capabilities",
    ]);
  }
}

async function runRequestedSmokeLanes(input: {
  mode: Mode;
  runFresh: () => Promise<void>;
  runLane: (name: "fresh" | "upgrade", fn: () => Promise<void>) => Promise<void>;
  runUpgrade: () => Promise<void>;
}): Promise<void> {
  if (input.mode === "fresh" || input.mode === "both") {
    await input.runLane("fresh", input.runFresh);
  }
  if (input.mode === "upgrade" || input.mode === "both") {
    await input.runLane("upgrade", input.runUpgrade);
  }
}

async function runSmokeLaneWithStatus(
  name: "fresh" | "upgrade",
  fn: () => Promise<void>,
  statuses: Pick<SmokeLaneStatuses, "freshMain" | "upgrade">,
): Promise<void> {
  await runSmokeLane(name, fn, (lane, status) => setSmokeLaneStatus(statuses, lane, status));
}

function setSmokeLaneStatus(
  statuses: Pick<SmokeLaneStatuses, "freshMain" | "upgrade">,
  name: SmokeLane,
  status: SmokeLaneStatus,
): void {
  if (name === "fresh") {
    statuses.freshMain = status;
  } else {
    statuses.upgrade = status;
  }
}

async function finishSmokeRun(input: {
  json: boolean;
  printSummary: (summaryPath: string) => void;
  status: Pick<SmokeLaneStatuses, "freshMain" | "upgrade">;
  summaryPath: string;
}): Promise<void> {
  if (input.json) {
    process.stdout.write(await readFile(input.summaryPath, "utf8"));
  } else {
    input.printSummary(input.summaryPath);
  }
  if (input.status.freshMain === "fail" || input.status.upgrade === "fail") {
    process.exitCode = 1;
  }
}

async function runSmokeLanesAndFinish(
  mode: Mode,
  json: boolean,
  status: Pick<SmokeLaneStatuses, "freshMain" | "upgrade">,
  runFresh: () => Promise<void>,
  runUpgrade: () => Promise<void>,
  writeSummary: () => Promise<string>,
  printSummary: (summaryPath: string) => void,
): Promise<void> {
  await runRequestedSmokeLanes({
    mode,
    runFresh,
    runLane: async (name, fn) => runSmokeLaneWithStatus(name, fn, status),
    runUpgrade,
  });
  await finishSmokeRun({
    json,
    printSummary,
    status,
    summaryPath: await writeSummary(),
  });
}

async function cleanupSmokeArtifacts(input: {
  keepServer: boolean;
  server: HostServer | null;
  tgzDir: string;
}): Promise<void> {
  if (input.keepServer) {
    return;
  }
  await input.server?.stop().catch(() => undefined);
  await rm(input.tgzDir, { force: true, recursive: true }).catch(() => undefined);
}

export async function expectedPackageTargetVersion(artifact: PackageArtifact): Promise<string> {
  return artifact.version || (await packageVersionFromTgz(artifact.path));
}

export async function expectedPackageBuildCommit(artifact: PackageArtifact): Promise<string> {
  return artifact.buildCommitShort || (await packageBuildCommitFromTgz(artifact.path)).slice(0, 7);
}

export async function extractLastOpenClawVersion(
  runDir: string,
  phaseName: string,
  pattern: RegExp,
): Promise<string> {
  return await extractLastOpenClawVersionFromLog(path.join(runDir, `${phaseName}.log`), pattern);
}

export function buildCommonSmokeSummary(input: {
  artifact: PackageArtifact | null;
  latestVersion: string;
  options: SmokeRunOptions;
  runDir: string;
  snapshot: SnapshotInfo;
  status: SmokeLaneStatuses;
  vmName: string;
}): CommonSmokeSummary {
  return {
    currentHead: input.artifact?.buildCommitShort || currentGitHeadShort(),
    freshMain: {
      agent: input.status.freshAgent,
      gateway: input.status.freshGateway,
      status: input.status.freshMain,
      version: input.status.freshVersion,
    },
    installVersion: input.options.installVersion || "",
    latestVersion: input.latestVersion,
    mode: input.options.mode,
    provider: input.options.provider,
    runDir: input.runDir,
    snapshotHint: input.options.snapshotHint,
    snapshotId: input.snapshot.id,
    targetPackageSpec: input.options.targetPackageSpec || "",
    upgrade: {
      agent: input.status.upgradeAgent,
      gateway: input.status.upgradeGateway,
      latestVersionInstalled: input.status.latestInstalledVersion,
      mainVersion: input.status.upgradeVersion,
      status: input.status.upgrade,
    },
    vm: input.vmName,
  };
}

export function printSmokeTargetSummary(input: {
  includeInstallVersion?: boolean;
  installVersion?: string;
  targetPackageSpec?: string;
}): void {
  if (input.targetPackageSpec) {
    process.stdout.write(`  target-package: ${input.targetPackageSpec}\n`);
  }
  if (input.includeInstallVersion !== false && input.installVersion) {
    process.stdout.write(`  baseline-install-version: ${input.installVersion}\n`);
  }
}

function currentGitHeadShort(): string {
  return run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim();
}
