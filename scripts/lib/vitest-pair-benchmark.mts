import { spawnSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, totalmem } from "node:os";
import path from "node:path";
import { inspectManagedProcessGroup, runManagedCommand } from "./managed-child-process.mts";
import {
  analyzeBenchmark,
  assertEquivalentInventories,
  assertExactSha,
  assertInventoryAvailable,
  buildBenchmarkSchedule,
  sha256,
  writeJsonAtomic,
  type BenchmarkLane,
  type BenchmarkManifest,
  type BenchmarkRunPlan,
  type BenchmarkRunRecord,
  type BenchmarkSide,
  type PackageManagerIdentity,
  type ProcessSample,
} from "./vitest-pair-benchmark-contract.mts";

export {
  analyzeBenchmark,
  assertEquivalentInventories,
  assertExactSha,
  assertInventoryAvailable,
  assertSingleWorkflowAttempt,
  benchmarkInventoryDigest,
  buildBenchmarkSchedule,
  loadBenchmarkManifest,
  sha256,
  validateBenchmarkManifest,
  withTerminalManifest,
  writeJsonAtomic,
} from "./vitest-pair-benchmark-contract.mts";
export type {
  BenchmarkAnalysis,
  BenchmarkLane,
  BenchmarkManifest,
  BenchmarkPhase,
  BenchmarkRunPlan,
  BenchmarkRunRecord,
  BenchmarkSide,
  BenchmarkThresholds,
  PackageManagerIdentity,
  ProcessSample,
} from "./vitest-pair-benchmark-contract.mts";

const SAMPLE_INTERVAL_MS = 100;
const CHILD_TIMEOUT_MS = 15 * 60 * 1000;
const ATTRIBUTED_DESCENDANT_KILL_GRACE_MS = 2_000;
const ATTRIBUTED_DESCENDANT_DRAIN_MS = 5_000;
const ATTRIBUTED_DESCENDANT_POLL_MS = 25;
export const VITEST_PAIR_HARNESS_DEADLINE_MS = 165 * 60 * 1000;
let cachedLinuxPageSize: number | undefined;

type RunCommandOptions = {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  samplePath?: string;
  deadline?: VitestPairDeadline;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type RunCommandResult = {
  exitCode: number;
  durationMs: number;
  samples: ProcessSample[];
  childPid: number | null;
};

type BenchmarkContext = {
  baselineDir: string;
  baselineSha: string;
  candidateDir: string;
  candidateSha: string;
  manifest: BenchmarkManifest;
  outputDir: string;
  pnpmBin: string;
  scratchDir: string;
};

type LinuxProcess = {
  pid: number;
  parentPid: number;
  processGroup: number;
  rssBytes: number;
  startTimeTicks: string;
  state: string;
};

export type VitestPairDeadline = {
  deadlineAt: number;
  signal: AbortSignal;
  throwIfExpired: () => void;
};

function parseProcStat(contents: string, pageSize: number): LinuxProcess {
  const close = contents.lastIndexOf(")");
  if (close < 0) {
    throw new Error("invalid /proc stat row");
  }
  const pid = Number.parseInt(contents.slice(0, contents.indexOf(" ")), 10);
  const fields = contents
    .slice(close + 2)
    .trim()
    .split(/\s+/u);
  return {
    pid,
    state: fields[0] ?? "",
    parentPid: Number.parseInt(fields[1] ?? "", 10),
    processGroup: Number.parseInt(fields[2] ?? "", 10),
    startTimeTicks: fields[19] ?? "",
    rssBytes: Math.max(0, Number.parseInt(fields[21] ?? "", 10)) * pageSize,
  };
}

function linuxPageSize(): number {
  if (cachedLinuxPageSize !== undefined) {
    return cachedLinuxPageSize;
  }
  const result = spawnSync("getconf", ["PAGESIZE"], { encoding: "utf8" });
  const pageSize = Number.parseInt(result.stdout.trim(), 10);
  if (result.status !== 0 || !Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error("unable to resolve Linux page size");
  }
  cachedLinuxPageSize = pageSize;
  return cachedLinuxPageSize;
}

function readLinuxProcess(pid: number, pageSize: number): LinuxProcess | undefined {
  try {
    return parseProcStat(readFileSync(`/proc/${String(pid)}/stat`, "utf8"), pageSize);
  } catch {
    return undefined;
  }
}

function readLinuxProcessSnapshot(pageSize: number): Map<number, LinuxProcess> {
  const snapshot = new Map<number, LinuxProcess>();
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/u.test(entry)) {
      continue;
    }
    const process = readLinuxProcess(Number.parseInt(entry, 10), pageSize);
    if (process) {
      snapshot.set(process.pid, process);
    }
  }
  return snapshot;
}

