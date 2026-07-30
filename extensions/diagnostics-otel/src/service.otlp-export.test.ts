// Boundary test: unlike service.test.ts this file does NOT mock @opentelemetry/api, so
// real SDK-generated span ids flow through the recorders.
//
// It exists because the mocked suite makes every span report back the same trace id the
// test feeds in, collapsing the diagnostic and OTel id spaces into one value. That hides
// a parent lookup keyed by one id space and queried with the other.
//
// It drives the service through the OPENCLAW_OTEL_PRELOADED seam so the plugin uses this
// file's tracer provider instead of starting its own NodeSDK. trace.disable() in teardown
// then fully releases the global API slot; a NodeSDK cannot be unregistered, and the
// leftover dead provider would make any later real-SDK test export nothing.
import { trace } from "@opentelemetry/api";
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
import { afterEach, beforeEach, expect, test } from "vitest";
import { startOtelService, stopStartedOtelServices } from "./service.test-helpers.js";

const PRELOAD_ENV = "OPENCLAW_OTEL_PRELOADED";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let originalPreloaded: string | undefined;

beforeEach(() => {
  originalPreloaded = process.env[PRELOAD_ENV];
  process.env[PRELOAD_ENV] = "1";
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
  await stopStartedOtelServices();
  await provider.shutdown();
  trace.disable();
  exporter.reset();
  if (originalPreloaded === undefined) {
    delete process.env[PRELOAD_ENV];
  } else {
    process.env[PRELOAD_ENV] = originalPreloaded;
  }
  resetDiagnosticEventsForTest();
});

const emit = (event: Parameters<typeof emitTrustedDiagnosticEventWithPrivateData>[0]) =>
  emitTrustedDiagnosticEventWithPrivateData(event, {});

function spanNamed(spans: ReadableSpan[], name: string) {
  return spans.find((span) => span.name === name);
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
