// Bench Gateway Startup script supports OpenClaw repository automation.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import { parseStrictIntegerOption } from "./lib/dev-tooling-safety.ts";
import { delay, stopChild } from "./lib/gateway-bench-child.ts";
import {
  getFreePort,
  parseProcessRssKb,
  readProcessRssMb,
  readProcessTreeCpuMs,
  requestProbeStatus,
} from "./lib/gateway-bench-probes.ts";

type GatewayBenchCase = {
  config: Record<string, unknown>;
  env?: Record<string, string>;
  id: string;
  name: string;
  pluginActivationOnStartup?: boolean;
  pluginCount?: number;
};

type ProbeResult = {
  firstErrorKind: string | null;
  firstRecoveryMs: number | null;
  ms: number | null;
  status: number | null;
  transitions: ProbeTransition[];
};

type ProbeTransition = {
  errorKind?: string;
  ms: number;
  status: number | null;
};

type GatewaySample = {
  cpuCoreRatio: number | null;
  cpuMs: number | null;
  exitedBeforeTeardown?: boolean;
  exitCode: number | null;
  firstOutputMs: number | null;
  gatewayReadyLogLine: string | null;
  gatewayReadyLogMs: number | null;
  healthz: ProbeResult;
  httpListenLogLine: string | null;
  httpListenLogMs: number | null;
  maxRssMb: number | null;
  outputTail: string;
  readyz: ProbeResult;
  signal: string | null;
  startupTrace: Record<string, number>;
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
  samples: GatewaySample[];
  summary: {
    firstOutputMs: SummaryStats | null;
    cpuCoreRatio: SummaryStats | null;
    cpuMs: SummaryStats | null;
    gatewayReadyLogMs: SummaryStats | null;
    healthzMs: SummaryStats | null;
    httpListenLogMs: SummaryStats | null;
    maxRssMb: SummaryStats | null;
    readyzMs: SummaryStats | null;
    startupTrace: Record<string, SummaryStats>;
  };
};

type BenchmarkFailure = {
  id: string;
  reason: string;
  sampleIndex: number;
};

type PluginFixtureResult = {
  pluginIds: string[];
  pluginsDir: string;
};

type CliOptions = {
  cases: GatewayBenchCase[];
  cpuProfDir?: string;
  entry: string;
  json: boolean;
  output?: string;
  runs: number;
  timeoutMs: number;
  warmup: number;
};

const DEFAULT_RUNS = 5;
const DEFAULT_WARMUP = 1;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_ENTRY = "dist/entry.js";
const BOOLEAN_FLAGS = new Set(["--help", "-h", "--json"]);
const VALUE_FLAGS = new Set([
  "--case",
  "--cpu-prof-dir",
  "--entry",
  "--output",
  "--runs",
  "--timeout-ms",
  "--warmup",
]);

class CliArgumentError extends Error {
  override name = "CliArgumentError";
}

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
    id: "default",
    name: "gateway default",
    config: BASE_CONFIG,
  },
  {
    id: "skipChannels",
    name: "gateway, skip channels",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    config: BASE_CONFIG,
  },
  {
    id: "oneInternalHook",
    name: "gateway, one configured internal hook",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    config: {
      ...BASE_CONFIG,
      hooks: {
        internal: {
          entries: {
            "session-memory": { enabled: true },
          },
        },
      },
    },
  },
  {
    id: "allInternalHooks",
    name: "gateway, all internal hooks",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    config: {
      ...BASE_CONFIG,
      hooks: {
        internal: {
          enabled: true,
        },
      },
    },
  },
  {
    id: "fiftyPlugins",
    name: "gateway, 50 manifest plugins",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    pluginActivationOnStartup: true,
    pluginCount: 50,
    config: BASE_CONFIG,
  },
  {
    id: "fiftyStartupLazyPlugins",
    name: "gateway, 50 startup-lazy manifest plugins",
    env: { OPENCLAW_SKIP_CHANNELS: "1" },
    pluginActivationOnStartup: false,
    pluginCount: 50,
    config: BASE_CONFIG,
  },
] as const;

function readRequiredFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new CliArgumentError(`${flag} requires a value`);
  }
  return value;
}

