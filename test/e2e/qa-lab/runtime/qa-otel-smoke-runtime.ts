// QA OTEL Smoke runtime supports OpenClaw repository automation.

import { spawn } from "node:child_process";
/* oxlint-disable typescript/unbound-method -- the original stream method is invoked with process.stdout through Reflect.apply below. */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  createDiagnosticsOtelService,
  type OpenClawPluginServiceContext,
} from "../../../../extensions/diagnostics-otel/runtime-api.js";
import { onTrustedInternalDiagnosticEvent } from "../../../../src/infra/diagnostic-events.js";
import { registerDiagnosticTracePropagationBridge } from "../../../../src/infra/diagnostic-trace-propagation.js";
import {
  appendCapturedBodyText,
  type CapturedLogRecord,
  type CapturedMetric,
  type CapturedRequest,
  type CapturedSpan,
  decodeRequestBody,
  type OtlpSignal,
  readPositiveIntegerEnv,
  readRequestBody,
  startLocalOtlpReceiver,
} from "./otel-test-support.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

type CollectorMode = "local" | "docker";
type OtelLogsExporter = "otlp" | "stdout" | "both";

type CliOptions = {
  collectorMode: CollectorMode;
  logsExporter: OtelLogsExporter;
  outputDir: string;
  help: boolean;
};

type OtelSmokeEvidenceContext = {
  startedAt: number;
  writer: ReturnType<typeof createQaScriptEvidenceWriter>;
};

let activeEvidenceContext: OtelSmokeEvidenceContext | undefined;

type StdoutDiagnosticLogRecord = {
  signal: "openclaw.diagnostic.log";
  ts?: unknown;
  "service.name"?: unknown;
  severityText?: unknown;
  severityNumber?: unknown;
  body?: unknown;
  attributes?: unknown;
  trace_id?: unknown;
  span_id?: unknown;
  trace_flags?: unknown;
  [key: string]: unknown;
};

const DEFAULT_DOCKER_COLLECTOR_IMAGE =
  process.env.OPENCLAW_QA_OTEL_COLLECTOR_IMAGE || "otel/opentelemetry-collector:0.104.0";
const REQUIRED_SPAN_NAMES = [
  "openclaw.run",
  "openclaw.harness.run",
  "openclaw.context.assembled",
  "openclaw.message.delivery",
] as const;
const REQUIRED_METRIC_NAMES = ["openclaw.harness.duration_ms"] as const;
const DIRECT_RUN_ID = "qa-otel-direct-run";
const DIRECT_CALL_ID = "qa-otel-direct-call";
const DIRECT_ERROR_MESSAGE = "QA OTEL provider stream failed";
const DIRECT_ERROR_SECRET = "sk-1234567890abcdef";
const DISALLOWED_ATTRIBUTE_KEYS = new Set([
  "openclaw.runId",
  "openclaw.chatId",
  "openclaw.messageId",
  "openclaw.sessionKey",
  "openclaw.sessionId",
  "openclaw.callId",
  "openclaw.toolCallId",
  "openclaw.run_id",
  "openclaw.chat_id",
  "openclaw.message_id",
  "openclaw.session_key",
  "openclaw.session_id",
  "openclaw.call_id",
  "openclaw.tool_call_id",
]);
const DISALLOWED_BODY_NEEDLES = [
  "OTEL-QA-SECRET",
  "OTEL-QA-OK",
  DIRECT_ERROR_SECRET,
  DIRECT_RUN_ID,
  DIRECT_CALL_ID,
];
const COLLECTOR_OUTPUT_TAIL_BYTES = 16_000;
const MAX_STDOUT_DIAGNOSTIC_LINE_BYTES = readPositiveIntegerEnv(
  "OPENCLAW_QA_OTEL_MAX_STDOUT_DIAGNOSTIC_LINE_BYTES",
  512 * 1024,
);
const QA_OTEL_ENV_TO_CLEAR = [
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_RESOURCE_ATTRIBUTES",
] as const;

function createOtelSmokeRunId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function usage(): string {
  return `Usage: pnpm qa:otel:smoke [--collector local|docker] [--logs-exporter otlp|stdout|both] [--output-dir <path>]

Runs the diagnostics-otel runtime producer directly, then asserts the emitted
signal shape and privacy contract. The default collector is an in-process OTLP/HTTP
receiver. Use --collector docker to put a real OpenTelemetry Collector container
in front of the receiver.
`;
}