function isLiveLinuxProcess(process: LinuxProcess): boolean {
  return process.state !== "Z" && process.state !== "X" && process.state !== "x";
}

class LinuxDescendantTracker {
  private readonly identities = new Map<number, string>();
  private readonly pageSize: number;

  constructor(rootPid: number, pageSize = linuxPageSize()) {
    this.pageSize = pageSize;
    const root = readLinuxProcess(rootPid, pageSize);
    if (!root) {
      throw new Error(`unable to read benchmark root process identity ${String(rootPid)}`);
    }
    this.identities.set(root.pid, root.startTimeTicks);
  }

  sample(): Omit<ProcessSample, "atMs"> {
    const snapshot = readLinuxProcessSnapshot(this.pageSize);
    this.discover(snapshot);
    const processes = this.liveProcesses(snapshot);
    return {
      processCount: processes.length,
      rssBytes: processes.reduce((total, process) => total + process.rssBytes, 0),
      processes: processes.map(({ pid, parentPid, processGroup, startTimeTicks, rssBytes }) => ({
        pid,
        parentPid,
        processGroup,
        startTimeTicks,
        rssBytes,
      })),
    };
  }

  async terminateRemaining(rootPid: number): Promise<{ hadLiveDescendants: boolean }> {
    let live = this.liveDescendants(rootPid);
    const hadLiveDescendants = live.length > 0;
    if (!hadLiveDescendants) {
      return { hadLiveDescendants: false };
    }

    const forceAt = Date.now() + ATTRIBUTED_DESCENDANT_KILL_GRACE_MS;
    const deadlineAt = forceAt + ATTRIBUTED_DESCENDANT_DRAIN_MS;
    while (live.length > 0 && Date.now() < deadlineAt) {
      const signal: NodeJS.Signals = Date.now() >= forceAt ? "SIGKILL" : "SIGTERM";
      for (const process of live) {
        this.signalExact(process, signal);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, ATTRIBUTED_DESCENDANT_POLL_MS);
      });
      live = this.liveDescendants(rootPid);
    }
    if (live.length > 0) {
      throw Object.assign(
        new Error(
          `benchmark cleanup could not terminate attributed descendants: ${live
            .map((process) => `${String(process.pid)}:${process.startTimeTicks}`)
            .join(", ")}`,
        ),
        { code: "EPROCESS_TREE_CLEANUP_FAILED", processTreeState: "live" },
      );
    }
    return { hadLiveDescendants };
  }

  private discover(snapshot: Map<number, LinuxProcess>): void {
    let added = true;
    while (added) {
      added = false;
      for (const process of snapshot.values()) {
        const knownIdentity = this.identities.get(process.pid);
        if (knownIdentity !== undefined) {
          continue;
        }
        const parentIdentity = this.identities.get(process.parentPid);
        const parent = snapshot.get(process.parentPid);
        if (parentIdentity && parent?.startTimeTicks === parentIdentity) {
          this.identities.set(process.pid, process.startTimeTicks);
          added = true;
        }
      }
    }
  }

  private liveProcesses(snapshot: Map<number, LinuxProcess>): LinuxProcess[] {
    const processes: LinuxProcess[] = [];
    for (const [pid, startTimeTicks] of this.identities) {
      const process = snapshot.get(pid);
      if (process && process.startTimeTicks === startTimeTicks && isLiveLinuxProcess(process)) {
        processes.push(process);
      }
    }
    return processes.toSorted((left, right) => left.pid - right.pid);
  }

  private liveDescendants(rootPid: number): LinuxProcess[] {
    const snapshot = readLinuxProcessSnapshot(this.pageSize);
    this.discover(snapshot);
    return this.liveProcesses(snapshot).filter((process) => process.pid !== rootPid);
  }

  private signalExact(process: LinuxProcess, signal: NodeJS.Signals): void {
    const current = readLinuxProcess(process.pid, this.pageSize);
    if (!current || current.startTimeTicks !== process.startTimeTicks) {
      return;
    }
    try {
      processKill(current.pid, signal);
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ESRCH") {
        throw error;
      }
    }
  }
}

