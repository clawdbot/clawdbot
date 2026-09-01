import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
// Bench Gateway Concurrency script measures gateway probes during synthetic streaming turns.
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { asFiniteNumber } from "../packages/normalization-core/src/number-coercion.ts";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";
import { sliceUtf16Safe } from "../packages/normalization-core/src/utf16-slice.ts";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { delay, stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort, readProcessRssMb } from "./lib/gateway-bench-probes.ts";
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

type GatewayMemorySample = {
  atMs: number;
  heapTotalMb: number;
  heapUsedMb: number;
  rssMb: number;
};

type BenchmarkRun = {
  controlUi: ControlUiProbe[];
  durationMs: number;
  freshConnection: FreshConnectionProbe;
  history: TimedProbe[];
  memory: { after: GatewayMemorySample; before: GatewayMemorySample; peakRssMb: number };
  messageSubscriptions: TimedProbe[];
  messageSubscriptionsDuringLoad: TimedProbe[];
  modelRequestCount: number;
  probeWarmup: {
    durationMs: number;
    samples: GatewaySample[];
  };
  pluginMetadataScans: ReturnType<typeof summarizePluginMetadataScans>;
  readyz: ReadyProbe[];
  sessionSeedDurationMs: number;
  sessionsList: TimedProbe[];
  sessionUpdates: TimedProbe[];
  setupDurationMs: number;
  turnCount: number;
  turnsDurationMs: number;
};

type CliOptions = {
  cadenceMs: number;
  concurrency: number;
  cpuProfDir?: string;
  diagnosticsTimeline: boolean;
  entry: string;
  historyBurst: number;
  historyClients: number;
  json: boolean;
  maxControlMs?: number;
  maxHandshakeMs?: number;
  output?: string;
  pluginCount: number;
  runs: number;
  sessionCount: number;
  sessionUpdateClients: number;
  sessionUpdates: number;
  streamChunkDelayMs: number;
  subscribers: number;
  timeoutMs: number;
  toolEvents: boolean;
  visibleObserver: boolean;
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
const MAX_SESSION_COUNT = 10_000;
const MAX_SESSION_UPDATES = 100_000;
const MAX_SESSION_SEED_CONCURRENCY = 16;
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
const BOOLEAN_FLAGS = new Set([
  "--help",
  "-h",
  "--json",
  "--no-diagnostics-timeline",
  "--tool-events",
  "--visible-observer",
  "--workspace-fanout",
]);
const VALUE_FLAGS = new Set([
  "--cadence-ms",
  "--concurrency",
  "--cpu-prof-dir",
  "--entry",
  "--history-burst",
  "--history-clients",
  "--max-control-ms",
  "--max-handshake-ms",
  "--output",
  "--plugin-count",
  "--runs",
  "--session-count",
  "--session-update-clients",
  "--session-updates",
  "--stream-chunk-delay-ms",
  "--subscribers",
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
    diagnosticsTimeline: !hasFlag(argv, "--no-diagnostics-timeline"),
    entry: resolveEntry(parseFlagValue(argv, "--entry"), DEFAULT_ENTRY),
    historyBurst: parseBoundedPositiveInt(
      parseFlagValue(argv, "--history-burst"),
      5,
      "--history-burst",
      32,
    ),
    historyClients: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--history-clients"),
      0,
      "--history-clients",
      MAX_CONCURRENCY,
    ),
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
    sessionCount: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--session-count"),
      0,
      "--session-count",
      MAX_SESSION_COUNT,
    ),
    sessionUpdateClients: parseBoundedPositiveInt(
      parseFlagValue(argv, "--session-update-clients"),
      4,
      "--session-update-clients",
      MAX_CONCURRENCY,
    ),
    sessionUpdates: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--session-updates"),
      0,
      "--session-updates",
      MAX_SESSION_UPDATES,
    ),
    streamChunkDelayMs: parseBoundedPositiveInt(
      parseFlagValue(argv, "--stream-chunk-delay-ms"),
      MOCK_RESPONSE_CHUNK_DELAY_MS,
      "--stream-chunk-delay-ms",
      30_000,
    ),
    subscribers: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--subscribers"),
      0,
      "--subscribers",
      MAX_CONCURRENCY,
    ),
    timeoutMs: parseBoundedPositiveInt(
      parseFlagValue(argv, "--timeout-ms"),
      DEFAULT_TIMEOUT_MS,
      "--timeout-ms",
      10 * 60_000,
    ),
    toolEvents: hasFlag(argv, "--tool-events"),
    visibleObserver: hasFlag(argv, "--visible-observer"),
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
  --session-count <n> Seed up to ${MAX_SESSION_COUNT} distinct sessions before load
  --session-updates <n> Bounded public sessions.patch mutations during load
  --session-update-clients <n> Concurrent session mutation clients (default: 4)
  --history-clients <n> Concurrent dedicated history-prefetch WebSocket clients
  --history-burst <n> Parallel history requests per prefetch client (default: 5)
  --subscribers <n> Dedicated session-message subscription clients
  --stream-chunk-delay-ms <n> Mock-provider delay between stream chunks (default: ${MOCK_RESPONSE_CHUNK_DELAY_MS})
  --visible-observer Mark subscribed clients visible to exercise session observation
  --no-diagnostics-timeline Disable diagnostics timeline file writes
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

