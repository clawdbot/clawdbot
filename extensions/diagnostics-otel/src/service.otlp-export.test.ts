// Boundary test: unlike service.test.ts this file does NOT mock @opentelemetry/api, so
// real SDK-generated span ids flow through the recorders.
//
// It exists because the mocked suite makes every span report back the same trace id the
// test feeds in, collapsing the diagnostic and OTel id spaces into one value. That hides
// a parent lookup keyed by one id space and queried with the other.
//
// Trace cases use the OPENCLAW_OTEL_PRELOADED seam to retain this file's tracer provider.
// Collector-boundary cases run owned mode, which now composes private providers and never
// registers global SDK state; teardown still restores the preloaded globals for trace cases.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { context, diag, DiagLogLevel, metrics, propagation, trace } from "@opentelemetry/api";
import { logs } from "@opentelemetry/api-logs";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContext,
  emitTrustedDiagnosticEventWithPrivateData,
  parseDiagnosticTraceparent,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { expect, test, vi } from "vitest";
import { runModelCallAndCaptureTraceparent } from "../../../test/e2e/qa-lab/runtime/otel-model-call.test-support.js";
import { startLocalOtlpReceiver } from "../../../test/e2e/qa-lab/runtime/otel-test-support.js";
import { createDiagnosticsOtelService } from "./service.js";
import { installRealOtelSdkTestHarness, PRELOAD_ENV } from "./service.real-sdk.test-support.js";
import {
  createOtelContext,
  emitRealSdkSignals,
  startOtelService,
  startOtlpReceiver,
} from "./service.test-helpers.js";

const sdk = installRealOtelSdkTestHarness();

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

function releasePreloadedOtelGlobals() {
  context.disable();
  logs.disable();
  metrics.disable();
  propagation.disable();
  trace.disable();
  process.env[PRELOAD_ENV] = "0";
}

const SHARED_ENDPOINT_ROUTING_CASES = [
  {
    label: "root",
    suffix: "",
    expected: ["/v1/traces", "/v1/metrics", "/v1/logs"],
  },
  {
    label: "trailing-slash root",
    suffix: "/",
    expected: ["/v1/traces", "/v1/metrics", "/v1/logs"],
  },
  {
    label: "custom collector path",
    suffix: "/api/public/otel",
    expected: [
      "/api/public/otel/v1/traces",
      "/api/public/otel/v1/metrics",
      "/api/public/otel/v1/logs",
    ],
  },
  {
    label: "signal-qualified collector path",
    suffix: "/api/public/otel/v1/traces",
    expected: [
      "/api/public/otel/v1/traces",
      "/api/public/otel/v1/metrics",
      "/api/public/otel/v1/logs",
    ],
  },
  {
    label: "signal-qualified path with trailing slash",
    suffix: "/api/public/otel/v1/traces/",
    expected: [
      "/api/public/otel/v1/traces",
      "/api/public/otel/v1/metrics",
      "/api/public/otel/v1/logs",
    ],
  },
  {
    label: "custom path with query slash",
    suffix: "/api/public/otel/?tenant=team/",
    expected: [
      "/api/public/otel/v1/traces?tenant=team/",
      "/api/public/otel/v1/metrics?tenant=team/",
      "/api/public/otel/v1/logs?tenant=team/",
    ],
  },
  {
    label: "signal path with query slash",
    suffix: "/api/public/otel/v1/traces/?tenant=team/",
    expected: [
      "/api/public/otel/v1/traces/?tenant=team/",
      "/api/public/otel/v1/metrics?tenant=team/",
      "/api/public/otel/v1/logs?tenant=team/",
    ],
  },
] as const;