function processKill(pid: number, signal: NodeJS.Signals): void {
  process.kill(pid, signal);
}

function deadlineError(timeoutMs: number): Error {
  return Object.assign(
    new Error(`Vitest pair aggregate deadline exceeded after ${String(timeoutMs)}ms`),
    { code: "ETIMEDOUT" },
  );
}

function normalizeError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export async function withVitestPairDeadline<T>(
  task: (deadline: VitestPairDeadline) => Promise<T>,
  timeoutMs = VITEST_PAIR_HARNESS_DEADLINE_MS,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Vitest pair aggregate deadline must be a positive integer");
  }
  const controller = new AbortController();
  const deadlineAt = Date.now() + timeoutMs;
  const expire = () => {
    if (!controller.signal.aborted) {
      controller.abort(deadlineError(timeoutMs));
    }
  };
  const timer = setTimeout(expire, timeoutMs);
  const deadline: VitestPairDeadline = {
    deadlineAt,
    signal: controller.signal,
    throwIfExpired() {
      if (Date.now() >= deadlineAt) {
        expire();
      }
      controller.signal.throwIfAborted();
    },
  };
  try {
    const result = await task(deadline);
    deadline.throwIfExpired();
    return result;
  } catch (error) {
    if (controller.signal.aborted) {
      throw normalizeError(controller.signal.reason);
    }
    throw normalizeError(error);
  } finally {
    clearTimeout(timer);
  }
}

