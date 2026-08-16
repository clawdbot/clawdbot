import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, expect, test } from "vitest";
import { startOtelServiceWithHostUsage, stopStartedOtelServices } from "./service.test-helpers.js";

const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
const OTEL_GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");

type OtelGlobalRegistrations = {
  trace?: Parameters<typeof trace.setGlobalTracerProvider>[0];
};

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let originalPreloaded: string | undefined;
let originalTraceProvider: OtelGlobalRegistrations["trace"];

function registeredOtelGlobals(): OtelGlobalRegistrations | undefined {
  return (globalThis as unknown as Record<symbol, OtelGlobalRegistrations | undefined>)[
    OTEL_GLOBAL_API_KEY
  ];
}

beforeEach(() => {
  originalPreloaded = process.env[PRELOAD_ENV];
  originalTraceProvider = registeredOtelGlobals()?.trace;
  if (originalTraceProvider) {
    trace.disable();
  }
  process.env[PRELOAD_ENV] = "1";
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await stopStartedOtelServices();
  await provider.shutdown();
  trace.disable();
  if (originalTraceProvider) {
    trace.setGlobalTracerProvider(originalTraceProvider);
  }
  if (originalPreloaded === undefined) {
    delete process.env[PRELOAD_ENV];
  } else {
    process.env[PRELOAD_ENV] = originalPreloaded;
  }
  resetDiagnosticEventsForTest();
});

test("adds plugin attribution only from trusted exporter-private provenance", async () => {
  const started = await startOtelServiceWithHostUsage();
  const { service, ctx } = started;

  started.emitHostPluginUsage(
    {
      type: "model.usage",
      provider: "openai",
      model: "gpt-5.5",
      usage: { input: 10, output: 4, total: 14 },
    },
    "llm-task",
  );
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.5",
    usage: { input: 2 },
    pluginId: "public-emitter-spoof",
  } as Parameters<typeof emitTrustedDiagnosticEvent>[0] & { pluginId: string });
  emitTrustedDiagnosticEvent({
    type: "model.usage",
    provider: "openai",
    model: "gpt-5.5",
    usage: { input: 3 },
  });
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "model.usage",
      provider: "openai",
      model: "gpt-5.5",
      usage: { input: 5 },
    },
    { hostPluginId: "private-data-spoof" } as Parameters<
      typeof emitTrustedDiagnosticEventWithPrivateData
    >[1] & { hostPluginId: string },
  );
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const usageSpans = exporter
    .getFinishedSpans()
    .filter((span) => span.name === "openclaw.model.usage");
  expect(usageSpans).toHaveLength(4);
  expect(usageSpans.map((span) => span.attributes["openclaw.plugin"])).toEqual([
    "llm-task",
    undefined,
    undefined,
    undefined,
  ]);
});
