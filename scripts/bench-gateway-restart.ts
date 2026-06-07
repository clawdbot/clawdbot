// Bench Gateway Restart script supports OpenClaw repository automation.
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseStrictIntegerOption } from "./lib/dev-tooling-safety.ts";
import { delay, stopChild, type StopChildResult } from "./lib/gateway-bench-child.ts";

type GatewayBenchCase = {
  config: Record<string, unknown>;
  env?: Record<string, string>;
  id: string;
  name: string;
  pluginActivationOnStartup?: boolean;
  pluginCount?: number;
};

type ProbeTransition = {
  errorKind?: string;
  ms: number;
  status: number | null;
};

type ProbeResult = {
  downtimeMs: number | null;
  firstErrorKind: string | null;
  firstRecoveryMs: number | null;
  ms: number | null;
  status: number | null;
  transitions: ProbeTransition[];
  unavailableMs: number | null;
};

type ResourceSnapshot = {
  activeHandlesCount: number | null;
  activeRequestsCount: number | null;
  activeTimersCount: number | null;
  fdCount: number | null;
  ms: number;
  phase: string;
  rssMb: number | null;
};

type BenchmarkEvent = {
  errorKind?: string;
  iteration?: number;
  line?: string;
  ms: number;
  phase?: string;
  status?: number | null;
  type: string;
};

type GatewayRestartFailureCode =
  | "initial_healthz_timeout"
  | "initial_ready_log_timeout"
  | "initial_readyz_timeout"
  | "restart_deadline_timeout"
  | "restart_signal_failed"
  | "restart_child_exited"
  | "next_healthz_timeout"
  | "next_readyz_timeout"
  | "ready_log_timeout"
  | "trace_missing"
  | "child_nonzero_exit"
  | "cleanup_failed";

type RestartIteration = {
  cpuCoreRatio: number | null;
  cpuMs: number | null;
  failureCode: GatewayRestartFailureCode | null;
  gatewayReadyLogLine: string | null;
  gatewayReadyLogMs: number | null;
  healthz: ProbeResult;
  httpListenLogLine: string | null;
  httpListenLogMs: number | null;
  index: number;
  readyz: ProbeResult;
  resourceSnapshots: ResourceSnapshot[];
  restartTrace: Record<string, number>;
  signalSentMs: number | null;
  startupTrace: Record<string, number>;
};

type ResourceSlope = {
  activeHandlesCountPerRestart: number | null;
  activeRequestsCountPerRestart: number | null;
  activeTimersCountPerRestart: number | null;
  fdCountPerRestart: number | null;
  heapUsedMbPerRestart: number | null;
  rssMbPerRestart: number | null;
};

type GatewayRestartSample = {
  childExitCode: number | null;
  childSignal: string | null;
  events: BenchmarkEvent[];
  exitedBeforeTeardown: boolean;
  failureCode: GatewayRestartFailureCode | null;
  firstOutputMs: number | null;
  initialGatewayReadyLogLine: string | null;
  initialGatewayReadyLogMs: number | null;
  initialHealthz: ProbeResult;
  initialHttpListenLogLine: string | null;
  initialHttpListenLogMs: number | null;
  initialReadyz: ProbeResult;
  initialStartupTrace: Record<string, number>;
  iterations: RestartIteration[];
  maxRssMb: number | null;
  outputTail: string;
  resourceSlope: ResourceSlope;
};

type SummaryStats = {
  avg: number;
  max: number;
  min: number;
  p50: number;
  p95: number;
};

type CaseResult = {
  id: string;
  name: string;
  samples: GatewayRestartSample[];
  summary: {
    downtimeMs: SummaryStats | null;
    failureRate: number;
    firstFailureCode: GatewayRestartFailureCode | null;
    healthzRecoveryMs: SummaryStats | null;
    readyzRecoveryMs: SummaryStats | null;
    resourceSlope: Record<keyof ResourceSlope, SummaryStats | null>;
    restartReadyMs: SummaryStats | null;
    restartReadyTotalMs: SummaryStats | null;
    restartTrace: Record<string, SummaryStats>;
  };
};

type BenchmarkEvidenceFailure = {
  id: string;
  reason: string;
  sampleIndex: number | null;
};

type PluginFixtureResult = {
  pluginIds: string[];
  pluginsDir: string;
};

type CliOptions = {
  allowFailures: boolean;
  cases: GatewayBenchCase[];
  entry: string;
  json: boolean;
  output?: string;
  postReadyDelayMs: number;
  restarts: number;
  runs: number;
  timeoutMs: number;
  warmup: number;
};

const DEFAULT_RUNS = 1;
const DEFAULT_WARMUP = 0;
const DEFAULT_RESTARTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POST_READY_DELAY_MS = 250;
const DEFAULT_ENTRY = "dist/entry.js";
const RESTART_INTENT_FILENAME = "gateway-restart-intent.json";

const BASE_CONFIG = {
  browser: { enabled: false },
  gateway: {
    mode: "local",
    bind: "loopback",
    auth: { mode: "none" },
    controlUi: { enabled: false },
    tailscale: { mode: "off" },
  },
  plugins: {
    enabled: true,
    entries: {
      browser: { enabled: false },
    },
  },
} satisfies Record<string, unknown>;

const GATEWAY_CASES: readonly GatewayBenchCase[] = [
  {
    id: "skipChannels",
    name: "gateway restart, skip channels",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    config: BASE_CONFIG,
  },
  {
    id: "skipChannelsAcpxProbe",
    name: "gateway restart, skip channels, ACPX startup probe on",
    env: { OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: "1", OPENCLAW_SKIP_CHANNELS: "1" },
    config: BASE_CONFIG,
  },
  {
    id: "skipChannelsNoAcpxProbe",
    name: "gateway restart, skip channels, ACPX startup probe off",
    env: { OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: "0", OPENCLAW_SKIP_CHANNELS: "1" },
    config: BASE_CONFIG,
  },
  {
    id: "default",
    name: "gateway restart, default",
    config: BASE_CONFIG,
  },
  {
    id: "fiftyPlugins",
    name: "gateway restart, 50 manifest plugins",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    pluginActivationOnStartup: true,
    pluginCount: 50,
    config: BASE_CONFIG,
  },
] as const;

function readRequiredFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseFlagValue(argv: string[], flag: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag) {
      return readRequiredFlagValue(argv, index, flag);
    }
  }
  return undefined;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function hasHelpFlag(argv: string[]): boolean {
  return hasFlag(argv, "--help") || hasFlag(argv, "-h");
}

function ensureSupportedRestartPlatform(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new Error(
      "Gateway restart benchmark is not supported on Windows because it requires SIGUSR1 in-process restarts; run it on macOS or Linux.",
    );
  }
}