function validateCliArgs(argv: string[]): void {
  const seenSingleValueFlags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (BOOLEAN_FLAGS.has(arg)) {
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      if (arg !== "--case") {
        if (seenSingleValueFlags.has(arg)) {
          throw new CliArgumentError(`${arg} was provided more than once`);
        }
        seenSingleValueFlags.add(arg);
      }
      readRequiredFlagValue(argv, index, arg);
      index += 1;
      continue;
    }
    throw new CliArgumentError(`Unknown argument: ${arg}`);
  }
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
    return [...GATEWAY_CASES];
  }
  const seenIds = new Set<string>();
  for (const id of caseIds) {
    if (seenIds.has(id)) {
      throw new CliArgumentError(`Duplicate --case "${id}"`);
    }
    seenIds.add(id);
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
  validateCliArgs(argv);
  return {
    cases: resolveCases(parseRepeatableFlag(argv, "--case")),
    cpuProfDir: parseFlagValue(argv, "--cpu-prof-dir"),
    entry: resolveEntry(parseFlagValue(argv, "--entry")),
    json: hasFlag(argv, "--json"),
    output: resolveOutputPath(parseFlagValue(argv, "--output")),
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
  console.log(`OpenClaw Gateway startup benchmark

Usage:
  pnpm test:startup:gateway -- [options]
  node --import tsx scripts/bench-gateway-startup.ts [options]

Options:
  --case <id>          Specific case id to run; repeatable
  --entry <path>       Gateway CLI entry file (default: ${DEFAULT_ENTRY})
  --runs <n>           Measured runs per case (default: ${DEFAULT_RUNS})
  --warmup <n>         Warmup runs per case (default: ${DEFAULT_WARMUP})
  --timeout-ms <ms>    Per-run timeout (default: ${DEFAULT_TIMEOUT_MS})
  --cpu-prof-dir <dir> Write one V8 CPU profile per run
  --output <path>      Write machine-readable JSON to a file
  --json               Emit machine-readable JSON
  --help, -h           Show this text

Case ids:
  ${GATEWAY_CASES.map((benchCase) => `${benchCase.id} (${benchCase.name})`).join("\n  ")}
`);
}

function median(values: number[]): number {
  const sorted = [...values].toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (
      (expectDefined(sorted[middle - 1], "lower middle gateway startup sample") +
        expectDefined(sorted[middle], "upper middle gateway startup sample")) /
      2
    );
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

function summarizeCase(benchCase: GatewayBenchCase, samples: GatewaySample[]): CaseResult {
  const startupTraceKeys = new Set<string>();
  for (const sample of samples) {
    for (const key of Object.keys(sample.startupTrace)) {
      startupTraceKeys.add(key);
    }
  }
  const startupTrace: Record<string, SummaryStats> = {};
  for (const key of [...startupTraceKeys].toSorted()) {
    const stats = summarizeNumbers(
      samples
        .map((sample) => sample.startupTrace[key])
        .filter((value): value is number => typeof value === "number"),
    );
    if (stats) {
      startupTrace[key] = stats;
    }
  }
  return {
    id: benchCase.id,
    name: benchCase.name,
    samples,
    summary: {
      firstOutputMs: summarizeNumbers(
        samples
          .map((sample) => sample.firstOutputMs)
          .filter((value): value is number => typeof value === "number"),
      ),
      cpuCoreRatio: summarizeNumbers(
        samples
          .map((sample) => sample.cpuCoreRatio)
          .filter((value): value is number => typeof value === "number"),
      ),
      cpuMs: summarizeNumbers(
        samples
          .map((sample) => sample.cpuMs)
          .filter((value): value is number => typeof value === "number"),
      ),
      gatewayReadyLogMs: summarizeNumbers(
        samples
          .map((sample) => sample.gatewayReadyLogMs)
          .filter((value): value is number => typeof value === "number"),
      ),
      healthzMs: summarizeNumbers(
        samples
          .map((sample) => sample.healthz.ms)
          .filter((value): value is number => typeof value === "number"),
      ),
      httpListenLogMs: summarizeNumbers(
        samples
          .map((sample) => sample.httpListenLogMs)
          .filter((value): value is number => typeof value === "number"),
      ),
      maxRssMb: summarizeNumbers(
        samples
          .map((sample) => sample.maxRssMb)
          .filter((value): value is number => typeof value === "number"),
      ),
      readyzMs: summarizeNumbers(
        samples
          .map((sample) => sample.readyz.ms)
          .filter((value): value is number => typeof value === "number"),
      ),
      startupTrace,
    },
  };
}

function collectResultFailures(
  results: CaseResult[],
  options: { processMetricsRequired?: boolean } = {},
): BenchmarkFailure[] {
  const processMetricsRequired = options.processMetricsRequired ?? process.platform !== "win32";
  const failures: BenchmarkFailure[] = [];
  for (const result of results) {
    result.samples.forEach((sample, index) => {
      const missing: string[] = [];
      if (sample.healthz.status !== 200 || sample.healthz.ms == null) {
        missing.push("/healthz");
      }
      if (sample.readyz.status !== 200 || sample.readyz.ms == null) {
        missing.push("/readyz");
      }
      if (processMetricsRequired) {
        if (sample.cpuMs == null || sample.cpuCoreRatio == null) {
          missing.push("cpu");
        }
        if (sample.maxRssMb == null) {
          missing.push("rss");
        }
      }
      if (missing.length > 0) {
        failures.push({
          id: result.id,
          reason: `missing ${missing.join(", ")}`,
          sampleIndex: index + 1,
        });
        return;
      }
      if (sample.exitedBeforeTeardown === true) {
        failures.push({
          id: result.id,
          reason:
            sample.signal == null
              ? `child exited ${sample.exitCode ?? "before teardown"}`
              : `child exited by ${sample.signal}`,
          sampleIndex: index + 1,
        });
      }
    });
  }
  return failures;
}

function printBenchmarkFailures(failures: BenchmarkFailure[]): void {
  if (failures.length === 0) {
    return;
  }
  console.error(
    `[gateway-startup-bench] failed: ${failures.length} sample(s) did not produce ready probes or process metrics`,
  );
  for (const failure of failures.slice(0, 8)) {
    console.error(
      `[gateway-startup-bench] ${failure.id} run ${failure.sampleIndex}: ${failure.reason}`,
    );
  }
  if (failures.length > 8) {
    console.error(`[gateway-startup-bench] ${failures.length - 8} more sample failure(s) omitted`);
  }
}

function formatMs(value: number | null): string {
  if (value == null) {
    return "n/a";
  }
  return `${value.toFixed(1)}ms`;
}

function formatMb(value: number | null): string {
  if (value == null) {
    return "n/a";
  }
  return `${value.toFixed(1)}MB`;
}

function formatRatio(value: number | null): string {
  if (value == null) {
    return "n/a";
  }
  return value.toFixed(3);
}

function formatStats(stats: SummaryStats | null): string {
  if (!stats) {
    return "n/a";
  }
  return `p50=${formatMs(stats.p50)} avg=${formatMs(stats.avg)} min=${formatMs(stats.min)} max=${formatMs(stats.max)}`;
}

function formatMemoryStats(stats: SummaryStats | null): string {
  if (!stats) {
    return "n/a";
  }
  return `p50=${formatMb(stats.p50)} avg=${formatMb(stats.avg)} min=${formatMb(stats.min)} max=${formatMb(stats.max)}`;
}

function formatRatioStats(stats: SummaryStats | null): string {
  if (!stats) {
    return "n/a";
  }
  return `p50=${formatRatio(stats.p50)} avg=${formatRatio(stats.avg)} min=${formatRatio(stats.min)} max=${formatRatio(stats.max)}`;
}

function getStartupTraceStat(
  startupTrace: Record<string, SummaryStats>,
  key: string,
): SummaryStats | null {
  return startupTrace[key] ?? null;
}

async function waitForProbe(params: {
  deadlineAt: number;
  isDone?: () => boolean;
  path: string;
  port: number;
  startAt: number;
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
    const now = performance.now();
    const elapsedMs = now - params.startAt;
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
        firstErrorKind,
        firstRecoveryMs,
        ms: elapsedMs,
        status: attempt.status,
        transitions,
      };
    }
    await delay(25);
  }
  return { firstErrorKind, firstRecoveryMs, ms: null, status: lastStatus, transitions };
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
    const entry = path.join(pluginDir, "index.cjs");
    writeFileSync(entry, `module.exports = { id: ${JSON.stringify(id)}, register() {} };\n`);
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
            load: { paths: [pluginFixtures.pluginsDir] },
            allow: pluginFixtures.pluginIds,
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
  const env: NodeJS.ProcessEnv = {
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
    OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
    OPENCLAW_HOME: root,
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_TEST_DISABLE_UPDATE_CHECK: "1",
    ...benchCase.env,
  };
  return env;
}

