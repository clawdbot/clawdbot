import {
  context,
  createContextKey,
  metrics,
  propagation,
  ROOT_CONTEXT,
  trace,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, W3CTraceContextPropagator } from "@opentelemetry/core";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startLocalOtlpReceiver } from "../../../test/e2e/qa-lab/runtime/otel-test-support.js";
import { OpenClawOtelSdk } from "./service-sdk.js";
import { createDiagnosticsOtelService } from "./service.js";
import { createOtelContext, getReportedExporterHealth } from "./service.test-helpers.js";

const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
const ENV_KEYS = [
  PRELOAD_ENV,
  "OTEL_SDK_DISABLED",
  "OTEL_PROPAGATORS",
  "OTEL_NODE_RESOURCE_DETECTORS",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY",
] as const;
const OTEL_GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");
const OTEL_GLOBAL_LOGS_KEY = Symbol.for("io.opentelemetry.js.api.logs");
const ASYNC_CONTEXT_KEY = createContextKey("openclaw.otel.lifecycle-test");

type OtelGlobalRegistrations = {
  context?: Parameters<typeof context.setGlobalContextManager>[0];
  metrics?: Parameters<typeof metrics.setGlobalMeterProvider>[0];
  propagation?: Parameters<typeof propagation.setGlobalPropagator>[0];
  trace?: Parameters<typeof trace.setGlobalTracerProvider>[0];
};
type Service = ReturnType<typeof createDiagnosticsOtelService>;
type ServiceContext = Parameters<Service["start"]>[0];
type Receiver = ReturnType<typeof startLocalOtlpReceiver>;

let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let originalGlobals: OtelGlobalRegistrations;
let originalLogsProvider: ReturnType<typeof logs.getLoggerProvider> | undefined;
const receivers = new Set<Receiver>();
const services: Array<{ ctx: ServiceContext; service: Service }> = [];
const providerShutdowns: Array<() => Promise<void>> = [];

function registeredOtelGlobals(): OtelGlobalRegistrations | undefined {
  return (globalThis as unknown as Record<symbol, OtelGlobalRegistrations | undefined>)[
    OTEL_GLOBAL_API_KEY
  ];
}

async function openReceiver() {
  const receiver = startLocalOtlpReceiver();
  receivers.add(receiver);
  const port = await receiver.listen();
  return { endpoint: `http://127.0.0.1:${port}`, receiver };
}

async function startService(service: Service, ctx: ServiceContext): Promise<void> {
  services.push({ service, ctx });
  await service.start(ctx);
}

function emitSdkSignals(label: string): void {
  trace.getTracer("openclaw-otel-lifecycle-test").startSpan(label).end();
  metrics
    .getMeter("openclaw-otel-lifecycle-test")
    .createCounter(`openclaw.lifecycle.${label.replaceAll("-", "_")}`)
    .add(1);
}

async function emitDiagnosticLog(): Promise<void> {
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "log.record",
      level: "INFO",
      message: "disabled lifecycle log",
    },
    {},
  );
  await waitForDiagnosticEventsDrained();
}

async function expectAsyncContext(): Promise<void> {
  const active = ROOT_CONTEXT.setValue(ASYNC_CONTEXT_KEY, "active");
  await context.with(active, async () => {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(context.active().getValue(ASYNC_CONTEXT_KEY)).toBe("active");
  });
}

async function expectNoAsyncContext(): Promise<void> {
  const active = ROOT_CONTEXT.setValue(ASYNC_CONTEXT_KEY, "inactive");
  await context.with(active, async () => {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(context.active().getValue(ASYNC_CONTEXT_KEY)).toBeUndefined();
  });
}

async function expectW3cPropagation(): Promise<void> {
  const incoming = {
    baggage: "tenant=example",
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
  expect(outgoing).toMatchObject(incoming);
}

function installExternalGlobals() {
  const contextManager = new AsyncLocalStorageContextManager().enable();
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const meterProvider = new MeterProvider();
  const ownerTracer = tracerProvider.getTracer("external-owner");
  expect(context.setGlobalContextManager(contextManager)).toBe(true);
  expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true);
  expect(trace.setGlobalTracerProvider(tracerProvider)).toBe(true);
  expect(metrics.setGlobalMeterProvider(meterProvider)).toBe(true);
  providerShutdowns.push(async () => {
    await Promise.all([tracerProvider.shutdown(), meterProvider.shutdown()]);
  });
  return { meterProvider, ownerTracer, spanExporter };
}

