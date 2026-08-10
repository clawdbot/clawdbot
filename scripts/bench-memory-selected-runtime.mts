// Measures warm selected-memory-runtime resolution without constructing a memory manager.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { booleanFlag, intFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mts";
import { budgetFloatFlag } from "./lib/budget-number-args.mts";

const BENCHMARK_FIXTURE = "memory-core-selected-runtime";
const BENCHMARK_MODE = "selected-memory-runtime";
// v2 added the comparable-run provenance required for baseline enforcement.
const BENCHMARK_VERSION = 2;
const DEFAULT_BATCH_SIZE = 100_000;
const DEFAULT_RUNS = 20;
const DEFAULT_WARMUP = 3;
const DEFAULT_MAX_P95_REGRESSION_PCT = 15;
const MAX_BATCH_SIZE = 10_000_000;
const MAX_RUNS = 100;
const MAX_WARMUP = 100;
const MIN_P95_SAMPLES = 20;

type BenchmarkOptions = {
  baseline?: string;
  batchSize: number;
  json: boolean;
  maxP95RegressionPct: number;
  output?: string;
  repo: string;
  runs: number;
  warmup: number;
};

type LatencySummary = {
  count: number;
  maxNsPerLookup: number;
  minNsPerLookup: number;
  p50NsPerLookup: number;
  p95NsPerLookup: number;
};

type BaselineComparison = {
  allowedP95NsPerLookup: number;
  baselineCommit: string;
  baselineP95NsPerLookup: number;
  candidateCommit: string;
  candidateP95NsPerLookup: number;
  maxP95RegressionPct: number;
  passed: boolean;
};

type RuntimeIdentity = {
  arch: string;
  node: string;
  platform: string;
};

type SourceIdentity = {
  commit: string;
};

type BenchmarkReport = {
  baselineComparison?: BaselineComparison;
  batchSize: number;
  fixture: typeof BENCHMARK_FIXTURE;
  firstLookupNs: number;
  generatedAt: string;
  lookup: "getMemoryRuntime" | "getSelectedMemoryRuntime";
  mode: typeof BENCHMARK_MODE;
  repo: string;
  runs: number;
  runtime: RuntimeIdentity;
  source: SourceIdentity;
  summary: LatencySummary;
  version: typeof BENCHMARK_VERSION;
  warmLookupNsPerLookup: number[];
  warmup: number;
};

type BaselineReport = {
  batchSize: number;
  fixture: string;
  mode: string;
  runs: number;
  runtime: RuntimeIdentity;
  source: SourceIdentity;
  summary: LatencySummary;
  version: number;
  warmLookupNsPerLookup: number[];
  warmup: number;
};

type BenchmarkRegistry = {
  memoryCapabilities: Array<{
    capability: { authorization?: unknown; runtime: unknown };
    pluginId: string;
  }>;
  plugins: Array<{ id: string; memorySlotSelected?: boolean }>;
};

type RuntimeBindings = {
  createEmptyPluginRegistry: () => BenchmarkRegistry;
  getRuntime: () => unknown;
  lookup: BenchmarkReport["lookup"];
  legacyAuthorizationCapabilities?: unknown;
  setActivePluginRegistry: (registry: BenchmarkRegistry) => void;
};