export async function runOwnedCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  const signal = options.deadline?.signal ?? options.signal;
  options.deadline?.throwIfExpired();
  signal?.throwIfAborted();
  mkdirSync(path.dirname(options.logPath), { recursive: true });
  if (options.samplePath) {
    mkdirSync(path.dirname(options.samplePath), { recursive: true });
  }
  const logFd = openSync(options.logPath, "wx", 0o600);
  const samples: ProcessSample[] = [];
  let childPid: number | null = null;
  let tracker: LinuxDescendantTracker | undefined;
  let sampler: ReturnType<typeof setInterval> | undefined;
  let exitCode: number | undefined;
  let commandError: Error | undefined;
  let durationMs = 0;
  let hadLiveDescendants = false;
  const started = process.hrtime.bigint();
  const sample = () => {
    if (!tracker) {
      return;
    }
    const reading = tracker.sample();
    samples.push({
      atMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      ...reading,
    });
  };
  try {
    options.deadline?.throwIfExpired();
    exitCode = await runManagedCommand({
      bin: options.bin,
      args: options.args,
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", logFd, logFd],
      timeoutMs: options.timeoutMs ?? CHILD_TIMEOUT_MS,
      timeoutKillGraceMs: 2_000,
      timeoutForceKillOnLeaderExit: true,
      requireProcessTreeExit: true,
      signal,
      abortKillGraceMs: 2_000,
      onReady(child) {
        childPid = child.pid ?? null;
        if (childPid && process.platform === "linux") {
          tracker = new LinuxDescendantTracker(childPid);
        }
        sample();
        sampler = setInterval(sample, SAMPLE_INTERVAL_MS);
      },
    });
    if (
      childPid &&
      inspectManagedProcessGroup(
        { pid: childPid, exitCode, signalCode: null },
        { errorPolicy: "indeterminate" },
      ) !== "dead"
    ) {
      throw new Error(`managed command process group ${String(childPid)} did not quiesce`);
    }
    durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  } catch (error) {
    durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    commandError = normalizeError(signal?.aborted ? (signal.reason ?? error) : error);
  } finally {
    clearInterval(sampler);
    sample();
    try {
      if (tracker && childPid) {
        ({ hadLiveDescendants } = await tracker.terminateRemaining(childPid));
      }
    } catch (cleanupError) {
      const normalizedCleanupError = normalizeError(cleanupError);
      commandError = commandError
        ? new AggregateError(
            [commandError, normalizedCleanupError],
            "benchmark command and attributed descendant cleanup failed",
            { cause: normalizedCleanupError },
          )
        : normalizedCleanupError;
    } finally {
      closeSync(logFd);
      if (options.samplePath) {
        writeFileSync(
          options.samplePath,
          samples.map((entry) => JSON.stringify(entry)).join("\n") + (samples.length ? "\n" : ""),
          { flag: "wx", mode: 0o600 },
        );
      }
    }
  }
  if (commandError) {
    throw commandError;
  }
  if (hadLiveDescendants) {
    throw Object.assign(
      new Error("managed command exited while attributed descendants remained active"),
      { code: "EPROCESS_TREE_CLEANUP_FAILED", processTreeState: "terminated" },
    );
  }
  return {
    exitCode: exitCode ?? 1,
    durationMs,
    samples,
    childPid,
  };
}

function parseGnuTime(file: string) {
  const text = readFileSync(file, "utf8");
  const readSeconds = (label: string) => {
    const match = new RegExp(`^\\s*${label}:\\s*([0-9.]+)\\s*$`, "mu").exec(text);
    if (!match) {
      throw new Error(`GNU time output is missing ${label}`);
    }
    return Number.parseFloat(match[1]!) * 1000;
  };
  return {
    userCpuMs: readSeconds("User time \\(seconds\\)"),
    systemCpuMs: readSeconds("System time \\(seconds\\)"),
  };
}

export function resolvePackageManagerIdentity(
  pnpmBin: string,
  isolationRoot: string,
  ambientEnv: NodeJS.ProcessEnv = process.env,
  deadline?: VitestPairDeadline,
): PackageManagerIdentity {
  deadline?.throwIfExpired();
  const resolvedExecutable = realpathSync(pnpmBin);
  const probeCache = path.join(isolationRoot, "cache");
  const probeHome = path.join(isolationRoot, "home");
  const env = buildBenchmarkCommandEnv(
    probeHome,
    probeCache,
    {
      executable: pnpmBin,
      resolvedExecutable,
      version: "unresolved",
    },
    ambientEnv,
  );
  return {
    executable: pnpmBin,
    resolvedExecutable,
    version: commandVersion(pnpmBin, env, deadline),
  };
}

export function buildBenchmarkCommandEnv(
  home: string,
  cacheRoot: string,
  packageManager: PackageManagerIdentity,
  ambientEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });
  const corepackHome = path.join(cacheRoot, "corepack");
  const pnpmHome = path.join(cacheRoot, "pnpm-home");
  const npmCache = path.join(cacheRoot, "npm-cache");
  for (const directory of [corepackHome, pnpmHome, npmCache, path.join(cacheRoot, "tmp")]) {
    mkdirSync(directory, { recursive: true });
  }
  return {
    CI: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    COREPACK_HOME: corepackHome,
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NODE_COMPILE_CACHE: path.join(cacheRoot, "node-compile"),
    PNPM_HOME: pnpmHome,
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(cacheRoot, "vitest-fs"),
    OPENCLAW_VITEST_MAX_WORKERS: "1",
    OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
    PATH: ambientEnv.PATH,
    TMPDIR: path.join(cacheRoot, "tmp"),
    npm_config_cache: npmCache,
    npm_execpath: packageManager.executable,
  };
}

