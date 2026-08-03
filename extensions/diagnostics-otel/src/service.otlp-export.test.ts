// Boundary test: unlike service.test.ts this file does NOT mock @opentelemetry/api, so
// real SDK-generated span ids flow through the recorders.
//
// It exists because the mocked suite makes every span report back the same trace id the
// test feeds in, collapsing the diagnostic and OTel id spaces into one value. That hides
// a parent lookup keyed by one id space and queried with the other.
//
// Trace cases use the OPENCLAW_OTEL_PRELOADED seam to retain this file's tracer provider.
// Collector-boundary cases start the real NodeSDK, so teardown restores every global SDK
// registration; otherwise a shutdown provider would poison later real-SDK cases.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { context, diag, DiagLogLevel, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEventWithPrivateData,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createDiagnosticsOtelService } from "./service.js";
import {
  createOtelContext,
  startOtelService,
  stopStartedOtelServices,
} from "./service.test-helpers.js";

const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";
const ENDPOINT_ENV_KEYS = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
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

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let originalPreloaded: string | undefined;
let originalEndpointEnv: Record<(typeof ENDPOINT_ENV_KEYS)[number], string | undefined>;
let originalOtelGlobals: OtelGlobalRegistrations;
let originalLogsProvider: ReturnType<typeof logs.getLoggerProvider> | undefined;

function registeredOtelGlobals(): OtelGlobalRegistrations | undefined {
  return (globalThis as unknown as Record<symbol, OtelGlobalRegistrations | undefined>)[
    OTEL_GLOBAL_API_KEY
  ];
}

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

const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});

function spanNamed(spans: ReadableSpan[], name: string) {
  return spans.find((span) => span.name === name);
}

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

// Covers all three completeTrackedLifecycleSpan owners: run.completed,
// harness.run.completed, and message.processed. The mocked suite cannot tell the two id
// spaces apart, so a regression at any one of them is only visible here.
test("keeps a whole turn on one trace when children arrive after their parent ended", async () => {
  const { service, ctx } = await startOtelService({ traces: true });

  const messageTrace = createDiagnosticTraceContext();
  const harnessTrace = createChildDiagnosticTraceContext(messageTrace);
  const runTrace = createChildDiagnosticTraceContext(harnessTrace);
  const base = { runId: "run-otlp-1", provider: "openai", model: "gpt-5.6-luna" };
  const harnessBase = { ...base, harnessId: "claude-cli" };

  emit({
    type: "message.dispatch.started",
    channel: "telegram",
    source: "webhook",
    trace: messageTrace,
  });
  emit({ type: "harness.run.started", ...harnessBase, trace: harnessTrace });
  emit({ type: "run.started", ...base, trace: runTrace });
  emit({
    type: "model.call.completed",
    ...base,
    callId: "call-1",
    durationMs: 1_200,
    trace: createChildDiagnosticTraceContext(runTrace),
  });
  await waitForDiagnosticEventsDrained();

  // Each lifecycle span below ends, then receives a straggler. Those stragglers must join
  // the same trace instead of each minting a fresh single-span trace.
  emit({
    type: "run.completed",
    ...base,
    outcome: "completed",
    durationMs: 9_000,
    trace: runTrace,
  });
  emit({
    type: "tool.execution.completed",
    runId: base.runId,
    toolName: "write",
    durationMs: 120,
    trace: createChildDiagnosticTraceContext(runTrace),
  });
  emit({
    type: "harness.run.completed",
    ...harnessBase,
    outcome: "completed",
    durationMs: 9_500,
    trace: harnessTrace,
  });
  emit({
    type: "context.assembled",
    ...base,
    sessionKey: "session-key",
    channel: "telegram",
    trigger: "message",
    messageCount: 3,
    historyTextChars: 100,
    historyImageBlocks: 0,
    maxMessageTextChars: 100,
    systemPromptChars: 50,
    promptChars: 150,
    promptImages: 0,
    trace: createChildDiagnosticTraceContext(harnessTrace),
  });
  emit({
    type: "message.processed",
    channel: "telegram",
    outcome: "completed",
    durationMs: 10_000,
    trace: messageTrace,
  });
  emit({
    type: "model.usage",
    ...base,
    usage: { input: 10, output: 5, total: 15 },
    durationMs: 30,
    trace: createChildDiagnosticTraceContext(messageTrace),
  });
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const spans = exporter.getFinishedSpans();
  const messageSpan = spanNamed(spans, "openclaw.message.processed");
  const harnessSpan = spanNamed(spans, "openclaw.harness.run");
  const runSpan = spanNamed(spans, "openclaw.run");

  expect(spans).toHaveLength(7);
  expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
  // A turn with no exported ancestor starts a fresh OTel root rather than reusing the
  // diagnostic trace id. Spans parented from an upstream traceparent do adopt it.
  expect(messageSpan?.spanContext().traceId).not.toBe(messageTrace.traceId);
  expect(messageSpan?.parentSpanContext).toBeUndefined();
  expect(harnessSpan?.parentSpanContext?.spanId).toBe(messageSpan?.spanContext().spanId);
  expect(runSpan?.parentSpanContext?.spanId).toBe(harnessSpan?.spanContext().spanId);
  // Stragglers land on the lifecycle span that owned them, not on a new root.
  expect(spanNamed(spans, "openclaw.tool.execution")?.parentSpanContext?.spanId).toBe(
    runSpan?.spanContext().spanId,
  );
  expect(spanNamed(spans, "openclaw.context.assembled")?.parentSpanContext?.spanId).toBe(
    harnessSpan?.spanContext().spanId,
  );
  expect(spanNamed(spans, "openclaw.model.usage")?.parentSpanContext?.spanId).toBe(
    messageSpan?.spanContext().spanId,
  );
}, 30_000);

