import { beforeEach, describe, expect, test, vi } from "vitest";

const registerLogTransportMock = vi.hoisted(() => vi.fn());

const telemetryState = vi.hoisted(() => {
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
  const tracer = {
    startSpan: vi.fn((_name: string, _opts?: unknown, _ctx?: unknown) => ({
      end: vi.fn(),
      setStatus: vi.fn(),
    })),
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
  return { counters, histograms, tracer, meter };
});

const sdkStart = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const sdkShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const logEmit = vi.hoisted(() => vi.fn());
const logShutdown = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const traceExporterCtor = vi.hoisted(() => vi.fn());

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
  OTLPMetricExporter: function OTLPMetricExporter() {},
}));

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: function OTLPTraceExporter(options?: unknown) {
    traceExporterCtor(options);
  },
}));

vi.mock("@opentelemetry/exporter-logs-otlp-proto", () => ({
  OTLPLogExporter: function OTLPLogExporter() {},
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

vi.mock("../api.js", async () => {
  const actual = await vi.importActual<typeof import("../api.js")>("../api.js");
  return {
    ...actual,
    registerLogTransport: registerLogTransportMock,
  };
});

import type { OpenClawPluginServiceContext } from "../api.js";
import { emitDiagnosticEvent } from "../api.js";
import { createDiagnosticsOtelService } from "./service.js";

const OTEL_TEST_STATE_DIR = "/tmp/openclaw-diagnostics-otel-test";
const OTEL_TEST_ENDPOINT = "http://otel-collector:4318";
const OTEL_TEST_PROTOCOL = "http/protobuf";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";

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
};
function createOtelContext(
  endpoint: string,
  { traces = false, metrics = false, logs = false }: OtelContextFlags = {},
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
        },
      },
    },
    logger: createLogger(),
    stateDir: OTEL_TEST_STATE_DIR,
  };
}

function createTraceOnlyContext(endpoint: string): OpenClawPluginServiceContext {
  return createOtelContext(endpoint, { traces: true });
}

type RegisteredLogTransport = (logObj: Record<string, unknown>) => void;
function setupRegisteredTransports() {
  const registeredTransports: RegisteredLogTransport[] = [];
  const stopTransports: ReturnType<typeof vi.fn>[] = [];
  registerLogTransportMock.mockImplementation((transport) => {
    registeredTransports.push(transport);
    const stopTransport = vi.fn();
    stopTransports.push(stopTransport);
    return stopTransport;
  });
  return { registeredTransports, stopTransports };
}

async function emitAndCaptureLog(logObj: Record<string, unknown>) {
  const { registeredTransports } = setupRegisteredTransports();
  const service = createDiagnosticsOtelService();
  const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { logs: true });
  await service.start(ctx);
  expect(registeredTransports).toHaveLength(1);
  registeredTransports[0]?.(logObj);
  expect(logEmit).toHaveBeenCalled();
  const emitCall = logEmit.mock.calls[0]?.[0];
  await service.stop?.(ctx);
  return emitCall;
}

describe("diagnostics-otel service", () => {
  beforeEach(() => {
    telemetryState.counters.clear();
    telemetryState.histograms.clear();
    telemetryState.tracer.startSpan.mockClear();
    telemetryState.tracer.setSpanContext.mockClear();
    telemetryState.meter.createCounter.mockClear();
    telemetryState.meter.createHistogram.mockClear();
    sdkStart.mockClear();
    sdkShutdown.mockClear();
    logEmit.mockClear();
    logShutdown.mockClear();
    traceExporterCtor.mockClear();
    registerLogTransportMock.mockReset();
  });

  test("records message-flow metrics and spans", async () => {
    const { registeredTransports } = setupRegisteredTransports();

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

    expect(registerLogTransportMock).toHaveBeenCalledTimes(1);
    expect(registeredTransports).toHaveLength(1);
    registeredTransports[0]?.({
      0: '{"subsystem":"diagnostic"}',
      1: "hello",
      _meta: { logLevelName: "INFO", date: new Date() },
    });
    expect(logEmit).toHaveBeenCalled();

    await service.stop?.(ctx);
  });

  test("restarts without retaining prior listeners or log transports", async () => {
    const { registeredTransports, stopTransports } = setupRegisteredTransports();

    const service = createDiagnosticsOtelService();
    const ctx = createOtelContext(OTEL_TEST_ENDPOINT, { traces: true, metrics: true, logs: true });
    await service.start(ctx);
    await service.start(ctx);

    expect(registerLogTransportMock).toHaveBeenCalledTimes(2);
    expect(registeredTransports).toHaveLength(2);
    expect(stopTransports[0]).toHaveBeenCalledTimes(1);
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
    expect(stopTransports[1]).toHaveBeenCalledTimes(1);
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

  test("tears down active handles when restarted with diagnostics disabled", async () => {
    const { stopTransports } = setupRegisteredTransports();

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

    expect(stopTransports[0]).toHaveBeenCalledTimes(1);
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

  test("redacts sensitive data from log messages before export", async () => {
    const emitCall = await emitAndCaptureLog({
      0: "Using API key sk-1234567890abcdef1234567890abcdef",
      _meta: { logLevelName: "INFO", date: new Date() },
    });

    expect(emitCall?.body).not.toContain("sk-1234567890abcdef1234567890abcdef");
    expect(emitCall?.body).toContain("sk-123");
    expect(emitCall?.body).toContain("…");
  });

  test("redacts sensitive data from log attributes before export", async () => {
    const emitCall = await emitAndCaptureLog({
      0: '{"token":"ghp_abcdefghijklmnopqrstuvwxyz123456"}', // pragma: allowlist secret
      1: "auth configured",
      _meta: { logLevelName: "DEBUG", date: new Date() },
    });

    const tokenAttr = emitCall?.attributes?.["openclaw.token"];
    expect(tokenAttr).not.toBe("ghp_abcdefghijklmnopqrstuvwxyz123456"); // pragma: allowlist secret
    if (typeof tokenAttr === "string") {
      expect(tokenAttr).toContain("…");
    }
  });

  test("attaches diagnostic trace context to exported logs", async () => {
    const emitCall = await emitAndCaptureLog({
      0: '{"subsystem":"diagnostic"}',
      1: {
        trace: {
          traceId: TRACE_ID,
          spanId: SPAN_ID,
          traceFlags: "01",
        },
      },
      2: "traceable log",
      _meta: { logLevelName: "INFO", date: new Date() },
    });

    expect(emitCall?.attributes).toMatchObject({
      "openclaw.traceId": TRACE_ID,
      "openclaw.spanId": SPAN_ID,
      "openclaw.traceFlags": "01",
    });
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

  test("parents diagnostic event spans from trace context", async () => {
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
    expect(modelUsageCall?.[2]).toEqual({
      spanContext: expect.objectContaining({
        traceId: TRACE_ID,
        spanId: SPAN_ID,
        traceFlags: 1,
        isRemote: true,
      }),
    });
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