function runVitestArgs(lane: BenchmarkLane): string[] {
  if (lane.config) {
    return [
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      lane.config,
      "--reporter=dot",
      ...lane.files,
    ];
  }
  return ["scripts/run-vitest.mjs", ...lane.files, "--", "--reporter=dot"];
}

async function runBenchmarkCommand(
  context: BenchmarkContext,
  plan: BenchmarkRunPlan,
  packageManager: PackageManagerIdentity,
  deadline: VitestPairDeadline,
): Promise<BenchmarkRunRecord> {
  deadline.throwIfExpired();
  const checkout = plan.side === "baseline" ? context.baselineDir : context.candidateDir;
  const phaseRoot = path.join(context.outputDir, plan.phase);
  const runRoot = path.join(phaseRoot, plan.id);
  const warmSeed = path.join(context.scratchDir, "warm-cache", plan.side, plan.lane.id);
  const cacheRoot =
    plan.phase === "warmup"
      ? warmSeed
      : path.join(context.scratchDir, "run-cache", plan.phase, plan.id);
  mkdirSync(runRoot, { recursive: true });
  if (plan.phase === "measured") {
    if (!existsSync(warmSeed)) {
      throw new Error(`warmup cache is missing for ${plan.side}/${plan.lane.id}`);
    }
    cpSync(warmSeed, cacheRoot, { recursive: true, force: false, errorOnExist: true });
  }
  const home = path.join(cacheRoot, "home");
  mkdirSync(path.join(cacheRoot, "tmp"), { recursive: true });
  const timePath = path.join(runRoot, "gnu-time.txt");
  const logPath = path.join(runRoot, "output.log");
  const samplePath = path.join(runRoot, "process-samples.jsonl");
  const vitestArgs = runVitestArgs(plan.lane);
  const command = ["/usr/bin/time", "-v", "-o", timePath, process.execPath, ...vitestArgs];
  const startedAt = new Date().toISOString();
  let result: RunCommandResult | undefined;
  try {
    result = await runOwnedCommand({
      bin: command[0]!,
      args: command.slice(1),
      cwd: checkout,
      env: buildBenchmarkCommandEnv(home, cacheRoot, packageManager),
      logPath,
      samplePath,
      deadline,
    });
    const timing = parseGnuTime(timePath);
    const record: BenchmarkRunRecord = {
      id: plan.id,
      phase: plan.phase,
      side: plan.side,
      lane: plan.lane.id,
      round: plan.round,
      pair: plan.pair,
      cacheMode: plan.cacheMode,
      command,
      packageManager,
      startedAt,
      durationMs: result.durationMs,
      userCpuMs: timing.userCpuMs,
      systemCpuMs: timing.systemCpuMs,
      peakRssBytes: Math.max(...result.samples.map((sample) => sample.rssBytes), 1),
      processSampleCount: result.samples.length,
      exitCode: result.exitCode,
    };
    writeJsonAtomic(path.join(runRoot, "record.json"), record);
    if (result.exitCode !== 0) {
      throw new Error(`${plan.id} exited with status ${result.exitCode}`);
    }
    return record;
  } catch (error) {
    const record: BenchmarkRunRecord = {
      id: plan.id,
      phase: plan.phase,
      side: plan.side,
      lane: plan.lane.id,
      round: plan.round,
      pair: plan.pair,
      cacheMode: plan.cacheMode,
      command,
      packageManager,
      startedAt,
      durationMs: result?.durationMs ?? 0,
      userCpuMs: 0,
      systemCpuMs: 0,
      peakRssBytes: Math.max(...(result?.samples ?? []).map((sample) => sample.rssBytes), 0),
      processSampleCount: result?.samples.length ?? 0,
      exitCode: result?.exitCode ?? null,
      error: error instanceof Error ? error.message : String(error),
    };
    const recordPath = path.join(runRoot, "record.json");
    if (!existsSync(recordPath)) {
      writeJsonAtomic(recordPath, record);
    }
    throw error;
  }
}