function parseArgs(
  argv: readonly string[],
  cwd = process.cwd(),
): BenchmarkOptions | { help: true } {
  const parsed = parseFlagArgs(
    [...argv],
    {
      baseline: undefined as string | undefined,
      batchSize: DEFAULT_BATCH_SIZE,
      help: false,
      json: false,
      maxP95RegressionPct: DEFAULT_MAX_P95_REGRESSION_PCT,
      output: undefined as string | undefined,
      repo: path.resolve(cwd),
      runs: DEFAULT_RUNS,
      warmup: DEFAULT_WARMUP,
    },
    [
      stringFlag("--baseline", "baseline", {
        rejectShortOptions: true,
        transform: (value: string) => path.resolve(cwd, value),
      }),
      intFlag("--batch-size", "batchSize", { min: 1 }),
      booleanFlag("--help", "help"),
      booleanFlag("-h", "help"),
      booleanFlag("--json", "json"),
      budgetFloatFlag("--max-p95-regression-pct", "maxP95RegressionPct"),
      stringFlag("--output", "output", {
        rejectShortOptions: true,
        transform: (value: string) => path.resolve(cwd, value),
      }),
      stringFlag("--repo", "repo", {
        rejectShortOptions: true,
        transform: (value: string) => path.resolve(cwd, value),
      }),
      intFlag("--runs", "runs", { min: MIN_P95_SAMPLES }),
      intFlag("--warmup", "warmup", { min: 0 }),
    ],
    {
      onUnhandledArg: (arg: string) => {
        throw new Error(`Unknown argument: ${arg}`);
      },
    },
  );
  if (parsed.help) {
    return { help: true };
  }
  if (parsed.batchSize > MAX_BATCH_SIZE) {
    throw new Error(`--batch-size must be at most ${String(MAX_BATCH_SIZE)}`);
  }
  if (parsed.runs > MAX_RUNS) {
    throw new Error(`--runs must be at most ${String(MAX_RUNS)}`);
  }
  if (parsed.warmup > MAX_WARMUP) {
    throw new Error(`--warmup must be at most ${String(MAX_WARMUP)}`);
  }
  return {
    baseline: parsed.baseline,
    batchSize: parsed.batchSize,
    json: parsed.json,
    maxP95RegressionPct: parsed.maxP95RegressionPct,
    output: parsed.output,
    repo: parsed.repo,
    runs: parsed.runs,
    warmup: parsed.warmup,
  };
}

function percentile(values: readonly number[], percentileValue: number): number {
  const index = Math.max(
    0,
    Math.min(values.length - 1, Math.ceil((percentileValue / 100) * values.length) - 1),
  );
  return values[index] ?? 0;
}

function summarizeLatency(samples: readonly number[]): LatencySummary {
  const sorted = samples.filter(Number.isFinite).toSorted((left, right) => left - right);
  if (sorted.length < MIN_P95_SAMPLES) {
    throw new Error(
      `p95 requires at least ${String(MIN_P95_SAMPLES)} warm lookup samples; received ${String(sorted.length)}`,
    );
  }
  return {
    count: sorted.length,
    maxNsPerLookup: sorted.at(-1) ?? 0,
    minNsPerLookup: sorted[0] ?? 0,
    p50NsPerLookup: percentile(sorted, 50),
    p95NsPerLookup: percentile(sorted, 95),
  };
}

function readBaselineText(value: unknown, reportPath: string, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`baseline report ${reportPath} must contain ${field}`);
  }
  return value;
}

function readBaselineInteger(
  value: unknown,
  reportPath: string,
  field: string,
  minimum: number,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`baseline report ${reportPath} must contain ${field} >= ${String(minimum)}`);
  }
  return value;
}

function readBaselineNumber(value: unknown, reportPath: string, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`baseline report ${reportPath} must contain ${field}`);
  }
  return value;
}

function readBaselineCommit(value: unknown, reportPath: string): string {
  const commit = readBaselineText(value, reportPath, "source.commit");
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`baseline report ${reportPath} source.commit must be a full lowercase SHA`);
  }
  return commit;
}

function readBaselineSamples(value: unknown, reportPath: string, runs: number): number[] {
  if (!Array.isArray(value)) {
    throw new Error(`baseline report ${reportPath} must contain warmLookupNsPerLookup`);
  }
  if (value.length !== runs) {
    throw new Error(`baseline report ${reportPath} warmLookupNsPerLookup length must equal runs`);
  }
  if (
    value.some((sample) => typeof sample !== "number" || !Number.isFinite(sample) || sample < 0)
  ) {
    throw new Error(`baseline report ${reportPath} warmLookupNsPerLookup must contain numbers`);
  }
  return value;
}

