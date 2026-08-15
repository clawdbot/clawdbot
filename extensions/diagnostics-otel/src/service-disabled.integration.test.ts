// Real dependency proof for the OTEL_SDK_DISABLED admission boundary. The unit suite
// mocks OpenTelemetry constructors; these cases exercise public global APIs and a receiver.
import { context, metrics, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resetDiagnosticEventsForTest } from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startLocalOtlpReceiver } from "../../../test/e2e/qa-lab/runtime/otel-test-support.js";
import {
  emitRealSdkSignals,
  getReportedExporterHealth,
  startOtelService,
  stopStartedOtelServices,
} from "./service.test-helpers.js";

const ENV_KEYS = ["OPENCLAW_OTEL_PRELOADED", "OTEL_PROPAGATORS", "OTEL_SDK_DISABLED"] as const;
const OTEL_GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");
const OTEL_GLOBAL_LOGS_KEY = Symbol.for("io.opentelemetry.js.api.logs");
const JAEGER_DEPRECATION_WARNING =
  'The Jaeger propagator is deprecated and will be removed in a future release. Use the W3C TraceContext propagator ("tracecontext") instead.';
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN_ID = "00f067aa0ba902b7";
const PROPAGATED_SPAN_CONTEXT = {
  traceId: TRACE_ID,
  spanId: SPAN_ID,
  traceFlags: 1,
  isRemote: true,
} as const;
const PROPAGATION_ROUNDTRIP_CASES = [
  {
    label: "W3C",
    value: "tracecontext",
    incoming: { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` },
    outgoing: { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` },
  },
  {
    label: "B3",
    value: "b3",
    incoming: { b3: `${TRACE_ID}-${SPAN_ID}-1` },
    outgoing: { b3: `${TRACE_ID}-${SPAN_ID}-1` },
  },
  {
    label: "B3MULTI",
    value: "b3multi",
    incoming: {
      "x-b3-traceid": TRACE_ID,
      "x-b3-spanid": SPAN_ID,
      "x-b3-sampled": "1",
    },
    outgoing: {
      "x-b3-traceid": TRACE_ID,
      "x-b3-spanid": SPAN_ID,
      "x-b3-sampled": "1",
    },
  },
  {
    label: "Jaeger",
    value: "jaeger",
    incoming: { "uber-trace-id": `${TRACE_ID}:${SPAN_ID}:0:1` },
    outgoing: { "uber-trace-id": `${TRACE_ID}:${SPAN_ID}:0:01` },
  },
] as const;

type OtelGlobalRegistrations = {
  context?: Parameters<typeof context.setGlobalContextManager>[0];
  metrics?: Parameters<typeof metrics.setGlobalMeterProvider>[0];
  propagation?: Parameters<typeof propagation.setGlobalPropagator>[0];
  trace?: Parameters<typeof trace.setGlobalTracerProvider>[0];
};

let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let originalGlobals: OtelGlobalRegistrations;
let originalLogsProvider: ReturnType<typeof logs.getLoggerProvider> | undefined;

function registeredOtelGlobals(): OtelGlobalRegistrations | undefined {
  return (globalThis as unknown as Record<symbol, OtelGlobalRegistrations | undefined>)[
    OTEL_GLOBAL_API_KEY
  ];
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof ENV_KEYS)[number],
    string | undefined
  >;
  originalGlobals = { ...registeredOtelGlobals() };
  originalLogsProvider = Object.hasOwn(globalThis, OTEL_GLOBAL_LOGS_KEY)
    ? logs.getLoggerProvider()
    : undefined;
  context.disable();
  logs.disable();
  metrics.disable();
  propagation.disable();
  trace.disable();
  process.env.OPENCLAW_OTEL_PRELOADED = "0";
  delete process.env.OTEL_PROPAGATORS;
  delete process.env.OTEL_SDK_DISABLED;
});

