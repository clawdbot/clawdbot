import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
// Bench Gateway Concurrency script measures gateway probes during synthetic streaming turns.
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";
import { asFiniteNumber } from "../packages/normalization-core/src/number-coercion.ts";
import { sliceUtf16Safe } from "../packages/normalization-core/src/utf16-slice.ts";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { delay, stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  CliArgumentError,
  createGatewayBenchEnv,
  hasFlag,
  hasHelpFlag,
  parseFlagValue,
  parseNonNegativeInt,
  parsePositiveInt,
  resolveEntry,
  resolveOutputPath,
  validateCliArgs,
  waitForInitialProbe,
  writeGatewayBenchConfig,
  writePluginFixtures,
} from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

type MetricSummary = {
  count: number;
  max: number;
  p50: number;
  p95: number;
  p99: number;
};

type TimedProbe = {
  atMs: number;
  error: string | null;
  latencyMs: number;
  ok: boolean;
};

type DiagnosticsTimelineSpan = {
  durationMs?: number;
  name?: string;
};

type ReadyProbe = TimedProbe & {
  cpuCoreRatio: number | null;
  degraded: boolean | null;
  degradedSinceMs: number | null;
  delayP99Ms: number | null;
  status: number;
  utilization: number | null;
};

type ControlUiProbe = TimedProbe & {
  status: number;
};

type GatewaySample = {
  controlUi: ControlUiProbe;
  readyz: ReadyProbe;
  sessionsList: TimedProbe;
};

type FreshConnectionProbe = {
  error: string | null;
  latencyMs: number;
  ok: boolean;
};

type GatewayRpc = <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>;

type BenchmarkRun = {
  controlUi: ControlUiProbe[];
  durationMs: number;
  freshConnection: FreshConnectionProbe;
  probeWarmup: {
    durationMs: number;
    samples: GatewaySample[];
  };
  pluginMetadataScans: ReturnType<typeof summarizePluginMetadataScans>;
  readyz: ReadyProbe[];
  sessionsList: TimedProbe[];
  turnCount: number;
  turnsDurationMs: number;
};

type CliOptions = {
  cadenceMs: number;
  concurrency: number;
  cpuProfDir?: string;
  entry: string;
  json: boolean;
  maxControlMs?: number;
  maxHandshakeMs?: number;
  output?: string;
  pluginCount: number;
  runs: number;
  timeoutMs: number;
  toolEvents: boolean;
  warmup: number;
  workspaceFanout: boolean;
};

const DEFAULT_CADENCE_MS = 100;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_ENTRY = "dist/entry.js";
const DEFAULT_RUNS = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_WARMUP = 0;
const MOCK_RESPONSE_CHUNK_DELAY_MS = 1_000;
const MAX_CONCURRENCY = 64;
const MAX_PLUGIN_COUNT = 100;
const MAX_RUNS = 20;
const MAX_WARMUP = 10;
const MAX_SAMPLES_PER_RUN = 2_048;
const MAX_HTTP_BODY_BYTES = 1_048_576;
const HTTP_TIMEOUT_MS = 20_000;
const PROBE_WARMUP_TIMEOUT_MS = 60_000;
const PROBE_WARMUP_TARGET_MS = 1_000;
const PROBE_WARMUP_RETRY_DELAY_MS = 100;
const GATEWAY_STDERR_TAIL_LINES = 20;
const AGENT_WAIT_RPC_GRACE_MS = 5_000;
const BOOLEAN_FLAGS = new Set(["--help", "-h", "--json", "--tool-events", "--workspace-fanout"]);
const VALUE_FLAGS = new Set([
  "--cadence-ms",
  "--concurrency",
  "--cpu-prof-dir",
  "--entry",
  "--max-control-ms",
  "--max-handshake-ms",
  "--output",
  "--plugin-count",
  "--runs",
  "--timeout-ms",
  "--warmup",
]);

function parseBoundedPositiveInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  max: number,
): number {
  const value = parsePositiveInt(raw, fallback, label);
  if (value > max) {
    throw new CliArgumentError(`${label} must be at most ${max}`);
  }
  return value;
}

function parseBoundedNonNegativeInt(
  raw: string | undefined,
  fallback: number,
  label: string,
  max: number,
): number {
  const value = parseNonNegativeInt(raw, fallback, label);
  if (value > max) {
    throw new CliArgumentError(`${label} must be at most ${max}`);
  }
  return value;
}

