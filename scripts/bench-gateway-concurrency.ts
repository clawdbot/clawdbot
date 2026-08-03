import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
// Bench Gateway Concurrency script measures gateway probes during synthetic streaming turns.
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { PROTOCOL_VERSION } from "../packages/gateway-protocol/src/version.ts";
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

type GatewayRpc = <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>;

type BenchmarkRun = {
  controlUi: ControlUiProbe[];
  durationMs: number;
  readyz: ReadyProbe[];
  sessionsList: TimedProbe[];
  turnCount: number;
  turnsDurationMs: number;
};

type CliOptions = {
  cadenceMs: number;
  concurrency: number;
  entry: string;
  json: boolean;
  output?: string;
  runs: number;
  timeoutMs: number;
  warmup: number;
};

const DEFAULT_CADENCE_MS = 100;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_ENTRY = "dist/entry.js";
const DEFAULT_RUNS = 1;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_WARMUP = 0;
const MOCK_RESPONSE_CHUNK_DELAY_MS = 1_000;
const MAX_CONCURRENCY = 64;
const MAX_RUNS = 20;
const MAX_WARMUP = 10;
const MAX_SAMPLES_PER_RUN = 2_048;
const MAX_HTTP_BODY_BYTES = 1_048_576;
const HTTP_TIMEOUT_MS = 20_000;
const AGENT_WAIT_RPC_GRACE_MS = 5_000;
const BOOLEAN_FLAGS = new Set(["--help", "-h", "--json"]);
const VALUE_FLAGS = new Set([
  "--cadence-ms",
  "--concurrency",
  "--entry",
  "--output",
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
    entry: resolveEntry(parseFlagValue(argv, "--entry"), DEFAULT_ENTRY),
    json: hasFlag(argv, "--json"),
    output: resolveOutputPath(parseFlagValue(argv, "--output")),
    runs: parseBoundedPositiveInt(parseFlagValue(argv, "--runs"), DEFAULT_RUNS, "--runs", MAX_RUNS),
    timeoutMs: parseBoundedPositiveInt(
      parseFlagValue(argv, "--timeout-ms"),
      DEFAULT_TIMEOUT_MS,
      "--timeout-ms",
      10 * 60_000,
    ),
    warmup: parseBoundedNonNegativeInt(
      parseFlagValue(argv, "--warmup"),
      DEFAULT_WARMUP,
      "--warmup",
      MAX_WARMUP,
    ),
  };
}

function printUsage(): void {
  console.log(`OpenClaw Gateway concurrency benchmark

Usage:
  pnpm test:gateway:concurrency -- [options]
  node scripts/bench-gateway-concurrency.ts [options]

Options:
  --concurrency <n>  Concurrent synthetic streaming turns (default: ${DEFAULT_CONCURRENCY})
  --runs <n>         Measured gateway runs (default: ${DEFAULT_RUNS})
  --warmup <n>       Warmup gateway runs (default: ${DEFAULT_WARMUP})
  --cadence-ms <ms>  Probe cadence (default: ${DEFAULT_CADENCE_MS})
  --timeout-ms <ms>  Whole benchmark wall-clock cap (default: ${DEFAULT_TIMEOUT_MS})
  --entry <path>     Gateway CLI entry file (default: ${DEFAULT_ENTRY})
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
  const timeoutMs = Math.max(
    1,
    Math.min(HTTP_TIMEOUT_MS, requireRemainingMs(params.deadlineAt, `requesting ${params.path}`)),
  );
  return await new Promise((resolve, reject) => {
    const req = request(
      {
        headers: { accept: params.accept },
        host: "127.0.0.1",
        method: "GET",
        path: params.path,
        port: params.port,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_HTTP_BODY_BYTES) {
            req.destroy(new Error(`${params.path} response exceeded ${MAX_HTTP_BODY_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            latencyMs: performance.now() - startedAt,
            status: res.statusCode ?? 0,
          });
        });
      },
    );
    req.once("error", reject);
    req.once("timeout", () => req.destroy(new Error(`${params.path} request timed out`)));
    req.end();
  });
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function describeProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

function formatProbeResult(name: string, probe: TimedProbe & { status?: number }): string {
  const status = probe.status === undefined ? (probe.ok ? "ok" : "failed") : probe.status;
  return `${name}(ok=${probe.ok} status=${status} error=${probe.error ? JSON.stringify(probe.error) : "none"} latencyMs=${probe.latencyMs.toFixed(1)})`;
}

function assertBaselineProbes(baseline: GatewaySample): void {
  if (baseline.readyz.ok && baseline.sessionsList.ok && baseline.controlUi.ok) {
    return;
  }
  throw new Error(
    `gateway probes did not pass before concurrent load: ${[
      formatProbeResult("readyz", baseline.readyz),
      formatProbeResult("sessionsList", baseline.sessionsList),
      formatProbeResult("controlUi", baseline.controlUi),
    ].join("; ")}`,
  );
}

