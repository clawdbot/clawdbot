import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const telemetryState = vi.hoisted(() => {
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
  const spans: Array<{
    name: string;
    addEvent: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
    setAttributes: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    spanContext: ReturnType<typeof vi.fn>;
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
        spanContext: vi.fn(() => ({
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

vi.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: function BatchLogRecordProcessor() {},
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
  emitTrustedDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type { OpenClawPluginServiceContext } from "../api.js";
import { emitDiagnosticEvent } from "../api.js";
import { createDiagnosticsOtelService } from "./service.js";

const OTEL_TEST_STATE_DIR = "/tmp/openclaw-diagnostics-otel-test";
const OTEL_TEST_ENDPOINT = "http://otel-collector:4318";
const OTEL_TEST_PROTOCOL = "http/protobuf";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const CHILD_SPAN_ID = "1111111111111111";
const GRANDCHILD_SPAN_ID = "2222222222222222";
const TOOL_SPAN_ID = "3333333333333333";
const PROTO_KEY = "__proto__";
const MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS = 4096;
const OTEL_TRUNCATED_SUFFIX_MAX_CHARS = 20;
const ORIGINAL_OPENCLAW_OTEL_PRELOADED = process.env.OPENCLAW_OTEL_PRELOADED;
const ORIGINAL_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
const ORIGINAL_OTEL_EXPORTER_OTLP_METRICS_ENDPOINT =
  process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
const ORIGINAL_OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
const ORIGINAL_OTEL_SEMCONV_STABILITY_OPT_IN = process.env.OTEL_SEMCONV_STABILITY_OPT_IN;

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

type OtelContextFlags = {
  traces?: boolean;
  metrics?: boolean;
  logs?: boolean;
  captureContent?: NonNullable<
    NonNullable<OpenClawPluginServiceContext["config"]["diagnostics"]>["otel"]
  >["captureContent"];
};
function createOtelContext(
  endpoint: string,
  { traces = false, metrics = false, logs = false, captureContent }: OtelContextFlags = {},
): OpenClawPluginServiceContext {
  return {
    config: {
      diagnostics: {
        enabled: true,
        otel: {
          enabled: true,
          endpoint,
          protocol: OTEL_TEST_PROTOCOL,
          traces,
          metrics,
          logs,
          ...(captureContent !== undefined ? { captureContent } : {}),
        },
      },
    },
    logger: createLogger(),
    stateDir: OTEL_TEST_STATE_DIR,
    internalDiagnostics: {
      emit: emitTrustedDiagnosticEvent,
      onEvent: onInternalDiagnosticEvent,
    },
  };
}

function createTraceOnlyContext(endpoint: string): OpenClawPluginServiceContext {
  return createOtelContext(endpoint, { traces: true });
}

async function emitAndCaptureLog(
  event: Omit<Extract<Parameters<typeof emitDiagnosticEvent>[0], { type: "log.record" }>, "type">,
  options: { trusted?: boolean } = {},
) {
  const service = createDiagnosticsOtelService();
  const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { logs: true });
  await service.start(ctx);
  const emit = options.trusted ? emitTrustedDiagnosticEvent : emitDiagnosticEvent;
  emit({
    type: "log.record",
    ...event,
  });
  await flushDiagnosticEvents();
  expect(logEmit).toHaveBeenCalled();
  const emitCall = logEmit.mock.calls[0]?.[0];
  await service.stop?.(ctx);
  return emitCall;
}

function flushDiagnosticEvents() {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

describe("diagnostics-otel service", () => {
  beforeEach(() => {
    resetDiagnosticEventsForTest();
    delete process.env.OPENCLAW_OTEL_PRELOADED;
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
    delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    delete process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT;
  });

  afterEach(() => {
    resetDiagnosticEventsForTest();
    if (ORIGINAL_OPENCLAW_OTEL_PRELOADED === undefined) {
      delete process.env.OPENCLAW_OTEL_PRELOADED;
    } else {
      process.env.OPENCLAW_OTEL_PRELOADED = ORIGINAL_OPENCLAW_OTEL_PRELOADED;
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
  });

  test("records message-flow metrics and spans", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true, logs: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "webhook.received",
      channel: "telegram",
      updateType: "telegram-post",
    });
    emitDiagnosticEvent({
      type: "webhook.processed",
      channel: "telegram",
      updateType: "telegram-post",
      durationMs: 120,
    });
    emitDiagnosticEvent({
      type: "message.queued",
      channel: "telegram",
      source: "telegram",
      queueDepth: 2,
    });
    emitDiagnosticEvent({
      type: "message.processed",
      channel: "telegram",
      outcome: "completed",
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

    expect(telemetryState.counters.get("openclaw.webhook.received")?.add).toHaveBeenCalled();
    expect(
      telemetryState.histograms.get("openclaw.webhook.duration_ms")?.record,
    ).toHaveBeenCalled();
    expect(telemetryState.counters.get("openclaw.message.queued")?.add).toHaveBeenCalled();
    expect(telemetryState.counters.get("openclaw.message.processed")?.add).toHaveBeenCalled();
    expect(
      telemetryState.histograms.get("openclaw.message.duration_ms")?.record,
    ).toHaveBeenCalled();
    expect(telemetryState.histograms.get("openclaw.queue.wait_ms")?.record).toHaveBeenCalled();
    expect(telemetryState.counters.get("openclaw.session.stuck")?.add).toHaveBeenCalled();
    expect(
      telemetryState.histograms.get("openclaw.session.stuck_age_ms")?.record,
    ).toHaveBeenCalled();
    expect(telemetryState.counters.get("openclaw.run.attempt")?.add).toHaveBeenCalled();

    const spanNames = telemetryState.tracer.startSpan.mock.calls.map((call) => call[0]);
    expect(spanNames).toContain("openclaw.webhook.processed");
    expect(spanNames).toContain("openclaw.message.processed");
    expect(spanNames).toContain("openclaw.session.stuck");

    emitDiagnosticEvent({
      type: "log.record",
      level: "INFO",
      message: "hello",
      attributes: { subsystem: "diagnostic" },
    });
    await flushDiagnosticEvents();
    expect(logEmit).toHaveBeenCalled();

    await service.stop?.(ctx);
  });

  test("restarts without retaining prior listeners or log transports", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true, logs: true });
    await service.start(ctx);
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

  test("uses a preloaded OpenTelemetry SDK without dropping diagnostic listeners", async () => {
    process.env.OPENCLAW_OTEL_PRELOADED = "1";
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true, logs: true });
    await service.start(ctx);

    expect(sdkStart).not.toHaveBeenCalled();
    expect(traceExporterCtor).not.toHaveBeenCalled();
    expect(ctx.logger.info).toHaveBeenCalledWith(
      "diagnostics-otel: using preloaded OpenTelemetry SDK",
    );

    emitDiagnosticEvent({
      type: "run.completed",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      outcome: "completed",
      durationMs: 100,
    });
    emitDiagnosticEvent({
      type: "log.record",
      level: "INFO",
      message: "preloaded log",
    });
    await flushDiagnosticEvents();

    expect(telemetryState.histograms.get("openclaw.run.duration_ms")?.record).toHaveBeenCalledWith(
      100,
      expect.objectContaining({
        "openclaw.provider": "openai",
        "openclaw.model": "gpt-5.4",
      }),
    );
    expect(telemetryState.tracer.startSpan).toHaveBeenCalledWith(
      "openclaw.run",
      expect.objectContaining({
        attributes: expect.objectContaining({
          "openclaw.outcome": "completed",
        }),
      }),
      undefined,
    );
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
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true, logs: true });

    await service.start(ctx);

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "telemetry.exporter",
          exporter: "diagnostics-otel",
          signal: "traces",
          status: "started",
          reason: "configured",
        }),
        expect.objectContaining({
          type: "telemetry.exporter",
          exporter: "diagnostics-otel",
          signal: "metrics",
          status: "started",
          reason: "configured",
        }),
        expect.objectContaining({
          type: "telemetry.exporter",
          exporter: "diagnostics-otel",
          signal: "logs",
          status: "started",
          reason: "configured",
        }),
      ]),
    );
    expect(
      telemetryState.counters.get("openclaw.telemetry.exporter.events")?.add,
    ).toHaveBeenCalledWith(1, {
      "openclaw.exporter": "diagnostics-otel",
      "openclaw.signal": "logs",
      "openclaw.status": "started",
      "openclaw.reason": "configured",
    });

    unsubscribe();
    await service.stop?.(ctx);
  });

  test("records liveness warning diagnostics", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });

    await service.start(ctx);
    emitDiagnosticEvent({
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
    await flushDiagnosticEvents();

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
    const livenessSpan = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.liveness.warning",
    );
    expect(livenessSpan?.[1]).toMatchObject({
      attributes: {
        "openclaw.liveness.reason": "event_loop_delay:cpu",
        "openclaw.liveness.active": 2,
        "openclaw.liveness.queued": 4,
      },
    });
    const span = telemetryState.spans.find((item) => item.name === "openclaw.liveness.warning");
    expect(span?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "event_loop_delay:cpu",
    });

    await service.stop?.(ctx);
  });

  test("reports log exporter emit failures without exporting raw error text", async () => {
    const events: Array<Parameters<Parameters<typeof onInternalDiagnosticEvent>[0]>[0]> = [];
    const unsubscribe = onInternalDiagnosticEvent((event) => {
      if (event.type === "telemetry.exporter") {
        events.push(event);
      }
    });
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { logs: true });
    logEmit.mockImplementationOnce(() => {
      throw new TypeError("token sk-test-secret should not leave as telemetry");
    });

    await service.start(ctx);
    emitDiagnosticEvent({
      type: "log.record",
      level: "INFO",
      message: "export me",
    });
    await flushDiagnosticEvents();

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "telemetry.exporter",
          exporter: "diagnostics-otel",
          signal: "logs",
          status: "failure",
          reason: "emit_failed",
          errorCategory: "TypeError",
        }),
      ]),
    );
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
    await service.stop?.(ctx);
  });

  test("ignores untrusted telemetry exporter events for OTEL metrics", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { metrics: true });

    await service.start(ctx);
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

    await service.stop?.(ctx);
  });

  test("honors disabled traces when an OpenTelemetry SDK is preloaded", async () => {
    process.env.OPENCLAW_OTEL_PRELOADED = "1";
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: false, metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "run.completed",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      outcome: "completed",
      durationMs: 100,
    });
    await flushDiagnosticEvents();

    expect(sdkStart).not.toHaveBeenCalled();
    expect(telemetryState.histograms.get("openclaw.run.duration_ms")?.record).toHaveBeenCalledWith(
      100,
      expect.objectContaining({
        "openclaw.provider": "openai",
      }),
    );
    expect(telemetryState.tracer.startSpan).not.toHaveBeenCalled();

    await service.stop?.(ctx);
    expect(sdkShutdown).not.toHaveBeenCalled();
  });

  test("tears down active handles when restarted with diagnostics disabled", async () => {
    const service = createDiagnosticsOtelService();
    const enabledCtx = createOtelContext(OTEL_TEST_ENDPOINT, {
      traces: true,
      metrics: true,
      logs: true,
    });
    await service.start(enabledCtx);
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

  test("appends signal path when endpoint contains non-signal /v1 segment", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createTraceOnlyContext("https://www.comet.com/opik/api/v1/private/otel");
    await service.start(ctx);

    const options = traceExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    expect(options?.url).toBe("https://www.comet.com/opik/api/v1/private/otel/v1/traces");
    await service.stop?.(ctx);
  });

  test("keeps already signal-qualified endpoint unchanged", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createTraceOnlyContext("https://collector.example.com/v1/traces");
    await service.start(ctx);

    const options = traceExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    expect(options?.url).toBe("https://collector.example.com/v1/traces");
    await service.stop?.(ctx);
  });

  test("keeps signal-qualified endpoint unchanged when it has query params", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createTraceOnlyContext("https://collector.example.com/v1/traces?timeout=30s");
    await service.start(ctx);

    const options = traceExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    expect(options?.url).toBe("https://collector.example.com/v1/traces?timeout=30s");
    await service.stop?.(ctx);
  });

  test("keeps signal-qualified endpoint unchanged when signal path casing differs", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createTraceOnlyContext("https://collector.example.com/v1/Traces");
    await service.start(ctx);

    const options = traceExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    expect(options?.url).toBe("https://collector.example.com/v1/Traces");
    await service.stop?.(ctx);
  });

  test("uses signal-specific OTLP endpoints ahead of the shared endpoint", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, {
      traces: true,
      metrics: true,
      logs: true,
    });
    ctx.config.diagnostics!.otel!.tracesEndpoint = "https://trace.example.com/otlp";
    ctx.config.diagnostics!.otel!.metricsEndpoint = "https://metric.example.com/v1/metrics";
    ctx.config.diagnostics!.otel!.logsEndpoint = "https://log.example.com/otlp";

    await service.start(ctx);

    const traceOptions = traceExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    const metricOptions = metricExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    const logOptions = logExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    expect(traceOptions?.url).toBe("https://trace.example.com/otlp/v1/traces");
    expect(metricOptions?.url).toBe("https://metric.example.com/v1/metrics");
    expect(logOptions?.url).toBe("https://log.example.com/otlp/v1/logs");
    await service.stop?.(ctx);
  });

  test("uses signal-specific OTLP env endpoints when config is unset", async () => {
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "https://trace-env.example.com/v1/traces";
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT = "https://metric-env.example.com/otlp";
    process.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT = "https://log-env.example.com/otlp";

    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, {
      traces: true,
      metrics: true,
      logs: true,
    });
    await service.start(ctx);

    const traceOptions = traceExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    const metricOptions = metricExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    const logOptions = logExporterCtor.mock.calls[0]?.[0] as { url?: string } | undefined;
    expect(traceOptions?.url).toBe("https://trace-env.example.com/v1/traces");
    expect(metricOptions?.url).toBe("https://metric-env.example.com/otlp/v1/metrics");
    expect(logOptions?.url).toBe("https://log-env.example.com/otlp/v1/logs");
    await service.stop?.(ctx);
  });

  test("redacts sensitive data from log messages before export", async () => {
    const emitCall = await emitAndCaptureLog({
      level: "INFO",
      message: "Using API key sk-1234567890abcdef1234567890abcdef",
    });

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
      trace: {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: "01",
      },
    });

    expect(emitCall?.attributes).toEqual(
      expect.not.objectContaining({
        "openclaw.traceId": expect.anything(),
        "openclaw.spanId": expect.anything(),
        "openclaw.traceFlags": expect.anything(),
      }),
    );
    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    expect(emitCall?.context).toBeUndefined();
  });

  test("attaches trusted diagnostic trace context to exported logs", async () => {
    const emitCall = await emitAndCaptureLog(
      {
        level: "INFO",
        message: "traceable log",
        trace: {
          traceId: TRACE_ID,
          spanId: SPAN_ID,
          traceFlags: "01",
        },
      },
      { trusted: true },
    );

    expect(telemetryState.tracer.setSpanContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: 1,
        isRemote: true,
      }),
    );
    expect(emitCall?.context).toEqual({
      spanContext: expect.objectContaining({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
      }),
    });
  });

  test("bounds plugin-emitted log attributes and omits source paths", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { logs: true });
    await service.start(ctx);

    const attributes = Object.create(null) as Record<string, string>;
    attributes.good = "y".repeat(6000);
    attributes["bad key"] = "drop-me";
    attributes[PROTO_KEY] = "pollute";
    attributes["constructor"] = "pollute";
    attributes["prototype"] = "pollute";
    attributes["sk-1234567890abcdef1234567890abcdef"] = "secret-key"; // pragma: allowlist secret

    emitDiagnosticEvent({
      type: "log.record",
      level: "INFO",
      message: "x".repeat(6000),
      attributes,
      code: {
        filepath: "/Users/alice/openclaw/src/private.ts",
        line: 42,
        functionName: "handler",
        location: "/Users/alice/openclaw/src/private.ts:42",
      },
    } as Parameters<typeof emitDiagnosticEvent>[0]);
    await flushDiagnosticEvents();

    const emitCall = logEmit.mock.calls[0]?.[0];
    expect(emitCall?.body.length).toBeLessThanOrEqual(4200);
    expect(emitCall?.attributes).toMatchObject({
      "openclaw.good": expect.stringMatching(/^y+/),
      "code.lineno": 42,
      "code.function": "handler",
    });
    expect(String(emitCall?.attributes?.["openclaw.good"]).length).toBeLessThanOrEqual(4200);
    expect(Object.hasOwn(emitCall?.attributes ?? {}, `openclaw.${PROTO_KEY}`)).toBe(false);
    expect(Object.hasOwn(emitCall?.attributes ?? {}, "openclaw.constructor")).toBe(false);
    expect(Object.hasOwn(emitCall?.attributes ?? {}, "openclaw.prototype")).toBe(false);
    expect(
      Object.hasOwn(
        emitCall?.attributes ?? {},
        "openclaw.sk-1234567890abcdef1234567890abcdef", // pragma: allowlist secret
      ),
    ).toBe(false);
    expect(emitCall?.attributes).toEqual(
      expect.not.objectContaining({
        "openclaw.bad key": expect.anything(),
        "code.filepath": expect.anything(),
        "openclaw.code.location": expect.anything(),
      }),
    );
    await service.stop?.(ctx);
  });

  test("rate-limits repeated log export failure reports", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { logs: true });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    logEmit.mockImplementation(() => {
      throw new Error("export failed");
    });
    try {
      await service.start(ctx);

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
      await service.stop?.(ctx);
    }
  });

  test("does not parent diagnostic event spans from plugin-emittable trace context", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.usage",
      trace: {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: "01",
      },
      provider: "openai",
      model: "gpt-5.4",
      usage: { total: 4 },
      durationMs: 12,
    });

    const modelUsageCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.usage",
    );
    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    expect(modelUsageCall?.[2]).toBeUndefined();
    await service.stop?.(ctx);
  });

  test("exports GenAI client token usage histogram for input and output only", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.usage",
      sessionKey: "session-key",
      channel: "webchat",
      agentId: "ops",
      provider: "openai",
      model: "gpt-5.4",
      usage: {
        input: 12,
        output: 7,
        cacheRead: 3,
        cacheWrite: 2,
        promptTokens: 17,
        total: 24,
      },
    });
    await flushDiagnosticEvents();

    expect(telemetryState.meter.createHistogram).toHaveBeenCalledWith(
      "gen_ai.client.token.usage",
      expect.objectContaining({
        unit: "{token}",
        advice: {
          explicitBucketBoundaries: expect.arrayContaining([1, 4, 16, 1024, 67108864]),
        },
      }),
    );
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
    await service.stop?.(ctx);
  });

  test("bounds agent identifiers on model usage metric attributes", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.usage",
      agentId: "Bearer sk-test-secret-value",
      provider: "openai",
      model: "gpt-5.4",
      usage: { input: 2 },
    });
    await flushDiagnosticEvents();

    expect(telemetryState.counters.get("openclaw.tokens")?.add).toHaveBeenCalledWith(2, {
      "openclaw.channel": "unknown",
      "openclaw.agent": "unknown",
      "openclaw.provider": "openai",
      "openclaw.model": "gpt-5.4",
      "openclaw.token": "input",
    });
    expect(
      JSON.stringify(telemetryState.counters.get("openclaw.tokens")?.add.mock.calls),
    ).not.toContain("sk-test-secret-value");
    await service.stop?.(ctx);
  });

  test("keeps GenAI token usage metric model attribute present when model is unavailable", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.usage",
      provider: "openai",
      usage: { input: 2 },
    });
    await flushDiagnosticEvents();

    expect(telemetryState.histograms.get("gen_ai.client.token.usage")?.record).toHaveBeenCalledWith(
      2,
      {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "unknown",
        "gen_ai.token.type": "input",
      },
    );
    await service.stop?.(ctx);
  });

  test("exports GenAI usage attributes on model usage spans without diagnostic identifiers", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.usage",
      sessionKey: "session-key",
      sessionId: "session-id",
      provider: "anthropic",
      model: "claude-sonnet-4.6",
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
    await flushDiagnosticEvents();

    const modelUsageCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.usage",
    );
    expect(modelUsageCall?.[1]).toMatchObject({
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.system": "anthropic",
        "gen_ai.request.model": "claude-sonnet-4.6",
        "gen_ai.usage.input_tokens": 150,
        "gen_ai.usage.output_tokens": 40,
        "gen_ai.usage.cache_read.input_tokens": 30,
        "gen_ai.usage.cache_creation.input_tokens": 20,
      },
    });
    expect(modelUsageCall?.[1]).toEqual({
      attributes: expect.not.objectContaining({
        "openclaw.sessionKey": expect.anything(),
        "openclaw.sessionId": expect.anything(),
        "gen_ai.provider.name": expect.anything(),
        "gen_ai.input.messages": expect.anything(),
        "gen_ai.output.messages": expect.anything(),
      }),
      startTime: expect.any(Number),
    });
    expect(JSON.stringify(modelUsageCall)).not.toContain("session-key");
    await service.stop?.(ctx);
  });

  test("exports GenAI client operation duration histogram without diagnostic identifiers", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      sessionKey: "session-key",
      provider: "openai",
      model: "gpt-5.4",
      api: "openai-completions",
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
    await flushDiagnosticEvents();

    expect(telemetryState.meter.createHistogram).toHaveBeenCalledWith(
      "gen_ai.client.operation.duration",
      expect.objectContaining({
        unit: "s",
        advice: {
          explicitBucketBoundaries: expect.arrayContaining([0.01, 0.32, 2.56, 81.92]),
        },
      }),
    );
    const genAiOperationDuration = telemetryState.histograms.get(
      "gen_ai.client.operation.duration",
    );
    expect(genAiOperationDuration?.record).toHaveBeenCalledTimes(2);
    expect(genAiOperationDuration?.record).toHaveBeenCalledWith(0.25, {
      "gen_ai.operation.name": "text_completion",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": "gpt-5.4",
    });
    expect(genAiOperationDuration?.record).toHaveBeenCalledWith(1.25, {
      "gen_ai.operation.name": "generate_content",
      "gen_ai.provider.name": "google",
      "gen_ai.request.model": "gemini-2.5-flash",
      "error.type": "TimeoutError",
    });
    expect(JSON.stringify(genAiOperationDuration?.record.mock.calls)).not.toContain("session-key");
    expect(JSON.stringify(genAiOperationDuration?.record.mock.calls)).not.toContain("run-1");
    await service.stop?.(ctx);
  });

  test("exports run, model call, and tool execution lifecycle spans", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "run.completed",
      runId: "run-1",
      sessionKey: "session-key",
      provider: "openai",
      model: "gpt-5.4",
      channel: "webchat",
      outcome: "completed",
      durationMs: 100,
      trace: {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: "01",
      },
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      api: "completions",
      transport: "http",
      durationMs: 80,
      requestPayloadBytes: 1234,
      responseStreamBytes: 567,
      timeToFirstByteMs: 45,
      trace: {
        traceId: TRACE_ID,
        spanId: CHILD_SPAN_ID,
        parentSpanId: SPAN_ID,
        traceFlags: "01",
      },
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
      trace: {
        traceId: TRACE_ID,
        spanId: GRANDCHILD_SPAN_ID,
        parentSpanId: CHILD_SPAN_ID,
        traceFlags: "01",
      },
    });
    emitDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-1",
      toolName: "read",
      toolCallId: "tool-1",
      paramsSummary: { kind: "object" },
      durationMs: 20,
      errorCategory: "TypeError",
      errorCode: "429",
      trace: {
        traceId: TRACE_ID,
        spanId: GRANDCHILD_SPAN_ID,
        parentSpanId: CHILD_SPAN_ID,
        traceFlags: "01",
      },
    });
    await flushDiagnosticEvents();

    const spanNames = telemetryState.tracer.startSpan.mock.calls.map((call) => call[0]);
    expect(spanNames).toEqual(
      expect.arrayContaining([
        "openclaw.run",
        "openclaw.model.call",
        "openclaw.harness.run",
        "openclaw.tool.execution",
      ]),
    );

    const runCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.run",
    );
    expect(runCall?.[1]).toMatchObject({
      attributes: {
        "openclaw.outcome": "completed",
        "openclaw.provider": "openai",
        "openclaw.model": "gpt-5.4",
        "openclaw.channel": "webchat",
      },
      startTime: expect.any(Number),
    });
    expect(runCall?.[1]).toEqual({
      attributes: expect.not.objectContaining({
        "gen_ai.system": expect.anything(),
        "gen_ai.request.model": expect.anything(),
        "openclaw.runId": expect.anything(),
        "openclaw.sessionKey": expect.anything(),
        "openclaw.traceId": expect.anything(),
      }),
      startTime: expect.any(Number),
    });

    const modelCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.call",
    );
    expect(modelCall?.[1]).toMatchObject({
      attributes: {
        "gen_ai.system": "openai",
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.operation.name": "text_completion",
      },
    });
    expect(modelCall?.[1]).toEqual({
      attributes: expect.not.objectContaining({
        "gen_ai.provider.name": expect.anything(),
        "openclaw.callId": expect.anything(),
        "openclaw.runId": expect.anything(),
        "openclaw.sessionKey": expect.anything(),
      }),
      startTime: expect.any(Number),
    });
    expect(modelCall?.[2]).toBeUndefined();

    const harnessCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.harness.run",
    );
    expect(harnessCall?.[1]).toMatchObject({
      attributes: {
        "openclaw.harness.id": "codex",
        "openclaw.harness.plugin": "codex-plugin",
        "openclaw.outcome": "completed",
        "openclaw.provider": "codex",
        "openclaw.model": "gpt-5.4",
        "openclaw.channel": "qa",
        "openclaw.harness.result_classification": "reasoning-only",
        "openclaw.harness.yield_detected": true,
        "openclaw.harness.items.started": 3,
        "openclaw.harness.items.completed": 2,
        "openclaw.harness.items.active": 1,
      },
      startTime: expect.any(Number),
    });
    expect(harnessCall?.[1]).toEqual({
      attributes: expect.not.objectContaining({
        "openclaw.runId": expect.anything(),
        "openclaw.sessionId": expect.anything(),
        "openclaw.sessionKey": expect.anything(),
        "openclaw.traceId": expect.anything(),
      }),
      startTime: expect.any(Number),
    });
    expect(harnessCall?.[2]).toBeUndefined();

    const toolCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.tool.execution",
    );
    expect(toolCall?.[1]).toMatchObject({
      attributes: {
        "openclaw.toolName": "read",
        "openclaw.errorCategory": "TypeError",
        "openclaw.errorCode": "429",
        "openclaw.tool.params.kind": "object",
        "gen_ai.tool.name": "read",
      },
    });
    expect(toolCall?.[1]).toEqual({
      attributes: expect.not.objectContaining({
        "openclaw.toolCallId": expect.anything(),
        "openclaw.runId": expect.anything(),
        "openclaw.sessionKey": expect.anything(),
      }),
      startTime: expect.any(Number),
    });
    expect(toolCall?.[2]).toBeUndefined();

    expect(
      telemetryState.histograms.get("openclaw.model_call.duration_ms")?.record,
    ).toHaveBeenCalledWith(
      80,
      expect.objectContaining({
        "openclaw.provider": "openai",
        "openclaw.model": "gpt-5.4",
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.model_call.request_bytes")?.record,
    ).toHaveBeenCalledWith(
      1234,
      expect.objectContaining({
        "openclaw.provider": "openai",
        "openclaw.model": "gpt-5.4",
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.model_call.response_bytes")?.record,
    ).toHaveBeenCalledWith(
      567,
      expect.objectContaining({
        "openclaw.provider": "openai",
        "openclaw.model": "gpt-5.4",
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.model_call.time_to_first_byte_ms")?.record,
    ).toHaveBeenCalledWith(
      45,
      expect.objectContaining({
        "openclaw.provider": "openai",
        "openclaw.model": "gpt-5.4",
      }),
    );
    const modelCallSpan = telemetryState.spans.find((span) => span.name === "openclaw.model.call");
    expect(modelCallSpan?.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "openclaw.model_call.request_bytes": 1234,
        "openclaw.model_call.response_bytes": 567,
        "openclaw.model_call.time_to_first_byte_ms": 45,
      }),
    );
    expect(telemetryState.histograms.get("openclaw.run.duration_ms")?.record).toHaveBeenCalledWith(
      100,
      expect.not.objectContaining({
        "openclaw.runId": expect.anything(),
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.harness.duration_ms")?.record,
    ).toHaveBeenCalledWith(
      90,
      expect.objectContaining({
        "openclaw.harness.id": "codex",
        "openclaw.harness.plugin": "codex-plugin",
        "openclaw.outcome": "completed",
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.harness.duration_ms")?.record,
    ).toHaveBeenCalledWith(
      90,
      expect.not.objectContaining({
        "openclaw.runId": expect.anything(),
        "openclaw.sessionKey": expect.anything(),
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.tool.execution.duration_ms")?.record,
    ).toHaveBeenCalledWith(
      20,
      expect.not.objectContaining({
        "openclaw.errorCode": expect.anything(),
        "openclaw.runId": expect.anything(),
      }),
    );

    const toolSpan = telemetryState.spans.find((span) => span.name === "openclaw.tool.execution");
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "TypeError",
    });
    expect(toolSpan?.end).toHaveBeenCalledWith(expect.any(Number));
    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    await service.stop?.(ctx);
  });

  test("maps model call APIs to GenAI operation names and error type", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
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
    emitDiagnosticEvent({
      type: "model.call.error",
      runId: "run-1",
      callId: "call-3",
      provider: "openai",
      model: "gpt-5.4",
      api: "openai-responses",
      durationMs: 40,
      errorCategory: "TimeoutError",
    });
    await flushDiagnosticEvents();

    const modelCallAttrs = telemetryState.tracer.startSpan.mock.calls
      .filter((call) => call[0] === "openclaw.model.call")
      .map((call) => (call[1] as { attributes?: Record<string, unknown> }).attributes);
    expect(modelCallAttrs).toEqual([
      expect.objectContaining({
        "gen_ai.system": "openai",
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.operation.name": "text_completion",
      }),
      expect.objectContaining({
        "gen_ai.system": "google",
        "gen_ai.request.model": "gemini-2.5-flash",
        "gen_ai.operation.name": "generate_content",
      }),
      expect.objectContaining({
        "gen_ai.system": "openai",
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.operation.name": "chat",
        "error.type": "TimeoutError",
      }),
    ]);
    await service.stop?.(ctx);
  });

  test("uses latest GenAI provider attribute only when semconv opt-in is set", async () => {
    process.env.OTEL_SEMCONV_STABILITY_OPT_IN = "http,gen_ai_latest_experimental";

    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      api: "openai-completions",
      durationMs: 80,
    });
    emitDiagnosticEvent({
      type: "model.usage",
      provider: "openai",
      model: "gpt-5.4",
      usage: { input: 3, output: 2 },
      durationMs: 10,
    });
    await flushDiagnosticEvents();

    const modelCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.call",
    );
    expect(modelCall?.[1]).toMatchObject({
      attributes: {
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.operation.name": "text_completion",
      },
    });
    expect(modelCall?.[1]).toEqual({
      attributes: expect.not.objectContaining({
        "gen_ai.system": expect.anything(),
      }),
      startTime: expect.any(Number),
    });
    const modelUsage = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.usage",
    );
    expect(modelUsage?.[1]).toMatchObject({
      attributes: {
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-5.4",
        "gen_ai.operation.name": "chat",
      },
    });
    expect(modelUsage?.[1]).toEqual({
      attributes: expect.not.objectContaining({
        "gen_ai.system": expect.anything(),
      }),
      startTime: expect.any(Number),
    });
    await service.stop?.(ctx);
  });

  test("records upstream request id hashes as model call span events only", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.call.error",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      api: "openai-responses",
      durationMs: 40,
      errorCategory: "ProviderError",
      failureKind: "terminated",
      upstreamRequestIdHash: "sha256:123456abcdef",
    });
    await flushDiagnosticEvents();

    const modelCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.call",
    );
    expect(modelCall?.[1]).toEqual({
      attributes: expect.objectContaining({
        "openclaw.failureKind": "terminated",
      }),
      startTime: expect.any(Number),
    });
    expect(modelCall?.[1]).toEqual({
      attributes: expect.not.objectContaining({
        "openclaw.upstreamRequestIdHash": expect.anything(),
      }),
      startTime: expect.any(Number),
    });
    const span = telemetryState.spans.find((candidate) => candidate.name === "openclaw.model.call");
    expect(span?.addEvent).toHaveBeenCalledWith("openclaw.provider.request", {
      "openclaw.upstreamRequestIdHash": "sha256:123456abcdef",
    });
    expect(
      telemetryState.histograms.get("openclaw.model_call.duration_ms")?.record,
    ).toHaveBeenCalledWith(
      40,
      expect.objectContaining({
        "openclaw.failureKind": "terminated",
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.model_call.duration_ms")?.record,
    ).toHaveBeenCalledWith(
      40,
      expect.not.objectContaining({
        "openclaw.upstreamRequestIdHash": expect.anything(),
      }),
    );
    await service.stop?.(ctx);
  });

  test("exports trusted context assembly spans without prompt content", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      trace: {
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: "01",
      },
    });
    emitTrustedDiagnosticEvent({
      type: "context.assembled",
      runId: "run-1",
      sessionKey: "session-key",
      sessionId: "session-id",
      provider: "openai",
      model: "gpt-5.4",
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
      trace: {
        traceId: TRACE_ID,
        spanId: GRANDCHILD_SPAN_ID,
        parentSpanId: SPAN_ID,
        traceFlags: "01",
      },
    });
    await flushDiagnosticEvents();

    const contextCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.context.assembled",
    );
    const runSpan = telemetryState.spans.find((span) => span.name === "openclaw.run");
    const runSpanId = runSpan?.spanContext.mock.results[0]?.value?.spanId;
    expect(contextCall?.[1]).toMatchObject({
      attributes: {
        "openclaw.provider": "openai",
        "openclaw.model": "gpt-5.4",
        "openclaw.channel": "webchat",
        "openclaw.trigger": "message",
        "openclaw.context.message_count": 12,
        "openclaw.context.history_text_chars": 1234,
        "openclaw.context.history_image_blocks": 2,
        "openclaw.context.max_message_text_chars": 456,
        "openclaw.context.system_prompt_chars": 789,
        "openclaw.context.prompt_chars": 42,
        "openclaw.context.prompt_images": 1,
        "openclaw.context.token_budget": 128_000,
        "openclaw.context.reserve_tokens": 4096,
      },
    });
    expect(contextCall?.[1]).toEqual({
      attributes: expect.any(Object),
      startTime: expect.any(Number),
    });
    expect(JSON.stringify(contextCall)).not.toContain("session-key");
    expect(JSON.stringify(contextCall)).not.toContain("prompt text");
    expect(telemetryState.tracer.setSpanContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ traceId: TRACE_ID, spanId: runSpanId }),
    );
    expect(
      (contextCall?.[2] as { spanContext?: { spanId?: string } } | undefined)?.spanContext?.spanId,
    ).toBe(runSpanId);
    await service.stop?.(ctx);
  });

  test("exports tool loop diagnostics without loop messages or session identifiers", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
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
    await flushDiagnosticEvents();

    expect(telemetryState.counters.get("openclaw.tool.loop")?.add).toHaveBeenCalledWith(1, {
      "openclaw.toolName": "process",
      "openclaw.loop.level": "critical",
      "openclaw.loop.action": "block",
      "openclaw.loop.detector": "known_poll_no_progress",
      "openclaw.loop.count": 20,
      "openclaw.loop.paired_tool": "read",
    });
    const loopSpanCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.tool.loop",
    );
    expect(loopSpanCall?.[1]).toMatchObject({
      attributes: {
        "openclaw.toolName": "process",
        "openclaw.loop.level": "critical",
        "openclaw.loop.action": "block",
        "openclaw.loop.detector": "known_poll_no_progress",
        "openclaw.loop.count": 20,
        "openclaw.loop.paired_tool": "read",
      },
    });
    const loopSpan = telemetryState.spans.find((span) => span.name === "openclaw.tool.loop");
    expect(loopSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "known_poll_no_progress:block",
    });
    expect(JSON.stringify(loopSpanCall)).not.toContain("session-key");
    expect(JSON.stringify(loopSpanCall)).not.toContain("secret-bearing");
    await service.stop?.(ctx);
  });

  test("exports diagnostic memory samples and pressure without session identifiers", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

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
    emitDiagnosticEvent({
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
    await flushDiagnosticEvents();

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
    const pressureCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.memory.pressure",
    );
    expect(pressureCall?.[1]).toMatchObject({
      attributes: {
        "openclaw.memory.level": "critical",
        "openclaw.memory.reason": "rss_growth",
        "openclaw.memory.rss_bytes": 200,
        "openclaw.memory.heap_used_bytes": 50,
        "openclaw.memory.heap_total_bytes": 90,
        "openclaw.memory.external_bytes": 20,
        "openclaw.memory.array_buffers_bytes": 6,
        "openclaw.memory.threshold_bytes": 512,
        "openclaw.memory.rss_growth_bytes": 256,
        "openclaw.memory.window_ms": 60_000,
      },
    });
    const pressureSpan = telemetryState.spans.find(
      (span) => span.name === "openclaw.memory.pressure",
    );
    expect(pressureSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "rss_growth",
    });
    expect(JSON.stringify(pressureCall)).not.toContain("session");
    await service.stop?.(ctx);
  });

  test("parents trusted diagnostic lifecycle spans from active started spans", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      trace: {
        traceId: TRACE_ID,
        spanId: CHILD_SPAN_ID,
        parentSpanId: SPAN_ID,
        traceFlags: "01",
      },
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      trace: {
        traceId: TRACE_ID,
        spanId: GRANDCHILD_SPAN_ID,
        parentSpanId: CHILD_SPAN_ID,
        traceFlags: "01",
      },
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.started",
      runId: "run-1",
      toolName: "read",
      trace: {
        traceId: TRACE_ID,
        spanId: TOOL_SPAN_ID,
        parentSpanId: GRANDCHILD_SPAN_ID,
        traceFlags: "01",
      },
    });
    emitTrustedDiagnosticEvent({
      type: "tool.execution.error",
      runId: "run-1",
      toolName: "read",
      durationMs: 20,
      errorCategory: "TypeError",
      trace: {
        traceId: TRACE_ID,
        spanId: TOOL_SPAN_ID,
        parentSpanId: GRANDCHILD_SPAN_ID,
        traceFlags: "01",
      },
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 80,
      trace: {
        traceId: TRACE_ID,
        spanId: GRANDCHILD_SPAN_ID,
        parentSpanId: CHILD_SPAN_ID,
        traceFlags: "01",
      },
    });
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      outcome: "completed",
      durationMs: 100,
      trace: {
        traceId: TRACE_ID,
        spanId: CHILD_SPAN_ID,
        parentSpanId: SPAN_ID,
        traceFlags: "01",
      },
    });
    await flushDiagnosticEvents();

    const runSpan = telemetryState.spans.find((span) => span.name === "openclaw.run");
    const modelSpan = telemetryState.spans.find((span) => span.name === "openclaw.model.call");
    const toolSpan = telemetryState.spans.find((span) => span.name === "openclaw.tool.execution");
    const runSpanId = runSpan?.spanContext.mock.results[0]?.value?.spanId;
    const modelSpanId = modelSpan?.spanContext.mock.results[0]?.value?.spanId;

    expect(telemetryState.tracer.setSpanContext).toHaveBeenCalledTimes(2);
    expect(telemetryState.tracer.setSpanContext.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ traceId: TRACE_ID, spanId: runSpanId }),
      expect.objectContaining({ traceId: TRACE_ID, spanId: modelSpanId }),
    ]);

    const parentBySpanName = Object.fromEntries(
      telemetryState.tracer.startSpan.mock.calls.map((call) => [
        call[0],
        (call[2] as { spanContext?: { spanId?: string } } | undefined)?.spanContext?.spanId,
      ]),
    );
    expect(parentBySpanName).toMatchObject({
      "openclaw.run": undefined,
      "openclaw.model.call": runSpanId,
      "openclaw.tool.execution": modelSpanId,
    });
    expect(toolSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "TypeError",
    });
    await service.stop?.(ctx);
  });

  test("keeps trusted run spans alive long enough for post-completion usage parenting", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.started",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      trace: {
        traceId: TRACE_ID,
        spanId: CHILD_SPAN_ID,
        parentSpanId: SPAN_ID,
        traceFlags: "01",
      },
    });
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      outcome: "completed",
      durationMs: 100,
      trace: {
        traceId: TRACE_ID,
        spanId: CHILD_SPAN_ID,
        parentSpanId: SPAN_ID,
        traceFlags: "01",
      },
    });
    emitTrustedDiagnosticEvent({
      type: "model.usage",
      provider: "openai",
      model: "gpt-5.4",
      usage: { input: 3, output: 2, total: 5 },
      durationMs: 10,
      trace: {
        traceId: TRACE_ID,
        spanId: GRANDCHILD_SPAN_ID,
        parentSpanId: SPAN_ID,
        traceFlags: "01",
      },
    });
    await flushDiagnosticEvents();

    const runSpan = telemetryState.spans.find((span) => span.name === "openclaw.run");
    const runSpanId = runSpan?.spanContext.mock.results[0]?.value?.spanId;
    const modelUsageCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.usage",
    );

    expect(telemetryState.tracer.setSpanContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ traceId: TRACE_ID, spanId: runSpanId }),
    );
    expect(
      (modelUsageCall?.[2] as { spanContext?: { spanId?: string } } | undefined)?.spanContext
        ?.spanId,
    ).toBe(runSpanId);
    expect(runSpan?.end).toHaveBeenCalledWith(expect.any(Number));
    await service.stop?.(ctx);
  });

  test("does not force remote parents for completed-only trusted lifecycle spans", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      outcome: "completed",
      durationMs: 100,
      trace: {
        traceId: TRACE_ID,
        spanId: CHILD_SPAN_ID,
        parentSpanId: SPAN_ID,
        traceFlags: "01",
      },
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 80,
      trace: {
        traceId: TRACE_ID,
        spanId: GRANDCHILD_SPAN_ID,
        parentSpanId: CHILD_SPAN_ID,
        traceFlags: "01",
      },
    });
    await flushDiagnosticEvents();

    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    const parentBySpanName = Object.fromEntries(
      telemetryState.tracer.startSpan.mock.calls.map((call) => [call[0], call[2]]),
    );
    expect(parentBySpanName).toMatchObject({
      "openclaw.run": undefined,
      "openclaw.model.call": undefined,
    });
    await service.stop?.(ctx);
  });

  test("does not self-parent trusted diagnostic lifecycle spans without parent ids", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitTrustedDiagnosticEvent({
      type: "run.completed",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      outcome: "completed",
      durationMs: 100,
      trace: {
        traceId: TRACE_ID,
        spanId: CHILD_SPAN_ID,
        traceFlags: "01",
      },
    });
    emitTrustedDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 80,
      trace: {
        traceId: TRACE_ID,
        spanId: GRANDCHILD_SPAN_ID,
        traceFlags: "01",
      },
    });
    await flushDiagnosticEvents();

    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    const parentBySpanName = Object.fromEntries(
      telemetryState.tracer.startSpan.mock.calls.map((call) => [call[0], call[2]]),
    );
    expect(parentBySpanName).toMatchObject({
      "openclaw.run": undefined,
      "openclaw.model.call": undefined,
    });
    await service.stop?.(ctx);
  });

  test("does not parent untrusted diagnostic lifecycle spans from injected trace ids", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "run.completed",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      outcome: "completed",
      durationMs: 100,
      trace: {
        traceId: TRACE_ID,
        spanId: CHILD_SPAN_ID,
        parentSpanId: SPAN_ID,
        traceFlags: "01",
      },
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 80,
      trace: {
        traceId: TRACE_ID,
        spanId: GRANDCHILD_SPAN_ID,
        parentSpanId: CHILD_SPAN_ID,
        traceFlags: "01",
      },
    });
    emitDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-1",
      toolName: "read",
      durationMs: 20,
      trace: {
        traceId: TRACE_ID,
        spanId: TOOL_SPAN_ID,
        parentSpanId: GRANDCHILD_SPAN_ID,
        traceFlags: "01",
      },
    });
    await flushDiagnosticEvents();

    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    const parentBySpanName = Object.fromEntries(
      telemetryState.tracer.startSpan.mock.calls.map((call) => [call[0], call[2]]),
    );
    expect(parentBySpanName).toMatchObject({
      "openclaw.run": undefined,
      "openclaw.model.call": undefined,
      "openclaw.tool.execution": undefined,
    });
    await service.stop?.(ctx);
  });

  test("does not create live started spans for untrusted lifecycle diagnostics", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "run.started",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
    });
    emitDiagnosticEvent({
      type: "run.completed",
      runId: "run-1",
      provider: "openai",
      model: "gpt-5.4",
      outcome: "completed",
      durationMs: 100,
    });
    emitDiagnosticEvent({
      type: "model.call.started",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
    });
    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
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
    emitDiagnosticEvent({
      type: "harness.run.completed",
      runId: "run-1",
      provider: "codex",
      model: "gpt-5.4",
      harnessId: "codex",
      pluginId: "codex-plugin",
      outcome: "completed",
      durationMs: 90,
    });
    await flushDiagnosticEvents();

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
    await service.stop?.(ctx);
  });

  test("exports exec process spans without command text", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
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
    await flushDiagnosticEvents();

    expect(telemetryState.histograms.get("openclaw.exec.duration_ms")?.record).toHaveBeenCalledWith(
      30,
      expect.objectContaining({
        "openclaw.exec.target": "host",
        "openclaw.exec.mode": "child",
        "openclaw.outcome": "failed",
        "openclaw.failureKind": "runtime-error",
      }),
    );

    const execCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.exec",
    );
    expect(execCall?.[1]).toMatchObject({
      attributes: {
        "openclaw.exec.target": "host",
        "openclaw.exec.mode": "child",
        "openclaw.outcome": "failed",
        "openclaw.exec.command_length": 42,
        "openclaw.exec.exit_code": 1,
        "openclaw.exec.timed_out": false,
        "openclaw.failureKind": "runtime-error",
      },
      startTime: expect.any(Number),
    });
    expect(execCall?.[1]).toEqual({
      attributes: expect.not.objectContaining({
        "openclaw.exec.command": expect.anything(),
        "openclaw.exec.workdir": expect.anything(),
        "openclaw.sessionKey": expect.anything(),
      }),
      startTime: expect.any(Number),
    });

    const execSpan = telemetryState.spans.find((span) => span.name === "openclaw.exec");
    expect(execSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "runtime-error",
    });
    expect(execSpan?.end).toHaveBeenCalledWith(expect.any(Number));
    await service.stop?.(ctx);
  });

  test("exports message delivery spans and metrics with low-cardinality attributes", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

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
    emitDiagnosticEvent({
      type: "message.delivery.error",
      channel: "discord",
      deliveryKind: "media",
      durationMs: 40,
      errorCategory: "TypeError",
      sessionKey: "session-secret",
    });
    await flushDiagnosticEvents();

    expect(
      telemetryState.counters.get("openclaw.message.delivery.started")?.add,
    ).toHaveBeenCalledWith(1, {
      "openclaw.channel": "matrix",
      "openclaw.delivery.kind": "text",
    });
    expect(
      telemetryState.histograms.get("openclaw.message.delivery.duration_ms")?.record,
    ).toHaveBeenCalledWith(
      25,
      expect.objectContaining({
        "openclaw.channel": "matrix",
        "openclaw.delivery.kind": "text",
        "openclaw.outcome": "completed",
      }),
    );
    expect(
      telemetryState.histograms.get("openclaw.message.delivery.duration_ms")?.record,
    ).toHaveBeenCalledWith(
      40,
      expect.objectContaining({
        "openclaw.channel": "discord",
        "openclaw.delivery.kind": "media",
        "openclaw.outcome": "error",
        "openclaw.errorCategory": "TypeError",
      }),
    );

    const deliverySpanCalls = telemetryState.tracer.startSpan.mock.calls.filter(
      (call) => call[0] === "openclaw.message.delivery",
    );
    expect(deliverySpanCalls).toHaveLength(2);
    expect(deliverySpanCalls[0]?.[1]).toMatchObject({
      attributes: {
        "openclaw.channel": "matrix",
        "openclaw.delivery.kind": "text",
        "openclaw.outcome": "completed",
        "openclaw.delivery.result_count": 1,
      },
      startTime: expect.any(Number),
    });
    expect(deliverySpanCalls[1]?.[1]).toMatchObject({
      attributes: {
        "openclaw.channel": "discord",
        "openclaw.delivery.kind": "media",
        "openclaw.outcome": "error",
        "openclaw.errorCategory": "TypeError",
      },
      startTime: expect.any(Number),
    });
    for (const call of deliverySpanCalls) {
      expect(call[1]).toEqual({
        attributes: expect.not.objectContaining({
          "openclaw.sessionKey": expect.anything(),
          "openclaw.messageId": expect.anything(),
          "openclaw.conversationId": expect.anything(),
          "openclaw.content": expect.anything(),
          "openclaw.to": expect.anything(),
        }),
        startTime: expect.any(Number),
      });
    }
    const errorSpan = telemetryState.spans.find(
      (span) => span.name === "openclaw.message.delivery" && span.setStatus.mock.calls.length > 0,
    );
    expect(errorSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "TypeError",
    });
    await service.stop?.(ctx);
  });

  test("does not export model or tool content unless capture is explicitly enabled", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 80,
      inputMessages: ["private user prompt"],
      outputMessages: ["private model reply"],
      systemPrompt: "private system prompt",
    } as Parameters<typeof emitDiagnosticEvent>[0]);
    emitDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-1",
      toolName: "read",
      toolCallId: "tool-1",
      durationMs: 20,
      toolInput: "private tool input",
      toolOutput: "private tool output",
    } as Parameters<typeof emitDiagnosticEvent>[0]);
    await flushDiagnosticEvents();

    const modelCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.call",
    );
    const toolCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.tool.execution",
    );
    expect(modelCall?.[1]).toEqual({
      attributes: expect.not.objectContaining({
        "openclaw.content.input_messages": expect.anything(),
        "openclaw.content.output_messages": expect.anything(),
        "openclaw.content.system_prompt": expect.anything(),
      }),
      startTime: expect.any(Number),
    });
    expect(toolCall?.[1]).toEqual({
      attributes: expect.not.objectContaining({
        "openclaw.content.tool_input": expect.anything(),
        "openclaw.content.tool_output": expect.anything(),
      }),
      startTime: expect.any(Number),
    });
    await service.stop?.(ctx);
  });

  test("exports bounded redacted content when capture fields are opted in", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, {
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
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.call.completed",
      runId: "run-1",
      callId: "call-1",
      provider: "openai",
      model: "gpt-5.4",
      durationMs: 80,
      inputMessages: ["use key sk-1234567890abcdef1234567890abcdef"], // pragma: allowlist secret
      outputMessages: ["model reply"],
      systemPrompt: "system prompt",
    } as Parameters<typeof emitDiagnosticEvent>[0]);
    emitDiagnosticEvent({
      type: "tool.execution.completed",
      runId: "run-1",
      toolName: "read",
      toolCallId: "tool-1",
      durationMs: 20,
      toolInput: "tool input",
      toolOutput: `${"x".repeat(4077)} Bearer ${"a".repeat(80)}`, // pragma: allowlist secret
    } as Parameters<typeof emitDiagnosticEvent>[0]);
    await flushDiagnosticEvents();

    const modelCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.call",
    );
    const toolCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.tool.execution",
    );
    const modelAttrs = (modelCall?.[1] as { attributes?: Record<string, unknown> } | undefined)
      ?.attributes;
    const toolAttrs = (toolCall?.[1] as { attributes?: Record<string, unknown> } | undefined)
      ?.attributes;

    expect(modelAttrs).toMatchObject({
      "openclaw.content.output_messages": "model reply",
      "openclaw.content.system_prompt": "system prompt",
    });
    expect(String(modelAttrs?.["openclaw.content.input_messages"])).not.toContain(
      "sk-1234567890abcdef1234567890abcdef", // pragma: allowlist secret
    );
    expect(toolAttrs).toMatchObject({
      "openclaw.content.tool_input": "tool input",
    });
    expect(String(toolAttrs?.["openclaw.content.tool_output"]).length).toBeLessThanOrEqual(
      MAX_TEST_OTEL_CONTENT_ATTRIBUTE_CHARS + OTEL_TRUNCATED_SUFFIX_MAX_CHARS,
    );
    expect(String(toolAttrs?.["openclaw.content.tool_output"])).not.toContain("a".repeat(11));
    await service.stop?.(ctx);
  });

  test("ignores invalid diagnostic event trace parents", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "model.usage",
      trace: {
        traceId: "0".repeat(32),
        spanId: "not-a-span",
        traceFlags: "zz",
      },
      provider: "openai",
      model: "gpt-5.4",
      usage: { total: 4 },
      durationMs: 12,
    });

    const modelUsageCall = telemetryState.tracer.startSpan.mock.calls.find(
      (call) => call[0] === "openclaw.model.usage",
    );
    expect(telemetryState.tracer.setSpanContext).not.toHaveBeenCalled();
    expect(modelUsageCall?.[2]).toBeUndefined();
    await service.stop?.(ctx);
  });

  test("redacts sensitive reason in session.state metric attributes", async () => {
    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { metrics: true });
    await service.start(ctx);

    emitDiagnosticEvent({
      type: "session.state",
      state: "waiting",
      reason: "token=ghp_abcdefghijklmnopqrstuvwxyz123456", // pragma: allowlist secret
    });

    const sessionCounter = telemetryState.counters.get("openclaw.session.state");
    expect(sessionCounter?.add).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        "openclaw.reason": expect.stringContaining("…"),
      }),
    );
    const attrs = sessionCounter?.add.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(typeof attrs?.["openclaw.reason"]).toBe("string");
    expect(String(attrs?.["openclaw.reason"])).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz123456", // pragma: allowlist secret
    );
    await service.stop?.(ctx);
  });
});