afterEach(async () => {
  await stopStartedOtelServices();
  const currentGlobals = registeredOtelGlobals();
  if (currentGlobals?.propagation !== originalGlobals.propagation) {
    propagation.disable();
    if (originalGlobals.propagation) {
      propagation.setGlobalPropagator(originalGlobals.propagation);
    }
  }
  if (currentGlobals?.metrics !== originalGlobals.metrics) {
    metrics.disable();
    if (originalGlobals.metrics) {
      metrics.setGlobalMeterProvider(originalGlobals.metrics);
    }
  }
  if (currentGlobals?.trace !== originalGlobals.trace) {
    trace.disable();
    if (originalGlobals.trace) {
      trace.setGlobalTracerProvider(originalGlobals.trace);
    }
  }
  if (Object.hasOwn(globalThis, OTEL_GLOBAL_LOGS_KEY) || originalLogsProvider) {
    logs.disable();
    if (originalLogsProvider) {
      logs.setGlobalLoggerProvider(originalLogsProvider);
    }
  }
  if (currentGlobals?.context !== originalGlobals.context) {
    context.disable();
    if (originalGlobals.context) {
      context.setGlobalContextManager(originalGlobals.context);
    }
  }
  restoreEnv();
  resetDiagnosticEventsForTest();
});

test("disables every OpenClaw route while preserving W3C propagation", async () => {
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  const stdoutWrites: string[] = [];
  const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdoutWrites.push(String(chunk));
    return true;
  });
  process.env.OTEL_SDK_DISABLED = " TrUe ";
  const { service, ctx } = await startOtelService({
    endpoint: `http://127.0.0.1:${port}`,
    traces: true,
    metrics: true,
    logs: true,
    logsExporter: "both",
  });

  try {
    await emitRealSdkSignals();
    const incoming = {
      baggage: "tenant=example",
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    };
    const extracted = propagation.extract(ROOT_CONTEXT, incoming);
    expect(trace.getSpanContext(extracted)).toMatchObject({
      traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      spanId: "00f067aa0ba902b7",
      traceFlags: 1,
    });
    expect(propagation.getBaggage(extracted)?.getEntry("tenant")?.value).toBe("example");
    const outgoing: Record<string, string> = {};
    await context.with(extracted, async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(trace.getSpanContext(context.active())).toMatchObject({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: 1,
      });
      expect(propagation.getBaggage(context.active())?.getEntry("tenant")?.value).toBe("example");
      propagation.inject(context.active(), outgoing);
    });
    expect(outgoing).toEqual(incoming);
    expect(getReportedExporterHealth(ctx)).toEqual([]);

    ctx.config.diagnostics!.enabled = false;
    await service.start(ctx);
    expect(context.with(extracted, () => trace.getSpanContext(context.active()))).toBeUndefined();
    expect(propagation.fields()).toEqual([]);
    expect(receiver.capturedRequests).toEqual([]);
  } finally {
    stdoutWrite.mockRestore();
    await service.stop?.(ctx);
    await receiver.close();
  }
  expect(stdoutWrites).toEqual([]);
}, 30_000);

test("preserves externally owned context and propagation globals while disabled", async () => {
  const externalContextManager = new AsyncLocalStorageContextManager().enable();
  expect(context.setGlobalContextManager(externalContextManager)).toBe(true);
  expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true);
  process.env.OTEL_SDK_DISABLED = "true";
  const { service, ctx } = await startOtelService();
  const incoming = {
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  };
  const extracted = propagation.extract(ROOT_CONTEXT, incoming);

  await service.stop?.(ctx);

  expect(propagation.fields()).toEqual(["traceparent", "tracestate"]);
  await context.with(extracted, async () => {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(trace.getSpanContext(context.active())?.traceId).toBe(
      "4bf92f3577b34da6a3ce929d0e0e4736",
    );
  });
});

test.each(["true", "false"] as const)(
  "does not remove replacement context and propagation owners when disabled=$disabled",
  async (disabled) => {
    process.env.OTEL_SDK_DISABLED = disabled;
    const { service, ctx } = await startOtelService({
      traces: false,
      metrics: false,
      logs: false,
    });
    const capturedContext = context.active();

    context.disable();
    propagation.disable();
    const externalContextManager = new AsyncLocalStorageContextManager().enable();
    expect(context.setGlobalContextManager(externalContextManager)).toBe(true);
    expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true);
    const incoming = {
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
    };
    const extracted = propagation.extract(ROOT_CONTEXT, incoming);

    await context.with(capturedContext, () => service.stop?.(ctx));

    expect(propagation.fields()).toEqual(["traceparent", "tracestate"]);
    await context.with(extracted, async () => {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(trace.getSpanContext(context.active())?.traceId).toBe(
        "4bf92f3577b34da6a3ce929d0e0e4736",
      );
    });
  },
);