function captureChildOutput(child: ChildProcessWithoutNullStreams): () => string {
  let output = "";
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString("utf8")}`.slice(-64 * 1_024);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  return () => output;
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

function buildConfig(root: string, mockPort: number, concurrency: number): string {
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
  return writeGatewayBenchConfig(root, config, {});
}

async function connectGateway(port: number, deadlineAt: number) {
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
          requireRemainingMs(deadlineAt, `waiting for ${method}`),
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
  return { close: client.close, request: requestRpc };
}

async function runTurn(rpc: GatewayRpc, index: number, deadlineAt: number): Promise<void> {
  const requestedRunId = randomUUID();
  const started = await rpc<{ runId?: string; status?: string }>("agent", {
    sessionKey: `agent:main:gateway-concurrency-${index + 1}`,
    message: `Reply with benchmark stream ${index + 1}.`,
    deliver: false,
    idempotencyKey: requestedRunId,
  });
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
      const payload = await params.rpc("sessions.list", {}, HTTP_TIMEOUT_MS);
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
      degradedSinceMs: numberOrNull(eventLoop?.degradedSinceMs),
      delayP99Ms: numberOrNull(eventLoop?.delayP99Ms),
      utilization: numberOrNull(eventLoop?.utilization),
      cpuCoreRatio: numberOrNull(eventLoop?.cpuCoreRatio),
    },
    sessionsList: {
      atMs,
      error: sessions.error,
      latencyMs: sessions.latencyMs,
      ok: sessions.ok,
    },
  };
}

async function runGatewaySample(options: {
  cadenceMs: number;
  concurrency: number;
  deadlineAt: number;
  entry: string;
}): Promise<BenchmarkRun> {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-gateway-concurrency-"));
  const [port, mockPort] = await Promise.all([getFreePort(), getFreePort()]);
  const runStartedAt = performance.now();
  let gateway: ChildProcessWithoutNullStreams | undefined;
  let mockProvider: ChildProcessWithoutNullStreams | undefined;
  let client: Awaited<ReturnType<typeof connectGateway>> | undefined;
  let gatewayOutput = () => "";
  let mockOutput = () => "";

  try {
    const configPath = buildConfig(root, mockPort, options.concurrency);
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

    gateway = spawn(process.execPath, buildGatewayBenchChildArgs(options.entry, port), {
      cwd: process.cwd(),
      detached: process.platform !== "win32",
      env: {
        ...createGatewayBenchEnv(root, configPath, {
          caseEnv: { OPENCLAW_SKIP_CHANNELS: "1" },
        }),
        OPENAI_API_KEY: "gateway-concurrency-benchmark",
      },
    });
    gatewayOutput = captureChildOutput(gateway);
    const ready = await waitForInitialProbe({
      deadlineAt: options.deadlineAt,
      isDone: () => gateway?.exitCode != null || gateway?.signalCode != null,
      path: "/readyz",
      port,
      startAt: runStartedAt,
    });
    if (ready.status !== 200) {
      throw new Error(`gateway did not become ready\n${gatewayOutput()}`);
    }
    await waitForGatewayDispatchReady(gatewayOutput, options.deadlineAt);
    client = await connectGateway(port, options.deadlineAt);
    const rpc = client.request;
    const baseline = await sampleGateway({
      deadlineAt: options.deadlineAt,
      port,
      rpc,
      runStartedAt,
      serial: true,
    });
    assertBaselineProbes(baseline);

    const controlUi: ControlUiProbe[] = [];
    const readyz: ReadyProbe[] = [];
    const sessionsList: TimedProbe[] = [];
    let turnsDone = false;
    const turnsStartedAt = performance.now();
    const turns = Promise.all(
      Array.from({ length: options.concurrency }, (_, index) =>
        runTurn(rpc, index, options.deadlineAt),
      ),
    ).finally(() => {
      turnsDone = true;
    });
    const sampler = (async () => {
      for (;;) {
        const sampleStartedAt = performance.now();
        const sample = await sampleGateway({
          deadlineAt: options.deadlineAt,
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
            requireRemainingMs(options.deadlineAt, "sampling gateway load"),
          ),
        );
      }
    })();
    await Promise.all([turns, sampler]);
    const turnsDurationMs = performance.now() - turnsStartedAt;

    return {
      controlUi,
      durationMs: performance.now() - runStartedAt,
      readyz,
      sessionsList,
      turnCount: options.concurrency,
      turnsDurationMs,
    };
  } catch (error) {
    const detail = [
      error instanceof Error ? error.message : String(error),
      gatewayOutput() ? `gateway output:\n${gatewayOutput()}` : "",
      mockOutput() ? `mock provider output:\n${mockOutput()}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    throw new Error(detail, { cause: error });
  } finally {
    client?.close();
    if (gateway) {
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    printUsage();
    return;
  }
  const options = parseOptions(argv);
  const deadlineAt = performance.now() + options.timeoutMs;
  const runs: BenchmarkRun[] = [];
  const total = options.runs + options.warmup;
  for (let index = 0; index < total; index += 1) {
    requireRemainingMs(deadlineAt, "starting gateway run");
    const run = await runGatewaySample({ ...options, deadlineAt });
    if (index >= options.warmup) {
      runs.push(run);
      console.error(
        `[bench-gateway-concurrency] run ${runs.length}/${options.runs}: turns=${run.turnCount} samples=${run.readyz.length} duration=${run.durationMs.toFixed(1)}ms`,
      );
    } else {
      console.error(
        `[bench-gateway-concurrency] warmup ${index + 1}/${options.warmup}: duration=${run.durationMs.toFixed(1)}ms`,
      );
    }
  }
  const payload = {
    cadenceMs: options.cadenceMs,
    concurrency: options.concurrency,
    entry: options.entry,
    generatedAt: new Date().toISOString(),
    mode: "mock-streaming-agent",
    runs,
    summary: summarizeRuns(runs),
  };
  if (options.output) {
    mkdirSync(path.dirname(options.output), { recursive: true });
    writeFileSync(options.output, `${JSON.stringify(payload, null, 2)}\n`);
  }
  if (options.json || !options.output) {
    console.log(JSON.stringify(payload, null, 2));
  }
}

export const testing = {
  parseOptions,
  assertBaselineProbes,
  runTurn,
  sampleGateway,
  summarizeNumbers,
  summarizeRuns,
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