function parseRepeatableFlag(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag) {
      values.push(readRequiredFlagValue(argv, index, flag));
      index += 1;
    }
  }
  return values;
}

function parsePositiveInt(raw: string | undefined, fallback: number, label: string): number {
  return parseStrictIntegerOption({ fallback, label, min: 1, raw });
}

function parseNonNegativeInt(raw: string | undefined, fallback: number, label: string): number {
  return parseStrictIntegerOption({ fallback, label, min: 0, raw });
}

function resolveEntry(raw: string | undefined): string {
  const entry = raw?.trim() || DEFAULT_ENTRY;
  if (entry.includes("\0")) {
    throw new Error("--entry must not contain NUL bytes");
  }
  if (entry.startsWith("-")) {
    throw new Error(`--entry must be a file path, not a Node option: ${JSON.stringify(entry)}`);
  }
  return entry;
}

function resolveOutputPath(raw: string | undefined): string | undefined {
  const output = raw?.trim();
  if (!output) {
    return undefined;
  }
  if (output.includes("\0")) {
    throw new Error("--output must not contain NUL bytes");
  }
  return output;
}

function resolveCases(caseIds: string[]): GatewayBenchCase[] {
  if (caseIds.length === 0) {
    return [GATEWAY_CASES[0]];
  }
  const byId = new Map(GATEWAY_CASES.map((benchCase) => [benchCase.id, benchCase]));
  return caseIds.map((id) => {
    const benchCase = byId.get(id);
    if (!benchCase) {
      throw new Error(`Unknown --case "${id}"`);
    }
    return benchCase;
  });
}

function parseOptions(argv: string[] = process.argv.slice(2)): CliOptions {
  return {
    allowFailures: hasFlag(argv, "--allow-failures"),
    cases: resolveCases(parseRepeatableFlag(argv, "--case")),
    entry: resolveEntry(parseFlagValue(argv, "--entry")),
    json: hasFlag(argv, "--json"),
    output: resolveOutputPath(parseFlagValue(argv, "--output")),
    postReadyDelayMs: parseNonNegativeInt(
      parseFlagValue(argv, "--post-ready-delay-ms"),
      DEFAULT_POST_READY_DELAY_MS,
      "--post-ready-delay-ms",
    ),
    restarts: parsePositiveInt(parseFlagValue(argv, "--restarts"), DEFAULT_RESTARTS, "--restarts"),
    runs: parsePositiveInt(parseFlagValue(argv, "--runs"), DEFAULT_RUNS, "--runs"),
    timeoutMs: parsePositiveInt(
      parseFlagValue(argv, "--timeout-ms"),
      DEFAULT_TIMEOUT_MS,
      "--timeout-ms",
    ),
    warmup: parseNonNegativeInt(parseFlagValue(argv, "--warmup"), DEFAULT_WARMUP, "--warmup"),
  };
}

function printUsage(): void {
  console.log(`OpenClaw Gateway restart benchmark

Usage:
  pnpm test:restart:gateway -- [options]
  node --import tsx scripts/bench-gateway-restart.ts [options]

Options:
  --case <id>              Specific case id to run; repeatable (default: skipChannels)
  --entry <path>           Gateway CLI entry file (default: ${DEFAULT_ENTRY})
  --runs <n>               Measured process samples per case (default: ${DEFAULT_RUNS})
  --warmup <n>             Warmup process samples per case (default: ${DEFAULT_WARMUP})
  --restarts <n>           In-process restarts per process sample (default: ${DEFAULT_RESTARTS})
  --timeout-ms <ms>        Timeout for initial startup and each restart (default: ${DEFAULT_TIMEOUT_MS})
  --post-ready-delay-ms <ms> Resource snapshot delay after next ready (default: ${DEFAULT_POST_READY_DELAY_MS})
  --output <path>          Write machine-readable JSON to a file
  --json                   Emit machine-readable JSON
  --allow-failures         Exit 0 even when restart failures are measured
  --help, -h               Show this text

Case ids:
  ${GATEWAY_CASES.map((benchCase) => `${benchCase.id} (${benchCase.name})`).join("\n  ")}
`);
}

function median(values: number[]): number {
  const sorted = [...values].toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[middle - 1] + sorted[middle]) / 2;
  }
  return sorted[middle] ?? 0;
}