test.each([
  {
    value: "tracecontext,baggage",
    fields: ["traceparent", "tracestate", "baggage"],
  },
  {
    value: "B3",
    fields: ["b3"],
  },
  {
    value: "B3MULTI",
    fields: ["x-b3-traceid", "x-b3-spanid", "x-b3-flags", "x-b3-sampled", "x-b3-parentspanid"],
  },
  {
    value: "JaEgEr",
    fields: ["uber-trace-id"],
    warning: JAEGER_DEPRECATION_WARNING,
  },
  {
    value: "NoNe",
    fields: [],
  },
  {
    value: "unavailable",
    fields: [],
    warning: 'Propagator "unavailable" requested through environment variable is unavailable.',
  },
] as const)(
  "configures OTEL_PROPAGATORS=$value and reports dependency warnings visibly",
  async ({ value, fields, warning }) => {
    process.env.OTEL_SDK_DISABLED = "true";
    process.env.OTEL_PROPAGATORS = value;
    const { service, ctx } = await startOtelService();

    try {
      expect(propagation.fields()).toEqual(fields);
      if (warning) {
        expect(ctx.logger.warn).toHaveBeenCalledWith(warning);
      } else {
        expect(ctx.logger.warn).not.toHaveBeenCalled();
      }
    } finally {
      await service.stop?.(ctx);
    }
    expect(propagation.fields()).toEqual([]);
  },
);

test.each(PROPAGATION_ROUNDTRIP_CASES)(
  "retains and roundtrips $label propagation across async context",
  async ({ value, incoming, outgoing: expectedOutgoing }) => {
    process.env.OTEL_SDK_DISABLED = "true";
    process.env.OTEL_PROPAGATORS = value;
    const { service, ctx } = await startOtelService();

    try {
      const extracted = propagation.extract(ROOT_CONTEXT, incoming);
      expect(trace.getSpanContext(extracted)).toEqual(PROPAGATED_SPAN_CONTEXT);

      const outgoing: Record<string, string> = {};
      await context.with(extracted, async () => {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(trace.getSpanContext(context.active())).toEqual(PROPAGATED_SPAN_CONTEXT);
        propagation.inject(context.active(), outgoing);
      });

      expect(outgoing).toEqual(expectedOutgoing);
      expect(trace.getSpanContext(propagation.extract(ROOT_CONTEXT, outgoing))).toEqual(
        PROPAGATED_SPAN_CONTEXT,
      );
    } finally {
      await service.stop?.(ctx);
    }
  },
);

test("cleans disabled ownership before a fresh enabled private-provider generation", async () => {
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  process.env.OTEL_SDK_DISABLED = "true";
  const disabled = await startOtelService({
    endpoint: `http://127.0.0.1:${port}`,
    traces: true,
    metrics: true,
    logs: true,
    logsExporter: "otlp",
  });

  try {
    expect(propagation.fields()).toEqual(["traceparent", "tracestate", "baggage"]);
    await disabled.service.stop?.(disabled.ctx);
    process.env.OTEL_SDK_DISABLED = "false";
    const enabled = await startOtelService({
      endpoint: `http://127.0.0.1:${port}`,
      traces: true,
      metrics: true,
      logs: true,
      logsExporter: "otlp",
    });
    expect(enabled.service).not.toBe(disabled.service);
    expect(propagation.fields()).toEqual(["traceparent", "tracestate", "baggage"]);
    await emitRealSdkSignals("enabled-generation");
    await enabled.service.stop?.(enabled.ctx);

    expect(new Set(receiver.capturedRequests.map((request) => request.signal))).toEqual(
      new Set(["traces", "metrics", "logs"]),
    );
  } finally {
    await disabled.service.stop?.(disabled.ctx);
    await receiver.close();
  }
}, 30_000);

test("warns through the plugin logger for an invalid disabled value", async () => {
  process.env.OTEL_SDK_DISABLED = "invalid";
  const loggerProviderBefore = logs.getLoggerProvider();
  const { service, ctx } = await startOtelService({
    traces: false,
    metrics: false,
    logs: false,
  });

  try {
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "diagnostics-otel: invalid OTEL_SDK_DISABLED value; expected true or false, using false",
    );
    expect(logs.getLoggerProvider()).toBe(loggerProviderBefore);
  } finally {
    await service.stop?.(ctx);
  }
});
