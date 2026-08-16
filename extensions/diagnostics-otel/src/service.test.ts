// Diagnostics Otel tests cover service plugin behavior.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
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

const traceProviderCtor = vi.hoisted(() => vi.fn());
const traceProviderShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const meterProviderCtor = vi.hoisted(() => vi.fn());
const meterProviderShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const diagWarn = vi.hoisted(() => vi.fn());
const detectResourcesMock = vi.hoisted(() =>
  vi.fn((_options: { detectors?: unknown[] }) => ({
    attributes: { "openclaw.test.detected": "1" },
    merge: vi.fn((configured: { attributes?: Record<string, unknown> }) => ({
      attributes: {
        "openclaw.test.detected": "1",
        ...configured.attributes,
      },
    })),
  })),
);
const logEmit = vi.hoisted(() => vi.fn());
const logShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const traceExporterCtor = vi.hoisted(() => vi.fn());
const metricExporterCtor = vi.hoisted(() => vi.fn());
const logExporterCtor = vi.hoisted(() => vi.fn());
const traceExporterExport = vi.hoisted(() => vi.fn());
const metricExporterExport = vi.hoisted(() => vi.fn());
const logExporterExport = vi.hoisted(() => vi.fn());
const traceExporterShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const metricExporterShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const logExporterShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const exporterForceFlush = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const logProcessorCtor = vi.hoisted(() => vi.fn());
const spanProcessorCtor = vi.hoisted(() => vi.fn());
const metricReaderCtor = vi.hoisted(() => vi.fn());
const ownedSdkRuntimeCleanup = vi.hoisted(() => vi.fn());
const registerOwnedSdkRuntimeMock = vi.hoisted(() => vi.fn(() => ownedSdkRuntimeCleanup));
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
  diag: {
    warn: diagWarn,
  },
  metrics: {
    getMeter: () => telemetryState.meter,
  },
  isSpanContextValid: () => true,
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

vi.mock("./service-propagation.js", () => ({
  registerOwnedSdkRuntime: registerOwnedSdkRuntimeMock,
}));

vi.mock("@opentelemetry/exporter-metrics-otlp-proto", () => ({
  OTLPMetricExporter: function OTLPMetricExporter(options?: unknown) {
    metricExporterCtor(options);
    return {
      export: metricExporterExport,
      forceFlush: exporterForceFlush,
      shutdown: metricExporterShutdown,
    };
  },
}));

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: function OTLPTraceExporter(options?: unknown) {
    traceExporterCtor(options);
    return {
      export: traceExporterExport,
      forceFlush: exporterForceFlush,
      shutdown: traceExporterShutdown,
    };
  },
}));

