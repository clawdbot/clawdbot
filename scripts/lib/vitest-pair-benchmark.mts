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
} from "node:fs";
import { cpus, totalmem } from "node:os";
import path from "node:path";
import { inspectManagedProcessGroup, runManagedCommand } from "./managed-child-process.mts";
import {
  analyzeBenchmark,
  assertEquivalentInventories,
  assertExecutionDigest,
  assertExactSha,
  assertInventoryAvailable,
  buildBenchmarkSchedule,
  parseVitestExecutionReport,
  sha256,
  writeJsonAtomic,
  type BenchmarkExecutionSummary,
  type BenchmarkLane,
  type BenchmarkManifest,
  type BenchmarkRunPlan,
  type BenchmarkRunRecord,
  type BenchmarkSide,
  type PackageManagerIdentity,
} from "./vitest-pair-benchmark-contract.mts";

export {
  analyzeBenchmark,
  assertEquivalentInventories,
  assertExecutionDigest,
  assertInventoryAvailable,
  assertSingleWorkflowAttempt,
  buildBenchmarkSchedule,
  loadBenchmarkManifest,
  parseVitestExecutionReport,
  validateBenchmarkManifest,
  withTerminalManifest,
  writeJsonAtomic,
} from "./vitest-pair-benchmark-contract.mts";
export type {
  BenchmarkManifest,
  BenchmarkRunRecord,
  PackageManagerIdentity,
} from "./vitest-pair-benchmark-contract.mts";

const CHILD_TIMEOUT_MS = 15 * 60 * 1000;
export const VITEST_PAIR_HARNESS_DEADLINE_MS = 165 * 60 * 1000;

type RunCommandOptions = {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  deadline?: VitestPairDeadline;
  signal?: AbortSignal;
  timeoutMs?: number;
};

type RunCommandResult = {
  exitCode: number;
  durationMs: number;
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

export type VitestPairDeadline = {
  deadlineAt: number;
  signal: AbortSignal;
  throwIfExpired: () => void;
};

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
  const logFd = openSync(options.logPath, "wx", 0o600);
  let childPid: number | null = null;
  const started = process.hrtime.bigint();
  try {
    options.deadline?.throwIfExpired();
    const exitCode = await runManagedCommand({
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
    return {
      exitCode,
      durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
    };
  } finally {
    closeSync(logFd);
  }
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

function runVitestArgs(lane: BenchmarkLane, reportFile: string): string[] {
  if (!path.isAbsolute(reportFile)) {
    throw new Error("Vitest JSON report path must be absolute");
  }
  if (lane.config) {
    return [
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      lane.config,
      "--reporter=json",
      "--includeTaskLocation",
      "--outputFile",
      reportFile,
      ...lane.files,
    ];
  }
  return [
    "scripts/run-vitest.mjs",
    ...lane.files,
    "--",
    "--reporter=json",
    "--includeTaskLocation",
    "--outputFile",
    reportFile,
  ];
}

async function runBenchmarkCommand(
  context: BenchmarkContext,
  plan: BenchmarkRunPlan,
  packageManager: PackageManagerIdentity,
  deadline: VitestPairDeadline,
  expectedExecutionDigest?: string,
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
  const reportPath = path.resolve(runRoot, "vitest-report.json");
  const vitestArgs = runVitestArgs(plan.lane, reportPath);
  const command = ["/usr/bin/time", "-v", "-o", timePath, process.execPath, ...vitestArgs];
  const startedAt = new Date().toISOString();
  let result: RunCommandResult | undefined;
  let timing: ReturnType<typeof parseGnuTime> | undefined;
  let execution: BenchmarkExecutionSummary | null = null;
  try {
    result = await runOwnedCommand({
      bin: command[0]!,
      args: command.slice(1),
      cwd: checkout,
      env: buildBenchmarkCommandEnv(home, cacheRoot, packageManager),
      logPath,
      deadline,
    });
    timing = parseGnuTime(timePath);
    if (result.exitCode !== 0) {
      throw new Error(`${plan.id} exited with status ${result.exitCode}`);
    }
    execution = parseVitestExecutionReport(reportPath, checkout, plan.lane);
    if (expectedExecutionDigest !== undefined) {
      assertExecutionDigest(execution, expectedExecutionDigest, plan.id);
    }
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
      execution,
      exitCode: result.exitCode,
    };
    writeJsonAtomic(path.join(runRoot, "record.json"), record);
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
      userCpuMs: timing?.userCpuMs ?? 0,
      systemCpuMs: timing?.systemCpuMs ?? 0,
      execution,
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
    throw new Error("vitest-pair benchmark requires Linux");
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
  if (packageManager.version !== "12.3.4") {
    throw new Error(`vitest-pair benchmark requires pnpm 12.3.4, got ${packageManager.version}`);
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
  const correctnessDigests = new Map<string, string>();
  for (const lane of context.manifest.lanes) {
    const laneRecords = new Map<BenchmarkSide, BenchmarkRunRecord>();
    for (const side of ["baseline", "candidate"] as const) {
      deadline.throwIfExpired();
      const record = await runBenchmarkCommand(
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
      );
      correctness.push(record);
      laneRecords.set(side, record);
    }
    const baselineExecution = laneRecords.get("baseline")?.execution;
    const candidateExecution = laneRecords.get("candidate")?.execution;
    if (!baselineExecution || !candidateExecution) {
      throw new Error(`correctness execution inventory is missing for lane ${lane.id}`);
    }
    assertExecutionDigest(
      candidateExecution,
      baselineExecution.digest,
      `correctness lane ${lane.id}`,
    );
    correctnessDigests.set(lane.id, baselineExecution.digest);
  }
  writeJsonAtomic(path.join(context.outputDir, "correctness-manifest.json"), {
    version: 1,
    status: "success",
    inventorySha256: baselineInventory.inventorySha256,
    executionDigests: Object.fromEntries(correctnessDigests),
    records: correctness,
  });

  // Timing state does not exist until both sides pass every correctness lane.
  mkdirSync(path.join(context.outputDir, "timing"), { recursive: false });
  const records: BenchmarkRunRecord[] = [];
  for (const plan of buildBenchmarkSchedule(context.manifest)) {
    deadline.throwIfExpired();
    const expectedExecutionDigest = correctnessDigests.get(plan.lane.id);
    if (!expectedExecutionDigest) {
      throw new Error(`correctness execution digest is missing for lane ${plan.lane.id}`);
    }
    records.push(
      await runBenchmarkCommand(context, plan, packageManager, deadline, expectedExecutionDigest),
    );
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
