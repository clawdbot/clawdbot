import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { classifyBoundedUnsignedDecimal } from "./lib/arg-utils.mts";

const DEFAULT_FANOUT = [1, 8, 32, 64];
const DEFAULT_SWEEP_ROWS = [32, 128, 512];
const WORKER_TIMEOUT_MS = 300_000;
export const WORKER_RESULT_SENTINEL = "[bench-agent-concurrency-result] ";

export type WorkerScenario =
  | "spawnPipelineInMemory"
  | "spawnPipelineDurable"
  | "admission"
  | "recoverySweep"
  | "duplicateSuppression";

export type WorkerResult = {
  scenario: WorkerScenario;
  size: number;
  timingsMs: number[];
  memory: {
    rssStartBytes: number;
    rssEndBytes: number;
    processMaxRssBytes: number;
  };
  invariant: Record<string, number | boolean>;
};

type Options = {
  runs: number;
  warmup: number;
  fanout: number[];
  sweepRows: number[];
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

const SCENARIO_SPECS: ReadonlyArray<{
  scenario: WorkerScenario;
  sizes: "fanout" | "sweepRows";
}> = [
  { scenario: "spawnPipelineInMemory", sizes: "fanout" },
  { scenario: "spawnPipelineDurable", sizes: "fanout" },
  { scenario: "admission", sizes: "fanout" },
  { scenario: "recoverySweep", sizes: "sweepRows" },
  { scenario: "duplicateSuppression", sizes: "sweepRows" },
];

const REQUIRED_INVARIANT_FIELDS: Record<WorkerScenario, readonly string[]> = {
  spawnPipelineInMemory: [
    "ok",
    "registeredRuns",
    "reservationsReleased",
    "blockedWaits",
    "settledRuns",
    "settledTasks",
    "outstandingWaits",
    "durableSubagentRows",
    "durableTaskRows",
    "durableStateFile",
    "postTeardownRegistryRows",
    "postTeardownTaskRows",
    "postTeardownDurableSubagentRows",
    "postTeardownDurableTaskRows",
    "postTeardownActiveRootWork",
  ],
  spawnPipelineDurable: [
    "ok",
    "registeredRuns",
    "reservationsReleased",
    "blockedWaits",
    "settledRuns",
    "settledTasks",
    "outstandingWaits",
    "durableSubagentRows",
    "durableTaskRows",
    "durableStateFile",
    "postTeardownRegistryRows",
    "postTeardownTaskRows",
    "postTeardownDurableSubagentRows",
    "postTeardownDurableTaskRows",
    "postTeardownActiveRootWork",
  ],
  admission: ["ok", "admissionCap", "overflowRejected", "released"],
  recoverySweep: [
    "ok",
    "seededRows",
    "removedRows",
    "retainedCurrent",
    "sessionEffects",
    "recoveryProjections",
    "lostContextCompletions",
  ],
  duplicateSuppression: [
    "ok",
    "inputRowsPerOrdering",
    "newestFirstSelectedRows",
    "oldestFirstSelectedRows",
    "newestFirstSelectedNewest",
    "oldestFirstSelectedNewest",
  ],
};

type WorkerProcessResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
};

type BenchmarkRuntime = {
  runWorker?: typeof runWorker;
  writeProgress?: (line: string) => void;
  now?: () => number;
};