vi.mock("@opentelemetry/exporter-logs-otlp-proto", () => ({
  OTLPLogExporter: function OTLPLogExporter(options?: unknown) {
    logExporterCtor(options);
    return {
      export: logExporterExport,
      forceFlush: exporterForceFlush,
      shutdown: logExporterShutdown,
    };
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
  MeterProvider: class {
    constructor(options?: unknown) {
      meterProviderCtor(options);
    }

    getMeter = () => telemetryState.meter;
    shutdown = meterProviderShutdown;
  },
  PeriodicExportingMetricReader: function PeriodicExportingMetricReader(options?: unknown) {
    metricReaderCtor(options);
  },
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  BasicTracerProvider: class {
    constructor(options?: unknown) {
      traceProviderCtor(options);
    }

    getTracer = () => telemetryState.tracer;
    shutdown = traceProviderShutdown;
  },
  BatchSpanProcessor: function BatchSpanProcessor(exporter?: unknown, options?: unknown) {
    spanProcessorCtor(exporter, options);
  },
  ParentBasedSampler: function ParentBasedSampler() {},
  TraceIdRatioBasedSampler: function TraceIdRatioBasedSampler() {},
}));

vi.mock("@opentelemetry/resources", () => ({
  detectResources: detectResourcesMock,
  envDetector: { detector: "env" },
  hostDetector: { detector: "host" },
  osDetector: { detector: "os" },
  processDetector: { detector: "process" },
  serviceInstanceIdDetector: { detector: "serviceinstance" },
  resourceFromAttributes: vi.fn((attrs: Record<string, unknown>) => ({
    attributes: attrs,
    merge: vi.fn((other: unknown) => other ?? {}),
  })),
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
  formatDiagnosticTraceparent,
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
import { emitDiagnosticEvent, type DiagnosticEventPayload } from "../api.js";
import { MAX_RETAINED_TRUSTED_SPAN_CONTEXTS } from "./service-constants.js";
import {
  createExporterHealthEventEmitter,
  type ExporterHealthUpdate,
} from "./service-exporter-health.js";
import { createDiagnosticsLogExporter } from "./service-logs.js";
import { createDiagnosticsOtelService } from "./service.js";
import {
  CHILD_SPAN_ID,
  createOtelContext,
  createTestTrace,
  getReportedExporterHealth,
  GRANDCHILD_SPAN_ID,
  MODEL_CALL_SPAN_ID,
  MODEL_CALL_FIXTURE,
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
// Longer than the default 30-minute background exec timeout.
const LATE_CHILD_ELAPSED_MS = 30 * 60_000 + 1_000;
const PROTO_KEY = "__proto__";
const MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS = 128 * 1024;
type TelemetryExporterEvent = Extract<DiagnosticEventPayload, { type: "telemetry.exporter" }>;
const OTEL_TRUNCATED_SUFFIX_MAX_CHARS = 20;
const OTEL_TEST_USERINFO = ["operator", "example-fixture"].join(":");
const ORIGINAL_OPENCLAW_OTEL_PRELOADED = process.env.OPENCLAW_OTEL_PRELOADED;
const ORIGINAL_OTEL_EXPORTER_OTLP_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const ORIGINAL_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const ORIGINAL_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
const ORIGINAL_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
const ORIGINAL_OTEL_SEMCONV_STABILITY_OPT_IN = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
const ORIGINAL_OTEL_SDK_DISABLED = process.env.OTEL_SDK_DISABLED;
const ORIGINAL_OTEL_PROPAGATORS = process.env.OTEL_PROPAGATORS;
const OTEL_PROTOCOL_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
] as const;
const OTEL_PROVIDER_ENV_KEYS = [
  "OTEL_BSP_EXPORT_TIMEOUT",
  "OTEL_BSP_MAX_EXPORT_BATCH_SIZE",
  "OTEL_BSP_MAX_QUEUE_SIZE",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_METRIC_EXPORT_INTERVAL",
  "OTEL_METRIC_EXPORT_TIMEOUT",
  "OTEL_NODE_EXPERIMENTAL_SDK_METRICS",
  "OTEL_NODE_RESOURCE_DETECTORS",
  "OTEL_SERVICE_NAME",
  "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  "OTEL_SPAN_EVENT_COUNT_LIMIT",
  "OTEL_SPAN_LINK_COUNT_LIMIT",
  "OTEL_TRACES_SAMPLER",
  "OTEL_TRACES_SAMPLER_ARG",
] as const;
const ORIGINAL_OTEL_PROTOCOL_ENV = Object.fromEntries(
  OTEL_PROTOCOL_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof OTEL_PROTOCOL_ENV_KEYS)[number], string | undefined>;
const ORIGINAL_OTEL_PROVIDER_ENV = Object.fromEntries(
  OTEL_PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof OTEL_PROVIDER_ENV_KEYS)[number], string | undefined>;
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

type TestSpanProcessorOptions = {
  exportTimeoutMillis?: number;
  maxExportBatchSize?: number;
  maxQueueSize?: number;
  scheduledDelayMillis?: number;
  selfObsMeterProvider?: unknown;
};

function firstSpanProcessorOptions(): TestSpanProcessorOptions {
  return mockCallArg(spanProcessorCtor, 1) as TestSpanProcessorOptions;
}

function firstMetricReaderOptions(): {
  exportIntervalMillis?: number;
  exportTimeoutMillis?: number;
} {
  return mockCallArg(metricReaderCtor, 0) as {
    exportIntervalMillis?: number;
    exportTimeoutMillis?: number;
  };
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
    for (const key of OTEL_PROTOCOL_ENV_KEYS) {
      delete process.env[key];
    }
    for (const key of OTEL_PROVIDER_ENV_KEYS) {
      delete process.env[key];
    }
    delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    delete process.env.OTEL_SDK_DISABLED;
    delete process.env.OTEL_PROPAGATORS;
    telemetryState.counters.clear();
    telemetryState.histograms.clear();
    telemetryState.spans.length = 0;
    telemetryState.tracer.startSpan.mockClear();
    telemetryState.tracer.setSpanContext.mockClear();
    telemetryState.meter.createCounter.mockClear();
    telemetryState.meter.createHistogram.mockClear();
    traceProviderCtor.mockClear();
    traceProviderShutdown.mockClear();
    meterProviderCtor.mockClear();
    meterProviderShutdown.mockClear();
    diagWarn.mockClear();
    logEmit.mockReset();
    logShutdown.mockClear();
    traceExporterCtor.mockClear();
    metricExporterCtor.mockClear();
    logExporterCtor.mockClear();
    traceExporterExport.mockReset();
    metricExporterExport.mockReset();
    logExporterExport.mockReset();
    traceExporterShutdown.mockReset();
    traceExporterShutdown.mockResolvedValue(undefined);
    metricExporterShutdown.mockReset();
    metricExporterShutdown.mockResolvedValue(undefined);
    logExporterShutdown.mockReset();
    logExporterShutdown.mockResolvedValue(undefined);
    exporterForceFlush.mockReset();
    exporterForceFlush.mockResolvedValue(undefined);
    logProcessorCtor.mockClear();
    spanProcessorCtor.mockClear();
    metricReaderCtor.mockClear();
    ownedSdkRuntimeCleanup.mockClear();
    registerOwnedSdkRuntimeMock.mockClear();
    registerOwnedSdkRuntimeMock.mockReturnValue(ownedSdkRuntimeCleanup);
    createNodeProxyAgentMock.mockReset();
    createNodeProxyAgentMock.mockReturnValue(undefined);
    unhandledRejectionHandlerState.reset();
    unhandledRejectionHandlerState.register.mockClear();
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
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
    if (ORIGINAL_OTEL_EXPORTER_OTLP_ENDPOINT === undefined) {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    } else {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = ORIGINAL_OTEL_EXPORTER_OTLP_ENDPOINT;
    }
    for (const key of OTEL_PROTOCOL_ENV_KEYS) {
      const value = ORIGINAL_OTEL_PROTOCOL_ENV[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const key of OTEL_PROVIDER_ENV_KEYS) {
      const value = ORIGINAL_OTEL_PROVIDER_ENV[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    if (ORIGINAL_OTEL_SEMCONV_STABILITY_OPT_IN === undefined) {
      delete process.env.OTEL_SEMCONV_STABILITY_OPT_IN;
    } else {
      process.env.OTEL_SEMCONV_STABILITY_OPT_IN = ORIGINAL_OTEL_SEMCONV_STABILITY_OPT_IN;
    }
    if (ORIGINAL_OTEL_SDK_DISABLED === undefined) {
      delete process.env.OTEL_SDK_DISABLED;
    } else {
      process.env.OTEL_SDK_DISABLED = ORIGINAL_OTEL_SDK_DISABLED;
    }
    if (ORIGINAL_OTEL_PROPAGATORS === undefined) {
      delete process.env.OTEL_PROPAGATORS;
    } else {
      process.env.OTEL_PROPAGATORS = ORIGINAL_OTEL_PROPAGATORS;
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

  test.each([
    {
      metricNamePrefix: undefined,
      expectedTokenName: "openclaw.tokens",
      expectedDurationName: "openclaw.run.duration_ms",
    },
    {
      metricNamePrefix: "acme.",
      expectedTokenName: "acme.tokens",
      expectedDurationName: "acme.run.duration_ms",
    },
    {
      metricNamePrefix: "",
      expectedTokenName: "tokens",
      expectedDurationName: "run.duration_ms",
    },
    {
      metricNamePrefix: "acme.openclaw.",
      expectedTokenName: "acme.openclaw.tokens",
      expectedDurationName: "acme.openclaw.run.duration_ms",
    },
  ])(
    "replaces the default OpenClaw metric prefix with $metricNamePrefix",
    async ({ metricNamePrefix, expectedTokenName, expectedDurationName }) => {
      await startOtelService({
        metrics: true,
        configure: (ctx) => {
          if (metricNamePrefix !== undefined) {
            ctx.config.diagnostics!.otel!.metricNamePrefix = metricNamePrefix;
          }
        },
      });

      expect(telemetryState.counters.has(expectedTokenName)).toBe(true);
      expect(telemetryState.histograms.has(expectedDurationName)).toBe(true);
      expect(telemetryState.histograms.has("gen_ai.client.token.usage")).toBe(true);
      expect(telemetryState.histograms.has("gen_ai.client.operation.duration")).toBe(true);
      expect(telemetryState.counters.has("openclaw.tokens")).toBe(
        expectedTokenName === "openclaw.tokens",
      );
    },
  );

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
    const unregisterBridge = vi.fn();
    const { service, ctx } = await startOtelService({
      traces: true,
      metrics: true,
      logs: true,
      configure: (context) => {
        const registerBridge = context.internalDiagnostics?.registerTracePropagationBridge;
        context.internalDiagnostics = {
          ...context.internalDiagnostics!,
          registerTracePropagationBridge: (bridge) => {
            const unregister = registerBridge!(bridge);
            return () => {
              unregisterBridge();
              unregister();
            };
          },
        };
      },
    });
    await service.start(ctx);

    expect(logShutdown).toHaveBeenCalledTimes(1);
    expect(traceProviderShutdown).toHaveBeenCalledTimes(1);
    expect(meterProviderShutdown).toHaveBeenCalledTimes(1);
    expect(unregisterBridge).toHaveBeenCalledTimes(1);

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
    expect(traceProviderShutdown).toHaveBeenCalledTimes(2);
    expect(meterProviderShutdown).toHaveBeenCalledTimes(2);
    expect(unregisterBridge).toHaveBeenCalledTimes(2);

    telemetryState.tracer.startSpan.mockClear();
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "completed",
      durationMs: 10,
    });
    expect(telemetryState.tracer.startSpan).not.toHaveBeenCalled();
  });

  test("surfaces bridge cleanup failure after attempting every shutdown phase", async () => {
    const cleanupError = new Error("bridge cleanup failed");
    const unregisterBridge = vi.fn(() => {
      throw cleanupError;
    });
    const cleanupOrder: string[] = [];
    logShutdown.mockImplementationOnce(async () => {
      cleanupOrder.push("log-provider");
    });
    traceProviderShutdown.mockImplementationOnce(async () => {
      cleanupOrder.push("trace-provider");
    });
    meterProviderShutdown.mockImplementationOnce(async () => {
      cleanupOrder.push("meter-provider");
    });
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, {
      traces: true,
      metrics: true,
      logs: true,
    });
    const onEvent = ctx.internalDiagnostics!.onEvent;
    ctx.internalDiagnostics = {
      ...ctx.internalDiagnostics!,
      onEvent: (listener) => {
        const unsubscribe = onEvent(listener);
        return () => {
          cleanupOrder.push("listener");
          unsubscribe();
        };
      },
      registerTracePropagationBridge: () => () => {
        cleanupOrder.push("bridge");
        unregisterBridge();
      },
    };
    await service.start(ctx);
    emitRunStarted();
    const runSpan = spanByName("openclaw.run");

    const stopError = await Promise.resolve(service.stop?.(ctx)).catch((error: unknown) => error);

    expect(stopError).toBe(cleanupError);
    expect(unregisterBridge).toHaveBeenCalledOnce();
    expect(runSpan.end).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
    expect(traceProviderShutdown).toHaveBeenCalledOnce();
    expect(meterProviderShutdown).toHaveBeenCalledOnce();
    expect(unhandledRejectionHandlerState.getHandlers()).toEqual([]);
    expect(cleanupOrder.indexOf("bridge")).toBeLessThan(cleanupOrder.indexOf("log-provider"));
    expect(cleanupOrder.indexOf("listener")).toBeLessThan(cleanupOrder.indexOf("trace-provider"));
  });

  test("attempts every provider shutdown and reports every failure", async () => {
    const logError = new Error("log provider failed");
    const traceError = new Error("trace provider failed");
    const meterError = new Error("meter provider failed");
    logShutdown.mockRejectedValueOnce(logError);
    traceProviderShutdown.mockRejectedValueOnce(traceError);
    meterProviderShutdown.mockRejectedValueOnce(meterError);
    const { service, ctx } = await startOtelService({ traces: true, metrics: true, logs: true });

    const stopError = await Promise.resolve(service.stop?.(ctx)).catch((error: unknown) => error);

    expect(logShutdown).toHaveBeenCalledTimes(1);
    expect(traceProviderShutdown).toHaveBeenCalledTimes(1);
    expect(meterProviderShutdown).toHaveBeenCalledTimes(1);
    expect(stopError).toBeInstanceOf(AggregateError);
    expect(stopError).toMatchObject({
      errors: [logError, traceError, meterError],
      message: expect.stringContaining("log provider failed"),
    });
    expect(stopError).toMatchObject({
      message: expect.stringContaining("trace provider failed"),
    });
    expect(stopError).toMatchObject({
      message: expect.stringContaining("meter provider failed"),
    });
  });

  test("retires an exporter failure retained after shutdown rejects", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    const { service, ctx } = await startOtelService({
      traces: true,
      metrics: false,
      logs: false,
    });
    traceExporterShutdown.mockRejectedValueOnce(new TypeError("private shutdown details"));
    traceProviderShutdown.mockImplementationOnce(async () => {
      // Emulate the real provider shutdown chain: the exporter health wrapper
      // observes the failing exporter shutdown before the provider failure is
      // reported, so the shutdown_failed route is retained, not dropped.
      const exporter = spanProcessorCtor.mock.calls.at(-1)?.[0] as
        | { shutdown(): Promise<void> }
        | undefined;
      if (!exporter) {
        throw new Error("expected trace exporter");
      }
      await exporter.shutdown();
    });

    await expect(service.stop?.(ctx)).rejects.toThrow("private shutdown details");
    await waitForDiagnosticEventsDrained();
    expect(events.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: "started", reason: "configured" },
      { status: "failure", reason: "shutdown_failed" },
    ]);
    expect(
      getReportedExporterHealth(ctx).map(({ transport, status, reason }) => ({
        transport,
        status,
        reason,
      })),
    ).toEqual([
      {
        transport: "otlp-http-protobuf",
        status: "started",
        reason: "configured",
      },
      {
        transport: "otlp-http-protobuf",
        status: "failure",
        reason: "shutdown_failed",
      },
    ]);

    await expect(service.stop?.(ctx)).resolves.toBeUndefined();
    await waitForDiagnosticEventsDrained();
    expect(events.at(-1)).toMatchObject({ status: "dropped" });
    expect(getReportedExporterHealth(ctx).at(-1)).toMatchObject({
      transport: "otlp-http-protobuf",
      status: "dropped",
    });
    expect(JSON.stringify({ events, health: getReportedExporterHealth(ctx) })).not.toContain(
      "private shutdown details",
    );
    unsubscribe();
  });

  test("preserves SDK startup failure through host rollback when shutdown also fails", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    const startupError = new Error("SDK startup failed");
    const rollbackError = new Error("SDK rollback failed");
    traceProviderCtor.mockImplementationOnce(() => {
      throw startupError;
    });
    meterProviderShutdown.mockRejectedValueOnce(rollbackError);
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });

    const startError = await Promise.resolve(service.start(ctx)).catch((error: unknown) => error);

    expect(startError).toBeInstanceOf(AggregateError);
    expect(startError).toMatchObject({
      message: "diagnostics-otel startup failed and rollback cleanup failed",
      cause: startupError,
      errors: [startupError, rollbackError],
    });
    expect(ctx.logger.error).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("diagnostics-otel: failed to start SDK: Error: SDK startup failed"),
    );
    expect(ctx.logger.error).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "diagnostics-otel: SDK startup rollback cleanup failed: Error: SDK rollback failed",
      ),
    );
    expect(meterProviderShutdown).toHaveBeenCalledOnce();
    await waitForDiagnosticEventsDrained();
    expect(events.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: "failure", reason: "start_failed" },
      { status: "failure", reason: "start_failed" },
    ]);
    expect(
      getReportedExporterHealth(ctx).map(({ signal, transport, endpointMode, status, reason }) => ({
        signal,
        transport,
        endpointMode,
        status,
        reason,
      })),
    ).toEqual([
      {
        signal: "traces",
        transport: "otlp-http-protobuf",
        endpointMode: "configured",
        status: "failure",
        reason: "start_failed",
      },
      {
        signal: "metrics",
        transport: "otlp-http-protobuf",
        endpointMode: "configured",
        status: "failure",
        reason: "start_failed",
      },
    ]);
    await expect(service.stop?.(ctx)).resolves.toBeUndefined();
    await waitForDiagnosticEventsDrained();
    expect(events.map(({ status, reason }) => ({ status, reason }))).toEqual([
      { status: "failure", reason: "start_failed" },
      { status: "failure", reason: "start_failed" },
    ]);
    expect(getReportedExporterHealth(ctx).at(-1)).toMatchObject({
      transport: "otlp-http-protobuf",
      status: "failure",
      reason: "start_failed",
    });

    await expect(service.stop?.(ctx)).resolves.toBeUndefined();
    await waitForDiagnosticEventsDrained();
    expect(events.at(-1)).toMatchObject({ status: "dropped" });
    expect(getReportedExporterHealth(ctx).at(-1)).toMatchObject({
      transport: "otlp-http-protobuf",
      status: "dropped",
    });
    unsubscribe();
  });

  test.each([
    {
      label: "explicit",
      endpoint: OTEL_TEST_ENDPOINT,
      endpointMode: "configured" as const,
    },
    {
      label: "dependency-default",
      endpoint: undefined,
      endpointMode: "default_endpoint" as const,
    },
  ])(
    "records $label endpoint ownership when SDK startup fails",
    async ({ endpoint, endpointMode }) => {
      const events: TelemetryExporterEvent[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (event.type === "telemetry.exporter") {
          events.push(event);
        }
      });
      traceProviderCtor.mockImplementationOnce(() => {
        throw new TypeError("private startup details");
      });
      const service = createDiagnosticsOtelService();
      const ctx = createOtelContext(endpoint ?? "", {
        traces: true,
        metrics: false,
        logs: false,
      });
      if (endpoint === undefined) {
        delete ctx.config.diagnostics?.otel?.endpoint;
      }

      await expect(service.start(ctx)).rejects.toThrow("private startup details");
      await waitForDiagnosticEventsDrained();

      expect(events.map(({ signal, status, reason }) => ({ signal, status, reason }))).toEqual([
        {
          signal: "traces",
          status: "failure",
          reason: "start_failed",
        },
      ]);
      expect(
        getReportedExporterHealth(ctx).map(
          ({ signal, transport, endpointMode: eventMode, status, reason }) => ({
            signal,
            transport,
            endpointMode: eventMode,
            status,
            reason,
          }),
        ),
      ).toEqual([
        {
          signal: "traces",
          transport: "otlp-http-protobuf",
          endpointMode,
          status: "failure",
          reason: "start_failed",
        },
      ]);
      expect(JSON.stringify({ events, health: getReportedExporterHealth(ctx) })).not.toContain(
        OTEL_TEST_ENDPOINT,
      );
      expect(JSON.stringify({ events, health: getReportedExporterHealth(ctx) })).not.toContain(
        "private startup details",
      );

      await service.stop?.(ctx);
      await service.stop?.(ctx);
      unsubscribe();
    },
  );

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

  test("cleans up existing providers and does not reinitialize without capability", async () => {
    const service = createDiagnosticsOtelService();
    const enabledCtx = createOtelContext(OTEL_TEST_ENDPOINT, {
      traces: true,
      metrics: true,
      logs: true,
    });
    await service.start(enabledCtx);

    traceProviderCtor.mockClear();
    meterProviderCtor.mockClear();
    logExporterCtor.mockClear();
    const deniedCtx = createOtelContext(OTEL_TEST_ENDPOINT, {
      traces: true,
      metrics: true,
      logs: true,
    });
    delete deniedCtx.internalDiagnostics;

    await service.start(deniedCtx);
    await service.stop?.(deniedCtx);

    expect(deniedCtx.logger.error).toHaveBeenCalledWith(
      "diagnostics-otel: internal diagnostics capability unavailable",
    );
    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();
    expect(logExporterCtor).not.toHaveBeenCalled();
    expect(traceProviderShutdown).toHaveBeenCalledOnce();
    expect(meterProviderShutdown).toHaveBeenCalledOnce();
    expect(logShutdown).toHaveBeenCalledOnce();
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

    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();
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
    expect(traceProviderShutdown).not.toHaveBeenCalled();
    expect(meterProviderShutdown).not.toHaveBeenCalled();
    expect(logShutdown).toHaveBeenCalledTimes(1);
  });

  test("emits and records bounded telemetry exporter health events", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    const { ctx } = await startOtelService({ traces: true, metrics: true, logs: true });

    for (const signal of ["traces", "metrics", "logs"]) {
      const event = events.find((entry) => entry.signal === signal);
      expect(event?.type).toBe("telemetry.exporter");
      expect(event?.exporter).toBe("diagnostics-otel");
      expect(event?.status).toBe("started");
      expect(event?.reason).toBe("configured");
      expect(getReportedExporterHealth(ctx).find((entry) => entry.signal === signal)).toMatchObject(
        {
          transport: "otlp-http-protobuf",
          endpointMode: "configured",
          status: "started",
          reason: "configured",
        },
      );
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

  test("coalesces multi-transport logs into one public lifecycle", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    const { service, ctx } = await startOtelService({
      traces: false,
      metrics: false,
      logs: true,
      logsExporter: "both",
    });
    await waitForDiagnosticEventsDrained();

    expect(events.map(({ signal, status, reason }) => ({ signal, status, reason }))).toEqual([
      { signal: "logs", status: "started", reason: "configured" },
    ]);
    expect(
      getReportedExporterHealth(ctx).map(({ transport, status }) => ({ transport, status })),
    ).toEqual([
      { transport: "otlp-http-protobuf", status: "started" },
      { transport: "stdout", status: "started" },
    ]);
    expect(
      telemetryState.counters.get("openclaw.telemetry.exporter.events")?.add,
    ).toHaveBeenCalledTimes(1);

    await service.stop?.(ctx);
    await waitForDiagnosticEventsDrained();
    expect(events.map((event) => event.status)).toEqual(["started", "dropped"]);
    expect(
      telemetryState.counters.get("openclaw.telemetry.exporter.events")?.add,
    ).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  test.each([" TRUE ", "TrUe"])(
    "disables every OpenClaw-owned telemetry route for OTEL_SDK_DISABLED=%j",
    async (value) => {
      const events: TelemetryExporterEvent[] = [];
      const unsubscribe = onInternalDiagnosticEvent((event) => {
        if (event.type === "telemetry.exporter") {
          events.push(event);
        }
      });
      const onEvent = vi.fn();
      process.env.OTEL_SDK_DISABLED = value;

      const { service, ctx } = await startOtelService({
        traces: true,
        metrics: true,
        logs: true,
        logsExporter: "both",
        configure: (context) => {
          context.internalDiagnostics = {
            ...context.internalDiagnostics!,
            onEvent,
          };
        },
      });
      await waitForDiagnosticEventsDrained();

      expect(events).toEqual([]);
      expect(getReportedExporterHealth(ctx)).toEqual([]);
      expect(onEvent).not.toHaveBeenCalled();
      expect(traceExporterCtor).not.toHaveBeenCalled();
      expect(metricExporterCtor).not.toHaveBeenCalled();
      expect(logExporterCtor).not.toHaveBeenCalled();
      expect(traceProviderCtor).not.toHaveBeenCalled();
      expect(meterProviderCtor).not.toHaveBeenCalled();
      expect(logEmit).not.toHaveBeenCalled();
      expect(unhandledRejectionHandlerState.register).not.toHaveBeenCalled();
      expect(registerOwnedSdkRuntimeMock).toHaveBeenCalledOnce();

      await service.stop?.(ctx);
      expect(ownedSdkRuntimeCleanup).toHaveBeenCalledOnce();
      unsubscribe();
    },
  );

  test.each([" FaLsE "])("keeps the SDK enabled for OTEL_SDK_DISABLED=%j", async (value) => {
    process.env.OTEL_SDK_DISABLED = value;

    const { service, ctx } = await startOtelService({
      traces: true,
      metrics: true,
      logs: true,
    });

    expect(traceProviderCtor).toHaveBeenCalledOnce();
    expect(meterProviderCtor).toHaveBeenCalledOnce();
    expect(traceExporterCtor).toHaveBeenCalledOnce();
    expect(metricExporterCtor).toHaveBeenCalledOnce();
    expect(logExporterCtor).toHaveBeenCalledOnce();
    expect(registerOwnedSdkRuntimeMock).toHaveBeenCalledOnce();

    await service.stop?.(ctx);
  });

  test("warns through the plugin logger and keeps the SDK enabled for an invalid value", async () => {
    process.env.OTEL_SDK_DISABLED = "invalid";

    const { service, ctx } = await startOtelService({
      traces: true,
      metrics: true,
      logs: true,
    });

    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "diagnostics-otel: invalid OTEL_SDK_DISABLED value; expected true or false, using false",
    );
    expect(traceProviderCtor).toHaveBeenCalledOnce();
    expect(meterProviderCtor).toHaveBeenCalledOnce();
    expect(traceExporterCtor).toHaveBeenCalledOnce();
    expect(metricExporterCtor).toHaveBeenCalledOnce();
    expect(logExporterCtor).toHaveBeenCalledOnce();
    expect(registerOwnedSdkRuntimeMock).toHaveBeenCalledOnce();

    await service.stop?.(ctx);
  });

  test("skips malformed endpoint, protocol, and TLS settings while disabled", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    process.env.OTEL_SDK_DISABLED = "true";
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = "/definitely-missing/otel-root.pem";
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext("not a collector URL", {
      traces: true,
      metrics: true,
      logs: true,
      logsExporter: "both",
    });

    await expect(service.start(ctx)).resolves.toBeUndefined();
    await waitForDiagnosticEventsDrained();

    expect(events).toEqual([]);
    expect(getReportedExporterHealth(ctx)).toEqual([]);
    expect(traceExporterCtor).not.toHaveBeenCalled();
    expect(metricExporterCtor).not.toHaveBeenCalled();
    expect(logExporterCtor).not.toHaveBeenCalled();
    expect(createNodeProxyAgentMock).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalled();
    await service.stop?.(ctx);
    unsubscribe();
  });

  test("preserves preloaded trace and metric ownership while disabling plugin logs", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    process.env.OPENCLAW_OTEL_PRELOADED = "1";
    process.env.OTEL_SDK_DISABLED = "true";

    const { service, ctx } = await startOtelService({
      traces: true,
      metrics: true,
      logs: true,
      logsExporter: "both",
    });
    emitDiagnosticEvent({
      type: "run.completed",
      ...RUN_FIXTURE,
      outcome: "completed",
      durationMs: 100,
    });
    await emitAndFlush({
      type: "log.record",
      level: "INFO",
      message: "disabled preloaded log",
    });
    await waitForDiagnosticEventsDrained();

    expect(events.map(({ signal, status }) => ({ signal, status }))).toEqual([
      { signal: "traces", status: "started" },
      { signal: "metrics", status: "started" },
    ]);
    expect(
      getReportedExporterHealth(ctx).map(({ signal, transport, status }) => ({
        signal,
        transport,
        status,
      })),
    ).toEqual([
      {
        signal: "traces",
        transport: "external-sdk",
        status: "started",
      },
      {
        signal: "metrics",
        transport: "external-sdk",
        status: "started",
      },
    ]);
    expect(traceExporterCtor).not.toHaveBeenCalled();
    expect(metricExporterCtor).not.toHaveBeenCalled();
    expect(logExporterCtor).not.toHaveBeenCalled();
    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();
    expect(unhandledRejectionHandlerState.register).not.toHaveBeenCalled();
    expect(lastHistogramRecord("openclaw.run.duration_ms")?.[0]).toBe(100);
    expect(startedSpanOptions("openclaw.run")?.attributes?.["openclaw.outcome"]).toBe("completed");
    expect(logEmit).not.toHaveBeenCalled();
    expect(registerOwnedSdkRuntimeMock).not.toHaveBeenCalled();
    await service.stop?.(ctx);
    unsubscribe();
  });

  test("releases each owned context and propagation generation across restart and stop", async () => {
    process.env.OTEL_SDK_DISABLED = "true";
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true });

    await service.start(ctx);
    await service.start(ctx);
    await service.stop?.(ctx);

    expect(registerOwnedSdkRuntimeMock).toHaveBeenCalledTimes(2);
    expect(ownedSdkRuntimeCleanup).toHaveBeenCalledTimes(2);
    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();
  });

  test("records dependency-default, stdout, and external SDK ownership facts", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });

    const defaultEndpoint = await startOtelService({
      traces: true,
      configure: (context) => {
        delete context.config.diagnostics?.otel?.endpoint;
      },
    });
    await defaultEndpoint.service.stop?.(defaultEndpoint.ctx);

    process.env.OPENCLAW_OTEL_PRELOADED = "1";
    const externalSdk = await startOtelService({
      traces: true,
      metrics: true,
      logs: true,
      logsExporter: "stdout",
    });

    expect(
      events
        .filter((event) => event.status === "started")
        .map(({ signal, status, reason }) => ({
          signal,
          status,
          reason,
        })),
    ).toEqual([
      {
        signal: "traces",
        status: "started",
        reason: "configured",
      },
      {
        signal: "traces",
        status: "started",
        reason: "configured",
      },
      {
        signal: "metrics",
        status: "started",
        reason: "configured",
      },
      {
        signal: "logs",
        status: "started",
        reason: "configured",
      },
    ]);
    const healthReports = [
      ...getReportedExporterHealth(defaultEndpoint.ctx),
      ...getReportedExporterHealth(externalSdk.ctx),
    ];
    expect(
      healthReports
        .filter((event) => event.status === "started")
        .map(({ signal, transport, endpointMode, status, reason }) => ({
          signal,
          transport,
          endpointMode,
          status,
          reason,
        })),
    ).toEqual([
      {
        signal: "traces",
        transport: "otlp-http-protobuf",
        endpointMode: "default_endpoint",
        status: "started",
        reason: "default_endpoint",
      },
      {
        signal: "traces",
        transport: "external-sdk",
        endpointMode: undefined,
        status: "started",
        reason: "configured",
      },
      {
        signal: "metrics",
        transport: "external-sdk",
        endpointMode: undefined,
        status: "started",
        reason: "configured",
      },
      {
        signal: "logs",
        transport: "stdout",
        endpointMode: undefined,
        status: "started",
        reason: "configured",
      },
    ]);

    unsubscribe();
  });

  test("retires trace ownership across external, unsupported, and supported restarts", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true });

    try {
      await service.start(ctx);
      process.env.OPENCLAW_OTEL_PRELOADED = "1";
      await service.start(ctx);
      process.env.OPENCLAW_OTEL_PRELOADED = "0";
      delete ctx.config.diagnostics!.otel!.protocol;
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
      await service.start(ctx);
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
      await service.start(ctx);
      await waitForDiagnosticEventsDrained();

      expect(
        getReportedExporterHealth(ctx).map(({ signal, transport, status, reason }) => ({
          signal,
          transport,
          status,
          reason,
        })),
      ).toEqual([
        {
          signal: "traces",
          transport: "otlp-http-protobuf",
          status: "started",
          reason: "configured",
        },
        {
          signal: "traces",
          transport: "otlp-http-protobuf",
          status: "dropped",
          reason: undefined,
        },
        {
          signal: "traces",
          transport: "external-sdk",
          status: "started",
          reason: "configured",
        },
        {
          signal: "traces",
          transport: "external-sdk",
          status: "dropped",
          reason: undefined,
        },
        {
          signal: "traces",
          transport: "otlp-http-protobuf",
          status: "failure",
          reason: "unsupported_protocol",
        },
        {
          signal: "traces",
          transport: "otlp-http-protobuf",
          status: "dropped",
          reason: undefined,
        },
        {
          signal: "traces",
          transport: "otlp-http-protobuf",
          status: "started",
          reason: "configured",
        },
      ]);
    } finally {
      await service.stop?.(ctx);
    }
  });

  test("retires unsupported OTLP failures on disabled restart and stop", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true });
    delete ctx.config.diagnostics!.otel!.protocol;
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";

    try {
      await service.start(ctx);
      ctx.config.diagnostics!.enabled = false;
      await service.start(ctx);
      ctx.config.diagnostics!.enabled = true;
      await service.start(ctx);
      await service.stop?.(ctx);
      await waitForDiagnosticEventsDrained();

      expect(
        getReportedExporterHealth(ctx).map(({ transport, status, reason }) => ({
          transport,
          status,
          reason,
        })),
      ).toEqual([
        {
          transport: "otlp-http-protobuf",
          status: "failure",
          reason: "unsupported_protocol",
        },
        { transport: "otlp-http-protobuf", status: "dropped", reason: undefined },
        {
          transport: "otlp-http-protobuf",
          status: "failure",
          reason: "unsupported_protocol",
        },
        { transport: "otlp-http-protobuf", status: "dropped", reason: undefined },
      ]);
    } finally {
      await service.stop?.(ctx);
    }
  });

  test("rebuilds the current log route set while preserving logs both", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, {
      logs: true,
      logsExporter: "both",
    });

    try {
      await service.start(ctx);
      ctx.config.diagnostics!.otel!.logsExporter = "stdout";
      await service.start(ctx);
      ctx.config.diagnostics!.otel!.logsExporter = "both";
      await service.start(ctx);
      await waitForDiagnosticEventsDrained();

      expect(
        getReportedExporterHealth(ctx).map(({ transport, status }) => ({
          transport,
          status,
        })),
      ).toEqual([
        { transport: "otlp-http-protobuf", status: "started" },
        { transport: "stdout", status: "started" },
        { transport: "otlp-http-protobuf", status: "dropped" },
        { transport: "stdout", status: "dropped" },
        { transport: "stdout", status: "started" },
        { transport: "stdout", status: "dropped" },
        { transport: "otlp-http-protobuf", status: "started" },
        { transport: "stdout", status: "started" },
      ]);
    } finally {
      await service.stop?.(ctx);
    }
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

  test("keeps explicit HTTP exporters canonical when ambient protocol is gRPC", async () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "grpc";
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "http/json";
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "grpc";
    const { ctx } = await startOtelService({
      protocol: "http/protobuf",
      traces: true,
      metrics: true,
      logs: true,
    });

    expect(traceProviderCtor).toHaveBeenCalledTimes(1);
    expect(meterProviderCtor).toHaveBeenCalledTimes(1);
    expect(mockCallArg(traceProviderCtor, 0)).toMatchObject({
      spanProcessors: expect.any(Array),
    });
    expect(mockCallArg(meterProviderCtor, 0)).toMatchObject({
      readers: expect.any(Array),
    });
    expect(traceExporterCtor).toHaveBeenCalledTimes(1);
    expect(metricExporterCtor).toHaveBeenCalledTimes(1);
    expect(logExporterCtor).toHaveBeenCalledTimes(1);
    expect(firstExporterOptions(traceExporterCtor).url).toBe(
      "http://otel-collector:4318/v1/traces",
    );
    expect(firstExporterOptions(metricExporterCtor).url).toBe(
      "http://otel-collector:4318/v1/metrics",
    );
    expect(firstExporterOptions(logExporterCtor).url).toBe("http://otel-collector:4318/v1/logs");
    expect(spanProcessorCtor).toHaveBeenCalledTimes(1);
    expect(ctx.logger.warn).not.toHaveBeenCalledWith("diagnostics-otel: unsupported protocol grpc");

    emitDiagnosticEvent({
      type: "log.record",
      level: "INFO",
      message: "OpenClaw-owned OTLP log",
    });
    await flushDiagnosticEvents();

    expect(logEmit).toHaveBeenCalledTimes(1);
  });

  test("rejects unsupported protocol env override before exporter startup", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    const { ctx } = await startOtelService({
      traces: true,
      metrics: true,
      logs: true,
      configure: (context) => {
        delete context.config.diagnostics?.otel?.protocol;
      },
    });

    expect(
      events.map((event) => ({
        signal: event.signal,
        status: event.status,
        reason: event.reason,
      })),
    ).toEqual([
      {
        signal: "traces",
        status: "failure",
        reason: "unsupported_protocol",
      },
      {
        signal: "metrics",
        status: "failure",
        reason: "unsupported_protocol",
      },
      {
        signal: "logs",
        status: "failure",
        reason: "unsupported_protocol",
      },
    ]);
    expect(
      getReportedExporterHealth(ctx).map(({ signal, transport, status, reason }) => ({
        signal,
        transport,
        status,
        reason,
      })),
    ).toEqual(
      ["traces", "metrics", "logs"].map((signal) => ({
        signal,
        transport: "otlp-http-protobuf",
        status: "failure",
        reason: "unsupported_protocol",
      })),
    );
    expect(vi.mocked(ctx.logger.warn).mock.calls).toEqual(
      ["traces", "metrics", "logs"].map((signal) => [
        `diagnostics-otel: unsupported ${signal} protocol grpc; OTLP export disabled`,
      ]),
    );
    expect(traceExporterCtor).not.toHaveBeenCalled();
    expect(metricExporterCtor).not.toHaveBeenCalled();
    expect(logExporterCtor).not.toHaveBeenCalled();
    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();

    unsubscribe();
  });

  test("uses signal protocol overrides without disabling supported siblings", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/protobuf";
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "http/json";
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/protobuf";

    const { ctx } = await startOtelService({
      traces: true,
      metrics: true,
      logs: true,
      configure: (context) => {
        delete context.config.diagnostics?.otel?.protocol;
      },
    });

    expect(traceExporterCtor).toHaveBeenCalledTimes(1);
    expect(metricExporterCtor).not.toHaveBeenCalled();
    expect(logExporterCtor).toHaveBeenCalledTimes(1);
    expect(traceProviderCtor).toHaveBeenCalledTimes(1);
    expect(meterProviderCtor).not.toHaveBeenCalled();
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "diagnostics-otel: unsupported metrics protocol http/json; OTLP export disabled",
    );
    expect(
      events.map((event) => ({
        signal: event.signal,
        status: event.status,
        reason: event.reason,
      })),
    ).toEqual([
      { signal: "metrics", status: "failure", reason: "unsupported_protocol" },
      { signal: "traces", status: "started", reason: "configured" },
      { signal: "logs", status: "started", reason: "configured" },
    ]);

    unsubscribe();
  });

  test("keeps rejected traces disabled when metrics still start owned SDK", async () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "grpc";
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "http/protobuf";
    const registerBridge = vi.fn(() => vi.fn());

    const { ctx } = await startOtelService({
      traces: true,
      metrics: true,
      logs: false,
      configure: (context) => {
        delete context.config.diagnostics?.otel?.protocol;
        context.internalDiagnostics = {
          ...context.internalDiagnostics!,
          registerTracePropagationBridge: registerBridge,
        };
      },
    });

    expect(traceExporterCtor).not.toHaveBeenCalled();
    expect(metricExporterCtor).toHaveBeenCalledTimes(1);
    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect((mockCallArg(meterProviderCtor, 0) as { readers?: unknown[] }).readers).toHaveLength(1);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "diagnostics-otel: unsupported traces protocol grpc; OTLP export disabled",
    );
    expect(registerBridge).not.toHaveBeenCalled();
  });

  test("keeps stdout logs active when the OTLP branch of both is unsupported", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "grpc";
    const capture = captureStdoutWrites();

    try {
      const { ctx } = await startOtelService({
        traces: false,
        metrics: false,
        logs: true,
        logsExporter: "both",
        configure: (context) => {
          delete context.config.diagnostics?.otel?.protocol;
        },
      });
      emitDiagnosticEvent({
        type: "log.record",
        level: "INFO",
        message: "stdout fallback log",
      });
      await flushDiagnosticEvents();

      expect(logExporterCtor).not.toHaveBeenCalled();
      expect(parseSingleStdoutDiagnosticLogLine(capture.writes).body).toBe("log");
      expect(ctx.logger.warn).toHaveBeenCalledWith(
        "diagnostics-otel: unsupported logs protocol grpc; OTLP export disabled",
      );
      expect(ctx.logger.info).toHaveBeenCalledWith(
        "diagnostics-otel: logs exporter enabled (stdout JSONL)",
      );
      expect(
        events.map((event) => ({
          signal: event.signal,
          status: event.status,
          reason: event.reason,
        })),
      ).toEqual([
        { signal: "logs", status: "failure", reason: "unsupported_protocol" },
        { signal: "logs", status: "started", reason: "configured" },
      ]);
    } finally {
      capture.spy.mockRestore();
      unsubscribe();
    }
  });

  test("does not validate externally owned trace and metric protocols", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    process.env.OPENCLAW_OTEL_PRELOADED = "1";
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/json";
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "grpc";

    const { ctx } = await startOtelService({
      traces: true,
      metrics: true,
      logs: false,
      configure: (context) => {
        delete context.config.diagnostics?.otel?.protocol;
      },
    });

    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();
    expect(traceExporterCtor).not.toHaveBeenCalled();
    expect(metricExporterCtor).not.toHaveBeenCalled();
    expect(ctx.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("unsupported"));
    expect(
      events.map((event) => ({
        signal: event.signal,
        status: event.status,
        reason: event.reason,
      })),
    ).toEqual([
      { signal: "traces", status: "started", reason: "configured" },
      { signal: "metrics", status: "started", reason: "configured" },
    ]);

    unsubscribe();
  });

  test("ignores blank signal protocol overrides in favor of the shared fallback", async () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = " \t ";
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "\u2000";
    process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "\ufeff";

    await startOtelService({
      traces: true,
      metrics: true,
      logs: true,
      configure: (context) => {
        delete context.config.diagnostics?.otel?.protocol;
      },
    });

    expect(traceExporterCtor).toHaveBeenCalledTimes(1);
    expect(metricExporterCtor).toHaveBeenCalledTimes(1);
    expect(logExporterCtor).toHaveBeenCalledTimes(1);
  });

  test("starts stdout-only logs when OTLP protocol env override is unsupported", async () => {
    process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
    const { ctx } = await startOtelService({
      traces: false,
      metrics: false,
      logs: true,
      logsExporter: "stdout",
      configure: (context) => {
        delete context.config.diagnostics?.otel?.protocol;
      },
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
      warning: " http/protobuf ",
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
      expect(vi.mocked(ctx.logger.warn).mock.calls).toEqual(
        ["traces", "metrics"].map((signal) => [
          `diagnostics-otel: unsupported ${signal} protocol ${warning}; OTLP export disabled`,
        ]),
      );
    } else {
      expect(ctx.logger.warn).not.toHaveBeenCalled();
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
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    logEmit
      .mockImplementationOnce(() => {
        throw new TypeError("token sk-test-secret should not leave as telemetry");
      })
      .mockImplementationOnce(() => {
        throw new TypeError("repeated private failure");
      });

    const { ctx } = await startOtelService({ logs: true });
    for (const message of ["first failure", "second failure", "recovery"]) {
      await emitAndFlush({
        type: "log.record",
        level: "INFO",
        message,
      });
    }

    const failureEvent = events.find((event) => event.status === "failure");
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
    expect(
      events.filter((event) => event.reason === "emit_failed").map((event) => event.status),
    ).toEqual(["failure"]);
    expect(
      getReportedExporterHealth(ctx)
        .filter(
          (event) => event.transport === "otlp-http-protobuf" && event.reason === "emit_failed",
        )
        .map((event) => event.status),
    ).toEqual(["failure", "recovered"]);
    expect(JSON.stringify({ events, health: getReportedExporterHealth(ctx) })).not.toContain(
      "sk-test-secret",
    );

    unsubscribe();
  });

  test("does not recover log OTLP health while an export failure remains active", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    let completeExport: ((result: ExportResult) => void) | undefined;
    logExporterExport.mockImplementation(
      (_items: unknown, callback: (result: ExportResult) => void) => {
        completeExport = callback;
      },
    );
    logEmit
      .mockImplementationOnce(() => {
        throw new TypeError("private enqueue failure");
      })
      .mockImplementationOnce(() => {});
    const { ctx } = await startOtelService({ traces: false, metrics: false, logs: true });
    const exporter = firstLogProcessorOptions().exporter as
      | {
          export(items: unknown, callback: (result: ExportResult) => void): void;
        }
      | undefined;
    if (!exporter) {
      throw new Error("expected log exporter");
    }

    exporter.export([], vi.fn());
    completeExport?.({
      code: ExportResultCode.FAILED,
      error: new Error("private collector failure"),
    });
    await emitAndFlush({ type: "log.record", level: "INFO", message: "enqueue failure" });
    await emitAndFlush({ type: "log.record", level: "INFO", message: "enqueue recovery" });
    exporter.export([], vi.fn());
    completeExport?.({
      code: ExportResultCode.FAILED,
      error: new Error("repeated private collector failure"),
    });
    await waitForDiagnosticEventsDrained();

    expect(
      getReportedExporterHealth(ctx)
        .filter((event) => event.transport === "otlp-http-protobuf")
        .map(({ status, reason }) => ({ status, reason })),
    ).toEqual([
      { status: "started", reason: "configured" },
      { status: "failure", reason: "export_failed" },
    ]);

    exporter.export([], vi.fn());
    completeExport?.({ code: ExportResultCode.SUCCESS });
    await waitForDiagnosticEventsDrained();
    expect(
      getReportedExporterHealth(ctx)
        .filter((event) => event.transport === "otlp-http-protobuf")
        .map(({ status, reason }) => ({ status, reason })),
    ).toEqual([
      { status: "started", reason: "configured" },
      { status: "failure", reason: "export_failed" },
      { status: "recovered", reason: "export_failed" },
    ]);
    expect(events.map((event) => event.status)).not.toContain("recovered");
    expect(JSON.stringify({ events, health: getReportedExporterHealth(ctx) })).not.toContain(
      "private",
    );

    unsubscribe();
  });

  test("recovers stdout emit health after repeated failures", async () => {
    const events: TelemetryExporterEvent[] = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    const stdout = captureStdoutWrites();
    const failWrite = (() => {
      throw new TypeError("private stdout failure");
    }) as typeof process.stdout.write;
    stdout.spy.mockImplementationOnce(failWrite).mockImplementationOnce(failWrite);

    try {
      const { ctx } = await startOtelService({
        traces: false,
        metrics: false,
        logs: true,
        logsExporter: "stdout",
      });
      for (const message of ["first failure", "second failure", "recovery"]) {
        await emitAndFlush({ type: "log.record", level: "INFO", message });
      }

      expect(
        getReportedExporterHealth(ctx)
          .filter((event) => event.transport === "stdout" && event.reason === "emit_failed")
          .map(({ status, errorCategory }) => ({ status, errorCategory })),
      ).toEqual([
        { status: "failure", errorCategory: "TypeError" },
        { status: "recovered", errorCategory: undefined },
      ]);
      expect(events.map((event) => event.status)).not.toContain("recovered");
      expect(stdout.writes).toHaveLength(1);
      expect(JSON.stringify({ events, health: getReportedExporterHealth(ctx) })).not.toContain(
        "private stdout failure",
      );
    } finally {
      stdout.spy.mockRestore();
      unsubscribe();
    }
  });

  test("preserves and recovers bounded exporter facts for log preparation failures", () => {
    const events: ExporterHealthUpdate[] = [];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const diagnosticsLogs = createDiagnosticsLogExporter({
      contentCapturePolicy: {
        inputMessages: false,
        outputMessages: false,
        toolInputs: false,
        toolOutputs: false,
        systemPrompt: false,
        toolDefinitions: false,
        logBodies: false,
      },
      emitExporterEvent: createExporterHealthEventEmitter((event) => {
        events.push(event);
      }),
      logger,
      logsEnabled: true,
      logsToOtlp: true,
      logsToStdout: false,
      resource: {} as never,
      serviceName: "openclaw-test",
    });
    const attributes = new Proxy<Record<string, string | number | boolean>>(
      {},
      {
        ownKeys() {
          throw new TypeError("private preparation details");
        },
      },
    );

    const recordLog = (
      seq: number,
      recordAttributes: Record<string, string | number | boolean>,
    ) => {
      diagnosticsLogs.recordLogRecord?.(
        {
          type: "log.record",
          seq,
          ts: seq,
          level: "INFO",
          message: "prepare me",
          attributes: recordAttributes,
        },
        { trusted: false },
      );
    };
    recordLog(1, attributes);
    recordLog(2, attributes);
    recordLog(3, {});

    expect(
      events.map(({ transport, status, reason, errorCategory }) => ({
        transport,
        status,
        reason,
        errorCategory,
      })),
    ).toEqual([
      {
        transport: "otlp-http-protobuf",
        status: "failure",
        reason: "emit_failed",
        errorCategory: "TypeError",
      },
      {
        transport: "otlp-http-protobuf",
        status: "recovered",
        reason: "emit_failed",
        errorCategory: undefined,
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("private preparation details");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("diagnostics-otel: log record export failed"),
    );
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

    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();
    const runDurationRecordCall = lastHistogramRecord("openclaw.run.duration_ms");
    expect(runDurationRecordCall?.[0]).toBe(100);
    expect(runDurationRecordCall?.[1]?.["openclaw.provider"]).toBe("openai");
    expect(telemetryState.tracer.startSpan).not.toHaveBeenCalled();

    await service.stop?.(ctx);
    expect(traceProviderShutdown).not.toHaveBeenCalled();
    expect(meterProviderShutdown).not.toHaveBeenCalled();
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
    expect(traceProviderShutdown).toHaveBeenCalledTimes(1);
    expect(meterProviderShutdown).toHaveBeenCalledTimes(1);

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
      "preserves valid collector credentials and query parameters",
      `https://${OTEL_TEST_USERINFO}@collector.example.com/otlp?tenant=red`,
      `https://${OTEL_TEST_USERINFO}@collector.example.com/otlp/v1/traces?tenant=red`,
    ],
    [
      "preserves parseable non-HTTP collector URL schemes",
      "custom+otel://collector.example.com/otlp",
      "custom+otel://collector.example.com/otlp/v1/traces",
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

  test("routes every signal from a shared signal-qualified endpoint", async () => {
    await startOtelService({
      endpoint: "https://collector.example.com/api/public/otel/v1/traces?tenant=red",
      traces: true,
      metrics: true,
      logs: true,
    });

    expect(firstExporterOptions(traceExporterCtor).url).toBe(
      "https://collector.example.com/api/public/otel/v1/traces?tenant=red",
    );
    expect(firstExporterOptions(metricExporterCtor).url).toBe(
      "https://collector.example.com/api/public/otel/v1/metrics?tenant=red",
    );
    expect(firstExporterOptions(logExporterCtor).url).toBe(
      "https://collector.example.com/api/public/otel/v1/logs?tenant=red",
    );
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

  test("passes explicit NodeSDK batch and metric defaults to private providers", async () => {
    await startOtelService({ traces: true, metrics: true });

    expect(firstSpanProcessorOptions()).toMatchObject({
      exportTimeoutMillis: 30_000,
      maxExportBatchSize: 512,
      maxQueueSize: 2048,
      scheduledDelayMillis: 5000,
    });
    expect(firstMetricReaderOptions()).toMatchObject({
      exportIntervalMillis: 60_000,
      exportTimeoutMillis: 30_000,
    });
    expect((mockCallArg(meterProviderCtor, 0) as Record<string, unknown>).sdkMetricsEnabled).toBe(
      false,
    );
    const traceOptions = mockCallArg(traceProviderCtor, 0) as Record<string, unknown>;
    expect(traceOptions.meterProvider).toBeUndefined();
    expect(traceOptions).not.toHaveProperty("sampler");
    expect(traceOptions).not.toHaveProperty("spanLimits");
    expect(firstSpanProcessorOptions().selfObsMeterProvider).toBeUndefined();
  });

  test("lets explicit OpenClaw sampling override the inherited sampler environment", async () => {
    process.env.OTEL_TRACES_SAMPLER = "always_off";
    await startOtelService({
      traces: true,
      configure: (ctx) => {
        ctx.config.diagnostics!.otel!.sampleRate = 1;
      },
    });

    const traceOptions = mockCallArg(traceProviderCtor, 0) as Record<string, unknown>;
    expect(traceOptions.sampler).toBeDefined();
    expect(traceOptions).not.toHaveProperty("spanLimits");
  });

  test("honors positive BSP and metric environment values", async () => {
    process.env.OTEL_BSP_MAX_QUEUE_SIZE = "32";
    process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = "16";
    process.env.OTEL_BSP_SCHEDULE_DELAY = "1250";
    process.env.OTEL_BSP_EXPORT_TIMEOUT = "2500";
    process.env.OTEL_METRIC_EXPORT_INTERVAL = "4000";
    process.env.OTEL_METRIC_EXPORT_TIMEOUT = "3000";

    await startOtelService({ traces: true, metrics: true });

    expect(firstSpanProcessorOptions()).toMatchObject({
      exportTimeoutMillis: 2500,
      maxExportBatchSize: 16,
      maxQueueSize: 32,
      scheduledDelayMillis: 1250,
    });
    expect(firstMetricReaderOptions()).toMatchObject({
      exportIntervalMillis: 4000,
      exportTimeoutMillis: 3000,
    });
  });

  test.each(["0", "-1", "invalid"])(
    "falls back from invalid positive-only OTel interval values: %s",
    async (value) => {
      process.env.OTEL_BSP_MAX_QUEUE_SIZE = value;
      process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = value;
      process.env.OTEL_BSP_SCHEDULE_DELAY = value;
      process.env.OTEL_BSP_EXPORT_TIMEOUT = value;
      process.env.OTEL_METRIC_EXPORT_INTERVAL = value;
      process.env.OTEL_METRIC_EXPORT_TIMEOUT = value;

      await startOtelService({ traces: true, metrics: true });

      expect(firstSpanProcessorOptions()).toMatchObject({
        exportTimeoutMillis: 30_000,
        maxExportBatchSize: 512,
        maxQueueSize: 2048,
        scheduledDelayMillis: 5000,
      });
      expect(firstMetricReaderOptions()).toMatchObject({
        exportIntervalMillis: 60_000,
        exportTimeoutMillis: 30_000,
      });
    },
  );

  test("clamps metric timeout to interval and wires experimental SDK metrics", async () => {
    process.env.OTEL_METRIC_EXPORT_INTERVAL = "2000";
    process.env.OTEL_METRIC_EXPORT_TIMEOUT = "3000";
    process.env.OTEL_NODE_EXPERIMENTAL_SDK_METRICS = "true";

    await startOtelService({ traces: true, metrics: true });

    expect(firstMetricReaderOptions()).toMatchObject({
      exportIntervalMillis: 2000,
      exportTimeoutMillis: 2000,
    });
    const meterOptions = mockCallArg(meterProviderCtor, 0) as Record<string, unknown>;
    expect(meterOptions.sdkMetricsEnabled).toBe(true);
    expect(
      (mockCallArg(traceProviderCtor, 0) as Record<string, unknown>).meterProvider,
    ).toBeDefined();
    expect(firstSpanProcessorOptions().selfObsMeterProvider).toBeDefined();
    expect(diagWarn).toHaveBeenCalledWith(
      "OTEL_METRIC_EXPORT_TIMEOUT (3000) is greater than the active metric export interval (2000). Clamping timeout to interval value.",
    );
  });

  test("clamps BSP export batches to the configured queue size", async () => {
    process.env.OTEL_BSP_MAX_QUEUE_SIZE = "16";
    process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE = "32";

    await startOtelService({ traces: true });

    expect(firstSpanProcessorOptions()).toMatchObject({
      maxExportBatchSize: 16,
      maxQueueSize: 16,
    });
  });

  test("merges configured service resource after detected environment attributes", async () => {
    process.env.OTEL_SERVICE_NAME = "environment-service";
    const { ctx } = await startOtelService({
      traces: true,
      configure: (serviceContext) => {
        serviceContext.config.diagnostics!.otel!.serviceName = "configured-service";
      },
    });

    expect(
      (mockCallArg(traceProviderCtor, 0) as { resource?: { attributes?: unknown } }).resource,
    ).toMatchObject({
      attributes: {
        "openclaw.test.detected": "1",
        "service.name": "configured-service",
      },
    });
    expect(ctx.logger.error).not.toHaveBeenCalled();
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
        ctx.config.diagnostics!.otel!.tracesEndpoint = "https://trace.example.com/custom";
        ctx.config.diagnostics!.otel!.metricsEndpoint =
          "https://metric.example.com/v1/traces?tenant=red";
        ctx.config.diagnostics!.otel!.logsEndpoint = "https://log.example.com/otlp/";
      },
    });

    const traceOptions = firstExporterOptions(traceExporterCtor);
    const metricOptions = firstExporterOptions(metricExporterCtor);
    const logOptions = firstExporterOptions(logExporterCtor);
    expect(traceOptions.url).toBe("https://trace.example.com/custom");
    expect(metricOptions.url).toBe("https://metric.example.com/v1/traces?tenant=red");
    expect(logOptions.url).toBe("https://log.example.com/otlp/");
  });

  test("uses signal-specific OTLP env endpoints when config is unset", async () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "https://trace-env.example.com/custom";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT =
      "https://metric-env.example.com/v1/traces?tenant=red";
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "https://log-env.example.com/otlp/";

    await startOtelService({
      traces: true,
      metrics: true,
      logs: true,
    });

    const traceOptions = firstExporterOptions(traceExporterCtor);
    const metricOptions = firstExporterOptions(metricExporterCtor);
    const logOptions = firstExporterOptions(logExporterCtor);
    expect(traceOptions.url).toBe("https://trace-env.example.com/custom");
    expect(metricOptions.url).toBe("https://metric-env.example.com/v1/traces?tenant=red");
    expect(logOptions.url).toBe("https://log-env.example.com/otlp/");
  });

  test("ignores malformed shared OTLP env when valid signal endpoints shadow it", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://operator:qa-ignored-shared-password@[";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "https://trace-env.example.com/v1/traces";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "https://metric-env.example.com/v1/metrics";
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "https://log-env.example.com/v1/logs";

    await startOtelService({ traces: true, metrics: true, logs: true });

    expect(firstExporterOptions(traceExporterCtor).url).toBe(
      "https://trace-env.example.com/v1/traces",
    );
    expect(firstExporterOptions(metricExporterCtor).url).toBe(
      "https://metric-env.example.com/v1/metrics",
    );
    expect(firstExporterOptions(logExporterCtor).url).toBe("https://log-env.example.com/v1/logs");
  });

  test("treats whitespace-only OTLP environment endpoints as unset", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = " \u00a0 ";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = " \t ";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "\u2000";
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "\ufeff";

    await startOtelService({ traces: true, metrics: true, logs: true });

    expect(firstExporterOptions(traceExporterCtor).url).toBe(`${OTEL_TEST_ENDPOINT}/v1/traces`);
    expect(firstExporterOptions(metricExporterCtor).url).toBe(`${OTEL_TEST_ENDPOINT}/v1/metrics`);
    expect(firstExporterOptions(logExporterCtor).url).toBe(`${OTEL_TEST_ENDPOINT}/v1/logs`);
  });

  test.each([
    {
      enabledSignal: "traces",
      flags: { traces: true, metrics: false, logs: false },
      metricReaderCount: 0,
      tracesDisabled: false,
    },
    {
      enabledSignal: "metrics",
      flags: { traces: false, metrics: true, logs: false },
      metricReaderCount: 1,
      tracesDisabled: true,
    },
    {
      enabledSignal: "traces and metrics",
      flags: { traces: true, metrics: true, logs: false },
      metricReaderCount: 1,
      tracesDisabled: false,
    },
  ] as const)(
    "keeps owned SDK exporter ownership explicit for $enabledSignal",
    async ({ flags, metricReaderCount, tracesDisabled }) => {
      process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
      await startOtelService(flags);

      if (metricReaderCount > 0) {
        expect((mockCallArg(meterProviderCtor, 0) as { readers?: unknown[] }).readers).toHaveLength(
          metricReaderCount,
        );
      } else {
        expect(meterProviderCtor).not.toHaveBeenCalled();
      }
      if (tracesDisabled) {
        expect(traceProviderCtor).not.toHaveBeenCalled();
      } else {
        expect(traceProviderCtor).toHaveBeenCalledTimes(1);
      }
    },
  );

  test.each([
    { label: "unset", env: undefined, expected: ["env", "process", "host"] },
    { label: "none", env: "none", expected: [] },
    { label: "subset", env: "process", expected: ["process"] },
    {
      label: "all",
      env: "all",
      expected: ["host", "os", "serviceinstance", "process", "env"],
    },
    {
      label: "subset with invalid name",
      env: "process,invalid-name",
      expected: ["process"],
    },
  ] as const)(
    "passes the $label resource detectors to detectResources",
    async ({ env, expected }) => {
      if (env === undefined) {
        delete process.env.OTEL_NODE_RESOURCE_DETECTORS;
      } else {
        process.env.OTEL_NODE_RESOURCE_DETECTORS = env;
      }
      await startOtelService({ traces: true });
      const call = detectResourcesMock.mock.calls.at(-1)?.[0] as
        | { detectors?: Array<{ detector: string }> }
        | undefined;
      expect(call?.detectors?.map((detector) => detector.detector)).toEqual(expected);
      if (env?.includes("invalid-name")) {
        expect(diagWarn).toHaveBeenCalledWith(
          'Invalid resource detector "invalid-name" specified in the environment variable OTEL_NODE_RESOURCE_DETECTORS',
        );
      }
    },
  );

  test("ignores malformed collector endpoints for preloaded traces and metrics", async () => {
    process.env.OPENCLAW_OTEL_PRELOADED = "1";
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://operator:qa-preloaded-shared-password@[";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT =
      "https://operator:qa-preloaded-trace-password@[";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT =
      "https://operator:qa-preloaded-metric-password@[";

    await startOtelService({ traces: true, metrics: true, logs: false });

    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();
    expect(traceExporterCtor).not.toHaveBeenCalled();
    expect(metricExporterCtor).not.toHaveBeenCalled();
  });

  test("ignores malformed collector endpoints for stdout-only diagnostics", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://operator:qa-stdout-shared-password@[";
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "https://operator:qa-stdout-log-password@[";

    await startOtelService({
      endpoint: "https://operator:qa-stdout-config-password@[",
      traces: false,
      metrics: false,
      logs: true,
      logsExporter: "stdout",
    });

    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();
    expect(logExporterCtor).not.toHaveBeenCalled();
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
      const sharedClientCertificatePath = path.join(certDir, "shared-client.pem");
      const clientKeyPath = path.join(certDir, "client-key.pem");
      writeFileSync(rootCertificatePath, "root-certificate");
      writeFileSync(clientCertificatePath, "trace-client-certificate");
      writeFileSync(sharedClientCertificatePath, "shared-client-certificate");
      writeFileSync(clientKeyPath, "client-key");
      process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = rootCertificatePath;
      process.env.OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE = sharedClientCertificatePath;
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
        cert: Buffer.from("shared-client-certificate"),
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

  test("pins validated collector TLS material on direct HTTPS exporter agents", async () => {
    const certDir = mkdtempSync(path.join(tmpdir(), "openclaw-otel-direct-tls-"));
    try {
      const rootCertificatePath = path.join(certDir, "root.pem");
      writeFileSync(rootCertificatePath, "explicit-root-certificate");
      process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = rootCertificatePath;

      await startOtelService({
        endpoint: "https://collector.example.com/otlp",
        traces: true,
      });

      expect(firstExporterOptions(traceExporterCtor).httpAgentOptions).toEqual({
        keepAlive: true,
        ca: Buffer.from("explicit-root-certificate"),
      });
    } finally {
      rmSync(certDir, { force: true, recursive: true });
    }
  });

  test("validates log TLS before constructing any trace, metric, or SDK owner", async () => {
    process.env.OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE =
      "/definitely-missing/qa-otel-log-root-atomic.pem";

    await expect(
      startOtelService({
        endpoint: "https://collector.example.com/otlp",
        traces: true,
        metrics: true,
        logs: true,
      }),
    ).rejects.toThrow(
      "Configured OpenTelemetry TLS root certificate file is missing, empty, or unreadable; refusing insecure export",
    );

    expect(traceExporterCtor).not.toHaveBeenCalled();
    expect(metricExporterCtor).not.toHaveBeenCalled();
    expect(logExporterCtor).not.toHaveBeenCalled();
    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();
  });

  test("never falls back from an unreadable signal TLS file to readable shared trust", async () => {
    process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = process.execPath;
    process.env.OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE =
      "/definitely-missing/qa-otel-signal-override.pem";

    await expect(startOtelService({ traces: true })).rejects.toThrow(
      "Configured OpenTelemetry TLS root certificate file is missing, empty, or unreadable; refusing insecure export",
    );
    expect(traceExporterCtor).not.toHaveBeenCalled();
  });

  test("lets a readable signal TLS file shadow an unreadable shared trust file", async () => {
    process.env.OTEL_EXPORTER_OTLP_CERTIFICATE =
      "/definitely-missing/qa-otel-shadowed-shared-root.pem";
    process.env.OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE = process.execPath;

    await startOtelService({ traces: true });

    expect(traceExporterCtor).toHaveBeenCalledTimes(1);
  });

  test("keeps valid ambient TLS material compatible with plain HTTP collectors", async () => {
    process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = process.execPath;

    await startOtelService({ endpoint: "http://collector.example.com/otlp", traces: true });

    expect(traceExporterCtor).toHaveBeenCalledTimes(1);
    expect(firstExporterOptions(traceExporterCtor).httpAgentOptions).toBeUndefined();
  });

  test("does not validate TLS material owned by a preloaded SDK", async () => {
    process.env.OPENCLAW_OTEL_PRELOADED = "1";
    process.env.OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE =
      "/definitely-missing/qa-otel-preloaded-traces-root.pem";
    process.env.OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE =
      "/definitely-missing/qa-otel-preloaded-metrics-root.pem";

    await startOtelService({ traces: true, metrics: true, logs: false });

    expect(traceProviderCtor).not.toHaveBeenCalled();
    expect(meterProviderCtor).not.toHaveBeenCalled();
  });

  test("still validates plugin-owned OTLP logs when a trace SDK is preloaded", async () => {
    process.env.OPENCLAW_OTEL_PRELOADED = "1";
    process.env.OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE =
      "/definitely-missing/qa-otel-preloaded-log-root.pem";

    await expect(startOtelService({ traces: true, logs: true })).rejects.toThrow(
      "Configured OpenTelemetry TLS root certificate file is missing, empty, or unreadable; refusing insecure export",
    );
    expect(logExporterCtor).not.toHaveBeenCalled();
  });

  test.each([
    {
      signal: "disabled traces",
      envKey: "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE",
      flags: { traces: false, metrics: true, logs: false },
    },
    {
      signal: "disabled metrics",
      envKey: "OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE",
      flags: { traces: true, metrics: false, logs: false },
    },
    {
      signal: "disabled logs",
      envKey: "OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE",
      flags: { traces: true, metrics: false, logs: false },
    },
    {
      signal: "stdout-only logs",
      envKey: "OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE",
      flags: { traces: true, metrics: false, logs: true, logsExporter: "stdout" },
    },
  ] as const)("does not read TLS files for $signal", async ({ envKey, flags }) => {
    process.env[envKey] = "/definitely-missing/qa-otel-inactive-signal-root.pem";

    await startOtelService(flags);

    expect(traceProviderCtor.mock.calls.length + meterProviderCtor.mock.calls.length).toBe(1);
  });

  test.each([
    ["traces", { traces: true }, "unsupported proxy protocol"],
    ["metrics", { metrics: true }, "invalid proxy URL"],
    ["logs", { logs: true }, "unsupported proxy protocol"],
  ] as const)(
    "refuses direct %s export when the configured proxy cannot initialize",
    async (_signal, signals, errorMessage) => {
      createNodeProxyAgentMock.mockImplementation(() => {
        throw new Error(errorMessage);
      });

      await expect(
        startOtelService({ endpoint: "https://collector.example.com/otlp", ...signals }),
      ).rejects.toThrow(
        "Configured telemetry proxy is invalid or unsupported; refusing direct export",
      );

      expect(traceExporterCtor).not.toHaveBeenCalled();
      expect(metricExporterCtor).not.toHaveBeenCalled();
      expect(logExporterCtor).not.toHaveBeenCalled();
    },
  );

  test("redacts proxy credentials from telemetry startup failures", async () => {
    const proxyPassword = "qa-otel-proxy-password-sentinel";
    createNodeProxyAgentMock.mockImplementation(() => {
      throw new Error(`Invalid proxy URL: "https://operator:${proxyPassword}@proxy.example.com"`);
    });

    const failure = await startOtelService({
      endpoint: "https://collector.example.com/otlp",
      traces: true,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      message: "Configured telemetry proxy is invalid or unsupported; refusing direct export",
    });
    expect(failure).not.toHaveProperty("cause");
    expect(String(failure)).not.toContain(proxyPassword);
    expect(traceExporterCtor).not.toHaveBeenCalled();
  });

  test.each([
    {
      disabledSignal: "traces",
      enabledSignal: "metrics",
      disabledEndpoint: "tracesEndpoint",
      signals: { traces: false, metrics: true },
    },
    {
      disabledSignal: "metrics",
      enabledSignal: "traces",
      disabledEndpoint: "metricsEndpoint",
      signals: { traces: true, metrics: false },
    },
  ] as const)(
    "does not resolve proxy settings for disabled $disabledSignal export",
    async ({ disabledSignal, enabledSignal, disabledEndpoint, signals }) => {
      createNodeProxyAgentMock.mockImplementation(({ targetUrl }: { targetUrl: string }) => {
        if (targetUrl.includes(`disabled-${disabledSignal}.example.com`)) {
          throw new Error("invalid disabled-signal proxy");
        }
        return nodeProxyAgent;
      });

      await startOtelService({
        endpoint: "https://collector.example.com/otlp",
        ...signals,
        configure: (ctx) => {
          ctx.config.diagnostics!.otel![disabledEndpoint] =
            `https://disabled-${disabledSignal}.example.com/otlp`;
        },
      });

      expect(createNodeProxyAgentCalls()).toEqual([
        expect.objectContaining({
          targetUrl: `https://collector.example.com/otlp/v1/${enabledSignal}`,
        }),
      ]);
    },
  );

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

  test("closes a tracked blocked tool span once without creating a duplicate", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-blocked",
      toolName: "exec",
      toolCallId: "call-blocked",
      sourceTimestampMs: 1_000,
      trace: createTestTrace(TOOL_SPAN_ID, CHILD_SPAN_ID),
    });
    await emitTrustedAndFlush({
      type: "tool.execution.blocked",
      runId: "run-blocked",
      toolName: "exec",
      toolCallId: "call-blocked",
      deniedReason: "tools.deny",
      reason: "policy denied",
      sourceTimestampMs: 1_250,
      trace: createTestTrace(TOOL_SPAN_ID, CHILD_SPAN_ID),
    });

    const toolSpans = telemetryState.spans.filter(
      (span) => span.name === "openclaw.tool.execution",
    );
    expect(toolSpans).toHaveLength(1);
    expect(startedSpanOptions("openclaw.tool.execution")?.startTime).toBe(1_000);
    expect(toolSpans[0]?.end).toHaveBeenCalledTimes(1);
    expect(toolSpans[0]?.end).toHaveBeenCalledWith(1_250);
  });

  test("uses authoritative source timestamps for terminal-only tool spans", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitTrustedDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-completed",
      toolName: "read",
      toolCallId: "call-completed",
      durationMs: 250,
      sourceTimestampMs: 5_000,
    });
    await emitTrustedAndFlush({
      type: "tool.execution.error",
      runId: "run-error",
      toolName: "write",
      toolCallId: "call-error",
      durationMs: 500,
      errorCategory: "test",
      sourceTimestampMs: 7_000,
    });

    const toolSpanCalls = telemetryState.tracer.startSpan.mock.calls.filter(
      (call) => call[0] === "openclaw.tool.execution",
    );
    const toolSpans = telemetryState.spans.filter(
      (span) => span.name === "openclaw.tool.execution",
    );
    expect(toolSpanCalls).toHaveLength(2);
    expect((toolSpanCalls[0]?.[1] as { startTime?: number } | undefined)?.startTime).toBe(4_750);
    expect((toolSpanCalls[1]?.[1] as { startTime?: number } | undefined)?.startTime).toBe(6_500);
    expect(toolSpans[0]?.end).toHaveBeenCalledWith(5_000);
    expect(toolSpans[1]?.end).toHaveBeenCalledWith(7_000);
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

  test("maps model call APIs and preserves zero usage on terminal spans", async () => {
    await startOtelService({ traces: true, metrics: true });
    const zeroUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
      total: 0,
    };

    emitDiagnosticEvent({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      api: "openai-completions",
      durationMs: 80,
      requestPayloadBytes: 0,
      responseStreamBytes: 0,
      timeToFirstByteMs: 0,
      usage: zeroUsage,
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
    emitDiagnosticEvent({
      type: "model.call.error",
      runId: "run-1",
      callId: "call-3",
      ...MODEL_FIXTURE,
      api: "openai-responses",
      durationMs: 40,
      errorCategory: "TimeoutError",
      usage: zeroUsage,
    });
    await emitAndFlush({
      type: "model.call.completed",
      ...MODEL_CALL_FIXTURE,
      callId: "call-cache-only",
      durationMs: 30,
      usage: { cacheWrite: 7 },
    });

    const modelCallAttrs = telemetryState.tracer.startSpan.mock.calls
      .filter((call) => call[0] === "openclaw.model.call")
      .map((call) => (call[1] as { attributes?: Record<string, unknown> }).attributes);
    expect(modelCallAttrs).toHaveLength(4);
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
    for (const attrs of [modelCallAttrs[0], modelCallAttrs[2]]) {
      expect(attrs).toMatchObject({
        "openclaw.model_call.usage.input_tokens": 0,
        "openclaw.model_call.usage.output_tokens": 0,
        "openclaw.model_call.usage.cache_read_input_tokens": 0,
        "openclaw.model_call.usage.cache_creation_input_tokens": 0,
        "openclaw.model_call.usage.reasoning_output_tokens": 0,
        "openclaw.model_call.usage.prompt_tokens": 0,
        "openclaw.model_call.usage.total_tokens": 0,
        "gen_ai.usage.input_tokens": 0,
        "gen_ai.usage.output_tokens": 0,
        "gen_ai.usage.cache_read.input_tokens": 0,
        "gen_ai.usage.cache_creation.input_tokens": 0,
      });
    }
    for (const key of [
      "openclaw.model_call.request_bytes",
      "openclaw.model_call.response_bytes",
      "openclaw.model_call.time_to_first_byte_ms",
    ]) {
      expect(modelCallAttrs[0]).not.toHaveProperty(key);
    }
    expect(
      Object.keys(modelCallAttrs[1] ?? {}).filter(
        (key) => key.startsWith("openclaw.model_call.usage.") || key.startsWith("gen_ai.usage."),
      ),
    ).toEqual([]);
    expect(modelCallAttrs[3]).toMatchObject({
      "openclaw.model_call.usage.cache_creation_input_tokens": 7,
      "openclaw.model_call.usage.prompt_tokens": 7,
      "gen_ai.usage.input_tokens": 7,
      "gen_ai.usage.cache_creation.input_tokens": 7,
    });
    expect(modelCallAttrs[3]).not.toHaveProperty("openclaw.model_call.usage.input_tokens");
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

  test("prepares model and tool spans synchronously for propagation without duplicate spans", async () => {
    await startOtelService({ traces: true, metrics: true });

    const runTrace = createTestTrace(CHILD_SPAN_ID, SPAN_ID);
    const modelTrace = createTestTrace(MODEL_CALL_SPAN_ID, CHILD_SPAN_ID);
    const toolTrace = createTestTrace(TOOL_SPAN_ID, MODEL_CALL_SPAN_ID);
    emitRunStarted({ trace: runTrace });
    expect(formatDiagnosticTraceparent(modelTrace)).toBe(
      `00-${modelTrace.traceId}-${modelTrace.spanId}-01`,
    );
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      ...MODEL_CALL_FIXTURE,
      trace: modelTrace,
    });

    const modelSpanContext = spanByName("openclaw.model.call").spanContext();
    const runSpanContext = spanByName("openclaw.run").spanContext();
    expect(startedSpanParentContexts("openclaw.model.call")).toEqual([runSpanContext]);
    expect(formatDiagnosticTraceparent(modelTrace)).toBe(
      `00-${modelTrace.traceId}-${modelTrace.spanId}-01`,
    );

    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-1",
      toolName: "read",
      trace: toolTrace,
    });
    expect(startedSpanParentContexts("openclaw.tool.execution")).toEqual([modelSpanContext]);
    expect(formatDiagnosticTraceparent(toolTrace)).toBe(
      `00-${toolTrace.traceId}-${toolTrace.spanId}-01`,
    );

    await waitForDiagnosticEventsDrained();

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

  // Background commands can finish long after run.completed ended the parent span.
  // A missed parent lookup makes OTel mint a fresh trace id, silently splitting the
  // turn into one-span traces, so the link must not depend on elapsed time.
  test.each([
    [
      "openclaw.model.call",
      {
        type: "model.call.completed",
        ...MODEL_CALL_FIXTURE,
        durationMs: 80,
        trace: createTestTrace(MODEL_CALL_SPAN_ID, CHILD_SPAN_ID),
      },
    ],
    [
      "openclaw.tool.execution",
      {
        type: "tool.execution.completed",
        runId: "run-1",
        toolName: "read",
        durationMs: 20,
        trace: createTestTrace(TOOL_SPAN_ID, CHILD_SPAN_ID),
      },
    ],
  ] as const)(
    "parents late %s spans into the run trace after more than 30 minutes",
    async (spanName, childEvent) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await startOtelService({ traces: true, metrics: true });

        emitRunStarted();
        const runSpanContext = spanByName("openclaw.run").spanContext();
        emitRunCompleted();

        vi.setSystemTime(Date.now() + LATE_CHILD_ELAPSED_MS);
        await flushDiagnosticEvents();
        await waitForDiagnosticEventsDrained();
        await flushDiagnosticEvents();

        emitTrustedDiagnosticEvent(childEvent);
        await flushDiagnosticEvents();

        const parentContext = startedSpanParentContexts(spanName)[0];
        expect(parentContext?.traceId).toBe(TRACE_ID);
        expect(parentContext?.spanId).toBe(runSpanContext.spanId);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // Retained contexts outlive the turn, so this bound is what keeps a long-lived
  // gateway from growing the map without limit.
  test("bounds retained run contexts by evicting the oldest completed runs", async () => {
    await startOtelService({ traces: true, metrics: true });

    // Each completed run retains its own span id plus its upstream alias, so
    // this comfortably overflows the bound and evicts the earliest run.
    for (let index = 0; index < MAX_RETAINED_TRUSTED_SPAN_CONTEXTS; index += 1) {
      const runId = `run-${index}`;
      const runTrace = createTestTrace(numberedSpanId(index), SPAN_ID);
      emitRunStarted({ runId, trace: runTrace });
      emitRunCompleted({ runId, trace: runTrace });
    }
    const newestRunSpanId = numberedSpanId(MAX_RETAINED_TRUSTED_SPAN_CONTEXTS - 1);
    const newestRunSpan = telemetryState.spans.findLast((span) => span.name === "openclaw.run");
    telemetryState.tracer.startSpan.mockClear();

    emitTrustedDiagnosticEvent({
      type: "model.usage",
      ...MODEL_FIXTURE,
      usage: { input: 3, output: 2, total: 5 },
      durationMs: 10,
      trace: createTestTrace(GRANDCHILD_SPAN_ID, newestRunSpanId),
    });
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      ...MODEL_FIXTURE,
      usage: { input: 3, output: 2, total: 5 },
      durationMs: 10,
      trace: createTestTrace(MODEL_USAGE_SPAN_ID, numberedSpanId(0)),
    });

    const usageParents = startedSpanParentContexts("openclaw.model.usage");
    expect(usageParents[0]?.spanId).toBe(newestRunSpan?.spanContext().spanId);
    expect(usageParents[1]).toBeUndefined();
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

  test.each([
    {
      label: "completed",
      event: {
        type: "harness.run.completed",
        runId: "run-completed-only",
        provider: "openai",
        model: "gpt-5.4",
        harnessId: "openclaw",
        outcome: "completed",
        durationMs: 90,
        trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
      } satisfies TrustedEventOf<"harness.run.completed">,
    },
    {
      label: "error",
      event: {
        type: "harness.run.error",
        runId: "run-error-only",
        provider: "openai",
        model: "gpt-5.4",
        harnessId: "openclaw",
        phase: "send",
        errorCategory: "aborted",
        durationMs: 90,
        trace: createTestTrace(GRANDCHILD_SPAN_ID, CHILD_SPAN_ID),
      } satisfies TrustedEventOf<"harness.run.error">,
    },
  ])("keeps $label-only harness fallback spans parentless", async ({ event }) => {
    await startOtelService({ traces: true, metrics: true });

    await emitTrustedAndFlush(event);

    expect(startedSpanParentContexts("openclaw.harness.run")[0]).toBeUndefined();
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

  // Exec spans used to always be roots, which stranded every shell command in its
  // own single-span trace instead of nesting it under the run that spawned it.
  test("nests exec spans under the run when the trace context is OpenClaw-owned", async () => {
    await startOtelService({ traces: true, metrics: true });

    emitRunStarted();
    const runSpanContext = spanByName("openclaw.run").spanContext();
    const execEvent = {
      type: "exec.process.completed",
      target: "host",
      mode: "child",
      outcome: "completed",
      durationMs: 30,
      commandLength: 12,
      // Exec carries the ambient run scope, so its own span id is the run's.
      trace: createTestTrace(CHILD_SPAN_ID, SPAN_ID),
    } as const;

    emitDiagnosticEventWithTrustedTraceContext(execEvent);
    emitDiagnosticEvent(execEvent);
    await flushDiagnosticEvents();

    const execParents = startedSpanParentContexts("openclaw.exec");
    expect(execParents[0]?.traceId).toBe(TRACE_ID);
    expect(execParents[0]?.spanId).toBe(runSpanContext.spanId);
    // A plain untrusted emitter must not be able to inject a parent link.
    expect(execParents[1]).toBeUndefined();
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

  test("exports bounded redacted content when capture is enabled", async () => {
    await startOtelService({
      traces: true,
      metrics: true,
      captureContent: true,
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
    expect(Object.hasOwn(modelAttrs ?? {}, "openclaw.content.system_prompt")).toBe(false);
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

  test("omits absent model content fields when capture is enabled", async () => {
    await startOtelService({
      traces: true,
      captureContent: true,
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
      captureContent: true,
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
    expect(Object.hasOwn(attrs ?? {}, "gen_ai.system_instructions")).toBe(false);
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
      captureContent: true,
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
          { type: "tool_call", id: "tool-1", name: "Read" },
        ],
        finish_reason: "end_turn",
      },
    ]);
    const compatibilityOutput = stringAttribute(attrs, "openclaw.content.output_messages");
    expect(compatibilityOutput).not.toContain("checked the span");
    expect(JSON.parse(compatibilityOutput)[0]?.content).toEqual([
      { type: "text", text: "trace complete" },
      { type: "reasoning", redacted: true },
      { type: "tool_call", id: "tool-1", name: "Read" },
    ]);
    expect(Object.hasOwn(attrs ?? {}, "gen_ai.system_instructions")).toBe(false);
    expect(Object.hasOwn(attrs ?? {}, "gen_ai.tool.definitions")).toBe(false);
  });

  test("never exports provider-internal thinking payloads in model message attributes", async () => {
    await startOtelService({
      traces: true,
      captureContent: true,
    });

    emitTrustedModelCallCompletedWithContent(
      {
        runId: "run-1",
        callId: "call-1",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        durationMs: 80,
      },
      {
        inputMessages: [
          {
            role: "assistant",
            reasoning_content: "input-message-internal-canary",
            reasoning_details: [{ text: "input-details-internal-canary" }],
            content: [
              { type: "thinking", thinking: "input-internal-canary" },
              { type: "reasoning", content: "input-part-internal-canary" },
              {
                type: "text",
                text: "visible input",
                textSignature: "input-text-signature-internal-canary",
              },
            ],
          },
        ],
        outputMessages: [
          {
            role: "assistant",
            reasoning: "output-message-internal-canary",
            reasoning_text: "output-text-internal-canary",
            content: [
              { type: "redacted_thinking", data: "output-internal-canary" },
              { type: "text", text: "visible output" },
              {
                type: "toolCall",
                id: "tool-1",
                name: "lookup",
                arguments: { query: "visible" },
                thoughtSignature: "output-thought-signature-internal-canary",
              },
            ],
          },
        ],
      },
    );
    await flushDiagnosticEvents();

    const attrs = startedSpanOptions("openclaw.model.call")?.attributes;
    const internalCanaries = [
      "input-internal-canary",
      "input-message-internal-canary",
      "input-details-internal-canary",
      "input-part-internal-canary",
      "output-internal-canary",
      "output-message-internal-canary",
      "output-text-internal-canary",
      "input-text-signature-internal-canary",
      "output-thought-signature-internal-canary",
    ];
    for (const key of [
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "openclaw.content.input_messages",
      "openclaw.content.output_messages",
    ]) {
      const value = stringAttribute(attrs, key);
      for (const canary of internalCanaries) {
        expect(value).not.toContain(canary);
      }
    }
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.input.messages"))[0]?.parts).toEqual([
      { type: "text", content: "visible input" },
    ]);
    expect(JSON.parse(stringAttribute(attrs, "gen_ai.output.messages"))[0]?.parts).toEqual([
      { type: "text", content: "visible output" },
      {
        type: "tool_call",
        id: "tool-1",
        name: "lookup",
        arguments: { query: "visible" },
      },
    ]);
    expect(
      JSON.parse(stringAttribute(attrs, "openclaw.content.input_messages"))[0]?.content[0],
    ).toEqual({ type: "reasoning", redacted: true });
    expect(
      JSON.parse(stringAttribute(attrs, "openclaw.content.input_messages"))[0]?.content[1],
    ).toEqual({ type: "reasoning", redacted: true });
    expect(
      JSON.parse(stringAttribute(attrs, "openclaw.content.output_messages"))[0]?.content[0],
    ).toEqual({ type: "reasoning", redacted: true });
    expect(
      JSON.parse(stringAttribute(attrs, "openclaw.content.input_messages"))[0]?.content[2],
    ).toEqual({ type: "text", text: "visible input" });
    expect(
      JSON.parse(stringAttribute(attrs, "openclaw.content.output_messages"))[0]?.content[2],
    ).toEqual({
      type: "toolCall",
      id: "tool-1",
      name: "lookup",
      arguments: { query: "visible" },
    });
  });

  test("emits semconv response text for tool response parts", async () => {
    await startOtelService({
      traces: true,
      captureContent: true,
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
      captureContent: true,
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
      captureContent: true,
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
      captureContent: true,
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
      captureContent: true,
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