function percentile(values: number[], p: number): number {
  const sorted = [...values].toSorted((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index] ?? 0;
}

function summarizeNumbers(values: number[]): SummaryStats | null {
  if (values.length === 0) {
    return null;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    avg: total / values.length,
    max: Math.max(...values),
    min: Math.min(...values),
    p50: median(values),
    p95: percentile(values, 95),
  };
}

function formatMs(value: number | null): string {
  return value == null ? "n/a" : `${value.toFixed(1)}ms`;
}

function formatMb(value: number | null): string {
  return value == null ? "n/a" : `${value.toFixed(1)}MB`;
}

function formatStats(stats: SummaryStats | null): string {
  if (!stats) {
    return "n/a";
  }
  return `p50=${formatMs(stats.p50)} avg=${formatMs(stats.avg)} min=${formatMs(stats.min)} max=${formatMs(stats.max)}`;
}

function formatRate(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function isTraceMetricSummaryKey(name: string): boolean {
  if (name.endsWith(".total")) {
    return true;
  }
  const lastSegment = name.split(".").at(-1);
  return (
    lastSegment === "eventLoopMax" ||
    lastSegment === "rssMb" ||
    lastSegment === "heapTotalMb" ||
    lastSegment === "heapUsedMb" ||
    lastSegment === "externalMb" ||
    lastSegment === "arrayBuffersMb" ||
    lastSegment === "activeHandlesCount" ||
    lastSegment === "activeRequestsCount" ||
    lastSegment === "activeTimersCount" ||
    lastSegment === "processSigintListenersCount" ||
    lastSegment === "processSigtermListenersCount" ||
    lastSegment === "processSigusr1ListenersCount" ||
    lastSegment === "restartExpectedMs" ||
    lastSegment?.endsWith("Count") === true ||
    lastSegment?.endsWith("Ms") === true
  );
}

function traceValue(iteration: RestartIteration, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = iteration.restartTrace[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return null;
}

function lastSnapshotValue(
  iteration: RestartIteration,
  key: keyof Omit<ResourceSnapshot, "ms" | "phase">,
): number | null {
  for (let index = iteration.resourceSnapshots.length - 1; index >= 0; index -= 1) {
    const value = iteration.resourceSnapshots[index]?.[key];
    if (typeof value === "number") {
      return value;
    }
  }
  return null;
}

function slope(values: Array<number | null>): number | null {
  const points = values
    .map((value, index) => ({ index, value }))
    .filter((point): point is { index: number; value: number } => typeof point.value === "number");
  if (points.length < 2) {
    return null;
  }
  const first = points[0];
  const last = points[points.length - 1];
  const denominator = Math.max(1, last.index - first.index);
  return (last.value - first.value) / denominator;
}

function summarizeResourceSlope(
  samples: GatewayRestartSample[],
): Record<keyof ResourceSlope, SummaryStats | null> {
  const keys: Array<keyof ResourceSlope> = [
    "rssMbPerRestart",
    "heapUsedMbPerRestart",
    "fdCountPerRestart",
    "activeHandlesCountPerRestart",
    "activeRequestsCountPerRestart",
    "activeTimersCountPerRestart",
  ];
  return Object.fromEntries(
    keys.map((key) => [
      key,
      summarizeNumbers(
        samples
          .map((sample) => sample.resourceSlope[key])
          .filter((value): value is number => typeof value === "number"),
      ),
    ]),
  ) as Record<keyof ResourceSlope, SummaryStats | null>;
}

function summarizeCase(benchCase: GatewayBenchCase, samples: GatewayRestartSample[]): CaseResult {
  const iterations = samples.flatMap((sample) => sample.iterations);
  const restartTraceKeys = new Set<string>();
  for (const iteration of iterations) {
    for (const key of Object.keys(iteration.restartTrace)) {
      restartTraceKeys.add(key);
    }
  }
  const restartTrace: Record<string, SummaryStats> = {};
  for (const key of [...restartTraceKeys].toSorted()) {
    const stats = summarizeNumbers(
      iterations
        .map((iteration) => iteration.restartTrace[key])
        .filter((value): value is number => typeof value === "number"),
    );
    if (stats) {
      restartTrace[key] = stats;
    }
  }
  const failedIterations = iterations.filter((iteration) => iteration.failureCode !== null);
  const sampleOnlyFailures = samples.filter(
    (sample) =>
      sample.failureCode !== null &&
      !sample.iterations.some((iteration) => iteration.failureCode !== null),
  );
  const failureUnits = iterations.length + sampleOnlyFailures.length;
  const firstFailureCode =
    samples.find((sample) => sample.failureCode)?.failureCode ??
    failedIterations[0]?.failureCode ??
    null;
  return {
    id: benchCase.id,
    name: benchCase.name,
    samples,
    summary: {
      downtimeMs: summarizeNumbers(
        iterations
          .map((iteration) => iteration.readyz.downtimeMs ?? iteration.healthz.downtimeMs)
          .filter((value): value is number => typeof value === "number"),
      ),
      failureRate:
        failureUnits === 0
          ? 0
          : (failedIterations.length + sampleOnlyFailures.length) / failureUnits,
      firstFailureCode,
      healthzRecoveryMs: summarizeNumbers(
        iterations
          .map((iteration) => iteration.healthz.ms)
          .filter((value): value is number => typeof value === "number"),
      ),
      readyzRecoveryMs: summarizeNumbers(
        iterations
          .map((iteration) => iteration.readyz.ms)
          .filter((value): value is number => typeof value === "number"),
      ),
      resourceSlope: summarizeResourceSlope(samples),
      restartReadyMs: summarizeNumbers(
        iterations
          .map((iteration) => traceValue(iteration, "restart.ready"))
          .filter((value): value is number => typeof value === "number"),
      ),
      restartReadyTotalMs: summarizeNumbers(
        iterations
          .map((iteration) => traceValue(iteration, "restart.ready.total"))
          .filter((value): value is number => typeof value === "number"),
      ),
      restartTrace,
    },
  };
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

async function waitForProbeReady(params: {
  deadlineAt: number;
  isDone?: () => boolean;
  path: string;
  port: number;
  sampleStartAt: number;
}): Promise<ProbeResult> {
  let firstErrorKind: string | null = null;
  let firstRecoveryMs: number | null = null;
  let lastStatus: number | null = null;
  let lastStateKey: string | null = null;
  let sawUnreadyState = false;
  const transitions: ProbeTransition[] = [];
  while (performance.now() < params.deadlineAt) {
    if (params.isDone?.()) {
      break;
    }
    const attempt = await requestProbeStatus(params.port, params.path);
    const elapsedMs = performance.now() - params.sampleStartAt;
    lastStatus = attempt.status;
    const stateKey = `${attempt.status ?? "none"}:${attempt.errorKind ?? "ok"}`;
    if (stateKey !== lastStateKey) {
      transitions.push({
        ms: elapsedMs,
        status: attempt.status,
        ...(attempt.errorKind ? { errorKind: attempt.errorKind } : {}),
      });
      lastStateKey = stateKey;
    }
    if (attempt.errorKind && firstErrorKind == null) {
      firstErrorKind = attempt.errorKind;
    }
    if (attempt.status !== 200) {
      sawUnreadyState = true;
    }
    if (attempt.status === 200) {
      if (sawUnreadyState && firstRecoveryMs == null) {
        firstRecoveryMs = elapsedMs;
      }
      return {
        downtimeMs: null,
        firstErrorKind,
        firstRecoveryMs,
        ms: elapsedMs,
        status: attempt.status,
        transitions,
        unavailableMs: null,
      };
    }
    await delay(25);
  }
  return {
    downtimeMs: null,
    firstErrorKind,
    firstRecoveryMs,
    ms: null,
    status: lastStatus,
    transitions,
    unavailableMs: null,
  };
}

async function waitForRestartProbe(params: {
  deadlineAt: number;
  events: BenchmarkEvent[];
  isDone?: () => boolean;
  isProcessDone?: () => boolean;
  iteration: number;
  path: string;
  port: number;
  sampleStartAt: number;
  signalSentAt: number;
}): Promise<ProbeResult> {
  let firstErrorKind: string | null = null;
  let firstRecoveryMs: number | null = null;
  let lastStatus: number | null = null;
  let lastStateKey: string | null = null;
  let lastSuccessMs: number | null = null;
  let unavailableMs: number | null = null;
  const transitions: ProbeTransition[] = [];
  while (performance.now() < params.deadlineAt) {
    if (params.isProcessDone?.()) {
      break;
    }
    if (params.isDone?.() && unavailableMs == null && lastSuccessMs != null) {
      return {
        downtimeMs: null,
        firstErrorKind,
        firstRecoveryMs,
        ms: lastSuccessMs,
        status: 200,
        transitions,
        unavailableMs: null,
      };
    }
    const attempt = await requestProbeStatus(params.port, params.path);
    const now = performance.now();
    const elapsedMs = now - params.signalSentAt;
    lastStatus = attempt.status;
    const stateKey = `${attempt.status ?? "none"}:${attempt.errorKind ?? "ok"}`;
    if (stateKey !== lastStateKey) {
      transitions.push({
        ms: elapsedMs,
        status: attempt.status,
        ...(attempt.errorKind ? { errorKind: attempt.errorKind } : {}),
      });
      params.events.push({
        iteration: params.iteration,
        ms: now - params.sampleStartAt,
        status: attempt.status,
        type: `${params.path}:transition`,
        ...(attempt.errorKind ? { errorKind: attempt.errorKind } : {}),
      });
      lastStateKey = stateKey;
    }
    if (attempt.errorKind && firstErrorKind == null) {
      firstErrorKind = attempt.errorKind;
    }
    if (attempt.status !== 200 && unavailableMs == null) {
      unavailableMs = elapsedMs;
    }
    if (attempt.status === 200) {
      lastSuccessMs = elapsedMs;
    }
    if (attempt.status === 200 && unavailableMs != null) {
      firstRecoveryMs = elapsedMs;
      return {
        downtimeMs: elapsedMs - unavailableMs,
        firstErrorKind,
        firstRecoveryMs,
        ms: elapsedMs,
        status: attempt.status,
        transitions,
        unavailableMs,
      };
    }
    await delay(25);
  }
  return {
    downtimeMs: null,
    firstErrorKind,
    firstRecoveryMs,
    ms: unavailableMs == null ? lastSuccessMs : null,
    status: lastStatus,
    transitions,
    unavailableMs,
  };
}

async function requestProbeStatus(
  port: number,
  pathname: string,
): Promise<{ errorKind: string | null; status: number | null }> {
  try {
    const status = await requestStatus(port, pathname);
    return {
      errorKind: status === 200 ? null : `http-${status}`,
      status,
    };
  } catch (error) {
    return {
      errorKind: classifyProbeErrorKind(error),
      status: null,
    };
  }
}

function classifyProbeErrorKind(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) {
      return code.trim().toLowerCase();
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.toLowerCase().includes("probe timeout")) {
      return "timeout";
    }
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) {
      return name.trim().toLowerCase();
    }
  }
  return "error";
}

function requestStatus(port: number, pathname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", method: "GET", path: pathname, port, timeout: 100 },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("probe timeout"));
    });
    req.end();
  });
}

