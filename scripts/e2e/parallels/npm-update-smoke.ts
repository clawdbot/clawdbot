#!/usr/bin/env -S pnpm tsx
// Npm Update Smoke script supports OpenClaw repository automation.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  die,
  ensureValue,
  extractLastOpenClawVersionFromLog,
  makeTempDir,
  packOpenClaw,
  parsePlatformList,
  parseProvider,
  readPositiveIntEnv,
  repoRoot,
  resolveHostIp,
  resolveLatestVersion,
  resolveOpenClawRegistryVersion,
  resolveProviderAuth,
  resolveWindowsProviderAuth,
  run,
  say,
  shellQuote,
  startHostServer,
  withProgressOnStderr,
  writeSummaryMarkdown,
  writeJson,
  type HostServer,
  type PackageArtifact,
  type Platform,
  type Provider,
  type ProviderAuth,
} from "./common.ts";
import { runWindowsBackgroundPowerShell } from "./guest-transports.ts";
import { linuxUpdateScript, macosUpdateScript, windowsUpdateScript } from "./npm-update-scripts.ts";
import { ensureVmRunning, resolveUbuntuVmName } from "./parallels-vm.ts";
import { runTimedUpdateJob } from "./update-job-timeout.ts";

interface NpmUpdateOptions {
  betaValidation?: string;
  freshTargetSpec?: string;
  hostIp?: string;
  packageSpec: string;
  updateTarget: string;
  platforms: Set<Platform>;
  provider: Provider;
  apiKeyEnv?: string;
  modelId?: string;
  json: boolean;
}

interface Job {
  done: boolean;
  durationMs: number;
  label: string;
  lastBytes: number;
  lastOutputAt: number;
  lastPhase: string;
  logPath: string;
  promise: Promise<number>;
  rerunCommand: string;
  startedAt: number;
}

interface UpdateJobContext {
  append(chunk: string | Uint8Array): void;
  logPath: string;
  signal: AbortSignal;
}

interface SpawnLoggedOptions {
  timeoutKillGraceMs?: number;
  timeoutLabel?: string;
  timeoutMs?: number;
}

interface NpmUpdateSummary {
  packageSpec: string;
  updateTarget: string;
  updateExpected: string;
  updateTargetBuildCommit: string;
  updateTargetPackageVersion: string;
  updateTargetTarball: string;
  provider: Provider;
  latestVersion: string;
  currentHead: string;
  harnessCheckoutVersion: string;
  harnessTargetFamily: string;
  runDir: string;
  slowestTiming?: {
    durationMs: number;
    label: string;
    phase: "fresh" | "fresh-target" | "update";
  };
  totalDurationMs: number;
  fresh: Record<Platform, string>;
  freshTarget: Record<Platform, string>;
  freshTargetSpec: string;
  update: Record<Platform, { status: string; version: string }>;
  timings: Array<{
    durationMs: number;
    label: string;
    logPath: string;
    phase: "fresh" | "fresh-target" | "update";
    status: string;
  }>;
}

const macosVm = "macOS Tahoe";
const windowsVm = "Windows 11";
const linuxVmDefault = "Ubuntu 26.04";
const updateTimeoutSeconds = readPositiveIntEnv("OPENCLAW_PARALLELS_NPM_UPDATE_TIMEOUT_S", 1200);
const updateCleanupBackstopMs = 60_000;
const freshLaneTimeoutKillGraceMs = readPositiveIntEnv(
  "OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_KILL_GRACE_MS",
  2_000,
);
const activeLoggedChildren = new Set<ReturnType<typeof spawn>>();
const loggedParentSignalHandlers = new Map<NodeJS.Signals, () => void>();
let loggedExitCleanupInstalled = false;

export function freshLaneTimeoutMs(platform: Platform): number {
  const defaultSeconds = platform === "windows" ? 90 * 60 : 75 * 60;
  return readPositiveIntEnv("OPENCLAW_PARALLELS_NPM_UPDATE_FRESH_TIMEOUT_S", defaultSeconds) * 1000;
}

export function spawnLoggedCommand(
  command: string,
  args: string[],
  logPath: string,
  env: NodeJS.ProcessEnv = {},
  onOutput: (text: string) => void = () => undefined,
  options: SpawnLoggedOptions = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    writeFileSync(logPath, "", "utf8");
    const child = spawn(command, args, {
      cwd: repoRoot,
      detached: process.platform !== "win32",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    trackLoggedChild(child);
    let timedOut = false;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const append = (text: string) => {
      appendFileSync(logPath, text, "utf8");
      onOutput(text);
    };
    const timeoutMs = options.timeoutMs ?? 0;
    const timeoutTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            append(
              `\n[${options.timeoutLabel ?? `${command} ${args.join(" ")}`} timed out after ${timeoutMs}ms]\n`,
            );
            signalLoggedChild(child, "SIGTERM");
            forceKillTimer = setTimeout(
              () => signalLoggedChild(child, "SIGKILL"),
              options.timeoutKillGraceMs ?? freshLaneTimeoutKillGraceMs,
            );
          }, timeoutMs)
        : undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      append(chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      append(chunk.toString("utf8"));
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      untrackLoggedChild(child);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(forceKillTimer);
      if (timedOut && loggedProcessTreeIsAlive(child)) {
        signalLoggedChild(child, "SIGKILL");
      }
      untrackLoggedChild(child);
      resolve(timedOut ? 124 : (code ?? 1));
    });
  });
}