function readDiagnosticsTimelineSpans(
  timelinePath: string,
  window?: { from: number; through: number },
): DiagnosticsTimelineSpan[] {
  const contents = readFileSync(timelinePath, "utf8");
  if (!contents.trim() || !contents.endsWith("\n")) {
    throw new Error("diagnostics timeline is empty or incomplete");
  }
  return contents
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      const event: unknown = JSON.parse(line);
      if (
        !isRecord(event) ||
        event.schemaVersion !== "openclaw.diagnostics.v1" ||
        typeof event.timestamp !== "string" ||
        !Number.isFinite(Date.parse(event.timestamp))
      ) {
        throw new Error("invalid diagnostics timeline record");
      }
      const timestamp = Date.parse(event.timestamp);
      if (window && (timestamp < window.from || timestamp > window.through)) {
        return [];
      }
      if (event.type !== "span.end") {
        return [];
      }
      if (
        typeof event.name !== "string" ||
        typeof event.durationMs !== "number" ||
        !Number.isFinite(event.durationMs)
      ) {
        throw new Error("invalid diagnostics timeline span");
      }
      return [{ name: event.name, durationMs: event.durationMs }];
    });
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
  const checkoutIndex = path.join(process.cwd(), "ui", "index.html");
  copyFileSync(
    existsSync(checkoutIndex)
      ? checkoutIndex
      : path.join(process.cwd(), "dist", "control-ui", "index.html"),
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
    utilityModel: "openai/gpt-5.6-luna",
  };
  const pluginFixtures =
    pluginCount > 0 ? writePluginFixtures(root, { count: pluginCount }) : undefined;
  return writeGatewayBenchConfig(root, config, { pluginFixtures });
}

async function readGatewayProtocolVersion(entry: string): Promise<number> {
  const protocolPath = path.join(
    path.dirname(path.resolve(entry)),
    "gateway",
    "protocol",
    "index.js",
  );
  const protocol: unknown = await import(pathToFileURL(protocolPath).href);
  if (
    typeof protocol !== "object" ||
    protocol === null ||
    !("PROTOCOL_VERSION" in protocol) ||
    typeof protocol.PROTOCOL_VERSION !== "number"
  ) {
    throw new Error(`Gateway protocol module is missing PROTOCOL_VERSION: ${protocolPath}`);
  }
  return protocol.PROTOCOL_VERSION;
}