function assertBaselineCompatibility(baseline: BaselineReport, candidate: BenchmarkReport): void {
  // Source commits label the comparison pair rather than joining it: this budget evaluates a
  // newer candidate commit against the explicitly supplied baseline commit.
  const mismatches = [
    ["version", baseline.version, candidate.version],
    ["mode", baseline.mode, candidate.mode],
    ["fixture", baseline.fixture, candidate.fixture],
    ["batchSize", baseline.batchSize, candidate.batchSize],
    ["runs", baseline.runs, candidate.runs],
    ["warmup", baseline.warmup, candidate.warmup],
    ["runtime.node", baseline.runtime.node, candidate.runtime.node],
    ["runtime.platform", baseline.runtime.platform, candidate.runtime.platform],
    ["runtime.arch", baseline.runtime.arch, candidate.runtime.arch],
  ].filter(([, baselineValue, candidateValue]) => baselineValue !== candidateValue);
  if (mismatches.length === 0) {
    return;
  }
  throw new Error(
    `baseline report is not comparable: ${mismatches
      .map(
        ([field, baselineValue, candidateValue]) =>
          `${field} baseline=${String(baselineValue)} candidate=${String(candidateValue)}`,
      )
      .join(", ")}`,
  );
}

function resolveSourceCommit(repo: string): string {
  let commit: string;
  let worktreeStatus: string;
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    worktreeStatus = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to resolve source commit for ${repo}: ${message}`, { cause: error });
  }
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error(`expected a full lowercase source commit for ${repo}`);
  }
  // A HEAD SHA cannot identify uncommitted input. Include untracked files so every report
  // names the exact measured tree rather than a potentially stale committed ancestor.
  if (worktreeStatus) {
    throw new Error(`source worktree for ${repo} must be clean to report its commit`);
  }
  return commit;
}

function readBaselineReport(reportPath: string): BaselineReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to read baseline report ${reportPath}: ${message}`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw new Error(`baseline report ${reportPath} must be an object`);
  }
  const version = readBaselineInteger(parsed.version, reportPath, "version", 0);
  const batchSize = readBaselineInteger(parsed.batchSize, reportPath, "batchSize", 1);
  const runs = readBaselineInteger(parsed.runs, reportPath, "runs", MIN_P95_SAMPLES);
  const warmup = readBaselineInteger(parsed.warmup, reportPath, "warmup", 0);
  const fixture = readBaselineText(parsed.fixture, reportPath, "fixture");
  const mode = readBaselineText(parsed.mode, reportPath, "mode");
  const samples = readBaselineSamples(parsed.warmLookupNsPerLookup, reportPath, runs);
  if (!isRecord(parsed.summary)) {
    throw new Error(`baseline report ${reportPath} must contain summary`);
  }
  const summary: LatencySummary = {
    count: readBaselineInteger(parsed.summary.count, reportPath, "summary.count", 0),
    maxNsPerLookup: readBaselineNumber(
      parsed.summary.maxNsPerLookup,
      reportPath,
      "summary.maxNsPerLookup",
    ),
    minNsPerLookup: readBaselineNumber(
      parsed.summary.minNsPerLookup,
      reportPath,
      "summary.minNsPerLookup",
    ),
    p50NsPerLookup: readBaselineNumber(
      parsed.summary.p50NsPerLookup,
      reportPath,
      "summary.p50NsPerLookup",
    ),
    p95NsPerLookup: readBaselineNumber(
      parsed.summary.p95NsPerLookup,
      reportPath,
      "summary.p95NsPerLookup",
    ),
  };
  const computedSummary = summarizeLatency(samples);
  if (
    summary.count !== computedSummary.count ||
    summary.maxNsPerLookup !== computedSummary.maxNsPerLookup ||
    summary.minNsPerLookup !== computedSummary.minNsPerLookup ||
    summary.p50NsPerLookup !== computedSummary.p50NsPerLookup ||
    summary.p95NsPerLookup !== computedSummary.p95NsPerLookup
  ) {
    throw new Error(`baseline report ${reportPath} summary must match warmLookupNsPerLookup`);
  }
  if (!isRecord(parsed.runtime)) {
    throw new Error(`baseline report ${reportPath} must contain runtime`);
  }
  if (!isRecord(parsed.source)) {
    throw new Error(`baseline report ${reportPath} must contain source`);
  }
  return {
    batchSize,
    fixture,
    mode,
    runs,
    runtime: {
      arch: readBaselineText(parsed.runtime.arch, reportPath, "runtime.arch"),
      node: readBaselineText(parsed.runtime.node, reportPath, "runtime.node"),
      platform: readBaselineText(parsed.runtime.platform, reportPath, "runtime.platform"),
    },
    source: {
      commit: readBaselineCommit(parsed.source.commit, reportPath),
    },
    summary,
    version,
    warmLookupNsPerLookup: samples,
    warmup,
  };
}

