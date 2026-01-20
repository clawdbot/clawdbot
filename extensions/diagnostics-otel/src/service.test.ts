import { beforeEach, describe, expect, test, vi } from "vitest";

const registerLogTransportMock = vi.hoisted(() => vi.fn());

const telemetryState = vi.hoisted(() => {
  const counters = new Map<string, { add: ReturnType<typeof vi.fn> }>();
  const histograms = new Map<string, { record: ReturnType<typeof vi.fn> }>();
  const tracer = {
    startSpan: vi.fn((_name: string, _opts?: unknown) => ({
      end: vi.fn(),
      setStatus: vi.fn(),
    })),
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

vi.mock("@opentelemetry/api", () => ({
  metrics: {
    getMeter: () => telemetryState.meter,
  },
  trace: {
    getTracer: () => telemetryState.tracer,
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

vi.mock("@opentelemetry/exporter-metrics-otlp-http", () => ({
  OTLPMetricExporter: class {},
}));

vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {},
}));

vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
  OTLPLogExporter: class {},
}));

vi.mock("@opentelemetry/sdk-logs", () => ({
  BatchLogRecordProcessor: class {},
  LoggerProvider: class {
    addLogRecordProcessor = vi.fn();
    getLogger = vi.fn(() => ({
      emit: logEmit,
    }));
    shutdown = logShutdown;
  },
}));

vi.mock("@opentelemetry/sdk-metrics", () => ({
  PeriodicExportingMetricReader: class {},
}));

vi.mock("@opentelemetry/sdk-trace-base", () => ({
  ParentBasedSampler: class {},
  TraceIdRatioBasedSampler: class {},
}));

vi.mock("@opentelemetry/resources", () => ({
  Resource: class {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(_value?: unknown) {}
  },
}));

vi.mock("@opentelemetry/semantic-conventions", () => ({
  SemanticResourceAttributes: {
    SERVICE_NAME: "service.name",
  },
}));

vi.mock("clawdbot/plugin-sdk", async () => {
  const actual = await vi.importActual<typeof import("clawdbot/plugin-sdk")>("clawdbot/plugin-sdk");
  return {
    ...actual,
    registerLogTransport: registerLogTransportMock,
  };
});

import { createDiagnosticsOtelService } from "./service.js";
import { emitDiagnosticEvent } from "clawdbot/plugin-sdk";

describe("diagnostics-otel service", () => {
  beforeEach(() => {
    telemetryState.counters.clear();
    telemetryState.histograms.clear();
    telemetryState.tracer.startSpan.mockClear();
    telemetryState.meter.createCounter.mockClear();
    telemetryState.meter.createHistogram.mockClear();
    sdkStart.mockClear();
    sdkShutdown.mockClear();
    logEmit.mockClear();
    logShutdown.mockClear();
    registerLogTransportMock.mockReset();
  });

  test("records message-flow metrics and spans", async () => {
    const registeredTransports: Array<(logObj: Record<string, unknown>) => void> = [];
    const stopTransport = vi.fn();
    registerLogTransportMock.mockImplementation((transport) => {
      registeredTransports.push(transport);
      return stopTransport;
    });

    const service = createDiagnosticsOtelService();
    await service.start({
      config: {
        diagnostics: {
          enabled: true,
          otel: {
            enabled: true,
            endpoint: "http://otel-collector:4318",
            protocol: "http/protobuf",
            traces: true,
            metrics: true,
            logs: true,
          },
        },
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });

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

    expect(telemetryState.counters.get("clawdbot.webhook.received")?.add).toHaveBeenCalled();
    expect(telemetryState.histograms.get("clawdbot.webhook.duration_ms")?.record).toHaveBeenCalled();
    expect(telemetryState.counters.get("clawdbot.message.queued")?.add).toHaveBeenCalled();
    expect(telemetryState.counters.get("clawdbot.message.processed")?.add).toHaveBeenCalled();
    expect(telemetryState.histograms.get("clawdbot.message.duration_ms")?.record).toHaveBeenCalled();
    expect(telemetryState.histograms.get("clawdbot.queue.wait_ms")?.record).toHaveBeenCalled();
    expect(telemetryState.counters.get("clawdbot.session.stuck")?.add).toHaveBeenCalled();
    expect(telemetryState.histograms.get("clawdbot.session.stuck_age_ms")?.record).toHaveBeenCalled();
    expect(telemetryState.counters.get("clawdbot.run.attempt")?.add).toHaveBeenCalled();

    const spanNames = telemetryState.tracer.startSpan.mock.calls.map((call) => call[0]);
    expect(spanNames).toContain("clawdbot.webhook.processed");
    expect(spanNames).toContain("clawdbot.message.processed");
    expect(spanNames).toContain("clawdbot.session.stuck");

    expect(registerLogTransportMock).toHaveBeenCalledTimes(1);
    expect(registeredTransports).toHaveLength(1);
    registeredTransports[0]?.({
      0: "{\"subsystem\":\"diagnostic\"}",
      1: "hello",
      _meta: { logLevelName: "INFO", date: new Date() },
    });
    expect(logEmit).toHaveBeenCalled();

    await service.stop?.();
  });
});