function parseOptions(argv: string[] = process.argv.slice(2)): CliOptions {
  validateCliArgs(argv, { booleanFlags: BOOLEAN_FLAGS, valueFlags: VALUE_FLAGS });
  return {
    cadenceMs: parseBoundedPositiveInt(
      parseFlagValue(argv, "--cadence-ms"),
      DEFAULT_CADENCE_MS,
      "--cadence-ms",
      5_000,
    ),
    concurrency: parseBoundedPositiveInt(
      parseFlagValue(argv, "--concurrency"),
      DEFAULT_CONCURRENCY,
      "--concurrency",
      MAX_CONCURRENCY,
    ),
    cpuProfDir: resolveOutputPath(parseFlagValue(argv, "--cpu-prof-dir")),
    entry: resolveEntry(parseFlagValue(argv, "--entry"), DEFAULT_ENTRY),
    json: hasFlag(argv, "--json"),
    maxControlMs: parseFlagValue(argv, "--max-control-ms")
      ? parseBoundedPositiveInt(
          parseFlagValue(argv, "--max-control-ms"),
          2_000,
          "--max-control-ms",
          30_000,
        )
      : undefined,
    maxHandshakeMs: parseFlagValue(argv, "--max-handshake-ms")
      ? parseBoundedPositiveInt(
          parseFlagValue(argv, "--max-handshake-ms"),
          2_000,
          "--max-handshake-ms",
          30_000,
        )
      : undefined,
    output: resolveOutputPath(parseFlagValue(argv, "--output")),
    pluginCount: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--plugin-count"),
      0,
      "--plugin-count",
      MAX_PLUGIN_COUNT,
    ),
    runs: parseBoundedPositiveInt(parseFlagValue(argv, "--runs"), DEFAULT_RUNS, "--runs", MAX_RUNS),
    timeoutMs: parseBoundedPositiveInt(
      parseFlagValue(argv, "--timeout-ms"),
      DEFAULT_TIMEOUT_MS,
      "--timeout-ms",
      10 * 60_000,
    ),
    toolEvents: hasFlag(argv, "--tool-events"),
    warmup: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--warmup"),
      DEFAULT_WARMUP,
      "--warmup",
      MAX_WARMUP,
    ),
    workspaceFanout: hasFlag(argv, "--workspace-fanout"),
  };
}

function printUsage(): void {
  console.log(`OpenClaw Gateway concurrency benchmark

Usage:
  pnpm test:gateway:concurrency -- [options]
  node scripts/bench-gateway-concurrency.ts [options]

Options:
  --concurrency <n>  Concurrent synthetic streaming turns (default: ${DEFAULT_CONCURRENCY})
  --cpu-prof-dir <p> Write Gateway V8 CPU profiles to this directory
  --runs <n>         Measured gateway runs (default: ${DEFAULT_RUNS})
  --warmup <n>       Warmup gateway runs (default: ${DEFAULT_WARMUP})
  --cadence-ms <ms>  Probe cadence (default: ${DEFAULT_CADENCE_MS})
  --timeout-ms <ms>  Per-run cap, excluding probe warmup (default: ${DEFAULT_TIMEOUT_MS})
  --entry <path>     Gateway CLI entry file (default: ${DEFAULT_ENTRY})
  --plugin-count <n> Configure synthetic plugins through plugins.load.paths (default: 0)
  --tool-events      Make every synthetic turn execute a tool before replying
  --workspace-fanout Bind each turn to a distinct workspace
  --max-control-ms   Fail when any load-phase health/control probe exceeds this bound
  --max-handshake-ms Fail when a fresh authenticated connection exceeds this bound
  --output <path>    Write machine-readable JSON to a file
  --json             Emit machine-readable JSON
  --help, -h         Show this text
`);
}