test.each(
  SHARED_ENDPOINT_ROUTING_CASES.flatMap((entry) =>
    (["config", "environment"] as const).map((source) => Object.assign({ source }, entry)),
  ),
)(
  "routes real exporters from a shared $label endpoint in $source",
  async ({ suffix, expected, source }) => {
    const receiver = await startOtlpReceiver();
    releasePreloadedOtelGlobals();
    const { service, ctx } = await startOtelService({
      endpoint: `${receiver.endpoint}${suffix}`,
      traces: true,
      metrics: true,
      logs: true,
      configure: (serviceContext) => {
        if (source === "environment") {
          delete serviceContext.config.diagnostics!.otel!.endpoint;
          process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `${receiver.endpoint}${suffix}`;
        }
      },
    });

    try {
      await emitRealSdkSignals();
      await service.stop?.(ctx);

      expect(new Set(receiver.requests.map((request) => request.url))).toEqual(new Set(expected));
      expect(
        receiver.requests.every(
          (request) =>
            request.method === "POST" && request.contentType === "application/x-protobuf",
        ),
      ).toBe(true);
    } finally {
      await service.stop?.(ctx);
      await receiver.close();
    }
  },
  30_000,
);

test("merges exporter headers with config and required protobuf precedence", async () => {
  const receiver = await startOtlpReceiver();
  releasePreloadedOtelGlobals();
  process.env.OTEL_EXPORTER_OTLP_HEADERS =
    "x-env-only=env-value,x-precedence=env-value,content-type=text/plain";
  const { service, ctx } = await startOtelService({
    endpoint: receiver.endpoint,
    traces: true,
    metrics: true,
    logs: true,
    configure: (serviceContext) => {
      serviceContext.config.diagnostics!.otel!.headers = {
        "content-type": "application/json",
        "x-config-only": "config-value",
        "x-precedence": "config-value",
      };
    },
  });

  try {
    await emitRealSdkSignals();
    await service.stop?.(ctx);

    expect(new Set(receiver.requests.map((request) => request.url))).toEqual(
      new Set(["/v1/traces", "/v1/metrics", "/v1/logs"]),
    );
    expect(
      receiver.requests.every((request) => {
        return (
          request.method === "POST" &&
          request.headers["content-type"] === "application/x-protobuf" &&
          request.headers["x-config-only"] === "config-value" &&
          request.headers["x-env-only"] === "env-value" &&
          request.headers["x-precedence"] === "config-value"
        );
      }),
    ).toBe(true);
  } finally {
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 30_000);

test("uses real signal-specific exporter endpoints verbatim", async () => {
  const receiver = await startOtlpReceiver();
  releasePreloadedOtelGlobals();
  const traceEndpoint = `${receiver.endpoint}/custom-traces?tenant=red`;
  const metricEndpoint = `${receiver.endpoint}/custom-metrics/`;
  const logEndpoint = `${receiver.endpoint}/v1/traces`;
  const { service, ctx } = await startOtelService({
    endpoint: `${receiver.endpoint}/shared-unused`,
    traces: true,
    metrics: true,
    logs: true,
    configure: (serviceContext) => {
      serviceContext.config.diagnostics!.otel!.tracesEndpoint = traceEndpoint;
      serviceContext.config.diagnostics!.otel!.metricsEndpoint = metricEndpoint;
      serviceContext.config.diagnostics!.otel!.logsEndpoint = logEndpoint;
    },
  });

  try {
    await emitRealSdkSignals();
    await service.stop?.(ctx);

    expect(new Set(receiver.requests.map((request) => request.url))).toEqual(
      new Set(["/custom-traces?tenant=red", "/custom-metrics/", "/v1/traces"]),
    );
  } finally {
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 30_000);

test("exports only signals whose resolved protocol is supported", async () => {
  const receiver = await startOtlpReceiver();
  releasePreloadedOtelGlobals();
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "grpc";
  process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "http/protobuf";
  process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "http/json";
  process.env.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL = "http/protobuf";
  const { service, ctx } = await startOtelService({
    endpoint: receiver.endpoint,
    traces: true,
    metrics: true,
    logs: true,
    configure: (serviceContext) => {
      delete serviceContext.config.diagnostics!.otel!.protocol;
    },
  });

  try {
    await emitRealSdkSignals();
    await service.stop?.(ctx);

    expect(new Set(receiver.requests.map((request) => request.url))).toEqual(
      new Set(["/v1/traces", "/v1/logs"]),
    );
    expect(
      receiver.requests.every(
        (request) => request.method === "POST" && request.contentType === "application/x-protobuf",
      ),
    ).toBe(true);
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "diagnostics-otel: unsupported metrics protocol http/json; OTLP export disabled",
    );
  } finally {
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 30_000);

test("does not auto-enable rejected traces when metrics start the real SDK", async () => {
  const receiver = await startOtlpReceiver();
  releasePreloadedOtelGlobals();
  process.env.OTEL_EXPORTER_OTLP_PROTOCOL = "http/protobuf";
  process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL = "grpc";
  process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL = "http/protobuf";
  const { service, ctx } = await startOtelService({
    endpoint: receiver.endpoint,
    traces: true,
    metrics: true,
    logs: false,
    configure: (serviceContext) => {
      delete serviceContext.config.diagnostics!.otel!.protocol;
    },
  });

  try {
    await emitRealSdkSignals();
    await service.stop?.(ctx);

    expect(new Set(receiver.requests.map((request) => request.url))).toEqual(
      new Set(["/v1/metrics"]),
    );
    expect(ctx.logger.warn).toHaveBeenCalledWith(
      "diagnostics-otel: unsupported traces protocol grpc; OTLP export disabled",
    );
  } finally {
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 30_000);

test("propagates the exported model span across two OTLP services with one rooted trace", async () => {
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  const endpoint = `http://127.0.0.1:${port}`;
  releasePreloadedOtelGlobals();

  const peerProvider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "openclaw-otel-peer" }),
    spanProcessors: [
      new SimpleSpanProcessor(
        new OTLPTraceExporter({
          url: `${endpoint}/v1/traces`,
        }),
      ),
    ],
  });
  const peerTracer = peerProvider.getTracer("openclaw-otel-peer");
  const peerRoot = peerTracer.startSpan("peer.request");
  const peerRootContext = peerRoot.spanContext();
  const inboundParent = createDiagnosticTraceContext({
    traceId: peerRootContext.traceId,
    spanId: peerRootContext.spanId,
    traceFlags: peerRootContext.traceFlags.toString(16).padStart(2, "0"),
  });

  const { service, ctx } = await startOtelService({
    endpoint,
    traces: true,
    metrics: false,
    logs: false,
    configure: (serviceContext) => {
      serviceContext.config.diagnostics!.otel!.serviceName = "openclaw-otel-gateway";
    },
  });

  try {
    const messageTrace = createChildDiagnosticTraceContext(inboundParent);
    const harnessTrace = createChildDiagnosticTraceContext(messageTrace);
    const runTrace = createChildDiagnosticTraceContext(harnessTrace);
    const toolTrace = createChildDiagnosticTraceContext(runTrace);
    const base = { runId: "run-live-bridge", provider: "openai", model: "gpt-5.6-luna" };
    const harnessBase = { ...base, harnessId: "openclaw" };

    emit({
      type: "message.dispatch.started",
      channel: "web",
      source: "http",
      trace: messageTrace,
    });
    emit({ type: "harness.run.started", ...harnessBase, trace: harnessTrace });
    emit({ type: "run.started", ...base, trace: runTrace });
    const outboundTraceparent = runModelCallAndCaptureTraceparent({
      ...base,
      callId: "call-live-bridge",
      trace: runTrace,
    });
    const outboundContext = parseDiagnosticTraceparent(outboundTraceparent);
    expect(outboundContext).toBeDefined();
    const peerCallback = peerTracer.startSpan(
      "peer.callback",
      {},
      trace.setSpanContext(context.active(), {
        traceId: outboundContext!.traceId,
        spanId: outboundContext!.spanId!,
        traceFlags: Number.parseInt(outboundContext!.traceFlags ?? "00", 16),
        isRemote: true,
      }),
    );
    peerCallback.end();

    emit({
      type: "tool.execution.started",
      runId: base.runId,
      toolName: "http",
      trace: toolTrace,
    });
    emit({
      type: "tool.execution.completed",
      runId: base.runId,
      toolName: "http",
      durationMs: 10,
      trace: toolTrace,
    });
    emit({
      type: "run.completed",
      ...base,
      outcome: "completed",
      durationMs: 60,
      trace: runTrace,
    });
    emit({
      type: "harness.run.completed",
      ...harnessBase,
      outcome: "completed",
      durationMs: 70,
      trace: harnessTrace,
    });
    emit({
      type: "message.processed",
      channel: "web",
      outcome: "completed",
      durationMs: 80,
      trace: messageTrace,
    });
    await waitForDiagnosticEventsDrained();
    peerRoot.end();
    await service.stop?.(ctx);
    await peerProvider.shutdown();

    const spans = receiver.capturedSpans.filter((span) =>
      [
        "peer.request",
        "peer.callback",
        "openclaw.message.processed",
        "openclaw.harness.run",
        "openclaw.run",
        "openclaw.model.call",
        "openclaw.tool.execution",
      ].includes(span.name),
    );
    const spanIds = new Set(spans.map((span) => span.spanId));
    const roots = spans.filter((span) => !span.parentSpanId);
    const modelSpan = spans.find((span) => span.name === "openclaw.model.call");

    expect(spans).toHaveLength(7);
    expect(new Set(spans.map((span) => span.traceId)).size).toBe(1);
    expect(roots.map((span) => span.name)).toEqual(["peer.request"]);
    expect(spans.every((span) => !span.parentSpanId || spanIds.has(span.parentSpanId))).toBe(true);
    expect(outboundContext?.traceId).toBe(modelSpan?.traceId);
    expect(outboundContext?.spanId).toBe(modelSpan?.spanId);
    expect(spans.find((span) => span.name === "peer.callback")?.parentSpanId).toBe(
      modelSpan?.spanId,
    );
  } finally {
    peerRoot.end();
    await service.stop?.(ctx);
    await peerProvider.shutdown();
    await receiver.close();
  }
}, 30_000);

test("preserves explicit zero model-call usage through OTLP protobuf export", async () => {
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  releasePreloadedOtelGlobals();
  const { service, ctx } = await startOtelService({
    endpoint: `http://127.0.0.1:${port}`,
    traces: true,
  });

  try {
    emit({
      type: "model.call.completed",
      runId: "run-zero-usage",
      callId: "call-zero-usage",
      provider: "openai",
      model: "gpt-5.6-luna",
      durationMs: 1,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    await waitForDiagnosticEventsDrained();
    await service.stop?.(ctx);

    expect(
      receiver.capturedSpans.find((span) => span.name === "openclaw.model.call")?.attributes,
    ).toMatchObject({
      "openclaw.model_call.usage.input_tokens": 0,
      "openclaw.model_call.usage.output_tokens": 0,
      "openclaw.model_call.usage.prompt_tokens": 0,
      "gen_ai.usage.input_tokens": 0,
    });
  } finally {
    await service.stop?.(ctx);
    await receiver.close();
  }
}, 30_000);

test("uses the real preloaded model span as the mid-turn propagation root", async () => {
  const { service, ctx } = await startOtelService({ traces: true });
  const outboundTraceparent = runModelCallAndCaptureTraceparent({
    trace: createDiagnosticTraceContext(),
    runId: "run-mid-turn",
    callId: "call-mid-turn",
    provider: "openai",
    model: "gpt-5.6-luna",
  });
  await waitForDiagnosticEventsDrained();
  await service.stop?.(ctx);

  const modelSpan = spanNamed(sdk.exporter.getFinishedSpans(), "openclaw.model.call");
  expect(modelSpan?.parentSpanContext).toBeUndefined();
  expect(outboundTraceparent).toBe(
    `00-${modelSpan?.spanContext().traceId}-${modelSpan?.spanContext().spanId}-01`,
  );
}, 30_000);

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

  const spans = sdk.exporter.getFinishedSpans();
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

  const spans = sdk.exporter.getFinishedSpans();
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

  const execSpan = spanNamed(sdk.exporter.getFinishedSpans(), "openclaw.exec");
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