async function runSetupCommand(
  context: BenchmarkContext,
  side: BenchmarkSide,
  packageManager: PackageManagerIdentity,
  deadline: VitestPairDeadline,
): Promise<void> {
  deadline.throwIfExpired();
  const checkout = side === "baseline" ? context.baselineDir : context.candidateDir;
  const setupRoot = path.join(context.scratchDir, "setup", side);
  const setupLogRoot = path.join(context.outputDir, "setup", side);
  const home = path.join(setupRoot, "home");
  const store = path.join(setupRoot, "pnpm-store");
  const cacheRoot = path.join(setupRoot, "cache");
  mkdirSync(path.join(cacheRoot, "tmp"), { recursive: true });
  const result = await runOwnedCommand({
    bin: context.pnpmBin,
    args: ["install", "--frozen-lockfile", "--store-dir", store],
    cwd: checkout,
    env: buildBenchmarkCommandEnv(home, cacheRoot, packageManager),
    logPath: path.join(setupLogRoot, "install.log"),
    deadline,
    timeoutMs: 20 * 60 * 1000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${side} frozen install exited with status ${result.exitCode}`);
  }
}

function gitOutput(cwd: string, args: string[], deadline?: VitestPairDeadline): string {
  deadline?.throwIfExpired();
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  }
  deadline?.throwIfExpired();
  return result.stdout.trim();
}

function commandVersion(
  bin: string,
  env: NodeJS.ProcessEnv,
  deadline?: VitestPairDeadline,
): string {
  deadline?.throwIfExpired();
  const result = spawnSync(bin, ["--version"], { encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(`unable to execute ${bin} --version`);
  }
  deadline?.throwIfExpired();
  return result.stdout.trim();
}

function collectArtifactHashes(root: string) {
  const entries: Array<{ path: string; sha256: string; bytes: number }> = [];
  const visit = (dir: string) => {
    for (const name of readdirSync(dir).toSorted()) {
      const absolute = path.join(dir, name);
      const relative = path.relative(root, absolute);
      const stat = statSync(absolute);
      if (stat.isDirectory()) {
        visit(absolute);
      } else if (
        stat.isFile() &&
        relative !== "artifact-manifest.json" &&
        relative !== "terminal-manifest.json"
      ) {
        entries.push({
          path: relative,
          sha256: sha256(readFileSync(absolute)),
          bytes: stat.size,
        });
      }
    }
  };
  visit(root);
  return entries;
}

export async function runVitestPairBenchmark(context: BenchmarkContext): Promise<void> {
  await withVitestPairDeadline(async (deadline) => {
    await runVitestPairBenchmarkBeforeDeadline(context, deadline);
  });
}

async function runVitestPairBenchmarkBeforeDeadline(
  context: BenchmarkContext,
  deadline: VitestPairDeadline,
): Promise<void> {
  deadline.throwIfExpired();
  if (process.platform !== "linux") {
    throw new Error("vitest-pair benchmark requires Linux /proc");
  }
  assertExactSha(context.baselineSha, "baseline SHA");
  assertExactSha(context.candidateSha, "candidate SHA");
  const baselineDir = realpathSync(context.baselineDir);
  const candidateDir = realpathSync(context.candidateDir);
  if (gitOutput(baselineDir, ["rev-parse", "HEAD"], deadline) !== context.baselineSha) {
    throw new Error("baseline checkout does not match the requested SHA");
  }
  if (gitOutput(candidateDir, ["rev-parse", "HEAD"], deadline) !== context.candidateSha) {
    throw new Error("candidate checkout does not match the requested SHA");
  }
  if (process.version !== "v24.19.0") {
    throw new Error(`vitest-pair benchmark requires Node v24.19.0, got ${process.version}`);
  }
  mkdirSync(context.outputDir, { recursive: true });
  mkdirSync(context.scratchDir, { recursive: true });
  const packageManager = resolvePackageManagerIdentity(
    context.pnpmBin,
    path.join(context.scratchDir, "package-manager-probe"),
    process.env,
    deadline,
  );
  deadline.throwIfExpired();
  if (packageManager.version !== "12.1.0") {
    throw new Error(`vitest-pair benchmark requires pnpm 12.1.0, got ${packageManager.version}`);
  }
  const baselineInventory = assertInventoryAvailable(baselineDir, context.manifest);
  const candidateInventory = assertInventoryAvailable(candidateDir, context.manifest);
  assertEquivalentInventories(baselineInventory, candidateInventory);
  writeJsonAtomic(path.join(context.outputDir, "environment.json"), {
    version: 1,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    packageManager,
    aggregateDeadlineMs: VITEST_PAIR_HARNESS_DEADLINE_MS,
    deadlineAt: new Date(deadline.deadlineAt).toISOString(),
    cpu: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    baselineSha: context.baselineSha,
    baselineTree: gitOutput(baselineDir, ["rev-parse", "HEAD^{tree}"], deadline),
    candidateSha: context.candidateSha,
    candidateTree: gitOutput(candidateDir, ["rev-parse", "HEAD^{tree}"], deadline),
    inventorySha256: baselineInventory.inventorySha256,
  });
  writeJsonAtomic(path.join(context.outputDir, "inventory-baseline.json"), baselineInventory);
  writeJsonAtomic(path.join(context.outputDir, "inventory-candidate.json"), candidateInventory);
  await runSetupCommand(context, "baseline", packageManager, deadline);
  await runSetupCommand(context, "candidate", packageManager, deadline);

  const correctness: BenchmarkRunRecord[] = [];
  for (const lane of context.manifest.lanes) {
    for (const side of ["baseline", "candidate"] as const) {
      deadline.throwIfExpired();
      correctness.push(
        await runBenchmarkCommand(
          context,
          {
            id: `correctness-${lane.id}-${side}`,
            phase: "correctness",
            side,
            lane,
            round: null,
            pair: null,
            cacheMode: "fresh",
          },
          packageManager,
          deadline,
        ),
      );
    }
  }
  writeJsonAtomic(path.join(context.outputDir, "correctness-manifest.json"), {
    version: 1,
    status: "success",
    inventorySha256: baselineInventory.inventorySha256,
    records: correctness,
  });

  // Timing state does not exist until both sides pass every correctness lane.
  mkdirSync(path.join(context.outputDir, "timing"), { recursive: false });
  const records: BenchmarkRunRecord[] = [];
  for (const plan of buildBenchmarkSchedule(context.manifest)) {
    deadline.throwIfExpired();
    records.push(await runBenchmarkCommand(context, plan, packageManager, deadline));
  }
  writeJsonAtomic(path.join(context.outputDir, "timing", "records.json"), {
    version: 1,
    records,
  });
  const analysis = analyzeBenchmark(records, context.manifest);
  writeJsonAtomic(path.join(context.outputDir, "analysis.json"), analysis);
  writeJsonAtomic(path.join(context.outputDir, "artifact-manifest.json"), {
    version: 1,
    files: collectArtifactHashes(context.outputDir),
  });
  if (analysis.verdict !== "pass") {
    throw new Error(
      `vitest-pair benchmark detected regression: ${analysis.regressions.join("; ")}`,
    );
  }
}