function parseArgs(argv: string[]): CliOptions {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const options: CliOptions = {
    collectorMode: "local",
    logsExporter: "otlp",
    outputDir: path.join(".artifacts", "qa-e2e", `otel-smoke-${createOtelSmokeRunId()}`),
    help: false,
  };
  const seen = new Set<string>();
  const recordOnce = (flag: string) => {
    if (seen.has(flag)) {
      throw new Error(`${flag} was provided more than once`);
    }
    seen.add(flag);
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const readValue = () => {
      const value = args[index + 1]?.trim();
      if (!value || value.startsWith("-")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return value;
    };
    if (arg === "--output-dir") {
      const value = readValue();
      recordOnce(arg);
      options.outputDir = value;
    } else if (arg === "--collector") {
      const value = readValue();
      recordOnce(arg);
      if (value !== "local" && value !== "docker") {
        throw new Error(`--collector must be local or docker, got ${JSON.stringify(value)}`);
      }
      options.collectorMode = value;
    } else if (arg === "--logs-exporter") {
      const value = readValue();
      recordOnce(arg);
      if (value !== "otlp" && value !== "stdout" && value !== "both") {
        throw new Error(
          `--logs-exporter must be otlp, stdout, or both, got ${JSON.stringify(value)}`,
        );
      }
      options.logsExporter = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function disallowedBodyNeedles(): string[] {
  return [...DISALLOWED_BODY_NEEDLES];
}

async function reserveLocalPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to reserve local port");
  }
  const port = address.port;
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  return port;
}

async function canConnectToLocalPort(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new Socket();
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, 1000);
    socket.once("connect", () => {
      clearTimeout(timer);
      cleanup();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      cleanup();
      resolve(false);
    });
    socket.connect(port, "127.0.0.1");
  });
}

async function waitForLocalPort(port: number, timeoutMs: number, readFailure: () => string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await canConnectToLocalPort(port)) {
      return;
    }
    const failure = readFailure();
    if (failure) {
      throw new Error(failure);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  throw new Error(`timed out waiting for OpenTelemetry Collector on 127.0.0.1:${port}`);
}

function createBoundedTextAccumulator(maxBytes: number) {
  let tail = Buffer.alloc(0);
  let truncated = false;

  return {
    append(chunk: unknown): void {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
      if (buffer.length >= maxBytes) {
        tail = Buffer.from(buffer.subarray(buffer.length - maxBytes));
        truncated = true;
        return;
      }
      const nextTail = Buffer.concat([tail, buffer]);
      if (nextTail.length > maxBytes) {
        tail = Buffer.from(nextTail.subarray(nextTail.length - maxBytes));
        truncated = true;
        return;
      }
      tail = nextTail;
    },
    byteLength(): number {
      return tail.byteLength;
    },
    text(): string {
      const output = tail.toString("utf8");
      return truncated ? `...\n${output}` : output;
    },
  };
}

function trimUtf8Tail(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) {
    return value;
  }
  return buffer.subarray(buffer.length - maxBytes).toString("utf8");
}

function objectValue(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function isStdoutDiagnosticLogRecord(value: unknown): value is StdoutDiagnosticLogRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    objectValue(value, "signal") === "openclaw.diagnostic.log"
  );
}

function parseStdoutDiagnosticLogLine(line: string): StdoutDiagnosticLogRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isStdoutDiagnosticLogRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function createStdoutDiagnosticLogCapture(maxLineBytes = MAX_STDOUT_DIAGNOSTIC_LINE_BYTES) {
  const records: StdoutDiagnosticLogRecord[] = [];
  const lines: string[] = [];
  let pendingLine = "";

  const appendLine = (line: string) => {
    const record = parseStdoutDiagnosticLogLine(line);
    if (!record) {
      return;
    }
    records.push(record);
    lines.push(line.trim());
  };

  return {
    records,
    lines,
    append(chunk: unknown): void {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const parts = text.split(/\r?\n/u);
      parts[0] = `${pendingLine}${parts[0]}`;
      pendingLine = trimUtf8Tail(parts.pop() ?? "", maxLineBytes);
      for (const part of parts) {
        appendLine(trimUtf8Tail(part, maxLineBytes));
      }
    },
    flush(): void {
      const line = pendingLine;
      pendingLine = "";
      appendLine(line);
    },
  };
}