function trackLoggedChild(child: ReturnType<typeof spawn>) {
  activeLoggedChildren.add(child);
  child.once("close", () => {
    if (!loggedProcessTreeIsAlive(child)) {
      activeLoggedChildren.delete(child);
    }
  });
  child.once("error", () => {
    if (!loggedProcessTreeIsAlive(child)) {
      activeLoggedChildren.delete(child);
    }
  });
  installLoggedParentCleanup();
}

function untrackLoggedChild(child: ReturnType<typeof spawn>) {
  if (!loggedProcessTreeIsAlive(child)) {
    activeLoggedChildren.delete(child);
  }
}

function installLoggedParentCleanup() {
  if (!loggedExitCleanupInstalled) {
    loggedExitCleanupInstalled = true;
    process.once("exit", () => cleanupActiveLoggedChildren("SIGTERM"));
  }
  for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    if (loggedParentSignalHandlers.has(signal)) {
      continue;
    }
    const handler = () => {
      cleanupActiveLoggedChildren(signal);
      for (const [registeredSignal, registeredHandler] of loggedParentSignalHandlers) {
        process.off(registeredSignal, registeredHandler);
      }
      loggedParentSignalHandlers.clear();
      process.kill(process.pid, signal);
    };
    loggedParentSignalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
}

function cleanupActiveLoggedChildren(signal: NodeJS.Signals) {
  for (const child of activeLoggedChildren) {
    signalLoggedChild(child, signal);
    if (process.platform !== "win32") {
      signalLoggedChild(child, "SIGKILL");
    }
  }
}

function loggedProcessTreeIsAlive(child: ReturnType<typeof spawn>): boolean {
  if (process.platform === "win32" || typeof child.pid !== "number") {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function signalLoggedChild(child: ReturnType<typeof spawn>, signal: NodeJS.Signals) {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") {
        return;
      }
    }
  }
  try {
    child.kill(signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
      throw error;
    }
  }
}

function usage(): string {
  return `Usage: bash scripts/e2e/parallels-npm-update-smoke.sh [options]

Options:
  --package-spec <npm-spec>  Baseline npm package spec. Default: openclaw@latest
  --update-target <target>    Target passed to guest 'openclaw update --tag'.
                             Default: host-served tgz packed from current checkout.
  --fresh-target <npm-spec>   Also run fresh install smoke for this package after update lanes.
  --beta-validation [target]  Resolve a beta tag/alias/version, then run latest->target update
                             plus fresh target install. Default target when flag is bare: beta.
                             Aliases like beta3 resolve to the latest *-beta.3 version.
  --platform <list>           Comma-separated platforms to run: all, macos, windows, linux.
                             Default: all
  --provider <openai|anthropic|minimax>
  --model <provider/model>    Override the model used for agent-turn smoke checks.
  --host-ip <ip>             Override Parallels host IP.
  --api-key-env <var>        Host env var name for provider API key.
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.
`;
}