function compareP95AgainstBaseline(params: {
  baseline: BaselineReport;
  candidate: BenchmarkReport;
  maxP95RegressionPct: number;
}): BaselineComparison {
  assertBaselineCompatibility(params.baseline, params.candidate);
  const allowedP95NsPerLookup =
    params.baseline.summary.p95NsPerLookup * (1 + params.maxP95RegressionPct / 100);
  return {
    allowedP95NsPerLookup,
    baselineCommit: params.baseline.source.commit,
    baselineP95NsPerLookup: params.baseline.summary.p95NsPerLookup,
    candidateCommit: params.candidate.source.commit,
    candidateP95NsPerLookup: params.candidate.summary.p95NsPerLookup,
    maxP95RegressionPct: params.maxP95RegressionPct,
    passed: params.candidate.summary.p95NsPerLookup <= allowedP95NsPerLookup,
  };
}

function assertP95RegressionWithinBudget(comparison: BaselineComparison): void {
  if (comparison.passed) {
    return;
  }
  throw new Error(
    `warm selected-memory-runtime p95 ${comparison.candidateP95NsPerLookup.toFixed(3)}ns/lookup ` +
      `exceeded ${comparison.allowedP95NsPerLookup.toFixed(3)}ns/lookup ` +
      `(baseline ${comparison.baselineP95NsPerLookup.toFixed(3)}ns/lookup, ` +
      `+${comparison.maxP95RegressionPct}% allowed)`,
  );
}

async function importFromRepo<T>(repo: string, relativePath: string): Promise<T> {
  return (await import(pathToFileURL(path.join(repo, relativePath)).href)) as T;
}

function findLegacyAuthorizationModule(repo: string): string | undefined {
  const authorizationModulePath = path.join(repo, "src/memory-host-sdk/host/authorization.ts");
  return existsSync(authorizationModulePath) ? authorizationModulePath : undefined;
}