async function stopDockerContainer(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn("docker", ["stop", name], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

type StartDockerOtelCollectorDeps = {
  mkdtemp?: (prefix: string) => Promise<string>;
  platform?: NodeJS.Platform;
  randomUUID?: typeof randomUUID;
  reserveLocalPort?: typeof reserveLocalPort;
  rm?: typeof rm;
  spawn?: typeof spawn;
  stopDockerContainer?: typeof stopDockerContainer;
  tmpdir?: typeof tmpdir;
  waitForLocalPort?: typeof waitForLocalPort;
  writeFile?: typeof writeFile;
};

async function startDockerOtelCollector(
  receiverPort: number,
  deps: StartDockerOtelCollectorDeps = {},
) {
  const reservePort = deps.reserveLocalPort ?? reserveLocalPort;
  const makeTempDir = deps.mkdtemp ?? mkdtemp;
  const writeConfigFile = deps.writeFile ?? writeFile;
  const spawnProcess = deps.spawn ?? spawn;
  const waitForPort = deps.waitForLocalPort ?? waitForLocalPort;
  const stopContainer = deps.stopDockerContainer ?? stopDockerContainer;
  const removePath = deps.rm ?? rm;
  const makeUuid = deps.randomUUID ?? randomUUID;
  const osTmpdir = deps.tmpdir ?? tmpdir;

  const collectorPort = await reservePort();
  let collectorTelemetryPort = await reservePort();
  for (let attempt = 0; collectorTelemetryPort === collectorPort && attempt < 5; attempt += 1) {
    collectorTelemetryPort = await reservePort();
  }
  if (collectorTelemetryPort === collectorPort) {
    throw new Error("OpenTelemetry collector telemetry port matched receiver port after retries.");
  }
  const tempDir = await makeTempDir(path.join(osTmpdir(), "openclaw-otel-collector-"));
  const configPath = path.join(tempDir, "collector.yaml");
  const containerName = `openclaw-otel-smoke-${makeUuid()}`;
  const useHostNetwork = (deps.platform ?? process.platform) === "linux";
  const collectorEndpoint = useHostNetwork ? `127.0.0.1:${collectorPort}` : "0.0.0.0:4318";
  const receiverEndpoint = useHostNetwork
    ? `http://127.0.0.1:${receiverPort}`
    : `http://host.docker.internal:${receiverPort}`;
  const config = `receivers:
  otlp:
    protocols:
      http:
        endpoint: ${collectorEndpoint}
exporters:
  otlphttp/openclaw:
    endpoint: ${receiverEndpoint}
service:
  telemetry:
    metrics:
      address: 127.0.0.1:${collectorTelemetryPort}
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/openclaw]
    metrics:
      receivers: [otlp]
      exporters: [otlphttp/openclaw]
    logs:
      receivers: [otlp]
      exporters: [otlphttp/openclaw]
`;
  await writeConfigFile(configPath, config, "utf8");

  const output = createBoundedTextAccumulator(COLLECTOR_OUTPUT_TAIL_BYTES);
  let exitCode: number | null = null;
  const dockerArgs = [
    "run",
    "--rm",
    "--pull=missing",
    "--name",
    containerName,
    ...(useHostNetwork
      ? ["--network", "host"]
      : ["--add-host=host.docker.internal:host-gateway", "-p", `127.0.0.1:${collectorPort}:4318`]),
    "-v",
    `${configPath}:/etc/otelcol/config.yaml:ro`,
    DEFAULT_DOCKER_COLLECTOR_IMAGE,
    "--config=/etc/otelcol/config.yaml",
  ];
  const child = spawnProcess("docker", dockerArgs, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk) => output.append(chunk));
  child.stderr?.on("data", (chunk) => output.append(chunk));
  child.on("error", (err) => {
    output.append(err instanceof Error ? (err.stack ?? err.message) : String(err));
    exitCode = 1;
  });
  child.on("close", (code) => {
    exitCode = code ?? 1;
  });

  try {
    await waitForPort(collectorPort, 60_000, () => {
      if (exitCode === null) {
        return "";
      }
      const collectorOutput = output.text().trim();
      return `OpenTelemetry Collector exited before readiness (code=${exitCode})${collectorOutput ? `:\n${collectorOutput}` : ""}`;
    });
  } catch (error) {
    try {
      await stopContainer(containerName);
    } finally {
      await removePath(tempDir, { force: true, recursive: true });
    }
    throw error;
  }

  return {
    port: collectorPort,
    image: DEFAULT_DOCKER_COLLECTOR_IMAGE,
    network: useHostNetwork ? "host" : "bridge",
    output(): string {
      return output.text().trim();
    },
    async close(): Promise<void> {
      await stopContainer(containerName);
      await removePath(tempDir, { force: true, recursive: true });
    },
  };
}

function collectAttributeKeys(spans: CapturedSpan[]): Set<string> {
  const keys = new Set<string>();
  for (const span of spans) {
    for (const key of Object.keys(span.attributes)) {
      keys.add(key);
    }
  }
  return keys;
}

function printableContext(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, ".");
}

function findNeedleContexts(body: string, needles: string[]): string[] {
  const contexts: string[] = [];
  for (const needle of needles) {
    const index = body.indexOf(needle);
    if (index < 0) {
      continue;
    }
    const start = Math.max(0, index - 80);
    const end = Math.min(body.length, index + needle.length + 80);
    contexts.push(printableContext(body.slice(start, end)).replaceAll(needle, "[needle]"));
  }
  return contexts;
}

function capturedValueKind(value: string | number | boolean | string[]): string {
  return Array.isArray(value) ? "array" : typeof value;
}

