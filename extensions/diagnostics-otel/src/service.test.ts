// Diagnostics Otel tests cover service plugin behavior.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const telemetryState = vi.hoisted(() => {
  type TestSpanContext = {
    traceId: string;
    spanId: string;
    traceFlags: number;
  };
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
  const spans: Array<{
    name: string;
    addEvent: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    setAttributes: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    spanContext: ReturnType<typeof vi.fn<() => TestSpanContext>>;
  }> = [];
  const tracer = {
    startSpan: vi.fn((name: string, _opts?: unknown, _ctx?: unknown) => {
      const spanNumber = spans.length + 1;
      const spanId = spanNumber.toString(16).padStart(16, "0");
      const span = {
        addEvent: vi.fn(),
        end: vi.fn(),
        setAttributes: vi.fn(),
        setStatus: vi.fn(),
        spanContext: vi.fn<() => TestSpanContext>(() => ({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId,
          traceFlags: 1,
        })),
      };
      spans.push({ name, ...span });
      return span;
    }),
    setSpanContext: vi.fn((_ctx: unknown, spanContext: unknown) => ({ spanContext })),
  };
  const meter = {
    createCounter: vi.fn((name: string) => {
      const counter = { add: vi.fn() };
      counters.set(name, counter);
      return counter;
    }),
    createHistogram: vi.fn((name: string) => {
      const histogram = { record: vi.fn() };
      histograms.set(name, histogram);
      return histogram;
    }),
  };
  return { counters, histograms, spans, tracer, meter };
});

const sdkStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const sdkShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const logEmit = vi.hoisted(() => vi.fn());
const logShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const traceExporterCtor = vi.hoisted(() => vi.fn());
const metricExporterCtor = vi.hoisted(() => vi.fn());
const logExporterCtor = vi.hoisted(() => vi.fn());
const logProcessorCtor = vi.hoisted(() => vi.fn());
const spanProcessorCtor = vi.hoisted(() => vi.fn());
const nodeProxyAgent = vi.hoisted(() => ({ kind: "node-proxy-agent" }));
const createNodeProxyAgentMock = vi.hoisted(() => vi.fn());
const unhandledRejectionHandlerState = vi.hoisted(() => {
  let handlers: Array<(reason: unknown) => boolean> = [];
  return {
    getHandlers: () => handlers,
    register: vi.fn((handler: (reason: unknown) => boolean) => {
      handlers.push(handler);
      return () => {
        handlers = handlers.filter((candidate) => candidate !== handler);
      };
    }),
    reset: () => {
      handlers = [];
    },
  };
});

vi.mock("@opentelemetry/api", () => ({
  context: {
    active: () => ({}),
  },
  metrics: {
    getMeter: () => telemetryState.meter,
  },
  trace: {
    getTracer: () => telemetryState.tracer,
    setSpanContext: telemetryState.tracer.setSpanContext,
  },
  TraceFlags: {
    NONE: 0,
    SAMPLED: 1,
  },
  SpanStatusCode: {
    ERROR: 2,
  },
  SpanKind: {
    CLIENT: 2,
  },
}));

vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    start = sdkStart;
    shutdown = sdkShutdown;
  },
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-proto", () => ({
  OTLPMetricExporter: function OTLPMetricExporter(options?: unknown) {
    metricExporterCtor(options);
  },
}));

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: function OTLPTraceExporter(options?: unknown) {
    traceExporterCtor(options);
  },
}));

vi.mock("@opentelemetry/exporter-logs-otlp-proto", () => ({
  OTLPLogExporter: function OTLPLogExporter(options?: unknown) {
    logExporterCtor(options);
  },
}));

vi.mock("openclaw/plugin-sdk/runtime-env", () => ({
  registerUnhandledRejectionHandler: unhandledRejectionHandlerState.register,
}));

vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({
  createNodeProxyAgent: createNodeProxyAgentMock,
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: function BatchLogRecordProcessor(options?: unknown) {
    logProcessorCtor(options);
  },
  LoggerProvider: class {
    getLogger = vi.fn(() => ({
      emit: logEmit,
    }));
    shutdown = logShutdown;
  },
}));

vi.mock("@opentelemetry/sdk-metrics", () => ({
  PeriodicExportingMetricReader: function PeriodicExportingMetricReader() {},
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BatchSpanProcessor: function BatchSpanProcessor(exporter?: unknown, options?: unknown) {
    spanProcessorCtor(exporter, options);
  },
  ParentBasedSampler: function ParentBasedSampler() {},
  TraceIdRatioBasedSampler: function TraceIdRatioBasedSampler() {},
}));

vi.mock("@opentelemetry/resources", () => ({
  resourceFromAttributes: vi.fn((attrs: Record<string, unknown>) => attrs),
  Resource: function Resource(_value?: unknown) {
    // Constructor shape required by the mocked OpenTelemetry API.
  },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  ATTR_SERVICE_NAME: "service.name",
}));

import {
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  emitDiagnosticEventWithTrustedTraceContext,
  emitInternalDiagnosticEventForTest,
  emitTrustedSecurityEvent,
  logMessageDispatchStarted,
  logMessageProcessed,
  runWithDiagnosticTraceContext,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { emitDiagnosticEvent } from "../api.js";
import { createDiagnosticsOtelService } from "./service.js";
import {
  CHILD_SPAN_ID,
  createOtelContext,
  createTestTrace,
  GRANDCHILD_SPAN_ID,
  INPUT_ONLY_CAPTURE,
  MODEL_CALL_SPAN_ID,
  MODEL_CALL_FIXTURE,
  MODEL_CONTENT_CAPTURE,
  MODEL_FIXTURE,
  MODEL_USAGE_SPAN_ID,
  type OtelContextFlags,
  OTEL_TEST_ENDPOINT,
  RUN_FIXTURE,
  SPAN_ID,
  startOtelService,
  stopStartedOtelServices,
  TOOL_SPAN_ID,
  TRACE_ID,
} from "./service.test-helpers.js";

function numberedSpanId(index: number) {
  return (index + 0x1000).toString(16).padStart(16, "0");
}
const PROTO_KEY = "__proto__";
const MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS = 128 * 1024;
const OTEL_TRUNCATED_SUFFIX_MAX_CHARS = 20;
const ORIGINAL_OPENCLAW_OTEL_PRELOADED = process.env.OPENCLAW_OTEL_PRELOADED;
const ORIGINAL_OTEL_EXPORTER_OTLP_PROTOCOL = process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
const ORIGINAL_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const ORIGINAL_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
const ORIGINAL_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
const ORIGINAL_OTEL_SEMCONV_STABILITY_OPT_IN = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
const OTEL_CERT_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_LOGS_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY",
] as const;
const ORIGINAL_OTEL_CERT_ENV = Object.fromEntries(
  OTEL_CERT_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof OTEL_CERT_ENV_KEYS)[number], string | undefined>;

function startedSpanCall(name: string) {
  const calls = telemetryState.tracer.startSpan.mock.calls as unknown as Array<
    [
      string,
      { attributes?: Record<string, unknown>; kind?: unknown; startTime?: unknown }?,
      unknown?,
    ]
  >;
  return calls.find(([spanName]) => spanName === name);
}

function startedSpanOptions(name: string) {
  return startedSpanCall(name)?.[1];
}

function startedSpanParentContexts(name: string) {
  return telemetryState.tracer.startSpan.mock.calls
    .filter((call) => call[0] === name)
    .map(
      (call) =>
        (call[2] as { spanContext?: { traceId?: string; spanId?: string } } | undefined)
          ?.spanContext,
    );
}

function startedSpanParentContextsByName(name: string) {
  return telemetryState.tracer.startSpan.mock.calls
    .filter((call) => call[0] === name)
    .map((call) => ({
      attributes: (call[1] as { attributes?: Record<string, unknown> } | undefined)?.attributes,
      parentContext: (
        call[2] as { spanContext?: { traceId?: string; spanId?: string } } | undefined
      )?.spanContext,
    }));
}