async function loadRuntimeBindings(repo: string): Promise<RuntimeBindings> {
  const authorizationModulePath = findLegacyAuthorizationModule(repo);
  const [registryModule, runtimeModule, authorizationModule, memoryStateModule] = await Promise.all(
    [
      importFromRepo<{ createEmptyPluginRegistry?: unknown }>(
        repo,
        "src/plugins/registry-empty.ts",
      ),
      importFromRepo<{ getSelectedMemoryRuntime?: unknown }>(repo, "src/plugins/memory-runtime.ts"),
      authorizationModulePath
        ? importFromRepo<{ LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES?: unknown }>(
            repo,
            "src/memory-host-sdk/host/authorization.ts",
          )
        : Promise.resolve(undefined),
      importFromRepo<{ getMemoryRuntime?: unknown }>(repo, "src/plugins/memory-state.ts"),
    ],
  );
  const runtimeStateModule = await importFromRepo<{ setActivePluginRegistry?: unknown }>(
    repo,
    "src/plugins/runtime.ts",
  );

  if (typeof registryModule.createEmptyPluginRegistry !== "function") {
    throw new Error(`expected createEmptyPluginRegistry() in ${repo}`);
  }
  if (typeof runtimeStateModule.setActivePluginRegistry !== "function") {
    throw new Error(`expected setActivePluginRegistry() in ${repo}`);
  }
  if (
    authorizationModulePath &&
    authorizationModule?.LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES === undefined
  ) {
    throw new Error(`expected LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES in ${repo}`);
  }
  if (typeof runtimeModule.getSelectedMemoryRuntime === "function") {
    return {
      createEmptyPluginRegistry:
        registryModule.createEmptyPluginRegistry as RuntimeBindings["createEmptyPluginRegistry"],
      getRuntime: runtimeModule.getSelectedMemoryRuntime as RuntimeBindings["getRuntime"],
      legacyAuthorizationCapabilities:
        authorizationModule?.LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
      lookup: "getSelectedMemoryRuntime",
      setActivePluginRegistry:
        runtimeStateModule.setActivePluginRegistry as RuntimeBindings["setActivePluginRegistry"],
    };
  }
  if (typeof memoryStateModule.getMemoryRuntime === "function") {
    return {
      createEmptyPluginRegistry:
        registryModule.createEmptyPluginRegistry as RuntimeBindings["createEmptyPluginRegistry"],
      getRuntime: memoryStateModule.getMemoryRuntime as RuntimeBindings["getRuntime"],
      legacyAuthorizationCapabilities:
        authorizationModule?.LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
      lookup: "getMemoryRuntime",
      setActivePluginRegistry:
        runtimeStateModule.setActivePluginRegistry as RuntimeBindings["setActivePluginRegistry"],
    };
  }
  throw new Error(`expected getSelectedMemoryRuntime() or getMemoryRuntime() in ${repo}`);
}

function createMemoryRuntimeFixture(): object {
  return {
    async getMemorySearchManager() {
      return { error: "no index", manager: null };
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" };
    },
  };
}

function createMemoryCapabilityFixture(
  runtime: unknown,
  authorization?: unknown,
): {
  authorization?: unknown;
  runtime: unknown;
} {
  return {
    ...(authorization === undefined ? {} : { authorization }),
    runtime,
  };
}

function runLookupBatch(params: {
  batchSize: number;
  expectedRuntime: unknown;
  getRuntime: () => unknown;
}): number {
  const startedAt = process.hrtime.bigint();
  let resolvedRuntime: unknown;
  for (let index = 0; index < params.batchSize; index += 1) {
    resolvedRuntime = params.getRuntime();
  }
  const elapsedNs = process.hrtime.bigint() - startedAt;
  if (resolvedRuntime !== params.expectedRuntime) {
    throw new Error("selected runtime lookup returned a different runtime");
  }
  return Number(elapsedNs) / params.batchSize;
}

