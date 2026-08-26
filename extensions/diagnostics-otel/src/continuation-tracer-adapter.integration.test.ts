import { context, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { runAgentLoop, type AgentMessage, type StreamFn } from "openclaw/plugin-sdk/agent-core";
import { wrapToolWithBeforeToolCallHook } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "openclaw/plugin-sdk/llm";
import {
  onTrustedInternalDiagnosticEvent,
  registerDiagnosticTracePropagationBridge,
  runWithDiagnosticTraceContext,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, test, vi } from "vitest";
// This test spans the core capture/scheduler and plugin resolution boundary.
// Production plugin code remains restricted to public Plugin SDK imports.
import {
  createContinueWorkTool,
  type ContinueWorkRequest,
} from "../../../src/agents/tools/continue-work-tool.js";
import type { ContinuationRuntimeConfig } from "../../../src/auto-reply/continuation/types.js";
import { executePendingContinuationWork } from "../../../src/auto-reply/continuation/work-dispatch-execution.js";
import {
  classifyContinuationWorkReason,
  resetContinuationWorkDispatchForTests,
  scheduleContinuationWorkBatch,
} from "../../../src/auto-reply/continuation/work-dispatch.js";
import { decodeWorkState } from "../../../src/auto-reply/continuation/work-flow-state.js";
import { consumePendingWork } from "../../../src/auto-reply/continuation/work-store.js";
import { resetSystemEventsForTest } from "../../../src/infra/system-events.js";
import { listTaskFlowsForOwnerKey } from "../../../src/tasks/task-flow-runtime-internal.js";
import { resetTaskFlowRegistryForTests } from "../../../src/tasks/task-runtime.test-helpers.js";
import {
  parseDiagnosticTraceparent,
  resetContinuationTracer,
  setContinuationTracer,
  type DiagnosticEventMetadata,
  type DiagnosticEventPayload,
  type DiagnosticTraceContext,
} from "../api.js";
import { createContinuationOtelTracerAdapter } from "./continuation-tracer-adapter.js";
import { resolveContentCapturePolicy } from "./service-content-normalization.js";
import { createDiagnosticsEventHandler } from "./service-events.js";
import { createDiagnosticsMetrics } from "./service-metrics.js";
import { createDiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import { createHarnessRecorders } from "./service-recorders-harness.js";
import { createModelRecorders } from "./service-recorders-model.js";
import { createOperationsRecorders } from "./service-recorders-operations.js";
import { createToolAndSystemRecorders } from "./service-recorders-tools.js";
import { createUsageRecorders } from "./service-recorders-usage.js";
import { createDiagnosticsTraceRuntime } from "./service-traces.js";

const OTEL_GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");
const SESSION_DIAGNOSTIC_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const HARNESS_SPAN_ID = "9999999999999999";
const PROOF_TURN_SPAN_IDS = ["2222222222222222", "3333333333333333"] as const;

function registeredContextManager() {
  return (
    globalThis as unknown as Record<
      symbol,
      { context?: Parameters<typeof context.setGlobalContextManager>[0] } | undefined
    >
  )[OTEL_GLOBAL_API_KEY]?.context;
}

test("parents owned-provider spans from active and carried trace context", async () => {
  const originalContextManager = registeredContextManager();
  context.disable();
  const contextManager = new AsyncLocalStorageContextManager().enable();
  expect(context.setGlobalContextManager(contextManager)).toBe(true);

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  try {
    const parent = provider.getTracer("test.parent").startSpan("parent");
    const parentContext = parent.spanContext();
    const continuationTracer = createContinuationOtelTracerAdapter({
      tracerProvider: provider,
    });

    context.with(trace.setSpan(context.active(), parent), () => {
      const activeChild = continuationTracer.startSpan("continuation.work");
      activeChild.end();
    });
    const carriedChild = continuationTracer.startSpan("continuation.work.fire", {
      traceparent: `00-${parentContext.traceId}-${parentContext.spanId}-01`,
    });
    carriedChild.end();
    parent.end();
    await provider.forceFlush();

    for (const name of ["continuation.work", "continuation.work.fire"]) {
      const child = exporter.getFinishedSpans().find((span) => span.name === name);
      expect(child?.spanContext().traceId).toBe(parentContext.traceId);
      expect(child?.parentSpanContext?.traceId).toBe(parentContext.traceId);
      expect(child?.parentSpanContext?.spanId).toBe(parentContext.spanId);
    }
  } finally {
    await provider.shutdown();
    if (registeredContextManager() !== originalContextManager) {
      context.disable();
      if (originalContextManager) {
        context.setGlobalContextManager(originalContextManager);
      }
    }
  }
});

// Simulates a full continue_delegate round trip against a real SDK: the
// originating tool span dispatches, the dispatch traceparent is serialized
// across the hop, and the far side re-enters from that string alone. The
// trusted-span registry is forced to resolve nothing because it is
// process-local and capacity-evicted, so it cannot be what keeps a delegate
// stitched. Regression guard for orphaned continuation spans.
test("keeps one trace across a continue_delegate out-and-back hop", async () => {
  const originalContextManager = registeredContextManager();
  context.disable();
  const contextManager = new AsyncLocalStorageContextManager().enable();
  expect(context.setGlobalContextManager(contextManager)).toBe(true);

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  try {
    const continuationTracer = createContinuationOtelTracerAdapter({
      tracerProvider: provider,
      resolveSpanContext: () => undefined,
    });

    // Leaving: the continue_delegate tool call is the active span.
    const toolSpan = provider.getTracer("test.delegate").startSpan("continue_delegate.tool");
    const toolContext = toolSpan.spanContext();

    const carried = context.with(trace.setSpan(context.active(), toolSpan), () => {
      const dispatch = continuationTracer.startSpan("continuation.delegate.dispatch");
      const dispatchTraceparent = dispatch.traceparent?.();
      dispatch.end();
      return dispatchTraceparent;
    });
    toolSpan.end();

    expect(carried).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    expect(carried).toContain(toolContext.traceId);

    // Coming back: only the serialized traceparent survived the hop, and the
    // originating span is already ended and out of the active context.
    expect(carried).toBeDefined();
    const fire = continuationTracer.startSpan("continuation.delegate.fire", {
      traceparent: carried,
    });
    fire.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const dispatchSpan = spans.find((span) => span.name === "continuation.delegate.dispatch");
    const fireSpan = spans.find((span) => span.name === "continuation.delegate.fire");

    // One trace end to end.
    expect(dispatchSpan?.spanContext().traceId).toBe(toolContext.traceId);
    expect(fireSpan?.spanContext().traceId).toBe(toolContext.traceId);
    // Dispatch hangs off the originating tool span, and the far side hangs off
    // dispatch rather than starting a new root.
    expect(dispatchSpan?.parentSpanContext?.spanId).toBe(toolContext.spanId);
    expect(fireSpan?.parentSpanContext?.spanId).toBe(dispatchSpan?.spanContext().spanId);
  } finally {
    await provider.shutdown();
    if (registeredContextManager() !== originalContextManager) {
      context.disable();
      if (originalContextManager) {
        context.setGlobalContextManager(originalContextManager);
      }
    }
  }
});

const CONTINUATION_TURN_PLANS = [
  {
    chainId: "11111111-1111-4111-8111-111111111111",
    reason: "finish the first turn's follow-up work",
    runId: "run-turn-one",
    sessionKey: "agent:main:otel-boundary-one",
    spanId: PROOF_TURN_SPAN_IDS[0],
    toolCallId: "call-turn-one",
  },
  {
    chainId: "22222222-2222-4222-8222-222222222222",
    reason: "finish the second turn's follow-up work",
    runId: "run-turn-two",
    sessionKey: "agent:main:otel-boundary-two",
    spanId: PROOF_TURN_SPAN_IDS[1],
    toolCallId: "call-turn-two",
  },
] as const;

const CONTINUATION_RUNTIME_CONFIG: ContinuationRuntimeConfig = {
  enabled: true,
  defaultDelayMs: 1_000,
  minDelayMs: 0,
  maxDelayMs: 1_000,
  maxChainLength: 8,
  costCapTokens: 1_000_000,
  maxDelegatesPerTurn: 5,
  maxPendingWork: 4,
  crossSessionTargeting: "disabled",
};

const CONTINUATION_RETRY_POLICY = {
  busyRetryDelayMs: 1_000,
  idleRetryHedgeMs: 1_000,
  mainCommandLane: "main",
} as const;

function installProductionDiagnostics(provider: BasicTracerProvider) {
  const traces = createDiagnosticsTraceRuntime(provider.getTracer("openclaw"));
  const recorderRuntime = createDiagnosticsRecorderRuntime({
    contentCapturePolicy: resolveContentCapturePolicy(undefined),
    metrics: createDiagnosticsMetrics(metrics.getMeter("openclaw")),
    traces,
    tracesEnabled: true,
  });
  const recorders = {
    ...createUsageRecorders(recorderRuntime),
    ...createOperationsRecorders(recorderRuntime),
    ...createHarnessRecorders(recorderRuntime),
    ...createModelRecorders(recorderRuntime),
    ...createToolAndSystemRecorders(recorderRuntime),
  };
  const handler = createDiagnosticsEventHandler({
    logger: {
      debug() {},
      error() {},
      info() {},
      warn() {},
    },
    recorders,
    recordLogRecord: undefined,
    recordSecurityEvent: undefined,
  });
  const unsubscribe = onTrustedInternalDiagnosticEvent(handler);
  const tracePropagationBridge = {
    shouldPrepareEvent(event: DiagnosticEventPayload) {
      return event.type === "model.call.started" || event.type === "tool.execution.started";
    },
    prepareEvent(event: DiagnosticEventPayload, metadata: DiagnosticEventMetadata) {
      if (event.type === "model.call.started") {
        recorders.recordModelCallStarted(event, metadata);
      } else if (event.type === "tool.execution.started") {
        recorders.recordToolExecutionStarted(event, metadata);
      }
    },
    resolveTraceContext(traceContext: DiagnosticTraceContext) {
      const spanContext = traces.exportedSpanContextForDiagnosticTraceContext(traceContext);
      return spanContext
        ? {
            traceId: spanContext.traceId,
            spanId: spanContext.spanId,
            traceFlags: spanContext.traceFlags.toString(16).padStart(2, "0"),
          }
        : undefined;
    },
  };
  const unregisterTracePropagationBridge =
    registerDiagnosticTracePropagationBridge(tracePropagationBridge);
  const continuationTracer = createContinuationOtelTracerAdapter({
    tracerProvider: provider,
    resolveSpanContext: traces.resolveTrustedSpanContext,
    resolveParentContext: traces.resolveTrustedParentContext,
  });
  setContinuationTracer(continuationTracer);
  return {
    traces,
    stop() {
      unregisterTracePropagationBridge();
      unsubscribe();
      resetContinuationTracer();
    },
  };
}

function exportedSpans(exporter: InMemorySpanExporter, name: string) {
  return exporter.getFinishedSpans().filter((span) => span.name === name);
}

function spanForChain(exporter: InMemorySpanExporter, name: string, chainId: string) {
  const span = exportedSpans(exporter, name).find(
    (candidate) => candidate.attributes["chain.id"] === chainId,
  );
  if (!span) {
    throw new Error(`expected an exported ${name} span for chain ${chainId}`);
  }
  return span;
}

function queuedWorkTraceparent(sessionKey: string): string | undefined {
  const queued = listTaskFlowsForOwnerKey(sessionKey).find((flow) => flow.status === "queued");
  return queued ? decodeWorkState(queued)?.traceparent : undefined;
}

const TEST_MODEL: Model = {
  id: "typed-continuation-proof",
  name: "Typed continuation proof",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 1_000,
};

const TEST_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function createTypedContinuationStream(plan: (typeof CONTINUATION_TURN_PLANS)[number]): StreamFn {
  let call = 0;
  return () => {
    call += 1;
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content:
        call === 1
          ? [
              {
                type: "toolCall",
                id: plan.toolCallId,
                name: "continue_work",
                arguments: { reason: plan.reason, delaySeconds: 1 },
              },
            ]
          : [{ type: "text", text: "scheduled" }],
      api: TEST_MODEL.api,
      provider: TEST_MODEL.provider,
      model: TEST_MODEL.id,
      usage: TEST_USAGE,
      stopReason: call === 1 ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
    queueMicrotask(() => {
      stream.push({
        type: "done",
        reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
        message,
      });
      stream.end();
    });
    return stream;
  };
}

async function runTypedContinuationTurn(params: {
  harnessTrace: DiagnosticTraceContext;
  plan: (typeof CONTINUATION_TURN_PLANS)[number];
  traces: ReturnType<typeof createDiagnosticsTraceRuntime>;
}) {
  const runTrace: DiagnosticTraceContext = {
    traceId: SESSION_DIAGNOSTIC_TRACE_ID,
    spanId: params.plan.spanId,
    parentSpanId: params.harnessTrace.spanId,
    traceFlags: "01",
  };
  emitTrustedDiagnosticEvent({
    type: "run.started",
    runId: params.plan.runId,
    sessionKey: params.plan.sessionKey,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    trace: runTrace,
  });
  const runSpanContext = params.traces.resolveTrustedSpanContext(runTrace);
  if (!runSpanContext) {
    throw new Error(`expected an exported run span for ${params.plan.runId}`);
  }

  const requests: ContinueWorkRequest[] = [];
  const tool = wrapToolWithBeforeToolCallHook(
    createContinueWorkTool({
      agentSessionKey: params.plan.sessionKey,
      requestContinuation: (request) => requests.push(request),
    }),
    {
      runId: params.plan.runId,
      sessionKey: params.plan.sessionKey,
      trace: runTrace,
    },
  );
  await runWithDiagnosticTraceContext(params.harnessTrace, () =>
    runAgentLoop(
      [{ role: "user", content: params.plan.reason, timestamp: Date.now() }],
      { systemPrompt: "", messages: [], tools: [tool] },
      {
        model: TEST_MODEL,
        convertToLlm: (messages: AgentMessage[]) => messages as never,
      },
      () => {},
      undefined,
      createTypedContinuationStream(params.plan),
    ),
  );
  await waitForDiagnosticEventsDrained();
  if (requests.length !== 1) {
    throw new Error(`expected one typed continuation request, got ${requests.length}`);
  }

  const batch = await scheduleContinuationWorkBatch({
    sessionKey: params.plan.sessionKey,
    chainState: {
      currentChainCount: 0,
      chainStartedAt: Date.now(),
      accumulatedChainTokens: 0,
      chainId: params.plan.chainId,
    },
    requests,
    config: CONTINUATION_RUNTIME_CONFIG,
  });
  if (batch.scheduledCount !== 1) {
    throw new Error(`expected one scheduled continuation wake, got ${batch.scheduledCount}`);
  }
  const persisted = queuedWorkTraceparent(params.plan.sessionKey);
  emitTrustedDiagnosticEvent({
    type: "run.completed",
    runId: params.plan.runId,
    sessionKey: params.plan.sessionKey,
    provider: TEST_MODEL.provider,
    model: TEST_MODEL.id,
    durationMs: 1,
    outcome: "completed",
    trace: runTrace,
  });

  return {
    persisted,
    runSpanContext,
  };
}

test("exports the typed-tool origin through delayed TaskFlow restart", async () => {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-typed-tool-trace-" },
    async () => {
      vi.useFakeTimers({ now: 1_780_000_000_000, toFake: ["Date", "setTimeout", "clearTimeout"] });
      const originalContextManager = registeredContextManager();
      context.disable();
      const contextManager = new AsyncLocalStorageContextManager().enable();
      expect(context.setGlobalContextManager(contextManager)).toBe(true);

      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(exporter)],
      });
      resetDiagnosticEventsForTest();
      resetTaskFlowRegistryForTests();
      const diagnostics = installProductionDiagnostics(provider);
      try {
        const harnessTrace: DiagnosticTraceContext = {
          traceId: SESSION_DIAGNOSTIC_TRACE_ID,
          spanId: HARNESS_SPAN_ID,
          traceFlags: "01",
        };
        emitTrustedDiagnosticEvent({
          type: "harness.run.started",
          runId: "harness-shared",
          harnessId: "openclaw",
          trace: harnessTrace,
        });
        const harnessSpanContext = diagnostics.traces.resolveTrustedSpanContext(harnessTrace);
        if (!harnessSpanContext) {
          throw new Error("expected an exported harness span");
        }

        const turns = [];
        for (const plan of CONTINUATION_TURN_PLANS) {
          turns.push(
            await runTypedContinuationTurn({
              harnessTrace,
              plan,
              traces: diagnostics.traces,
            }),
          );
        }

        resetContinuationWorkDispatchForTests();
        resetTaskFlowRegistryForTests({ persist: false });
        await vi.advanceTimersByTimeAsync(1_000);

        for (const [index, turn] of turns.entries()) {
          const plan = CONTINUATION_TURN_PLANS[index];
          if (!plan) {
            throw new Error(`missing continuation turn plan ${index}`);
          }
          expect(queuedWorkTraceparent(plan.sessionKey)).toBe(turn.persisted);
          const [claimed] = consumePendingWork(plan.sessionKey);
          if (!claimed) {
            throw new Error(`expected restored continuation work for ${plan.sessionKey}`);
          }
          await executePendingContinuationWork(
            claimed,
            {
              ...CONTINUATION_RETRY_POLICY,
              reasonCategory: classifyContinuationWorkReason(claimed.reason),
            },
            new AbortController().signal,
          );
        }

        emitTrustedDiagnosticEvent({
          type: "harness.run.completed",
          runId: "harness-shared",
          harnessId: "openclaw",
          durationMs: 1,
          outcome: "completed",
          trace: harnessTrace,
        });
        await waitForDiagnosticEventsDrained();

        const toolSpans = exportedSpans(exporter, "openclaw.tool.execution").filter(
          (span) => span.attributes["gen_ai.tool.name"] === "continue_work",
        );
        expect(toolSpans).toHaveLength(CONTINUATION_TURN_PLANS.length);
        for (const [index, turn] of turns.entries()) {
          const plan = CONTINUATION_TURN_PLANS[index];
          if (!plan) {
            throw new Error(`missing continuation turn plan ${index}`);
          }
          const toolSpan = toolSpans.find(
            (span) => span.parentSpanContext?.spanId === turn.runSpanContext.spanId,
          );
          if (!toolSpan) {
            throw new Error(`expected the originating tool span for ${plan.runId}`);
          }
          expect(turn.runSpanContext.traceId).toBe(harnessSpanContext.traceId);
          expect(toolSpan.parentSpanContext?.spanId).toBe(turn.runSpanContext.spanId);
          const persistedSpanId = parseDiagnosticTraceparent(turn.persisted)?.spanId;
          expect(
            persistedSpanId,
            "typed continuation must not bypass its tool span through the harness scope",
          ).not.toBe(harnessSpanContext.spanId);
          expect(
            persistedSpanId,
            "typed continuation must not bypass its tool span through the run scope",
          ).not.toBe(turn.runSpanContext.spanId);
          expect(persistedSpanId, "typed continuation must carry the originating tool span").toBe(
            toolSpan.spanContext().spanId,
          );
          for (const name of ["continuation.work", "continuation.work.fire"]) {
            const span = spanForChain(exporter, name, plan.chainId);
            expect(span.spanContext().traceId).toBe(toolSpan.spanContext().traceId);
            expect(span.parentSpanContext?.spanId).toBe(toolSpan.spanContext().spanId);
          }
        }
        expect(new Set(turns.map((turn) => turn.runSpanContext.spanId)).size).toBe(2);
        expect(new Set(toolSpans.map((span) => span.spanContext().spanId)).size).toBe(2);
        expect(new Set(turns.map((turn) => turn.persisted)).size).toBe(2);
      } finally {
        diagnostics.stop();
        resetContinuationWorkDispatchForTests();
        resetTaskFlowRegistryForTests();
        resetSystemEventsForTest();
        resetDiagnosticEventsForTest();
        diagnostics.traces.stopActiveTrustedSpans();
        await provider.shutdown();
        vi.useRealTimers();
        if (registeredContextManager() !== originalContextManager) {
          context.disable();
          if (originalContextManager) {
            context.setGlobalContextManager(originalContextManager);
          }
        }
      }
    },
  );
});