function mockCall(mock: { mock: { calls: unknown[][] } }, callIndex = 0): unknown[] {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call at index ${callIndex}`);
  }
  return call;
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, argIndex: number, callIndex = 0) {
  return mockCall(mock, callIndex)[argIndex];
}

type TestExporterOptions = {
  url?: string;
  httpAgentOptions?: (protocol: string) => unknown;
};

function firstExporterOptions(mock: { mock: { calls: unknown[][] } }): TestExporterOptions {
  return mockCallArg(mock, 0) as TestExporterOptions;
}

function createNodeProxyAgentCalls(): Array<{
  mode?: string;
  targetUrl?: string;
  agentOptions?: {
    keepAlive?: boolean;
    ca?: Buffer;
    cert?: Buffer;
    key?: Buffer;
  };
}> {
  return createNodeProxyAgentMock.mock.calls.map(
    ([options]) =>
      options as {
        mode?: string;
        targetUrl?: string;
        agentOptions?: {
          keepAlive?: boolean;
          ca?: Buffer;
          cert?: Buffer;
          key?: Buffer;
        };
      },
  );
}

function findCreateNodeProxyAgentCall(targetUrl: string) {
  const call = createNodeProxyAgentCalls().find((candidate) => candidate.targetUrl === targetUrl);
  if (!call) {
    throw new Error(`Expected createNodeProxyAgent call for ${targetUrl}`);
  }
  return call;
}

function firstSpanProcessorOptions(): { scheduledDelayMillis?: number } {
  return mockCallArg(spanProcessorCtor, 1) as { scheduledDelayMillis?: number };
}

function firstLogProcessorOptions(): { exporter?: unknown; scheduledDelayMillis?: number } {
  return mockCallArg(logProcessorCtor, 0) as {
    exporter?: unknown;
    scheduledDelayMillis?: number;
  };
}

function firstSetSpanContext(): Record<string, unknown> {
  return mockCallArg(telemetryState.tracer.setSpanContext, 1) as Record<string, unknown>;
}

function spanByName(name: string): (typeof telemetryState.spans)[number] {
  const span = telemetryState.spans.find((candidate) => candidate.name === name);
  if (!span) {
    throw new Error(`Expected span ${name}`);
  }
  return span;
}

function firstSpanAttributes(name: string): Record<string, unknown> {
  return mockCallArg(spanByName(name).setAttributes, 0) as Record<string, unknown>;
}

function stringAttribute(attrs: Record<string, unknown> | undefined, key: string): string {
  const value = attrs?.[key];
  expect(value).toEqual(expect.any(String));
  return value as string;
}

function firstSpanEndTime(name: string): unknown {
  return mockCallArg(spanByName(name).end, 0);
}

function firstCounterAddCall(name: string): [unknown, Record<string, unknown>?] {
  const counter = telemetryState.counters.get(name);
  if (!counter) {
    throw new Error(`Expected counter ${name}`);
  }
  return mockCall(counter.add) as [unknown, Record<string, unknown>?];
}

function lastHistogramRecord(name: string) {
  return telemetryState.histograms.get(name)?.record.mock.calls.at(-1) as
    | [unknown, Record<string, unknown>?]
    | undefined;
}

function histogramCreateOptions(name: string) {
  const calls = telemetryState.meter.createHistogram.mock.calls as unknown as Array<
    [string, unknown?]
  >;
  const call = calls.find(([histogramName]) => histogramName === name);
  return call?.[1] as
    | { unit?: unknown; advice?: { explicitBucketBoundaries?: unknown[] } }
    | undefined;
}

type StdoutDiagnosticLogLine = {
  ts?: string;
  signal?: string;
  "service.name"?: string;
  severityText?: string;
  severityNumber?: number;
  body?: unknown;
  attributes?: Record<string, unknown>;
  trace_id?: string;
  span_id?: string;
  trace_flags?: string;
};

function captureStdoutWrites() {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write);
  return { writes, spy };
}

function parseSingleStdoutDiagnosticLogLine(writes: string[]): StdoutDiagnosticLogLine {
  expect(writes).toHaveLength(1);
  expect(writes[0]?.endsWith("\n")).toBe(true);
  const line = writes[0]?.slice(0, -1) ?? "";
  expect(line).not.toContain("\n");
  return JSON.parse(line) as StdoutDiagnosticLogLine;
}

async function emitAndCaptureLog(
  event: Omit<Extract<Parameters<typeof emitDiagnosticEvent>[0], { type: "log.record" }>, "type">,
  options: {
    captureContent?: OtelContextFlags["captureContent"];
    trusted?: boolean;
    trustedTraceContext?: boolean;
  } = {},
) {
  await startOtelService({
    logs: true,
    ...(options.captureContent !== undefined ? { captureContent: options.captureContent } : {}),
  });
  const emit = options.trusted
    ? emitTrustedDiagnosticEvent
    : options.trustedTraceContext
      ? emitDiagnosticEventWithTrustedTraceContext
      : emitDiagnosticEvent;
  emit({
    type: "log.record",
    ...event,
  });
  await flushDiagnosticEvents();
  expect(logEmit).toHaveBeenCalled();
  const emitCall = mockCallArg(logEmit, 0) as {
    attributes?: Record<string, unknown>;
    body?: string;
    context?: unknown;
  };
  return emitCall;
}

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function emitAndFlush(event: Parameters<typeof emitDiagnosticEvent>[0]) {
  emitDiagnosticEvent(event);
  await flushDiagnosticEvents();
}

async function emitTrustedAndFlush(event: Parameters<typeof emitTrustedDiagnosticEvent>[0]) {
  emitTrustedDiagnosticEvent(event);
  await flushDiagnosticEvents();
}

type TrustedEvent = Parameters<typeof emitTrustedDiagnosticEvent>[0];
type TrustedEventOf<T extends TrustedEvent["type"]> = Extract<TrustedEvent, { type: T }>;

function emitRunStarted(overrides: Partial<Omit<TrustedEventOf<"run.started">, "type">> = {}) {
  emitTrustedDiagnosticEvent({
    type: "run.started",
    ...RUN_FIXTURE,
    trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
    ...overrides,
  });
}

function emitRunCompleted(overrides: Partial<Omit<TrustedEventOf<"run.completed">, "type">> = {}) {
  emitTrustedDiagnosticEvent({
    type: "run.completed",
    ...RUN_FIXTURE,
    outcome: "completed",
    durationMs: 100,
    trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
    ...overrides,
  });
}

function emitQueuedRunWithModelCalls() {
  emitRunStarted();
  for (let index = 0; index < 125; index += 1) {
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: `call-${index}`,
      ...MODEL_FIXTURE,
      durationMs: 80,
      trace: createTestTrace(numberedSpanId(index), CHILD_SPAN_ID),
    });
  }
  emitRunCompleted();
}

function emitDefaultModelUsage() {
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.4",
    usage: { input: 3, output: 2, total: 5 },
    durationMs: 10,
    trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
  });
}

function emitTrustedModelCallCompletedWithContent(
  event: Omit<
    Extract<Parameters<typeof emitDiagnosticEvent>[0], { type: "model.call.completed" }>,
    "type"
  >,
  modelContent: NonNullable<DiagnosticEventPrivateData["modelContent"]>,
) {
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "model.call.completed",
      ...event,
    },
    { modelContent },
  );
}

function emitTrustedToolExecutionCompletedWithContent(
  event: Omit<
    Extract<Parameters<typeof emitDiagnosticEvent>[0], { type: "tool.execution.completed" }>,
    "type"
  >,
  toolContent: NonNullable<DiagnosticEventPrivateData["toolContent"]>,
) {
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "tool.execution.completed",
      ...event,
    },
    { toolContent },
  );
}

afterAll(() => {
  vi.doUnmock("@opentelemetry/api");
  vi.doUnmock("@opentelemetry/sdk-node");
  vi.doUnmock("@opentelemetry/exporter-metrics-otlp-proto");
  vi.doUnmock("@opentelemetry/exporter-trace-otlp-proto");
  vi.doUnmock("@opentelemetry/exporter-logs-otlp-proto");
  vi.doUnmock("@opentelemetry/sdk-logs");
  vi.doUnmock("@opentelemetry/sdk-metrics");
  vi.doUnmock("@opentelemetry/sdk-trace-base");
  vi.doUnmock("openclaw/plugin-sdk/fetch-runtime");
  vi.doUnmock("@opentelemetry/resources");
  vi.doUnmock("@opentelemetry/semantic-conventions");
  vi.resetModules();
});

describe("diagnostics-otel service", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    delete process.env.OPENCLAW_OTEL_PRELOADED;
    delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
    delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    telemetryState.counters.clear();
    telemetryState.histograms.clear();
    telemetryState.spans.length = 0;
    telemetryState.tracer.startSpan.mockClear();
    telemetryState.tracer.setSpanContext.mockClear();
    telemetryState.meter.createCounter.mockClear();
    telemetryState.meter.createHistogram.mockClear();
    sdkStart.mockClear();
    sdkShutdown.mockClear();
    logEmit.mockReset();
    logShutdown.mockClear();
    traceExporterCtor.mockClear();
    metricExporterCtor.mockClear();
    logExporterCtor.mockClear();
    logProcessorCtor.mockClear();
    spanProcessorCtor.mockClear();
    createNodeProxyAgentMock.mockReset();
    createNodeProxyAgentMock.mockReturnValue(undefined);
    unhandledRejectionHandlerState.reset();
    unhandledRejectionHandlerState.register.mockClear();
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    for (const key of OTEL_CERT_ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(async () => {
    await stopStartedOtelServices();
    resetDiagnosticEventsForTest();
    if (ORIGINAL_OPENCLAW_OTEL_PRELOADED === undefined) {
      delete process.env.OPENCLAW_OTEL_PRELOADED;
    } else {
      process.env.OPENCLAW_OTEL_PRELOADED = ORIGINAL_OPENCLAW_OTEL_PRELOADED;
    }
    if (ORIGINAL_OTEL_EXPORTER_OTLP_PROTOCOL === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_PROTOCOL;
    } else {
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = ORIGINAL_OTEL_EXPORTER_OTLP_PROTOCOL;
    }
    if (ORIGINAL_OTEL_SEMCONV_STABILITY_OPT_IN === undefined) {
      delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    } else {
      process.env.OTEL_SEMCONV_STABILITY_OPT_IN = ORIGINAL_OTEL_SEMCONV_STABILITY_OPT_IN;
    }
    if (ORIGINAL_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = ORIGINAL_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    }
    if (ORIGINAL_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT =
        ORIGINAL_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    }
    if (ORIGINAL_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = ORIGINAL_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
    }
    for (const key of OTEL_CERT_ENV_KEYS) {
      const value = ORIGINAL_OTEL_CERT_ENV[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  test("drops camelCase and snake_case diagnostic id log attributes before export", async () => {
    const emitCall = await emitAndCaptureLog({
      level: "INFO",
      message: "diagnostic id attributes",
      attributes: {
        callId: "call-camel",
        call_id: "call-snake",
        chatId: "chat-camel",
        chat_id: "chat-snake",
        messageId: "message-camel",
        message_id: "message-snake",
        parentSpanId: "parent-camel",
        parent_span_id: "parent-snake",
        runId: "run-camel",
        run_id: "run-snake",
        sessionId: "session-camel",
        session_id: "session-snake",
        sessionKey: "session-key-camel",
        session_key: "session-key-snake",
        spanId: "span-camel",
        span_id: "span-snake",
        toolCallId: "tool-camel",
        tool_call_id: "tool-snake",
        traceId: "trace-camel",
        trace_id: "trace-snake",
        provider: "openai",
      },
    });

    expect(emitCall.attributes?.["openclaw.provider"]).toBe("openai");
    for (const key of [
      "openclaw.callId",
      "openclaw.call_id",
      "openclaw.chatId",
      "openclaw.chat_id",
      "openclaw.messageId",
      "openclaw.message_id",
      "openclaw.parentSpanId",
      "openclaw.parent_span_id",
      "openclaw.runId",
      "openclaw.run_id",
      "openclaw.sessionId",
      "openclaw.session_id",
      "openclaw.sessionKey",
      "openclaw.session_key",
      "openclaw.spanId",
      "openclaw.span_id",
      "openclaw.toolCallId",
      "openclaw.tool_call_id",
      "openclaw.traceId",
      "openclaw.trace_id",
    ]) {
      expect(Object.hasOwn(emitCall.attributes ?? {}, key)).toBe(false);
    }
  });

  test("records message-flow metrics and spans", async () => {
    await startOtelService({ traces: true, metrics: true, logs: true });

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
      updateType: "telegram-post",
    });
    emitDiagnosticEvent({
      type: "webhook.processed",
      channel: "telegram",
      updateType: "telegram-post",
      chatId: "chat-should-not-export",
      durationMs: 120,
    });
    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      queueDepth: 2,
    });
    emitDiagnosticEvent({
      type: "message.received",
      channel: "telegram",
      source: "webhook",
    });
    emitDiagnosticEvent({
      type: "message.dispatch.started",
      channel: "telegram",
      source: "webhook",
    });
    emitDiagnosticEvent({
      type: "message.dispatch.completed",
      channel: "telegram",
      source: "webhook",
      durationMs: 25,
      outcome: "completed",
    });
    emitDiagnosticEvent({
      type: "message.received",
      channel: "telegram/custom",
      source: "webhook with secret sk-test",
    });
    emitDiagnosticEvent({
      type: "message.dispatch.started",
      channel: "telegram/custom",
      source: "webhook with secret sk-test",
    });
    emitDiagnosticEvent({
      type: "message.dispatch.completed",
      channel: "telegram/custom",
      source: "webhook with secret sk-test",
      durationMs: 30,
      outcome: "completed",
      reason: "progress draft / message tool 123",
    });
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      chatId: "chat-should-not-export",
      messageId: "message-should-not-export",
      outcome: "completed",
      reason: "progress draft / message tool 123",
      durationMs: 55,
    });
    emitDiagnosticEvent({
      type: "queue.lane.dequeue",
      lane: "main",
      queueSize: 3,
      waitMs: 10,
    });
    emitDiagnosticEvent({
      type: "session.stuck",
      state: "processing",
      ageMs: 125_000,
      classification: "stale_session_state",
    });
    emitDiagnosticEvent({
      type: "run.attempt",
      runId: "run-1",
      attempt: 2,
    });

    expect(telemetryState.counters.get("openclaw.webhook.received")?.add).toHaveBeenCalledWith(1, {
      "openclaw.channel": "telegram",
      "openclaw.webhook": "telegram-post",
    });
    expect(
      telemetryState.histograms.get("openclaw.webhook.duration_ms")?.record,
    ).toHaveBeenCalledWith(120, {
      "openclaw.channel": "telegram",
      "openclaw.webhook": "telegram-post",
    });
    expect(telemetryState.counters.get("openclaw.message.queued")?.add).toHaveBeenCalledWith(1, {
      "openclaw.channel": "telegram",
      "openclaw.source": "telegram",
    });
    expect(telemetryState.histograms.get("openclaw.queue.depth")?.record).toHaveBeenCalledTimes(2);
    expect(telemetryState.histograms.get("openclaw.queue.depth")?.record).toHaveBeenCalledWith(2, {
      "openclaw.channel": "telegram",
      "openclaw.source": "telegram",
    });
    expect(telemetryState.histograms.get("openclaw.queue.depth")?.record).toHaveBeenCalledWith(3, {
      "openclaw.lane": "main",
    });
    expect(telemetryState.counters.get("openclaw.message.processed")?.add).toHaveBeenCalledWith(1, {
      "openclaw.channel": "telegram",
      "openclaw.outcome": "completed",
    });
    expect(telemetryState.counters.get("openclaw.message.received")?.add).toHaveBeenCalledWith(1, {
      "openclaw.channel": "telegram",
      "openclaw.source": "webhook",
    });
    expect(telemetryState.counters.get("openclaw.message.received")?.add).toHaveBeenCalledWith(1, {
      "openclaw.channel": "unknown",
      "openclaw.source": "unknown",
    });
    expect(
      telemetryState.counters.get("openclaw.message.dispatch.started")?.add,
    ).toHaveBeenCalledWith(1, {
      "openclaw.channel": "telegram",
      "openclaw.source": "webhook",
    });
    expect(
      telemetryState.counters.get("openclaw.message.dispatch.started")?.add,
    ).toHaveBeenCalledWith(1, {
      "openclaw.channel": "unknown",
      "openclaw.source": "unknown",
    });
    expect(
      telemetryState.counters.get("openclaw.message.dispatch.completed")?.add,
    ).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        "openclaw.channel": "telegram",
        "openclaw.outcome": "completed",
        "openclaw.source": "webhook",
      }),
    );
    expect(
      telemetryState.counters.get("openclaw.message.dispatch.completed")?.add,
    ).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        "openclaw.channel": "unknown",
        "openclaw.reason": "none",
        "openclaw.source": "unknown",
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.message.dispatch.duration_ms")?.record,
    ).toHaveBeenCalledWith(
      25,
      expect.objectContaining({
        "openclaw.channel": "telegram",
        "openclaw.outcome": "completed",
        "openclaw.source": "webhook",
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.message.dispatch.duration_ms")?.record,
    ).toHaveBeenCalledWith(
      30,
      expect.objectContaining({
        "openclaw.channel": "unknown",
        "openclaw.reason": "none",
        "openclaw.source": "unknown",
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.message.duration_ms")?.record,
    ).toHaveBeenCalledWith(55, {
      "openclaw.channel": "telegram",
      "openclaw.outcome": "completed",
    });
    expect(telemetryState.histograms.get("openclaw.queue.wait_ms")?.record).toHaveBeenCalledWith(
      10,
      {
        "openclaw.lane": "main",
      },
    );
    expect(telemetryState.counters.get("openclaw.session.stuck")?.add).toHaveBeenCalledTimes(1);
    expect(telemetryState.counters.get("openclaw.session.stuck")?.add).toHaveBeenCalledWith(1, {
      "openclaw.state": "processing",
    });
    expect(
      telemetryState.histograms.get("openclaw.session.stuck_age_ms")?.record,
    ).toHaveBeenCalledWith(125_000, {
      "openclaw.state": "processing",
    });
    expect(telemetryState.counters.get("openclaw.run.attempt")?.add).toHaveBeenCalledWith(1, {
      "openclaw.attempt": 2,
    });

    emitDiagnosticEvent({
      type: "session.turn.created",
      runId: "run-1",
      agentId: "agent.default",
      channel: "telegram",
      trigger: "user",
    });
    expect(telemetryState.counters.get("openclaw.session.turn.created")?.add).toHaveBeenCalledWith(
      1,
      {
        "openclaw.agent": "agent.default",
        "openclaw.channel": "telegram",
        "openclaw.trigger": "user",
      },
    );

    const spanNames = telemetryState.tracer.startSpan.mock.calls.map((call) => call[0]);
    expect(spanNames).toContain("openclaw.webhook.processed");
    expect(spanNames).toContain("openclaw.message.processed");
    expect(spanNames).toContain("openclaw.session.stuck");
    const webhookSpanOptions = startedSpanOptions("openclaw.webhook.processed");
    expect(webhookSpanOptions?.attributes).not.toHaveProperty("openclaw.chatId");
    expect(webhookSpanOptions?.startTime).toBeTypeOf("number");
    const messageSpanOptions = startedSpanOptions("openclaw.message.processed");
    expect(messageSpanOptions?.attributes?.["openclaw.channel"]).toBe("telegram");
    expect(messageSpanOptions?.attributes?.["openclaw.outcome"]).toBe("completed");
    expect(messageSpanOptions?.attributes?.["openclaw.reason"]).toBe("unknown");
    expect(messageSpanOptions?.attributes).not.toHaveProperty("openclaw.chatId");
    expect(messageSpanOptions?.attributes).not.toHaveProperty("openclaw.messageId");
    expect(messageSpanOptions?.startTime).toBeTypeOf("number");

    await emitAndFlush({
      type: "log.record",
      level: "INFO",
      message: "hello",
      attributes: { subsystem: "diagnostic" },
    });
    expect(logEmit).toHaveBeenCalled();
  });

  test("restarts without retaining prior listeners or log transports", async () => {
    const { service, ctx } = await startOtelService({ traces: true, metrics: true, logs: true });
    await service.start(ctx);

    expect(logShutdown).toHaveBeenCalledTimes(1);
    expect(sdkShutdown).toHaveBeenCalledTimes(1);

    telemetryState.tracer.startSpan.mockClear();
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "completed",
      durationMs: 10,
    });
    expect(telemetryState.tracer.startSpan).toHaveBeenCalledTimes(1);

    await service.stop?.(ctx);
    expect(logShutdown).toHaveBeenCalledTimes(2);
    expect(sdkShutdown).toHaveBeenCalledTimes(2);

    telemetryState.tracer.startSpan.mockClear();
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "completed",
      durationMs: 10,
    });
    expect(telemetryState.tracer.startSpan).not.toHaveBeenCalled();
  });

  test("registers and removes an OTLP exporter unhandled rejection handler", async () => {
    const { service, ctx } = await startOtelService({ traces: true, metrics: true, logs: true });

    expect(unhandledRejectionHandlerState.register).toHaveBeenCalledTimes(1);
    const handler = unhandledRejectionHandlerState.getHandlers()[0];
    expect(handler).toBeTypeOf("function");

    const errorInstance = Object.assign(new Error("collector gone"), {
      name: "OTLPExporterError",
      code: 410,
    });
    expect(handler?.(errorInstance)).toBe(true);
    expect(handler?.({ name: "OTLPExporterError", code: 410, data: "user_stop" })).toBe(true);
    expect(handler?.([{ name: "OTLPExporterError", code: 410, data: "user_stop" }])).toBe(true);
    expect(
      handler?.(
        new AggregateError(
          [{ name: "OTLPExporterError", code: 410, data: "user_stop" }],
          "export failed",
        ),
      ),
    ).toBe(true);
    expect(handler?.(new Error("other exporter error"))).toBe(false);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "diagnostics-otel: suppressed OTLP exporter unhandled rejection (code=410)",
    );

    await service.stop?.(ctx);
    expect(unhandledRejectionHandlerState.getHandlers()).toHaveLength(0);
  });

  test("does not retain an OTLP exporter handler when startup setup fails", async () => {
    const startupError = new Error("trace exporter setup failed");
    traceExporterCtor.mockImplementationOnce(() => {
      throw startupError;
    });
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true });

    await expect(service.start(ctx)).rejects.toBe(startupError);

    expect(unhandledRejectionHandlerState.register).not.toHaveBeenCalled();
    expect(unhandledRejectionHandlerState.getHandlers()).toHaveLength(0);
  });

  test("uses a preloaded OpenTelemetry SDK without dropping diagnostic listeners", async () => {
    process.env.OPENCLAW_OTEL_PRELOADED = "1";
    const { service, ctx } = await startOtelService({ traces: true, metrics: true, logs: true });

    expect(sdkStart).not.toHaveBeenCalled();
    expect(traceExporterCtor).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "diagnostics-otel: using preloaded OpenTelemetry SDK",
    );

    emitDiagnosticEvent({
      type: "run.completed",
      ...RUN_FIXTURE,
      outcome: "completed",
      durationMs: 100,
    });
    await emitAndFlush({
      type: "log.record",
      level: "INFO",
      message: "preloaded log",
    });

    const runDurationRecordCall = lastHistogramRecord("openclaw.run.duration_ms");
    expect(runDurationRecordCall?.[0]).toBe(100);
    const runDurationAttributes = runDurationRecordCall?.[1];
    expect(runDurationAttributes?.["openclaw.provider"]).toBe("openai");
    expect(runDurationAttributes?.["openclaw.model"]).toBe("gpt-5.4");
    const runSpanOptions = startedSpanOptions("openclaw.run");
    expect(runSpanOptions?.attributes?.["openclaw.outcome"]).toBe("completed");
    expect(logEmit).toHaveBeenCalled();

    await service.stop?.(ctx);
    expect(sdkShutdown).not.toHaveBeenCalled();
    expect(logShutdown).toHaveBeenCalledTimes(1);
  });

  test("emits and records bounded telemetry exporter health events", async () => {
    const events: Array<Parameters<Parameters<typeof onInternalDiagnosticEvent>[0]>[0]> = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    await startOtelService({ traces: true, metrics: true, logs: true });

    const exporterEvents = events.filter((event) => event.type === "telemetry.exporter");
    for (const signal of ["traces", "metrics", "logs"]) {
      const event = exporterEvents.find((entry) => entry.signal === signal);
      expect(event?.type).toBe("telemetry.exporter");
      expect(event?.exporter).toBe("diagnostics-otel");
      expect(event?.status).toBe("started");
      expect(event?.reason).toBe("configured");
    }
    expect(
      telemetryState.counters.get("openclaw.telemetry.exporter.events")?.add,
    ).toHaveBeenCalledWith(1, {
      "openclaw.exporter": "diagnostics-otel",
      "openclaw.signal": "logs",
      "openclaw.status": "started",
      "openclaw.reason": "configured",
    });

    unsubscribe();
  });

  test("exports trusted security events as bounded OTLP logs", async () => {
    await startOtelService({ logs: true });
    const trace = createDiagnosticTraceContext(createTestTrace(SPAN_ID));

    emitTrustedSecurityEvent({
      eventId: "security-event-1",
      category: "tool",
      action: "tool.execution.blocked",
      outcome: "denied",
      severity: "medium",
      reason: "tools.deny",
      actor: {
        kind: "agent",
        idHash: "agent-hash-1",
        role: "operator",
        scopes: ["operator.read", "operator.approvals"],
      },
      target: {
        kind: "plugin",
        name: "@acme/security-event-plugin",
        owner: "plugin-installer",
      },
      policy: {
        id: "tools.exec",
        decision: "deny",
        reason: "allowlist.miss",
      },
      control: {
        id: "exec-approval",
        family: "approval",
      },
      attributes: {
        params_kind: "object",
        secretish: "token sk-test-secret",
        [PROTO_KEY]: "blocked",
      },
      trace,
    });
    await flushDiagnosticEvents();

    const emitCall = mockCallArg(logEmit, 0) as {
      attributes?: Record<string, unknown>;
      body?: string;
      context?: unknown;
      severityNumber?: number;
      severityText?: string;
    };
    expect(emitCall.body).toBe("openclaw.security.event");
    expect(emitCall.severityText).toBe("WARN");
    expect(emitCall.severityNumber).toBe(13);
    expect(emitCall.attributes).toMatchObject({
      "openclaw.security.event_id": "security-event-1",
      "openclaw.security.category": "tool",
      "openclaw.security.action": "tool.execution.blocked",
      "openclaw.security.outcome": "denied",
      "openclaw.security.severity": "medium",
      "openclaw.security.reason": "tools.deny",
      "openclaw.security.actor.kind": "agent",
      "openclaw.security.actor.id_hash": "agent-hash-1",
      "openclaw.security.actor.role": "operator",
      "openclaw.security.actor.scopes": "operator.read,operator.approvals",
      "openclaw.security.target.kind": "plugin",
      "openclaw.security.target.name": "@acme/security-event-plugin",
      "openclaw.security.target.owner": "plugin-installer",
      "openclaw.security.policy.id": "tools.exec",
      "openclaw.security.policy.decision": "deny",
      "openclaw.security.policy.reason": "allowlist.miss",
      "openclaw.security.control.id": "exec-approval",
      "openclaw.security.control.family": "approval",
      "openclaw.security.attribute.params_kind": "object",
      "openclaw.security.attribute.secretish": "unknown",
    });
    expect(emitCall.context).toEqual({
      spanContext: {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: 1,
        isRemote: true,
      },
    });
    expect(Object.hasOwn(emitCall.attributes ?? {}, "openclaw.security.attribute.__proto__")).toBe(
      false,
    );
    expect(JSON.stringify(emitCall)).not.toContain("sk-test-secret");
  });

  test("does not export security events when OTLP logs are disabled", async () => {
    await startOtelService({ logs: false, metrics: true });
    emitTrustedSecurityEvent({
      eventId: "security-event-logs-disabled",
      category: "auth",
      action: "gateway.auth.failed",
      outcome: "failure",
      severity: "high",
    });
    await flushDiagnosticEvents();

    expect(logEmit).not.toHaveBeenCalled();
  });

  test("starts stdout-only logs when OTLP protocol is unsupported", async () => {
    const { ctx } = await startOtelService({
      traces: false,
      metrics: false,
      logs: true,
      protocol: "grpc",
      logsExporter: "stdout",
    });
    const capture = captureStdoutWrites();
    try {
      emitDiagnosticEvent({
        type: "log.record",
        level: "INFO",
        message: "stdout only log",
      });
      await flushDiagnosticEvents();

      const line = parseSingleStdoutDiagnosticLogLine(capture.writes);
      expect(line.body).toBe("log");
      expect(logExporterCtor).not.toHaveBeenCalled();
      expect(traceExporterCtor).not.toHaveBeenCalled();
      expect(metricExporterCtor).not.toHaveBeenCalled();
      expect(ctx.logger.warn).not.toHaveBeenCalledWith(
        "diagnostics-otel: unsupported protocol grpc",
      );
    } finally {
      capture.spy.mockRestore();
    }
  });

  test.each([
    {
      name: "ignores blank OTLP protocol env overrides",
      value: "   ",
      exporterCalls: 1,
    },
    {
      name: "preserves nonblank OTLP protocol env overrides",
      value: " http/protobuf ",
      exporterCalls: 0,
      warning: "diagnostics-otel: unsupported protocol  http/protobuf ",
    },
  ])("$name", async ({ value, exporterCalls, warning }) => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = value;
    const { ctx } = await startOtelService({
      traces: true,
      metrics: true,
      configure: (context) => {
        delete context.config.diagnostics?.otel?.protocol;
      },
    });

    expect(traceExporterCtor).toHaveBeenCalledTimes(exporterCalls);
    expect(metricExporterCtor).toHaveBeenCalledTimes(exporterCalls);
    if (warning) {
      expect(ctx.logger.warn).toHaveBeenCalledWith(warning);
    } else {
      expect(ctx.logger.warn).not.toHaveBeenCalledWith(
        "diagnostics-otel: unsupported protocol    ",
      );
    }
  });

  test("exports trusted security events as stdout JSONL logs", async () => {
    await startOtelService({ endpoint: "", logs: true, logsExporter: "stdout" });
    const trace = createDiagnosticTraceContext(createTestTrace(SPAN_ID));
    const stdout = captureStdoutWrites();

    try {
      emitTrustedSecurityEvent({
        eventId: "security-event-stdout",
        category: "tool",
        action: "tool.execution.blocked",
        outcome: "denied",
        severity: "medium",
        reason: "tools.deny",
        attributes: {
          secretish: "token sk-test-secret",
          [PROTO_KEY]: "blocked",
        },
        trace,
      });
      await flushDiagnosticEvents();

      expect(logExporterCtor).not.toHaveBeenCalled();
      expect(logEmit).not.toHaveBeenCalled();
      const record = parseSingleStdoutDiagnosticLogLine(stdout.writes);
      expect(record.body).toBe("openclaw.security.event");
      expect(record.severityText).toBe("WARN");
      expect(record.severityNumber).toBe(13);
      expect(record.attributes).toMatchObject({
        "openclaw.security.event_id": "security-event-stdout",
        "openclaw.security.category": "tool",
        "openclaw.security.action": "tool.execution.blocked",
        "openclaw.security.outcome": "denied",
        "openclaw.security.severity": "medium",
        "openclaw.security.reason": "tools.deny",
        "openclaw.security.attribute.secretish": "unknown",
      });
      expect(Object.hasOwn(record.attributes ?? {}, "openclaw.security.attribute.__proto__")).toBe(
        false,
      );
      expect(record.trace_id).toBe(TRACE_ID);
      expect(record.span_id).toBe(SPAN_ID);
      expect(record.trace_flags).toBe("01");
      expect(JSON.stringify(record)).not.toContain("sk-test-secret");
    } finally {
      stdout.spy.mockRestore();
    }
  });

  test("records liveness warning diagnostics", async () => {
    await startOtelService({ traces: true, metrics: true });
    await emitAndFlush({
      type: "diagnostic.liveness.warning",
      reasons: ["event_loop_delay", "cpu"],
      intervalMs: 30_000,
      eventLoopDelayP99Ms: 250,
      eventLoopDelayMaxMs: 900,
      eventLoopUtilization: 0.95,
      cpuUserMs: 1200,
      cpuSystemMs: 300,
      cpuTotalMs: 1500,
      cpuCoreRatio: 1.4,
      active: 2,
      waiting: 1,
      queued: 4,
    });

    expect(telemetryState.counters.get("openclaw.liveness.warning")?.add).toHaveBeenCalledWith(1, {
      "openclaw.liveness.reason": "event_loop_delay:cpu",
    });
    expect(
      telemetryState.histograms.get("openclaw.liveness.event_loop_delay_p99_ms")?.record,
    ).toHaveBeenCalledWith(250, {
      "openclaw.liveness.reason": "event_loop_delay:cpu",
    });
    expect(
      telemetryState.histograms.get("openclaw.liveness.cpu_core_ratio")?.record,
    ).toHaveBeenCalledWith(1.4, {
      "openclaw.liveness.reason": "event_loop_delay:cpu",
    });
    const livenessSpanOptions = startedSpanOptions("openclaw.liveness.warning");
    expect(livenessSpanOptions?.attributes?.["openclaw.liveness.reason"]).toBe(
      "event_loop_delay:cpu",
    );
    expect(livenessSpanOptions?.attributes?.["openclaw.liveness.active"]).toBe(2);
    expect(livenessSpanOptions?.attributes?.["openclaw.liveness.queued"]).toBe(4);
    const span = telemetryState.spans.find((item) => item.name === "openclaw.liveness.warning");
    expect(span?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "event_loop_delay:cpu",
    });
  });

  test("records oversized payload metrics without raw identifiers", async () => {
    await startOtelService({ metrics: true, traces: false });
    await emitTrustedAndFlush({
      type: "payload.large",
      surface: "gateway.frame",
      action: "rejected",
      bytes: 2048,
      limitBytes: 1024,
      channel: "web",
      pluginId: "agent:qa:otel-trace-smoke",
      reason: "body-too-large",
    });

    expect(telemetryState.counters.get("openclaw.payload.large")?.add).toHaveBeenCalledWith(1, {
      "openclaw.payload.action": "rejected",
      "openclaw.payload.surface": "gateway.frame",
      "openclaw.channel": "web",
      "openclaw.plugin": "none",
      "openclaw.reason": "body-too-large",
    });
    expect(
      telemetryState.histograms.get("openclaw.payload.large_bytes")?.record,
    ).toHaveBeenCalledWith(2048, {
      "openclaw.payload.action": "rejected",
      "openclaw.payload.surface": "gateway.frame",
      "openclaw.channel": "web",
      "openclaw.plugin": "none",
      "openclaw.reason": "body-too-large",
    });
  });

  test("reports log exporter emit failures without exporting raw error text", async () => {
    const events: Array<Parameters<Parameters<typeof onInternalDiagnosticEvent>[0]>[0]> = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    logEmit.mockImplementationOnce(() => {
      throw new TypeError("token sk-test-secret should not leave as telemetry");
    });

    await startOtelService({ logs: true });
    await emitAndFlush({
      type: "log.record",
      level: "INFO",
      message: "export me",
    });

    const exporterEvents = events.filter((event) => event.type === "telemetry.exporter");
    const failureEvent = exporterEvents.find((event) => event.status === "failure");
    expect(failureEvent?.type).toBe("telemetry.exporter");
    expect(failureEvent?.exporter).toBe("diagnostics-otel");
    expect(failureEvent?.signal).toBe("logs");
    expect(failureEvent?.status).toBe("failure");
    expect(failureEvent?.reason).toBe("emit_failed");
    expect(failureEvent?.errorCategory).toBe("TypeError");
    expect(
      telemetryState.counters.get("openclaw.telemetry.exporter.events")?.add,
    ).toHaveBeenCalledWith(1, {
      "openclaw.exporter": "diagnostics-otel",
      "openclaw.signal": "logs",
      "openclaw.status": "failure",
      "openclaw.reason": "emit_failed",
      "openclaw.errorCategory": "TypeError",
    });

    unsubscribe();
  });

  test("ignores untrusted telemetry exporter events for OTEL metrics", async () => {
    await startOtelService({ metrics: true });
    telemetryState.counters.get("openclaw.telemetry.exporter.events")?.add.mockClear();
    emitDiagnosticEvent({
      type: "telemetry.exporter",
      exporter: "spoofed-plugin-exporter",
      signal: "metrics",
      status: "failure",
      reason: "emit_failed",
    });

    expect(
      telemetryState.counters.get("openclaw.telemetry.exporter.events")?.add,
    ).not.toHaveBeenCalled();
  });

  test("records hook-blocked run metrics with safe blocker originator", async () => {
    await startOtelService({ traces: true, metrics: true });

    await emitAndFlush({
      type: "run.completed",
      ...RUN_FIXTURE,
      outcome: "blocked",
      blockedBy: "policy-plugin",
      durationMs: 100,
    });

    const runDurationRecordCall = lastHistogramRecord("openclaw.run.duration_ms");
    expect(runDurationRecordCall?.[0]).toBe(100);
    expect(runDurationRecordCall?.[1]?.["openclaw.outcome"]).toBe("blocked");
    expect(runDurationRecordCall?.[1]?.["openclaw.blocked_by"]).toBe("policy-plugin");
    expect(JSON.stringify(telemetryState)).not.toContain("matched secret prompt");
  });

  test("run.completed error span carries the redacted message off the metric attrs", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        outcome: "error",
        errorCategory: "Error",
        durationMs: 100,
      },
      { errorMessage: "upstream model stream stalled then aborted" },
    );
    await flushDiagnosticEvents();

    expect(startedSpanOptions("openclaw.run")?.attributes?.["openclaw.error"]).toBe(
      "upstream model stream stalled then aborted",
    );
    expect(spanByName("openclaw.run").setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "upstream model stream stalled then aborted",
    });
    // The raw message must never widen metric cardinality.
    const runDuration = lastHistogramRecord("openclaw.run.duration_ms");
    expect(runDuration?.[1]?.["openclaw.outcome"]).toBe("error");
    expect(Object.hasOwn(runDuration?.[1] ?? {}, "openclaw.error")).toBe(false);
  });

  test("run.completed bounds sensitive error text before export", async () => {
    await startOtelService({ traces: true });
    const secret = "sk-1234567890abcdef";

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "run.completed",
        runId: "run-1",
        outcome: "error",
        errorCategory: "Error",
        durationMs: 100,
      },
      { errorMessage: `OPENAI_API_KEY=${secret} ${"x".repeat(8 * 1024)}` },
    );
    await flushDiagnosticEvents();

    const status = mockCallArg(spanByName("openclaw.run").setStatus, 0) as {
      message?: string;
    };
    expect(status.message).not.toContain(secret);
    expect(status.message).toMatch(/\.\.\.\(truncated\)$/u);
    expect(status.message?.length).toBeLessThanOrEqual(4 * 1024 + 20);
  });

  test("harness.run.completed error span carries the redacted message", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "harness.run.completed",
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        harnessId: "openclaw",
        outcome: "error",
        durationMs: 90,
        itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      },
      { errorMessage: "model run failed during resolve phase" },
    );
    await flushDiagnosticEvents();

    expect(startedSpanOptions("openclaw.harness.run")?.attributes?.["openclaw.error"]).toBe(
      "model run failed during resolve phase",
    );
    expect(spanByName("openclaw.harness.run").setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "model run failed during resolve phase",
    });
    const harnessDuration = lastHistogramRecord("openclaw.harness.duration_ms");
    expect(Object.hasOwn(harnessDuration?.[1] ?? {}, "openclaw.error")).toBe(false);
  });

  test("harness.run.error span prefers the redacted message over the category", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitTrustedDiagnosticEventWithPrivateData(
      {
        type: "harness.run.error",
        runId: "run-1",
        provider: "openai",
        model: "gpt-5.4",
        harnessId: "openclaw",
        phase: "resolve",
        errorCategory: "Error",
        durationMs: 90,
      },
      { errorMessage: "harness cleanup threw" },
    );
    await flushDiagnosticEvents();

    expect(startedSpanOptions("openclaw.harness.run")?.attributes?.["openclaw.error"]).toBe(
      "harness cleanup threw",
    );
    expect(spanByName("openclaw.harness.run").setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "harness cleanup threw",
    });
  });

  test("honors disabled traces when an OpenTelemetry SDK is preloaded", async () => {
    process.env.OPENCLAW_OTEL_PRELOADED = "1";
    const { service, ctx } = await startOtelService({ traces: false, metrics: true });

    await emitAndFlush({
      type: "run.completed",
      ...RUN_FIXTURE,
      outcome: "completed",
      durationMs: 100,
    });

    expect(sdkStart).not.toHaveBeenCalled();
    const runDurationRecordCall = lastHistogramRecord("openclaw.run.duration_ms");
    expect(runDurationRecordCall?.[0]).toBe(100);
    expect(runDurationRecordCall?.[1]?.["openclaw.provider"]).toBe("openai");
    expect(telemetryState.tracer.startSpan).not.toHaveBeenCalled();

    await service.stop?.(ctx);
    expect(sdkShutdown).not.toHaveBeenCalled();
  });

  test("treats omitted diagnostics enabled flag as enabled", async () => {
    await startOtelService({
      traces: true,
      captureContent: true,
      configure: (ctx) => {
        delete (ctx.config.diagnostics as { enabled?: boolean }).enabled;
      },
    });

    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 80,
      },
      { inputMessages: ["user prompt"] },
    );
    await flushDiagnosticEvents();

    const attrs = startedSpanOptions("openclaw.model.call")?.attributes;
    expect(attrs?.["openclaw.content.input_messages"]).toBe("user prompt");
  });

  test("tears down active handles when restarted with diagnostics disabled", async () => {
    const { service, ctx: enabledCtx } = await startOtelService({
      traces: true,
      metrics: true,
      logs: true,
    });
    await service.start({
      ...enabledCtx,
      config: { diagnostics: { enabled: false } },
    });

    expect(logShutdown).toHaveBeenCalledTimes(1);
    expect(sdkShutdown).toHaveBeenCalledTimes(1);

    telemetryState.tracer.startSpan.mockClear();
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "completed",
      durationMs: 10,
    });
    expect(telemetryState.tracer.startSpan).not.toHaveBeenCalled();
  });

  test.each([
    [
      "appends signal path when endpoint contains non-signal /v1 segment",
      "https://www.comet.com/opik/api/v1/private/otel",
      "https://www.comet.com/opik/api/v1/private/otel/v1/traces",
    ],
    [
      "keeps already signal-qualified endpoint unchanged",
      "https://collector.example.com/v1/traces",
      "https://collector.example.com/v1/traces",
    ],
    [
      "keeps signal-qualified endpoint unchanged when it has query params",
      "https://collector.example.com/v1/traces?timeout=30s",
      "https://collector.example.com/v1/traces?timeout=30s",
    ],
    [
      "inserts signal path before shared endpoint query params",
      "https://collector.example.com/otlp?timeout=30s",
      "https://collector.example.com/otlp/v1/traces?timeout=30s",
    ],
    [
      "inserts signal path before shared endpoint fragments",
      "https://collector.example.com/otlp#tenant-a",
      "https://collector.example.com/otlp/v1/traces#tenant-a",
    ],
    [
      "keeps signal-qualified endpoint unchanged when signal path casing differs",
      "https://collector.example.com/v1/Traces",
      "https://collector.example.com/v1/Traces",
    ],
  ])("%s", async (_name, endpoint, expected) => {
    await startOtelService({ endpoint, traces: true });

    expect(firstExporterOptions(traceExporterCtor).url).toBe(expected);
  });

  test("applies flush interval to trace batching", async () => {
    await startOtelService({
      traces: true,
      configure: (ctx) => {
        ctx.config.diagnostics!.otel!.flushIntervalMs = 250;
      },
    });

    expect(spanProcessorCtor).toHaveBeenCalledTimes(1);
    expect(firstSpanProcessorOptions().scheduledDelayMillis).toBe(1000);
  });

  test("applies flush interval to log batching", async () => {
    await startOtelService({
      logs: true,
      configure: (ctx) => {
        ctx.config.diagnostics!.otel!.flushIntervalMs = 250;
      },
    });

    expect(logProcessorCtor).toHaveBeenCalledTimes(1);
    const options = firstLogProcessorOptions();
    expect(options.exporter).toBeDefined();
    expect(options.scheduledDelayMillis).toBe(1000);
  });

  test("uses signal-specific OTLP endpoints ahead of the shared endpoint", async () => {
    await startOtelService({
      traces: true,
      metrics: true,
      logs: true,
      configure: (ctx) => {
        ctx.config.diagnostics!.otel!.tracesEndpoint = "https://trace.example.com/otlp";
        ctx.config.diagnostics!.otel!.metricsEndpoint = "https://metric.example.com/v1/metrics";
        ctx.config.diagnostics!.otel!.logsEndpoint = "https://log.example.com/otlp";
      },
    });

    const traceOptions = firstExporterOptions(traceExporterCtor);
    const metricOptions = firstExporterOptions(metricExporterCtor);
    const logOptions = firstExporterOptions(logExporterCtor);
    expect(traceOptions.url).toBe("https://trace.example.com/otlp/v1/traces");
    expect(metricOptions.url).toBe("https://metric.example.com/v1/metrics");
    expect(logOptions.url).toBe("https://log.example.com/otlp/v1/logs");
  });

  test("uses signal-specific OTLP env endpoints when config is unset", async () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "https://trace-env.example.com/v1/traces";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "https://metric-env.example.com/otlp";
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "https://log-env.example.com/otlp";

    await startOtelService({
      traces: true,
      metrics: true,
      logs: true,
    });

    const traceOptions = firstExporterOptions(traceExporterCtor);
    const metricOptions = firstExporterOptions(metricExporterCtor);
    const logOptions = firstExporterOptions(logExporterCtor);
    expect(traceOptions.url).toBe("https://trace-env.example.com/v1/traces");
    expect(metricOptions.url).toBe("https://metric-env.example.com/otlp/v1/metrics");
    expect(logOptions.url).toBe("https://log-env.example.com/otlp/v1/logs");
  });

  test("passes env proxy agents to OTLP HTTP exporters", async () => {
    createNodeProxyAgentMock.mockReturnValue(nodeProxyAgent);

    await startOtelService({
      endpoint: "https://collector.example.com/otlp",
      traces: true,
      metrics: true,
      logs: true,
    });

    const traceOptions = firstExporterOptions(traceExporterCtor);
    const metricOptions = firstExporterOptions(metricExporterCtor);
    const logOptions = firstExporterOptions(logExporterCtor);
    expect(traceOptions.httpAgentOptions?.("https:")).toBe(nodeProxyAgent);
    expect(metricOptions.httpAgentOptions?.("https:")).toBe(nodeProxyAgent);
    expect(logOptions.httpAgentOptions?.("https:")).toBe(nodeProxyAgent);
    expect(createNodeProxyAgentCalls()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mode: "env",
          targetUrl: "https://collector.example.com/otlp/v1/traces",
          agentOptions: expect.objectContaining({ keepAlive: true }),
        }),
        expect.objectContaining({
          mode: "env",
          targetUrl: "https://collector.example.com/otlp/v1/metrics",
          agentOptions: expect.objectContaining({ keepAlive: true }),
        }),
        expect.objectContaining({
          mode: "env",
          targetUrl: "https://collector.example.com/otlp/v1/logs",
          agentOptions: expect.objectContaining({ keepAlive: true }),
        }),
      ]),
    );
  });

  test("preserves OTLP TLS env options when passing env proxy agents", async () => {
    const certDir = mkdtempSync(path.join(tmpdir(), "openclaw-otel-tls-"));
    try {
      const rootCertificatePath = path.join(certDir, "root.pem");
      const clientCertificatePath = path.join(certDir, "client.pem");
      const clientKeyPath = path.join(certDir, "client-key.pem");
      writeFileSync(rootCertificatePath, "root-certificate");
      writeFileSync(clientCertificatePath, "trace-client-certificate");
      writeFileSync(clientKeyPath, "client-key");
      process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = rootCertificatePath;
      process.env.OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE = clientCertificatePath;
      process.env.OTEL_EXPORTER_OTLP_CLIENT_KEY = clientKeyPath;
      createNodeProxyAgentMock.mockReturnValue(nodeProxyAgent);

      await startOtelService({
        endpoint: "https://collector.example.com/otlp",
        traces: true,
        metrics: true,
        logs: true,
      });

      const traceCall = findCreateNodeProxyAgentCall(
        "https://collector.example.com/otlp/v1/traces",
      );
      const metricCall = findCreateNodeProxyAgentCall(
        "https://collector.example.com/otlp/v1/metrics",
      );
      expect(traceCall.agentOptions).toEqual({
        keepAlive: true,
        ca: Buffer.from("root-certificate"),
        cert: Buffer.from("trace-client-certificate"),
        key: Buffer.from("client-key"),
      });
      expect(metricCall.agentOptions).toEqual({
        keepAlive: true,
        ca: Buffer.from("root-certificate"),
        key: Buffer.from("client-key"),
      });
    } finally {
      rmSync(certDir, { force: true, recursive: true });
    }
  });

  test("falls back to shared OTLP TLS env options when signal-specific values are empty", async () => {
    const certDir = mkdtempSync(path.join(tmpdir(), "openclaw-otel-tls-"));
    try {
      const rootCertificatePath = path.join(certDir, "root.pem");
      writeFileSync(rootCertificatePath, "shared-root-certificate");
      process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = rootCertificatePath;
      process.env.OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE = "   ";
      createNodeProxyAgentMock.mockReturnValue(nodeProxyAgent);

      await startOtelService({
        endpoint: "https://collector.example.com/otlp",
        traces: true,
      });

      const traceCall = findCreateNodeProxyAgentCall(
        "https://collector.example.com/otlp/v1/traces",
      );
      expect(traceCall.agentOptions).toEqual({
        keepAlive: true,
        ca: Buffer.from("shared-root-certificate"),
      });
    } finally {
      rmSync(certDir, { force: true, recursive: true });
    }
  });

  test("falls back to default OTLP agents when env proxy agent creation fails", async () => {
    createNodeProxyAgentMock.mockImplementation(() => {
      throw new Error("unsupported proxy protocol");
    });

    const { ctx } = await startOtelService({
      endpoint: "https://collector.example.com/otlp",
      traces: true,
      metrics: true,
      logs: true,
    });

    expect(firstExporterOptions(traceExporterCtor).httpAgentOptions).toBeUndefined();
    expect(firstExporterOptions(metricExporterCtor).httpAgentOptions).toBeUndefined();
    expect(firstExporterOptions(logExporterCtor).httpAgentOptions).toBeUndefined();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "diagnostics-otel: env proxy agent unavailable for OTLP traces exporter; falling back to default Node agent",
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "diagnostics-otel: env proxy agent unavailable for OTLP metrics exporter; falling back to default Node agent",
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "diagnostics-otel: env proxy agent unavailable for OTLP logs exporter; falling back to default Node agent",
    );
  });

  test("leaves OTLP HTTP exporters on their default agents when env proxy is bypassed", async () => {
    await startOtelService({
      endpoint: "https://collector.example.com/otlp",
      traces: true,
      metrics: true,
      logs: true,
    });

    expect(firstExporterOptions(traceExporterCtor).httpAgentOptions).toBeUndefined();
    expect(firstExporterOptions(metricExporterCtor).httpAgentOptions).toBeUndefined();
    expect(firstExporterOptions(logExporterCtor).httpAgentOptions).toBeUndefined();
    expect(createNodeProxyAgentMock).toHaveBeenCalledTimes(3);
  });

  test("exports diagnostic logs as stdout JSONL without constructing the OTLP log exporter", async () => {
    await startOtelService({
      endpoint: "",
      logs: true,
      logsExporter: "stdout",
      captureContent: true,
      configure: (ctx) => {
        ctx.config.diagnostics!.otel!.serviceName = "rovoclaw-openclaw";
      },
    });
    const stdout = captureStdoutWrites();

    try {
      expect(logExporterCtor).not.toHaveBeenCalled();
      emitDiagnosticEventWithTrustedTraceContext({
        type: "log.record",
        level: "WARN",
        message: "Using API key sk-1234567890abcdef1234567890abcdef",
        attributes: {
          token: "ghp_abcdefghijklmnopqrstuvwxyz123456", // pragma: allowlist secret
          subsystem: "diagnostic",
        },
        trace: createTestTrace(SPAN_ID),
      });
      await flushDiagnosticEvents();

      expect(logEmit).not.toHaveBeenCalled();
      const record = parseSingleStdoutDiagnosticLogLine(stdout.writes);
      expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(record.signal).toBe("openclaw.diagnostic.log");
      expect(record["service.name"]).toBe("rovoclaw-openclaw");
      expect(record.severityText).toBe("WARN");
      expect(record.severityNumber).toBe(13);
      expect(String(record.body)).not.toContain("sk-1234567890abcdef1234567890abcdef");
      expect(String(record.body)).toContain("sk-123");
      expect(record.attributes).toMatchObject({
        "openclaw.log.level": "WARN",
        "openclaw.subsystem": "diagnostic",
      });
      const tokenAttr = record.attributes?.["openclaw.token"];
      expect(tokenAttr).not.toBe("ghp_abcdefghijklmnopqrstuvwxyz123456"); // pragma: allowlist secret
      expect(record.trace_id).toBe(TRACE_ID);
      expect(record.span_id).toBe(SPAN_ID);
      expect(JSON.stringify(record)).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456"); // pragma: allowlist secret
    } finally {
      stdout.spy.mockRestore();
    }
  });

  test("keeps explicit OTLP log export off stdout", async () => {
    const stdout = captureStdoutWrites();

    try {
      await startOtelService({ logs: true, logsExporter: "otlp" });
      emitDiagnosticEvent({
        type: "log.record",
        level: "INFO",
        message: "otlp only",
      });
      await flushDiagnosticEvents();

      expect(logExporterCtor).toHaveBeenCalledTimes(1);
      expect(logEmit).toHaveBeenCalledTimes(1);
      expect(stdout.writes).toEqual([]);
    } finally {
      stdout.spy.mockRestore();
    }
  });

  test("exports diagnostic logs to OTLP and stdout when logsExporter is both", async () => {
    const stdout = captureStdoutWrites();

    try {
      await startOtelService({ logs: true, logsExporter: "both" });
      emitDiagnosticEvent({
        type: "log.record",
        level: "ERROR",
        message: "both sinks",
        attributes: {
          subsystem: "diagnostic",
        },
      });
      await flushDiagnosticEvents();

      expect(logExporterCtor).toHaveBeenCalledTimes(1);
      const emitCall = mockCallArg(logEmit, 0) as {
        attributes?: Record<string, unknown>;
        body?: string;
        severityText?: string;
      };
      const record = parseSingleStdoutDiagnosticLogLine(stdout.writes);
      expect(emitCall.body).toBe("log");
      expect(record.body).toBe(emitCall.body);
      expect(record.severityText).toBe(emitCall.severityText);
      expect(record.attributes).toEqual(emitCall.attributes);
    } finally {
      stdout.spy.mockRestore();
    }
  });

  test("omits log message bodies from OTLP logs unless broad content capture is enabled", async () => {
    const emitCall = await emitAndCaptureLog({
      level: "INFO",
      message: "model replied OTEL-QA-OK",
    });

    expect(emitCall?.body).toBe("log");
  });

  test("keeps granular content capture from enabling OTLP log bodies", async () => {
    const emitCall = await emitAndCaptureLog(
      {
        level: "INFO",
        message: "model replied OTEL-QA-OK",
      },
      { captureContent: { enabled: true, inputMessages: true } },
    );

    expect(emitCall?.body).toBe("log");
  });

  test("redacts sensitive data from log messages before export when broad content capture is enabled", async () => {
    const emitCall = await emitAndCaptureLog(
      {
        level: "INFO",
        message: "Using API key sk-1234567890abcdef1234567890abcdef",
      },
      { captureContent: true },
    );

    expect(emitCall?.body).not.toContain("sk-1234567890abcdef1234567890abcdef");
    expect(emitCall?.body).toContain("sk-123");
    expect(emitCall?.body).toContain("…");
  });

  test("redacts sensitive data from log attributes before export", async () => {
    const emitCall = await emitAndCaptureLog({
      level: "DEBUG",
      message: "auth configured",
      attributes: {
        token: "ghp_abcdefghijklmnopqrstuvwxyz123456", // pragma: allowlist secret
      },
    });

    const tokenAttr = emitCall?.attributes?.["openclaw.token"];
    expect(tokenAttr).not.toBe("ghp_abcdefghijklmnopqrstuvwxyz123456"); // pragma: allowlist secret
    if (typeof tokenAttr === "string") {
      expect(tokenAttr).toContain("…");
    }
  });

  test("does not attach untrusted diagnostic trace context to exported logs", async () => {
    const emitCall = await emitAndCaptureLog({
      level: "INFO",
      message: "traceable log",
      attributes: {
        subsystem: "diagnostic",
      },
      trace: createTestTrace(SPAN_ID),
    });

    expect(Object.hasOwn(emitCall?.attributes ?? {}, "openclaw.traceId")).toBe(false);
    expect(Object.hasOwn(emitCall?.attributes ?? {}, "openclaw.spanId")).toBe(false);
    expect(Object.hasOwn(emitCall?.attributes ?? {}, "openclaw.traceFlags")).toBe(false);
    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    expect(emitCall?.context).toBeUndefined();
  });

  test("attaches trace-only trusted context to exported logs", async () => {
    const emitCall = await emitAndCaptureLog(
      {
        level: "INFO",
        message: "traceable log",
        trace: createTestTrace(SPAN_ID),
      },
      { trustedTraceContext: true },
    );

    expect(emitCall?.body).toBe("log");
    expect(telemetryState.tracer.setSpanContext).toHaveBeenCalledTimes(1);
    const emitContext = emitCall?.context as { spanContext?: Record<string, unknown> } | undefined;
    const emitSpanContext = emitContext?.spanContext;
    expect(emitSpanContext?.traceId).toBe(TRACE_ID);
    expect(emitSpanContext?.spanId).toBe(SPAN_ID);
  });

  test("attaches trusted diagnostic trace context to exported logs", async () => {
    const emitCall = await emitAndCaptureLog(
      {
        level: "INFO",
        message: "traceable log",
        trace: createTestTrace(SPAN_ID),
      },
      { trusted: true },
    );

    expect(telemetryState.tracer.setSpanContext).toHaveBeenCalledTimes(1);
    const trustedSpanContext = firstSetSpanContext();
    expect(trustedSpanContext.traceId).toBe(TRACE_ID);
    expect(trustedSpanContext.spanId).toBe(SPAN_ID);
    expect(trustedSpanContext.traceFlags).toBe(1);
    expect(trustedSpanContext.isRemote).toBe(true);
    const emitContext = emitCall?.context as { spanContext?: Record<string, unknown> } | undefined;
    const emitSpanContext = emitContext?.spanContext;
    expect(emitSpanContext?.traceId).toBe(TRACE_ID);
    expect(emitSpanContext?.spanId).toBe(SPAN_ID);
  });

  test("bounds plugin-emitted log attributes and omits source paths", async () => {
    await startOtelService({ logs: true, captureContent: true });

    const boundaryMessage = `${"x".repeat(4095)}🚀tail`;
    const boundaryAttribute = `${"y".repeat(4095)}🚀tail`;
    const attributes = Object.create(null) as Record<string, string>;
    attributes.good = boundaryAttribute;
    attributes["bad key"] = "drop-me";
    attributes[PROTO_KEY] = "pollute";
    attributes["constructor"] = "pollute";
    attributes["prototype"] = "pollute";
    attributes["sk-1234567890abcdef1234567890abcdef"] = "secret-key"; // pragma: allowlist secret

    emitDiagnosticEvent({
      type: "log.record",
      level: "INFO",
      message: boundaryMessage,
      attributes,
      code: {
        filepath: "/Users/alice/openclaw/src/private.ts",
        line: 42,
        functionName: "handler",
        location: "/Users/alice/openclaw/src/private.ts:42",
      },
    } as Parameters<typeof emitDiagnosticEvent>[0]);
    await flushDiagnosticEvents();

    const emitCall = mockCallArg(logEmit, 0) as {
      attributes: Record<string, unknown>;
      body: string;
    };
    expect(emitCall.body).toBe(`${"x".repeat(4095)}...(truncated)`);
    expect(emitCall.attributes["openclaw.good"]).toBe(`${"y".repeat(4095)}...(truncated)`);
    expect(emitCall.attributes["code.lineno"]).toBe(42);
    expect(emitCall.attributes["code.function"]).toBe("handler");
    expect(Object.hasOwn(emitCall.attributes, `openclaw.${PROTO_KEY}`)).toBe(false);
    expect(Object.hasOwn(emitCall.attributes, "openclaw.constructor")).toBe(false);
    expect(Object.hasOwn(emitCall.attributes, "openclaw.prototype")).toBe(false);
    expect(
      Object.hasOwn(
        emitCall.attributes,
        "openclaw.sk-1234567890abcdef1234567890abcdef", // pragma: allowlist secret
      ),
    ).toBe(false);
    expect(Object.hasOwn(emitCall.attributes, "openclaw.bad key")).toBe(false);
    expect(Object.hasOwn(emitCall.attributes, "code.filepath")).toBe(false);
    expect(Object.hasOwn(emitCall.attributes, "openclaw.code.location")).toBe(false);
  });

  test("rate-limits repeated log export failure reports", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    logEmit.mockImplementation(() => {
      throw new Error("export failed");
    });
    try {
      const { ctx } = await startOtelService({ logs: true });

      emitDiagnosticEvent({
        type: "log.record",
        level: "ERROR",
        message: "first failing log",
      });
      emitDiagnosticEvent({
        type: "log.record",
        level: "ERROR",
        message: "second failing log",
      });
      await flushDiagnosticEvents();

      expect(ctx.logger.error).toHaveBeenCalledTimes(1);

      nowSpy.mockReturnValue(62_000);
      emitDiagnosticEvent({
        type: "log.record",
        level: "ERROR",
        message: "third failing log",
      });
      await flushDiagnosticEvents();

      expect(ctx.logger.error).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("does not parent diagnostic event spans from plugin-emittable trace context", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitDiagnosticEvent({
      type: "model.usage",
      trace: createTestTrace(SPAN_ID),
      ...MODEL_FIXTURE,
      usage: { total: 4 },
      durationMs: 12,
    });

    const modelUsageCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.usage",
    );
    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    expect(modelUsageCall?.[2]).toBeUndefined();
  });

  test("exports GenAI client token usage histogram for input and output only", async () => {
    await startOtelService({ metrics: true });

    await emitAndFlush({
      type: "model.usage",
      sessionKey: "session-key",
      channel: "webchat",
      agentId: "ops",
      ...MODEL_FIXTURE,
      usage: {
        input: 12,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        promptTokens: 17,
        total: 24,
      },
    });

    const tokenUsageOptions = histogramCreateOptions("gen_ai.client.token.usage");
    expect(tokenUsageOptions?.unit).toBe("{token}");
    const tokenUsageBoundaries = tokenUsageOptions?.advice?.explicitBucketBoundaries;
    for (const boundary of [1, 4, 16, 1024, 67108864]) {
      expect(tokenUsageBoundaries).toContain(boundary);
    }
    const genAiTokenUsage = telemetryState.histograms.get("gen_ai.client.token.usage");
    const tokens = telemetryState.counters.get("openclaw.tokens");
    expect(tokens?.add).toHaveBeenCalledWith(12, {
      "openclaw.channel": "webchat",
      "openclaw.agent": "ops",
      "openclaw.provider": "openai",
      "openclaw.model": "gpt-5.4",
      "openclaw.token": "input",
    });
    expect(genAiTokenUsage?.record).toHaveBeenCalledTimes(2);
    expect(genAiTokenUsage?.record).toHaveBeenCalledWith(12, {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-5.4",
      "gen_ai.token.type": "input",
    });
    expect(genAiTokenUsage?.record).toHaveBeenCalledWith(7, {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-5.4",
      "gen_ai.token.type": "output",
    });
    expect(JSON.stringify(genAiTokenUsage?.record.mock.calls)).not.toContain("session-key");
  });

  test("advertises explicit duration buckets on the openclaw run/harness/context histograms", async () => {
    const priorSdkBoundaries = [
      0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000,
    ];
    await startOtelService({ metrics: true });

    const runDurationOptions = histogramCreateOptions("openclaw.run.duration_ms");
    expect(runDurationOptions?.unit).toBe("ms");
    const runBoundaries = runDurationOptions?.advice?.explicitBucketBoundaries;
    expect(runBoundaries).toEqual(expect.arrayContaining(priorSdkBoundaries));
    for (const boundary of [60000, 3_600_000]) {
      expect(runBoundaries).toContain(boundary);
    }

    const harnessDurationOptions = histogramCreateOptions("openclaw.harness.duration_ms");
    const harnessBoundaries = harnessDurationOptions?.advice?.explicitBucketBoundaries;
    expect(harnessBoundaries).toEqual(runBoundaries);

    const contextOptions = histogramCreateOptions("openclaw.context.tokens");
    const contextBoundaries = contextOptions?.advice?.explicitBucketBoundaries;
    expect(contextBoundaries).toEqual(expect.arrayContaining(priorSdkBoundaries));
    for (const boundary of [128000, 1_000_000]) {
      expect(contextBoundaries).toContain(boundary);
    }
  });

  test.each([
    ["bounds agent identifiers on model usage metric attributes", "Bearer sk-test-secret-value"],
    [
      "drops session-shaped agent identifiers from model usage metric attributes",
      "Agent:qa:otel-trace-smoke",
    ],
  ])("%s", async (_name, agentId) => {
    await startOtelService({ metrics: true });

    await emitAndFlush({
      type: "model.usage",
      agentId,
      ...MODEL_FIXTURE,
      usage: { input: 2 },
    });

    expect(telemetryState.counters.get("openclaw.tokens")?.add).toHaveBeenCalledWith(2, {
      "openclaw.channel": "unknown",
      "openclaw.agent": "unknown",
      "openclaw.provider": "openai",
      "openclaw.model": "gpt-5.4",
      "openclaw.token": "input",
    });
    expect(
      JSON.stringify(telemetryState.counters.get("openclaw.tokens")?.add.mock.calls),
    ).not.toContain(agentId);
  });

  test.each([
    [
      "drops session-shaped queue lane metric attributes",
      "session:Agent:qa:otel-trace-smoke",
      "session",
      "Agent:qa:otel-trace-smoke",
    ],
    [
      "keeps only the bounded prefix from scoped queue lane metric attributes",
      "dreaming-narrative:session-main",
      "dreaming-narrative",
      "session-main",
    ],
  ])("%s", async (_name, lane, expected, omitted) => {
    await startOtelService({ metrics: true });

    await emitAndFlush({
      type: "queue.lane.enqueue",
      lane,
      queueSize: 2,
    });

    expect(telemetryState.counters.get("openclaw.queue.lane.enqueue")?.add).toHaveBeenCalledWith(
      1,
      {
        "openclaw.lane": expected,
      },
    );
    expect(
      JSON.stringify(telemetryState.counters.get("openclaw.queue.lane.enqueue")?.add.mock.calls),
    ).not.toContain(omitted);
  });

  test("keeps GenAI token usage metric model attribute present when model is unavailable", async () => {
    await startOtelService({ metrics: true });

    await emitAndFlush({
      type: "model.usage",
      provider: "openai",
      usage: { input: 2 },
    });

    expect(telemetryState.histograms.get("gen_ai.client.token.usage")?.record).toHaveBeenCalledWith(
      2,
      {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "unknown",
        "gen_ai.token.type": "input",
      },
    );
  });

  test("exports GenAI usage attributes on model usage spans without diagnostic identifiers", async () => {
    await startOtelService({ traces: true });

    await emitAndFlush({
      type: "model.usage",
      sessionKey: "session-key",
      sessionId: "session-id",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4.6",
      usage: {
        input: 100,
        output: 40,
        cacheRead: 30,
        cacheWrite: 20,
        promptTokens: 150,
        total: 190,
      },
      durationMs: 25,
    });

    const modelUsageOptions = startedSpanOptions("openclaw.model.usage");
    expect(modelUsageOptions?.attributes?.["gen_ai.operation.name"]).toBe("chat");
    expect(modelUsageOptions?.attributes?.["gen_ai.system"]).toBe("anthropic");
    expect(modelUsageOptions?.attributes?.["gen_ai.request.model"]).toBe(
      "anthropic/claude-sonnet-4.6",
    );
    expect(modelUsageOptions?.attributes?.["gen_ai.usage.input_tokens"]).toBe(150);
    expect(modelUsageOptions?.attributes?.["gen_ai.usage.output_tokens"]).toBe(40);
    expect(modelUsageOptions?.attributes?.["gen_ai.usage.cache_read.input_tokens"]).toBe(30);
    expect(modelUsageOptions?.attributes?.["gen_ai.usage.cache_creation.input_tokens"]).toBe(20);
    expect(Object.hasOwn(modelUsageOptions?.attributes ?? {}, "openclaw.sessionKey")).toBe(false);
    expect(Object.hasOwn(modelUsageOptions?.attributes ?? {}, "openclaw.sessionId")).toBe(false);
    expect(Object.hasOwn(modelUsageOptions?.attributes ?? {}, "gen_ai.provider.name")).toBe(false);
    expect(Object.hasOwn(modelUsageOptions?.attributes ?? {}, "gen_ai.input.messages")).toBe(false);
    expect(Object.hasOwn(modelUsageOptions?.attributes ?? {}, "gen_ai.output.messages")).toBe(
      false,
    );
    expect(modelUsageOptions?.startTime).toBeTypeOf("number");
    expect(JSON.stringify(modelUsageOptions)).not.toContain("session-key");
  });

  test("separates request and turn GenAI client duration by operation", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      sessionKey: "session-key",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4.6",
      api: "openai-completions",
      observationUnit: "request",
      durationMs: 250,
    });
    emitDiagnosticEvent({
      type: "model.call.error",
      runId: "run-1",
      callId: "call-2",
      sessionKey: "session-key",
      provider: "google",
      model: "gemini-2.5-flash",
      api: "google-generative-ai",
      durationMs: 1250,
      errorCategory: "TimeoutError",
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-3",
      provider: "anthropic",
      model: "claude-opus-4-7",
      api: "claude-code",
      transport: "stdio-live",
      observationUnit: "turn",
      durationMs: 2500,
    });
    await emitAndFlush({
      type: "model.call.error",
      runId: "run-1",
      callId: "call-4",
      ...MODEL_FIXTURE,
      api: "openai-responses",
      transport: "stdio",
      observationUnit: "turn",
      durationMs: 3000,
      errorCategory: "TurnError",
    });

    const operationDurationOptions = histogramCreateOptions("gen_ai.client.operation.duration");
    expect(operationDurationOptions?.unit).toBe("s");
    const operationDurationBoundaries = operationDurationOptions?.advice?.explicitBucketBoundaries;
    for (const boundary of [0.01, 0.32, 2.56, 81.92]) {
      expect(operationDurationBoundaries).toContain(boundary);
    }
    const genAiOperationDuration = telemetryState.histograms.get(
      "gen_ai.client.operation.duration",
    );
    expect(genAiOperationDuration?.record).toHaveBeenCalledTimes(4);
    expect(genAiOperationDuration?.record).toHaveBeenCalledWith(0.25, {
      "gen_ai.operation.name": "text_completion",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "unknown",
    });
    expect(genAiOperationDuration?.record).toHaveBeenCalledWith(1.25, {
      "gen_ai.operation.name": "generate_content",
      "gen_ai.provider.name": "google",
      "gen_ai.request.model": "gemini-2.5-flash",
      "error.type": "TimeoutError",
    });
    expect(genAiOperationDuration?.record).toHaveBeenCalledWith(2.5, {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-opus-4-7",
    });
    expect(genAiOperationDuration?.record).toHaveBeenCalledWith(3, {
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-5.4",
      "error.type": "TurnError",
    });
    const openClawModelCallDuration = telemetryState.histograms.get(
      "openclaw.model_call.duration_ms",
    );
    expect(openClawModelCallDuration?.record).toHaveBeenCalledTimes(4);
    expect(
      openClawModelCallDuration?.record.mock.calls.map(
        (call) => call[1]?.["openclaw.model_call.observation_unit"],
      ),
    ).toEqual(["request", "request", "turn", "turn"]);
    const spanObservationUnits = telemetryState.tracer.startSpan.mock.calls
      .filter((call) => call[0] === "openclaw.model.call")
      .map(
        (call) =>
          (call[1] as { attributes?: Record<string, unknown> }).attributes?.[
            "openclaw.model_call.observation_unit"
          ],
      );
    expect(spanObservationUnits).toEqual(["request", "request", "turn", "turn"]);
    const spanOperations = telemetryState.tracer.startSpan.mock.calls
      .filter((call) => call[0] === "openclaw.model.call")
      .map(
        (call) =>
          (call[1] as { attributes?: Record<string, unknown> }).attributes?.[
            "gen_ai.operation.name"
          ],
      );
    expect(spanOperations).toEqual([
      "text_completion",
      "generate_content",
      "invoke_agent",
      "invoke_agent",
    ]);
    expect(JSON.stringify(genAiOperationDuration?.record.mock.calls)).not.toContain("session-key");
    expect(JSON.stringify(genAiOperationDuration?.record.mock.calls)).not.toContain("run-1");
  });

  test("exports skill usage counter and span without raw identifiers", async () => {
    await startOtelService({ traces: true, metrics: true });

    await emitTrustedAndFlush({
      type: "skill.used",
      agentId: "main",
      runId: "run-should-not-export",
      sessionKey: "session-should-not-export",
      skillName: "tiny-llm-brainstorm",
      skillSource: "workspace",
      activation: "read",
      toolName: "read",
      trace: createTestTrace(TOOL_SPAN_ID, CHILD_SPAN_ID),
    });

    const expectedAttrs = {
      "openclaw.agent": "main",
      "openclaw.skill.activation": "read",
      "openclaw.skill.name": "tiny-llm-brainstorm",
      "openclaw.skill.source": "workspace",
      "openclaw.toolName": "read",
    };
    expect(telemetryState.counters.get("openclaw.skill.used")?.add).toHaveBeenCalledWith(
      1,
      expectedAttrs,
    );
    const skillSpanCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.skill.used",
    );
    expect(skillSpanCall?.[1]).toMatchObject({ attributes: expectedAttrs });
    expect(JSON.stringify(skillSpanCall)).not.toContain("run-should-not-export");
    expect(JSON.stringify(skillSpanCall)).not.toContain("session-should-not-export");
  });

  test("exports run, model call, and tool execution lifecycle spans", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitDiagnosticEvent({
      type: "run.completed",
      runId: "run-1",
      sessionKey: "session-key",
      ...MODEL_FIXTURE,
      channel: "webchat",
      outcome: "completed",
      durationMs: 100,
      trace: createTestTrace(SPAN_ID),
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      api: "completions",
      transport: "http",
      durationMs: 80,
      requestPayloadBytes: 1234,
      responseStreamBytes: 567,
      timeToFirstByteMs: 45,
      promptStats: {
        inputMessagesCount: 2,
        inputMessagesChars: 3456,
        systemPromptChars: 789,
        toolDefinitionsCount: 4,
        toolDefinitionsChars: 2345,
        totalChars: 6590,
      },
      usage: {
        input: 100,
        output: 20,
        cacheRead: 30,
        cacheWrite: 5,
        reasoningTokens: 8,
        promptTokens: 135,
        total: 155,
      },
      trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
    });
    emitDiagnosticEvent({
      type: "harness.run.completed",
      runId: "run-1",
      sessionKey: "session-key",
      sessionId: "session-1",
      provider: "codex",
      model: "gpt-5.4",
      channel: "qa",
      harnessId: "codex",
      pluginId: "codex-plugin",
      outcome: "completed",
      durationMs: 90,
      resultClassification: "reasoning-only",
      yieldDetected: true,
      itemLifecycle: { startedCount: 3, completedCount: 2, activeCount: 1 },
      trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
    });
    await emitAndFlush({
      type: "tool.execution.error",
      runId: "run-1",
      toolName: "read",
      toolCallId: "tool-1",
      paramsSummary: { kind: "object" },
      durationMs: 20,
      errorCategory: "TypeError",
      errorCode: "429",
      trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
    });

    const spanNames = telemetryState.tracer.startSpan.mock.calls.map((call) => call[0]);
    expect(spanNames).toContain("openclaw.run");
    expect(spanNames).toContain("openclaw.model.call");
    expect(spanNames).toContain("openclaw.harness.run");
    expect(spanNames).toContain("openclaw.tool.execution");

    const runOptions = startedSpanOptions("openclaw.run");
    expect(runOptions?.attributes?.["openclaw.outcome"]).toBe("completed");
    expect(runOptions?.attributes?.["openclaw.provider"]).toBe("openai");
    expect(runOptions?.attributes?.["openclaw.model"]).toBe("gpt-5.4");
    expect(runOptions?.attributes?.["openclaw.channel"]).toBe("webchat");
    expect(Object.hasOwn(runOptions?.attributes ?? {}, "gen_ai.system")).toBe(false);
    expect(Object.hasOwn(runOptions?.attributes ?? {}, "gen_ai.request.model")).toBe(false);
    expect(Object.hasOwn(runOptions?.attributes ?? {}, "openclaw.runId")).toBe(false);
    expect(Object.hasOwn(runOptions?.attributes ?? {}, "openclaw.sessionKey")).toBe(false);
    expect(Object.hasOwn(runOptions?.attributes ?? {}, "openclaw.traceId")).toBe(false);
    expect(runOptions?.startTime).toBeTypeOf("number");

    const modelCall = startedSpanCall("openclaw.model.call");
    const modelOptions = modelCall?.[1];
    expect(modelOptions?.attributes?.["gen_ai.system"]).toBe("openai");
    expect(modelOptions?.attributes?.["gen_ai.request.model"]).toBe("gpt-5.4");
    expect(modelOptions?.attributes?.["gen_ai.operation.name"]).toBe("text_completion");
    expect(Object.hasOwn(modelOptions?.attributes ?? {}, "gen_ai.provider.name")).toBe(false);
    expect(Object.hasOwn(modelOptions?.attributes ?? {}, "openclaw.callId")).toBe(false);
    expect(Object.hasOwn(modelOptions?.attributes ?? {}, "openclaw.runId")).toBe(false);
    expect(Object.hasOwn(modelOptions?.attributes ?? {}, "openclaw.sessionKey")).toBe(false);
    expect(modelOptions?.startTime).toBeTypeOf("number");
    expect(modelOptions?.kind).toBe(2);
    expect(modelCall?.[2]).toBeUndefined();

    const harnessCall = startedSpanCall("openclaw.harness.run");
    const harnessOptions = harnessCall?.[1];
    expect(harnessOptions?.attributes?.["openclaw.harness.id"]).toBe("codex");
    expect(harnessOptions?.attributes?.["openclaw.harness.plugin"]).toBe("codex-plugin");
    expect(harnessOptions?.attributes?.["openclaw.outcome"]).toBe("completed");
    expect(harnessOptions?.attributes?.["openclaw.provider"]).toBe("codex");
    expect(harnessOptions?.attributes?.["openclaw.model"]).toBe("gpt-5.4");
    expect(harnessOptions?.attributes?.["openclaw.channel"]).toBe("qa");
    expect(harnessOptions?.attributes?.["openclaw.harness.result_classification"]).toBe(
      "reasoning-only",
    );
    expect(harnessOptions?.attributes?.["openclaw.harness.yield_detected"]).toBe(true);
    expect(harnessOptions?.attributes?.["openclaw.harness.items.started"]).toBe(3);
    expect(harnessOptions?.attributes?.["openclaw.harness.items.completed"]).toBe(2);
    expect(harnessOptions?.attributes?.["openclaw.harness.items.active"]).toBe(1);
    expect(Object.hasOwn(harnessOptions?.attributes ?? {}, "openclaw.runId")).toBe(false);
    expect(Object.hasOwn(harnessOptions?.attributes ?? {}, "openclaw.sessionId")).toBe(false);
    expect(Object.hasOwn(harnessOptions?.attributes ?? {}, "openclaw.sessionKey")).toBe(false);
    expect(Object.hasOwn(harnessOptions?.attributes ?? {}, "openclaw.traceId")).toBe(false);
    expect(harnessOptions?.startTime).toBeTypeOf("number");
    expect(harnessCall?.[2]).toBeUndefined();

    const toolCall = startedSpanCall("openclaw.tool.execution");
    const toolOptions = toolCall?.[1];
    expect(toolOptions?.attributes?.["openclaw.toolName"]).toBe("read");
    expect(toolOptions?.attributes?.["openclaw.tool.source"]).toBe("core");
    expect(toolOptions?.attributes?.["openclaw.errorCategory"]).toBe("TypeError");
    expect(toolOptions?.attributes?.["openclaw.errorCode"]).toBe("429");
    expect(toolOptions?.attributes?.["openclaw.tool.params.kind"]).toBe("object");
    expect(toolOptions?.attributes?.["gen_ai.tool.name"]).toBe("read");
    expect(Object.hasOwn(toolOptions?.attributes ?? {}, "openclaw.toolCallId")).toBe(false);
    expect(Object.hasOwn(toolOptions?.attributes ?? {}, "openclaw.runId")).toBe(false);
    expect(Object.hasOwn(toolOptions?.attributes ?? {}, "openclaw.sessionKey")).toBe(false);
    expect(toolOptions?.startTime).toBeTypeOf("number");
    expect(Object.hasOwn(toolOptions ?? {}, "kind")).toBe(false);
    expect(toolCall?.[2]).toBeUndefined();

    const modelCallDuration = lastHistogramRecord("openclaw.model_call.duration_ms");
    expect(modelCallDuration?.[0]).toBe(80);
    expect(modelCallDuration?.[1]?.["openclaw.provider"]).toBe("openai");
    expect(modelCallDuration?.[1]?.["openclaw.model"]).toBe("gpt-5.4");
    const requestBytes = lastHistogramRecord("openclaw.model_call.request_bytes");
    expect(requestBytes?.[0]).toBe(1234);
    expect(requestBytes?.[1]?.["openclaw.provider"]).toBe("openai");
    expect(requestBytes?.[1]?.["openclaw.model"]).toBe("gpt-5.4");
    const responseBytes = lastHistogramRecord("openclaw.model_call.response_bytes");
    expect(responseBytes?.[0]).toBe(567);
    expect(responseBytes?.[1]?.["openclaw.provider"]).toBe("openai");
    expect(responseBytes?.[1]?.["openclaw.model"]).toBe("gpt-5.4");
    const timeToFirstByte = lastHistogramRecord("openclaw.model_call.time_to_first_byte_ms");
    expect(timeToFirstByte?.[0]).toBe(45);
    expect(timeToFirstByte?.[1]?.["openclaw.provider"]).toBe("openai");
    expect(timeToFirstByte?.[1]?.["openclaw.model"]).toBe("gpt-5.4");
    const modelSpanAttributes = firstSpanAttributes("openclaw.model.call");
    expect(modelSpanAttributes["openclaw.model_call.request_bytes"]).toBe(1234);
    expect(modelSpanAttributes["openclaw.model_call.response_bytes"]).toBe(567);
    expect(modelSpanAttributes["openclaw.model_call.time_to_first_byte_ms"]).toBe(45);
    expect(modelSpanAttributes["openclaw.model_call.prompt.input_messages_count"]).toBe(2);
    expect(modelSpanAttributes["openclaw.model_call.prompt.input_messages_chars"]).toBe(3456);
    expect(modelSpanAttributes["openclaw.model_call.prompt.system_prompt_chars"]).toBe(789);
    expect(modelSpanAttributes["openclaw.model_call.prompt.tool_definitions_count"]).toBe(4);
    expect(modelSpanAttributes["openclaw.model_call.prompt.tool_definitions_chars"]).toBe(2345);
    expect(modelSpanAttributes["openclaw.model_call.prompt.total_chars"]).toBe(6590);
    expect(modelSpanAttributes["openclaw.model_call.usage.input_tokens"]).toBe(100);
    expect(modelSpanAttributes["openclaw.model_call.usage.output_tokens"]).toBe(20);
    expect(modelSpanAttributes["openclaw.model_call.usage.cache_read_input_tokens"]).toBe(30);
    expect(modelSpanAttributes["openclaw.model_call.usage.cache_creation_input_tokens"]).toBe(5);
    expect(modelSpanAttributes["openclaw.model_call.usage.reasoning_output_tokens"]).toBe(8);
    expect(modelSpanAttributes["openclaw.model_call.usage.prompt_tokens"]).toBe(135);
    expect(modelSpanAttributes["openclaw.model_call.usage.total_tokens"]).toBe(155);
    expect(modelSpanAttributes["gen_ai.usage.input_tokens"]).toBe(135);
    expect(modelSpanAttributes["gen_ai.usage.output_tokens"]).toBe(20);
    const runDuration = lastHistogramRecord("openclaw.run.duration_ms");
    expect(runDuration?.[0]).toBe(100);
    expect(Object.hasOwn(runDuration?.[1] ?? {}, "openclaw.runId")).toBe(false);
    const harnessDuration = lastHistogramRecord("openclaw.harness.duration_ms");
    expect(harnessDuration?.[0]).toBe(90);
    expect(harnessDuration?.[1]?.["openclaw.harness.id"]).toBe("codex");
    expect(harnessDuration?.[1]?.["openclaw.harness.plugin"]).toBe("codex-plugin");
    expect(harnessDuration?.[1]?.["openclaw.outcome"]).toBe("completed");
    expect(Object.hasOwn(harnessDuration?.[1] ?? {}, "openclaw.runId")).toBe(false);
    expect(Object.hasOwn(harnessDuration?.[1] ?? {}, "openclaw.sessionKey")).toBe(false);
    const toolDuration = lastHistogramRecord("openclaw.tool.execution.duration_ms");
    expect(toolDuration?.[0]).toBe(20);
    expect(toolDuration?.[1]?.["openclaw.tool.source"]).toBe("core");
    expect(Object.hasOwn(toolDuration?.[1] ?? {}, "openclaw.errorCode")).toBe(false);
    expect(Object.hasOwn(toolDuration?.[1] ?? {}, "openclaw.runId")).toBe(false);

    const toolSpan = spanByName("openclaw.tool.execution");
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "TypeError",
    });
    expect(firstSpanEndTime("openclaw.tool.execution")).toBeTypeOf("number");
    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
  });

  test("exports model failover spans", async () => {
    await startOtelService({ traces: true });

    await emitTrustedAndFlush({
      type: "model.failover",
      sessionId: "session-1",
      lane: "main",
      fromProvider: "anthropic",
      fromModel: "claude-opus-4-6",
      toProvider: "openai",
      toModel: "gpt-5.4",
      reason: "overloaded",
      suspended: true,
      cascadeDepth: 1,
    });

    const failoverOptions = startedSpanOptions("openclaw.model.failover");
    expect(failoverOptions?.attributes?.["openclaw.provider"]).toBe("anthropic");
    expect(failoverOptions?.attributes?.["openclaw.model"]).toBe("claude-opus-4-6");
    expect(failoverOptions?.attributes?.["openclaw.failover.to_provider"]).toBe("openai");
    expect(failoverOptions?.attributes?.["openclaw.failover.to_model"]).toBe("gpt-5.4");
    expect(failoverOptions?.attributes?.["openclaw.failover.reason"]).toBe("overloaded");
    expect(failoverOptions?.attributes?.["openclaw.failover.suspended"]).toBe(true);
    expect(failoverOptions?.attributes?.["openclaw.failover.cascade_depth"]).toBe(1);
    expect(failoverOptions?.attributes?.["openclaw.lane"]).toBe("main");
    expect(Object.hasOwn(failoverOptions?.attributes ?? {}, "openclaw.sessionId")).toBe(false);
    expect(Object.hasOwn(failoverOptions?.attributes ?? {}, "openclaw.sessionKey")).toBe(false);
    expect(failoverOptions?.startTime).toBeTypeOf("number");
    expect(firstSpanEndTime("openclaw.model.failover")).toBeTypeOf("number");
    expect(firstCounterAddCall("openclaw.model.failover")).toStrictEqual([
      1,
      {
        "openclaw.failover.reason": "overloaded",
        "openclaw.failover.suspended": "true",
        "openclaw.lane": "main",
        "openclaw.model": "claude-opus-4-6",
        "openclaw.provider": "anthropic",
        "openclaw.failover.to_model": "gpt-5.4",
        "openclaw.failover.to_provider": "openai",
      },
    ]);
  });

  test("records blocked tool metrics even when traces are disabled", async () => {
    await startOtelService({ metrics: true, traces: false });

    await emitTrustedAndFlush({
      type: "tool.execution.blocked",
      runId: "run-should-not-export",
      toolName: "browser",
      toolSource: "mcp",
      toolOwner: "browser-tools",
      deniedReason: "tools.deny",
      reason: "matched browser",
      paramsSummary: { kind: "object" },
    });

    expect(firstCounterAddCall("openclaw.tool.execution.blocked")).toStrictEqual([
      1,
      {
        "openclaw.toolName": "browser",
        "openclaw.tool.source": "mcp",
        "gen_ai.tool.name": "browser",
        "openclaw.tool.owner": "browser-tools",
        "openclaw.tool.params.kind": "object",
        "openclaw.deniedReason": "tools.deny",
      },
    ]);
    expect(telemetryState.tracer.startSpan).not.toHaveBeenCalledWith(
      "openclaw.tool.execution",
      expect.anything(),
      expect.anything(),
    );
  });

  test("drops session-shaped queue lanes from model failover spans", async () => {
    await startOtelService({ traces: true });

    await emitAndFlush({
      type: "model.failover",
      lane: "session:Agent:qa:otel-trace-smoke",
      reason: "overloaded",
      fromProvider: "anthropic",
      fromModel: "claude-opus-4-6",
    });

    const failoverOptions = startedSpanOptions("openclaw.model.failover");
    expect(failoverOptions?.attributes?.["openclaw.lane"]).toBe("session");
    expect(JSON.stringify(failoverOptions?.attributes)).not.toContain("Agent:qa:otel-trace-smoke");
  });

  test("maps model call APIs to GenAI operation names and error type", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitDiagnosticEvent({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      api: "openai-completions",
      durationMs: 80,
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-2",
      provider: "google",
      model: "gemini-2.5-flash",
      api: "google-generative-ai",
      durationMs: 90,
    });
    await emitAndFlush({
      type: "model.call.error",
      runId: "run-1",
      callId: "call-3",
      ...MODEL_FIXTURE,
      api: "openai-responses",
      durationMs: 40,
      errorCategory: "TimeoutError",
    });

    const modelCallAttrs = telemetryState.tracer.startSpan.mock.calls
      .filter((call) => call[0] === "openclaw.model.call")
      .map((call) => (call[1] as { attributes?: Record<string, unknown> }).attributes);
    expect(modelCallAttrs).toHaveLength(3);
    expect(modelCallAttrs[0]?.["gen_ai.system"]).toBe("openai");
    expect(modelCallAttrs[0]?.["gen_ai.request.model"]).toBe("gpt-5.4");
    expect(modelCallAttrs[0]?.["gen_ai.operation.name"]).toBe("text_completion");
    expect(modelCallAttrs[1]?.["gen_ai.system"]).toBe("google");
    expect(modelCallAttrs[1]?.["gen_ai.request.model"]).toBe("gemini-2.5-flash");
    expect(modelCallAttrs[1]?.["gen_ai.operation.name"]).toBe("generate_content");
    expect(modelCallAttrs[2]?.["gen_ai.system"]).toBe("openai");
    expect(modelCallAttrs[2]?.["gen_ai.request.model"]).toBe("gpt-5.4");
    expect(modelCallAttrs[2]?.["gen_ai.operation.name"]).toBe("chat");
    expect(modelCallAttrs[2]?.["error.type"]).toBe("TimeoutError");
  });

  test("uses latest GenAI request and agent span shapes only when semconv opt-in is set", async () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "http,gen_ai_latest_experimental";

    await startOtelService({ traces: true, metrics: true });

    emitDiagnosticEvent({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      api: "openai-completions",
      durationMs: 80,
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-2",
      provider: "anthropic",
      model: "claude-opus-4-7",
      api: "claude-code",
      transport: "stdio-live",
      observationUnit: "turn",
      durationMs: 90,
    });
    await emitAndFlush({
      type: "model.usage",
      ...MODEL_FIXTURE,
      usage: { input: 3, output: 2 },
      durationMs: 10,
    });

    expect(startedSpanOptions("openclaw.model.call")).toBeUndefined();
    const modelCallOptions = startedSpanOptions("text_completion gpt-5.4");
    expect(modelCallOptions?.attributes?.["gen_ai.provider.name"]).toBe("openai");
    expect(modelCallOptions?.attributes?.["gen_ai.request.model"]).toBe("gpt-5.4");
    expect(modelCallOptions?.attributes?.["gen_ai.operation.name"]).toBe("text_completion");
    expect(Object.hasOwn(modelCallOptions?.attributes ?? {}, "gen_ai.system")).toBe(false);
    expect(modelCallOptions?.startTime).toBeTypeOf("number");
    expect(modelCallOptions?.kind).toBe(2);
    const agentTurnOptions = startedSpanOptions("invoke_agent");
    expect(agentTurnOptions?.attributes?.["gen_ai.provider.name"]).toBe("anthropic");
    expect(agentTurnOptions?.attributes?.["gen_ai.request.model"]).toBe("claude-opus-4-7");
    expect(agentTurnOptions?.attributes?.["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(agentTurnOptions?.attributes?.["openclaw.model_call.observation_unit"]).toBe("turn");
    expect(agentTurnOptions?.startTime).toBeTypeOf("number");
    expect(agentTurnOptions?.kind).toBe(2);
    const modelUsageOptions = startedSpanOptions("openclaw.model.usage");
    expect(modelUsageOptions?.attributes?.["gen_ai.provider.name"]).toBe("openai");
    expect(modelUsageOptions?.attributes?.["gen_ai.request.model"]).toBe("gpt-5.4");
    expect(modelUsageOptions?.attributes?.["gen_ai.operation.name"]).toBe("chat");
    expect(Object.hasOwn(modelUsageOptions?.attributes ?? {}, "gen_ai.system")).toBe(false);
    expect(modelUsageOptions?.startTime).toBeTypeOf("number");
  });

  test("records upstream request id hashes as model call span events only", async () => {
    await startOtelService({ traces: true, metrics: true });

    await emitAndFlush({
      type: "model.call.error",
      ...MODEL_CALL_FIXTURE,
      api: "openai-responses",
      durationMs: 40,
      errorCategory: "ProviderError",
      failureKind: "terminated",
      upstreamRequestIdHash: "sha256:123456abcdef",
    });

    const modelCallOptions = startedSpanOptions("openclaw.model.call");
    expect(modelCallOptions?.attributes?.["openclaw.failureKind"]).toBe("terminated");
    expect(
      Object.hasOwn(modelCallOptions?.attributes ?? {}, "openclaw.upstreamRequestIdHash"),
    ).toBe(false);
    expect(modelCallOptions?.startTime).toBeTypeOf("number");
    const span = telemetryState.spans.find((candidate) => candidate.name === "openclaw.model.call");
    expect(span?.addEvent).toHaveBeenCalledWith("openclaw.provider.request", {
      "openclaw.upstreamRequestIdHash": "sha256:123456abcdef",
    });
    const modelCallDuration = lastHistogramRecord("openclaw.model_call.duration_ms");
    expect(modelCallDuration?.[0]).toBe(40);
    expect(modelCallDuration?.[1]?.["openclaw.failureKind"]).toBe("terminated");
    expect(Object.hasOwn(modelCallDuration?.[1] ?? {}, "openclaw.upstreamRequestIdHash")).toBe(
      false,
    );
  });

  test("exports trusted context assembly spans without prompt content", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitTrustedDiagnosticEvent({
      type: "run.started",
      ...RUN_FIXTURE,
      trace: createTestTrace(SPAN_ID),
    });
    await emitTrustedAndFlush({
      type: "context.assembled",
      runId: "run-1",
      sessionKey: "session-key",
      sessionId: "session-id",
      ...MODEL_FIXTURE,
      channel: "webchat",
      trigger: "message",
      messageCount: 12,
      historyTextChars: 1234,
      historyImageBlocks: 2,
      maxMessageTextChars: 456,
      systemPromptChars: 789,
      promptChars: 42,
      promptImages: 1,
      contextTokenBudget: 128_000,
      reserveTokens: 4096,
      trace: createTestTrace(GRANDCHILD_SPAN_ID, SPAN_ID),
    });

    const contextCall = startedSpanCall("openclaw.context.assembled");
    const contextOptions = contextCall?.[1];
    const runSpan = telemetryState.spans.find((span) => span.name === "openclaw.run");
    const runSpanId = runSpan?.spanContext.mock.results[0]?.value?.spanId;
    expect(contextOptions?.attributes?.["openclaw.provider"]).toBe("openai");
    expect(contextOptions?.attributes?.["openclaw.model"]).toBe("gpt-5.4");
    expect(contextOptions?.attributes?.["openclaw.channel"]).toBe("webchat");
    expect(contextOptions?.attributes?.["openclaw.trigger"]).toBe("message");
    expect(contextOptions?.attributes?.["openclaw.context.message_count"]).toBe(12);
    expect(contextOptions?.attributes?.["openclaw.context.history_text_chars"]).toBe(1234);
    expect(contextOptions?.attributes?.["openclaw.context.history_image_blocks"]).toBe(2);
    expect(contextOptions?.attributes?.["openclaw.context.max_message_text_chars"]).toBe(456);
    expect(contextOptions?.attributes?.["openclaw.context.system_prompt_chars"]).toBe(789);
    expect(contextOptions?.attributes?.["openclaw.context.prompt_chars"]).toBe(42);
    expect(contextOptions?.attributes?.["openclaw.context.prompt_images"]).toBe(1);
    expect(contextOptions?.attributes?.["openclaw.context.token_budget"]).toBe(128_000);
    expect(contextOptions?.attributes?.["openclaw.context.reserve_tokens"]).toBe(4096);
    expect(contextOptions?.attributes).toBeTypeOf("object");
    expect(contextOptions?.startTime).toBeTypeOf("number");
    expect(JSON.stringify(contextCall)).not.toContain("session-key");
    expect(JSON.stringify(contextCall)).not.toContain("prompt text");
    const linkedSpanContext = firstSetSpanContext();
    expect(linkedSpanContext.traceId).toBe(TRACE_ID);
    expect(linkedSpanContext.spanId).toBe(runSpanId);
    expect(
      (contextCall?.[2] as { spanContext?: { spanId?: string } } | undefined)?.spanContext?.spanId,
    ).toBe(runSpanId);
  });

  test("exports tool loop diagnostics without loop messages or session identifiers", async () => {
    await startOtelService({ traces: true, metrics: true });

    await emitAndFlush({
      type: "tool.loop",
      sessionKey: "session-key",
      sessionId: "session-id",
      toolName: "process",
      level: "critical",
      action: "block",
      detector: "known_poll_no_progress",
      count: 20,
      message: "CRITICAL: repeated secret-bearing tool output",
      pairedToolName: "read",
    });

    expect(telemetryState.counters.get("openclaw.tool.loop")?.add).toHaveBeenCalledWith(1, {
      "openclaw.toolName": "process",
      "openclaw.loop.level": "critical",
      "openclaw.loop.action": "block",
      "openclaw.loop.detector": "known_poll_no_progress",
      "openclaw.loop.count": 20,
      "openclaw.loop.paired_tool": "read",
    });
    const loopSpanCall = startedSpanCall("openclaw.tool.loop");
    const loopOptions = loopSpanCall?.[1];
    expect(loopOptions?.attributes?.["openclaw.toolName"]).toBe("process");
    expect(loopOptions?.attributes?.["openclaw.loop.level"]).toBe("critical");
    expect(loopOptions?.attributes?.["openclaw.loop.action"]).toBe("block");
    expect(loopOptions?.attributes?.["openclaw.loop.detector"]).toBe("known_poll_no_progress");
    expect(loopOptions?.attributes?.["openclaw.loop.count"]).toBe(20);
    expect(loopOptions?.attributes?.["openclaw.loop.paired_tool"]).toBe("read");
    const loopSpan = telemetryState.spans.find((span) => span.name === "openclaw.tool.loop");
    expect(loopSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "known_poll_no_progress:block",
    });
    expect(JSON.stringify(loopSpanCall)).not.toContain("session-key");
    expect(JSON.stringify(loopSpanCall)).not.toContain("secret-bearing");
  });

  test("exports diagnostic memory samples and pressure without session identifiers", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitDiagnosticEvent({
      type: "diagnostic.memory.sample",
      uptimeMs: 1234,
      memory: {
        rssBytes: 100,
        heapUsedBytes: 40,
        heapTotalBytes: 80,
        externalBytes: 10,
        arrayBuffersBytes: 5,
      },
    });
    await emitAndFlush({
      type: "diagnostic.memory.pressure",
      level: "critical",
      reason: "rss_growth",
      thresholdBytes: 512,
      rssGrowthBytes: 256,
      windowMs: 60_000,
      memory: {
        rssBytes: 200,
        heapUsedBytes: 50,
        heapTotalBytes: 90,
        externalBytes: 20,
        arrayBuffersBytes: 6,
      },
    });

    expect(telemetryState.histograms.get("openclaw.memory.rss_bytes")?.record).toHaveBeenCalledWith(
      100,
      {},
    );
    expect(telemetryState.histograms.get("openclaw.memory.rss_bytes")?.record).toHaveBeenCalledWith(
      200,
      {
        "openclaw.memory.level": "critical",
        "openclaw.memory.reason": "rss_growth",
      },
    );
    expect(telemetryState.counters.get("openclaw.memory.pressure")?.add).toHaveBeenCalledWith(1, {
      "openclaw.memory.level": "critical",
      "openclaw.memory.reason": "rss_growth",
    });
    const pressureCall = startedSpanCall("openclaw.memory.pressure");
    const pressureOptions = pressureCall?.[1];
    expect(pressureOptions?.attributes?.["openclaw.memory.level"]).toBe("critical");
    expect(pressureOptions?.attributes?.["openclaw.memory.reason"]).toBe("rss_growth");
    expect(pressureOptions?.attributes?.["openclaw.memory.rss_bytes"]).toBe(200);
    expect(pressureOptions?.attributes?.["openclaw.memory.heap_used_bytes"]).toBe(50);
    expect(pressureOptions?.attributes?.["openclaw.memory.heap_total_bytes"]).toBe(90);
    expect(pressureOptions?.attributes?.["openclaw.memory.external_bytes"]).toBe(20);
    expect(pressureOptions?.attributes?.["openclaw.memory.array_buffers_bytes"]).toBe(6);
    expect(pressureOptions?.attributes?.["openclaw.memory.threshold_bytes"]).toBe(512);
    expect(pressureOptions?.attributes?.["openclaw.memory.rss_growth_bytes"]).toBe(256);
    expect(pressureOptions?.attributes?.["openclaw.memory.window_ms"]).toBe(60_000);
    const pressureSpan = telemetryState.spans.find(
      (span) => span.name === "openclaw.memory.pressure",
    );
    expect(pressureSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "rss_growth",
    });
    expect(JSON.stringify(pressureCall)).not.toContain("session");
  });

  test("records async diagnostic queue drop summaries", async () => {
    await startOtelService({ metrics: true });

    await emitAndFlush({
      type: "diagnostic.async_queue.dropped",
      droppedEvents: 4,
      droppedTrustedEvents: 1,
      droppedUntrustedEvents: 2,
      droppedPriorityEvents: 1,
      queueLength: 0,
      maxQueueLength: 10_000,
      drainBatchSize: 100,
    });

    const counter = telemetryState.counters.get("openclaw.diagnostic.async_queue.dropped");
    expect(counter?.add).toHaveBeenCalledWith(4, {
      "openclaw.diagnostic.async_queue.drop_class": "total",
    });
    expect(counter?.add).toHaveBeenCalledWith(1, {
      "openclaw.diagnostic.async_queue.drop_class": "trusted",
    });
    expect(counter?.add).toHaveBeenCalledWith(2, {
      "openclaw.diagnostic.async_queue.drop_class": "untrusted",
    });
    expect(counter?.add).toHaveBeenCalledWith(1, {
      "openclaw.diagnostic.async_queue.drop_class": "priority",
    });
  });

  test("parents trusted diagnostic lifecycle spans from active started spans", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitRunStarted();
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      ...MODEL_CALL_FIXTURE,
      trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-1",
      toolName: "read",
      trace: createTestTrace(TOOL_SPAN_ID, GRANDCHILD_SPAN_ID),
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-1",
      toolName: "read",
      durationMs: 20,
      errorCategory: "TypeError",
      trace: createTestTrace(TOOL_SPAN_ID, GRANDCHILD_SPAN_ID),
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      durationMs: 80,
      trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
    });
    await emitTrustedAndFlush({
      type: "run.completed",
      ...RUN_FIXTURE,
      outcome: "completed",
      durationMs: 100,
      trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
    });

    const runSpan = telemetryState.spans.find((span) => span.name === "openclaw.run");
    const modelSpan = telemetryState.spans.find((span) => span.name === "openclaw.model.call");
    const toolSpan = telemetryState.spans.find((span) => span.name === "openclaw.tool.execution");
    const runSpanId = runSpan?.spanContext.mock.results[0]?.value?.spanId;
    const modelSpanId = modelSpan?.spanContext.mock.results[0]?.value?.spanId;

    expect(telemetryState.tracer.setSpanContext).toHaveBeenCalledTimes(2);
    const linkedSpanContexts = telemetryState.tracer.setSpanContext.mock.calls.map(
      (call) => call[1] as Record<string, unknown>,
    );
    expect(linkedSpanContexts[0]?.traceId).toBe(TRACE_ID);
    expect(linkedSpanContexts[0]?.spanId).toBe(runSpanId);
    expect(linkedSpanContexts[1]?.traceId).toBe(TRACE_ID);
    expect(linkedSpanContexts[1]?.spanId).toBe(modelSpanId);

    const parentBySpanName = Object.fromEntries(
      telemetryState.tracer.startSpan.mock.calls.map((call) => [
        call[0],
        (call[2] as { spanContext?: { spanId?: string } } | undefined)?.spanContext?.spanId,
      ]),
    );
    expect(parentBySpanName["openclaw.run"]).toBeUndefined();
    expect(parentBySpanName["openclaw.model.call"]).toBe(runSpanId);
    expect(parentBySpanName["openclaw.tool.execution"]).toBe(modelSpanId);
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "TypeError",
    });
  });

  test("correlates one channel message waterfall across message, harness, usage, and model spans", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitTrustedDiagnosticEvent({
      type: "message.dispatch.started",
      channel: "slack",
      source: "replyResolver",
      sessionKey: "agent:main:slack:channel:c1",
      trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
    });
    emitTrustedDiagnosticEvent({
      type: "harness.run.started",
      runId: "run-1",
      harnessId: "codex",
      pluginId: "codex",
      provider: "openai",
      model: "gpt-5.5",
      channel: "slack",
      trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
    });
    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.5",
      channel: "slack",
      trace: createTestTrace(TOOL_SPAN_ID, GRANDCHILD_SPAN_ID),
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.5",
      api: "openai-codex-responses",
      transport: "stdio",
      trace: createTestTrace(MODEL_CALL_SPAN_ID, TOOL_SPAN_ID),
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.5",
      api: "openai-codex-responses",
      transport: "stdio",
      durationMs: 80,
      trace: createTestTrace(MODEL_CALL_SPAN_ID, TOOL_SPAN_ID),
    });
    emitTrustedDiagnosticEvent({
      type: "harness.run.completed",
      runId: "run-1",
      harnessId: "codex",
      pluginId: "codex",
      provider: "openai",
      model: "gpt-5.5",
      channel: "slack",
      durationMs: 100,
      outcome: "completed",
      itemLifecycle: { startedCount: 1, completedCount: 1, activeCount: 0 },
      trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
    });
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      sessionKey: "agent:main:slack:channel:c1",
      channel: "slack",
      agentId: "main",
      provider: "openai",
      model: "gpt-5.5",
      usage: { input: 3, output: 2, total: 5 },
      durationMs: 10,
      trace: createTestTrace(MODEL_USAGE_SPAN_ID, GRANDCHILD_SPAN_ID),
    });
    await emitTrustedAndFlush({
      type: "message.processed",
      channel: "slack",
      sessionKey: "agent:main:slack:channel:c1",
      durationMs: 120,
      outcome: "completed",
      trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
    });

    const messageSpan = spanByName("openclaw.message.processed");
    const harnessSpan = spanByName("openclaw.harness.run");
    const runSpan = spanByName("openclaw.run");
    const usageSpan = spanByName("openclaw.model.usage");
    const modelCallSpan = spanByName("openclaw.model.call");
    const messageSpanContext = messageSpan.spanContext();
    const harnessSpanContext = harnessSpan.spanContext();
    const runSpanContext = runSpan.spanContext();
    const usageSpanContext = usageSpan.spanContext();
    const modelCallSpanContext = modelCallSpan.spanContext();

    const parentBySpanName = Object.fromEntries(
      telemetryState.tracer.startSpan.mock.calls.map((call) => [
        call[0],
        (call[2] as { spanContext?: { traceId?: string; spanId?: string } } | undefined)
          ?.spanContext,
      ]),
    );

    expect(messageSpanContext.traceId).toBe(TRACE_ID);
    expect(harnessSpanContext.traceId).toBe(TRACE_ID);
    expect(usageSpanContext.traceId).toBe(TRACE_ID);
    expect(modelCallSpanContext.traceId).toBe(TRACE_ID);
    expect(parentBySpanName["openclaw.message.processed"]?.spanId).toBe(SPAN_ID);
    expect(parentBySpanName["openclaw.harness.run"]?.spanId).toBe(messageSpanContext.spanId);
    expect(parentBySpanName["openclaw.run"]?.spanId).toBe(harnessSpanContext.spanId);
    expect(parentBySpanName["openclaw.model.usage"]?.spanId).toBe(harnessSpanContext.spanId);
    expect(parentBySpanName["openclaw.model.call"]?.spanId).toBe(runSpanContext.spanId);
  });

  test("uses production message lifecycle helpers as the message span anchor", async () => {
    await startOtelService({ traces: true, metrics: true });

    const messageTrace = createDiagnosticTraceContext(createTestTrace(CHILD_SPAN_ID, SPAN_ID));

    runWithDiagnosticTraceContext(messageTrace, () => {
      logMessageDispatchStarted({
        channel: "slack",
        sessionKey: "agent:main:slack:channel:c1",
        source: "replyResolver",
      });
      emitTrustedDiagnosticEvent({
        type: "harness.run.started",
        runId: "run-1",
        harnessId: "codex",
        pluginId: "codex",
        provider: "openai",
        model: "gpt-5.5",
        channel: "slack",
        trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
      });
      emitTrustedDiagnosticEvent({
        type: "model.usage",
        sessionKey: "agent:main:slack:channel:c1",
        channel: "slack",
        agentId: "main",
        provider: "openai",
        model: "gpt-5.5",
        usage: { input: 3, output: 2, total: 5 },
        durationMs: 10,
        trace: createTestTrace(MODEL_USAGE_SPAN_ID, GRANDCHILD_SPAN_ID),
      });
      logMessageProcessed({
        channel: "slack",
        sessionKey: "agent:main:slack:channel:c1",
        durationMs: 120,
        outcome: "completed",
      });
    });
    await flushDiagnosticEvents();

    const messageSpan = spanByName("openclaw.message.processed");
    const harnessSpan = spanByName("openclaw.harness.run");
    const messageSpanContext = messageSpan.spanContext();
    const harnessSpanContext = harnessSpan.spanContext();
    const parentBySpanName = Object.fromEntries(
      telemetryState.tracer.startSpan.mock.calls.map((call) => [
        call[0],
        (call[2] as { spanContext?: { traceId?: string; spanId?: string } } | undefined)
          ?.spanContext,
      ]),
    );

    expect(parentBySpanName["openclaw.message.processed"]?.spanId).toBe(SPAN_ID);
    expect(parentBySpanName["openclaw.harness.run"]?.spanId).toBe(messageSpanContext.spanId);
    expect(parentBySpanName["openclaw.model.usage"]?.spanId).toBe(harnessSpanContext.spanId);
    expect(messageSpanContext.traceId).toBe(TRACE_ID);
    expect(harnessSpanContext.traceId).toBe(TRACE_ID);
  });

  test("does not force a remote parent for root message lifecycle helpers", async () => {
    await startOtelService({ traces: true, metrics: true });

    const messageTrace = createDiagnosticTraceContext(createTestTrace(CHILD_SPAN_ID));

    runWithDiagnosticTraceContext(messageTrace, () => {
      logMessageDispatchStarted({
        channel: "slack",
        sessionKey: "agent:main:slack:channel:c1",
        source: "replyResolver",
      });
      logMessageProcessed({
        channel: "slack",
        sessionKey: "agent:main:slack:channel:c1",
        durationMs: 120,
        outcome: "completed",
      });
    });
    await flushDiagnosticEvents();

    expect(spanByName("openclaw.message.processed").spanContext().traceId).toBe(TRACE_ID);
    expect(startedSpanParentContexts("openclaw.message.processed")[0]).toBeUndefined();
  });

  test("parents outbound delivery spans under the active message lifecycle span", async () => {
    await startOtelService({ traces: true, metrics: true });

    const messageTrace = createDiagnosticTraceContext(createTestTrace(CHILD_SPAN_ID, SPAN_ID));

    runWithDiagnosticTraceContext(messageTrace, () => {
      logMessageDispatchStarted({
        channel: "slack",
        sessionKey: "agent:main:slack:channel:c1",
        source: "replyResolver",
      });
      emitInternalDiagnosticEventForTest({
        type: "message.delivery.completed",
        channel: "slack",
        deliveryKind: "text",
        sessionKey: "agent:main:slack:channel:c1",
        durationMs: 15,
        resultCount: 1,
      });
      emitInternalDiagnosticEventForTest({
        type: "message.delivery.error",
        channel: "slack",
        deliveryKind: "media",
        sessionKey: "agent:main:slack:channel:c1",
        durationMs: 25,
        errorCategory: "network",
      });
      logMessageProcessed({
        channel: "slack",
        sessionKey: "agent:main:slack:channel:c1",
        durationMs: 120,
        outcome: "completed",
      });
    });
    await flushDiagnosticEvents();

    const messageSpanContext = spanByName("openclaw.message.processed").spanContext();
    const deliveryParentContexts = startedSpanParentContexts("openclaw.message.delivery");

    expect(deliveryParentContexts).toHaveLength(2);
    expect(deliveryParentContexts[0]?.traceId).toBe(TRACE_ID);
    expect(deliveryParentContexts[0]?.spanId).toBe(messageSpanContext.spanId);
    expect(deliveryParentContexts[1]?.traceId).toBe(TRACE_ID);
    expect(deliveryParentContexts[1]?.spanId).toBe(messageSpanContext.spanId);
  });

  test("parents multi-batch late delivery spans from the retained message context", async () => {
    await startOtelService({ traces: true, metrics: true });

    const messageTrace = createDiagnosticTraceContext(createTestTrace(CHILD_SPAN_ID, SPAN_ID));

    runWithDiagnosticTraceContext(messageTrace, () => {
      logMessageDispatchStarted({
        channel: "slack",
        sessionKey: "agent:main:slack:channel:c1",
        source: "replyResolver",
      });
      for (let index = 0; index < 125; index += 1) {
        emitInternalDiagnosticEventForTest({
          type: "message.delivery.completed",
          channel: "slack",
          deliveryKind: "text",
          sessionKey: `agent:main:slack:channel:c${index}`,
          durationMs: 15,
          resultCount: 1,
        });
      }
      logMessageProcessed({
        channel: "slack",
        sessionKey: "agent:main:slack:channel:c1",
        durationMs: 120,
        outcome: "completed",
      });
    });

    const messageSpan = spanByName("openclaw.message.processed");
    const messageSpanContext = messageSpan.spanContext();
    expect(messageSpan.end).toHaveBeenCalledTimes(1);
    await waitForDiagnosticEventsDrained();

    const deliveryParentContexts = startedSpanParentContexts("openclaw.message.delivery");
    expect(deliveryParentContexts).toHaveLength(125);
    expect(deliveryParentContexts.every((parent) => parent?.traceId === TRACE_ID)).toBe(true);
    expect(
      deliveryParentContexts.every((parent) => parent?.spanId === messageSpanContext.spanId),
    ).toBe(true);
  });

  test("correlates skipped duplicate message lifecycle helpers to the active inbound trace", async () => {
    await startOtelService({ traces: true, metrics: true });

    const messageTrace = createDiagnosticTraceContext(createTestTrace(CHILD_SPAN_ID, SPAN_ID));

    runWithDiagnosticTraceContext(messageTrace, () => {
      logMessageProcessed({
        channel: "slack",
        messageId: "msg-duplicate",
        chatId: "c1",
        sessionKey: "agent:main:slack:channel:c1",
        durationMs: 5,
        outcome: "skipped",
        reason: "duplicate",
      });
    });
    await flushDiagnosticEvents();

    const messageSpan = spanByName("openclaw.message.processed");
    const messageSpanContext = messageSpan.spanContext();
    const parentContext = startedSpanParentContexts("openclaw.message.processed")[0];

    expect(messageSpanContext.traceId).toBe(TRACE_ID);
    expect(parentContext?.traceId).toBe(TRACE_ID);
    expect(parentContext?.spanId).toBe(SPAN_ID);
    expect(firstSpanAttributes("openclaw.message.processed")["openclaw.reason"]).toBe("duplicate");
    expect(messageSpan.end).toHaveBeenCalledTimes(1);
  });

  test("does not force a remote parent for fallback root message processed spans", async () => {
    await startOtelService({ traces: true, metrics: true });

    await emitTrustedAndFlush({
      type: "message.processed",
      channel: "slack",
      sessionKey: "agent:main:slack:channel:c1",
      durationMs: 25,
      outcome: "skipped",
      trace: createTestTrace(CHILD_SPAN_ID),
    });

    expect(spanByName("openclaw.message.processed").spanContext().traceId).toBe(TRACE_ID);
    expect(startedSpanParentContexts("openclaw.message.processed")[0]).toBeUndefined();
  });

  test("does not retain fallback message processed spans as active parents", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitTrustedDiagnosticEvent({
      type: "message.processed",
      channel: "slack",
      sessionKey: "agent:main:slack:channel:c1",
      durationMs: 25,
      outcome: "skipped",
      trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
    });
    expect(spanByName("openclaw.message.processed").end).toHaveBeenCalledTimes(1);

    telemetryState.tracer.setSpanContext.mockClear();
    emitTrustedDiagnosticEvent({
      type: "harness.run.started",
      runId: "run-1",
      harnessId: "codex",
      pluginId: "codex",
      provider: "openai",
      model: "gpt-5.5",
      channel: "slack",
      trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
    });

    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    expect(startedSpanCall("openclaw.harness.run")?.[2]).toBeUndefined();
  });

  test("retains trusted run context long enough for exact post-completion usage parenting", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitRunStarted();
    emitRunCompleted();
    await Promise.resolve();
    await emitTrustedAndFlush({
      type: "model.usage",
      ...MODEL_FIXTURE,
      usage: { input: 3, output: 2, total: 5 },
      durationMs: 10,
      trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
    });

    const runSpan = telemetryState.spans.find((span) => span.name === "openclaw.run");
    const runSpanId = runSpan?.spanContext.mock.results[0]?.value?.spanId;
    const modelUsageCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.usage",
    );

    const linkedSpanContext = firstSetSpanContext();
    expect(linkedSpanContext.traceId).toBe(TRACE_ID);
    expect(linkedSpanContext.spanId).toBe(runSpanId);
    expect(
      (modelUsageCall?.[2] as { spanContext?: { spanId?: string } } | undefined)?.spanContext
        ?.spanId,
    ).toBe(runSpanId);
    expect(firstSpanEndTime("openclaw.run")).toBeTypeOf("number");
  });

  test.each([
    ["does not parent sibling active runs through shared upstream aliases", false],
    ["does not parent sibling runs through retained upstream aliases", true],
  ])("%s", async (_name, completeFirstRun) => {
    await startOtelService({ traces: true, metrics: true });

    emitRunStarted();
    if (completeFirstRun) {
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        ...RUN_FIXTURE,
        outcome: "completed",
        durationMs: 100,
        trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
      });
    }
    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "run-2",
      ...MODEL_FIXTURE,
      trace: createTestTrace(GRANDCHILD_SPAN_ID, SPAN_ID),
    });

    const runContexts = startedSpanParentContextsByName("openclaw.run");

    expect(runContexts).toHaveLength(2);
    expect(runContexts[0]?.parentContext).toBeUndefined();
    expect(runContexts[1]?.parentContext).toBeUndefined();
  });

  test("parents retained upstream alias events only when the owner matches", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitRunStarted();
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      durationMs: 80,
      trace: createTestTrace(MODEL_CALL_SPAN_ID, SPAN_ID),
    });
    await emitTrustedAndFlush({
      type: "run.completed",
      ...RUN_FIXTURE,
      outcome: "completed",
      durationMs: 100,
      trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
    });

    const runSpanContext = spanByName("openclaw.run").spanContext();
    const modelParentContext = startedSpanParentContexts("openclaw.model.call")[0];

    expect(modelParentContext?.traceId).toBe(TRACE_ID);
    expect(modelParentContext?.spanId).toBe(runSpanContext.spanId);
  });

  test("parents multi-batch late model spans from the retained run context", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitQueuedRunWithModelCalls();

    const runSpan = spanByName("openclaw.run");
    const runSpanContext = runSpan.spanContext();
    expect(runSpan.end).toHaveBeenCalledTimes(1);
    await waitForDiagnosticEventsDrained();

    const modelParentContexts = startedSpanParentContexts("openclaw.model.call");
    expect(modelParentContexts).toHaveLength(125);
    expect(modelParentContexts.every((parent) => parent?.traceId === TRACE_ID)).toBe(true);
    expect(modelParentContexts.every((parent) => parent?.spanId === runSpanContext.spanId)).toBe(
      true,
    );
  });

  test("removes retained run contexts after queued diagnostics drain", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitQueuedRunWithModelCalls();

    await waitForDiagnosticEventsDrained();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    await waitForDiagnosticEventsDrained();
    await Promise.resolve();
    telemetryState.tracer.setSpanContext.mockClear();
    telemetryState.tracer.startSpan.mockClear();

    emitDefaultModelUsage();

    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    expect(startedSpanCall("openclaw.model.usage")?.[2]).toBeUndefined();
  });

  test("clears retained run contexts when the service stops", async () => {
    const { service, ctx } = await startOtelService({ traces: true, metrics: true });

    emitRunStarted();
    emitRunCompleted();

    await service.stop?.(ctx);
    await service.start(ctx);
    telemetryState.tracer.setSpanContext.mockClear();
    telemetryState.tracer.startSpan.mockClear();

    emitDefaultModelUsage();

    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    expect(startedSpanCall("openclaw.model.usage")?.[2]).toBeUndefined();
  });

  test.each([
    [
      "does not force remote parents for completed-only trusted lifecycle spans",
      createTestTrace(CHILD_SPAN_ID, SPAN_ID),
      createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
    ],
    [
      "does not self-parent trusted diagnostic lifecycle spans without parent ids",
      createTestTrace(CHILD_SPAN_ID),
      createTestTrace(GRANDCHILD_SPAN_ID),
    ],
  ])("%s", async (_name, runTrace, modelTrace) => {
    await startOtelService({ traces: true, metrics: true });

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      ...RUN_FIXTURE,
      outcome: "completed",
      durationMs: 100,
      trace: runTrace,
    });
    await emitTrustedAndFlush({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      durationMs: 80,
      trace: modelTrace,
    });

    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    const parentBySpanName = Object.fromEntries(
      telemetryState.tracer.startSpan.mock.calls.map((call) => [call[0], call[2]]),
    );
    expect(parentBySpanName["openclaw.run"]).toBeUndefined();
    expect(parentBySpanName["openclaw.model.call"]).toBeUndefined();
  });

  test("does not parent untrusted diagnostic lifecycle spans from injected trace ids", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitDiagnosticEvent({
      type: "run.completed",
      ...RUN_FIXTURE,
      outcome: "completed",
      durationMs: 100,
      trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      durationMs: 80,
      trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
    });
    await emitAndFlush({
      type: "tool.execution.completed",
      runId: "run-1",
      toolName: "read",
      durationMs: 20,
      trace: createTestTrace(TOOL_SPAN_ID, GRANDCHILD_SPAN_ID),
    });

    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    const parentBySpanName = Object.fromEntries(
      telemetryState.tracer.startSpan.mock.calls.map((call) => [call[0], call[2]]),
    );
    expect(parentBySpanName["openclaw.run"]).toBeUndefined();
    expect(parentBySpanName["openclaw.model.call"]).toBeUndefined();
    expect(parentBySpanName["openclaw.tool.execution"]).toBeUndefined();
  });

  test("does not create live started spans for untrusted lifecycle diagnostics", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitDiagnosticEvent({
      type: "run.started",
      ...RUN_FIXTURE,
    });
    emitDiagnosticEvent({
      type: "run.completed",
      ...RUN_FIXTURE,
      outcome: "completed",
      durationMs: 100,
    });
    emitDiagnosticEvent({
      type: "model.call.started",
      ...MODEL_CALL_FIXTURE,
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      durationMs: 80,
    });
    emitDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-1",
      toolName: "read",
    });
    emitDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-1",
      toolName: "read",
      durationMs: 20,
      errorCategory: "TypeError",
    });
    emitDiagnosticEvent({
      type: "harness.run.started",
      runId: "run-1",
      provider: "codex",
      model: "gpt-5.4",
      harnessId: "codex",
      pluginId: "codex-plugin",
    });
    await emitAndFlush({
      type: "harness.run.completed",
      runId: "run-1",
      provider: "codex",
      model: "gpt-5.4",
      harnessId: "codex",
      pluginId: "codex-plugin",
      outcome: "completed",
      durationMs: 90,
    });

    expect(
      telemetryState.tracer.startSpan.mock.calls.filter((call) => call[0] === "openclaw.run"),
    ).toHaveLength(1);
    expect(
      telemetryState.tracer.startSpan.mock.calls.filter(
        (call) => call[0] === "openclaw.model.call",
      ),
    ).toHaveLength(1);
    expect(
      telemetryState.tracer.startSpan.mock.calls.filter(
        (call) => call[0] === "openclaw.tool.execution",
      ),
    ).toHaveLength(1);
    expect(
      telemetryState.tracer.startSpan.mock.calls.filter(
        (call) => call[0] === "openclaw.harness.run",
      ),
    ).toHaveLength(1);
  });

  test("exports exec process spans without command text", async () => {
    await startOtelService({ traces: true, metrics: true });

    await emitAndFlush({
      type: "exec.process.completed",
      target: "host",
      mode: "child",
      outcome: "failed",
      durationMs: 30,
      commandLength: 42,
      exitCode: 1,
      timedOut: false,
      failureKind: "runtime-error",
    });

    const execDuration = lastHistogramRecord("openclaw.exec.duration_ms");
    expect(execDuration?.[0]).toBe(30);
    expect(execDuration?.[1]?.["openclaw.exec.target"]).toBe("host");
    expect(execDuration?.[1]?.["openclaw.exec.mode"]).toBe("child");
    expect(execDuration?.[1]?.["openclaw.outcome"]).toBe("failed");
    expect(execDuration?.[1]?.["openclaw.failureKind"]).toBe("runtime-error");

    const execCall = startedSpanCall("openclaw.exec");
    const execOptions = execCall?.[1];
    expect(execOptions?.attributes?.["openclaw.exec.target"]).toBe("host");
    expect(execOptions?.attributes?.["openclaw.exec.mode"]).toBe("child");
    expect(execOptions?.attributes?.["openclaw.outcome"]).toBe("failed");
    expect(execOptions?.attributes?.["openclaw.exec.command_length"]).toBe(42);
    expect(execOptions?.attributes?.["openclaw.exec.exit_code"]).toBe(1);
    expect(execOptions?.attributes?.["openclaw.exec.timed_out"]).toBe(false);
    expect(execOptions?.attributes?.["openclaw.failureKind"]).toBe("runtime-error");
    expect(Object.hasOwn(execOptions?.attributes ?? {}, "openclaw.exec.command")).toBe(false);
    expect(Object.hasOwn(execOptions?.attributes ?? {}, "openclaw.exec.workdir")).toBe(false);
    expect(Object.hasOwn(execOptions?.attributes ?? {}, "openclaw.sessionKey")).toBe(false);
    expect(execOptions?.startTime).toBeTypeOf("number");

    const execSpan = spanByName("openclaw.exec");
    expect(execSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "runtime-error",
    });
    expect(firstSpanEndTime("openclaw.exec")).toBeTypeOf("number");
  });

  test("exports message delivery spans and metrics with low-cardinality attributes", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitDiagnosticEvent({
      type: "message.delivery.started",
      channel: "matrix",
      deliveryKind: "text",
      sessionKey: "session-secret",
    });
    emitDiagnosticEvent({
      type: "message.delivery.completed",
      channel: "matrix",
      deliveryKind: "text",
      durationMs: 25,
      resultCount: 1,
      sessionKey: "session-secret",
    });
    await emitAndFlush({
      type: "message.delivery.error",
      channel: "discord",
      deliveryKind: "media",
      durationMs: 40,
      errorCategory: "TypeError",
      sessionKey: "session-secret",
    });

    expect(
      telemetryState.counters.get("openclaw.message.delivery.started")?.add,
    ).toHaveBeenCalledWith(1, {
      "openclaw.channel": "matrix",
      "openclaw.delivery.kind": "text",
    });
    const deliveryDurationRecords = telemetryState.histograms.get(
      "openclaw.message.delivery.duration_ms",
    )?.record.mock.calls as Array<[unknown, Record<string, unknown>]>;
    expect(deliveryDurationRecords[0]?.[0]).toBe(25);
    expect(deliveryDurationRecords[0]?.[1]["openclaw.channel"]).toBe("matrix");
    expect(deliveryDurationRecords[0]?.[1]["openclaw.delivery.kind"]).toBe("text");
    expect(deliveryDurationRecords[0]?.[1]["openclaw.outcome"]).toBe("completed");
    expect(deliveryDurationRecords[1]?.[0]).toBe(40);
    expect(deliveryDurationRecords[1]?.[1]["openclaw.channel"]).toBe("discord");
    expect(deliveryDurationRecords[1]?.[1]["openclaw.delivery.kind"]).toBe("media");
    expect(deliveryDurationRecords[1]?.[1]["openclaw.outcome"]).toBe("error");
    expect(deliveryDurationRecords[1]?.[1]["openclaw.errorCategory"]).toBe("TypeError");

    const deliverySpanCalls = telemetryState.tracer.startSpan.mock.calls.filter(
      (call) => call[0] === "openclaw.message.delivery",
    );
    expect(deliverySpanCalls).toHaveLength(2);
    const firstDeliveryOptions = deliverySpanCalls[0]?.[1] as
      | { attributes?: Record<string, unknown>; startTime?: unknown }
      | undefined;
    expect(firstDeliveryOptions?.attributes?.["openclaw.channel"]).toBe("matrix");
    expect(firstDeliveryOptions?.attributes?.["openclaw.delivery.kind"]).toBe("text");
    expect(firstDeliveryOptions?.attributes?.["openclaw.outcome"]).toBe("completed");
    expect(firstDeliveryOptions?.attributes?.["openclaw.delivery.result_count"]).toBe(1);
    expect(firstDeliveryOptions?.startTime).toBeTypeOf("number");
    const secondDeliveryOptions = deliverySpanCalls[1]?.[1] as
      | { attributes?: Record<string, unknown>; startTime?: unknown }
      | undefined;
    expect(secondDeliveryOptions?.attributes?.["openclaw.channel"]).toBe("discord");
    expect(secondDeliveryOptions?.attributes?.["openclaw.delivery.kind"]).toBe("media");
    expect(secondDeliveryOptions?.attributes?.["openclaw.outcome"]).toBe("error");
    expect(secondDeliveryOptions?.attributes?.["openclaw.errorCategory"]).toBe("TypeError");
    expect(secondDeliveryOptions?.startTime).toBeTypeOf("number");
    for (const call of deliverySpanCalls) {
      const options = call[1] as { attributes?: Record<string, unknown>; startTime?: unknown };
      expect(Object.hasOwn(options.attributes ?? {}, "openclaw.chatId")).toBe(false);
      expect(Object.hasOwn(options.attributes ?? {}, "openclaw.sessionKey")).toBe(false);
      expect(Object.hasOwn(options.attributes ?? {}, "openclaw.messageId")).toBe(false);
      expect(Object.hasOwn(options.attributes ?? {}, "openclaw.conversationId")).toBe(false);
      expect(Object.hasOwn(options.attributes ?? {}, "openclaw.content")).toBe(false);
      expect(Object.hasOwn(options.attributes ?? {}, "openclaw.to")).toBe(false);
      expect(options.startTime).toBeTypeOf("number");
    }
    const errorSpan = telemetryState.spans.find(
      (span) => span.name === "openclaw.message.delivery" && span.setStatus.mock.calls.length > 0,
    );
    expect(errorSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "TypeError",
    });
  });

  test("bounds unsafe message delivery attributes before export", async () => {
    await startOtelService({ traces: true, metrics: true });

    await emitAndFlush({
      type: "message.delivery.completed",
      channel: "discord/custom",
      deliveryKind: "progress draft" as never,
      durationMs: 20,
      resultCount: 1,
      sessionKey: "session-secret",
    });

    const deliveryDuration = lastHistogramRecord("openclaw.message.delivery.duration_ms");
    expect(deliveryDuration?.[0]).toBe(20);
    expect(deliveryDuration?.[1]?.["openclaw.channel"]).toBe("unknown");
    expect(deliveryDuration?.[1]?.["openclaw.delivery.kind"]).toBe("other");
    expect(deliveryDuration?.[1]?.["openclaw.outcome"]).toBe("completed");
    const deliverySpanCall = startedSpanCall("openclaw.message.delivery");
    const deliveryOptions = deliverySpanCall?.[1];
    expect(deliveryOptions?.attributes?.["openclaw.channel"]).toBe("unknown");
    expect(deliveryOptions?.attributes?.["openclaw.delivery.kind"]).toBe("other");
    expect(deliveryOptions?.attributes?.["openclaw.outcome"]).toBe("completed");
    expect(deliveryOptions?.attributes?.["openclaw.delivery.result_count"]).toBe(1);
    expect(deliveryOptions?.startTime).toBeTypeOf("number");
  });

  test("exports session recovery and talk metrics with bounded attributes", async () => {
    await startOtelService({ metrics: true });

    emitTrustedDiagnosticEvent({
      type: "session.recovery.requested",
      sessionId: "session-should-not-export",
      sessionKey: "key-should-not-export",
      state: "processing",
      ageMs: 12_000,
      reason: "startup-sweep",
      activeWorkKind: "tool_call",
      allowActiveAbort: true,
    });
    emitTrustedDiagnosticEvent({
      type: "session.recovery.completed",
      sessionId: "session-should-not-export",
      sessionKey: "key-should-not-export",
      state: "processing",
      ageMs: 13_000,
      reason: "startup-sweep",
      activeWorkKind: "tool_call",
      status: "released",
      action: "abort-active-run",
    });
    emitTrustedDiagnosticEvent({
      type: "talk.event",
      sessionId: "talk-session-should-not-export",
      turnId: "turn-should-not-export",
      talkEventType: "input.audio.delta",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      byteLength: 320,
    });
    await emitTrustedAndFlush({
      type: "talk.event",
      sessionId: "talk-session-should-not-export",
      talkEventType: "latency.metrics",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "openai",
      durationMs: 45,
    });

    const recoveryRequestedCall = firstCounterAddCall("openclaw.session.recovery.requested");
    expect(recoveryRequestedCall[0]).toBe(1);
    expect(recoveryRequestedCall[1]?.["openclaw.state"]).toBe("processing");
    expect(recoveryRequestedCall[1]?.["openclaw.action"]).toBe("abort");
    expect(recoveryRequestedCall[1]?.["openclaw.active_work_kind"]).toBe("tool_call");
    const recoveryCompletedCall = firstCounterAddCall("openclaw.session.recovery.completed");
    expect(recoveryCompletedCall[0]).toBe(1);
    expect(recoveryCompletedCall[1]?.["openclaw.state"]).toBe("processing");
    expect(recoveryCompletedCall[1]?.["openclaw.status"]).toBe("released");
    expect(recoveryCompletedCall[1]?.["openclaw.action"]).toBe("abort-active-run");
    const recoveryAgeRecord = lastHistogramRecord("openclaw.session.recovery.age_ms");
    expect(recoveryAgeRecord?.[0]).toBe(13_000);
    expect(recoveryAgeRecord?.[1]?.["openclaw.status"]).toBe("released");
    expect(telemetryState.counters.get("openclaw.talk.event")?.add).toHaveBeenCalledWith(1, {
      "openclaw.talk.brain": "agent-consult",
      "openclaw.talk.event_type": "input.audio.delta",
      "openclaw.talk.mode": "realtime",
      "openclaw.talk.provider": "openai",
      "openclaw.talk.transport": "gateway-relay",
    });
    expect(telemetryState.histograms.get("openclaw.talk.audio.bytes")?.record).toHaveBeenCalledWith(
      320,
      {
        "openclaw.talk.brain": "agent-consult",
        "openclaw.talk.event_type": "input.audio.delta",
        "openclaw.talk.mode": "realtime",
        "openclaw.talk.provider": "openai",
        "openclaw.talk.transport": "gateway-relay",
      },
    );
    expect(
      telemetryState.histograms.get("openclaw.talk.event.duration_ms")?.record,
    ).toHaveBeenCalledWith(45, {
      "openclaw.talk.brain": "agent-consult",
      "openclaw.talk.event_type": "latency.metrics",
      "openclaw.talk.mode": "realtime",
      "openclaw.talk.provider": "openai",
      "openclaw.talk.transport": "gateway-relay",
    });

    const talkCounterCalls = JSON.stringify(
      telemetryState.counters.get("openclaw.talk.event")?.add.mock.calls,
    );
    expect(talkCounterCalls).not.toContain("talk-session-should-not-export");
    expect(talkCounterCalls).not.toContain("turn-should-not-export");
  });

  test("does not export model or tool content unless capture is explicitly enabled", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 80,
      },
      {
        inputMessages: ["private user prompt"],
        outputMessages: ["private model reply"],
        systemPrompt: "private system prompt",
      },
    );
    emitTrustedToolExecutionCompletedWithContent(
      {
        runId: "run-1",
        toolName: "read",
        toolCallId: "tool-1",
        durationMs: 20,
      },
      {
        toolInput: "private tool input",
        toolOutput: "private tool output",
      },
    );
    await flushDiagnosticEvents();

    const modelOptions = startedSpanOptions("openclaw.model.call");
    expect(Object.hasOwn(modelOptions?.attributes ?? {}, "openclaw.content.input_messages")).toBe(
      false,
    );
    expect(Object.hasOwn(modelOptions?.attributes ?? {}, "openclaw.content.output_messages")).toBe(
      false,
    );
    expect(Object.hasOwn(modelOptions?.attributes ?? {}, "openclaw.content.system_prompt")).toBe(
      false,
    );
    expect(modelOptions?.startTime).toBeTypeOf("number");
    const toolOptions = startedSpanOptions("openclaw.tool.execution");
    expect(Object.hasOwn(toolOptions?.attributes ?? {}, "openclaw.content.tool_input")).toBe(false);
    expect(Object.hasOwn(toolOptions?.attributes ?? {}, "openclaw.content.tool_output")).toBe(
      false,
    );
    expect(Object.hasOwn(toolOptions?.attributes ?? {}, "gen_ai.tool.call.arguments")).toBe(false);
    expect(Object.hasOwn(toolOptions?.attributes ?? {}, "gen_ai.tool.call.result")).toBe(false);
    expect(toolOptions?.attributes?.["gen_ai.tool.call.id"]).toBe("tool-1");
    expect(toolOptions?.attributes?.["gen_ai.operation.name"]).toBe("execute_tool");
    expect(toolOptions?.startTime).toBeTypeOf("number");
  });

  test("exports bounded redacted content when capture fields are opted in", async () => {
    await startOtelService({
      traces: true,
      metrics: true,
      captureContent: {
        enabled: true,
        inputMessages: true,
        outputMessages: true,
        toolInputs: true,
        toolOutputs: true,
        systemPrompt: true,
      },
    });

    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 80,
      },
      {
        inputMessages: ["use key sk-1234567890abcdef1234567890abcdef"], // pragma: allowlist secret
        outputMessages: ["model reply"],
        systemPrompt: "system prompt",
      },
    );
    emitTrustedToolExecutionCompletedWithContent(
      {
        runId: "run-1",
        toolName: "read",
        toolCallId: "tool-1",
        durationMs: 20,
      },
      {
        toolInput: "tool input",
        toolOutput: `${"x".repeat(4077)} Bearer ${"a".repeat(80)}`, // pragma: allowlist secret
      },
    );
    await flushDiagnosticEvents();

    const modelAttrs = startedSpanOptions("openclaw.model.call")?.attributes;
    const toolAttrs = startedSpanOptions("openclaw.tool.execution")?.attributes;

    expect(modelAttrs?.["openclaw.content.output_messages"]).toBe("model reply");
    expect(modelAttrs?.["openclaw.content.system_prompt"]).toBe("system prompt");
    expect(String(modelAttrs?.["openclaw.content.input_messages"])).not.toContain(
      "sk-1234567890abcdef1234567890abcdef", // pragma: allowlist secret
    );
    expect(toolAttrs?.["openclaw.content.tool_input"]).toBe("tool input");
    expect(toolAttrs?.["gen_ai.tool.call.id"]).toBe("tool-1");
    expect(toolAttrs?.["gen_ai.operation.name"]).toBe("execute_tool");
    expect(toolAttrs?.["gen_ai.tool.call.arguments"]).toBe(
      toolAttrs?.["openclaw.content.tool_input"],
    );
    expect(typeof toolAttrs?.["openclaw.content.tool_output"]).toBe("string");
    expect(String(toolAttrs?.["openclaw.content.tool_output"]).length).toBeLessThanOrEqual(
      MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS + OTEL_TRUNCATED_SUFFIX_MAX_CHARS,
    );
    expect(String(toolAttrs?.["openclaw.content.tool_output"])).not.toContain("a".repeat(11));
    expect(toolAttrs?.["gen_ai.tool.call.result"]).toBe(
      toolAttrs?.["openclaw.content.tool_output"],
    );
  });

  test("omits absent model content fields when capture fields are opted in", async () => {
    await startOtelService({
      traces: true,
      captureContent: MODEL_CONTENT_CAPTURE,
    });

    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 80,
      },
      { inputMessages: ["user prompt"] },
    );
    await flushDiagnosticEvents();

    const attrs = startedSpanOptions("openclaw.model.call")?.attributes ?? {};
    expect(attrs["openclaw.content.input_messages"]).toBe("user prompt");
    expect(Object.hasOwn(attrs, "openclaw.content.output_messages")).toBe(false);
    expect(Object.hasOwn(attrs, "openclaw.content.system_prompt")).toBe(false);
    expect(Object.hasOwn(attrs, "openclaw.content.tool_definitions")).toBe(false);
    expect(Object.hasOwn(attrs, "gen_ai.output.messages")).toBe(false);
    expect(Object.hasOwn(attrs, "gen_ai.system_instructions")).toBe(false);
    expect(Object.hasOwn(attrs, "gen_ai.tool.definitions")).toBe(false);
  });

  test("exports Phoenix-readable GenAI prompt, output, and tool definition attributes", async () => {
    await startOtelService({
      traces: true,
      captureContent: MODEL_CONTENT_CAPTURE,
    });

    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 80,
      },
      {
        inputMessages: [
          { role: "user", content: "what changed?", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call-1", name: "lookup", arguments: { q: "trace" } },
            ],
          },
          { role: "toolResult", toolCallId: "call-1", content: { rows: 1 } },
        ],
        outputMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "the trace changed" }],
            stopReason: "stop",
          },
        ],
        systemPrompt: "be exact",
        toolDefinitions: [
          { name: "lookup", description: "Lookup data", parameters: { type: "object" } },
        ],
      },
    );
    await flushDiagnosticEvents();

    const attrs = startedSpanOptions("openclaw.model.call")?.attributes;
    expect(attrs?.["gen_ai.system_instructions"]).toBe(
      JSON.stringify([{ type: "text", content: "be exact" }]),
    );
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.input.messages"))).toEqual([
      { role: "user", parts: [{ type: "text", content: "what changed?" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            id: "call-1",
            name: "lookup",
            arguments: { q: "trace" },
          },
        ],
      },
      {
        role: "tool",
        parts: [{ type: "tool_call_response", id: "call-1", response: { rows: 1 } }],
      },
    ]);
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.output.messages"))).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "the trace changed" }],
        finish_reason: "stop",
      },
    ]);
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.tool.definitions"))).toEqual([
      {
        type: "function",
        name: "lookup",
        description: "Lookup data",
        parameters: { type: "object" },
      },
    ]);
    expect(attrs?.["input.mime_type"]).toBe("application/json");
    expect(attrs?.["output.mime_type"]).toBe("application/json");
  });

  test("exports Claude CLI turn content through the existing Phoenix GenAI keys", async () => {
    await startOtelService({
      traces: true,
      captureContent: MODEL_CONTENT_CAPTURE,
    });

    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-claude-cli",
        callId: "call-claude-cli",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        api: "claude-code",
        transport: "stdio-live",
        durationMs: 80,
      },
      {
        inputMessages: [{ role: "user", content: [{ type: "text", text: "trace this" }] }],
        outputMessages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: "trace complete" },
              { type: "thinking", thinking: "checked the span" },
              { type: "tool_call", id: "tool-1", name: "Read" },
            ],
            stopReason: "end_turn",
          },
        ],
        systemPrompt: "OpenClaw appended instructions",
      },
    );
    await flushDiagnosticEvents();

    const attrs = startedSpanOptions("openclaw.model.call")?.attributes;
    expect(attrs?.["openclaw.api"]).toBe("claude-code");
    expect(attrs?.["openclaw.transport"]).toBe("stdio-live");
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.input.messages"))).toEqual([
      { role: "user", parts: [{ type: "text", content: "trace this" }] },
    ]);
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.output.messages"))).toEqual([
      {
        role: "assistant",
        parts: [
          { type: "text", content: "trace complete" },
          { type: "reasoning", content: "checked the span" },
          { type: "tool_call", id: "tool-1", name: "Read" },
        ],
        finish_reason: "end_turn",
      },
    ]);
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.system_instructions"))).toEqual([
      { type: "text", content: "OpenClaw appended instructions" },
    ]);
    expect(Object.hasOwn(attrs ?? {}, "gen_ai.tool.definitions")).toBe(false);
  });

  test("emits semconv response text for tool response parts", async () => {
    await startOtelService({
      traces: true,
      captureContent: INPUT_ONLY_CAPTURE,
    });

    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 80,
      },
      {
        inputMessages: [
          {
            role: "tool",
            parts: [
              {
                type: "tool_call_response",
                id: "call-1",
                result: [
                  { type: "text", text: "first line" },
                  { type: "text", text: "second line" },
                ],
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "call-2",
            content: [
              { type: "text", text: "alpha" },
              { type: "text", text: "beta" },
            ],
          },
        ],
      },
    );
    await flushDiagnosticEvents();

    const attrs = startedSpanOptions("openclaw.model.call")?.attributes;
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.input.messages"))).toEqual([
      {
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            id: "call-1",
            response: "first line\nsecond line",
          },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            id: "call-2",
            response: "alpha\nbeta",
          },
        ],
      },
    ]);
  });

  test("flattens oversized pure-text tool results with a truncation marker", async () => {
    await startOtelService({
      traces: true,
      captureContent: INPUT_ONLY_CAPTURE,
    });

    const textParts = Array.from({ length: 201 }, (_, index) => ({
      type: "text",
      text: `line-${index}`,
    }));
    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 80,
      },
      {
        inputMessages: [{ role: "toolResult", toolCallId: "call-1", content: textParts }],
      },
    );
    await flushDiagnosticEvents();

    const attrs = startedSpanOptions("openclaw.model.call")?.attributes;
    const messages = JSON.parse(stringAttribute(attrs, "gen_ai.input.messages")) as {
      parts: { response?: unknown }[];
    }[];
    const expected = `${textParts
      .slice(0, 200)
      .map((part) => part.text)
      .join("\n")}\n...(1 more text parts omitted)`;
    expect(messages[0]?.parts[0]?.response).toBe(expected);
  });

  test("normalizes snake_case tool_call parts the same as camelCase toolCall parts", async () => {
    await startOtelService({
      traces: true,
      captureContent: INPUT_ONLY_CAPTURE,
    });

    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 80,
      },
      {
        inputMessages: [
          {
            role: "assistant",
            content: [
              {
                type: "tool_call",
                id: "tc-1",
                name: "search",
                arguments: { q: "x" },
                extraField: "leaked",
              },
            ],
          },
        ],
      },
    );
    await flushDiagnosticEvents();

    const attrs = startedSpanOptions("openclaw.model.call")?.attributes;
    const parsed = JSON.parse(stringAttribute(attrs, "gen_ai.input.messages"));
    expect(parsed[0].parts[0]).toEqual({
      type: "tool_call",
      id: "tc-1",
      name: "search",
      arguments: { q: "x" },
    });
    expect(JSON.stringify(parsed)).not.toContain("leaked");
  });

  test("truncates oversized GenAI input messages instead of silently dropping them", async () => {
    await startOtelService({
      traces: true,
      captureContent: INPUT_ONLY_CAPTURE,
    });

    // Build messages that exceed MAX_OTEL_CONTENT_ATTRIBUTE_CHARS (128KB) in total.
    const largeMessages = Array.from({ length: 200 }, (_, i) => ({
      role: "user",
      content: `message-${i}-${"x".repeat(1024)}`,
    }));

    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 80,
      },
      { inputMessages: largeMessages },
    );
    await flushDiagnosticEvents();

    const attrs = startedSpanOptions("openclaw.model.call")?.attributes;
    const genAiInput = stringAttribute(attrs, "gen_ai.input.messages");
    // Must not be empty — a truncated subset should appear.
    expect(genAiInput.length).toBeGreaterThan(0);
    // Must fit within the attribute size limit.
    expect(genAiInput.length).toBeLessThanOrEqual(MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS + 50);
    // The first message should still be present.
    expect(genAiInput).toContain("message-0-");
    expect(JSON.parse(genAiInput)[0]).toMatchObject({
      role: "user",
      parts: [{ type: "text" }],
    });
  });

  test("keeps single oversized GenAI messages and tool definitions parseable", async () => {
    await startOtelService({
      traces: true,
      captureContent: {
        enabled: true,
        inputMessages: true,
        outputMessages: false,
        toolDefinitions: true,
      },
    });

    // The 8,192-character candidate budget leaves an 8,178-character text prefix;
    // place a surrogate pair across that boundary so serialized JSON must stay valid.
    const surrogateBoundaryPrefix = "x".repeat(8177);
    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 80,
      },
      {
        inputMessages: [
          {
            role: "user",
            content: `${surrogateBoundaryPrefix}🚀${"y".repeat(
              MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS,
            )}`,
          },
        ],
        toolDefinitions: [
          {
            name: "huge_schema",
            description: "Huge schema",
            parameters: {
              type: "object",
              properties: {
                payload: {
                  type: "string",
                  description: "x".repeat(MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS),
                },
              },
            },
          },
        ],
      },
    );
    await flushDiagnosticEvents();

    const attrs = startedSpanOptions("openclaw.model.call")?.attributes;
    const genAiInput = stringAttribute(attrs, "gen_ai.input.messages");
    const toolDefinitions = stringAttribute(attrs, "gen_ai.tool.definitions");
    expect(genAiInput.length).toBeLessThanOrEqual(MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS);
    expect(toolDefinitions.length).toBeLessThanOrEqual(MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS);
    expect(genAiInput).not.toContain("\\ud83d");
    expect(JSON.parse(genAiInput)).toEqual([
      {
        role: "user",
        parts: [
          {
            type: "text",
            content: `${surrogateBoundaryPrefix}...(truncated)`,
          },
        ],
      },
    ]);
    expect(JSON.parse(toolDefinitions)[0]).toMatchObject({
      type: "function",
      name: "huge_schema",
      parameters: {
        type: "object",
      },
    });
  });

  test("exports tool definitions without requiring input message capture", async () => {
    await startOtelService({
      traces: true,
      captureContent: {
        enabled: true,
        inputMessages: false,
        toolDefinitions: true,
      },
    });

    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-1",
        callId: "call-1",
        provider: "openai",
        model: "gpt-5.4",
        durationMs: 80,
      },
      {
        inputMessages: [{ role: "user", content: "do not export this prompt" }],
        toolDefinitions: [
          { name: "lookup", description: "Lookup data", parameters: { type: "object" } },
        ],
      },
    );
    await flushDiagnosticEvents();

    const attrs = startedSpanOptions("openclaw.model.call")?.attributes;
    expect(Object.hasOwn(attrs ?? {}, "gen_ai.input.messages")).toBe(false);
    expect(Object.hasOwn(attrs ?? {}, "input.value")).toBe(false);
    expect(Object.hasOwn(attrs ?? {}, "openclaw.content.input_messages")).toBe(false);
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.tool.definitions"))).toEqual([
      {
        type: "function",
        name: "lookup",
        description: "Lookup data",
        parameters: { type: "object" },
      },
    ]);
    expect(JSON.parse(String(attrs?.["openclaw.content.tool_definitions"]))).toEqual([
      {
        name: "lookup",
        description: "Lookup data",
        parameters: { type: "object" },
      },
    ]);
  });

  test("ignores invalid diagnostic event trace parents", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitDiagnosticEvent({
      type: "model.usage",
      trace: {
        traceId: "0".repeat(32),
        spanId: "not-a-span",
        traceFlags: "zz",
      },
      ...MODEL_FIXTURE,
      usage: { total: 4 },
      durationMs: 12,
    });

    const modelUsageCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.usage",
    );
    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    expect(modelUsageCall?.[2]).toBeUndefined();
  });

  test("redacts sensitive reason in session.state metric attributes", async () => {
    await startOtelService({ metrics: true });

    emitDiagnosticEvent({
      type: "session.state",
      state: "waiting",
      reason: "token=ghp_abcdefghijklmnopqrstuvwxyz123456", // pragma: allowlist secret
    });

    const sessionStateCall = firstCounterAddCall("openclaw.session.state");
    const attrs = sessionStateCall[1];
    expect(sessionStateCall[0]).toBe(1);
    expect(String(attrs?.["openclaw.reason"])).toContain("…");
    expect(typeof attrs?.["openclaw.reason"]).toBe("string");
    expect(String(attrs?.["openclaw.reason"])).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz123456", // pragma: allowlist secret
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
