import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { run, say } from "./host-command.ts";
import { resolveHostIp, resolveHostPort } from "./host-server.ts";
import { startHostServer } from "./host-server.ts";
import { runSmokeLane, type SmokeLane, type SmokeLaneStatus } from "./lane-runner.ts";
import {
  packageBuildCommitFromTgz,
  packageVersionFromTgz,
  packOpenClaw,
} from "./package-artifact.ts";
import type { HostServer, Mode, PackageArtifact, Provider, SnapshotInfo } from "./types.ts";

export interface SmokeHostOptions {
  hostIp?: string;
  hostPort: number;
  hostPortExplicit: boolean;
}

export interface SmokeRunOptions {
  installVersion?: string;
  json: boolean;
  keepServer: boolean;
  mode: Mode;
  provider: Provider;
  snapshotHint: string;
  targetPackageSpec?: string;
}

export interface SmokeLaneStatuses {
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

export interface CommonSmokeSummary {
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
  protected runDir = "";
  protected server: HostServer | null = null;
  protected tgzDir = "";

  protected constructor(protected options: TOptions) {}

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
      (path) => this.printSummary(path),
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

export async function resolveSmokeHostConfig(
  options: SmokeHostOptions,
  defaultPort: number,
): Promise<{ hostIp: string; hostPort: number }> {
  return {
    hostIp: resolveHostIp(options.hostIp),
    hostPort: await resolveHostPort(options.hostPort, options.hostPortExplicit, defaultPort),
  };
}

export async function prepareSmokeRunHost(
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

export function logSmokeRunStart(input: {
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

export async function startSmokeArtifactServer(input: {
  artifact: PackageArtifact;
  dir: string;
  hostIp: string;
  label: string;
  port: number;
}): Promise<{ hostPort: number; server: HostServer }> {
  const server = await startHostServer({
    artifactPath: input.artifact.path,
    dir: input.dir,
    hostIp: input.hostIp,
    label: input.label,
    port: input.port,
  });
  return { hostPort: server.port, server };
}

export async function packAndServeSmokeArtifact(
  tgzDir: string,
  packageSpec: string | undefined,
  hostIp: string,
  hostPort: number,
  label: string,
  requireControlUi = false,
): Promise<readonly [artifact: PackageArtifact, server: HostServer, hostPort: number]> {
  const artifact = await packOpenClaw({
    destination: tgzDir,
    packageSpec,
    requireControlUi,
  });
  const server = await startSmokeArtifactServer({
    artifact,
    dir: tgzDir,
    hostIp,
    label,
    port: hostPort,
  });
  return [artifact, server.server, server.hostPort];
}

export async function runRequestedSmokeLanes(input: {
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

export async function runSmokeLaneWithStatus(
  name: "fresh" | "upgrade",
  fn: () => Promise<void>,
  statuses: Pick<SmokeLaneStatuses, "freshMain" | "upgrade">,
): Promise<void> {
  await runSmokeLane(name, fn, (lane, status) => setSmokeLaneStatus(statuses, lane, status));
}

export function setSmokeLaneStatus(
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

export async function finishSmokeRun(input: {
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

export async function runSmokeLanesAndFinish(
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

export async function cleanupSmokeArtifacts(input: {
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
  const text = await readFile(path.join(runDir, `${phaseName}.log`), "utf8").catch(() => "");
  return [...text.matchAll(pattern)].at(-1)?.[1] ?? "";
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