function isLatestGenAiModelCallSpan(span: CapturedSpan): boolean {
  const operationName = span.attributes["gen_ai.operation.name"];
  const modelName = span.attributes["gen_ai.request.model"];
  if (typeof operationName !== "string" || typeof modelName !== "string") {
    return false;
  }
  return (
    span.name === `${operationName} ${modelName}` &&
    typeof span.attributes["openclaw.provider"] === "string" &&
    typeof span.attributes["openclaw.model"] === "string"
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createDirectProducerContext(params: {
  endpoint: string;
  logsExporter: OtelLogsExporter;
  outputDir: string;
  writeLog: (line: string) => void;
}): OpenClawPluginServiceContext {
  return {
    config: {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          endpoint: params.endpoint,
          protocol: "http/protobuf",
          traces: true,
          metrics: true,
          logs: true,
          logsExporter: params.logsExporter,
        },
      },
    },
    internalDiagnostics: {
      emit: emitTrustedDiagnosticEventWithPrivateData,
      onEvent: onTrustedInternalDiagnosticEvent,
      registerTracePropagationBridge: registerDiagnosticTracePropagationBridge,
    },
    logger: {
      debug: (...args) => params.writeLog(`${args.map(String).join(" ")}\n`),
      error: (...args) => params.writeLog(`${args.map(String).join(" ")}\n`),
      info: (...args) => params.writeLog(`${args.map(String).join(" ")}\n`),
      warn: (...args) => params.writeLog(`${args.map(String).join(" ")}\n`),
    },
    stateDir: params.outputDir,
  };
}

async function runDirectTelemetryProducer(params: {
  endpoint: string;
  logsExporter: OtelLogsExporter;
  outputDir: string;
  writeLog: (line: string) => void;
}) {
  const service = createDiagnosticsOtelService();
  const context = createDirectProducerContext(params);
  const previousEnv = new Map<string, string | undefined>();
  for (const key of QA_OTEL_ENV_TO_CLEAR) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  previousEnv.set("OTEL_SERVICE_NAME", process.env.OTEL_SERVICE_NAME);
  previousEnv.set("OTEL_SEMCONV_STABILITY_OPT_IN", process.env.OTEL_SEMCONV_STABILITY_OPT_IN);
  process.env.OTEL_SERVICE_NAME = "openclaw-qa-lab-otel-smoke";
  process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "gen_ai_latest_experimental";
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const harnessTrace = createDiagnosticTraceContext({
    traceId,
    spanId: "00f067aa0ba902b7",
    traceFlags: "01",
  });
  const runTrace = createDiagnosticTraceContext({
    traceId,
    spanId: "1111111111111111",
    parentSpanId: harnessTrace.spanId,
    traceFlags: "01",
  });
  const modelTrace = createDiagnosticTraceContext({
    traceId,
    spanId: "2222222222222222",
    parentSpanId: runTrace.spanId,
    traceFlags: "01",
  });
  await service.start(context);
  try {
    emitTrustedDiagnosticEvent({
      type: "harness.run.started",
      runId: DIRECT_RUN_ID,
      harnessId: "qa-otel-direct",
      pluginId: "diagnostics-otel",
      provider: "openai",
      model: "gpt-5.6-luna",
      channel: "qa",
      trace: harnessTrace,
    });
    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: DIRECT_RUN_ID,
      provider: "openai",
      model: "gpt-5.6-luna",
      channel: "qa",
      trace: runTrace,
    });
    emitTrustedDiagnosticEvent({
      type: "context.assembled",
      runId: DIRECT_RUN_ID,
      provider: "openai",
      model: "gpt-5.6-luna",
      channel: "qa",
      messageCount: 1,
      historyTextChars: 0,
      historyImageBlocks: 0,
      maxMessageTextChars: 0,
      systemPromptChars: 32,
      promptChars: 64,
      promptImages: 0,
      trace: runTrace,
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: DIRECT_RUN_ID,
      callId: DIRECT_CALL_ID,
      provider: "openai",
      model: "gpt-5.6-luna",
      api: "responses",
      transport: "direct",
      trace: modelTrace,
    });
    emitTrustedDiagnosticEvent({
      type: "log.record",
      level: "info",
      message: "QA OTEL direct runtime producer",
      loggerName: "qa-otel-smoke",
      trace: modelTrace,
    });
    emitTrustedDiagnosticEvent({
      type: "message.delivery.completed",
      channel: "qa",
      deliveryKind: "text",
      durationMs: 2,
      resultCount: 1,
      trace: runTrace,
    });
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "model.call.completed",
        runId: DIRECT_RUN_ID,
        callId: DIRECT_CALL_ID,
        provider: "openai",
        model: "gpt-5.6-luna",
        api: "responses",
        transport: "direct",
        durationMs: 5,
        usage: { input: 2, output: 1, total: 3 },
        trace: modelTrace,
      },
      {
        modelContent: {
          inputMessages: ["OTEL-QA-SECRET"],
          outputMessages: ["OTEL-QA-OK"],
        },
      },
    );
    const failurePrivateData = {
      errorMessage: `${DIRECT_ERROR_MESSAGE} OPENAI_API_KEY=${DIRECT_ERROR_SECRET}`,
    };
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        runId: DIRECT_RUN_ID,
        provider: "openai",
        model: "gpt-5.6-luna",
        channel: "qa",
        durationMs: 8,
        outcome: "error",
        errorCategory: "Error",
        trace: runTrace,
      },
      failurePrivateData,
    );
    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "harness.run.completed",
        runId: DIRECT_RUN_ID,
        harnessId: "qa-otel-direct",
        pluginId: "diagnostics-otel",
        provider: "openai",
        model: "gpt-5.6-luna",
        channel: "qa",
        durationMs: 10,
        outcome: "error",
        trace: harnessTrace,
      },
      failurePrivateData,
    );
    await waitForDiagnosticEventsDrained();
  } finally {
    await service.stop?.(context);
    for (const [key, value] of previousEnv) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function hasRequiredSmokeSignals(params: {
  logsExporter: OtelLogsExporter;
  receiver: ReturnType<typeof startLocalOtlpReceiver>;
}): boolean {
  const expectsOtlpLogs = params.logsExporter === "otlp" || params.logsExporter === "both";
  const receiver = params.receiver;
  const spanNames = new Set(receiver.capturedSpans.map((span) => span.name));
  const metricNames = new Set(receiver.capturedMetrics.map((metric) => metric.name));
  return (
    REQUIRED_SPAN_NAMES.every((name) => spanNames.has(name)) &&
    receiver.capturedSpans.some(isLatestGenAiModelCallSpan) &&
    REQUIRED_METRIC_NAMES.every((name) => metricNames.has(name)) &&
    (!expectsOtlpLogs || receiver.capturedLogRecords.length > 0) &&
    receiver.capturedRequests.some((request) => request.signal === "traces") &&
    receiver.capturedRequests.some((request) => request.signal === "metrics") &&
    (!expectsOtlpLogs || receiver.capturedRequests.some((request) => request.signal === "logs"))
  );
}

async function waitForExpectedTelemetry(
  receiver: ReturnType<typeof startLocalOtlpReceiver>,
  logsExporter: OtelLogsExporter,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasRequiredSmokeSignals({ logsExporter, receiver })) {
      return;
    }
    await delay(250);
  }
}