function collectStartupTrace(line: string, startupTrace: Record<string, number>): void {
  const phaseMatch = /startup trace: ([^ ]+) ([0-9.]+)ms total=([0-9.]+)ms(?: (.*))?/u.exec(line);
  if (phaseMatch) {
    const phase = expectDefined(phaseMatch[1], "gateway startup trace phase name");
    startupTrace[phase] = Number(expectDefined(phaseMatch[2], `${phase} startup duration`));
    startupTrace[`${phase}.total`] = Number(
      expectDefined(phaseMatch[3], `${phase} total startup duration`),
    );
    for (const metric of parseStartupTraceMetrics(phaseMatch[4] ?? "")) {
      startupTrace[`${phase}.${metric.key}`] = metric.value;
    }
    return;
  }
  const detailMatch = /startup trace: ([^ ]+) (.*)/u.exec(line);
  if (!detailMatch) {
    return;
  }
  const phase = expectDefined(detailMatch[1], "gateway startup detail phase name");
  const detail = expectDefined(detailMatch[2], `${phase} startup detail metrics`);
  for (const metric of parseStartupTraceMetrics(detail)) {
    startupTrace[`${phase}.${metric.key}`] = metric.value;
  }
}

function classifyGatewayReadyLog(line: string): "gateway-ready" | "http-listen" | null {
  if (line.includes("[gateway] http server listening (")) {
    return "http-listen";
  }
  if (/\[gateway\] ready(?:\s*\(|\s*$)/.test(line)) {
    return "gateway-ready";
  }
  return null;
}

function parseStartupTraceMetrics(raw: string): Array<{ key: string; value: number }> {
  const metrics: Array<{ key: string; value: number }> = [];
  for (const part of raw.trim().split(/\s+/u)) {
    const metricMatch = /^([A-Za-z][A-Za-z0-9]*)=([0-9.]+)(?:ms)?$/u.exec(part);
    if (!metricMatch) {
      continue;
    }
    const key = expectDefined(metricMatch[1], "gateway startup trace metric key");
    const value = Number(expectDefined(metricMatch[2], `${key} startup trace metric value`));
    if (
      !Number.isFinite(value) ||
      (key !== "eventLoopMax" &&
        !key.endsWith("Ms") &&
        !key.endsWith("Mb") &&
        !key.endsWith("Count"))
    ) {
      continue;
    }
    metrics.push({ key, value });
  }
  return metrics;
}

async function runGatewaySample(options: {
  benchCase: GatewayBenchCase;
  cpuProfDir?: string;
  entry: string;
  sampleIndex: number;
  timeoutMs: number;
}): Promise<GatewaySample> {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-gateway-bench-"));
  const port = await getFreePort();
  const configPath = writeConfig(root, options.benchCase);
  const env = sanitizedEnv(root, configPath, options.benchCase);
  const startAt = performance.now();
  const deadlineAt = startAt + options.timeoutMs;
  const startupTrace: Record<string, number> = {};
  const output: string[] = [];
  let firstOutputMs: number | null = null;
  let gatewayReadyLogLine: string | null = null;
  let gatewayReadyLogMs: number | null = null;
  let httpListenLogLine: string | null = null;
  let httpListenLogMs: number | null = null;
  let maxRssMb: number | null = null;
  let childExited = false;

  const childArgs = [
    ...(options.cpuProfDir
      ? [
          "--cpu-prof",
          "--cpu-prof-dir",
          options.cpuProfDir,
          "--cpu-prof-name",
          `openclaw-gateway-${options.benchCase.id}-${options.sampleIndex}-${Date.now()}.cpuprofile`,
        ]
      : []),
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
  ];
  const child = spawn(process.execPath, childArgs, {
    cwd: process.cwd(),
    detached: process.platform !== "win32",
    env,
  });
  const cpuStartMs = readProcessTreeCpuMs(child.pid);
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
        resolve({ exitCode, signal });
      });
    },
  );

  const onChunk = (chunk: Buffer) => {
    if (firstOutputMs == null) {
      firstOutputMs = performance.now() - startAt;
    }
    const text = chunk.toString("utf8");
    output.push(text);
    if (output.length > 20) {
      output.splice(0, output.length - 20);
    }
    for (const line of text.split(/\r?\n/u)) {
      const readyLogKind = classifyGatewayReadyLog(line);
      if (readyLogKind === "http-listen" && httpListenLogMs == null) {
        httpListenLogMs = performance.now() - startAt;
        httpListenLogLine = line;
      }
      if (readyLogKind === "gateway-ready" && gatewayReadyLogMs == null) {
        gatewayReadyLogMs = performance.now() - startAt;
        gatewayReadyLogLine = line;
      }
      collectStartupTrace(line, startupTrace);
    }
  };
  child.stdout.on("data", onChunk);
  child.stderr.on("data", onChunk);

  const [healthz, readyz] = await Promise.all([
    waitForProbe({
      deadlineAt,
      isDone: () => childExited,
      path: "/healthz",
      port,
      startAt,
    }),
    waitForProbe({
      deadlineAt,
      isDone: () => childExited,
      path: "/readyz",
      port,
      startAt,
    }),
  ]);
  const readyAt = performance.now();
  const cpuEndMs = readProcessTreeCpuMs(child.pid);
  const cpuMs = cpuStartMs == null || cpuEndMs == null ? null : Math.max(0, cpuEndMs - cpuStartMs);
  const cpuCoreRatio = cpuMs == null ? null : cpuMs / Math.max(1, readyAt - startAt);
  const exit = await stopChild(child);
  clearInterval(rssTimer);
  sampleRss();
  // stopChild is the bounded teardown wait; the raw exit promise may never settle.
  void childExitPromise.catch(() => null);
  rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });

  return {
    cpuCoreRatio,
    cpuMs,
    exitedBeforeTeardown: exit.exitedBeforeTeardown,
    exitCode: exit.exitCode,
    firstOutputMs,
    gatewayReadyLogLine,
    gatewayReadyLogMs,
    healthz,
    httpListenLogLine,
    httpListenLogMs,
    maxRssMb,
    outputTail: output.join("").split(/\r?\n/u).slice(-20).join("\n"),
    readyz,
    signal: exit.signal,
    startupTrace,
  };
}