function usage(): string {
  return `OpenClaw agent concurrency benchmark

Usage:
  node --import tsx scripts/bench-agent-concurrency.ts [options]

Options:
  --runs <n>          Measured samples per scenario (default: 5)
  --warmup <n>        Warmup samples per scenario (default: 1)
  --fanout <list>     Comma-separated spawn/admission sizes (default: 1,8,32,64)
  --sweep-rows <list> Comma-separated child counts, with 3 generations each (default: 32,128,512)
  --output <path>     Write the JSON report to a file
  --json              Print only the JSON report
  --help              Show this text
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

function parseList(raw: string, flag: string, max: number): number[] {
  if (!raw || raw.split(",").some((value) => value.length === 0)) {
    throw new Error(`${flag} requires a comma-separated integer list`);
  }
  const values = raw.split(",").map((value) => parseInteger(value, flag, 1, max));
  if (new Set(values).size !== values.length) {
    throw new Error(`${flag} contains duplicate values`);
  }
  return values;
}

function parseOptions(argv: string[]): Options {
  const options: Options = {
    runs: 5,
    warmup: 1,
    fanout: DEFAULT_FANOUT,
    sweepRows: DEFAULT_SWEEP_ROWS,
    json: false,
    help: false,
  };
  const seen = new Set<string>();
  const valueFlags = new Set(["--runs", "--warmup", "--fanout", "--sweep-rows", "--output"]);
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
    if (flag === "--runs") {
      options.runs = parseInteger(value, flag, 1, 100);
    } else if (flag === "--warmup") {
      options.warmup = parseInteger(value, flag, 0, 20);
    } else if (flag === "--fanout") {
      options.fanout = parseList(value, flag, 256);
    } else if (flag === "--sweep-rows") {
      options.sweepRows = parseList(value, flag, 4096);
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

function expectedWorkerKeys(options: Options): string[] {
  return SCENARIO_SPECS.flatMap(({ scenario, sizes }) =>
    options[sizes].map((size) => `${scenario}:${size}`),
  );
}

function aggregateWorkerResults(
  options: Options,
  workers: WorkerResult[],
  parentMemory = {
    rssStartBytes: process.memoryUsage().rss,
    rssEndBytes: process.memoryUsage().rss,
  },
) {
  const expected = expectedWorkerKeys(options);
  const byKey = new Map(workers.map((worker) => [`${worker.scenario}:${worker.size}`, worker]));
  if (byKey.size !== workers.length) {
    throw new Error("worker results contain duplicate scenario/size pairs");
  }
  const missing = expected.filter((key) => !byKey.has(key));
  const unexpected = [...byKey.keys()].filter((key) => !expected.includes(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `worker result mismatch: missing=${missing.join(",") || "none"} unexpected=${unexpected.join(",") || "none"}`,
    );
  }

  const scenarios = Object.fromEntries(
    SCENARIO_SPECS.map(({ scenario, sizes }) => [
      scenario,
      options[sizes].map((size) => {
        const worker = byKey.get(`${scenario}:${size}`);
        if (!worker) {
          throw new Error(`missing worker result for ${scenario}:${size}`);
        }
        return {
          size,
          timingsMs: summarizeTimings(worker.timingsMs),
          memory: worker.memory,
          invariant: worker.invariant,
        };
      }),
    ]),
  ) as Record<
    WorkerScenario,
    Array<{
      size: number;
      timingsMs: TimingSummary;
      memory: WorkerResult["memory"];
      invariant: WorkerResult["invariant"];
    }>
  >;

  const checks = {
    spawnPipelineInMemory: scenarios.spawnPipelineInMemory.every(
      (entry) => entry.invariant.ok === true,
    ),
    spawnPipelineDurable: scenarios.spawnPipelineDurable.every(
      (entry) => entry.invariant.ok === true,
    ),
    admissionCapOverflowRelease: scenarios.admission.every((entry) => entry.invariant.ok === true),
    sweepRecoveryRowsWithoutSessionEffects: scenarios.recoverySweep.every(
      (entry) => entry.invariant.ok === true,
    ),
    dedupeNewestPerChild: scenarios.duplicateSuppression.every(
      (entry) => entry.invariant.ok === true,
    ),
  };
  const failures = Object.entries(checks)
    .filter(([, ok]) => !ok)
    .map(([name]) => name);

  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    options: {
      runs: options.runs,
      warmup: options.warmup,
      fanout: options.fanout,
      sweepRows: options.sweepRows,
    },
    memory: {
      ...parentMemory,
      workerProcessMaxRssBytes: Math.max(
        ...workers.map((worker) => worker.memory.processMaxRssBytes),
      ),
    },
    scenarios,
    invariants: { ok: failures.length === 0, failures, ...checks },
  };
}

function assertFiniteNonNegative(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`worker result field ${field} must be a finite nonnegative number`);
  }
}

function validateWorkerResult(
  value: unknown,
  expected: { scenario: WorkerScenario; size: number; runs: number },
): WorkerResult {
  if (!isRecord(value)) {
    throw new Error("worker result must be an object");
  }
  if (value.scenario !== expected.scenario || value.size !== expected.size) {
    throw new Error(`worker ${expected.scenario}:${expected.size} returned mismatched identity`);
  }
  if (!Array.isArray(value.timingsMs) || value.timingsMs.length !== expected.runs) {
    throw new Error(
      `worker ${expected.scenario}:${expected.size} returned ${Array.isArray(value.timingsMs) ? value.timingsMs.length : "invalid"} samples; expected ${expected.runs}`,
    );
  }
  value.timingsMs.forEach((timing, index) =>
    assertFiniteNonNegative(timing, `timingsMs[${index}]`),
  );
  if (!isRecord(value.memory)) {
    throw new Error("worker result memory must be an object");
  }
  assertFiniteNonNegative(value.memory.rssStartBytes, "memory.rssStartBytes");
  assertFiniteNonNegative(value.memory.rssEndBytes, "memory.rssEndBytes");
  assertFiniteNonNegative(value.memory.processMaxRssBytes, "memory.processMaxRssBytes");
  if (!isRecord(value.invariant)) {
    throw new Error("worker result invariant must be an object");
  }
  for (const field of REQUIRED_INVARIANT_FIELDS[expected.scenario]) {
    const invariantValue = value.invariant[field];
    if (typeof invariantValue !== "number" && typeof invariantValue !== "boolean") {
      throw new Error(`worker result invariant.${field} is missing or invalid`);
    }
  }
  if (value.invariant.ok !== true) {
    throw new Error(`worker ${expected.scenario}:${expected.size} reported a failed invariant`);
  }
  return value as WorkerResult;
}

function parseWorkerProcessResult(
  result: WorkerProcessResult,
  expected: { scenario: WorkerScenario; size: number; runs: number },
): WorkerResult {
  if (result.error) {
    const detail =
      "code" in result.error && result.error.code === "ETIMEDOUT"
        ? `timed out after ${WORKER_TIMEOUT_MS}ms`
        : result.error.message;
    throw new Error(`worker ${expected.scenario}:${expected.size} failed: ${detail}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `worker ${expected.scenario}:${expected.size} failed (${result.status ?? "signal"}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  const payloads = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(WORKER_RESULT_SENTINEL));
  if (payloads.length !== 1) {
    throw new Error(
      `worker ${expected.scenario}:${expected.size} returned ${payloads.length} result payloads`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloads[0]!.slice(WORKER_RESULT_SENTINEL.length));
  } catch {
    throw new Error(`worker ${expected.scenario}:${expected.size} returned invalid JSON`);
  }
  return validateWorkerResult(parsed, expected);
}

function runWorker(options: Options, scenario: WorkerScenario, size: number): WorkerResult {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/bench-agent-concurrency-worker.ts",
      "--scenario",
      scenario,
      "--size",
      String(size),
      "--runs",
      String(options.runs),
      "--warmup",
      String(options.warmup),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      timeout: WORKER_TIMEOUT_MS,
      killSignal: "SIGTERM",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return parseWorkerProcessResult(result, { scenario, size, runs: options.runs });
}

function benchmark(options: Options, runtime: BenchmarkRuntime = {}) {
  const rssStartBytes = process.memoryUsage().rss;
  const jobs = SCENARIO_SPECS.flatMap(({ scenario, sizes }) =>
    options[sizes].map((size) => ({ scenario, size })),
  );
  const run = runtime.runWorker ?? runWorker;
  const writeProgress =
    runtime.writeProgress ?? ((line: string) => process.stderr.write(`${line}\n`));
  const now = runtime.now ?? Date.now;
  const workers = jobs.map(({ scenario, size }, index) => {
    const ordinal = index + 1;
    writeProgress(
      `[bench-agent-concurrency] worker ${ordinal}/${jobs.length} start scenario=${scenario} size=${size}`,
    );
    const startedAt = now();
    try {
      const worker = run(options, scenario, size);
      const elapsedMs = Math.max(0, now() - startedAt);
      writeProgress(
        `[bench-agent-concurrency] worker ${ordinal}/${jobs.length} complete scenario=${scenario} size=${size} elapsed=${(elapsedMs / 1_000).toFixed(3)}s`,
      );
      return worker;
    } catch (error) {
      const elapsedMs = Math.max(0, now() - startedAt);
      writeProgress(
        `[bench-agent-concurrency] worker ${ordinal}/${jobs.length} failed scenario=${scenario} size=${size} elapsed=${(elapsedMs / 1_000).toFixed(3)}s`,
      );
      throw error;
    }
  });
  return aggregateWorkerResults(options, workers, {
    rssStartBytes,
    rssEndBytes: process.memoryUsage().rss,
  });
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
  for (const [name, scenarios] of Object.entries(report.scenarios)) {
    for (const scenario of scenarios) {
      const tail =
        scenario.timingsMs.p95 === undefined
          ? ""
          : ` p95=${scenario.timingsMs.p95.toFixed(3)}ms p99=${scenario.timingsMs.p99?.toFixed(3)}ms`;
      console.log(
        `${name} size=${scenario.size} p50=${scenario.timingsMs.p50.toFixed(3)}ms max=${scenario.timingsMs.max.toFixed(3)}ms${tail}`,
      );
    }
  }
  console.log(
    `max worker RSS ${(report.memory.workerProcessMaxRssBytes / 1024 / 1024).toFixed(1)} MiB`,
  );
}

export const testing = {
  aggregateWorkerResults,
  benchmark,
  parseOptions,
  parseWorkerProcessResult,
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
      console.error(`[bench-agent-concurrency] FAILED (exit ${process.exitCode})`);
    }
  }
}
