import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { classifyBoundedUnsignedDecimal } from "./lib/arg-utils.mts";

const DEFAULT_SIZES = [24, 64, 128];
const WORKER_TIMEOUT_MS = 300_000;
export const WORKER_RESULT_SENTINEL = "[bench-task-registry-sqlite-result] ";

export type MemorySample = {
  cycle: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  rssBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  processPeakRssBytes: number;
};

export type RetainedMemoryMetrics = Pick<
  MemorySample,
  "heapUsedBytes" | "heapTotalBytes" | "rssBytes" | "externalBytes" | "arrayBuffersBytes"
>;

export type RegistryLifecycleCounts = {
  taskCount: number;
  deliveryStateCount: number;
  runningTasks: number;
  succeededTasks: number;
  pendingDeliveryTasks: number;
  succeededTerminalOutcomes: number;
};

export type RegistrySnapshot = {
  memory: RegistryLifecycleCounts;
  sqlite: RegistryLifecycleCounts;
};

export type WorkerResult = {
  size: number;
  timingsMs: {
    registration: number[];
    terminal: number[];
    teardown: number[];
  };
  memory: {
    postGcBaseline: MemorySample;
    postGcSamples: MemorySample[];
    retainedSlopesBytesPerCycle: RetainedMemoryMetrics;
    retainedDeltasBytes: RetainedMemoryMetrics;
    processPeakRssBytes: number;
  };
  invariant: {
    ok: boolean;
    cyclesValidated: number;
    registration: RegistrySnapshot;
    terminal: RegistrySnapshot;
    teardown: RegistrySnapshot;
    serializedSharedConnection: boolean;
  };
};

type Options = {
  sizes: number[];
  cycles: number;
  warmup: number;
  output?: string;
  json: boolean;
  help: boolean;
};

type TimingSummary = {
  count: number;
  min: number;
  p50: number;
  max: number;
  p95?: number;
  p99?: number;
};

type WorkerProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
};

type WorkerSpawner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    encoding: "utf8";
    env: NodeJS.ProcessEnv;
    timeout: number;
    killSignal: NodeJS.Signals;
    maxBuffer: number;
  },
) => WorkerProcessResult;

type WorkerLaunchRuntime = {
  spawnWorker?: WorkerSpawner;
};

type BenchmarkRuntime = {
  runWorker?: typeof runWorker;
  writeProgress?: (line: string) => void;
  now?: () => number;
};

function usage(): string {
  return `OpenClaw durable task registry churn benchmark

Usage:
  node --import tsx scripts/bench-task-registry-sqlite.ts [options]

Options:
  --sizes <list>  Comma-separated subagent task-record registration burst sizes (default: 24,64,128)
  --cycles <n>    Measured create/terminal/delete cycles per size (default: 20)
  --warmup <n>    Warmup cycles per size (default: 3)
  --output <path> Write the JSON report to a file
  --json          Print only the JSON report
  --help          Show this text
`;
}

function parseInteger(raw: string, flag: string, min: number, max: number): number {
  const result = classifyBoundedUnsignedDecimal(raw, min, max);
  if (result.kind === "syntax") {
    throw new Error(`${flag} must be an integer`);
  }
  if (result.kind === "below") {
    throw new Error(`${flag} must be at least ${min}`);
  }
  if (result.kind === "above") {
    throw new Error(`${flag} must be at most ${max}`);
  }
  return result.value;
}