async function runCase(options: {
  benchCase: GatewayBenchCase;
  cpuProfDir?: string;
  entry: string;
  runs: number;
  timeoutMs: number;
  warmup: number;
}): Promise<CaseResult> {
  const samples: GatewaySample[] = [];
  const total = options.runs + options.warmup;
  for (let index = 0; index < total; index += 1) {
    const sample = await runGatewaySample({
      benchCase: options.benchCase,
      cpuProfDir: options.cpuProfDir,
      entry: options.entry,
      sampleIndex: index + 1,
      timeoutMs: options.timeoutMs,
    });
    if (index >= options.warmup) {
      samples.push(sample);
      const heapUsedMb = sample.startupTrace["memory.ready.heapUsedMb"] ?? null;
      console.log(
        `[gateway-startup-bench] ${options.benchCase.id} run ${samples.length}/${options.runs}: healthz=${formatMs(sample.healthz.ms)} readyz=${formatMs(sample.readyz.ms)} httpListen=${formatMs(sample.httpListenLogMs)} gatewayReady=${formatMs(sample.gatewayReadyLogMs)} cpu=${formatMs(sample.cpuMs)} cpuCore=${formatRatio(sample.cpuCoreRatio)} rss=${formatMb(sample.maxRssMb)} heap=${formatMb(heapUsedMb)}`,
      );
    } else {
      const heapUsedMb = sample.startupTrace["memory.ready.heapUsedMb"] ?? null;
      console.log(
        `[gateway-startup-bench] ${options.benchCase.id} warmup ${index + 1}/${options.warmup}: healthz=${formatMs(sample.healthz.ms)} readyz=${formatMs(sample.readyz.ms)} cpu=${formatMs(sample.cpuMs)} cpuCore=${formatRatio(sample.cpuCoreRatio)} rss=${formatMb(sample.maxRssMb)} heap=${formatMb(heapUsedMb)}`,
      );
    }
  }
  return summarizeCase(options.benchCase, samples);
}