function percentile(sorted: readonly number[], percentileValue: number): number {
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

function summarizeNumbers(values: readonly number[]): MetricSummary | null {
  const sorted = values.filter(Number.isFinite).toSorted((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  return {
    count: sorted.length,
    max: sorted.at(-1) ?? 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

function summarizePluginMetadataScans(events: readonly DiagnosticsTimelineSpan[]) {
  const durations = events.flatMap((event) =>
    event.name === "plugins.metadata.scan" &&
    typeof event.durationMs === "number" &&
    Number.isFinite(event.durationMs)
      ? [event.durationMs]
      : [],
  );
  return {
    count: durations.length,
    durationMs: summarizeNumbers(durations),
    totalDurationMs: durations.reduce((sum, durationMs) => sum + durationMs, 0),
  };
}

function readDiagnosticsTimelineSpans(timelinePath: string): DiagnosticsTimelineSpan[] {
  try {
    return readFileSync(timelinePath, "utf8")
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const event = JSON.parse(line) as {
            durationMs?: unknown;
            name?: unknown;
            type?: unknown;
          };
          if (event.type !== "span.end" || typeof event.name !== "string") {
            return [];
          }
          return [
            {
              name: event.name,
              ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
            },
          ];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function remainingMs(deadlineAt: number): number {
  return Math.max(0, deadlineAt - performance.now());
}

function requireRemainingMs(deadlineAt: number, label: string): number {
  const remaining = remainingMs(deadlineAt);
  if (remaining <= 0) {
    throw new Error(`benchmark timed out while ${label}`);
  }
  return remaining;
}

async function requestHttp(params: {
  accept: string;
  deadlineAt: number;
  path: string;
  port: number;
}): Promise<{ body: string; latencyMs: number; status: number }> {
  const startedAt = performance.now();
  const requestDeadlineAt = Math.min(params.deadlineAt, startedAt + HTTP_TIMEOUT_MS);
  requireRemainingMs(requestDeadlineAt, `requesting ${params.path}`);
  return await new Promise((resolve, reject) => {
    let settled = false;
    const settle = (run: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      run();
    };
    const fail = (error: Error) =>
      settle(() => {
        req.destroy();
        reject(error);
      });
    const req = request(
      {
        headers: { accept: params.accept },
        host: "127.0.0.1",
        method: "GET",
        path: params.path,
        port: params.port,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_HTTP_BODY_BYTES) {
            fail(new Error(`${params.path} response exceeded ${MAX_HTTP_BODY_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.once("aborted", () => fail(new Error(`${params.path} response aborted`)));
        res.once("error", fail);
        res.once("end", () =>
          settle(() =>
            resolve({
              body: Buffer.concat(chunks).toString("utf8"),
              latencyMs: performance.now() - startedAt,
              status: res.statusCode ?? 0,
            }),
          ),
        );
      },
    );
    req.once("error", fail);
    // Request/socket timeouts measure inactivity; this timer owns the wall-clock deadline.
    const timer = setTimeout(
      () => fail(new Error(`${params.path} request timed out`)),
      Math.max(1, Math.ceil(remainingMs(requestDeadlineAt))),
    );
    timer.unref?.();
    req.end();
  });
}

function describeProbeError(error: unknown): string {
  return sliceUtf16Safe(error instanceof Error ? error.message : String(error), 0, 500);
}

function formatProbeResult(name: string, probe: TimedProbe & { status?: number }): string {
  const status = probe.status === undefined ? "n/a" : probe.status;
  return `${name}: ok=${probe.ok} status=${status} latencyMs=${probe.latencyMs.toFixed(1)} error=${probe.error ? JSON.stringify(probe.error) : "none"}`;
}

function formatProbeFailure(sample: GatewaySample): string {
  return [
    "gateway probes did not become fast and healthy before concurrent load",
    formatProbeResult("readyz", sample.readyz),
    formatProbeResult("sessionsList", sample.sessionsList),
    formatProbeResult("controlUi", sample.controlUi),
  ].join("\n  ");
}

function tailLines(output: string, lineCount: number): string {
  return output.trimEnd().split(/\r?\n/u).slice(-lineCount).join("\n");
}

function captureChildOutput(child: ChildProcessWithoutNullStreams): {
  readOutput: () => string;
  readStderrTail: () => string;
} {
  let output = "";
  let stderr = "";
  const appendOutput = (chunk: Buffer) => {
    output = sliceUtf16Safe(`${output}${chunk.toString("utf8")}`, -64 * 1_024);
  };
  child.stdout.on("data", appendOutput);
  child.stderr.on("data", (chunk: Buffer) => {
    appendOutput(chunk);
    stderr = sliceUtf16Safe(`${stderr}${chunk.toString("utf8")}`, -64 * 1_024);
  });
  return {
    readOutput: () => output,
    readStderrTail: () => tailLines(stderr, GATEWAY_STDERR_TAIL_LINES),
  };
}

function formatRunFailure(
  error: unknown,
  gatewayOutput: { readOutput: () => string; readStderrTail: () => string },
  mockOutput: { readOutput: () => string },
): string {
  return [
    error instanceof Error ? error.message : String(error),
    gatewayOutput.readStderrTail()
      ? `gateway stderr tail:\n${gatewayOutput.readStderrTail()}`
      : "gateway stderr tail: (empty)",
    gatewayOutput.readOutput() ? `gateway output tail:\n${gatewayOutput.readOutput()}` : "",
    mockOutput.readOutput() ? `mock provider output tail:\n${mockOutput.readOutput()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function waitForMockServer(port: number, deadlineAt: number): Promise<void> {
  let lastError: unknown;
  while (remainingMs(deadlineAt) > 0) {
    try {
      const result = await requestHttp({
        accept: "application/json",
        deadlineAt,
        path: "/health",
        port,
      });
      if (result.status === 200) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(Math.min(25, remainingMs(deadlineAt)));
  }
  const detail =
    lastError instanceof Error
      ? lastError.message
      : typeof lastError === "string"
        ? lastError
        : "timeout";
  throw new Error(`mock provider did not become healthy: ${detail}`);
}

async function waitForGatewayDispatchReady(
  readOutput: () => string,
  deadlineAt: number,
): Promise<void> {
  while (remainingMs(deadlineAt) > 0) {
    if (readOutput().includes("startup trace: sidecars.ready ")) {
      return;
    }
    await delay(Math.min(25, remainingMs(deadlineAt)));
  }
  throw new Error("gateway did not finish dispatch-ready sidecars");
}

function buildConfig(
  root: string,
  mockPort: number,
  concurrency: number,
  pluginCount: number,
): string {
  const controlUiRoot = path.join(root, "control-ui");
  mkdirSync(controlUiRoot, { recursive: true });
  copyFileSync(
    path.join(process.cwd(), "ui", "index.html"),
    path.join(controlUiRoot, "index.html"),
  );

  const config = structuredClone(BASE_GATEWAY_BENCH_CONFIG) as Record<string, unknown>;
  config.gateway = {
    ...(config.gateway as Record<string, unknown>),
    controlUi: { enabled: true, root: controlUiRoot },
  };
  applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gpt-5.6-luna" });
  const agents = config.agents as Record<string, unknown>;
  agents.defaults = {
    ...(agents.defaults as Record<string, unknown>),
    maxConcurrent: concurrency,
  };
  const pluginFixtures =
    pluginCount > 0 ? writePluginFixtures(root, { count: pluginCount }) : undefined;
  return writeGatewayBenchConfig(root, config, { pluginFixtures });
}

async function connectGateway(port: number, deadlineAt: number, subscribeSessions = true) {
  let requestDeadlineAt = deadlineAt;
  const client = createGatewayWsClient({
    handshakeTimeoutMs: Math.min(8_000, requireRemainingMs(deadlineAt, "connecting WebSocket")),
    openTimeoutMs: Math.min(8_000, requireRemainingMs(deadlineAt, "opening WebSocket")),
    url: `ws://127.0.0.1:${port}`,
  });
  await client.waitOpen();

  const requestRpc = async <T>(
    method: string,
    params: unknown,
    requestedTimeoutMs?: number,
  ): Promise<T> => {
    const response = await client.request(
      method,
      params,
      Math.max(
        1,
        Math.min(
          requestedTimeoutMs ?? 65_000,
          requireRemainingMs(requestDeadlineAt, `waiting for ${method}`),
        ),
      ),
    );
    if (!response.ok) {
      const message =
        response.error && typeof response.error === "object" && "message" in response.error
          ? String(response.error.message)
          : JSON.stringify(response.error);
      throw new Error(`${method} failed: ${message}`);
    }
    return response.payload as T;
  };

  await requestRpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "gateway-concurrency-benchmark",
      version: "1.0.0",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.write", "operator.admin"],
    caps: [],
  });
  if (subscribeSessions) {
    await requestRpc("sessions.subscribe", {});
  }
  return {
    close: client.close,
    request: requestRpc,
    setDeadlineAt: (value: number) => {
      requestDeadlineAt = value;
    },
  };
}

async function runTurn(
  rpc: GatewayRpc,
  index: number,
  deadlineAt: number,
  toolEvents = false,
  options?: { onStarted?: () => void; sessionKey?: string },
): Promise<void> {
  const requestedRunId = randomUUID();
  const started = await rpc<{ runId?: string; status?: string }>("agent", {
    sessionKey: options?.sessionKey ?? `agent:main:gateway-concurrency-${index + 1}`,
    message: toolEvents
      ? `OPENCLAW_E2E_DRAFTPROOF benchmark tool stream ${index + 1}.`
      : `Reply with benchmark stream ${index + 1}.`,
    deliver: false,
    idempotencyKey: requestedRunId,
  });
  options?.onStarted?.();
  if (started.status === "ok") {
    return;
  }
  if (started.status !== "accepted") {
    throw new Error(`agent ${index + 1} was not accepted: ${JSON.stringify(started)}`);
  }
  const remaining = requireRemainingMs(deadlineAt, `waiting for agent ${index + 1} completion`);
  const waitTimeoutMs = Math.max(
    0,
    Math.min(60_000, Math.floor(remaining - AGENT_WAIT_RPC_GRACE_MS)),
  );
  const rpcTimeoutMs = Math.min(65_000, Math.max(1, Math.ceil(remaining)));
  const completed = await rpc<{ status?: string }>(
    "agent.wait",
    {
      runId: started.runId ?? requestedRunId,
      timeoutMs: waitTimeoutMs,
    },
    rpcTimeoutMs,
  );
  if (completed.status !== "ok") {
    throw new Error(`agent ${index + 1} did not complete: ${JSON.stringify(completed)}`);
  }
}

async function sampleGateway(params: {
  deadlineAt: number;
  port: number;
  rpc: GatewayRpc;
  runStartedAt: number;
  serial?: boolean;
}): Promise<GatewaySample> {
  const atMs = performance.now() - params.runStartedAt;
  const safeHttpProbe = async (pathValue: string, accept: string) => {
    const startedAt = performance.now();
    try {
      return {
        ...(await requestHttp({
          accept,
          deadlineAt: params.deadlineAt,
          path: pathValue,
          port: params.port,
        })),
        error: null,
        ok: true,
      };
    } catch (error) {
      return {
        body: "",
        error: describeProbeError(error),
        latencyMs: performance.now() - startedAt,
        ok: false,
        status: 0,
      };
    }
  };
  const probeReadyz = () => safeHttpProbe("/readyz", "application/json");
  const probeControlUi = () => safeHttpProbe("/", "text/html");
  const probeSessions = async () => {
    const startedAt = performance.now();
    try {
      const payload = await params.rpc(
        "sessions.list",
        {},
        Math.min(HTTP_TIMEOUT_MS, requireRemainingMs(params.deadlineAt, "probing sessions.list")),
      );
      return { error: null, latencyMs: performance.now() - startedAt, ok: true, payload };
    } catch (error) {
      return {
        error: describeProbeError(error),
        latencyMs: performance.now() - startedAt,
        ok: false,
        payload: null,
      };
    }
  };
  const [readyz, controlUi, sessions] = params.serial
    ? [await probeReadyz(), await probeControlUi(), await probeSessions()]
    : await Promise.all([probeReadyz(), probeControlUi(), probeSessions()]);
  const readyBody = (() => {
    if (readyz.status !== 200) {
      return {};
    }
    try {
      return JSON.parse(readyz.body) as { eventLoop?: Record<string, unknown> };
    } catch {
      return {};
    }
  })();
  const eventLoop = readyBody.eventLoop;
  return {
    controlUi: {
      atMs,
      error:
        controlUi.error ??
        (controlUi.status === 200 && !controlUi.body.includes("<html")
          ? "response body did not contain <html"
          : null),
      latencyMs: controlUi.latencyMs,
      ok: controlUi.ok && controlUi.status === 200 && controlUi.body.includes("<html"),
      status: controlUi.status,
    },
    readyz: {
      atMs,
      error: readyz.error,
      latencyMs: readyz.latencyMs,
      ok: readyz.ok && readyz.status === 200,
      status: readyz.status,
      degraded: typeof eventLoop?.degraded === "boolean" ? eventLoop.degraded : null,
      degradedSinceMs: asFiniteNumber(eventLoop?.degradedSinceMs) ?? null,
      delayP99Ms: asFiniteNumber(eventLoop?.delayP99Ms) ?? null,
      utilization: asFiniteNumber(eventLoop?.utilization) ?? null,
      cpuCoreRatio: asFiniteNumber(eventLoop?.cpuCoreRatio) ?? null,
    },
    sessionsList: {
      atMs,
      error: sessions.error,
      latencyMs: sessions.latencyMs,
      ok: sessions.ok,
    },
  };
}

async function warmGatewayProbes(params: {
  deadlineAt: number;
  sample: (deadlineAt: number) => Promise<GatewaySample>;
  retryDelayMs?: number;
  targetMs?: number;
}): Promise<{ durationMs: number; samples: GatewaySample[] }> {
  const startedAt = performance.now();
  const samples: GatewaySample[] = [];
  const targetMs = params.targetMs ?? PROBE_WARMUP_TARGET_MS;
  while (remainingMs(params.deadlineAt) > 0) {
    const sample = await params.sample(params.deadlineAt);
    samples.push(sample);
    const healthy = sample.readyz.ok && sample.sessionsList.ok && sample.controlUi.ok;
    const fast =
      Math.max(
        sample.readyz.latencyMs,
        sample.sessionsList.latencyMs,
        sample.controlUi.latencyMs,
      ) <= targetMs;
    const eventLoopSettled = sample.readyz.degraded !== true;
    if (healthy && fast && eventLoopSettled) {
      return { durationMs: performance.now() - startedAt, samples };
    }
    await delay(
      Math.min(params.retryDelayMs ?? PROBE_WARMUP_RETRY_DELAY_MS, remainingMs(params.deadlineAt)),
    );
  }
  const lastSample = samples.at(-1);
  throw new Error(
    lastSample
      ? formatProbeFailure(lastSample)
      : "gateway probes did not run before the warmup deadline",
  );
}

async function runGatewaySample(options: {
  cadenceMs: number;
  concurrency: number;
  deadlineAt: number;
  entry: string;
  cpuProfDir?: string;
  pluginCount: number;
  toolEvents: boolean;
  workspaceFanout: boolean;
}): Promise<BenchmarkRun> {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-gateway-concurrency-"));
  const [port, mockPort] = await Promise.all([getFreePort(), getFreePort()]);
  const runStartedAt = performance.now();
  const timelinePath = path.join(root, "diagnostics-timeline.jsonl");
  let gateway: ChildProcessWithoutNullStreams | undefined;
  let mockProvider: ChildProcessWithoutNullStreams | undefined;
  let client: Awaited<ReturnType<typeof connectGateway>> | undefined;
  let gatewayOutput = { readOutput: () => "", readStderrTail: () => "" };
  let mockOutput = { readOutput: () => "", readStderrTail: () => "" };

  try {
    const configPath = buildConfig(root, mockPort, options.concurrency, options.pluginCount);
    mockProvider = spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env: {
        LANG: process.env.LANG ?? "en_US.UTF-8",
        PATH: process.env.PATH,
        MOCK_PORT: String(mockPort),
        MOCK_RESPONSE_CHUNK_DELAY_MS: String(MOCK_RESPONSE_CHUNK_DELAY_MS),
        SUCCESS_MARKER: "OpenClaw gateway concurrency benchmark streaming response.",
      },
    });
    mockOutput = captureChildOutput(mockProvider);
    await waitForMockServer(mockPort, options.deadlineAt);

    if (options.cpuProfDir) {
      mkdirSync(options.cpuProfDir, { recursive: true });
    }
    const gatewayArgs = buildGatewayBenchChildArgs(options.entry, port);
    gateway = spawn(
      process.execPath,
      options.cpuProfDir
        ? ["--cpu-prof", `--cpu-prof-dir=${options.cpuProfDir}`, ...gatewayArgs]
        : gatewayArgs,
      {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        env: {
          ...createGatewayBenchEnv(root, configPath, {
            caseEnv: {
              OPENCLAW_DIAGNOSTICS: "timeline",
              OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
              OPENCLAW_SKIP_CHANNELS: "1",
            },
          }),
          OPENAI_API_KEY: "gateway-concurrency-benchmark",
        },
      },
    );
    gatewayOutput = captureChildOutput(gateway);
    const ready = await waitForInitialProbe({
      deadlineAt: options.deadlineAt,
      isDone: () => gateway?.exitCode != null || gateway?.signalCode != null,
      path: "/readyz",
      port,
      startAt: runStartedAt,
    });
    if (ready.status !== 200) {
      throw new Error(`gateway did not become ready\n${gatewayOutput.readOutput()}`);
    }
    await waitForGatewayDispatchReady(gatewayOutput.readOutput, options.deadlineAt);
    client = await connectGateway(port, options.deadlineAt);
    const rpc = client.request;
    // The first authenticated RPC lazily imports the server-method graph. It measured 6.9s
    // on an idle M4 Pro (previously 18.4s) and crossed 20s on Linux; hot probes took 15-40ms.
    // Keep that cold work out of the load-phase deadline and latency distributions.
    const probeWarmupDeadlineAt = performance.now() + PROBE_WARMUP_TIMEOUT_MS;
    client.setDeadlineAt(probeWarmupDeadlineAt);
    const probeWarmup = await warmGatewayProbes({
      deadlineAt: probeWarmupDeadlineAt,
      sample: (deadlineAt) =>
        sampleGateway({
          deadlineAt,
          port,
          rpc,
          runStartedAt,
        }),
    });
    const loadDeadlineAt = options.deadlineAt + probeWarmup.durationMs;
    client.setDeadlineAt(loadDeadlineAt);
    const workspaceSessionKeys = options.workspaceFanout
      ? await Promise.all(
          Array.from({ length: options.concurrency }, async (_, index) => {
            const workspaceDir = path.join(root, `workspace-${index + 1}`);
            mkdirSync(workspaceDir, { recursive: true });
            const sessionKey = `agent:main:gateway-concurrency-${index + 1}`;
            await rpc("sessions.create", {
              key: sessionKey,
              agentId: "main",
              cwd: workspaceDir,
            });
            return sessionKey;
          }),
        )
      : [];
    // The benchmark compares runtime event work, so discard startup and lazy-import spans.
    writeFileSync(timelinePath, "");

    const controlUi: ControlUiProbe[] = [];
    const readyz: ReadyProbe[] = [];
    const sessionsList: TimedProbe[] = [];
    let turnsDone = false;
    let startedTurnCount = 0;
    let resolveAllTurnsStarted!: () => void;
    const allTurnsStarted = new Promise<void>((resolve) => {
      resolveAllTurnsStarted = resolve;
    });
    const turnsStartedAt = performance.now();
    const turns = Promise.all(
      Array.from({ length: options.concurrency }, (_, index) =>
        runTurn(rpc, index, loadDeadlineAt, options.toolEvents, {
          onStarted: () => {
            startedTurnCount += 1;
            if (startedTurnCount === options.concurrency) {
              resolveAllTurnsStarted();
            }
          },
          ...(workspaceSessionKeys[index] ? { sessionKey: workspaceSessionKeys[index] } : {}),
        }),
      ),
    ).finally(() => {
      turnsDone = true;
      resolveAllTurnsStarted();
    });
    const freshConnection = allTurnsStarted.then(async (): Promise<FreshConnectionProbe> => {
      const startedAt = performance.now();
      try {
        const freshClient = await connectGateway(port, loadDeadlineAt, false);
        freshClient.close();
        return { error: null, latencyMs: performance.now() - startedAt, ok: true };
      } catch (error) {
        return {
          error: describeProbeError(error),
          latencyMs: performance.now() - startedAt,
          ok: false,
        };
      }
    });
    const sampler = (async () => {
      for (;;) {
        const sampleStartedAt = performance.now();
        const sample = await sampleGateway({
          deadlineAt: loadDeadlineAt,
          port,
          rpc,
          runStartedAt,
        });
        readyz.push(sample.readyz);
        sessionsList.push(sample.sessionsList);
        controlUi.push(sample.controlUi);
        if (turnsDone || readyz.length >= MAX_SAMPLES_PER_RUN) {
          break;
        }
        await delay(
          Math.min(
            Math.max(0, options.cadenceMs - (performance.now() - sampleStartedAt)),
            requireRemainingMs(loadDeadlineAt, "sampling gateway load"),
          ),
        );
      }
    })();
    await Promise.all([turns, sampler]);
    const freshConnectionResult = await freshConnection;
    const turnsDurationMs = performance.now() - turnsStartedAt;

    return {
      controlUi,
      durationMs: performance.now() - runStartedAt,
      freshConnection: freshConnectionResult,
      probeWarmup,
      pluginMetadataScans: summarizePluginMetadataScans(readDiagnosticsTimelineSpans(timelinePath)),
      readyz,
      sessionsList,
      turnCount: options.concurrency,
      turnsDurationMs,
    };
  } catch (error) {
    const detail = formatRunFailure(error, gatewayOutput, mockOutput);
    throw new Error(detail, { cause: error });
  } finally {
    client?.close();
    if (gateway) {
      if (options.cpuProfDir && gateway.exitCode === null && gateway.signalCode === null) {
        // V8 flushes the main-isolate CPU profile on its normal interrupt path.
        const profileFlushed = new Promise<void>((resolve) => {
          gateway!.once("exit", () => {
            resolve();
          });
        });
        gateway.kill("SIGINT");
        await Promise.race([profileFlushed, delay(2_000)]);
      }
      await stopChild(gateway);
    }
    if (mockProvider) {
      await stopChild(mockProvider);
    }
    rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  }
}

function summarizeRuns(runs: readonly BenchmarkRun[]) {
  const readyz = runs.flatMap((run) => run.readyz);
  return {
    controlUiFailedSamples: runs.flatMap((run) => run.controlUi).filter((sample) => !sample.ok)
      .length,
    controlUiLatencyMs: summarizeNumbers(
      runs.flatMap((run) => run.controlUi.map((sample) => sample.latencyMs)),
    ),
    cpuCoreRatio: summarizeNumbers(
      readyz.flatMap((sample) => (sample.cpuCoreRatio == null ? [] : [sample.cpuCoreRatio])),
    ),
    degradedSamples: readyz.filter((sample) => sample.degraded === true).length,
    eventLoopDelayP99Ms: summarizeNumbers(
      readyz.flatMap((sample) => (sample.delayP99Ms == null ? [] : [sample.delayP99Ms])),
    ),
    eventLoopUtilization: summarizeNumbers(
      readyz.flatMap((sample) => (sample.utilization == null ? [] : [sample.utilization])),
    ),
    freshConnectionFailedRuns: runs.filter((run) => !run.freshConnection.ok).length,
    freshConnectionLatencyMs: summarizeNumbers(runs.map((run) => run.freshConnection.latencyMs)),
    pluginMetadataScanCount: runs.reduce((sum, run) => sum + run.pluginMetadataScans.count, 0),
    pluginMetadataScanTotalDurationMs: runs.reduce(
      (sum, run) => sum + run.pluginMetadataScans.totalDurationMs,
      0,
    ),
    readyzLatencyMs: summarizeNumbers(readyz.map((sample) => sample.latencyMs)),
    readyzFailedSamples: readyz.filter((sample) => !sample.ok).length,
    sampleCount: readyz.length,
    sessionsListLatencyMs: summarizeNumbers(
      runs.flatMap((run) => run.sessionsList.map((sample) => sample.latencyMs)),
    ),
    sessionsListFailedSamples: runs
      .flatMap((run) => run.sessionsList)
      .filter((sample) => !sample.ok).length,
    turnsDurationMs: summarizeNumbers(runs.map((run) => run.turnsDurationMs)),
  };
}

async function runBenchmarkSamples(params: {
  now?: () => number;
  onProgress?: (message: string) => void;
  options: CliOptions;
  runSample?: typeof runGatewaySample;
}): Promise<BenchmarkRun[]> {
  const now = params.now ?? performance.now.bind(performance);
  const runSample = params.runSample ?? runGatewaySample;
  const runs: BenchmarkRun[] = [];
  const total = params.options.runs + params.options.warmup;
  for (let index = 0; index < total; index += 1) {
    // Each sample gets the same budget so earlier runs cannot shrink later agent waits.
    // runGatewaySample extends this deadline by its probe warmup before load starts.
    const deadlineAt = now() + params.options.timeoutMs;
    const run = await runSample({ ...params.options, deadlineAt });
    if (index >= params.options.warmup) {
      runs.push(run);
      params.onProgress?.(
        `[bench-gateway-concurrency] run ${runs.length}/${params.options.runs}: turns=${run.turnCount} samples=${run.readyz.length} duration=${run.durationMs.toFixed(1)}ms`,
      );
    } else {
      params.onProgress?.(
        `[bench-gateway-concurrency] warmup ${index + 1}/${params.options.warmup}: duration=${run.durationMs.toFixed(1)}ms`,
      );
    }
  }
  return runs;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    printUsage();
    return;
  }
  const options = parseOptions(argv);
  const runs = await runBenchmarkSamples({ onProgress: console.error, options });
  const payload = {
    cadenceMs: options.cadenceMs,
    concurrency: options.concurrency,
    entry: options.entry,
    generatedAt: new Date().toISOString(),
    mode: "mock-streaming-agent",
    pluginCount: options.pluginCount,
    runs,
    summary: summarizeRuns(runs),
    toolEvents: options.toolEvents,
    workspaceFanout: options.workspaceFanout,
  };
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(payload, null, 2)}\n`);
  }
  if (options.json || !options.output) {
    console.log(JSON.stringify(payload, null, 2));
  }
  if (options.maxHandshakeMs !== undefined) {
    const violation = runs.find(
      (run) => !run.freshConnection.ok || run.freshConnection.latencyMs > options.maxHandshakeMs!,
    );
    if (violation) {
      throw new Error(
        `fresh Gateway connection exceeded ${options.maxHandshakeMs}ms: ` +
          `ok=${violation.freshConnection.ok} ` +
          `latencyMs=${violation.freshConnection.latencyMs.toFixed(1)} ` +
          `error=${violation.freshConnection.error ?? "none"}`,
      );
    }
  }
  if (options.maxControlMs !== undefined) {
    const controlSamples: Array<{ name: string; sample: TimedProbe }> = [];
    for (const run of runs) {
      controlSamples.push(
        ...run.readyz.map((sample) => ({ name: "readyz", sample })),
        ...run.sessionsList.map((sample) => ({ name: "sessions.list", sample })),
      );
    }
    const violation = controlSamples.find(
      ({ sample }) => !sample.ok || sample.latencyMs > options.maxControlMs!,
    );
    if (violation) {
      throw new Error(
        `Gateway ${violation.name} probe exceeded ${options.maxControlMs}ms: ` +
          `ok=${violation.sample.ok} latencyMs=${violation.sample.latencyMs.toFixed(1)} ` +
          `error=${violation.sample.error ?? "none"}`,
      );
    }
  }
}

export const testing = {
  parseOptions,
  formatProbeFailure,
  formatRunFailure,
  requestHttp,
  runBenchmarkSamples,
  runTurn,
  sampleGateway,
  summarizePluginMetadataScans,
  summarizeNumbers,
  summarizeRuns,
  tailLines,
  warmGatewayProbes,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main()
    .catch((error: unknown) => {
      console.error(error instanceof CliArgumentError ? error.message : (error as Error)?.stack);
      process.exitCode = 1;
    })
    .finally(() => {
      if (process.exitCode && process.exitCode !== 0) {
        console.error(`[bench-gateway-concurrency] FAILED (exit ${process.exitCode})`);
      }
    });
}