function formatBoundedList(values: readonly string[], maxItems: number): string {
  if (values.length === 0) {
    return "(none)";
  }
  const visible = values.slice(0, maxItems);
  const suffix =
    values.length > visible.length ? `, ... (${values.length - visible.length} more)` : "";
  return `${visible.join(", ")}${suffix}`;
}

function assertSmoke(params: {
  childExitCode: number;
  disallowedBodyNeedles: string[];
  logsExporter: OtelLogsExporter;
  spans: CapturedSpan[];
  metrics: CapturedMetric[];
  logRecords: CapturedLogRecord[];
  stdoutLogRecords: StdoutDiagnosticLogRecord[];
  stdoutLogLines: string[];
  requests: CapturedRequest[];
  bodyText: Partial<Record<OtlpSignal, string[]>>;
}) {
  const failures: string[] = [];
  const leakContexts: Partial<Record<OtlpSignal, string[]>> = {};
  const expectsOtlpLogs = params.logsExporter === "otlp" || params.logsExporter === "both";
  const expectsStdoutLogs = params.logsExporter === "stdout" || params.logsExporter === "both";
  if (params.childExitCode !== 0) {
    failures.push(`qa suite exited with ${params.childExitCode}`);
  }
  for (const signal of ["traces", "metrics"] as const) {
    const requests = params.requests.filter((request) => request.signal === signal);
    if (requests.length === 0) {
      failures.push(`no OTLP ${signal} requests were received`);
    }
    const emptyRequests = requests.filter((request) => request.bytes === 0);
    if (emptyRequests.length > 0) {
      failures.push(`empty OTLP ${signal} request received`);
    }
    for (const request of requests.filter((entry) => entry.status < 200 || entry.status >= 300)) {
      failures.push(`OTLP ${signal} request ${request.path} returned status ${request.status}`);
    }
  }
  const logRequests = params.requests.filter((request) => request.signal === "logs");
  if (expectsOtlpLogs && logRequests.length === 0) {
    failures.push("no OTLP logs requests were received");
  }
  if (!expectsOtlpLogs && logRequests.length > 0) {
    failures.push("OTLP logs requests were received for stdout logs exporter");
  }
  for (const request of logRequests) {
    if (request.bytes === 0) {
      failures.push("empty OTLP logs request received");
    }
    if (request.status < 200 || request.status >= 300) {
      failures.push(`OTLP logs request ${request.path} returned status ${request.status}`);
    }
  }
  if (params.spans.length === 0) {
    failures.push("no OTLP trace spans were decoded");
  }
  if (params.metrics.length === 0) {
    failures.push("no OTLP metrics were decoded");
  }
  if (expectsOtlpLogs && params.logRecords.length === 0) {
    failures.push("no OTLP log records were decoded");
  }
  if (!expectsOtlpLogs && params.logRecords.length > 0) {
    failures.push("OTLP log records were decoded for stdout logs exporter");
  }
  if (!expectsStdoutLogs && params.stdoutLogRecords.length > 0) {
    failures.push("stdout diagnostic log records were captured for OTLP logs exporter");
  }
  if (expectsStdoutLogs && params.stdoutLogRecords.length === 0) {
    failures.push("no stdout diagnostic log records were captured");
  }

  const spanNames = new Set(params.spans.map((span) => span.name));
  for (const name of REQUIRED_SPAN_NAMES) {
    if (!spanNames.has(name)) {
      failures.push(`missing required span ${name}`);
    }
  }
  const modelSpans = params.spans.filter(isLatestGenAiModelCallSpan);
  if (modelSpans.length === 0) {
    failures.push("missing required GenAI model-call span");
  }
  if (spanNames.has("openclaw.model.call")) {
    failures.push("legacy openclaw.model.call span exported with GenAI semconv opt-in");
  }
  const metricNames = new Set(params.metrics.map((metric) => metric.name));
  for (const name of REQUIRED_METRIC_NAMES) {
    if (!metricNames.has(name)) {
      failures.push(`missing required metric ${name}`);
    }
  }
  const correlatedLogRecords = params.logRecords.filter(
    (record) => record.traceId && record.spanId,
  );
  if (expectsOtlpLogs && correlatedLogRecords.length === 0) {
    failures.push("no OTLP log records included trace/span correlation ids");
  }
  for (const record of params.stdoutLogRecords) {
    if (typeof record.ts !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(record.ts)) {
      failures.push("stdout diagnostic log record missing ISO timestamp");
    }
    if (typeof record["service.name"] !== "string" || record["service.name"].trim() === "") {
      failures.push("stdout diagnostic log record missing service.name");
    }
    if (typeof record.severityText !== "string" || record.severityText.trim() === "") {
      failures.push("stdout diagnostic log record missing severityText");
    }
    if (typeof record.severityNumber !== "number") {
      failures.push("stdout diagnostic log record missing numeric severityNumber");
    }
    if (!Object.hasOwn(record, "body")) {
      failures.push("stdout diagnostic log record missing body");
    }
    if (
      typeof record.attributes !== "object" ||
      record.attributes === null ||
      Array.isArray(record.attributes)
    ) {
      failures.push("stdout diagnostic log record missing attributes object");
    }
  }

  const attributeKeys = collectAttributeKeys(params.spans);
  const disallowed = [...DISALLOWED_ATTRIBUTE_KEYS].filter((key) => attributeKeys.has(key));
  const contentKeys = [...attributeKeys].filter((key) => key.startsWith("openclaw.content."));
  if (disallowed.length > 0) {
    failures.push(`raw diagnostic id attributes exported: ${disallowed.join(", ")}`);
  }
  if (contentKeys.length > 0) {
    failures.push(`content attributes exported with capture disabled: ${contentKeys.join(", ")}`);
  }
  if (modelSpans.some((span) => Object.hasOwn(span.attributes, "gen_ai.system"))) {
    failures.push("legacy gen_ai.system attribute exported on GenAI model-call span");
  }

  const modelErrorSpans = modelSpans.filter((span) => {
    const serialized = JSON.stringify(span.attributes);
    return (
      Object.hasOwn(span.attributes, "error.type") ||
      Object.hasOwn(span.attributes, "openclaw.errorCategory") ||
      serialized.includes("StreamAbandoned")
    );
  });
  if (modelErrorSpans.length > 0) {
    failures.push("successful QA run exported model-call error attributes");
  }

  const failedRunSpans = params.spans.filter(
    (span) =>
      (span.name === "openclaw.run" || span.name === "openclaw.harness.run") &&
      span.attributes["openclaw.error"] === `${DIRECT_ERROR_MESSAGE} OPENAI_API_KEY=***`,
  );
  if (failedRunSpans.length !== 2) {
    const observed = params.spans
      .filter((span) => span.name === "openclaw.run" || span.name === "openclaw.harness.run")
      .map((span) => ({ name: span.name, error: span.attributes["openclaw.error"] }));
    failures.push(
      `run and harness spans did not export the redacted failure message: ${JSON.stringify(observed)}`,
    );
  }
  if ((params.bodyText.metrics ?? []).some((body) => body.includes(DIRECT_ERROR_MESSAGE))) {
    failures.push("run failure message leaked into OTLP metric attributes");
  }

  const serializedAttributes = JSON.stringify(params.spans.map((span) => span.attributes));
  if (serializedAttributes.includes("StreamAbandoned")) {
    failures.push("StreamAbandoned leaked into OTEL attributes");
  }

  for (const signal of ["traces", "metrics", "logs"] as const) {
    const signalBodies = (params.bodyText[signal] ?? []).join("\n");
    const leakedNeedles = params.disallowedBodyNeedles.filter((needle) =>
      signalBodies.includes(needle),
    );
    if (leakedNeedles.length > 0) {
      leakContexts[signal] = findNeedleContexts(signalBodies, leakedNeedles);
      failures.push(`OTLP ${signal} payload leaked content: ${leakedNeedles.join(", ")}`);
    }
  }
  const stdoutLogText = params.stdoutLogLines.join("\n");
  const stdoutLeakedNeedles = params.disallowedBodyNeedles.filter((needle) =>
    stdoutLogText.includes(needle),
  );
  if (stdoutLeakedNeedles.length > 0) {
    leakContexts.logs = findNeedleContexts(stdoutLogText, stdoutLeakedNeedles);
    failures.push(
      `stdout diagnostic log payload leaked content: ${stdoutLeakedNeedles.join(", ")}`,
    );
  }

  return {
    passed: failures.length === 0,
    failures,
    spanNames: [...spanNames].toSorted(),
    metricNames: [...metricNames].toSorted(),
    logRecordCount: params.logRecords.length,
    modelSpanCount: modelSpans.length,
    modelErrorSpanCount: modelErrorSpans.length,
    disallowedAttributeKeys: disallowed,
    contentAttributeKeys: contentKeys,
    leakContexts,
    signalRequestCounts: {
      traces: params.requests.filter((request) => request.signal === "traces").length,
      metrics: params.requests.filter((request) => request.signal === "metrics").length,
      logs: params.requests.filter((request) => request.signal === "logs").length,
    },
    stdoutLogRecordCount: params.stdoutLogRecords.length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }

  await mkdir(options.outputDir, { recursive: true });
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.outputDir,
    logFileName: "qa-otel-smoke.log",
    primaryModel: "gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: process.cwd(),
    target: {
      id: "qa-otel-smoke",
      title: "QA OTEL smoke evidence",
      sourcePath: "test/e2e/qa-lab/runtime/qa-otel-smoke-runtime.ts",
      docsRefs: ["docs/gateway/opentelemetry.md", "docs/concepts/qa-e2e-automation.md"],
      codeRefs: [
        "test/e2e/qa-lab/runtime/qa-otel-smoke-runtime.ts",
        "extensions/diagnostics-otel/runtime-api.ts",
        "extensions/diagnostics-otel/src/service.ts",
      ],
    },
  });
  const startedAt = Date.now();
  activeEvidenceContext = { startedAt, writer };
  const writeStdout = (chunk: unknown) => {
    writer.appendLog(chunk);
    process.stdout.write(String(chunk));
  };
  const writeStderr = (chunk: unknown) => {
    writer.appendLog(chunk);
    process.stderr.write(String(chunk));
  };
  const receiver = startLocalOtlpReceiver(disallowedBodyNeedles());
  const port = await receiver.listen();
  writeStdout(`qa-otel-smoke: local OTLP receiver listening on http://127.0.0.1:${port}\n`);

  let collector: Awaited<ReturnType<typeof startDockerOtelCollector>> | undefined;
  let childExitCode = 1;
  const stdoutDiagnosticLogs = createStdoutDiagnosticLogCapture();
  try {
    let exportPort = port;
    if (options.collectorMode === "docker") {
      collector = await startDockerOtelCollector(port);
      exportPort = collector.port;
      writeStdout(
        `qa-otel-smoke: OpenTelemetry Collector ${collector.image} listening on http://127.0.0.1:${exportPort} (${collector.network} network)\n`,
      );
    }

    const originalStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      stdoutDiagnosticLogs.append(chunk);
      return Reflect.apply(originalStdoutWrite, process.stdout, [chunk, ...args]) as boolean;
    }) as typeof process.stdout.write;
    try {
      await runDirectTelemetryProducer({
        endpoint: `http://127.0.0.1:${exportPort}`,
        logsExporter: options.logsExporter,
        outputDir: options.outputDir,
        writeLog: writeStdout,
      });
      childExitCode = 0;
    } finally {
      process.stdout.write = originalStdoutWrite;
      stdoutDiagnosticLogs.flush();
    }
    await waitForExpectedTelemetry(receiver, options.logsExporter, 15_000);
  } finally {
    try {
      await collector?.close();
    } finally {
      await receiver.close();
    }
  }

  const assertion = assertSmoke({
    childExitCode,
    disallowedBodyNeedles: disallowedBodyNeedles(),
    logsExporter: options.logsExporter,
    spans: receiver.capturedSpans,
    metrics: receiver.capturedMetrics,
    logRecords: receiver.capturedLogRecords,
    stdoutLogRecords: stdoutDiagnosticLogs.records,
    stdoutLogLines: stdoutDiagnosticLogs.lines,
    requests: receiver.capturedRequests,
    bodyText: receiver.capturedBodyText,
  });
  const summary = {
    passed: assertion.passed,
    failures: assertion.failures,
    outputDir: options.outputDir,
    producer: "diagnostics-otel-direct",
    collectorMode: options.collectorMode,
    logsExporter: options.logsExporter,
    requests: receiver.capturedRequests,
    spanCount: receiver.capturedSpans.length,
    metricCount: receiver.capturedMetrics.length,
    logRecordCount: receiver.capturedLogRecords.length,
    stdoutLogRecordCount: stdoutDiagnosticLogs.records.length,
    logRecordsWithTraceContext: receiver.capturedLogRecords.filter(
      (record) => record.traceId && record.spanId,
    ).length,
    spanNames: assertion.spanNames,
    metricNames: assertion.metricNames,
    signalRequestCounts: assertion.signalRequestCounts,
    modelSpanCount: assertion.modelSpanCount,
    modelErrorSpanCount: assertion.modelErrorSpanCount,
    stdoutLogRecordCountFromAssertion: assertion.stdoutLogRecordCount,
    disallowedAttributeKeys: assertion.disallowedAttributeKeys,
    contentAttributeKeys: assertion.contentAttributeKeys,
    leakContexts: assertion.leakContexts,
    collector: collector
      ? {
          image: collector.image,
          network: collector.network,
          output: assertion.passed ? undefined : collector.output(),
        }
      : undefined,
    spans: receiver.capturedSpans.map((span) => ({
      name: span.name,
      parent: span.parent,
      attributeKeys: Object.keys(span.attributes).toSorted(),
    })),
    logBodyKinds: [
      ...new Set(receiver.capturedLogRecords.map((record) => capturedValueKind(record.body))),
    ],
    stdoutLogBodyKinds: [
      ...new Set(
        stdoutDiagnosticLogs.records.map((record) =>
          Array.isArray(record.body) ? "array" : typeof record.body,
        ),
      ),
    ],
  };
  const summaryPath = path.join(options.outputDir, "otel-smoke-summary.json");
  await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  writeStdout(`qa-otel-smoke: summary ${summaryPath}\n`);

  if (!assertion.passed) {
    for (const failure of assertion.failures) {
      writeStderr(`qa-otel-smoke: ${failure}\n`);
    }
    writeStderr(
      `qa-otel-smoke: captured request counts traces=${assertion.signalRequestCounts.traces} ` +
        `metrics=${assertion.signalRequestCounts.metrics} logs=${assertion.signalRequestCounts.logs}\n`,
    );
    writeStderr(
      `qa-otel-smoke: captured decoded counts spans=${receiver.capturedSpans.length} ` +
        `metrics=${receiver.capturedMetrics.length} logs=${receiver.capturedLogRecords.length} ` +
        `stdoutLogs=${stdoutDiagnosticLogs.records.length}\n`,
    );
    writeStderr(
      `qa-otel-smoke: captured span names: ${formatBoundedList(assertion.spanNames, 40)}\n`,
    );
    writeStderr(
      `qa-otel-smoke: captured metric names: ${formatBoundedList(assertion.metricNames, 40)}\n`,
    );
    for (const [signal, contexts] of Object.entries(assertion.leakContexts)) {
      for (const context of contexts ?? []) {
        writeStderr(`qa-otel-smoke: ${signal} leak context: ${context}\n`);
      }
    }
    const collectorOutput = collector?.output();
    if (collectorOutput) {
      writeStderr(`qa-otel-smoke: collector output:\n${collectorOutput}\n`);
    }
    await writer.write({
      artifacts: [{ kind: "summary", filePath: path.resolve(summaryPath) }],
      details: assertion.failures.join("\n"),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
    activeEvidenceContext = undefined;
    process.exitCode = 1;
    return;
  }
  writeStdout(
    `qa-otel-smoke: passed spans=${receiver.capturedSpans.length} ` +
      `metrics=${receiver.capturedMetrics.length} logs=${receiver.capturedLogRecords.length} ` +
      `stdoutLogs=${stdoutDiagnosticLogs.records.length} ` +
      `traces=${assertion.signalRequestCounts.traces} ` +
      `metricRequests=${assertion.signalRequestCounts.metrics} ` +
      `logRequests=${assertion.signalRequestCounts.logs}\n`,
  );
  await writer.write({
    artifacts: [{ kind: "summary", filePath: path.resolve(summaryPath) }],
    details: `captured spans=${receiver.capturedSpans.length} metrics=${receiver.capturedMetrics.length} logs=${receiver.capturedLogRecords.length}`,
    durationMs: Math.max(1, Date.now() - startedAt),
    status: "pass",
  });
  activeEvidenceContext = undefined;
}

export const testing = {
  appendCapturedBodyText,
  assertSmoke,
  createBoundedTextAccumulator,
  createStdoutDiagnosticLogCapture,
  decodeRequestBody,
  parseArgs,
  parseStdoutDiagnosticLogLine,
  readPositiveIntegerEnv,
  readRequestBody,
  startLocalOtlpReceiver,
  startDockerOtelCollector,
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch(async (error: unknown) => {
    const details = error instanceof Error ? error.stack || error.message : String(error);
    process.stderr.write(`qa-otel-smoke: ${details}\n`);
    const evidenceContext = activeEvidenceContext;
    if (evidenceContext) {
      evidenceContext.writer.appendLog(`qa-otel-smoke: ${details}\n`);
      await evidenceContext.writer
        .write({
          details,
          durationMs: Math.max(1, Date.now() - evidenceContext.startedAt),
          status: "fail",
        })
        .catch(() => undefined);
      activeEvidenceContext = undefined;
    }
    process.exitCode = 1;
  });
}