function printResult(result: CaseResult): void {
  console.log(`\n${result.name} (${result.id})`);
  console.log(`  first output: ${formatStats(result.summary.firstOutputMs)}`);
  console.log(`  CPU:          ${formatStats(result.summary.cpuMs)}`);
  console.log(`  CPU core:     ${formatRatioStats(result.summary.cpuCoreRatio)}`);
  console.log(`  /healthz:     ${formatStats(result.summary.healthzMs)}`);
  console.log(`  http listen:  ${formatStats(result.summary.httpListenLogMs)}`);
  console.log(`  gateway ready: ${formatStats(result.summary.gatewayReadyLogMs)}`);
  console.log(`  /readyz:      ${formatStats(result.summary.readyzMs)}`);
  console.log(`  max RSS:      ${formatMemoryStats(result.summary.maxRssMb)}`);
  console.log(
    `  ready memory: rss=${formatMemoryStats(getStartupTraceStat(result.summary.startupTrace, "memory.ready.rssMb"))} heap=${formatMemoryStats(getStartupTraceStat(result.summary.startupTrace, "memory.ready.heapUsedMb"))} external=${formatMemoryStats(getStartupTraceStat(result.summary.startupTrace, "memory.ready.externalMb"))}`,
  );
  console.log(
    `  post-ready memory: rss=${formatMemoryStats(getStartupTraceStat(result.summary.startupTrace, "memory.post-ready.rssMb"))} heap=${formatMemoryStats(getStartupTraceStat(result.summary.startupTrace, "memory.post-ready.heapUsedMb"))} external=${formatMemoryStats(getStartupTraceStat(result.summary.startupTrace, "memory.post-ready.externalMb"))}`,
  );
  const trace = Object.entries(result.summary.startupTrace)
    .filter(([name]) => !name.endsWith(".total") && !name.startsWith("memory."))
    .toSorted((a, b) => (b[1].avg ?? 0) - (a[1].avg ?? 0))
    .slice(0, 8);
  if (trace.length > 0) {
    console.log("  trace top:");
    for (const [name, stats] of trace) {
      console.log(`    ${name}: ${formatStats(stats)}`);
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    printUsage();
    return;
  }

  const options = parseOptions(argv);
  if (options.cpuProfDir) {
    mkdirSync(options.cpuProfDir, { recursive: true });
  }
  const results: CaseResult[] = [];
  for (const benchCase of options.cases) {
    results.push(
      await runCase({
        benchCase,
        cpuProfDir: options.cpuProfDir,
        entry: options.entry,
        runs: options.runs,
        timeoutMs: options.timeoutMs,
        warmup: options.warmup,
      }),
    );
  }

  const payload = {
    entry: options.entry,
    generatedAt: new Date().toISOString(),
    results,
  };
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(payload, null, 2)}\n`);
  }
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
  } else {
    for (const result of results) {
      printResult(result);
    }
  }

  const failures = collectResultFailures(results);
  if (failures.length > 0) {
    printBenchmarkFailures(failures);
    process.exitCode = 1;
  }
}

export const testing = {
  classifyGatewayReadyLog,
  collectResultFailures,
  collectStartupTrace,
  parseOptions,
  parseNonNegativeInt,
  parsePositiveInt,
  parseProcessRssKb,
  resolveEntry,
  sanitizedEnv,
  stopChild,
  summarizeCase,
  validateCliArgs,
  waitForProbe,
  writeConfig,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    if (err instanceof CliArgumentError) {
      console.error(err.message);
      process.exitCode = 1;
      return;
    }
    console.error(err instanceof Error ? err.stack : String(err));
    process.exitCode = 1;
  });
}
