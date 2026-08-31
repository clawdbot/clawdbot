import {
  context,
  diag,
  DiagLogLevel,
  metrics,
  propagation,
  type Tracer,
  trace,
  TraceFlags,
} from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, beforeEach, expect, test } from "vitest";

const OTEL_GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");
const OTEL_GLOBAL_LOGS_KEY = Symbol.for("io.opentelemetry.js.api.logs");
const ENV_KEYS = [
  "OTEL_ATTRIBUTE_COUNT_LIMIT",
  "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  "OTEL_LOG_LEVEL",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_SDK_DISABLED",
  "OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT",
  "OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  "OTEL_SPAN_EVENT_COUNT_LIMIT",
  "OTEL_SPAN_LINK_COUNT_LIMIT",
  "OTEL_TRACES_EXPORTER",
  "OTEL_TRACES_SAMPLER",
  "OTEL_TRACES_SAMPLER_ARG",
] as const;

type OtelGlobalRegistrations = {
  context?: Parameters<typeof context.setGlobalContextManager>[0];
  diag?: Parameters<typeof diag.setLogger>[0];
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

function clearGlobalProviders(): void {
  context.disable();
  logs.disable();
  metrics.disable();
  propagation.disable();
  trace.disable();
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
  clearGlobalProviders();
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
});

afterEach(() => {
  clearGlobalProviders();
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
  diag.disable();
  if (originalGlobals.diag) {
    diag.setLogger(originalGlobals.diag, {
      logLevel: DiagLogLevel.ALL,
      suppressOverrideMessage: true,
    });
  }
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

async function capturePrivateProviderSpans(emit: (tracer: Tracer) => void) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({}),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  emit(provider.getTracer("openclaw-private-provider-parity"));
  await provider.forceFlush();
  const spans = [...exporter.getFinishedSpans()];
  await provider.shutdown();
  return spans;
}

async function captureNodeSdkSpans(emit: (tracer: Tracer) => void) {
  const exporter = new InMemorySpanExporter();
  const sdk = new NodeSDK({
    autoDetectResources: false,
    resource: resourceFromAttributes({}),
    spanProcessor: new SimpleSpanProcessor(exporter),
  });
  sdk.start();
  emit(trace.getTracer("openclaw-node-sdk-parity"));
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  const spans = [...exporter.getFinishedSpans()];
  await sdk.shutdown();
  clearGlobalProviders();
  return spans;
}

const SAMPLER_CASES: ReadonlyArray<{
  label: string;
  sampler?: string;
  arg?: string;
  expected: number;
}> = [
  { label: "default", expected: 1 },
  { label: "always_on", sampler: "always_on", expected: 1 },
  { label: "always_off", sampler: "always_off", expected: 0 },
  { label: "parentbased_always_on", sampler: "parentbased_always_on", expected: 1 },
  { label: "parentbased_always_off", sampler: "parentbased_always_off", expected: 0 },
  { label: "traceidratio=1", sampler: "traceidratio", arg: "1", expected: 1 },
  { label: "traceidratio=0", sampler: "traceidratio", arg: "0", expected: 0 },
  {
    label: "parentbased_traceidratio=1",
    sampler: "parentbased_traceidratio",
    arg: "1",
    expected: 1,
  },
  {
    label: "parentbased_traceidratio=0",
    sampler: "parentbased_traceidratio",
    arg: "0",
    expected: 0,
  },
  { label: "invalid sampler", sampler: "invalid", expected: 1 },
  { label: "invalid ratio", sampler: "traceidratio", arg: "-1", expected: 1 },
];

test.each(SAMPLER_CASES)(
  "matches NodeSDK sampler behavior for $label",
  async ({ sampler, arg, expected }) => {
    if (sampler !== undefined) {
      process.env.OTEL_TRACES_SAMPLER = sampler;
    }
    if (arg !== undefined) {
      process.env.OTEL_TRACES_SAMPLER_ARG = arg;
    }
    const emit = (tracer: Tracer) => tracer.startSpan("sampler-probe").end();

    const nodeSdkSpans = await captureNodeSdkSpans(emit);
    const privateProviderSpans = await capturePrivateProviderSpans(emit);

    expect(nodeSdkSpans).toHaveLength(expected);
    expect(privateProviderSpans).toHaveLength(expected);
  },
);

function emitLimitProbe(tracer: Tracer): void {
  const span = tracer.startSpan("limit-probe", {
    attributes: {
      first: "abcdef",
      second: "ghijkl",
    },
    links: [
      {
        context: {
          traceId: "11111111111111111111111111111111",
          spanId: "1111111111111111",
          traceFlags: TraceFlags.SAMPLED,
        },
        attributes: { first: "abcdef", second: "ghijkl" },
      },
      {
        context: {
          traceId: "22222222222222222222222222222222",
          spanId: "2222222222222222",
          traceFlags: TraceFlags.SAMPLED,
        },
        attributes: { first: "abcdef", second: "ghijkl" },
      },
    ],
  });
  span.addEvent("first", { first: "abcdef", second: "ghijkl" });
  span.addEvent("second", { first: "abcdef", second: "ghijkl" });
  span.end();
}

function spanLimitShape(span: ReadableSpan) {
  return {
    attributes: span.attributes,
    events: span.events.map((event) => event.attributes),
    links: span.links.map((link) => link.attributes),
  };
}

test("matches NodeSDK behavior for all six OTEL_SPAN_* limit variables", async () => {
  process.env.OTEL_SPAN_ATTRIBUTE_COUNT_LIMIT = "1";
  process.env.OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT = "3";
  process.env.OTEL_SPAN_EVENT_COUNT_LIMIT = "1";
  process.env.OTEL_SPAN_LINK_COUNT_LIMIT = "1";
  process.env.OTEL_SPAN_ATTRIBUTE_PER_EVENT_COUNT_LIMIT = "1";
  process.env.OTEL_SPAN_ATTRIBUTE_PER_LINK_COUNT_LIMIT = "1";

  const [nodeSdkSpan] = await captureNodeSdkSpans(emitLimitProbe);
  const [privateProviderSpan] = await capturePrivateProviderSpans(emitLimitProbe);
  if (!nodeSdkSpan || !privateProviderSpan) {
    throw new Error("expected both providers to export the limit probe");
  }
  const expectedShape = {
    attributes: { first: "abc" },
    events: [{ first: "abc" }],
    links: [{ first: "abc" }],
  };

  expect(spanLimitShape(nodeSdkSpan)).toEqual(expectedShape);
  expect(spanLimitShape(privateProviderSpan)).toEqual(expectedShape);
});