beforeEach(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof ENV_KEYS)[number],
    string | undefined
  >;
  for (const key of ENV_KEYS) {
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
  resetDiagnosticEventsForTest();
});

afterEach(async () => {
  for (const { service, ctx } of services.toReversed()) {
    await service.stop?.(ctx);
  }
  services.length = 0;
  for (const shutdown of providerShutdowns.splice(0).toReversed()) {
    await shutdown();
  }
  for (const receiver of receivers) {
    await receiver.close();
  }
  receivers.clear();
  context.disable();
  logs.disable();
  metrics.disable();
  propagation.disable();
  trace.disable();
  if (originalGlobals.context) {
    context.setGlobalContextManager(originalGlobals.context);
  }
  if (originalGlobals.metrics) {
    metrics.setGlobalMeterProvider(originalGlobals.metrics);
  }
  if (originalGlobals.propagation) {
    propagation.setGlobalPropagator(originalGlobals.propagation);
  }
  if (originalGlobals.trace) {
    trace.setGlobalTracerProvider(originalGlobals.trace);
  }
  if (originalLogsProvider) {
    logs.setGlobalLoggerProvider(originalLogsProvider);
  }
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetDiagnosticEventsForTest();
  vi.restoreAllMocks();
});

test("replaces enabled SDK generations and exports through the current provider", async () => {
  const first = await openReceiver();
  const second = await openReceiver();
  const service = createDiagnosticsOtelService();
  const firstCtx = createOtelContext(first.endpoint, { traces: true, metrics: true });
  const secondCtx = createOtelContext(second.endpoint, { traces: true, metrics: true });

  await startService(service, firstCtx);
  emitSdkSignals("generation-one");
  await startService(service, secondCtx);
  emitSdkSignals("generation-two");
  await service.stop?.(secondCtx);

  expect(first.receiver.capturedSpans.map((span) => span.name)).toContain("generation-one");
  expect(first.receiver.capturedSpans.map((span) => span.name)).not.toContain("generation-two");
  expect(second.receiver.capturedSpans.map((span) => span.name)).toContain("generation-two");
  expect(first.receiver.capturedMetrics.map((metric) => metric.name)).toContain(
    "openclaw.lifecycle.generation_one",
  );
  expect(second.receiver.capturedMetrics.map((metric) => metric.name)).toContain(
    "openclaw.lifecycle.generation_two",
  );
  expect(propagation.fields()).toEqual([]);
});

test("keeps async context installed while span processors flush", async () => {
  let activeDuringExport: unknown;
  const exporter: SpanExporter = {
    export(_spans, resultCallback) {
      activeDuringExport = context.active().getValue(ASYNC_CONTEXT_KEY);
      resultCallback({ code: ExportResultCode.SUCCESS });
    },
    async shutdown() {},
  };
  const sdk = new OpenClawOtelSdk({
    spanProcessors: [
      new BatchSpanProcessor(exporter, {
        scheduledDelayMillis: 60_000,
      }),
    ],
  });
  sdk.start();
  trace.getTracer("flush-context-test").startSpan("flush-context").end();

  await context.with(ROOT_CONTEXT.setValue(ASYNC_CONTEXT_KEY, "flush-active"), async () => {
    sdk.unregisterSignalGlobals();
    await sdk.shutdown();
    expect(activeDuringExport).toBe("flush-active");
    sdk.unregisterContextGlobals();
  });
  expect(propagation.fields()).toEqual([]);
});