// An aborted turn ends the harness span via harness.run.error and never emits
// run.completed, so that error path is the only thing a late child can attach to.
test("keeps a late child on the trace when the turn ended in harness.run.error", async () => {
  const { service, ctx } = await startOtelService({ traces: true });

  const harnessTrace = createDiagnosticTraceContext();
  const base = { runId: "run-err-1", provider: "openai", model: "gpt-5.6-luna" };
  const harnessBase = { ...base, harnessId: "openclaw" };

  emit({ type: "harness.run.started", ...harnessBase, trace: harnessTrace });
  await waitForDiagnosticEventsDrained();

  emit({
    type: "harness.run.error",
    ...harnessBase,
    phase: "send",
    errorCategory: "aborted",
    durationMs: 4_000,
    trace: harnessTrace,
  });
  // The killed child process settles after the harness span already ended.
  emit({
    type: "tool.execution.completed",
    runId: base.runId,
    toolName: "bash",
    durationMs: 200,
    trace: createChildDiagnosticTraceContext(harnessTrace),
  });
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const spans = exporter.getFinishedSpans();
  const harnessSpan = spanNamed(spans, "openclaw.harness.run");
  const toolSpan = spanNamed(spans, "openclaw.tool.execution");

  expect(harnessSpan).toBeDefined();
  expect(toolSpan).toBeDefined();
  expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
  expect(toolSpan?.parentSpanContext?.spanId).toBe(harnessSpan?.spanContext().spanId);
}, 30_000);

// Regression guard: when nothing this process exported can be resolved as the parent, the
// span must stay a root. Pointing at an unexported span id breaks waterfalls and makes
// parent-id-keyed backends drop the observation.
test("leaves exec spans parentless rather than naming a span nobody exported", async () => {
  const { service, ctx } = await startOtelService({ traces: true });

  // No harness.run.started or run.started, so activeTrustedSpans is empty - the state an
  // operator lands in when traces are enabled mid-turn.
  const requestScope = createDiagnosticTraceContext();
  const { emitDiagnosticEventWithTrustedTraceContext } =
    await import("openclaw/plugin-sdk/plugin-test-runtime");
  emitDiagnosticEventWithTrustedTraceContext({
    type: "exec.process.completed",
    target: "host",
    mode: "child",
    outcome: "completed",
    durationMs: 640,
    commandLength: 24,
    trace: createChildDiagnosticTraceContext(requestScope),
  } as Parameters<typeof emitDiagnosticEventWithTrustedTraceContext>[0]);
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const execSpan = spanNamed(exporter.getFinishedSpans(), "openclaw.exec");
  expect(execSpan).toBeDefined();
  expect(execSpan?.parentSpanContext).toBeUndefined();
}, 30_000);

const OTEL_ENDPOINT_SIGNAL_CASES = [
  {
    signal: "traces",
    envKey: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    configKey: "tracesEndpoint",
    flags: { traces: true, metrics: false, logs: false },
  },
  {
    signal: "metrics",
    envKey: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    configKey: "metricsEndpoint",
    flags: { traces: false, metrics: true, logs: false },
  },
  {
    signal: "logs",
    envKey: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    configKey: "logsEndpoint",
    flags: { traces: false, metrics: false, logs: true },
  },
] as const;

const OTEL_ENDPOINT_SECURITY_CASES = OTEL_ENDPOINT_SIGNAL_CASES.flatMap((signal) =>
  (
    [
      "shared configuration",
      "signal configuration",
      "signal environment",
      "shared environment",
      "Unicode-prefixed signal environment",
      "Unicode-prefixed shared environment",
      "path-concatenated shared environment",
      "path-concatenated shared configuration",
      "path-concatenated signal configuration",
    ] as const
  ).map((source) => Object.assign({ source }, signal)),
);

