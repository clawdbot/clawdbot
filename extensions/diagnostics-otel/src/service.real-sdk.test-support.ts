import { context, diag, DiagLogLevel, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resetDiagnosticEventsForTest } from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach } from "vitest";
import { stopStartedOtelServices } from "./service.test-helpers.js";

export const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
const ENDPOINT_ENV_KEYS = [
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TIMEOUT",
  "OTEL_EXPORTER_OTLP_TRACES_TIMEOUT",
  "OTEL_EXPORTER_OTLP_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_TRACES_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_TRACES_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_TRACES_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_METRICS_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY",
  "OTEL_EXPORTER_OTLP_LOGS_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_LOGS_CLIENT_CERTIFICATE",
  "OTEL_EXPORTER_OTLP_LOGS_CLIENT_KEY",
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

// Real-SDK suites share one owner for global registrations, providers, and environment cleanup.
export function installRealOtelSdkTestHarness() {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;
  let originalPreloaded: string | undefined;
  let originalEndpointEnv: Record<(typeof ENDPOINT_ENV_KEYS)[number], string | undefined>;
  let originalOtelGlobals: OtelGlobalRegistrations;
  let originalLogsProvider: ReturnType<typeof logs.getLoggerProvider> | undefined;

  beforeEach(() => {
    originalPreloaded = process.env[PRELOAD_ENV];
    originalEndpointEnv = Object.fromEntries(
      ENDPOINT_ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<(typeof ENDPOINT_ENV_KEYS)[number], string | undefined>;
    for (const key of ENDPOINT_ENV_KEYS) {
      delete process.env[key];
    }
    originalOtelGlobals = { ...registeredOtelGlobals() };
    originalLogsProvider = Object.hasOwn(globalThis, OTEL_GLOBAL_LOGS_KEY)
      ? logs.getLoggerProvider()
      : undefined;
    process.env[PRELOAD_ENV] = "1";
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
    trace.setGlobalTracerProvider(provider);
  });

  afterEach(async () => {
    await stopStartedOtelServices();
    await provider.shutdown();
    const currentGlobals = registeredOtelGlobals();
    if (currentGlobals?.context !== originalOtelGlobals.context) {
      context.disable();
      if (originalOtelGlobals.context) {
        context.setGlobalContextManager(originalOtelGlobals.context);
      }
    }
    if (currentGlobals?.propagation !== originalOtelGlobals.propagation) {
      propagation.disable();
      if (originalOtelGlobals.propagation) {
        propagation.setGlobalPropagator(originalOtelGlobals.propagation);
      }
    }
    if (currentGlobals?.metrics !== originalOtelGlobals.metrics) {
      metrics.disable();
      if (originalOtelGlobals.metrics) {
        metrics.setGlobalMeterProvider(originalOtelGlobals.metrics);
      }
    }
    if (currentGlobals?.trace !== originalOtelGlobals.trace) {
      trace.disable();
      if (originalOtelGlobals.trace) {
        trace.setGlobalTracerProvider(originalOtelGlobals.trace);
      }
    }
    if (Object.hasOwn(globalThis, OTEL_GLOBAL_LOGS_KEY) || originalLogsProvider) {
      logs.disable();
      if (originalLogsProvider) {
        logs.setGlobalLoggerProvider(originalLogsProvider);
      }
    }
    exporter.reset();
    if (originalPreloaded === undefined) {
      delete process.env[PRELOAD_ENV];
    } else {
      process.env[PRELOAD_ENV] = originalPreloaded;
    }
    for (const key of ENDPOINT_ENV_KEYS) {
      const value = originalEndpointEnv[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    diag.disable();
    if (originalOtelGlobals.diag) {
      diag.setLogger(originalOtelGlobals.diag, {
        logLevel: DiagLogLevel.ALL,
        suppressOverrideMessage: true,
      });
    }
    resetDiagnosticEventsForTest();
  });

  return {
    get exporter() {
      return exporter;
    },
    get provider() {
      return provider;
    },
  };
}
