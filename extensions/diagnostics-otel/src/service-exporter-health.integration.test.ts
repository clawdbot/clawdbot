import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { context, diag, DiagLogLevel, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, expect, test } from "vitest";
import type { DiagnosticEventPayload } from "../api.js";
import {
  getReportedExporterHealth,
  startOtelService,
  stopStartedOtelServices,
  type ReportedExporterHealth,
} from "./service.test-helpers.js";

const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
const IMMEDIATE_RETRY_AFTER = "Thu, 01 Jan 1970 00:00:00 GMT";
const OTEL_ENV_KEYS = [
  "OTEL_SDK_DISABLED",
  "OTEL_PROPAGATORS",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TIMEOUT",
  "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
  "OTEL_EXPORTER_OTLP_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY",
] as const;
const OTEL_GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");
const OTEL_GLOBAL_LOGS_KEY = Symbol.for("io.opentelemetry.js.api.logs");

type OtelGlobalRegistrations = {
  context?: Parameters<typeof context.setGlobalContextManager>[0];
  diag?: Parameters<typeof diag.setLogger>[0];
  metrics?: Parameters<typeof metrics.setGlobalMeterProvider>[0];
  propagation?: Parameters<typeof propagation.setGlobalPropagator>[0];
  trace?: Parameters<typeof trace.setGlobalTracerProvider>[0];
};
type ExporterEvent = Extract<DiagnosticEventPayload, { type: "telemetry.exporter" }>;

let originalPreloaded: string | undefined;
let originalEnv: Record<(typeof OTEL_ENV_KEYS)[number], string | undefined>;
let originalGlobals: OtelGlobalRegistrations;
let originalLogsProvider: ReturnType<typeof logs.getLoggerProvider> | undefined;

function registeredOtelGlobals(): OtelGlobalRegistrations | undefined {
  return (globalThis as unknown as Record<symbol, OtelGlobalRegistrations | undefined>)[
    OTEL_GLOBAL_API_KEY
  ];
}

beforeEach(() => {
  originalPreloaded = process.env[PRELOAD_ENV];
  originalEnv = Object.fromEntries(OTEL_ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof OTEL_ENV_KEYS)[number],
    string | undefined
  >;
  for (const key of OTEL_ENV_KEYS) {
    delete process.env[key];
  }
  originalGlobals = { ...registeredOtelGlobals() };
  originalLogsProvider = Object.hasOwn(globalThis, OTEL_GLOBAL_LOGS_KEY)
    ? logs.getLoggerProvider()
    : undefined;
  context.disable();
  logs.disable();
  metrics.disable();
  propagation.disable();
  trace.disable();
  process.env[PRELOAD_ENV] = "0";
});

afterEach(async () => {
  await stopStartedOtelServices();
  context.disable();
  propagation.disable();
  metrics.disable();
  trace.disable();
  logs.disable();
  if (originalGlobals.context) {
    context.setGlobalContextManager(originalGlobals.context);
  }
  if (originalGlobals.propagation) {
    propagation.setGlobalPropagator(originalGlobals.propagation);
  }
  if (originalGlobals.metrics) {
    metrics.setGlobalMeterProvider(originalGlobals.metrics);
  }
  if (originalGlobals.trace) {
    trace.setGlobalTracerProvider(originalGlobals.trace);
  }
  if (originalLogsProvider) {
    logs.setGlobalLoggerProvider(originalLogsProvider);
  }
  if (originalPreloaded === undefined) {
    delete process.env[PRELOAD_ENV];
  } else {
    process.env[PRELOAD_ENV] = originalPreloaded;
  }
  for (const key of OTEL_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  diag.disable();
  if (originalGlobals.diag) {
    diag.setLogger(originalGlobals.diag, {
      logLevel: DiagLogLevel.ALL,
      suppressOverrideMessage: true,
    });
  }
  resetDiagnosticEventsForTest();
});

async function startExporterHealthReceiver(
  handleRequest: (request: IncomingMessage, response: ServerResponse, requestCount: number) => void,
) {
  let requestCount = 0;
  const server = createServer((request, response) => {
    requestCount += 1;
    request.resume();
    handleRequest(request, response, requestCount);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    get requestCount() {
      return requestCount;
    },
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

function captureExporterEvents() {
  const events: ExporterEvent[] = [];
  const unsubscribe = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "telemetry.exporter") {
      events.push(event);
    }
  });
  return { events, unsubscribe };
}

const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});