function writePluginFixtures(
  root: string,
  count: number,
  activationOnStartup?: boolean,
): PluginFixtureResult {
  const pluginIds: string[] = [];
  const pluginsDir = path.join(root, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const id = `bench-plugin-${String(index + 1).padStart(2, "0")}`;
    pluginIds.push(id);
    const pluginDir = path.join(pluginsDir, id);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      path.join(pluginDir, "index.cjs"),
      `module.exports = { id: ${JSON.stringify(id)}, register() {} };\n`,
    );
    writeFileSync(
      path.join(pluginDir, "openclaw.plugin.json"),
      `${JSON.stringify(
        {
          id,
          ...(activationOnStartup === undefined
            ? {}
            : { activation: { onStartup: activationOnStartup } }),
          configSchema: { type: "object", additionalProperties: false },
        },
        null,
        2,
      )}\n`,
    );
  }
  return { pluginIds, pluginsDir };
}

function writeConfig(root: string, benchCase: GatewayBenchCase): string {
  const pluginFixtures = benchCase.pluginCount
    ? writePluginFixtures(root, benchCase.pluginCount, benchCase.pluginActivationOnStartup)
    : null;
  const config = {
    ...benchCase.config,
    plugins: {
      ...(benchCase.config.plugins as Record<string, unknown> | undefined),
      ...(pluginFixtures
        ? {
            allow: pluginFixtures.pluginIds,
            load: { paths: [pluginFixtures.pluginsDir] },
          }
        : {}),
    },
  };
  const configPath = path.join(root, "openclaw.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return configPath;
}

function sanitizedEnv(
  root: string,
  configPath: string,
  benchCase: GatewayBenchCase,
): NodeJS.ProcessEnv {
  return {
    CI: process.env.CI ?? "1",
    HOME: root,
    LANG: process.env.LANG ?? "en_US.UTF-8",
    LOGNAME: process.env.LOGNAME ?? "openclaw-bench",
    NO_COLOR: "1",
    PATH: process.env.PATH,
    SHELL: process.env.SHELL,
    TMPDIR: process.env.TMPDIR,
    USER: process.env.USER ?? "openclaw-bench",
    npm_config_update_notifier: "false",
    OPENCLAW_CONFIG: configPath,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_GATEWAY_RESTART_TRACE: "1",
    OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
    OPENCLAW_HOME: root,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_TEST_DISABLE_UPDATE_CHECK: "1",
    ...benchCase.env,
  };
}

function writeRestartIntent(env: NodeJS.ProcessEnv, targetPid: number, reason: string): boolean {
  const stateDir = env.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    return false;
  }
  try {
    mkdirSync(stateDir, { recursive: true });
    const intentPath = path.join(stateDir, RESTART_INTENT_FILENAME);
    writeFileSync(
      intentPath,
      `${JSON.stringify({
        kind: "gateway-restart",
        pid: targetPid,
        createdAt: Date.now(),
        reason,
      })}\n`,
      { mode: 0o600 },
    );
    return true;
  } catch {
    return false;
  }
}

function readProcessRssMb(pid: number | undefined): number | null {
  if (!pid || process.platform === "win32") {
    return null;
  }
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  const rssKb = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(rssKb) && rssKb > 0 ? rssKb / 1024 : null;
}

function readProcessFdCount(pid: number | undefined): number | null {
  if (!pid || process.platform === "win32") {
    return null;
  }
  const procFd = `/proc/${pid}/fd`;
  try {
    return fs.readdirSync(procFd).length;
  } catch {
    // macOS does not expose /proc; use lsof when available.
  }
  const result = spawnSync("lsof", ["-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1000,
  });
  if (result.status !== 0) {
    return null;
  }
  return countLsofFileDescriptors(result.stdout);
}

function countLsofFileDescriptors(raw: string): number | null {
  const lines = raw.trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length <= 1) {
    return null;
  }
  let count = 0;
  for (const line of lines.slice(1)) {
    const columns = line.trim().split(/\s+/u);
    if (/^\d+/u.test(columns[3] ?? "")) {
      count += 1;
    }
  }
  return count;
}

function parsePsCpuTimeMs(raw: string): number | null {
  const parts = raw.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  if (parts.length === 2) {
    return Math.round((parts[0] * 60 + parts[1]) * 1000);
  }
  if (parts.length === 3) {
    return Math.round((parts[0] * 60 * 60 + parts[1] * 60 + parts[2]) * 1000);
  }
  return null;
}

function readProcessTreeCpuMs(rootPid: number | undefined): number | null {
  if (!rootPid || process.platform === "win32") {
    return null;
  }
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,time="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }

  const childrenByParent = new Map<number, number[]>();
  const cpuByPid = new Map<number, number>();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/u);
    if (!match) {
      continue;
    }
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const cpuMs = parsePsCpuTimeMs(match[3]);
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || cpuMs === null) {
      continue;
    }
    cpuByPid.set(pid, cpuMs);
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  if (!cpuByPid.has(rootPid)) {
    return null;
  }

  let totalCpuMs = 0;
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    totalCpuMs += cpuByPid.get(pid) ?? 0;
    for (const childPid of childrenByParent.get(pid) ?? []) {
      stack.push(childPid);
    }
  }
  return totalCpuMs;
}