test.each([
  { detectors: undefined, expected: true },
  { detectors: "none", expected: false },
  { detectors: "env", expected: true },
])("honors OTEL_NODE_RESOURCE_DETECTORS=$detectors", async ({ detectors, expected }) => {
  if (detectors) {
    process.env.OTEL_NODE_RESOURCE_DETECTORS = detectors;
  }
  process.env.OTEL_RESOURCE_ATTRIBUTES = "openclaw.lifecycle.detector=enabled";
  let resourceAttributes: Readonly<Record<string, unknown>> = {};
  let resolveExport!: () => void;
  let rejectExport!: (error: unknown) => void;
  const exported = new Promise<void>((resolve, reject) => {
    resolveExport = resolve;
    rejectExport = reject;
  });
  const exporter: SpanExporter = {
    export(spans, resultCallback) {
      const resource = spans[0]?.resource;
      if (!resource) {
        const error = new Error("expected exported span resource");
        resultCallback({ code: ExportResultCode.FAILED, error });
        rejectExport(error);
        return;
      }
      void Promise.resolve(resource.waitForAsyncAttributes?.()).then(
        () => {
          resourceAttributes = resource.attributes;
          resultCallback({ code: ExportResultCode.SUCCESS });
          resolveExport();
        },
        (cause: unknown) => {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          resultCallback({ code: ExportResultCode.FAILED, error });
          rejectExport(error);
        },
      );
    },
    async shutdown() {},
  };
  const sdk = new OpenClawOtelSdk({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  sdk.start();
  trace
    .getTracer(`resource-detector-test-${detectors ?? "default"}`)
    .startSpan("resource-detector")
    .end();
  await exported;
  sdk.unregisterSignalGlobals();
  await sdk.shutdown();
  sdk.unregisterContextGlobals();

  if (expected) {
    expect(resourceAttributes).toHaveProperty("openclaw.lifecycle.detector", "enabled");
  } else {
    expect(resourceAttributes).not.toHaveProperty("openclaw.lifecycle.detector");
  }
});

test("switches enabled to disabled with no signal, health, listener, or stdout route", async () => {
  const { endpoint, receiver } = await openReceiver();
  const service = createDiagnosticsOtelService();
  const enabledCtx = createOtelContext(endpoint, { traces: true, metrics: true });
  await startService(service, enabledCtx);
  emitSdkSignals("before-disabled");

  const stdoutWrites: string[] = [];
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  const onEvent = vi.fn();
  process.env.OTEL_SDK_DISABLED = " TrUe ";
  process.env.OTEL_PROPAGATORS = "none";
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
  process.env.OTEL_EXPORTER_OTLP_CERTIFICATE = "/missing/otel-ca.pem";
  const disabledCtx = createOtelContext("not a collector URL", {
    traces: true,
    metrics: true,
    logs: true,
    logsExporter: "both",
  });
  disabledCtx.internalDiagnostics = { ...disabledCtx.internalDiagnostics!, onEvent };

  await startService(service, disabledCtx);
  const requestsAfterTransition = receiver.capturedRequests.length;
  emitSdkSignals("while-disabled");
  await emitDiagnosticLog();
  await expectAsyncContext();

  expect(propagation.fields()).toEqual([]);
  expect(receiver.capturedRequests).toHaveLength(requestsAfterTransition);
  expect(getReportedExporterHealth(disabledCtx)).toEqual([]);
  expect(onEvent).not.toHaveBeenCalled();
  expect(disabledCtx.logger.warn).not.toHaveBeenCalled();
  expect(stdoutWrites).toEqual([]);
  stdoutWrite.mockRestore();
});

test("switches disabled to enabled after preserving propagation and async context", async () => {
  const { endpoint, receiver } = await openReceiver();
  const service = createDiagnosticsOtelService();
  process.env.OTEL_SDK_DISABLED = "true";
  const disabledCtx = createOtelContext("not a collector URL", {
    traces: true,
    metrics: true,
    logs: true,
  });
  await startService(service, disabledCtx);
  expect(propagation.fields()).toEqual(["traceparent", "tracestate", "baggage"]);
  await expectAsyncContext();
  await expectW3cPropagation();

  delete process.env.OTEL_SDK_DISABLED;
  const enabledCtx = createOtelContext(endpoint, { traces: true, metrics: true });
  await startService(service, enabledCtx);
  emitSdkSignals("after-disabled");
  await service.stop?.(enabledCtx);

  expect(receiver.capturedSpans.map((span) => span.name)).toContain("after-disabled");
  expect(receiver.capturedMetrics.map((metric) => metric.name)).toContain(
    "openclaw.lifecycle.after_disabled",
  );
});

test("host rollback releases a partially started generation before the next start", async () => {
  const { endpoint, receiver } = await openReceiver();
  const service = createDiagnosticsOtelService();
  const failedCtx = createOtelContext(endpoint, { traces: true, metrics: true });
  failedCtx.internalDiagnostics = {
    ...failedCtx.internalDiagnostics!,
    onEvent: () => {
      throw new Error("listener registration failed");
    },
  };

  services.push({ service, ctx: failedCtx });
  await expect(service.start(failedCtx)).rejects.toThrow("listener registration failed");
  await service.stop?.(failedCtx);
  expect(propagation.fields()).toEqual([]);

  const recoveredCtx = createOtelContext(endpoint, { traces: true, metrics: true });
  await startService(service, recoveredCtx);
  emitSdkSignals("after-rollback");
  await service.stop?.(recoveredCtx);

  expect(receiver.capturedSpans.map((span) => span.name)).toContain("after-rollback");
  expect(receiver.capturedMetrics.map((metric) => metric.name)).toContain(
    "openclaw.lifecycle.after_rollback",
  );
});

test("rolls back partial ownership when trace registration fails", async () => {
  const { endpoint } = await openReceiver();
  const externalTraceProvider = new BasicTracerProvider();
  const externalTracer = externalTraceProvider.getTracer("external-trace-owner");
  expect(trace.setGlobalTracerProvider(externalTraceProvider)).toBe(true);
  providerShutdowns.push(() => externalTraceProvider.shutdown());
  const originalMeterProvider = metrics.getMeterProvider();
  const service = createDiagnosticsOtelService();
  const ctx = createOtelContext(endpoint, { traces: true, metrics: true });
  services.push({ service, ctx });

  await expect(service.start(ctx)).rejects.toThrow(
    "diagnostics-otel could not register its global tracer provider",
  );
  await service.stop?.(ctx);

  expect(trace.getTracer("external-trace-owner")).toBe(externalTracer);
  expect(metrics.getMeterProvider()).toBe(originalMeterProvider);
  expect(propagation.fields()).toEqual([]);
  await expectNoAsyncContext();
});

test("keeps preloaded globals while all OpenClaw telemetry stays disabled", async () => {
  const external = installExternalGlobals();
  process.env[PRELOAD_ENV] = "1";
  process.env.OTEL_SDK_DISABLED = "true";
  const stdoutWrites: string[] = [];
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  const service = createDiagnosticsOtelService();
  const ctx = createOtelContext("not a collector URL", {
    traces: true,
    metrics: true,
    logs: true,
    logsExporter: "both",
  });
  const onEvent = vi.fn();
  ctx.internalDiagnostics = { ...ctx.internalDiagnostics!, onEvent };

  await startService(service, ctx);
  await emitDiagnosticLog();
  await service.stop?.(ctx);
  external.ownerTracer.startSpan("external-after-stop").end();

  expect(trace.getTracer("external-owner")).toBe(external.ownerTracer);
  expect(metrics.getMeterProvider()).toBe(external.meterProvider);
  expect(external.spanExporter.getFinishedSpans().map((span) => span.name)).toContain(
    "external-after-stop",
  );
  expect(getReportedExporterHealth(ctx)).toEqual([]);
  expect(onEvent).not.toHaveBeenCalled();
  expect(stdoutWrites).toEqual([]);
  stdoutWrite.mockRestore();
});

test("does not remove context, propagation, trace, or metrics replaced by the host", async () => {
  const { endpoint } = await openReceiver();
  const service = createDiagnosticsOtelService();
  const ctx = createOtelContext(endpoint, { traces: true, metrics: true });
  await startService(service, ctx);

  context.disable();
  metrics.disable();
  propagation.disable();
  trace.disable();
  const external = installExternalGlobals();
  await service.stop?.(ctx);

  expect(trace.getTracer("external-owner")).toBe(external.ownerTracer);
  expect(metrics.getMeterProvider()).toBe(external.meterProvider);
  expect(propagation.fields()).toEqual(["traceparent", "tracestate"]);
  await expectAsyncContext();
});

test.each([
  { value: " B3 ", fields: ["b3"] },
  {
    value: "b3MULTI",
    fields: ["x-b3-traceid", "x-b3-spanid", "x-b3-flags", "x-b3-sampled", "x-b3-parentspanid"],
  },
  { value: " JaEgEr ", fields: ["uber-trace-id"] },
  { value: "none", fields: [] },
])("honors OTEL_PROPAGATORS=$value while disabled", async ({ value, fields }) => {
  process.env.OTEL_SDK_DISABLED = "true";
  process.env.OTEL_PROPAGATORS = value;
  const service = createDiagnosticsOtelService();
  const ctx = createOtelContext("not a collector URL");
  await startService(service, ctx);

  expect(propagation.fields()).toEqual(fields);
  await expectAsyncContext();
});

test("warns through the plugin logger for an invalid disabled value", async () => {
  process.env.OTEL_SDK_DISABLED = "invalid";
  const service = createDiagnosticsOtelService();
  const ctx = createOtelContext("not a collector URL");
  await startService(service, ctx);

  expect(ctx.logger.warn).toHaveBeenCalledWith(
    "diagnostics-otel: invalid OTEL_SDK_DISABLED value; expected true or false, using false",
  );
});
