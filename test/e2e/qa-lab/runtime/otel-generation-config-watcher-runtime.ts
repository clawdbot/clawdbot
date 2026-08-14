import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WebSocket, type RawData } from "ws";
import {
  QA_EVIDENCE_FILENAME,
  startQaGatewayChild,
  startQaMockOpenAiServer,
} from "../../../../extensions/qa-lab/api.js";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../../packages/gateway-protocol/src/version.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import {
  type CapturedLogRecord,
  type CapturedRequest,
  type CapturedSpan,
  startLocalOtlpReceiver,
} from "./otel-test-support.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "otel-generation-config-watcher";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/otel-generation-config-watcher-runtime.ts";
const FRAME_TIMEOUT_MS = 90_000;
const SIGNAL_TIMEOUT_MS = 60_000;
const RESTART_TIMEOUT_MS = 120_000;
const POST_STOP_SETTLE_MS = 500;

type RuntimeOptions = {
  artifactBase: string;
  repoRoot: string;
};

type GenerationTarget = {
  marker: string;
  parentSpanId: string;
  traceId: string;
};

type SignalRequestCounts = Record<"logs" | "metrics" | "traces", number>;

type GenerationEvidence = {
  externalParentSpanIds: string[];
  failedRequestCount: number;
  logCorrelationValid: boolean;
  logRecordCount: number;
  metricNames: string[];
  parentGraphValid: boolean;
  requiredSpanNames: string[];
  signalRequestCounts: SignalRequestCounts;
  spanCount: number;
  spanNames: string[];
  traceId: string;
  traceparentAccepted: boolean;
};

export type OtelGenerationConfigWatcherSummary = {
  collectorA?: GenerationEvidence;
  collectorB?: GenerationEvidence;
  collectorAPostReadyRequestCount: number | null;
  failures: string[];
  noRespawn: boolean;
  passed: boolean;
  pid: {
    after: number | null;
    before: number | null;
    same: boolean;
  };
  readyAfterMutation: boolean;
  restartLogObserved: boolean;
};

type RawGatewayClient = {
  frames: unknown[];
  socket: WebSocket;
};

type LocalReceiver = ReturnType<typeof startLocalOtlpReceiver> & {
  baseUrl: string;
};