function snapshotResources(
  child: ChildProcessWithoutNullStreams,
  sampleStartAt: number,
  phase: string,
): ResourceSnapshot {
  return {
    activeHandlesCount: null,
    activeRequestsCount: null,
    activeTimersCount: null,
    fdCount: readProcessFdCount(child.pid),
    ms: performance.now() - sampleStartAt,
    phase,
    rssMb: readProcessRssMb(child.pid),
  };
}

function collectTraceLine(
  line: string,
  prefix: "startup trace" | "restart trace",
  trace: Record<string, number>,
): boolean {
  const escapedPrefix = prefix.replace(" ", "\\s+");
  const phaseMatch = new RegExp(
    `${escapedPrefix}: ([^ ]+) ([0-9.]+)ms total=([0-9.]+)ms(?: (.*))?`,
    "u",
  ).exec(line);
  if (phaseMatch) {
    trace[phaseMatch[1]] = Number(phaseMatch[2]);
    trace[`${phaseMatch[1]}.total`] = Number(phaseMatch[3]);
    for (const metric of parseTraceMetrics(phaseMatch[4] ?? "")) {
      trace[`${phaseMatch[1]}.${metric.key}`] = metric.value;
    }
    return true;
  }
  const detailMatch = new RegExp(`${escapedPrefix}: ([^ ]+) (.*)`, "u").exec(line);
  if (!detailMatch) {
    return false;
  }
  for (const metric of parseTraceMetrics(detailMatch[2])) {
    trace[`${detailMatch[1]}.${metric.key}`] = metric.value;
  }
  return true;
}

function parseTraceMetrics(raw: string): Array<{ key: string; value: number }> {
  const metrics: Array<{ key: string; value: number }> = [];
  for (const part of raw.trim().split(/\s+/u)) {
    const metricMatch = /^([A-Za-z][A-Za-z0-9]*)=([0-9.]+)(?:ms)?$/u.exec(part);
    if (!metricMatch) {
      continue;
    }
    const key = metricMatch[1];
    const value = Number(metricMatch[2]);
    if (!Number.isFinite(value)) {
      continue;
    }
    if (
      key !== "eventLoopMax" &&
      !key.endsWith("Ms") &&
      !key.endsWith("Mb") &&
      !key.endsWith("Count")
    ) {
      continue;
    }
    metrics.push({ key, value });
  }
  return metrics;
}