function parseList(raw: string, flag: string): number[] {
  if (!raw || raw.split(",").some((value) => value.length === 0)) {
    throw new Error(`${flag} requires a comma-separated integer list`);
  }
  const values = raw.split(",").map((value) => parseInteger(value, flag, 1, 4096));
  if (new Set(values).size !== values.length) {
    throw new Error(`${flag} contains duplicate values`);
  }
  return values;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    sizes: DEFAULT_SIZES,
    cycles: 20,
    warmup: 3,
    json: false,
    help: false,
  };
  const seen = new Set<string>();
  const valueFlags = new Set(["--sizes", "--cycles", "--warmup", "--output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
    if (flag === "--json" || flag === "--help") {
      options[flag === "--json" ? "json" : "help"] = true;
      continue;
    }
    if (!valueFlags.has(flag)) {
      throw new Error(`Unknown argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    index += 1;
    if (flag === "--sizes") {
      options.sizes = parseList(value, flag);
    } else if (flag === "--cycles") {
      options.cycles = parseInteger(value, flag, 1, 200);
    } else if (flag === "--warmup") {
      options.warmup = parseInteger(value, flag, 0, 20);
    } else {
      options.output = value;
    }
  }
  return options;
}

function percentile(sorted: number[], ratio: number): number {
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)] ?? 0;
}

function summarizeTimings(values: number[]): TimingSummary {
  if (values.length === 0) {
    throw new Error("cannot summarize an empty timing set");
  }
  const sorted = values.toSorted((left, right) => left - right);
  const summary: TimingSummary = {
    count: sorted.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 0.5),
    max: sorted.at(-1) ?? 0,
  };
  if (sorted.length >= 20) {
    summary.p95 = percentile(sorted, 0.95);
    summary.p99 = percentile(sorted, 0.99);
  }
  return summary;
}

function assertFinite(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`worker result field ${field} must be finite`);
  }
}

function assertFiniteNonNegative(value: unknown, field: string): asserts value is number {
  assertFinite(value, field);
  if (value < 0) {
    throw new Error(`worker result field ${field} must be nonnegative`);
  }
}

const MEMORY_FIELDS = [
  "heapUsedBytes",
  "heapTotalBytes",
  "rssBytes",
  "externalBytes",
  "arrayBuffersBytes",
  "processPeakRssBytes",
] as const;

const RETAINED_MEMORY_FIELDS = [
  "heapUsedBytes",
  "heapTotalBytes",
  "rssBytes",
  "externalBytes",
  "arrayBuffersBytes",
] as const;

const LIFECYCLE_COUNT_FIELDS = [
  "taskCount",
  "deliveryStateCount",
  "runningTasks",
  "succeededTasks",
  "pendingDeliveryTasks",
  "succeededTerminalOutcomes",
] as const;

function validateMemorySample(
  value: unknown,
  expectedCycle: number,
  field: string,
): asserts value is MemorySample {
  if (!isRecord(value) || value.cycle !== expectedCycle) {
    throw new Error(`worker result ${field} has an invalid cycle`);
  }
  for (const memoryField of MEMORY_FIELDS) {
    assertFiniteNonNegative(value[memoryField], `${field}.${memoryField}`);
  }
}

function validateRegistrySnapshot(
  value: unknown,
  field: string,
  expected: RegistryLifecycleCounts,
): asserts value is RegistrySnapshot {
  if (!isRecord(value) || !isRecord(value.memory) || !isRecord(value.sqlite)) {
    throw new Error(`worker result field ${field} must be a registry snapshot`);
  }
  for (const surface of ["memory", "sqlite"] as const) {
    const counts = surface === "memory" ? value.memory : value.sqlite;
    for (const countField of LIFECYCLE_COUNT_FIELDS) {
      const count = counts[countField];
      assertFiniteNonNegative(count, `${field}.${surface}.${countField}`);
      if (count !== expected[countField]) {
        throw new Error(`worker result field ${field}.${surface}.${countField} was unexpected`);
      }
    }
  }
}

function validateWorkerResult(
  value: unknown,
  expected: { size: number; cycles: number; warmup: number },
): WorkerResult {
  if (!isRecord(value)) {
    throw new Error("worker result must be an object");
  }
  if (value.size !== expected.size) {
    throw new Error(`worker size ${expected.size} returned mismatched identity`);
  }
  if (!isRecord(value.timingsMs)) {
    throw new Error("worker result timingsMs must be an object");
  }
  for (const phase of ["registration", "terminal", "teardown"] as const) {
    const timings = value.timingsMs[phase];
    if (!Array.isArray(timings) || timings.length !== expected.cycles) {
      throw new Error(
        `worker size ${expected.size} returned ${Array.isArray(timings) ? timings.length : "invalid"} ${phase} samples; expected ${expected.cycles}`,
      );
    }
    timings.forEach((timing, index) =>
      assertFiniteNonNegative(timing, `timingsMs.${phase}[${index}]`),
    );
  }
  if (!isRecord(value.memory)) {
    throw new Error("worker result memory must be an object");
  }
  const postGcBaseline = value.memory.postGcBaseline;
  validateMemorySample(postGcBaseline, -1, "memory.postGcBaseline");
  if (
    !Array.isArray(value.memory.postGcSamples) ||
    value.memory.postGcSamples.length !== expected.cycles
  ) {
    throw new Error(
      `worker size ${expected.size} returned invalid post-GC sample count; expected ${expected.cycles}`,
    );
  }
  value.memory.postGcSamples.forEach((sample, index) =>
    validateMemorySample(sample, index, `memory.postGcSamples[${index}]`),
  );
  const postGcSamples = value.memory.postGcSamples as MemorySample[];
  if (!isRecord(value.memory.retainedSlopesBytesPerCycle)) {
    throw new Error("worker result retained memory slopes must be an object");
  }
  if (!isRecord(value.memory.retainedDeltasBytes)) {
    throw new Error("worker result retained memory deltas must be an object");
  }
  const finalPostGcSample = postGcSamples.at(-1);
  if (!finalPostGcSample) {
    throw new Error("worker result must include a final post-GC sample");
  }
  for (const field of RETAINED_MEMORY_FIELDS) {
    assertFinite(
      value.memory.retainedSlopesBytesPerCycle[field],
      `memory.retainedSlopesBytesPerCycle.${field}`,
    );
    assertFinite(value.memory.retainedDeltasBytes[field], `memory.retainedDeltasBytes.${field}`);
    const expectedDelta = finalPostGcSample[field] - postGcBaseline[field];
    if (value.memory.retainedDeltasBytes[field] !== expectedDelta) {
      throw new Error(
        `worker result memory.retainedDeltasBytes.${field} must be end minus baseline`,
      );
    }
  }
  if ("processPeakRssBytes" in value.memory.retainedSlopesBytesPerCycle) {
    throw new Error("worker result retained memory slopes must exclude process peak RSS");
  }
  if ("processPeakRssBytes" in value.memory.retainedDeltasBytes) {
    throw new Error("worker result retained memory deltas must exclude process peak RSS");
  }
  assertFiniteNonNegative(value.memory.processPeakRssBytes, "memory.processPeakRssBytes");
  if (!isRecord(value.invariant)) {
    throw new Error("worker result invariant must be an object");
  }
  assertFiniteNonNegative(value.invariant.cyclesValidated, "invariant.cyclesValidated");
  const emptyCounts: RegistryLifecycleCounts = {
    taskCount: 0,
    deliveryStateCount: 0,
    runningTasks: 0,
    succeededTasks: 0,
    pendingDeliveryTasks: 0,
    succeededTerminalOutcomes: 0,
  };
  validateRegistrySnapshot(value.invariant.registration, "invariant.registration", {
    ...emptyCounts,
    taskCount: expected.size,
    deliveryStateCount: expected.size,
    runningTasks: expected.size,
    pendingDeliveryTasks: expected.size,
  });
  validateRegistrySnapshot(value.invariant.terminal, "invariant.terminal", {
    ...emptyCounts,
    taskCount: expected.size,
    deliveryStateCount: expected.size,
    succeededTasks: expected.size,
    pendingDeliveryTasks: expected.size,
    succeededTerminalOutcomes: expected.size,
  });
  validateRegistrySnapshot(value.invariant.teardown, "invariant.teardown", emptyCounts);
  if (
    value.invariant.ok !== true ||
    value.invariant.serializedSharedConnection !== true ||
    value.invariant.cyclesValidated !== expected.cycles + expected.warmup
  ) {
    throw new Error(`worker size ${expected.size} reported a failed invariant`);
  }
  return value as WorkerResult;
}

function parseWorkerProcessResult(
  result: WorkerProcessResult,
  expected: { size: number; cycles: number; warmup: number },
): WorkerResult {
  if (result.error) {
    const detail =
      result.error.code === "ETIMEDOUT"
        ? `timed out after ${WORKER_TIMEOUT_MS}ms`
        : result.error.message;
    throw new Error(`worker size ${expected.size} failed: ${detail}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `worker size ${expected.size} failed (${result.status ?? "signal"}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const payloads = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(WORKER_RESULT_SENTINEL));
  if (payloads.length !== 1) {
    throw new Error(`worker size ${expected.size} returned ${payloads.length} result payloads`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloads[0]!.slice(WORKER_RESULT_SENTINEL.length));
  } catch {
    throw new Error(`worker size ${expected.size} returned invalid JSON`);
  }
  return validateWorkerResult(parsed, expected);
}

function buildWorkerArgs(options: Options, size: number, stateDir: string): string[] {
  return [
    "--expose-gc",
    "--import",
    "tsx",
    "scripts/bench-task-registry-sqlite-worker.ts",
    "--size",
    String(size),
    "--cycles",
    String(options.cycles),
    "--warmup",
    String(options.warmup),
    "--state-dir",
    stateDir,
  ];
}

function runWorker(
  options: Options,
  size: number,
  runtime: WorkerLaunchRuntime = {},
): WorkerResult {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-task-registry-bench-"));
  const spawnWorker =
    runtime.spawnWorker ??
    ((command, args, spawnOptions) => spawnSync(command, args, spawnOptions));
  try {
    const result = spawnWorker(process.execPath, buildWorkerArgs(options, size, stateDir), {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      timeout: WORKER_TIMEOUT_MS,
      killSignal: "SIGTERM",
      maxBuffer: 16 * 1024 * 1024,
    });
    return parseWorkerProcessResult(result, {
      size,
      cycles: options.cycles,
      warmup: options.warmup,
    });
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
}

function aggregateWorkerResults(options: Options, workers: WorkerResult[]) {
  const bySize = new Map(workers.map((worker) => [worker.size, worker]));
  if (bySize.size !== workers.length) {
    throw new Error("worker results contain duplicate sizes");
  }
  const missing = options.sizes.filter((size) => !bySize.has(size));
  const unexpected = [...bySize.keys()].filter((size) => !options.sizes.includes(size));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `worker result mismatch: missing=${missing.join(",") || "none"} unexpected=${unexpected.join(",") || "none"}`,
    );
  }
  const sizes = options.sizes.map((size) => {
    const worker = bySize.get(size);
    if (!worker) {
      throw new Error(`missing worker result for size ${size}`);
    }
    return {
      size,
      timingsMs: {
        registration: summarizeTimings(worker.timingsMs.registration),
        terminal: summarizeTimings(worker.timingsMs.terminal),
        teardown: summarizeTimings(worker.timingsMs.teardown),
      },
      memory: worker.memory,
      invariant: worker.invariant,
    };
  });
  const failures = sizes
    .filter((entry) => !entry.invariant.ok)
    .map((entry) => `size:${entry.size}`);
  return {
    schemaVersion: 1,
    benchmark: "durable-task-registry-churn",
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    model: {
      unit: "subagent task-record registrations",
      execution:
        "serialized create, terminal, and delete calls through one process-local shared SQLite connection",
      isolation: "fresh --expose-gc worker process per size",
      workload:
        "all task records start running with pending delivery, transition to succeeded with a succeeded terminal outcome, then delete",
    },
    interpretation: {
      timings: "advisory only; this is not a concurrent SQLite writer benchmark",
      memory:
        "post-GC baseline, end-minus-baseline retained deltas, and retained slopes are diagnostic only; they neither claim nor rule out a memory leak",
    },
    options: {
      sizes: options.sizes,
      cycles: options.cycles,
      warmup: options.warmup,
    },
    memory: {
      workerProcessPeakRssBytes: Math.max(
        ...workers.map((worker) => worker.memory.processPeakRssBytes),
      ),
    },
    sizes,
    invariants: {
      ok: failures.length === 0,
      failures,
      exactRegistrationTerminalAndTeardownState: failures.length === 0,
      zeroRowsAfterEveryTeardown: failures.length === 0,
    },
  };
}

function benchmark(options: Options, runtime: BenchmarkRuntime = {}) {
  const run = runtime.runWorker ?? runWorker;
  const writeProgress =
    runtime.writeProgress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = runtime.now ?? Date.now;
  const workers = options.sizes.map((size, index) => {
    const ordinal = index + 1;
    writeProgress(
      `[bench-task-registry-sqlite] worker ${ordinal}/${options.sizes.length} start size=${size}`,
    );
    const startedAt = now();
    try {
      const worker = run(options, size);
      writeProgress(
        `[bench-task-registry-sqlite] worker ${ordinal}/${options.sizes.length} complete size=${size} elapsed=${(Math.max(0, now() - startedAt) / 1_000).toFixed(3)}s`,
      );
      return worker;
    } catch (error) {
      writeProgress(
        `[bench-task-registry-sqlite] worker ${ordinal}/${options.sizes.length} failed size=${size} elapsed=${(Math.max(0, now() - startedAt) / 1_000).toFixed(3)}s`,
      );
      throw error;
    }
  });
  return aggregateWorkerResults(options, workers);
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const report = benchmark(options);
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    fs.writeFileSync(options.output, json);
  }
  if (options.json) {
    process.stdout.write(json);
    return;
  }
  for (const entry of report.sizes) {
    const registration = entry.timingsMs.registration;
    const heapSlope = entry.memory.retainedSlopesBytesPerCycle.heapUsedBytes;
    console.log(
      `size=${entry.size} registration-p50=${registration.p50.toFixed(3)}ms registration-max=${registration.max.toFixed(3)}ms post-gc-heap-slope=${heapSlope.toFixed(1)}B/cycle`,
    );
  }
  console.log(report.interpretation.timings);
  console.log(report.interpretation.memory);
}

export const testing = {
  aggregateWorkerResults,
  benchmark,
  buildWorkerArgs,
  parseOptions,
  parseWorkerProcessResult,
  runWorker,
  summarizeTimings,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (process.exitCode && process.exitCode !== 0) {
      console.error(`[bench-task-registry-sqlite] FAILED (exit ${process.exitCode})`);
    }
  }
}