async function runBenchmark(options: BenchmarkOptions): Promise<BenchmarkReport> {
  const source: SourceIdentity = { commit: resolveSourceCommit(options.repo) };
  const bindings = await loadRuntimeBindings(options.repo);
  const registry = bindings.createEmptyPluginRegistry();
  const expectedRuntime = createMemoryRuntimeFixture();
  registry.plugins.push({ id: "memory-core", memorySlotSelected: true });
  registry.memoryCapabilities.push({
    capability: createMemoryCapabilityFixture(
      expectedRuntime,
      bindings.legacyAuthorizationCapabilities,
    ),
    pluginId: "memory-core",
  });

  bindings.setActivePluginRegistry(registry);
  try {
    const firstStartedAt = process.hrtime.bigint();
    const firstRuntime = bindings.getRuntime();
    const firstLookupNs = Number(process.hrtime.bigint() - firstStartedAt);
    if (firstRuntime !== expectedRuntime) {
      throw new Error("first selected runtime lookup did not return the fixture runtime");
    }
    for (let index = 0; index < options.warmup; index += 1) {
      runLookupBatch({
        batchSize: options.batchSize,
        expectedRuntime,
        getRuntime: bindings.getRuntime,
      });
    }
    const warmLookupNsPerLookup = Array.from({ length: options.runs }, () =>
      runLookupBatch({
        batchSize: options.batchSize,
        expectedRuntime,
        getRuntime: bindings.getRuntime,
      }),
    );
    const summary = summarizeLatency(warmLookupNsPerLookup);
    const report: BenchmarkReport = {
      batchSize: options.batchSize,
      fixture: BENCHMARK_FIXTURE,
      firstLookupNs,
      generatedAt: new Date().toISOString(),
      lookup: bindings.lookup,
      mode: BENCHMARK_MODE,
      repo: options.repo,
      runs: options.runs,
      runtime: {
        arch: process.arch,
        node: process.version,
        platform: process.platform,
      },
      source,
      summary,
      version: BENCHMARK_VERSION,
      warmLookupNsPerLookup,
      warmup: options.warmup,
    };
    if (options.baseline) {
      report.baselineComparison = compareP95AgainstBaseline({
        baseline: readBaselineReport(options.baseline),
        candidate: report,
        maxP95RegressionPct: options.maxP95RegressionPct,
      });
    }
    return report;
  } finally {
    // This benchmark process can import multiple candidate trees only by request; leave its
    // active registry empty so the fixture cannot leak into any later probe in this process.
    bindings.setActivePluginRegistry(bindings.createEmptyPluginRegistry());
  }
}

function writeReport(report: BenchmarkReport, output?: string): void {
  if (!output) {
    return;
  }
  mkdirSync(path.dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
}

function printUsage(): void {
  console.log(`Selected memory runtime benchmark

Usage:
  node --import tsx scripts/bench-memory-selected-runtime.mts [options]

Options:
  --repo <path>                     Source checkout to measure (default: current directory)
  --batch-size <n>                  Warm lookups in each sample (default: ${String(DEFAULT_BATCH_SIZE)})
  --runs <n>                        Measured warm samples, at least ${String(MIN_P95_SAMPLES)} (default: ${String(DEFAULT_RUNS)})
  --warmup <n>                      Unreported warm samples (default: ${String(DEFAULT_WARMUP)})
  --output <path>                   Write the JSON report to a file
  --json                            Also emit the full JSON report to stdout
  --baseline <report.json>          Compare p95 against a prior report
  --max-p95-regression-pct <n>      Allowed p95 regression (default: ${String(DEFAULT_MAX_P95_REGRESSION_PCT)}%)
  --help, -h                        Show this text
`);
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if ("help" in parsed) {
    printUsage();
    return;
  }
  const report = await runBenchmark(parsed);
  writeReport(report, parsed.output);
  console.log(
    `MEMORY_SELECTED_RUNTIME_BENCH lookup=${report.lookup} ` +
      `p50_ns_per_lookup=${report.summary.p50NsPerLookup.toFixed(3)} ` +
      `p95_ns_per_lookup=${report.summary.p95NsPerLookup.toFixed(3)}`,
  );
  if (parsed.json) {
    console.log(JSON.stringify(report, null, 2));
  }
  if (report.baselineComparison) {
    assertP95RegressionWithinBudget(report.baselineComparison);
  }
}

export const testing = {
  assertBaselineCompatibility,
  assertP95RegressionWithinBudget,
  compareP95AgainstBaseline,
  createMemoryCapabilityFixture,
  findLegacyAuthorizationModule,
  parseArgs,
  readBaselineReport,
  resolveSourceCommit,
  summarizeLatency,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => {
      if (process.exitCode && process.exitCode !== 0) {
        console.error(`[bench-memory-selected-runtime] FAILED (exit ${process.exitCode})`);
      }
    });
}