function classifyGatewayReadyLog(line: string): "gateway-ready" | "http-listen" | null {
  if (line.includes("[gateway] http server listening (")) {
    return "http-listen";
  }
  if (/\[gateway\] ready(?:\s*\(|\s*$)/u.test(line)) {
    return "gateway-ready";
  }
  return null;
}

function collectOutputLines(carry: string, chunk: string): { carry: string; lines: string[] } {
  const parts = `${carry}${chunk}`.split(/\r?\n/u);
  return {
    carry: parts.pop() ?? "",
    lines: parts,
  };
}

function flushOutputLineBuffers(
  buffers: Record<"stderr" | "stdout", string>,
  onLine: (line: string, nowMs: number) => void,
  nowMs: number,
  options: { flushPartial?: boolean } = {},
): void {
  if (!options.flushPartial) {
    return;
  }
  for (const stream of ["stdout", "stderr"] as const) {
    const line = buffers[stream];
    if (!line) {
      continue;
    }
    buffers[stream] = "";
    onLine(line, nowMs);
  }
}

function createEmptyProbeResult(): ProbeResult {
  return {
    downtimeMs: null,
    firstErrorKind: null,
    firstRecoveryMs: null,
    ms: null,
    status: null,
    transitions: [],
    unavailableMs: null,
  };
}

function createRestartIteration(index: number): RestartIteration {
  return {
    cpuCoreRatio: null,
    cpuMs: null,
    failureCode: null,
    gatewayReadyLogLine: null,
    gatewayReadyLogMs: null,
    healthz: createEmptyProbeResult(),
    httpListenLogLine: null,
    httpListenLogMs: null,
    index,
    readyz: createEmptyProbeResult(),
    resourceSnapshots: [],
    restartTrace: {},
    signalSentMs: null,
    startupTrace: {},
  };
}

function resolveIterationFailure(iteration: RestartIteration): GatewayRestartFailureCode | null {
  if (iteration.healthz.ms === null) {
    return "next_healthz_timeout";
  }
  if (iteration.readyz.ms === null) {
    return "next_readyz_timeout";
  }
  if (iteration.gatewayReadyLogMs === null) {
    return "ready_log_timeout";
  }
  if (typeof iteration.restartTrace["restart.ready.total"] !== "number") {
    return "trace_missing";
  }
  return null;
}

function finalizeRestartIteration(
  iteration: RestartIteration,
  childExited: boolean,
  flushOutputBuffers: () => void,
): GatewayRestartFailureCode | null {
  flushOutputBuffers();
  return childExited ? "restart_child_exited" : resolveIterationFailure(iteration);
}

function hasRestartReadySignal(iteration: RestartIteration): boolean {
  return (
    typeof iteration.restartTrace["restart.ready.total"] === "number" &&
    iteration.gatewayReadyLogMs !== null
  );
}

function hasInitialReadyLogs(params: {
  initialGatewayReadyLogMs: number | null;
  initialHttpListenLogMs: number | null;
}): boolean {
  return params.initialGatewayReadyLogMs !== null && params.initialHttpListenLogMs !== null;
}

function resolveRestartDeadlineFailure(childExited: boolean): GatewayRestartFailureCode {
  return childExited ? "restart_child_exited" : "restart_deadline_timeout";
}

function resolveSampleExitFailure(exit: StopChildResult): GatewayRestartFailureCode | null {
  if (!exit.exitedBeforeTeardown) {
    return null;
  }
  return exit.exitCode !== null && exit.exitCode !== 0
    ? "child_nonzero_exit"
    : "restart_child_exited";
}

function computeResourceSlope(iterations: RestartIteration[]): ResourceSlope {
  return {
    activeHandlesCountPerRestart: slope(
      iterations.map((iteration) =>
        traceValue(
          iteration,
          "restart.ready.activeHandlesCount",
          "restart.ready.memory.ready.activeHandlesCount",
        ),
      ),
    ),
    activeRequestsCountPerRestart: slope(
      iterations.map((iteration) =>
        traceValue(
          iteration,
          "restart.ready.activeRequestsCount",
          "restart.ready.memory.ready.activeRequestsCount",
        ),
      ),
    ),
    activeTimersCountPerRestart: slope(
      iterations.map((iteration) =>
        traceValue(
          iteration,
          "restart.ready.activeTimersCount",
          "restart.ready.memory.ready.activeTimersCount",
        ),
      ),
    ),
    fdCountPerRestart: slope(
      iterations.map((iteration) => lastSnapshotValue(iteration, "fdCount")),
    ),
    heapUsedMbPerRestart: slope(
      iterations.map((iteration) =>
        traceValue(iteration, "restart.ready.heapUsedMb", "restart.ready.memory.ready.heapUsedMb"),
      ),
    ),
    rssMbPerRestart: slope(
      iterations.map(
        (iteration) =>
          traceValue(iteration, "restart.ready.rssMb", "restart.ready.memory.ready.rssMb") ??
          lastSnapshotValue(iteration, "rssMb"),
      ),
    ),
  };
}

async function waitForIterationCondition(
  predicate: () => boolean,
  deadlineAt: number,
): Promise<boolean> {
  while (performance.now() < deadlineAt) {
    if (predicate()) {
      return true;
    }
    await delay(25);
  }
  return predicate();
}

function resolvePhaseDeadlineAt(startedAt: number, timeoutMs: number): number {
  return startedAt + timeoutMs;
}

async function runGatewaySample(options: {
  benchCase: GatewayBenchCase;
  entry: string;
  restarts: number;
  postReadyDelayMs: number;
  timeoutMs: number;
}): Promise<GatewayRestartSample> {
  ensureSupportedRestartPlatform();
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-gateway-restart-bench-"));
  const port = await getFreePort();
  const configPath = writeConfig(root, options.benchCase);
  const env = sanitizedEnv(root, configPath, options.benchCase);
  const sampleStartAt = performance.now();
  const initialDeadlineAt = resolvePhaseDeadlineAt(sampleStartAt, options.timeoutMs);
  const initialStartupTrace: Record<string, number> = {};
  const events: BenchmarkEvent[] = [{ ms: 0, type: "process.spawn.start" }];
  const output: string[] = [];
  const outputBuffers: Record<"stderr" | "stdout", string> = { stderr: "", stdout: "" };
  let currentIteration: RestartIteration | null = null;
  let firstOutputMs: number | null = null;
  let initialGatewayReadyLogLine: string | null = null;
  let initialGatewayReadyLogMs: number | null = null;
  let initialHttpListenLogLine: string | null = null;
  let initialHttpListenLogMs: number | null = null;
  let maxRssMb: number | null = null;
  let childExited = false;

  const child = spawn(
    process.execPath,
    [
      options.entry,
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--auth",
      "none",
      "--tailscale",
      "off",
      "--allow-unconfigured",
    ],
    {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env,
    },
  );
  events.push({ ms: performance.now() - sampleStartAt, type: "process.spawned" });
  const sampleRss = () => {
    const rssMb = readProcessRssMb(child.pid);
    if (rssMb != null) {
      maxRssMb = maxRssMb == null ? rssMb : Math.max(maxRssMb, rssMb);
    }
  };
  sampleRss();
  const rssTimer = setInterval(sampleRss, 100);
  rssTimer.unref?.();
  const childExitPromise = new Promise<{ exitCode: number | null; signal: string | null }>(
    (resolve) => {
      child.once("exit", (exitCode, signal) => {
        childExited = true;
        events.push({ ms: performance.now() - sampleStartAt, type: "process.exit" });
        resolve({ exitCode, signal });
      });
    },
  );

  const onLine = (line: string, nowMs: number) => {
    if (!line) {
      return;
    }
    const readyLogKind = classifyGatewayReadyLog(line);
    if (readyLogKind === "http-listen") {
      if (currentIteration) {
        currentIteration.httpListenLogMs ??= nowMs - (currentIteration.signalSentMs ?? nowMs);
        currentIteration.httpListenLogLine ??= line;
      } else if (initialHttpListenLogMs == null) {
        initialHttpListenLogMs = nowMs;
        initialHttpListenLogLine = line;
      }
    }
    if (readyLogKind === "gateway-ready") {
      if (currentIteration) {
        currentIteration.gatewayReadyLogMs ??= nowMs - (currentIteration.signalSentMs ?? nowMs);
        currentIteration.gatewayReadyLogLine ??= line;
      } else if (initialGatewayReadyLogMs == null) {
        initialGatewayReadyLogMs = nowMs;
        initialGatewayReadyLogLine = line;
      }
    }
    const traceTarget = currentIteration?.startupTrace ?? initialStartupTrace;
    if (collectTraceLine(line, "startup trace", traceTarget)) {
      events.push({
        iteration: currentIteration?.index,
        line,
        ms: nowMs,
        type: "startup-trace",
      });
    }
    if (
      currentIteration &&
      collectTraceLine(line, "restart trace", currentIteration.restartTrace)
    ) {
      events.push({ iteration: currentIteration.index, line, ms: nowMs, type: "restart-trace" });
    }
  };

  const onChunk = (stream: "stderr" | "stdout", chunk: Buffer) => {
    const nowMs = performance.now() - sampleStartAt;
    if (firstOutputMs == null) {
      firstOutputMs = nowMs;
      events.push({ ms: nowMs, type: "process.first-output" });
    }
    const text = chunk.toString("utf8");
    output.push(text);
    if (output.length > 30) {
      output.splice(0, output.length - 30);
    }
    const parsed = collectOutputLines(outputBuffers[stream], text);
    outputBuffers[stream] = parsed.carry;
    for (const line of parsed.lines) {
      onLine(line, nowMs);
    }
  };
  child.stdout.on("data", (chunk: Buffer) => onChunk("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => onChunk("stderr", chunk));

  let failureCode: GatewayRestartFailureCode | null = null;
  const initialHealthz = await waitForProbeReady({
    deadlineAt: initialDeadlineAt,
    isDone: () => childExited,
    path: "/healthz",
    port,
    sampleStartAt,
  });
  if (initialHealthz.ms === null) {
    failureCode = "initial_healthz_timeout";
  }
  const initialReadyz =
    failureCode === null
      ? await waitForProbeReady({
          deadlineAt: initialDeadlineAt,
          isDone: () => childExited,
          path: "/readyz",
          port,
          sampleStartAt,
        })
      : createEmptyProbeResult();
  if (failureCode === null && initialReadyz.ms === null) {
    failureCode = "initial_readyz_timeout";
  }

  if (failureCode === null) {
    flushOutputLineBuffers(outputBuffers, onLine, performance.now() - sampleStartAt);
    await waitForIterationCondition(
      () => hasInitialReadyLogs({ initialGatewayReadyLogMs, initialHttpListenLogMs }),
      initialDeadlineAt,
    );
    flushOutputLineBuffers(outputBuffers, onLine, performance.now() - sampleStartAt);
    if (!hasInitialReadyLogs({ initialGatewayReadyLogMs, initialHttpListenLogMs })) {
      failureCode = "initial_ready_log_timeout";
    }
  }

  const iterations: RestartIteration[] = [];
  if (failureCode === null) {
    for (let index = 1; index <= options.restarts; index += 1) {
      if (childExited) {
        failureCode = resolveRestartDeadlineFailure(childExited);
        break;
      }
      const iteration = createRestartIteration(index);
      currentIteration = iteration;
      const cpuStartMs = readProcessTreeCpuMs(child.pid);
      iteration.resourceSnapshots.push(snapshotResources(child, sampleStartAt, "before-signal"));
      const targetPid = child.pid;
      if (!targetPid || !writeRestartIntent(env, targetPid, "gateway-restart-bench")) {
        iteration.failureCode = "restart_signal_failed";
        failureCode = iteration.failureCode;
        iterations.push(iteration);
        break;
      }
      events.push({
        iteration: index,
        ms: performance.now() - sampleStartAt,
        type: "restart-intent-written",
      });
      try {
        process.kill(targetPid, "SIGUSR1");
      } catch {
        iteration.failureCode = "restart_signal_failed";
        failureCode = iteration.failureCode;
        iterations.push(iteration);
        break;
      }
      const signalSentAt = performance.now();
      iteration.signalSentMs = signalSentAt - sampleStartAt;
      const iterationDeadlineAt = resolvePhaseDeadlineAt(signalSentAt, options.timeoutMs);
      events.push({ iteration: index, ms: iteration.signalSentMs, type: "restart-signal-sent" });

      const healthzPromise = waitForRestartProbe({
        deadlineAt: iterationDeadlineAt,
        events,
        isDone: () => hasRestartReadySignal(iteration),
        isProcessDone: () => childExited,
        iteration: index,
        path: "/healthz",
        port,
        sampleStartAt,
        signalSentAt,
      });
      const readyzPromise = waitForRestartProbe({
        deadlineAt: iterationDeadlineAt,
        events,
        isDone: () => hasRestartReadySignal(iteration),
        isProcessDone: () => childExited,
        iteration: index,
        path: "/readyz",
        port,
        sampleStartAt,
        signalSentAt,
      });
      const [healthz, readyz] = await Promise.all([healthzPromise, readyzPromise]);
      iteration.healthz = healthz;
      iteration.readyz = readyz;
      iteration.resourceSnapshots.push(snapshotResources(child, sampleStartAt, "after-next-ready"));
      await waitForIterationCondition(() => hasRestartReadySignal(iteration), iterationDeadlineAt);
      if (options.postReadyDelayMs > 0 && performance.now() < iterationDeadlineAt) {
        await delay(
          Math.min(options.postReadyDelayMs, Math.max(0, iterationDeadlineAt - performance.now())),
        );
      }
      iteration.resourceSnapshots.push(
        snapshotResources(child, sampleStartAt, "after-post-ready-delay"),
      );
      const cpuEndMs = readProcessTreeCpuMs(child.pid);
      iteration.cpuMs =
        cpuStartMs == null || cpuEndMs == null ? null : Math.max(0, cpuEndMs - cpuStartMs);
      iteration.cpuCoreRatio =
        iteration.cpuMs == null
          ? null
          : iteration.cpuMs / Math.max(1, performance.now() - signalSentAt);
      iteration.failureCode = finalizeRestartIteration(iteration, childExited, () =>
        flushOutputLineBuffers(outputBuffers, onLine, performance.now() - sampleStartAt),
      );
      iterations.push(iteration);
      console.error(
        `[gateway-restart-bench] ${options.benchCase.id} restart ${index}/${options.restarts}: readyz=${formatMs(iteration.readyz.ms)} downtime=${formatMs(iteration.readyz.downtimeMs ?? iteration.healthz.downtimeMs)} restartReady=${formatMs(traceValue(iteration, "restart.ready.total"))} cpu=${formatMs(iteration.cpuMs)} rss=${formatMb(traceValue(iteration, "restart.ready.rssMb", "restart.ready.memory.ready.rssMb") ?? lastSnapshotValue(iteration, "rssMb"))} failure=${iteration.failureCode ?? "none"}`,
      );
      if (iteration.failureCode) {
        failureCode = iteration.failureCode;
        break;
      }
    }
  }

  currentIteration = null;
  flushOutputLineBuffers(outputBuffers, onLine, performance.now() - sampleStartAt);
  const exit = await stopChild(child);
  clearInterval(rssTimer);
  sampleRss();
  // stopChild is the bounded teardown wait; the raw exit promise may never settle.
  void childExitPromise.catch(() => null);
  flushOutputLineBuffers(outputBuffers, onLine, performance.now() - sampleStartAt, {
    flushPartial: true,
  });
  failureCode ??= resolveSampleExitFailure(exit);
  try {
    rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  } catch {
    failureCode ??= "cleanup_failed";
  }

  return {
    childExitCode: exit.exitCode,
    childSignal: exit.signal,
    events,
    exitedBeforeTeardown: exit.exitedBeforeTeardown,
    failureCode,
    firstOutputMs,
    initialGatewayReadyLogLine,
    initialGatewayReadyLogMs,
    initialHealthz,
    initialHttpListenLogLine,
    initialHttpListenLogMs,
    initialReadyz,
    initialStartupTrace,
    iterations,
    maxRssMb,
    outputTail: output.join("").split(/\r?\n/u).slice(-30).join("\n"),
    resourceSlope: computeResourceSlope(iterations),
  };
}

async function runCase(options: {
  benchCase: GatewayBenchCase;
  entry: string;
  postReadyDelayMs: number;
  restarts: number;
  runs: number;
  timeoutMs: number;
  warmup: number;
}): Promise<CaseResult> {
  const samples: GatewayRestartSample[] = [];
  const total = options.runs + options.warmup;
  for (let index = 0; index < total; index += 1) {
    const sample = await runGatewaySample({
      benchCase: options.benchCase,
      entry: options.entry,
      postReadyDelayMs: options.postReadyDelayMs,
      restarts: options.restarts,
      timeoutMs: options.timeoutMs,
    });
    if (index >= options.warmup) {
      samples.push(sample);
      console.error(
        `[gateway-restart-bench] ${options.benchCase.id} sample ${samples.length}/${options.runs}: iterations=${sample.iterations.length} failure=${sample.failureCode ?? "none"} rssSlope=${formatMb(sample.resourceSlope.rssMbPerRestart)} heapSlope=${formatMb(sample.resourceSlope.heapUsedMbPerRestart)} fdSlope=${sample.resourceSlope.fdCountPerRestart ?? "n/a"}`,
      );
    } else {
      console.error(
        `[gateway-restart-bench] ${options.benchCase.id} warmup ${index + 1}/${options.warmup}: failure=${sample.failureCode ?? "none"}`,
      );
    }
  }
  return summarizeCase(options.benchCase, samples);
}

function printResult(result: CaseResult): void {
  console.log(`\n${result.name} (${result.id})`);
  console.log(`  failure rate: ${formatRate(result.summary.failureRate)}`);
  console.log(`  first failure: ${result.summary.firstFailureCode ?? "none"}`);
  console.log(`  downtime:      ${formatStats(result.summary.downtimeMs)}`);
  console.log(`  /healthz next: ${formatStats(result.summary.healthzRecoveryMs)}`);
  console.log(`  /readyz next:  ${formatStats(result.summary.readyzRecoveryMs)}`);
  console.log(`  restart.ready: ${formatStats(result.summary.restartReadyTotalMs)}`);
  console.log(
    `  resource slope: rss=${formatMb(result.summary.resourceSlope.rssMbPerRestart?.avg ?? null)}/restart heap=${formatMb(result.summary.resourceSlope.heapUsedMbPerRestart?.avg ?? null)}/restart fd=${result.summary.resourceSlope.fdCountPerRestart?.avg?.toFixed(2) ?? "n/a"}/restart`,
  );
  const trace = Object.entries(result.summary.restartTrace)
    .filter(([name]) => !isTraceMetricSummaryKey(name))
    .toSorted((a, b) => (b[1].avg ?? 0) - (a[1].avg ?? 0))
    .slice(0, 10);
  if (trace.length > 0) {
    console.log("  trace top:");
    for (const [name, stats] of trace) {
      console.log(`    ${name}: ${formatStats(stats)}`);
    }
  }
}

function hasBenchmarkFailures(results: CaseResult[]): boolean {
  return results.some(
    (result) => result.summary.failureRate > 0 || result.summary.firstFailureCode !== null,
  );
}

function hasPositiveNumber(value: number | null): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function hasFiniteNumber(value: number | null): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function hasIterationRssEvidence(iteration: RestartIteration): boolean {
  return hasPositiveNumber(
    traceValue(iteration, "restart.ready.rssMb", "restart.ready.memory.ready.rssMb") ??
      lastSnapshotValue(iteration, "rssMb"),
  );
}

function isFailureFreeSample(sample: GatewayRestartSample): boolean {
  return (
    sample.failureCode === null &&
    sample.iterations.every((iteration) => iteration.failureCode === null)
  );
}

function collectBenchmarkEvidenceFailures(results: CaseResult[]): BenchmarkEvidenceFailure[] {
  const failures: BenchmarkEvidenceFailure[] = [];
  for (const result of results) {
    if (result.samples.length === 0) {
      failures.push({
        id: result.id,
        reason: "missing measured samples",
        sampleIndex: null,
      });
      continue;
    }

    for (const [index, sample] of result.samples.entries()) {
      if (!isFailureFreeSample(sample)) {
        continue;
      }
      const sampleIndex = index + 1;
      if (sample.iterations.length === 0) {
        failures.push({
          id: result.id,
          reason: "missing restart iterations",
          sampleIndex,
        });
        continue;
      }
      if (!hasPositiveNumber(sample.maxRssMb)) {
        failures.push({
          id: result.id,
          reason: "missing positive RSS sample",
          sampleIndex,
        });
      }
      if (sample.iterations.some((iteration) => !hasIterationRssEvidence(iteration))) {
        failures.push({
          id: result.id,
          reason: "missing per-restart RSS evidence",
          sampleIndex,
        });
      }
      if (sample.iterations.length >= 2 && !hasFiniteNumber(sample.resourceSlope.rssMbPerRestart)) {
        failures.push({
          id: result.id,
          reason: "missing RSS slope",
          sampleIndex,
        });
      }
    }
  }
  return failures;
}

function hasInvalidBenchmarkEvidence(results: CaseResult[]): boolean {
  return collectBenchmarkEvidenceFailures(results).length > 0;
}

function shouldFailBenchmark(results: CaseResult[], options: { allowFailures: boolean }): boolean {
  return (
    hasInvalidBenchmarkEvidence(results) ||
    (!options.allowFailures && hasBenchmarkFailures(results))
  );
}

function printBenchmarkEvidenceFailures(failures: BenchmarkEvidenceFailure[]): void {
  for (const failure of failures) {
    const sample = failure.sampleIndex === null ? "" : ` sample ${failure.sampleIndex}`;
    console.error(
      `[gateway-restart-bench] ${failure.id}${sample}: ${failure.reason}; benchmark evidence is incomplete`,
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    printUsage();
    return;
  }

  ensureSupportedRestartPlatform();
  const options = parseOptions(argv);
  const results: CaseResult[] = [];
  for (const benchCase of options.cases) {
    results.push(
      await runCase({
        benchCase,
        entry: options.entry,
        postReadyDelayMs: options.postReadyDelayMs,
        restarts: options.restarts,
        runs: options.runs,
        timeoutMs: options.timeoutMs,
        warmup: options.warmup,
      }),
    );
  }

  const payload = {
    entry: options.entry,
    generatedAt: new Date().toISOString(),
    node: process.version,
    platform: {
      arch: process.arch,
      platform: process.platform,
    },
    results,
  };
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(payload, null, 2)}\n`);
  }
  const evidenceFailures = collectBenchmarkEvidenceFailures(results);
  if (evidenceFailures.length > 0) {
    printBenchmarkEvidenceFailures(evidenceFailures);
  }
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    if (shouldFailBenchmark(results, options)) {
      process.exitCode = 1;
    }
    return;
  }
  for (const result of results) {
    printResult(result);
  }
  if (shouldFailBenchmark(results, options)) {
    process.exitCode = 1;
  }
}

export const testing = {
  classifyGatewayReadyLog,
  classifyProbeErrorKind,
  collectOutputLines,
  collectTraceLine,
  countLsofFileDescriptors,
  computeResourceSlope,
  createRestartIteration,
  ensureSupportedRestartPlatform,
  finalizeRestartIteration,
  flushOutputLineBuffers,
  collectBenchmarkEvidenceFailures,
  hasInitialReadyLogs,
  hasBenchmarkFailures,
  hasInvalidBenchmarkEvidence,
  parseNonNegativeInt,
  parseOptions,
  parsePositiveInt,
  resolveRestartDeadlineFailure,
  resolveEntry,
  resolvePhaseDeadlineAt,
  resolveSampleExitFailure,
  sanitizedEnv,
  shouldFailBenchmark,
  stopChild,
  summarizeCase,
  waitForRestartProbe,
  writeConfig,
  writeRestartIntent,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
export { testing as __testing };