async function waitForExporterStatus(
  events: Array<Pick<ReportedExporterHealth, "status">>,
  status: ReportedExporterHealth["status"],
) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (events.some((event) => event.status === status)) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`timed out waiting for exporter status ${status}`);
}

function emitExporterHealthSpan(name: string) {
  // Owned mode keeps trace providers private, so spans must be created through
  // the diagnostic event recorders instead of the global trace API.
  emit({
    type: "model.call.completed",
    runId: `run-${name}`,
    callId: `call-${name}`,
    provider: "openai",
    model: "gpt-5.4",
    durationMs: 10,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
  });
}

function startTraceExporterHealthService(
  endpoint: string,
  timeout: string,
  flushIntervalMs?: number,
) {
  process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT = timeout;
  return startOtelService({
    endpoint,
    traces: true,
    metrics: false,
    logs: false,
    ...(flushIntervalMs === undefined
      ? {}
      : {
          configure: (ctx) => {
            ctx.config.diagnostics!.otel!.flushIntervalMs = flushIntervalMs;
          },
        }),
  });
}

test("reports no OpenClaw-owned routes when the SDK is disabled", async () => {
  process.env.OTEL_SDK_DISABLED = " TRUE ";

  const { ctx } = await startOtelService({
    traces: true,
    metrics: true,
    logs: true,
    logsExporter: "stdout",
  });

  expect(
    getReportedExporterHealth(ctx).map(({ signal, transport, status }) => ({
      signal,
      transport,
      status,
    })),
  ).toEqual([]);
  expect(propagation.fields()).toEqual(["traceparent", "tracestate", "baggage"]);
});