async function connectGateway(
  port: number,
  deadlineAt: number,
  protocolVersion: number,
  subscribeSessions = true,
) {
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
    minProtocol: protocolVersion,
    maxProtocol: protocolVersion,
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

async function readGatewayMemory(
  rpc: GatewayRpc,
  runStartedAt: number,
): Promise<GatewayMemorySample> {
  const result = await rpc<{
    processMemory?: { heapTotalBytes?: number; heapUsedBytes?: number; rssBytes?: number };
  }>("status", { includeChannelSummary: false });
  const memory = result.processMemory;
  const heapTotalBytes = asFiniteNumber(memory?.heapTotalBytes);
  const heapUsedBytes = asFiniteNumber(memory?.heapUsedBytes);
  const rssBytes = asFiniteNumber(memory?.rssBytes);
  if (heapTotalBytes === undefined || heapUsedBytes === undefined || rssBytes === undefined) {
    throw new Error("Gateway status did not report process memory");
  }
  const toMb = (bytes: number) => bytes / 1024 / 1024;
  return {
    atMs: performance.now() - runStartedAt,
    heapTotalMb: toMb(heapTotalBytes),
    heapUsedMb: toMb(heapUsedBytes),
    rssMb: toMb(rssBytes),
  };
}

function readGatewayProcessRssMb(pid: number | undefined): number | null {
  if (!pid) {
    return null;
  }
  if (process.platform !== "linux") {
    return readProcessRssMb(pid);
  }
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s+(\d+)\s+kB$/mu.exec(status);
    const rssKb = match ? Number(match[1]) : Number.NaN;
    return Number.isFinite(rssKb) && rssKb > 0 ? rssKb / 1024 : null;
  } catch {
    return null;
  }
}