test.each(OTEL_ENDPOINT_SECURITY_CASES)(
  "rejects malformed $signal collector $source before the real SDK can expose credentials",
  async ({ signal, envKey, configKey, flags, source }) => {
    process.env[PRELOAD_ENV] = "0";
    const credential = `qa-otel-${signal}-endpoint-password-sentinel`;
    const malformedEndpoint = source.startsWith("Unicode-prefixed")
      ? `\u00a0https://operator:${credential}@collector.example.com/otlp`
      : source === "path-concatenated shared environment"
        ? `https://operator:${credential}@collector.example.com: `
        : source.startsWith("path-concatenated")
          ? `https://operator:${credential}@collector.example.com /`
          : `https://operator:${credential}@[`;
    const configuredEndpoint = source.endsWith("shared configuration")
      ? malformedEndpoint
      : "https://collector.example.com/otlp";
    if (source.endsWith("signal environment")) {
      process.env[envKey] = malformedEndpoint;
    } else if (source.endsWith("shared environment")) {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = malformedEndpoint;
    }

    const diagnostics = captureOtelDiagnostics();
    const ctx = createOtelContext(configuredEndpoint, flags);
    if (source.endsWith("signal configuration") || source.endsWith("signal environment")) {
      ctx.config.diagnostics!.otel![configKey] = source.endsWith("signal configuration")
        ? malformedEndpoint
        : "https://signal.example.com/otlp";
    }
    ctx.internalDiagnostics!.emit = () => {};
    const service = createDiagnosticsOtelService();
    let failure: unknown;
    try {
      await service.start(ctx);
    } catch (error) {
      failure = error;
    } finally {
      await service.stop?.(ctx);
    }

    expect(diagnostics.join("\n")).not.toContain(credential);
    expect(failure).toBeInstanceOf(Error);
    const startupError = failure as Error;
    expect(startupError.message).toBe(
      "Configured OpenTelemetry collector endpoint is invalid; check the collector URL",
    );
    expect(startupError.stack).not.toContain(credential);
    expect(startupError).not.toHaveProperty("cause");
    expect(JSON.stringify(vi.mocked(ctx.logger.error).mock.calls)).not.toContain(credential);
    expect(JSON.stringify(vi.mocked(ctx.logger.warn).mock.calls)).not.toContain(credential);
  },
);

test.each([
  {
    disabledSignal: "metrics",
    envKey: "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
    flags: { traces: true, metrics: false, logs: false },
  },
  {
    disabledSignal: "traces",
    envKey: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    flags: { traces: false, metrics: true, logs: false },
  },
  {
    disabledSignal: "logs",
    envKey: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    flags: { traces: true, metrics: false, logs: false },
  },
  {
    disabledSignal: "stdout-only logs",
    envKey: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
    flags: { traces: true, metrics: false, logs: true, logsExporter: "stdout" },
  },
] as const)(
  "does not auto-create an undeclared $disabledSignal OTLP exporter",
  async ({ disabledSignal, envKey, flags }) => {
    process.env[PRELOAD_ENV] = "0";
    const credential = `qa-otel-${disabledSignal.replaceAll(" ", "-")}-disabled-password`;
    process.env[envKey] = `https://operator:${credential}@[`;
    const diagnostics = captureOtelDiagnostics();
    const ctx = createOtelContext("https://collector.example.com/otlp", flags);
    ctx.internalDiagnostics!.emit = () => {};
    const service = createDiagnosticsOtelService();

    try {
      await service.start(ctx);
      expect(diagnostics.join("\n")).not.toContain(credential);
    } finally {
      await service.stop?.(ctx);
    }
  },
);

const OTEL_TLS_MATERIAL_CASES = [
  { suffix: "CERTIFICATE", label: "TLS root certificate" },
  { suffix: "CLIENT_CERTIFICATE", label: "mTLS client certificate" },
  { suffix: "CLIENT_KEY", label: "mTLS client private key" },
] as const;

const OTEL_TLS_FILE_SECURITY_CASES = OTEL_ENDPOINT_SIGNAL_CASES.flatMap((signal) =>
  OTEL_TLS_MATERIAL_CASES.flatMap((material) =>
    (["shared", "signal"] as const).map((scope) => Object.assign({ scope }, signal, material)),
  ),
);