const GENERATION_A: GenerationTarget = {
  marker: "OTEL-GENERATION-A-OK",
  parentSpanId: "1111111111111111",
  traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const GENERATION_B: GenerationTarget = {
  marker: "OTEL-GENERATION-B-OK",
  parentSpanId: "2222222222222222",
  traceId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function parseOptions(argv: readonly string[], repoRoot = process.cwd()): RuntimeOptions {
  let artifactBase = path.join(repoRoot, ".artifacts", "qa-e2e", "otel-generation-config-watcher");
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      const value = argv[++index];
      if (!value) {
        throw new Error("--output-dir requires a value");
      }
      artifactBase = path.resolve(repoRoot, value);
      continue;
    }
    if (arg === "--") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { artifactBase, repoRoot };
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

async function openRawGatewayClient(wsUrl: string): Promise<RawGatewayClient> {
  const socket = new WebSocket(wsUrl);
  const frames: unknown[] = [];
  socket.on("message", (data) => {
    frames.push(JSON.parse(rawDataText(data)));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { frames, socket };
}

async function waitFor<T>(params: {
  label: string;
  read: () => Promise<T | undefined> | T | undefined;
  timeoutMs: number;
  timeoutContext?: () => unknown;
}): Promise<T> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const value = await params.read();
    if (value !== undefined) {
      return value;
    }
    await sleep(50);
  }
  const context = params.timeoutContext?.();
  throw new Error(
    `timed out waiting for ${params.label}${
      context === undefined ? "" : `: ${JSON.stringify(context)}`
    }`,
  );
}

function responseFor(id: string) {
  return (frame: unknown) => isRecord(frame) && frame.type === "res" && frame.id === id;
}

async function waitForFrame(
  client: RawGatewayClient,
  predicate: (frame: unknown) => boolean,
  startIndex = 0,
  timeoutMs = FRAME_TIMEOUT_MS,
): Promise<unknown> {
  return await waitFor({
    label: "Gateway response frame",
    timeoutMs,
    read: () => client.frames.slice(startIndex).find(predicate),
    timeoutContext: () => ({
      capturedFrameCount: client.frames.length,
      socketState: client.socket.readyState,
    }),
  });
}

async function closeRawGatewayClient(client: RawGatewayClient): Promise<void> {
  const isClosed = () => client.socket.readyState === WebSocket.CLOSED;
  if (isClosed()) {
    return;
  }
  const closed = new Promise<void>((resolve) => {
    client.socket.once("close", () => resolve());
  });
  if (client.socket.readyState === WebSocket.OPEN) {
    client.socket.close();
  }
  await Promise.race([closed, sleep(1_000)]);
  if (!isClosed()) {
    client.socket.terminate();
  }
}

function sendFrame(client: RawGatewayClient, frame: unknown): void {
  client.socket.send(JSON.stringify(frame));
}

async function requestRawFrame(
  client: RawGatewayClient,
  params: {
    method: string;
    requestParams: unknown;
    timeoutMs?: number;
    traceparent?: string;
  },
): Promise<Record<string, unknown>> {
  const id = randomUUID();
  const startIndex = client.frames.length;
  sendFrame(client, {
    type: "req",
    id,
    method: params.method,
    params: params.requestParams,
    ...(params.traceparent ? { traceparent: params.traceparent } : {}),
  });
  const frame = await waitForFrame(
    client,
    responseFor(id),
    startIndex,
    params.timeoutMs ?? FRAME_TIMEOUT_MS,
  );
  assertContract(isRecord(frame), `${params.method} response was not an object`);
  return frame;
}

async function requestRaw(
  client: RawGatewayClient,
  params: {
    method: string;
    requestParams: unknown;
    timeoutMs?: number;
    traceparent?: string;
  },
): Promise<Record<string, unknown>> {
  const frame = await requestRawFrame(client, params);
  assertContract(
    frame.ok === true,
    `${params.method} failed: ${JSON.stringify(frame.error ?? frame)}`,
  );
  assertContract(isRecord(frame.payload), `${params.method} response omitted payload`);
  return frame.payload;
}

async function connectRawGateway(params: {
  token: string;
  wsUrl: string;
}): Promise<RawGatewayClient> {
  const client = await openRawGatewayClient(params.wsUrl);
  await waitForFrame(
    client,
    (frame) => isRecord(frame) && frame.type === "event" && frame.event === "connect.challenge",
  );
  const payload = await requestRaw(client, {
    method: "connect",
    requestParams: {
      minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        version: SCENARIO_ID,
        platform: process.platform,
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
      role: "operator",
      scopes: ["operator.admin"],
      auth: { token: params.token },
    },
  });
  assertContract(payload.type === "hello-ok", "Gateway connect did not return hello-ok");
  return client;
}

function traceparent(target: GenerationTarget): string {
  return `00-${target.traceId}-${target.parentSpanId}-01`;
}

async function runTracedTurn(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  target: GenerationTarget,
): Promise<void> {
  const client = await connectRawGateway({ token: gateway.token, wsUrl: gateway.wsUrl });
  try {
    const started = await requestRaw(client, {
      method: "chat.send",
      requestParams: {
        sessionKey: `agent:qa:${SCENARIO_ID}-${target.marker.toLowerCase()}-${randomUUID()}`,
        message: `Reply exactly: ${target.marker}`,
        deliver: false,
        idempotencyKey: randomUUID(),
      },
      traceparent: traceparent(target),
      timeoutMs: 30_000,
    });
    assertContract(started.status === "started", "chat.send did not start");
    assertContract(typeof started.runId === "string" && started.runId, "chat.send omitted runId");
    const completed = await requestRaw(client, {
      method: "agent.wait",
      requestParams: {
        runId: started.runId,
        timeoutMs: 60_000,
      },
      traceparent: traceparent(target),
      timeoutMs: 70_000,
    });
    assertContract(completed.status === "ok", "agent.wait did not complete successfully");
    const logProbe = await requestRawFrame(client, {
      method: "qa.otel.generation.log-probe",
      requestParams: {},
      traceparent: traceparent(target),
      timeoutMs: 10_000,
    });
    assertContract(logProbe.ok === false, "unknown-method log probe unexpectedly succeeded");
  } finally {
    await closeRawGatewayClient(client);
  }
}

async function startReceiver(): Promise<LocalReceiver> {
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  return { ...receiver, baseUrl: `http://127.0.0.1:${port}` };
}

function signalRequestCounts(requests: readonly CapturedRequest[]): SignalRequestCounts {
  return {
    logs: requests.filter((request) => request.status === 200 && request.signal === "logs").length,
    metrics: requests.filter((request) => request.status === 200 && request.signal === "metrics")
      .length,
    traces: requests.filter((request) => request.status === 200 && request.signal === "traces")
      .length,
  };
}

function isTraceId(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{32}$/u.test(value);
}

function isSpanId(value: string | undefined): value is string {
  return typeof value === "string" && /^[0-9a-f]{16}$/u.test(value);
}

function inspectParentGraph(
  spans: readonly CapturedSpan[],
  expectedExternalParentSpanId: string,
): {
  externalParentSpanIds: string[];
  valid: boolean;
} {
  const spansById = new Map(
    spans.flatMap((span) => (isSpanId(span.spanId) ? ([[span.spanId, span]] as const) : [])),
  );
  if (spansById.size !== spans.length) {
    return { externalParentSpanIds: [], valid: false };
  }
  const externalParentSpanIds = new Set<string>();
  for (const span of spans) {
    const visited = new Set<string>();
    let current: CapturedSpan | undefined = span;
    while (current) {
      if (!isSpanId(current.parentSpanId)) {
        return { externalParentSpanIds: [...externalParentSpanIds].toSorted(), valid: false };
      }
      if (visited.has(current.parentSpanId)) {
        return { externalParentSpanIds: [...externalParentSpanIds].toSorted(), valid: false };
      }
      visited.add(current.parentSpanId);
      const parent = spansById.get(current.parentSpanId);
      if (!parent) {
        externalParentSpanIds.add(current.parentSpanId);
        if (current.parentSpanId !== expectedExternalParentSpanId) {
          return { externalParentSpanIds: [...externalParentSpanIds].toSorted(), valid: false };
        }
      }
      current = parent;
    }
  }
  return {
    externalParentSpanIds: [...externalParentSpanIds].toSorted(),
    valid:
      externalParentSpanIds.size === 1 && externalParentSpanIds.has(expectedExternalParentSpanId),
  };
}

function inspectGeneration(receiver: LocalReceiver, target: GenerationTarget): GenerationEvidence {
  const spans = receiver.capturedSpans.filter((span) => span.traceId === target.traceId);
  const logs = receiver.capturedLogRecords.filter((record) => record.traceId === target.traceId);
  const graph = inspectParentGraph(spans, target.parentSpanId);
  const spanNames = [...new Set(spans.map((span) => span.name))].toSorted();
  const metricNames = [
    ...new Set(
      receiver.capturedMetrics
        .map((metric) => metric.name)
        .filter((name) => name.startsWith("openclaw.")),
    ),
  ].toSorted();
  const requiredSpanNames = ["openclaw.model.call", "openclaw.run"].filter((name) =>
    spanNames.includes(name),
  );
  const logCorrelationValid = logs.some(
    (record: CapturedLogRecord) =>
      isTraceId(record.traceId) && isSpanId(record.spanId) && record.traceId === target.traceId,
  );
  return {
    externalParentSpanIds: graph.externalParentSpanIds,
    failedRequestCount: receiver.capturedRequests.filter((request) => request.status !== 200)
      .length,
    logCorrelationValid,
    logRecordCount: logs.length,
    metricNames,
    parentGraphValid: graph.valid,
    requiredSpanNames,
    signalRequestCounts: signalRequestCounts(receiver.capturedRequests),
    spanCount: spans.length,
    spanNames,
    traceId: target.traceId,
    traceparentAccepted: spans.length > 0 && graph.valid,
  };
}

function generationReady(evidence: GenerationEvidence): boolean {
  return (
    evidence.failedRequestCount === 0 &&
    evidence.signalRequestCounts.logs > 0 &&
    evidence.signalRequestCounts.metrics > 0 &&
    evidence.signalRequestCounts.traces > 0 &&
    evidence.requiredSpanNames.length === 2 &&
    evidence.metricNames.length > 0 &&
    evidence.logCorrelationValid &&
    evidence.parentGraphValid &&
    evidence.traceparentAccepted
  );
}

async function waitForGeneration(
  receiver: LocalReceiver,
  target: GenerationTarget,
): Promise<GenerationEvidence> {
  return await waitFor({
    label: `${target.marker} OTLP signals`,
    timeoutMs: SIGNAL_TIMEOUT_MS,
    read: () => {
      const evidence = inspectGeneration(receiver, target);
      return generationReady(evidence) ? evidence : undefined;
    },
    timeoutContext: () => inspectGeneration(receiver, target),
  });
}

function withOtelEndpoint(config: OpenClawConfig, endpoint: string): OpenClawConfig {
  return {
    ...config,
    gateway: {
      ...config.gateway,
      reload: { mode: "hybrid" },
    },
    logging: {
      ...config.logging,
      level: "info",
      consoleLevel: "info",
    },
    diagnostics: {
      ...config.diagnostics,
      enabled: true,
      otel: {
        ...config.diagnostics?.otel,
        enabled: true,
        endpoint,
        tracesEndpoint: `${endpoint}/v1/traces`,
        metricsEndpoint: `${endpoint}/v1/metrics`,
        logsEndpoint: `${endpoint}/v1/logs`,
        protocol: "http/protobuf",
        traces: true,
        metrics: true,
        logs: true,
        logsExporter: "otlp",
        sampleRate: 1,
        flushIntervalMs: 250,
        captureContent: false,
      },
    },
  };
}

async function updateWatchedEndpoint(configPath: string, endpoint: string): Promise<void> {
  const parsed = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
  const next = withOtelEndpoint(parsed, endpoint);
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function stopResources(params: {
  gateway?: Awaited<ReturnType<typeof startQaGatewayChild>>;
  gatewayStopped: boolean;
  mock?: Awaited<ReturnType<typeof startQaMockOpenAiServer>>;
  receiverA?: LocalReceiver;
  receiverB?: LocalReceiver;
}): Promise<void> {
  const failures: unknown[] = [];
  if (params.gateway && !params.gatewayStopped) {
    await params.gateway.stop().catch((error: unknown) => failures.push(error));
  }
  await params.mock?.stop().catch((error: unknown) => failures.push(error));
  await params.receiverA?.close().catch((error: unknown) => failures.push(error));
  await params.receiverB?.close().catch((error: unknown) => failures.push(error));
  if (failures.length > 0) {
    throw new AggregateError(failures, "OTEL generation watcher cleanup failed");
  }
}

async function probeOtelGenerationConfigWatcher(
  options: RuntimeOptions,
): Promise<OtelGenerationConfigWatcherSummary> {
  let receiverA: LocalReceiver | undefined;
  let receiverB: LocalReceiver | undefined;
  let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  let gatewayStopped = false;
  try {
    receiverA = await startReceiver();
    receiverB = await startReceiver();
    mock = await startQaMockOpenAiServer();
    gateway = await startQaGatewayChild({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      primaryModel: "mock-openai/gpt-5.6-luna",
      alternateModel: "mock-openai/gpt-5.6-luna-alt",
      transportBaseUrl: "http://127.0.0.1",
      enabledPluginIds: ["diagnostics-otel"],
      controlUiEnabled: false,
      runtimeEnvPatch: {
        OPENCLAW_NO_RESPAWN: "1",
        OPENCLAW_OTEL_PRELOADED: "0",
        OTEL_SDK_DISABLED: "false",
      },
      mutateConfig: (config) => withOtelEndpoint(config, receiverA!.baseUrl),
    });

    const noRespawn = gateway.runtimeEnv.OPENCLAW_NO_RESPAWN === "1";
    const pidBefore = gateway.pid;
    assertContract(noRespawn, "QA Gateway did not set OPENCLAW_NO_RESPAWN=1");
    assertContract(typeof pidBefore === "number", "QA Gateway did not expose its PID");

    await runTracedTurn(gateway, GENERATION_A);
    await waitForGeneration(receiverA, GENERATION_A);

    const restartLogOffset = gateway.logs().length;
    await updateWatchedEndpoint(gateway.configPath, receiverB.baseUrl);
    const restartLogObserved = await waitFor({
      label: "in-process config watcher restart",
      timeoutMs: RESTART_TIMEOUT_MS,
      read: () =>
        gateway!
          .logs()
          .slice(restartLogOffset)
          .includes("restart mode: in-process restart (OPENCLAW_NO_RESPAWN)")
          ? true
          : undefined,
    });
    await waitFor({
      label: "post-restart Gateway readiness",
      timeoutMs: RESTART_TIMEOUT_MS,
      read: async () => {
        try {
          const response = await fetch(`${gateway!.baseUrl}/readyz`);
          return response.ok ? true : undefined;
        } catch {
          return undefined;
        }
      },
    });
    await gateway.call("config.get", {}, { timeoutMs: RESTART_TIMEOUT_MS });
    const readyAfterMutation = true;
    const readyAtMs = Date.now();
    const collectorARequestCountAtReady = receiverA.capturedRequests.length;
    const pidAfter = gateway.pid;

    await runTracedTurn(gateway, GENERATION_B);
    await waitForGeneration(receiverB, GENERATION_B);
    await sleep(1_000);
    await gateway.stop();
    gatewayStopped = true;
    await sleep(POST_STOP_SETTLE_MS);

    const collectorA = inspectGeneration(receiverA, GENERATION_A);
    const collectorB = inspectGeneration(receiverB, GENERATION_B);
    const postReadyByCursor = receiverA.capturedRequests.slice(collectorARequestCountAtReady);
    const postReadyByTimestamp = receiverA.capturedRequests.filter(
      (request) => (request.receivedAtMs ?? 0) > readyAtMs,
    );
    const collectorAPostReadyRequestCount = Math.max(
      postReadyByCursor.length,
      postReadyByTimestamp.length,
    );
    const failures: string[] = [];
    if (!generationReady(collectorA)) {
      failures.push("collector A final OTLP evidence failed the generation contract");
    }
    if (!generationReady(collectorB)) {
      failures.push("collector B final OTLP evidence failed the generation contract");
    }
    if (pidAfter !== pidBefore) {
      failures.push(`Gateway PID changed across in-process restart: ${pidBefore} -> ${pidAfter}`);
    }
    if (collectorAPostReadyRequestCount !== 0) {
      failures.push(
        `collector A received ${collectorAPostReadyRequestCount} request(s) after readiness`,
      );
    }

    return {
      collectorA,
      collectorB,
      collectorAPostReadyRequestCount,
      failures,
      noRespawn,
      passed: failures.length === 0,
      pid: {
        after: pidAfter,
        before: pidBefore,
        same: pidAfter === pidBefore,
      },
      readyAfterMutation,
      restartLogObserved,
    };
  } finally {
    await stopResources({ gateway, gatewayStopped, mock, receiverA, receiverB });
  }
}

function createWriter(options: RuntimeOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "OTEL generation config watcher",
      sourcePath: SOURCE_PATH,
      docsRefs: ["docs/gateway/opentelemetry.md", "docs/concepts/qa-e2e-automation.md"],
      codeRefs: [
        SOURCE_PATH,
        "extensions/diagnostics-otel/src/service.ts",
        "extensions/diagnostics-otel/src/service-propagation.ts",
        "extensions/qa-lab/src/gateway-child.ts",
        "test/e2e/qa-lab/runtime/otel-test-support.ts",
      ],
    },
  });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function sanitizeProofFailure(error: unknown, repoRoot: string): string {
  return formatErrorMessage(error)
    .replace(new RegExp(escapeRegExp(repoRoot), "gu"), "<repo>")
    .replace(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/giu, "<local-endpoint>")
    .replace(/qa-suite-[0-9a-f-]{20,}/giu, "<gateway-token>")
    .replace(/(?:\/private)?\/var\/folders\/[^\s'"]+/gu, "<temp-path>")
    .replace(/\/tmp\/[^\s'"]+/gu, "<temp-path>")
    .replace(/[a-z]:\\[^\s'"]+/giu, "<absolute-path>")
    .slice(0, 2_000);
}

function failedSummary(error: unknown, repoRoot: string): OtelGenerationConfigWatcherSummary {
  return {
    collectorAPostReadyRequestCount: null,
    failures: [sanitizeProofFailure(error, repoRoot)],
    noRespawn: false,
    passed: false,
    pid: {
      after: null,
      before: null,
      same: false,
    },
    readyAfterMutation: false,
    restartLogObserved: false,
  };
}

export async function runOtelGenerationConfigWatcherRuntime(options: RuntimeOptions) {
  const writer = createWriter(options);
  const startedAt = Date.now();
  let summary: OtelGenerationConfigWatcherSummary;
  try {
    summary = await probeOtelGenerationConfigWatcher(options);
  } catch (error) {
    summary = failedSummary(error, options.repoRoot);
  }

  const summaryPath = path.join(options.artifactBase, `${SCENARIO_ID}-summary.json`);
  await fs.mkdir(options.artifactBase, { recursive: true });
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writer.appendLog(
    `${SCENARIO_ID}: ${summary.passed ? "passed" : "failed"} ` +
      `samePid=${summary.pid.same} collectorAPostReady=${summary.collectorAPostReadyRequestCount}\n`,
  );
  const evidence = await writer.write({
    artifacts: [{ kind: "summary", filePath: summaryPath }],
    details: summary.passed
      ? `same PID=${summary.pid.same}; collector A post-ready requests=0; collector B signals=trace,metric,log`
      : summary.failures.join("\n"),
    durationMs: Math.max(1, Date.now() - startedAt),
    status: summary.passed ? "pass" : "fail",
  });
  return { evidence, summary };
}

async function main(): Promise<void> {
  const result = await runOtelGenerationConfigWatcherRuntime(parseOptions(process.argv.slice(2)));
  process.stdout.write(
    `${SCENARIO_ID}: ${result.summary.passed ? "passed" : "failed"}; evidence=${QA_EVIDENCE_FILENAME}\n`,
  );
  if (!result.summary.passed) {
    process.exitCode = 1;
  }
}

export const testing = {
  inspectGeneration,
  inspectParentGraph,
  parseOptions,
  sanitizeProofFailure,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${SCENARIO_ID}: ${formatErrorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