test("retries a real OTLP 503 then succeeds without an intermediate failure fact", async () => {
  const receiver = await startExporterHealthReceiver((_request, response, requestCount) => {
    response.writeHead(requestCount === 1 ? 503 : 200, {
      ...(requestCount === 1 ? { "retry-after": IMMEDIATE_RETRY_AFTER } : {}),
      "content-type": "application/x-protobuf",
    });
    response.end();
  });
  const capture = captureExporterEvents();
  const { service, ctx } = await startTraceExporterHealthService(receiver.endpoint, "1000");

  try {
    emitExporterHealthSpan("retry-then-success");
    await waitForDiagnosticEventsDrained();
    await service.stop?.(ctx);
    await waitForDiagnosticEventsDrained();
    expect(receiver.requestCount).toBe(2);
    expect(capture.events.some((event) => event.status === "failure")).toBe(false);
    expect(
      getReportedExporterHealth(ctx).some(
        (event) => event.status === "failure" || event.status === "recovered",
      ),
    ).toBe(false);
  } finally {
    capture.unsubscribe();
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 15_000);

test("records a final failure after persistent real OTLP 503 responses", async () => {
  const receiver = await startExporterHealthReceiver((_request, response) => {
    response.writeHead(503, { "retry-after": IMMEDIATE_RETRY_AFTER });
    response.end();
  });
  const capture = captureExporterEvents();
  const { service, ctx } = await startTraceExporterHealthService(receiver.endpoint, "1000");

  try {
    emitExporterHealthSpan("persistent-503");
    await waitForDiagnosticEventsDrained();
    await Promise.resolve(service.stop?.(ctx)).catch(() => {});
    await waitForDiagnosticEventsDrained();
    expect(receiver.requestCount).toBe(6);
    expect(
      capture.events.filter(
        (event) => event.status === "failure" && event.reason === "emit_failed",
      ),
    ).toHaveLength(1);
    expect(
      getReportedExporterHealth(ctx).filter(
        (event) => event.status === "failure" && event.reason === "export_failed",
      ),
    ).toHaveLength(1);
  } finally {
    capture.unsubscribe();
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 15_000);

test.each([400, 408, 500] as const)(
  "records one final failure for a non-retryable real OTLP HTTP $statusCode response",
  async (statusCode) => {
    const receiver = await startExporterHealthReceiver((_request, response) => {
      response.writeHead(statusCode);
      response.end();
    });
    const capture = captureExporterEvents();
    const { service, ctx } = await startTraceExporterHealthService(receiver.endpoint, "1000");

    try {
      emitExporterHealthSpan(`http-${statusCode}`);
      await waitForDiagnosticEventsDrained();
      await Promise.resolve(service.stop?.(ctx)).catch(() => {});
      await waitForDiagnosticEventsDrained();
      expect(receiver.requestCount).toBe(1);
      expect(
        capture.events.filter(
          (event) => event.status === "failure" && event.reason === "emit_failed",
        ),
      ).toHaveLength(1);
      expect(
        getReportedExporterHealth(ctx).filter(
          (event) => event.status === "failure" && event.reason === "export_failed",
        ),
      ).toHaveLength(1);
    } finally {
      capture.unsubscribe();
      await service.stop?.(ctx);
      await receiver.close();
    }
  },
  15_000,
);

test("records a final failure for a real OTLP connection reset", async () => {
  const receiver = await startExporterHealthReceiver((request) => {
    request.socket.destroy();
  });
  const capture = captureExporterEvents();
  const { service, ctx } = await startTraceExporterHealthService(receiver.endpoint, "200");

  try {
    emitExporterHealthSpan("connection-reset");
    await waitForDiagnosticEventsDrained();
    await Promise.resolve(service.stop?.(ctx)).catch(() => {});
    await waitForDiagnosticEventsDrained();
    expect(receiver.requestCount).toBeGreaterThanOrEqual(1);
    expect(
      capture.events.filter(
        (event) => event.status === "failure" && event.reason === "emit_failed",
      ),
    ).toHaveLength(1);
    expect(
      getReportedExporterHealth(ctx).filter(
        (event) => event.status === "failure" && event.reason === "export_failed",
      ),
    ).toHaveLength(1);
  } finally {
    capture.unsubscribe();
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 15_000);

test("records a final failure for a real OTLP request timeout", async () => {
  const receiver = await startExporterHealthReceiver(() => {
    // Keep the request open until the exporter-owned timeout settles.
  });
  const capture = captureExporterEvents();
  const { service, ctx } = await startTraceExporterHealthService(receiver.endpoint, "150");

  try {
    emitExporterHealthSpan("request-timeout");
    await waitForDiagnosticEventsDrained();
    await Promise.resolve(service.stop?.(ctx)).catch(() => {});
    await waitForDiagnosticEventsDrained();
    expect(receiver.requestCount).toBeGreaterThanOrEqual(1);
    expect(
      capture.events.filter(
        (event) => event.status === "failure" && event.reason === "emit_failed",
      ),
    ).toHaveLength(1);
    expect(
      getReportedExporterHealth(ctx).filter(
        (event) => event.status === "failure" && event.reason === "export_failed",
      ),
    ).toHaveLength(1);
  } finally {
    capture.unsubscribe();
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 15_000);

test("records recovery after a later real OTLP export succeeds", async () => {
  let failExports = true;
  const receiver = await startExporterHealthReceiver((_request, response) => {
    response.writeHead(failExports ? 503 : 200, {
      "content-type": "application/x-protobuf",
      ...(failExports ? { "retry-after": IMMEDIATE_RETRY_AFTER } : {}),
    });
    response.end();
  });
  const capture = captureExporterEvents();
  const { service, ctx } = await startTraceExporterHealthService(receiver.endpoint, "1000", 1000);
  const health = getReportedExporterHealth(ctx);

  try {
    emitExporterHealthSpan("failure-before-recovery");
    await waitForDiagnosticEventsDrained();
    await waitForExporterStatus(health, "failure");
    failExports = false;
    emitExporterHealthSpan("successful-recovery");
    await waitForDiagnosticEventsDrained();
    await waitForExporterStatus(health, "recovered");
    expect(
      health.filter((event) => event.reason === "export_failed").map((event) => event.status),
    ).toEqual(["failure", "recovered"]);
    expect(capture.events.map((event) => event.status)).not.toContain("recovered");
  } finally {
    capture.unsubscribe();
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 15_000);