test.each(OTEL_TLS_FILE_SECURITY_CASES)(
  "refuses the real $signal exporter when its $scope $label file cannot be read",
  async ({ signal, suffix, label, scope, flags }) => {
    process.env[PRELOAD_ENV] = "0";
    const pathSentinel = `qa-otel-${signal}-${suffix.toLowerCase()}-file-sentinel`;
    const missingPath = `/definitely-missing/${pathSentinel}.pem`;
    const envKey =
      scope === "shared"
        ? `OTEL_EXPORTER_OTLP_${suffix}`
        : `OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_${suffix}`;
    process.env[envKey] = missingPath;

    const diagnostics = captureOtelDiagnostics();
    const ctx = createOtelContext("https://collector.example.com/otlp", flags);
    ctx.internalDiagnostics!.emit = () => {};
    const service = createDiagnosticsOtelService();
    let failure: unknown;
    try {
      await service.start(ctx);
    } catch (error) {
      failure = error;
    } finally {
      await service.stop?.(ctx);
    }

    expect(failure).toBeInstanceOf(Error);
    const startupError = failure as Error;
    expect(startupError.message).toBe(
      `Configured OpenTelemetry ${label} file is missing, empty, or unreadable; refusing insecure export`,
    );
    expect(startupError.stack).not.toContain(pathSentinel);
    expect(startupError).not.toHaveProperty("cause");
    expect(diagnostics.join("\n")).not.toContain(pathSentinel);
    expect(JSON.stringify(vi.mocked(ctx.logger.error).mock.calls)).not.toContain(pathSentinel);
    expect(JSON.stringify(vi.mocked(ctx.logger.warn).mock.calls)).not.toContain(pathSentinel);
  },
);

test.each(OTEL_ENDPOINT_SIGNAL_CASES)(
  "refuses invalid TLS material before the real default $signal exporter is constructed",
  async ({ signal, flags }) => {
    process.env[PRELOAD_ENV] = "0";
    process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_CERTIFICATE`] =
      "/definitely-missing/qa-otel-default-root.pem";
    const ctx = createOtelContext("", flags);
    ctx.internalDiagnostics!.emit = () => {};
    const service = createDiagnosticsOtelService();

    try {
      await expect(service.start(ctx)).rejects.toThrow(
        "Configured OpenTelemetry TLS root certificate file is missing, empty, or unreadable; refusing insecure export",
      );
    } finally {
      await service.stop?.(ctx);
    }
  },
);

test.each(
  OTEL_ENDPOINT_SIGNAL_CASES.flatMap((signal) =>
    OTEL_TLS_MATERIAL_CASES.map((material) => Object.assign({}, signal, material)),
  ),
)(
  "rejects an empty $signal $label file before the SDK can silently downgrade trust",
  async ({ signal, suffix, label, flags }) => {
    process.env[PRELOAD_ENV] = "0";
    const certDir = mkdtempSync(path.join(tmpdir(), "openclaw-otel-empty-tls-"));
    const emptyMaterialPath = path.join(certDir, "empty.pem");
    writeFileSync(emptyMaterialPath, "");
    process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_${suffix}`] = emptyMaterialPath;
    const ctx = createOtelContext("https://collector.example.com/otlp", flags);
    ctx.internalDiagnostics!.emit = () => {};
    const service = createDiagnosticsOtelService();

    try {
      await expect(service.start(ctx)).rejects.toThrow(
        `Configured OpenTelemetry ${label} file is missing, empty, or unreadable; refusing insecure export`,
      );
    } finally {
      await service.stop?.(ctx);
      rmSync(certDir, { force: true, recursive: true });
    }
  },
);

test.each(OTEL_ENDPOINT_SIGNAL_CASES)(
  "rejects the raw whitespace-padded $signal TLS certificate path the SDK cannot read",
  async ({ signal, flags }) => {
    process.env[PRELOAD_ENV] = "0";
    process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_CERTIFICATE`] = ` ${process.execPath} `;
    const ctx = createOtelContext("https://collector.example.com/otlp", flags);
    ctx.internalDiagnostics!.emit = () => {};
    const service = createDiagnosticsOtelService();

    try {
      await expect(service.start(ctx)).rejects.toThrow(
        "Configured OpenTelemetry TLS root certificate file is missing, empty, or unreadable; refusing insecure export",
      );
    } finally {
      await service.stop?.(ctx);
    }
  },
);

test.each(
  OTEL_ENDPOINT_SIGNAL_CASES.flatMap((signal) =>
    (["CLIENT_CERTIFICATE", "CLIENT_KEY"] as const).map((suffix) =>
      Object.assign({ suffix }, signal),
    ),
  ),
)(
  "rejects the real $signal exporter when only $suffix mTLS material is configured",
  async ({ signal, suffix, flags }) => {
    process.env[PRELOAD_ENV] = "0";
    process.env[`OTEL_EXPORTER_OTLP_${signal.toUpperCase()}_${suffix}`] = process.execPath;
    const ctx = createOtelContext("https://collector.example.com/otlp", flags);
    ctx.internalDiagnostics!.emit = () => {};
    const service = createDiagnosticsOtelService();

    try {
      await expect(service.start(ctx)).rejects.toThrow(
        "Configured OpenTelemetry mTLS requires both a client certificate and private key; refusing insecure export",
      );
    } finally {
      await service.stop?.(ctx);
    }
  },
);
