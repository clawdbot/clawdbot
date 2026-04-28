import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

type GatewayBenchCase = {
  config: Record<string, unknown>;
  env?: Record<string, string>;
  id: string;
  name: string;
  pluginActivationOnStartup?: boolean;
  pluginCount?: number;
};

type ProbeResult = {
  ms: number | null;
  status: number | null;
};

type GatewaySample = {
  exitCode: number | null;
  firstOutputMs: number | null;
  healthz: ProbeResult;
  maxRssMb: number | null;
  outputTail: string;
  readyLogMs: number | null;
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
    healthzMs: SummaryStats | null;
    maxRssMb: SummaryStats | null;
    readyLogMs: SummaryStats | null;
    readyzMs: SummaryStats | null;
    startupTrace: Record<string, SummaryStats>;
  };
};

type CliOptions = {
  cases: GatewayBenchCase[];
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
    pluginCount: 50,
    config: BASE_CONFIG,
  },
  {
    id: "fiftyPluginsFutureStrict",
    name: "gateway, 50 manifest plugins with legacy startup fallback disabled",
    env: {
      OPENCLAW_DISABLE_LEGACY_IMPLICIT_STARTUP_SIDECARS: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
    },
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

function parseFlagValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseRepeatableFlag(flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < process.argv.length; index += 1) {
    if (process.argv[index] === flag && process.argv[index + 1]) {
      values.push(process.argv[index + 1]);
    }
  }
  return values;
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function resolveCases(caseIds: string[]): GatewayBenchCase[] {
  if (caseIds.length === 0) {
    return [...GATEWAY_CASES];
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

function parseOptions(): CliOptions {
  return {
    cases: resolveCases(parseRepeatableFlag("--case")),
    entry: parseFlagValue("--entry") ?? DEFAULT_ENTRY,
    json: hasFlag("--json"),
    output: parseFlagValue("--output"),
    runs: parsePositiveInt(parseFlagValue("--runs"), DEFAULT_RUNS),
    timeoutMs: parsePositiveInt(parseFlagValue("--timeout-ms"), DEFAULT_TIMEOUT_MS),
    warmup: parsePositiveInt(parseFlagValue("--warmup"), DEFAULT_WARMUP),
  };
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
      healthzMs: summarizeNumbers(
        samples
          .map((sample) => sample.healthz.ms)
          .filter((value): value is number => typeof value === "number"),
      ),
      maxRssMb: summarizeNumbers(
        samples
          .map((sample) => sample.maxRssMb)
          .filter((value): value is number => typeof value === "number"),
      ),
      readyLogMs: summarizeNumbers(
        samples
          .map((sample) => sample.readyLogMs)
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

async function waitForProbe(params: {
  deadlineAt: number;
  isDone?: () => boolean;
  path: string;
  port: number;
  startAt: number;
}): Promise<ProbeResult> {
  let lastStatus: number | null = null;
  while (performance.now() < params.deadlineAt) {
    if (params.isDone?.()) {
      break;
    }
    const status = await requestStatus(params.port, params.path).catch(() => null);
    lastStatus = status;
    if (status === 200) {
      return { ms: performance.now() - params.startAt, status };
    }
    await delay(25);
  }
  return { ms: null, status: lastStatus };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writePluginFixtures(root: string, count: number, activationOnStartup?: boolean): string[] {
  const files: string[] = [];
  const pluginsDir = path.join(root, "plugins");
  mkdirSync(pluginsDir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    const id = `bench-plugin-${String(index + 1).padStart(2, "0")}`;
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
    files.push(entry);
  }
  return files;
}

function writeConfig(root: string, benchCase: GatewayBenchCase): string {
  const pluginPaths = benchCase.pluginCount
    ? writePluginFixtures(root, benchCase.pluginCount, benchCase.pluginActivationOnStartup)
    : [];
  const config = {
    ...benchCase.config,
    plugins: {
      ...(benchCase.config.plugins as Record<string, unknown> | undefined),
      ...(pluginPaths.length > 0
        ? {
            load: { paths: pluginPaths },
            allow: pluginPaths.map((file) => path.basename(path.dirname(file))),
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
    OPENCLAW_LOCAL_CHECK: "0",
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_TEST_DISABLE_UPDATE_CHECK: "1",
    ...benchCase.env,
  };
  return env;
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<{
  exitCode: number | null;
  signal: string | null;
}> {
  if (child.exitCode != null || child.signalCode != null) {
    return { exitCode: child.exitCode, signal: child.signalCode };
  }
  const exited = new Promise<{ exitCode: number | null; signal: string | null }>((resolve) => {
    child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  killProcessTree(child, "SIGTERM");
  const timeout = delay(2000).then(() => {
    if (child.exitCode == null && child.signalCode == null) {
      killProcessTree(child, "SIGKILL");
    }
    return exited;
  });
  return Promise.race([exited, timeout]);
}

function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child below.
    }
  }
  child.kill(signal);
}

function collectStartupTrace(line: string, startupTrace: Record<string, number>): void {
  const phaseMatch = /startup trace: ([^ ]+) ([0-9.]+)ms total=([0-9.]+)ms(?: (.*))?/u.exec(line);
  if (phaseMatch) {
    startupTrace[phaseMatch[1]] = Number(phaseMatch[2]);
    startupTrace[`${phaseMatch[1]}.total`] = Number(phaseMatch[3]);
    for (const metric of parseStartupTraceMetrics(phaseMatch[4] ?? "")) {
      startupTrace[`${phaseMatch[1]}.${metric.key}`] = metric.value;
    }
    return;
  }
  const detailMatch = /startup trace: ([^ ]+) (.*)/u.exec(line);
  if (!detailMatch) {
    return;
  }
  for (const metric of parseStartupTraceMetrics(detailMatch[2])) {
    startupTrace[`${detailMatch[1]}.${metric.key}`] = metric.value;
  }
}

function hasGatewayReadyLog(line: string): boolean {
  return /\[gateway\] (?:http server listening|ready \()/.test(line);
}

function parseStartupTraceMetrics(raw: string): Array<{ key: string; value: number }> {
  const metrics: Array<{ key: string; value: number }> = [];
  for (const part of raw.trim().split(/\s+/u)) {
    const metricMatch = /^([A-Za-z][A-Za-z0-9]*)=([0-9.]+)(?:ms)?$/u.exec(part);
    if (!metricMatch) {
      continue;
    }
    const key = metricMatch[1];
    const value = Number(metricMatch[2]);
    if (!Number.isFinite(value) || (key !== "eventLoopMax" && !key.endsWith("Ms"))) {
      continue;
    }
    metrics.push({ key, value });
  }
  return metrics;
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

async function runGatewaySample(options: {
  benchCase: GatewayBenchCase;
  entry: string;
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
  let maxRssMb: number | null = null;
  let readyLogMs: number | null = null;
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
    { cwd: process.cwd(), detached: process.platform !== "win32", env },
  );
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
      if (hasGatewayReadyLog(line) && readyLogMs == null) {
        readyLogMs = performance.now() - startAt;
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
  const exit = await stopChild(child);
  clearInterval(rssTimer);
  sampleRss();
  await childExitPromise.catch(() => null);
  rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });

  return {
    exitCode: exit.exitCode,
    firstOutputMs,
    healthz,
    maxRssMb,
    outputTail: output.join("").split(/\r?\n/u).slice(-20).join("\n"),
    readyLogMs,
    readyz,
    signal: exit.signal,
    startupTrace,
  };
}

async function runCase(options: {
  benchCase: GatewayBenchCase;
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
      entry: options.entry,
      timeoutMs: options.timeoutMs,
    });
    if (index >= options.warmup) {
      samples.push(sample);
      console.log(
        `[gateway-startup-bench] ${options.benchCase.id} run ${samples.length}/${options.runs}: healthz=${formatMs(sample.healthz.ms)} readyz=${formatMs(sample.readyz.ms)} readyLog=${formatMs(sample.readyLogMs)} rss=${formatMb(sample.maxRssMb)}`,
      );
    } else {
      console.log(
        `[gateway-startup-bench] ${options.benchCase.id} warmup ${index + 1}/${options.warmup}: healthz=${formatMs(sample.healthz.ms)} readyz=${formatMs(sample.readyz.ms)} rss=${formatMb(sample.maxRssMb)}`,
      );
    }
  }
  return summarizeCase(options.benchCase, samples);
}

function printResult(result: CaseResult): void {
  console.log(`\n${result.name} (${result.id})`);
  console.log(`  first output: ${formatStats(result.summary.firstOutputMs)}`);
  console.log(`  /healthz:     ${formatStats(result.summary.healthzMs)}`);
  console.log(`  ready log:    ${formatStats(result.summary.readyLogMs)}`);
  console.log(`  /readyz:      ${formatStats(result.summary.readyzMs)}`);
  console.log(`  max RSS:      ${formatMemoryStats(result.summary.maxRssMb)}`);
  const trace = Object.entries(result.summary.startupTrace)
    .filter(([name]) => !name.endsWith(".total"))
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
  const options = parseOptions();
  const results: CaseResult[] = [];
  for (const benchCase of options.cases) {
    results.push(
      await runCase({
        benchCase,
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
    return;
  }
  for (const result of results) {
    printResult(result);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exitCode = 1;
});