export function parseArgs(argv: string[]): NpmUpdateOptions {
  const args = stripLeadingPackageManagerSeparator(argv);
  const options: NpmUpdateOptions = {
    apiKeyEnv: undefined,
    betaValidation: undefined,
    freshTargetSpec: undefined,
    json: false,
    modelId: undefined,
    packageSpec: "",
    platforms: parsePlatformList("all"),
    provider: "openai",
    updateTarget: "",
  };
  parseArgv: for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--":
        break parseArgv;
      case "--package-spec":
        options.packageSpec = ensureValue(args, i, arg);
        i++;
        break;
      case "--update-target":
        options.updateTarget = ensureValue(args, i, arg);
        i++;
        break;
      case "--fresh-target":
        options.freshTargetSpec = ensureValue(args, i, arg);
        i++;
        break;
      case "--beta-validation": {
        const next = args[i + 1];
        if (next && !next.startsWith("-")) {
          options.betaValidation = next;
          i++;
        } else {
          options.betaValidation = "beta";
        }
        break;
      }
      case "--platform":
      case "--only":
        options.platforms = parsePlatformList(ensureValue(args, i, arg));
        i++;
        break;
      case "--provider":
        options.provider = parseProvider(ensureValue(args, i, arg));
        i++;
        break;
      case "--model":
        options.modelId = ensureValue(args, i, arg);
        i++;
        break;
      case "--host-ip":
        options.hostIp = ensureValue(args, i, arg);
        i++;
        break;
      case "--api-key-env":
      case "--openai-api-key-env":
        options.apiKeyEnv = ensureValue(args, i, arg);
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

function stripLeadingPackageManagerSeparator(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

function platformRecord<T>(value: T): Record<Platform, T> {
  return { linux: value, macos: value, windows: value };
}

function formatDuration(durationMs: number): string {
  const seconds = Math.round(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function readHarnessCheckoutVersion(): string {
  const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    version?: unknown;
  };
  return typeof pkg.version === "string" ? pkg.version : "";
}

function openClawVersionFamily(version: string): string {
  return /^(\d{4}\.\d{1,2}\.\d{1,2})(?:[-.]|$)/u.exec(version.trim())?.[1] ?? "";
}

function parseOpenClawPackageSpecVersion(spec: string): string {
  const value = spec.trim();
  if (!value) {
    return "";
  }
  return resolveOpenClawRegistryVersion(value) || "";
}

export class NpmUpdateSmoke {
  private auth: ProviderAuth;
  private windowsAuth: ProviderAuth;
  private runDir = "";
  private tgzDir = "";
  private latestVersion = "";
  private packageSpec = "";
  private currentHead = "";
  private currentHeadShort = "";
  private harnessCheckoutVersion = "";
  private harnessTargetFamily = "";
  private hostIp = "";
  protected server: HostServer | null = null;
  private artifact: PackageArtifact | null = null;
  private freshTargetSpec = "";
  private startedAt = Date.now();
  private updateTargetBuildCommit = "";
  private updateTargetEffective = "";
  private updateExpectedNeedle = "";
  private updateTargetPackageVersion = "";
  private updateTargetTarball = "";
  private linuxVm = linuxVmDefault;

  private freshStatus = platformRecord("skip");
  private freshTargetStatus = platformRecord("skip");
  private updateStatus = platformRecord("skip");
  private updateVersion = platformRecord("skip");
  private timings: NpmUpdateSummary["timings"] = [];

  constructor(private options: NpmUpdateOptions) {
    this.auth = resolveProviderAuth({
      apiKeyEnv: options.apiKeyEnv,
      modelId: options.modelId,
      provider: options.provider,
    });
    this.windowsAuth = resolveWindowsProviderAuth({
      apiKeyEnv: options.apiKeyEnv,
      modelId: options.modelId,
      provider: options.provider,
    });
  }

  async run(): Promise<void> {
    this.startedAt = Date.now();
    this.runDir = await this.makeRunTempDir("openclaw-parallels-npm-update.");
    this.tgzDir = await this.makeRunTempDir("openclaw-parallels-npm-update-tgz.");
    try {
      await this.runSteps();
    } finally {
      await this.server?.stop().catch(() => undefined);
      await rm(this.tgzDir, { force: true, recursive: true }).catch(() => undefined);
    }
  }

  protected async makeRunTempDir(prefix: string): Promise<string> {
    return await makeTempDir(prefix);
  }

  protected async runSteps(): Promise<void> {
    this.latestVersion = resolveLatestVersion();
    this.packageSpec = this.options.packageSpec || `openclaw@${this.latestVersion}`;
    this.currentHead = run("git", ["rev-parse", "HEAD"], { quiet: true }).stdout.trim();
    this.currentHeadShort = run("git", ["rev-parse", "--short=7", "HEAD"], {
      quiet: true,
    }).stdout.trim();
    this.harnessCheckoutVersion = readHarnessCheckoutVersion();
    this.hostIp = resolveHostIp(this.options.hostIp ?? "");
    this.configurePublishedTargets();
    this.assertPublishedTargetMatchesHarnessCheckout();

    if (this.options.platforms.has("linux")) {
      this.linuxVm = resolveUbuntuVmName(linuxVmDefault);
    }
    this.preflightRegistryUpdateTarget();

    say(`Run fresh npm baseline: ${this.packageSpec}`);
    say(`Platforms: ${[...this.options.platforms].join(",")}`);
    say(`Run dir: ${this.runDir}`);
    await this.runFreshBaselines();

    await this.prepareUpdateTarget();
    say(`Run same-guest openclaw update to ${this.updateTargetEffective}`);
    await this.runSameGuestUpdates();

    if (this.freshTargetSpec) {
      say(`Run fresh target npm install: ${this.freshTargetSpec}`);
      await this.runFreshTargetInstalls();
    }

    const summaryPath = await this.writeSummary();
    if (this.options.json) {
      process.stdout.write(await readFile(summaryPath, "utf8"));
    } else {
      say(`Run dir: ${this.runDir}`);
      process.stdout.write(await readFile(summaryPath, "utf8"));
    }
  }

  private async runFreshBaselines(): Promise<void> {
    const jobs: Job[] = [];
    if (this.options.platforms.has("macos")) {
      jobs.push(this.spawnFresh("macOS", "macos", []));
    }
    if (this.options.platforms.has("windows")) {
      jobs.push(this.spawnFresh("Windows", "windows", []));
    }
    if (this.options.platforms.has("linux")) {
      jobs.push(
        this.spawnFresh("Linux", "linux", ["--vm", this.linuxVm], {
          OPENCLAW_PARALLELS_LINUX_DISABLE_BONJOUR: "1",
        }),
      );
    }
    await this.monitorJobs("fresh", jobs);
    for (const job of jobs) {
      const status = (await job.promise) === 0 ? "pass" : "fail";
      const platform = this.platformFromLabel(job.label);
      this.freshStatus[platform] = status;
      this.recordTiming("fresh", job, status);
      if (status !== "pass") {
        this.dumpLogTail(job.logPath);
        die(`${job.label} fresh baseline failed; rerun: ${job.rerunCommand}`);
      }
    }
  }

  private async runFreshTargetInstalls(): Promise<void> {
    const jobs: Job[] = [];
    if (this.options.platforms.has("macos")) {
      jobs.push(this.spawnFresh("macOS", "macos", [], {}, this.freshTargetSpec, "fresh-target"));
    }
    if (this.options.platforms.has("windows")) {
      jobs.push(
        this.spawnFresh("Windows", "windows", [], {}, this.freshTargetSpec, "fresh-target"),
      );
    }
    if (this.options.platforms.has("linux")) {
      jobs.push(
        this.spawnFresh(
          "Linux",
          "linux",
          ["--vm", this.linuxVm],
          {
            OPENCLAW_PARALLELS_LINUX_DISABLE_BONJOUR: "1",
          },
          this.freshTargetSpec,
          "fresh-target",
        ),
      );
    }
    await this.monitorJobs("fresh-target", jobs);
    for (const job of jobs) {
      const status = (await job.promise) === 0 ? "pass" : "fail";
      const platform = this.platformFromLabel(job.label);
      this.freshTargetStatus[platform] = status;
      this.recordTiming("fresh-target", job, status);
      if (status !== "pass") {
        this.dumpLogTail(job.logPath);
        die(`${job.label} fresh target failed; rerun: ${job.rerunCommand}`);
      }
    }
  }

  private spawnFresh(
    label: string,
    platform: Platform,
    extraArgs: string[],
    env: NodeJS.ProcessEnv = {},
    packageSpec = this.packageSpec,
    phase: "fresh" | "fresh-target" = "fresh",
  ): Job {
    const logPath = path.join(this.runDir, `${platform}-${phase}.log`);
    const auth = this.authForPlatform(platform);
    const script = `scripts/e2e/parallels-${platform}-smoke.sh`;
    const args = [
      script,
      "--mode",
      "fresh",
      "--provider",
      this.options.provider,
      "--model",
      auth.modelId,
      "--api-key-env",
      auth.apiKeyEnv,
      "--target-package-spec",
      packageSpec,
      "--json",
      ...extraArgs,
    ];
    const startedAt = Date.now();
    const job: Job = {
      done: false,
      durationMs: 0,
      label,
      lastBytes: 0,
      lastOutputAt: startedAt,
      lastPhase: "starting",
      logPath,
      promise: Promise.resolve(1),
      rerunCommand: this.formatRerun("bash", args, env),
      startedAt,
    };
    job.promise = this.spawnLogged(
      "bash",
      args,
      logPath,
      env,
      (text) => this.noteJobOutput(job, text),
      {
        timeoutLabel: `${label} ${phase}`,
        timeoutMs: freshLaneTimeoutMs(platform),
      },
    ).finally(() => {
      job.durationMs = Date.now() - job.startedAt;
      job.done = true;
    });
    return job;
  }

  private async prepareUpdateTarget(): Promise<void> {
    if (!this.options.updateTarget || this.options.updateTarget === "local-main") {
      this.artifact = await packOpenClaw({
        destination: this.tgzDir,
        requireControlUi: true,
      });
      this.server = await startHostServer({
        artifactPath: this.artifact.path,
        dir: this.tgzDir,
        hostIp: this.hostIp,
        label: "current main tgz",
        port: 0,
      });
      this.updateTargetEffective = this.server.urlFor(this.artifact.path);
      this.updateExpectedNeedle = this.currentHeadShort;
      this.updateTargetPackageVersion = this.artifact.version ?? "";
      this.updateTargetBuildCommit =
        this.artifact.buildCommitShort ?? this.artifact.buildCommit ?? "";
      this.updateTargetTarball = this.updateTargetEffective;
      return;
    }
    this.updateTargetEffective = this.options.updateTarget;
    this.updateExpectedNeedle = this.isExplicitPackageTarget(this.updateTargetEffective)
      ? ""
      : resolveOpenClawRegistryVersion(this.updateTargetEffective) || this.updateTargetEffective;
    const metadata = this.resolveRegistryPackageMetadata(this.updateTargetEffective);
    this.updateTargetPackageVersion = metadata.version;
    this.updateTargetBuildCommit =
      metadata.gitHead || this.resolvePackageBuildCommit(metadata.tarball);
    this.updateTargetTarball = metadata.tarball;
  }

  private resolvePackageBuildCommit(tarball: string): string {
    if (!tarball) {
      return "";
    }
    const output = run(
      "bash",
      ["-lc", `curl -fsSL ${shellQuote(tarball)} | tar -xzOf - package/dist/build-info.json`],
      {
        check: false,
        quiet: true,
      },
    ).stdout.trim();
    if (!output) {
      return "";
    }
    try {
      const parsed = JSON.parse(output) as { commit?: string };
      return parsed.commit ? parsed.commit.slice(0, 7) : "";
    } catch {
      return "";
    }
  }

  private resolveRegistryPackageMetadata(target: string): {
    gitHead: string;
    tarball: string;
    version: string;
  } {
    if (this.isExplicitPackageTarget(target)) {
      return { gitHead: "", tarball: "", version: "" };
    }
    const spec = target.startsWith("openclaw@") ? target : `openclaw@${target}`;
    const output = run("npm", ["view", spec, "version", "dist.tarball", "gitHead", "--json"], {
      check: false,
      quiet: true,
    }).stdout.trim();
    if (!output) {
      return { gitHead: "", tarball: "", version: "" };
    }
    try {
      const parsed = JSON.parse(output) as {
        dist?: { tarball?: string };
        gitHead?: string;
        version?: string;
      };
      return {
        gitHead: parsed.gitHead ?? "",
        tarball: parsed.dist?.tarball ?? "",
        version: parsed.version ?? "",
      };
    } catch {
      return { gitHead: "", tarball: "", version: "" };
    }
  }

  private async runSameGuestUpdates(): Promise<void> {
    const jobs: Job[] = [];
    if (this.options.platforms.has("macos")) {
      ensureVmRunning(macosVm);
      jobs.push(this.spawnUpdate("macOS", "macos", (ctx) => this.runMacosUpdate(ctx)));
    }
    if (this.options.platforms.has("windows")) {
      ensureVmRunning(windowsVm);
      jobs.push(this.spawnUpdate("Windows", "windows", (ctx) => this.runWindowsUpdate(ctx)));
    }
    if (this.options.platforms.has("linux")) {
      ensureVmRunning(this.linuxVm);
      jobs.push(this.spawnUpdate("Linux", "linux", (ctx) => this.runLinuxUpdate(ctx)));
    }
    await this.monitorJobs("update", jobs);
    for (const job of jobs) {
      const platform = this.platformFromLabel(job.label);
      const status = (await job.promise) === 0 ? "pass" : "fail";
      this.updateStatus[platform] = status;
      this.updateVersion[platform] = await this.extractLastVersion(job.logPath);
      this.recordTiming("update", job, status);
      if (status !== "pass") {
        this.dumpLogTail(job.logPath);
        die(`${job.label} update failed; rerun: ${job.rerunCommand}`);
      }
    }
  }

  private spawnUpdate(
    label: string,
    platform: Platform,
    fn: (ctx: UpdateJobContext) => Promise<void> | void,
  ): Job {
    const logPath = path.join(this.runDir, `${platform}-update.log`);
    const startedAt = Date.now();
    const job: Job = {
      done: false,
      durationMs: 0,
      label,
      lastBytes: 0,
      lastOutputAt: startedAt,
      lastPhase: "starting",
      logPath,
      promise: Promise.resolve(1),
      rerunCommand: `inspect ${logPath}; rerun aggregate phase with --platform ${platform}`,
      startedAt,
    };
    job.promise = (async () => {
      writeFileSync(logPath, "", "utf8");
      const append = (chunk: string | Uint8Array): void => {
        const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        appendFileSync(logPath, text, "utf8");
        this.noteJobOutput(job, text);
      };
      return await runTimedUpdateJob({
        append,
        label,
        run: ({ signal }) => fn({ append, logPath, signal }),
        timeoutDescription: `${updateTimeoutSeconds}s plus cleanup backstop`,
        timeoutMs: updateTimeoutSeconds * 1000 + updateCleanupBackstopMs,
        writeLog: async () => undefined,
      });
    })().finally(() => {
      job.durationMs = Date.now() - job.startedAt;
      job.done = true;
    });
    return job;
  }

  private async runMacosUpdate(ctx: UpdateJobContext): Promise<void> {
    await this.guestMacos(this.updateScript("macos"), updateTimeoutSeconds * 1000, ctx);
  }

  private runWindowsUpdate(ctx: UpdateJobContext): Promise<void> {
    return this.guestWindows(this.updateScript("windows"), updateTimeoutSeconds * 1000, ctx);
  }

  private async runLinuxUpdate(ctx: UpdateJobContext): Promise<void> {
    await this.guestLinux(this.updateScript("linux"), updateTimeoutSeconds * 1000, ctx);
  }

  private updateScript(platform: Platform): string {
    const input = {
      auth: this.authForPlatform(platform),
      expectedNeedle: this.updateExpectedNeedle,
      updateTarget: this.updateTargetEffective,
    };
    switch (platform) {
      case "macos":
        return macosUpdateScript(input);
      case "windows":
        return windowsUpdateScript(input);
      case "linux":
        return linuxUpdateScript(input);
    }
    return die("unsupported platform");
  }

  private authForPlatform(platform: Platform): ProviderAuth {
    return platform === "windows" ? this.windowsAuth : this.auth;
  }

  private spawnLogged(
    command: string,
    args: string[],
    logPath: string,
    env: NodeJS.ProcessEnv = {},
    onOutput: (text: string) => void = () => undefined,
    options: SpawnLoggedOptions = {},
  ): Promise<number> {
    return spawnLoggedCommand(command, args, logPath, env, onOutput, options);
  }

  private async monitorJobs(label: string, jobs: Job[]): Promise<void> {
    const pending = new Set(jobs.map((job) => job.label));
    while (pending.size > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, 15_000);
      });
      for (const job of jobs) {
        if (!pending.has(job.label)) {
          continue;
        }
        if (job.done) {
          pending.delete(job.label);
        }
      }
      if (pending.size > 0) {
        const status = jobs
          .filter((job) => pending.has(job.label))
          .map((job) => {
            const elapsed = Math.floor((Date.now() - job.startedAt) / 1000);
            const stale = Math.floor((Date.now() - job.lastOutputAt) / 1000);
            return `${job.label}:${job.lastPhase} ${elapsed}s stale=${stale}s bytes=${job.lastBytes}`;
          })
          .join(", ");
        say(`${label} still running: ${status}`);
      }
    }
  }

  private async guestMacos(
    script: string,
    timeoutMs: number,
    ctx: UpdateJobContext,
  ): Promise<void> {
    const scriptPath = this.writeGuestScript(
      macosVm,
      script,
      "openclaw-parallels-npm-update-macos",
    );
    const macosExecArgs = this.resolveMacosUpdateExecArgs(ctx);
    const sudoUserArgIndex = macosExecArgs.indexOf("-u");
    const sudoUser =
      sudoUserArgIndex >= 0 && sudoUserArgIndex + 1 < macosExecArgs.length
        ? macosExecArgs[sudoUserArgIndex + 1]
        : "";
    if (sudoUser) {
      run("prlctl", ["exec", macosVm, "/usr/sbin/chown", sudoUser, scriptPath], {
        timeoutMs: 30_000,
      });
    }
    try {
      const status = await this.runStreamingToJobLog(
        "prlctl",
        ["exec", macosVm, ...macosExecArgs, "/bin/bash", scriptPath],
        timeoutMs,
        ctx,
      );
      if (status !== 0) {
        throw new Error(`macOS update command failed with exit code ${status}`);
      }
    } finally {
      this.removeGuestScript(macosVm, scriptPath);
    }
  }

  private resolveMacosUpdateExecArgs(ctx: UpdateJobContext): string[] {
    const guestPath =
      "/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/local/bin:/usr/local/sbin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
    const currentUser = run("prlctl", ["exec", macosVm, "--current-user", "whoami"], {
      check: false,
      quiet: true,
      timeoutMs: 45_000,
    });
    const user = currentUser.stdout.trim().replaceAll("\r", "").split("\n").at(-1) ?? "";
    if (currentUser.status === 0 && /^[A-Za-z0-9._-]+$/.test(user)) {
      return ["--current-user", "/usr/bin/env", `PATH=${guestPath}`];
    }

    const fallbackUser = this.resolveMacosDesktopUser();
    if (!fallbackUser) {
      ctx.append(currentUser.stdout);
      ctx.append(currentUser.stderr);
      throw new Error("macOS desktop user unavailable before update phase");
    }
    ctx.append(
      `desktop user unavailable via Parallels --current-user; using root sudo fallback for ${fallbackUser}\n`,
    );
    const home = this.resolveMacosDesktopHome(fallbackUser);
    return [
      "/usr/bin/sudo",
      "-H",
      "-u",
      fallbackUser,
      "/usr/bin/env",
      `HOME=${home}`,
      `USER=${fallbackUser}`,
      `LOGNAME=${fallbackUser}`,
      `PATH=${guestPath}`,
    ];
  }

  private resolveMacosDesktopUser(): string {
    const consoleUser =
      run("prlctl", ["exec", macosVm, "/usr/bin/stat", "-f", "%Su", "/dev/console"], {
        check: false,
        quiet: true,
        timeoutMs: 30_000,
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
      ["exec", macosVm, "/usr/bin/dscl", ".", "-list", "/Users", "NFSHomeDirectory"],
      { check: false, quiet: true, timeoutMs: 30_000 },
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

  private resolveMacosDesktopHome(user: string): string {
    const output = run(
      "prlctl",
      ["exec", macosVm, "/usr/bin/dscl", ".", "-read", `/Users/${user}`, "NFSHomeDirectory"],
      { check: false, quiet: true, timeoutMs: 30_000 },
    ).stdout.replaceAll("\r", "");
    const match = /NFSHomeDirectory:\s*(\S+)/.exec(output);
    return match?.[1] ?? `/Users/${user}`;
  }

  private async guestWindows(
    script: string,
    timeoutMs: number,
    ctx: UpdateJobContext,
  ): Promise<void> {
    await runWindowsBackgroundPowerShell({
      append: (chunk) => ctx.append(chunk),
      label: "Windows update",
      script,
      timeoutMs,
      vmName: windowsVm,
    });
  }

  private async guestLinux(
    script: string,
    timeoutMs: number,
    ctx: UpdateJobContext,
  ): Promise<void> {
    const scriptPath = this.writeGuestScript(
      this.linuxVm,
      script,
      "openclaw-parallels-npm-update-linux",
    );
    try {
      const status = await this.runStreamingToJobLog(
        "prlctl",
        [
          "exec",
          this.linuxVm,
          "/usr/bin/env",
          "HOME=/root",
          "OPENCLAW_ALLOW_ROOT=1",
          "PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/snap/bin",
          "bash",
          scriptPath,
        ],
        timeoutMs,
        ctx,
      );
      if (status !== 0) {
        throw new Error(`Linux update command failed with exit code ${status}`);
      }
    } finally {
      this.removeGuestScript(this.linuxVm, scriptPath);
    }
  }

  private writeGuestScript(vm: string, script: string, prefix: string): string {
    const scriptPath = `/tmp/${prefix}-${process.pid}-${Date.now()}.sh`;
    const write = run("prlctl", ["exec", vm, "/usr/bin/tee", scriptPath], {
      check: false,
      input: script,
      quiet: true,
      timeoutMs: 120_000,
    });
    if (write.status !== 0) {
      throw new Error(`failed to write guest script ${scriptPath}: ${write.stderr.trim()}`);
    }
    const chmod = run("prlctl", ["exec", vm, "/bin/chmod", "755", scriptPath], {
      check: false,
      quiet: true,
      timeoutMs: 30_000,
    });
    if (chmod.status !== 0) {
      throw new Error(`failed to chmod guest script ${scriptPath}: ${chmod.stderr.trim()}`);
    }
    return scriptPath;
  }

  private removeGuestScript(vm: string, scriptPath: string): void {
    run("prlctl", ["exec", vm, "/bin/rm", "-f", scriptPath], {
      check: false,
      quiet: true,
      timeoutMs: 30_000,
    });
  }

  private async runStreamingToJobLog(
    command: string,
    args: string[],
    timeoutMs: number,
    ctx: UpdateJobContext,
  ): Promise<number> {
    return await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: repoRoot,
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout.on("data", (chunk: Buffer) => ctx.append(chunk));
      child.stderr.on("data", (chunk: Buffer) => ctx.append(chunk));

      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const signalChild = (signal: NodeJS.Signals): void => {
        if (!child.pid) {
          return;
        }
        try {
          if (process.platform === "win32") {
            child.kill(signal);
          } else {
            process.kill(-child.pid, signal);
          }
        } catch {
          child.kill(signal);
        }
      };
      const abort = (): void => {
        if (timedOut) {
          return;
        }
        timedOut = true;
        signalChild("SIGTERM");
        killTimer = setTimeout(() => signalChild("SIGKILL"), 2_000);
        killTimer.unref();
      };
      if (ctx.signal.aborted) {
        abort();
      } else {
        ctx.signal.addEventListener("abort", abort, { once: true });
      }
      const timer = setTimeout(() => {
        abort();
      }, timeoutMs);

      child.on("error", (error) => {
        ctx.signal.removeEventListener("abort", abort);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        reject(error);
      });
      child.on("close", (code, signal) => {
        ctx.signal.removeEventListener("abort", abort);
        clearTimeout(timer);
        if (killTimer) {
          clearTimeout(killTimer);
        }
        if (timedOut) {
          signalChild("SIGKILL");
          resolve(124);
          return;
        }
        resolve(code ?? (signal ? 128 : 1));
      });
    });
  }

  private isExplicitPackageTarget(target: string): boolean {
    return (
      target.includes("://") ||
      target.includes("#") ||
      /^(file|github|git\+ssh|git\+https|git\+http|git\+file|npm):/.test(target)
    );
  }

  private preflightRegistryUpdateTarget(): void {
    if (
      !this.options.updateTarget ||
      this.options.updateTarget === "local-main" ||
      this.isExplicitPackageTarget(this.options.updateTarget)
    ) {
      return;
    }
    const baseline = resolveOpenClawRegistryVersion(this.packageSpec);
    const target = resolveOpenClawRegistryVersion(this.options.updateTarget);
    if (baseline && target && baseline === target) {
      die(
        `--update-target ${this.options.updateTarget} resolves to openclaw@${target}, same as baseline ${this.packageSpec}; publish or choose a newer --update-target before running VM update coverage`,
      );
    }
  }

  private platformFromLabel(label: string): Platform {
    if (label === "macOS") {
      return "macos";
    }
    return label.toLowerCase() as Platform;
  }

  private async extractLastVersion(logPath: string): Promise<string> {
    return await extractLastOpenClawVersionFromLog(logPath);
  }

  private dumpLogTail(logPath: string): void {
    const log = run("tail", ["-n", "80", logPath], { check: false, quiet: true }).stdout;
    if (log) {
      process.stderr.write(`\n--- tail ${logPath} ---\n`);
      process.stderr.write(log);
    }
  }

  private recordTiming(phase: "fresh" | "fresh-target" | "update", job: Job, status: string): void {
    this.timings.push({
      durationMs: job.durationMs || Date.now() - job.startedAt,
      label: job.label,
      logPath: job.logPath,
      phase,
      status,
    });
  }

  private configurePublishedTargets(): void {
    if (this.options.betaValidation) {
      const version = resolveOpenClawRegistryVersion(this.options.betaValidation);
      if (!version) {
        die(`could not resolve beta validation target: ${this.options.betaValidation}`);
      }
      this.options.updateTarget = version;
      this.options.freshTargetSpec = `openclaw@${version}`;
      say(`Beta validation target: openclaw@${version}`);
    } else if (
      this.options.updateTarget &&
      this.options.updateTarget !== "local-main" &&
      !this.isExplicitPackageTarget(this.options.updateTarget)
    ) {
      const version = resolveOpenClawRegistryVersion(this.options.updateTarget);
      if (version) {
        this.options.updateTarget = version;
      }
    }

    if (this.options.freshTargetSpec) {
      const version = resolveOpenClawRegistryVersion(this.options.freshTargetSpec);
      this.freshTargetSpec = version ? `openclaw@${version}` : this.options.freshTargetSpec;
    }
  }

  private assertPublishedTargetMatchesHarnessCheckout(): void {
    if (process.env.OPENCLAW_PARALLELS_ALLOW_HARNESS_TARGET_MISMATCH === "1") {
      return;
    }
    const candidateVersion = this.freshTargetSpec
      ? parseOpenClawPackageSpecVersion(this.freshTargetSpec)
      : parseOpenClawPackageSpecVersion(this.options.updateTarget);
    const targetFamily = openClawVersionFamily(candidateVersion);
    if (!targetFamily) {
      return;
    }
    this.harnessTargetFamily = targetFamily;
    const checkoutFamily = openClawVersionFamily(this.harnessCheckoutVersion);
    if (checkoutFamily === targetFamily) {
      return;
    }
    die(
      `refusing to run Parallels ${candidateVersion} target with harness checkout ${this.harnessCheckoutVersion || "unknown"}; checkout the matching release branch or set OPENCLAW_PARALLELS_ALLOW_HARNESS_TARGET_MISMATCH=1 for an intentional cross-version harness run`,
    );
  }

  private noteJobOutput(job: Job, text: string): void {
    job.lastOutputAt = Date.now();
    job.lastBytes += text.length;
    const matches = [...text.matchAll(/[=]=>\s*([A-Za-z0-9_.-]+)/g)];
    const phase = matches.at(-1)?.[1];
    if (phase) {
      job.lastPhase = phase;
    }
  }

  private formatRerun(command: string, args: string[], env: NodeJS.ProcessEnv): string {
    const envPrefix = Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}=${shellQuote(String(value))}`);
    return [...envPrefix, command, ...args.map(shellQuote)].join(" ");
  }

  private async writeSummary(): Promise<string> {
    const slowestTiming = this.timings.toSorted((a, b) => b.durationMs - a.durationMs)[0];
    const summary: NpmUpdateSummary = {
      currentHead: this.currentHeadShort,
      fresh: this.freshStatus,
      freshTarget: this.freshTargetStatus,
      freshTargetSpec: this.freshTargetSpec,
      harnessCheckoutVersion: this.harnessCheckoutVersion,
      harnessTargetFamily: this.harnessTargetFamily,
      latestVersion: this.latestVersion,
      packageSpec: this.packageSpec,
      provider: this.options.provider,
      runDir: this.runDir,
      update: {
        linux: { status: this.updateStatus.linux, version: this.updateVersion.linux },
        macos: { status: this.updateStatus.macos, version: this.updateVersion.macos },
        windows: { status: this.updateStatus.windows, version: this.updateVersion.windows },
      },
      timings: this.timings,
      slowestTiming: slowestTiming
        ? {
            durationMs: slowestTiming.durationMs,
            label: slowestTiming.label,
            phase: slowestTiming.phase,
          }
        : undefined,
      totalDurationMs: Date.now() - this.startedAt,
      updateExpected: this.updateExpectedNeedle,
      updateTargetBuildCommit: this.updateTargetBuildCommit,
      updateTargetPackageVersion: this.updateTargetPackageVersion,
      updateTargetTarball: this.updateTargetTarball,
      updateTarget: this.updateTargetEffective,
    };
    const summaryPath = path.join(this.runDir, "summary.json");
    await writeJson(summaryPath, summary);
    await writeSummaryMarkdown({
      lines: [
        `- package spec: ${summary.packageSpec}`,
        `- update target: ${summary.updateTarget}`,
        `- update target package: ${summary.updateTargetPackageVersion || "unknown"}${summary.updateTargetBuildCommit ? ` (${summary.updateTargetBuildCommit})` : ""}`,
        `- update target tarball: ${summary.updateTargetTarball || "n/a"}`,
        `- update expected: ${summary.updateExpected}`,
        `- fresh: macOS=${summary.fresh.macos}, Windows=${summary.fresh.windows}, Linux=${summary.fresh.linux}`,
        `- update: macOS=${summary.update.macos.status} (${summary.update.macos.version}), Windows=${summary.update.windows.status} (${summary.update.windows.version}), Linux=${summary.update.linux.status} (${summary.update.linux.version})`,
        `- fresh target: ${summary.freshTargetSpec || "skip"} macOS=${summary.freshTarget.macos}, Windows=${summary.freshTarget.windows}, Linux=${summary.freshTarget.linux}`,
        `- wall clock: ${formatDuration(summary.totalDurationMs)}`,
        `- slowest phase: ${summary.slowestTiming ? `${summary.slowestTiming.phase}/${summary.slowestTiming.label} ${formatDuration(summary.slowestTiming.durationMs)}` : "n/a"}`,
        `- logs: ${summary.runDir}`,
      ],
      summaryPath,
      title: "Parallels NPM Update Smoke",
    });
    return summaryPath;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const runSmoke = () => new NpmUpdateSmoke(options).run();
  const runPromise = options.json ? withProgressOnStderr(runSmoke) : runSmoke();
  await runPromise.catch((error: unknown) => {
    die(error instanceof Error ? error.message : String(error));
  });
}