async function timeRpcProbe(
  rpc: GatewayRpc,
  method: string,
  params: unknown,
  runStartedAt: number,
): Promise<TimedProbe> {
  const startedAt = performance.now();
  try {
    await rpc(method, params);
    return {
      atMs: startedAt - runStartedAt,
      error: null,
      latencyMs: performance.now() - startedAt,
      ok: true,
    };
  } catch (error) {
    return {
      atMs: startedAt - runStartedAt,
      error: describeProbeError(error),
      latencyMs: performance.now() - startedAt,
      ok: false,
    };
  }
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
  // Agent waits share the load deadline; a shorter observation cap would abort
  // an active turn while the benchmark still has time to measure completion.
  const waitTimeoutMs = Math.max(0, Math.floor(remaining - AGENT_WAIT_RPC_GRACE_MS));
  const rpcTimeoutMs = Math.max(1, Math.ceil(remaining));
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
  diagnosticsTimeline: boolean;
  entry: string;
  cpuProfDir?: string;
  historyBurst: number;
  historyClients: number;
  pluginCount: number;
  sessionCount: number;
  sessionUpdateClients: number;
  sessionUpdates: number;
  streamChunkDelayMs: number;
  subscribers: number;
  timeoutMs: number;
  toolEvents: boolean;
  visibleObserver: boolean;
  workspaceFanout: boolean;
}): Promise<BenchmarkRun> {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-gateway-concurrency-"));
  const [port, mockPort] = await Promise.all([getFreePort(), getFreePort()]);
  const runStartedAt = performance.now();
  const timelinePath = path.join(root, "diagnostics-timeline.jsonl");
  const requestLogPath = path.join(root, "mock-provider-requests.jsonl");
  const protocolVersion = await readGatewayProtocolVersion(options.entry);
  let gateway: ChildProcessWithoutNullStreams | undefined;
  let mockProvider: ChildProcessWithoutNullStreams | undefined;
  let client: Awaited<ReturnType<typeof connectGateway>> | undefined;
  const auxiliaryClients: Array<Awaited<ReturnType<typeof connectGateway>>> = [];
  let gatewayOutput = { readOutput: () => "", readStderrTail: () => "" };
  let mockOutput = { readOutput: () => "", readStderrTail: () => "" };
  let result: BenchmarkRun;
  let gatewayExit: Awaited<ReturnType<typeof stopChild>> | undefined;
  let timelineWindow: { from: number; through: number } | undefined;

  try {
    try {
      const configPath = buildConfig(root, mockPort, options.concurrency, options.pluginCount);
      mockProvider = spawn(process.execPath, ["scripts/e2e/mock-openai-server.mjs"], {
        cwd: process.cwd(),
        detached: process.platform !== "win32",
        env: {
          LANG: process.env.LANG ?? "en_US.UTF-8",
          PATH: process.env.PATH,
          MOCK_PORT: String(mockPort),
          MOCK_REQUEST_LOG: requestLogPath,
          MOCK_RESPONSE_CHUNK_DELAY_MS: String(options.streamChunkDelayMs),
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
                ...(options.diagnosticsTimeline
                  ? {
                      OPENCLAW_DIAGNOSTICS: "timeline",
                      OPENCLAW_DIAGNOSTICS_TIMELINE_PATH: timelinePath,
                    }
                  : {}),
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
      client = await connectGateway(port, options.deadlineAt, protocolVersion);
      const rpc = client.request;
      if (options.visibleObserver) {
        await rpc("sessions.observer.visibility", { visible: true });
      }
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
      const setupDeadlineAt = performance.now() + options.timeoutMs;
      const setupStartedAt = performance.now();
      client.setDeadlineAt(setupDeadlineAt);
      const sessionCount = Math.max(options.concurrency, options.sessionCount);
      const prepareSessions =
        options.workspaceFanout ||
        options.sessionCount > 0 ||
        options.historyClients > 0 ||
        options.sessionUpdates > 0 ||
        options.subscribers > 0;
      const sessionKeys = Array.from(
        { length: sessionCount },
        (_, index) => `agent:main:gateway-concurrency-${index + 1}`,
      );
      const sessionSeedStartedAt = performance.now();
      if (prepareSessions) {
        let nextSessionIndex = 0;
        let seededSessionCount = 0;
        await Promise.all(
          Array.from({ length: Math.min(MAX_SESSION_SEED_CONCURRENCY, sessionCount) }, async () => {
            for (;;) {
              const index = nextSessionIndex++;
              const sessionKey = sessionKeys[index];
              if (!sessionKey) {
                return;
              }
              const workspaceDir = options.workspaceFanout
                ? path.join(root, `workspace-${index + 1}`)
                : undefined;
              if (workspaceDir) {
                mkdirSync(workspaceDir, { recursive: true });
              }
              await rpc("sessions.create", {
                key: sessionKey,
                agentId: "main",
                ...(workspaceDir ? { cwd: workspaceDir } : {}),
              });
              seededSessionCount += 1;
              if (sessionCount >= 250 && seededSessionCount % 250 === 0) {
                console.error(
                  `[bench-gateway-concurrency] seeded ${seededSessionCount}/${sessionCount} sessions`,
                );
              }
            }
          }),
        );
      }
      const sessionSeedDurationMs = performance.now() - sessionSeedStartedAt;
      const messageSubscriptions: TimedProbe[] = [];
      for (let index = 0; index < options.subscribers; index += 1) {
        const subscriber = await connectGateway(port, setupDeadlineAt, protocolVersion, false);
        auxiliaryClients.push(subscriber);
        if (options.visibleObserver) {
          await subscriber.request("sessions.observer.visibility", { visible: true });
        }
        const subscription = await timeRpcProbe(
          subscriber.request,
          "sessions.messages.subscribe",
          { key: sessionKeys[index % sessionKeys.length] },
          runStartedAt,
        );
        messageSubscriptions.push(subscription);
        if (!subscription.ok) {
          throw new Error(`session message subscription failed: ${subscription.error}`);
        }
      }
      const historyClients = await Promise.all(
        Array.from({ length: options.historyClients }, async () => {
          const historyClient = await connectGateway(port, setupDeadlineAt, protocolVersion, false);
          auxiliaryClients.push(historyClient);
          return historyClient;
        }),
      );
      const sessionUpdateClients = await Promise.all(
        Array.from(
          { length: options.sessionUpdates > 0 ? options.sessionUpdateClients : 0 },
          async () => {
            const updateClient = await connectGateway(
              port,
              setupDeadlineAt,
              protocolVersion,
              false,
            );
            auxiliaryClients.push(updateClient);
            return updateClient;
          },
        ),
      );
      const subscriptionProbeClient =
        options.subscribers > 0
          ? await connectGateway(port, setupDeadlineAt, protocolVersion, false)
          : undefined;
      if (subscriptionProbeClient) {
        auxiliaryClients.push(subscriptionProbeClient);
      }
      const memoryBefore = await readGatewayMemory(rpc, runStartedAt);
      const setupDurationMs = performance.now() - setupStartedAt;
      // Large session fixtures are setup, not benchmarked load. Every measured
      // run therefore gets its complete timeout after all clients are ready.
      const loadDeadlineAt = performance.now() + options.timeoutMs;
      client.setDeadlineAt(loadDeadlineAt);
      for (const auxiliaryClient of auxiliaryClients) {
        auxiliaryClient.setDeadlineAt(loadDeadlineAt);
      }
      const controlUi: ControlUiProbe[] = [];
      const history: TimedProbe[] = [];
      const messageSubscriptionsDuringLoad: TimedProbe[] = [];
      const readyz: ReadyProbe[] = [];
      const sessionsList: TimedProbe[] = [];
      const sessionUpdates: TimedProbe[] = [];
      let peakRssMb = memoryBefore.rssMb;
      let lastRssSampleAt = performance.now();
      let turnsDone = false;
      let updatesDone = options.sessionUpdates === 0;
      const workloadDone = () => turnsDone && updatesDone;
      let startedTurnCount = 0;
      let resolveAllTurnsStarted!: () => void;
      const allTurnsStarted = new Promise<void>((resolve) => {
        resolveAllTurnsStarted = resolve;
      });
      const turnsStartedAt = performance.now();
      // Keep the live artifact intact: buffered setup writes can arrive after this boundary.
      // Inclusive millisecond timestamps conservatively include events on the boundary.
      const timelineFrom = Date.now();
      const turns = Promise.all(
        Array.from({ length: options.concurrency }, (_, index) =>
          runTurn(rpc, index, loadDeadlineAt, options.toolEvents, {
            onStarted: () => {
              startedTurnCount += 1;
              if (startedTurnCount === options.concurrency) {
                resolveAllTurnsStarted();
              }
            },
            ...(sessionKeys[index] ? { sessionKey: sessionKeys[index] } : {}),
          }),
        ),
      ).finally(() => {
        turnsDone = true;
        resolveAllTurnsStarted();
      });
      const freshConnection = allTurnsStarted.then(async (): Promise<FreshConnectionProbe> => {
        const startedAt = performance.now();
        try {
          const freshClient = await connectGateway(port, loadDeadlineAt, protocolVersion, false);
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
          const subscriptionKey = sessionKeys[readyz.length % sessionKeys.length];
          const [sample, subscription] = await Promise.all([
            sampleGateway({
              deadlineAt: loadDeadlineAt,
              port,
              rpc,
              runStartedAt,
            }),
            subscriptionProbeClient && subscriptionKey
              ? timeRpcProbe(
                  subscriptionProbeClient.request,
                  "sessions.messages.subscribe",
                  { key: subscriptionKey },
                  runStartedAt,
                )
              : Promise.resolve(undefined),
          ]);
          if (subscription) {
            messageSubscriptionsDuringLoad.push(subscription);
            if (subscription.ok) {
              await subscriptionProbeClient?.request("sessions.messages.unsubscribe", {
                key: subscriptionKey,
              });
            }
          }
          readyz.push(sample.readyz);
          sessionsList.push(sample.sessionsList);
          controlUi.push(sample.controlUi);
          if (performance.now() - lastRssSampleAt >= 1_000) {
            // Linux reads procfs without spawning a process. Non-Linux hosts use
            // the shared ps fallback at most once per second to bound perturbation.
            peakRssMb = Math.max(peakRssMb, readGatewayProcessRssMb(gateway?.pid) ?? 0);
            lastRssSampleAt = performance.now();
          }
          if (workloadDone() || readyz.length >= MAX_SAMPLES_PER_RUN) {
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
      const historyLoad = Promise.all(
        historyClients.map(async (historyClient, clientIndex) => {
          let offset = clientIndex * options.historyBurst;
          while (!workloadDone() && history.length < MAX_SAMPLES_PER_RUN) {
            const probes = await Promise.all(
              Array.from({ length: options.historyBurst }, (_, index) =>
                timeRpcProbe(
                  historyClient.request,
                  "chat.history",
                  { sessionKey: sessionKeys[(offset + index) % sessionKeys.length] },
                  runStartedAt,
                ),
              ),
            );
            history.push(...probes);
            offset += options.historyBurst;
            if (!workloadDone()) {
              await delay(Math.min(options.cadenceMs, remainingMs(loadDeadlineAt)));
            }
          }
        }),
      );
      let nextUpdateIndex = 0;
      const sessionUpdateLoad = Promise.all(
        sessionUpdateClients.map(async (updateClient) => {
          for (;;) {
            const index = nextUpdateIndex++;
            if (index >= options.sessionUpdates) {
              return;
            }
            const sessionKey = sessionKeys[index % sessionKeys.length];
            const update = await timeRpcProbe(
              updateClient.request,
              "sessions.patch",
              { key: sessionKey, label: `Benchmark update ${index + 1}` },
              runStartedAt,
            );
            sessionUpdates.push(update);
            if (!update.ok) {
              throw new Error(`sessions.patch load probe failed: ${update.error}`);
            }
          }
        }),
      ).finally(() => {
        updatesDone = true;
      });
      await Promise.all([turns, sampler, historyLoad, sessionUpdateLoad]);
      if (options.historyClients > 0 && !history.some((sample) => sample.ok)) {
        const failure = history[0]?.error ?? "no requests completed before turns finished";
        throw new Error(`all configured chat.history load probes failed: ${failure}`);
      }
      const freshConnectionResult = await freshConnection;
      const turnsDurationMs = performance.now() - turnsStartedAt;
      const memoryAfter = await readGatewayMemory(rpc, runStartedAt);
      peakRssMb = Math.max(peakRssMb, memoryAfter.rssMb);
      const modelRequestCount = existsSync(requestLogPath)
        ? readFileSync(requestLogPath, "utf8").split(/\r?\n/u).filter(Boolean).length
        : 0;

      timelineWindow = { from: timelineFrom, through: Date.now() };
      result = {
        controlUi,
        durationMs: performance.now() - runStartedAt,
        freshConnection: freshConnectionResult,
        history,
        memory: { after: memoryAfter, before: memoryBefore, peakRssMb },
        messageSubscriptions,
        messageSubscriptionsDuringLoad,
        modelRequestCount,
        probeWarmup,
        pluginMetadataScans: summarizePluginMetadataScans([]),
        readyz,
        sessionSeedDurationMs,
        sessionsList,
        sessionUpdates,
        setupDurationMs,
        turnCount: options.concurrency,
        turnsDurationMs,
      };
    } catch (error) {
      const detail = formatRunFailure(error, gatewayOutput, mockOutput);
      throw new Error(detail, { cause: error });
    } finally {
      for (const auxiliaryClient of auxiliaryClients) {
        auxiliaryClient.close();
      }
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
        gatewayExit = await stopChild(gateway);
      }
    }
    if (options.diagnosticsTimeline) {
      if (!gatewayExit || gatewayExit.exitCode !== 0 || gatewayExit.signal !== null) {
        throw new Error("Gateway did not exit cleanly; diagnostics timeline may be incomplete");
      }
      if (gatewayOutput.readOutput().includes("[diagnostics] failed to write timeline event")) {
        throw new Error("Gateway reported a diagnostics timeline write failure");
      }
      result.pluginMetadataScans = summarizePluginMetadataScans(
        readDiagnosticsTimelineSpans(timelinePath, timelineWindow),
      );
    }
    return result;
  } finally {
    try {
      if (mockProvider) {
        await stopChild(mockProvider);
      }
    } finally {
      rmSync(root, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
    }
  }
}

function summarizeRuns(
  runs: readonly BenchmarkRun[],
  options: Pick<CliOptions, "maxControlMs" | "maxHandshakeMs"> = {},
) {
  const controlUi = runs.flatMap((run) => run.controlUi);
  const readyz = runs.flatMap((run) => run.readyz);
  const sessionsList = runs.flatMap((run) => run.sessionsList);
  const history = runs.flatMap((run) => run.history);
  const subscriptions = runs.flatMap((run) => run.messageSubscriptions);
  const subscriptionsDuringLoad = runs.flatMap((run) => run.messageSubscriptionsDuringLoad);
  const sessionUpdates = runs.flatMap((run) => run.sessionUpdates);
  // Setup subscriptions and warmup probes are not load-phase measurements.
  const budgetViolations = [
    {
      name: "fresh Gateway connection",
      maxMs: options.maxHandshakeMs,
      samples: runs.map((run) => run.freshConnection),
    },
    ...(
      [
        ["readyz", readyz],
        ["Control UI", controlUi],
        ["sessions.list", sessionsList],
        ["chat.history", history],
        ["sessions.messages.subscribe", subscriptionsDuringLoad],
        ["sessions.patch", sessionUpdates],
      ] as const
    ).map(([name, samples]) => ({
      name: `Gateway ${name} probe`,
      maxMs: options.maxControlMs,
      samples,
    })),
  ].flatMap(({ name, maxMs, samples }) => {
    if (maxMs === undefined) {
      return [];
    }
    const violation = samples.find((sample) => !sample.ok || sample.latencyMs > maxMs);
    return violation
      ? [
          `${name} exceeded ${maxMs}ms: ok=${violation.ok} ` +
            `latencyMs=${violation.latencyMs.toFixed(1)} error=${violation.error ?? "none"}`,
        ]
      : [];
  });
  return {
    budgetViolations,
    controlUiFailedSamples: controlUi.filter((sample) => !sample.ok).length,
    controlUiLatencyMs: summarizeNumbers(controlUi.map((sample) => sample.latencyMs)),
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
    gatewayHeapGrowthMb: summarizeNumbers(
      runs.map((run) => run.memory.after.heapUsedMb - run.memory.before.heapUsedMb),
    ),
    gatewayHeapUsedMb: summarizeNumbers(runs.map((run) => run.memory.after.heapUsedMb)),
    gatewayPeakRssMb: summarizeNumbers(runs.map((run) => run.memory.peakRssMb)),
    gatewayRssGrowthMb: summarizeNumbers(
      runs.map((run) => run.memory.after.rssMb - run.memory.before.rssMb),
    ),
    historyFailedSamples: history.filter((sample) => !sample.ok).length,
    historyLatencyMs: summarizeNumbers(history.map((sample) => sample.latencyMs)),
    historySampleCount: history.length,
    messageSubscriptionFailedSamples: subscriptions.filter((sample) => !sample.ok).length,
    messageSubscriptionLatencyMs: summarizeNumbers(subscriptions.map((sample) => sample.latencyMs)),
    messageSubscriptionLoadFailedSamples: subscriptionsDuringLoad.filter((sample) => !sample.ok)
      .length,
    messageSubscriptionLoadLatencyMs: summarizeNumbers(
      subscriptionsDuringLoad.map((sample) => sample.latencyMs),
    ),
    modelRequestCount: runs.reduce((count, run) => count + run.modelRequestCount, 0),
    pluginMetadataScanCount: runs.reduce((sum, run) => sum + run.pluginMetadataScans.count, 0),
    pluginMetadataScanTotalDurationMs: runs.reduce(
      (sum, run) => sum + run.pluginMetadataScans.totalDurationMs,
      0,
    ),
    readyzLatencyMs: summarizeNumbers(readyz.map((sample) => sample.latencyMs)),
    readyzFailedSamples: readyz.filter((sample) => !sample.ok).length,
    sampleCount: readyz.length,
    sessionSeedDurationMs: summarizeNumbers(runs.map((run) => run.sessionSeedDurationMs)),
    sessionsListLatencyMs: summarizeNumbers(sessionsList.map((sample) => sample.latencyMs)),
    sessionsListFailedSamples: sessionsList.filter((sample) => !sample.ok).length,
    sessionUpdateFailedSamples: sessionUpdates.filter((sample) => !sample.ok).length,
    sessionUpdateLatencyMs: summarizeNumbers(sessionUpdates.map((sample) => sample.latencyMs)),
    sessionUpdateSampleCount: sessionUpdates.length,
    setupDurationMs: summarizeNumbers(runs.map((run) => run.setupDurationMs)),
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
    diagnosticsTimeline: options.diagnosticsTimeline,
    entry: options.entry,
    generatedAt: new Date().toISOString(),
    historyBurst: options.historyBurst,
    historyClients: options.historyClients,
    mode: "mock-streaming-agent",
    pluginCount: options.pluginCount,
    runs,
    sessionCount: Math.max(options.sessionCount, options.concurrency),
    sessionUpdateClients: options.sessionUpdates > 0 ? options.sessionUpdateClients : 0,
    sessionUpdates: options.sessionUpdates,
    streamChunkDelayMs: options.streamChunkDelayMs,
    subscribers: options.subscribers,
    summary: summarizeRuns(runs, options),
    toolEvents: options.toolEvents,
    visibleObserver: options.visibleObserver,
    workspaceFanout: options.workspaceFanout,
  };
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(payload, null, 2)}\n`);
  }
  if (options.json || !options.output) {
    console.log(JSON.stringify(payload, null, 2));
  }
  if (payload.summary.budgetViolations.length > 0) {
    throw new Error(payload.summary.budgetViolations.join("\n"));
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
  readDiagnosticsTimelineSpans,
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
