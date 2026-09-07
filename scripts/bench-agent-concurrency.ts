import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  emitBenchmarkReport,
  parseBenchmarkInteger,
  parseBenchmarkIntegerList,
  parseBenchmarkOptions,
  parseBenchmarkWorkerResult,
  runBenchmarkEntrypoint,
  runBenchmarkJobs,
  runBenchmarkWorker,
  summarizeBenchmarkTimings,
  type BenchmarkTimingSummary,
  type BenchmarkWorkerProcessResult,
} from "./lib/benchmark-harness.mts";

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

function parseOptions(argv: string[]): Options {
  return parseBenchmarkOptions<Options>(
    argv,
    {
      runs: 5,
      warmup: 1,
      fanout: DEFAULT_FANOUT,
      sweepRows: DEFAULT_SWEEP_ROWS,
      json: false,
      help: false,
    },
    {
      "--runs": (options, value) => {
        options.runs = parseBenchmarkInteger(value, "--runs", 1, 100);
      },
      "--warmup": (options, value) => {
        options.warmup = parseBenchmarkInteger(value, "--warmup", 0, 20);
      },
      "--fanout": (options, value) => {
        options.fanout = parseBenchmarkIntegerList(value, "--fanout", 256);
      },
      "--sweep-rows": (options, value) => {
        options.sweepRows = parseBenchmarkIntegerList(value, "--sweep-rows", 4096);
      },
      "--output": (options, value) => {
        options.output = value;
      },
    },
  );
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
          timingsMs: summarizeBenchmarkTimings(worker.timingsMs),
          memory: worker.memory,
          invariant: worker.invariant,
        };
      }),
    ]),
  ) as Record<
    WorkerScenario,
    Array<{
      size: number;
      timingsMs: BenchmarkTimingSummary;
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
  result: BenchmarkWorkerProcessResult,
  expected: { scenario: WorkerScenario; size: number; runs: number },
): WorkerResult {
  return parseBenchmarkWorkerResult({
    result,
    label: `${expected.scenario}:${expected.size}`,
    sentinel: WORKER_RESULT_SENTINEL,
    timeoutMs: WORKER_TIMEOUT_MS,
    validate: (value) => validateWorkerResult(value, expected),
  });
}

function runWorker(options: Options, scenario: WorkerScenario, size: number): WorkerResult {
  return runBenchmarkWorker({
    args: [
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
    label: `${scenario}:${size}`,
    sentinel: WORKER_RESULT_SENTINEL,
    timeoutMs: WORKER_TIMEOUT_MS,
    validate: (value) => validateWorkerResult(value, { scenario, size, runs: options.runs }),
  });
}

function benchmark(options: Options, runtime: BenchmarkRuntime = {}) {
  const rssStartBytes = process.memoryUsage().rss;
  const jobs = SCENARIO_SPECS.flatMap(({ scenario, sizes }) =>
    options[sizes].map((size) => ({ scenario, size })),
  );
  const run = runtime.runWorker ?? runWorker;
  const workers = runBenchmarkJobs(jobs, {
    prefix: "bench-agent-concurrency",
    describe: ({ scenario, size }) => `scenario=${scenario} size=${size}`,
    run: ({ scenario, size }) => run(options, scenario, size),
    now: runtime.now,
    writeProgress: runtime.writeProgress,
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
  emitBenchmarkReport(report, options, (result) => [
    ...Object.entries(result.scenarios).flatMap(([name, scenarios]) =>
      scenarios.map((scenario) => {
        const tail =
          scenario.timingsMs.p95 === undefined
            ? ""
            : ` p95=${scenario.timingsMs.p95.toFixed(3)}ms p99=${scenario.timingsMs.p99?.toFixed(3)}ms`;
        return `${name} size=${scenario.size} p50=${scenario.timingsMs.p50.toFixed(3)}ms max=${scenario.timingsMs.max.toFixed(3)}ms${tail}`;
      }),
    ),
    `max worker RSS ${(result.memory.workerProcessMaxRssBytes / 1024 / 1024).toFixed(1)} MiB`,
  ]);
}

export const testing = {
  aggregateWorkerResults,
  benchmark,
  parseOptions,
  parseWorkerProcessResult,
  summarizeTimings: summarizeBenchmarkTimings,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await runBenchmarkEntrypoint("bench-agent-concurrency", main);
}
