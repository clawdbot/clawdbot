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
  type ProcessSample,
} from "./vitest-pair-benchmark-contract.mts";

export {
  analyzeBenchmark,
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
  ProcessSample,
} from "./vitest-pair-benchmark-contract.mts";

const SAMPLE_INTERVAL_MS = 100;
const CHILD_TIMEOUT_MS = 15 * 60 * 1000;
let cachedLinuxPageSize: number | undefined;

type RunCommandOptions = {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logPath: string;
  samplePath?: string;
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

function parseProcStat(contents: string) {
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
    processGroup: Number.parseInt(fields[2] ?? "", 10),
    rssPages: Number.parseInt(fields[21] ?? "", 10),
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

export function sampleLinuxProcessGroup(processGroup: number, pageSize = linuxPageSize()) {
  let processCount = 0;
  let rssBytes = 0;
  for (const entry of readdirSync("/proc")) {
    if (!/^[0-9]+$/u.test(entry)) {
      continue;
    }
    try {
      const stat = parseProcStat(readFileSync(`/proc/${entry}/stat`, "utf8"));
      if (stat.processGroup === processGroup) {
        processCount += 1;
        rssBytes += Math.max(0, stat.rssPages) * pageSize;
      }
    } catch {
      // Processes may exit between the directory and stat reads.
    }
  }
  return { processCount, rssBytes };
}

export async function runOwnedCommand(options: RunCommandOptions): Promise<RunCommandResult> {
  mkdirSync(path.dirname(options.logPath), { recursive: true });
  if (options.samplePath) {
    mkdirSync(path.dirname(options.samplePath), { recursive: true });
  }
  const logFd = openSync(options.logPath, "wx", 0o600);
  const samples: ProcessSample[] = [];
  let childPid: number | null = null;
  let sampler: ReturnType<typeof setInterval> | undefined;
  const started = process.hrtime.bigint();
  const sample = () => {
    if (!childPid || process.platform !== "linux") {
      return;
    }
    const reading = sampleLinuxProcessGroup(childPid);
    samples.push({
      atMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      ...reading,
    });
  };
  try {
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
      onReady(child) {
        childPid = child.pid ?? null;
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
    return {
      exitCode,
      durationMs: Number(process.hrtime.bigint() - started) / 1_000_000,
      samples,
      childPid,
    };
  } finally {
    clearInterval(sampler);
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

function commandEnv(home: string, cacheRoot: string): NodeJS.ProcessEnv {
  mkdirSync(home, { recursive: true });
  mkdirSync(cacheRoot, { recursive: true });
  return {
    CI: "1",
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    NODE_COMPILE_CACHE: path.join(cacheRoot, "node-compile"),
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(cacheRoot, "vitest-fs"),
    OPENCLAW_VITEST_MAX_WORKERS: "1",
    OPENCLAW_TEST_PROJECTS_PARALLEL: "1",
    PATH: process.env.PATH,
    TMPDIR: path.join(cacheRoot, "tmp"),
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
): Promise<BenchmarkRunRecord> {
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
      env: commandEnv(home, cacheRoot),
      logPath,
      samplePath,
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

async function runSetupCommand(context: BenchmarkContext, side: BenchmarkSide): Promise<void> {
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
    env: {
      ...commandEnv(home, cacheRoot),
      PNPM_HOME: path.join(setupRoot, "pnpm-home"),
      npm_config_cache: path.join(setupRoot, "npm-cache"),
    },
    logPath: path.join(setupLogRoot, "install.log"),
    timeoutMs: 20 * 60 * 1000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`${side} frozen install exited with status ${result.exitCode}`);
  }
}

function gitOutput(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
  }
  return result.stdout.trim();
}

function commandVersion(bin: string): string {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`unable to execute ${bin} --version`);
  }
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
  if (process.platform !== "linux") {
    throw new Error("vitest-pair benchmark requires Linux /proc");
  }
  assertExactSha(context.baselineSha, "baseline SHA");
  assertExactSha(context.candidateSha, "candidate SHA");
  const baselineDir = realpathSync(context.baselineDir);
  const candidateDir = realpathSync(context.candidateDir);
  if (gitOutput(baselineDir, ["rev-parse", "HEAD"]) !== context.baselineSha) {
    throw new Error("baseline checkout does not match the requested SHA");
  }
  if (gitOutput(candidateDir, ["rev-parse", "HEAD"]) !== context.candidateSha) {
    throw new Error("candidate checkout does not match the requested SHA");
  }
  if (process.version !== "v24.19.0") {
    throw new Error(`vitest-pair benchmark requires Node v24.19.0, got ${process.version}`);
  }
  const pnpmVersion = commandVersion(context.pnpmBin);
  if (pnpmVersion !== "12.1.0") {
    throw new Error(`vitest-pair benchmark requires pnpm 12.1.0, got ${pnpmVersion}`);
  }
  mkdirSync(context.outputDir, { recursive: true });
  mkdirSync(context.scratchDir, { recursive: true });
  const baselineInventory = assertInventoryAvailable(baselineDir, context.manifest);
  const candidateInventory = assertInventoryAvailable(candidateDir, context.manifest);
  if (baselineInventory.inventorySha256 !== candidateInventory.inventorySha256) {
    throw new Error("baseline and candidate benchmark inventories differ");
  }
  writeJsonAtomic(path.join(context.outputDir, "environment.json"), {
    version: 1,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    pnpm: pnpmVersion,
    cpu: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    baselineSha: context.baselineSha,
    baselineTree: gitOutput(baselineDir, ["rev-parse", "HEAD^{tree}"]),
    candidateSha: context.candidateSha,
    candidateTree: gitOutput(candidateDir, ["rev-parse", "HEAD^{tree}"]),
    inventorySha256: baselineInventory.inventorySha256,
  });
  writeJsonAtomic(path.join(context.outputDir, "inventory-baseline.json"), baselineInventory);
  writeJsonAtomic(path.join(context.outputDir, "inventory-candidate.json"), candidateInventory);
  await runSetupCommand(context, "baseline");
  await runSetupCommand(context, "candidate");

  const correctness: BenchmarkRunRecord[] = [];
  for (const lane of context.manifest.lanes) {
    for (const side of ["baseline", "candidate"] as const) {
      correctness.push(
        await runBenchmarkCommand(context, {
          id: `correctness-${lane.id}-${side}`,
          phase: "correctness",
          side,
          lane,
          round: null,
          pair: null,
          cacheMode: "fresh",
        }),
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
    records.push(await runBenchmarkCommand(context, plan));
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
