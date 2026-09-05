import { setTimeout as sleep } from "node:timers/promises";
import {
  context,
  diag,
  DiagLogLevel,
  metrics,
  propagation,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  resetDiagnosticEventsForTest,
  type DiagnosticTraceContext,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, expect, test } from "vitest";
import {
  type CapturedLogRecord,
  type CapturedSpan,
  startLocalOtlpReceiver,
} from "../../../test/e2e/qa-lab/runtime/otel-test-support.js";
import { createDiagnosticsOtelService } from "./service.js";
import { createOtelContext, emitRealSdkSignals, startOtelService } from "./service.test-helpers.js";

const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
const OWNERSHIP_ENV_KEYS = [
  PRELOAD_ENV,
  "OTEL_SDK_DISABLED",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_LOG_LEVEL",
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

function registeredOtelGlobals(): OtelGlobalRegistrations | undefined {
  return (globalThis as unknown as Record<symbol, OtelGlobalRegistrations | undefined>)[
    OTEL_GLOBAL_API_KEY
  ];
}

function registeredOtelLogs(): unknown {
  return (globalThis as unknown as Record<symbol, unknown>)[OTEL_GLOBAL_LOGS_KEY];
}

const ORIGINAL_ENV = Object.fromEntries(
  OWNERSHIP_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof OWNERSHIP_ENV_KEYS)[number], string | undefined>;
const ORIGINAL_GLOBALS = { ...registeredOtelGlobals() };
const ORIGINAL_LOGS_PROVIDER = Object.hasOwn(globalThis, OTEL_GLOBAL_LOGS_KEY)
  ? logs.getLoggerProvider()
  : undefined;

function releaseOtelGlobals() {
  context.disable();
  metrics.disable();
  propagation.disable();
  trace.disable();
  logs.disable();
  for (const key of OWNERSHIP_ENV_KEYS) {
    delete process.env[key];
  }
}

function assertCorrelatedGeneration(
  spans: CapturedSpan[],
  logRecords: CapturedLogRecord[],
  logTrace: DiagnosticTraceContext,
): void {
  const run = spans.find((span) => span.name === "openclaw.run");
  const model = spans.find((span) => span.name === "openclaw.model.call");
  const correlatedLog = logRecords.find(
    (record) => record.traceId === logTrace.traceId && record.spanId === logTrace.spanId,
  );
  expect(run?.traceId).toBeTruthy();
  expect(run?.spanId).toBeTruthy();
  expect(model?.traceId).toBe(run?.traceId);
  expect(model?.parentSpanId).toBe(run?.spanId);
  expect(correlatedLog).toBeDefined();
}

afterEach(() => {
  releaseOtelGlobals();
  if (ORIGINAL_GLOBALS.context) {
    context.setGlobalContextManager(ORIGINAL_GLOBALS.context);
  }
  if (ORIGINAL_GLOBALS.propagation) {
    propagation.setGlobalPropagator(ORIGINAL_GLOBALS.propagation);
  }
  if (ORIGINAL_GLOBALS.metrics) {
    metrics.setGlobalMeterProvider(ORIGINAL_GLOBALS.metrics);
  }
  if (ORIGINAL_GLOBALS.trace) {
    trace.setGlobalTracerProvider(ORIGINAL_GLOBALS.trace);
  }
  if (ORIGINAL_LOGS_PROVIDER) {
    logs.setGlobalLoggerProvider(ORIGINAL_LOGS_PROVIDER);
  }
  diag.disable();
  if (ORIGINAL_GLOBALS.diag) {
    diag.setLogger(ORIGINAL_GLOBALS.diag, {
      logLevel: DiagLogLevel.ALL,
      suppressOverrideMessage: true,
    });
  }
  for (const key of OWNERSHIP_ENV_KEYS) {
    const value = ORIGINAL_ENV[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetDiagnosticEventsForTest();
});

function captureOtelDiagnostics(): string[] {
  const messages: string[] = [];
  const capture = (...args: unknown[]) => {
    messages.push(args.map((value) => String(value)).join(" "));
  };
  diag.setLogger(
    {
      debug: () => {},
      error: capture,
      info: () => {},
      verbose: () => {},
      warn: capture,
    },
    { logLevel: DiagLogLevel.ALL, suppressOverrideMessage: true },
  );
  return messages;
}

test.each(["replacement instance", "retained instance"])(
  "flushes each private generation with a %s and leaves global providers untouched",
  async (mode) => {
    const receiverA = startLocalOtlpReceiver();
    const receiverB = startLocalOtlpReceiver();
    const portA = await receiverA.listen();
    const portB = await receiverB.listen();
    releaseOtelGlobals();
    const globalProviders = {
      logs: registeredOtelLogs(),
      metrics: registeredOtelGlobals()?.metrics,
      trace: registeredOtelGlobals()?.trace,
    };
    const serviceA = createDiagnosticsOtelService();
    const serviceB = mode === "retained instance" ? serviceA : createDiagnosticsOtelService();
    const ctxA = createOtelContext(`http://127.0.0.1:${portA}`, {
      traces: true,
      metrics: true,
      logs: true,
    });
    const ctxB = createOtelContext(`http://127.0.0.1:${portB}`, {
      traces: true,
      metrics: true,
      logs: true,
    });
    ctxA.config.diagnostics!.otel!.flushIntervalMs = 60_000;
    ctxB.config.diagnostics!.otel!.flushIntervalMs = 60_000;

    try {
      await serviceA.start(ctxA);
      const traceA = await emitRealSdkSignals("generation-a");
      await serviceA.stop?.(ctxA);
      const aRequestsAfterStop = receiverA.capturedRequests.length;

      expect(new Set(receiverA.capturedRequests.map((request) => request.signal))).toEqual(
        new Set(["traces", "metrics", "logs"]),
      );
      expect(receiverA.capturedMetrics.length).toBeGreaterThan(0);
      assertCorrelatedGeneration(receiverA.capturedSpans, receiverA.capturedLogRecords, traceA);
      expect(registeredOtelGlobals()?.trace).toBe(globalProviders.trace);
      expect(registeredOtelGlobals()?.metrics).toBe(globalProviders.metrics);
      expect(registeredOtelLogs()).toBe(globalProviders.logs);

      await emitRealSdkSignals("after-a-stop");
      await waitForDiagnosticEventsDrained();
      await sleep(50);
      expect(receiverA.capturedRequests).toHaveLength(aRequestsAfterStop);

      await serviceB.start(ctxB);
      const traceB = await emitRealSdkSignals("generation-b");
      await serviceB.stop?.(ctxB);
      const bRequestsAfterStop = receiverB.capturedRequests.length;

      expect(receiverA.capturedRequests).toHaveLength(aRequestsAfterStop);
      expect(new Set(receiverB.capturedRequests.map((request) => request.signal))).toEqual(
        new Set(["traces", "metrics", "logs"]),
      );
      expect(receiverB.capturedMetrics.length).toBeGreaterThan(0);
      assertCorrelatedGeneration(receiverB.capturedSpans, receiverB.capturedLogRecords, traceB);
      expect(registeredOtelGlobals()?.trace).toBe(globalProviders.trace);
      expect(registeredOtelGlobals()?.metrics).toBe(globalProviders.metrics);
      expect(registeredOtelLogs()).toBe(globalProviders.logs);

      await emitRealSdkSignals("after-b-stop");
      await waitForDiagnosticEventsDrained();
      await sleep(50);
      expect(receiverB.capturedRequests).toHaveLength(bRequestsAfterStop);
    } finally {
      await serviceA.stop?.(ctxA);
      await serviceB.stop?.(ctxB);
      await receiverA.close();
      await receiverB.close();
    }
  },
  30_000,
);

test("keeps preloaded host providers live and owned by the host after plugin stop", async () => {
  releaseOtelGlobals();
  process.env[PRELOAD_ENV] = "1";
  const externalContextManager = new AsyncLocalStorageContextManager().enable();
  const externalPropagator = new W3CTraceContextPropagator();
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricProvider = new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: metricExporter,
        exportIntervalMillis: 60_000,
      }),
    ],
  });
  const logExporter = new InMemoryLogRecordExporter();
  const loggerProvider = new LoggerProvider({
    processors: [new SimpleLogRecordProcessor({ exporter: logExporter })],
  });
  expect(context.setGlobalContextManager(externalContextManager)).toBe(true);
  expect(propagation.setGlobalPropagator(externalPropagator)).toBe(true);
  expect(trace.setGlobalTracerProvider(tracerProvider)).toBe(true);
  expect(metrics.setGlobalMeterProvider(metricProvider)).toBe(true);
  logs.setGlobalLoggerProvider(loggerProvider);
  const hostOwners = {
    context: registeredOtelGlobals()?.context,
    logs: logs.getLoggerProvider(),
    metrics: registeredOtelGlobals()?.metrics,
    propagation: registeredOtelGlobals()?.propagation,
    trace: registeredOtelGlobals()?.trace,
  };
  const { service, ctx } = await startOtelService({
    traces: true,
    metrics: true,
    logs: false,
  });
  const emitHostSignals = (generation: string) => {
    trace.getTracer("host-preloaded").startSpan(`host-${generation}`).end();
    metrics
      .getMeter("host-preloaded")
      .createCounter("host.preloaded.counter")
      .add(1, { generation });
    logs.getLogger("host-preloaded").emit({
      body: `host-${generation}`,
      severityText: "INFO",
    });
  };

  try {
    expect({
      context: registeredOtelGlobals()?.context,
      logs: logs.getLoggerProvider(),
      metrics: registeredOtelGlobals()?.metrics,
      propagation: registeredOtelGlobals()?.propagation,
      trace: registeredOtelGlobals()?.trace,
    }).toEqual(hostOwners);
    emitHostSignals("before-stop");
    await Promise.all([
      tracerProvider.forceFlush(),
      metricProvider.forceFlush(),
      loggerProvider.forceFlush(),
    ]);

    const incoming = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    };
    const extracted = propagation.extract(ROOT_CONTEXT, incoming);
    const outgoing: Record<string, string> = {};
    await context.with(extracted, async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      propagation.inject(context.active(), outgoing);
    });
    expect(outgoing).toEqual(incoming);

    await service.stop?.(ctx);
    expect({
      context: registeredOtelGlobals()?.context,
      logs: logs.getLoggerProvider(),
      metrics: registeredOtelGlobals()?.metrics,
      propagation: registeredOtelGlobals()?.propagation,
      trace: registeredOtelGlobals()?.trace,
    }).toEqual(hostOwners);
    emitHostSignals("after-stop");
    await Promise.all([
      tracerProvider.forceFlush(),
      metricProvider.forceFlush(),
      loggerProvider.forceFlush(),
    ]);

    expect(spanExporter.getFinishedSpans().map((span) => span.name)).toEqual([
      "host-before-stop",
      "host-after-stop",
    ]);
    expect(
      metricExporter
        .getMetrics()
        .flatMap((resourceMetrics) => resourceMetrics.scopeMetrics)
        .flatMap((scopeMetrics) => scopeMetrics.metrics)
        .map((metric) => metric.descriptor.name),
    ).toContain("host.preloaded.counter");
    expect(logExporter.getFinishedLogRecords().map((record) => record.body)).toEqual([
      "host-before-stop",
      "host-after-stop",
    ]);
  } finally {
    await service.stop?.(ctx);
    await loggerProvider.shutdown();
    await metricProvider.shutdown();
    await tracerProvider.shutdown();
  }
}, 30_000);

test("leaves OTEL_LOG_LEVEL and the process diagnostic logger under host ownership", async () => {
  releaseOtelGlobals();
  const messages = captureOtelDiagnostics();
  const hostDiagOwner = registeredOtelGlobals()?.diag;
  process.env.OTEL_LOG_LEVEL = "debug";
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  const { service, ctx } = await startOtelService({
    endpoint: `http://127.0.0.1:${port}`,
    traces: true,
  });

  try {
    await emitRealSdkSignals("diag-owner");
    await service.stop?.(ctx);
    expect(registeredOtelGlobals()?.diag).toBe(hostDiagOwner);
    diag.warn("host diagnostic logger remains active");
    expect(messages).toContain("host diagnostic logger remains active");
  } finally {
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 30_000);
