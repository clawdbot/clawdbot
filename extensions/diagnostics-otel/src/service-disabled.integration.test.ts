// Real dependency proof for the OTEL_SDK_DISABLED admission boundary. The unit suite
// mocks OpenTelemetry constructors; these cases exercise public global APIs and a receiver.
import { context, metrics, propagation, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  emitTrustedDiagnosticEventWithPrivateData,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { startLocalOtlpReceiver } from "../../../test/e2e/qa-lab/runtime/otel-test-support.js";
import {
  getReportedExporterHealth,
  startOtelService,
  stopStartedOtelServices,
} from "./service.test-helpers.js";

const ENV_KEYS = ["OPENCLAW_OTEL_PRELOADED", "OTEL_PROPAGATORS", "OTEL_SDK_DISABLED"] as const;
const OTEL_GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");

type OtelGlobalRegistrations = {
  context?: Parameters<typeof context.setGlobalContextManager>[0];
  propagation?: Parameters<typeof propagation.setGlobalPropagator>[0];
};

let originalEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let originalGlobals: OtelGlobalRegistrations;

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
  context.disable();
  propagation.disable();
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
  if (currentGlobals?.context !== originalGlobals.context) {
    context.disable();
    if (originalGlobals.context) {
      context.setGlobalContextManager(originalGlobals.context);
    }
  }
  restoreEnv();
  resetDiagnosticEventsForTest();
});

async function emitOpenClawSignals() {
  trace.getTracer("openclaw-otel-disabled-test").startSpan("disabled-test").end();
  metrics.getMeter("openclaw-otel-disabled-test").createCounter("disabled.test").add(1);
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "log.record",
      level: "INFO",
      message: "disabled route test",
    },
    {},
  );
  await waitForDiagnosticEventsDrained();
}

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
    await emitOpenClawSignals();
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

test("does not remove context and propagation globals installed after startup", async () => {
  process.env.OTEL_SDK_DISABLED = "true";
  const { service, ctx } = await startOtelService();

  context.disable();
  propagation.disable();
  const externalContextManager = new AsyncLocalStorageContextManager().enable();
  expect(context.setGlobalContextManager(externalContextManager)).toBe(true);
  expect(propagation.setGlobalPropagator(new W3CTraceContextPropagator())).toBe(true);
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

test("honors OTEL_PROPAGATORS=none while disabled", async () => {
  process.env.OTEL_SDK_DISABLED = "true";
  process.env.OTEL_PROPAGATORS = "NoNe";
  const { service, ctx } = await startOtelService();

  try {
    expect(propagation.fields()).toEqual([]);
  } finally {
    await service.stop?.(ctx);
  }
  expect(propagation.fields()).toEqual([]);
});

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
