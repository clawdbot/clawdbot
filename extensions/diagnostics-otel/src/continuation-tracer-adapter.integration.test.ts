import { context, metrics, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { runWithDiagnosticTraceContext } from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, test } from "vitest";
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
import { createDiagnosticsMetrics } from "./service-metrics.js";
import { createDiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import { createHarnessRecorders } from "./service-recorders-harness.js";
import { createUsageRecorders } from "./service-recorders-usage.js";
import { createDiagnosticsTraceRuntime } from "./service-traces.js";

const OTEL_GLOBAL_API_KEY = Symbol.for("opentelemetry.js.api.1");
const SESSION_DIAGNOSTIC_TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const OLDER_TURN_ROOT_SPAN_ID = "9999999999999999";
const TURN_ANCESTOR_SPAN_ID = "1111111111111111";
const PROOF_TURN_SPAN_IDS = ["2222222222222222", "3333333333333333"] as const;

type DiagnosticEventOfType<T extends DiagnosticEventPayload["type"]> = Extract<
  DiagnosticEventPayload,
  { type: T }
>;

const TRUSTED_EVENT_METADATA: DiagnosticEventMetadata = { trusted: true };

function olderTurnRootTrace(): DiagnosticTraceContext {
  return {
    traceId: SESSION_DIAGNOSTIC_TRACE_ID,
    spanId: OLDER_TURN_ROOT_SPAN_ID,
    traceFlags: "01",
  };
}

function messageDispatchStartedEvent(
  traceContext: DiagnosticTraceContext,
): DiagnosticEventOfType<"message.dispatch.started"> {
  return {
    type: "message.dispatch.started",
    ts: Date.now(),
    seq: 1,
    channel: "test",
    source: "test",
    trace: traceContext,
  };
}

function messageProcessedEvent(
  traceContext: DiagnosticTraceContext,
): DiagnosticEventOfType<"message.processed"> {
  return {
    type: "message.processed",
    ts: Date.now(),
    seq: 2,
    channel: "test",
    outcome: "completed",
    durationMs: 1,
    trace: traceContext,
  };
}

function harnessRunStartedEvent(
  runId: string,
  traceContext: DiagnosticTraceContext,
): DiagnosticEventOfType<"harness.run.started"> {
  return {
    type: "harness.run.started",
    ts: Date.now(),
    seq: 3,
    runId,
    harnessId: "openclaw",
    trace: traceContext,
  };
}

function harnessRunCompletedEvent(
  runId: string,
  traceContext: DiagnosticTraceContext,
): DiagnosticEventOfType<"harness.run.completed"> {
  return {
    type: "harness.run.completed",
    ts: Date.now(),
    seq: 4,
    runId,
    harnessId: "openclaw",
    durationMs: 1,
    outcome: "completed",
    trace: traceContext,
  };
}

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

const CONTINUATION_WORK_SESSION_KEY = "agent:main:otel-boundary";
const CONTINUATION_TURN_PLANS = [
  { chainId: "chain-turn-one", runId: "run-turn-one", spanId: PROOF_TURN_SPAN_IDS[0] },
  { chainId: "chain-turn-two", runId: "run-turn-two", spanId: PROOF_TURN_SPAN_IDS[1] },
] as const;

const CONTINUATION_RUNTIME_CONFIG: ContinuationRuntimeConfig = {
  enabled: true,
  defaultDelayMs: 0,
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
  setContinuationTracer(
    createContinuationOtelTracerAdapter({
      tracerProvider: provider,
      resolveSpanContext: traces.resolveTrustedSpanContext,
      resolveParentContext: traces.resolveTrustedParentContext,
    }),
  );
  return {
    traces,
    recorders: {
      ...createUsageRecorders(recorderRuntime),
      ...createHarnessRecorders(recorderRuntime),
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

function durableQueuedWorkTraceparent(sessionKey: string): string | undefined {
  const queued = listTaskFlowsForOwnerKey(sessionKey).find((flow) => flow.status === "queued");
  return queued ? decodeWorkState(queued)?.traceparent : undefined;
}

async function runProductionContinuationTurn(params: {
  exporter: InMemorySpanExporter;
  recorders: ReturnType<typeof installProductionDiagnostics>["recorders"];
  plan: (typeof CONTINUATION_TURN_PLANS)[number];
}) {
  const runTrace: DiagnosticTraceContext = {
    traceId: SESSION_DIAGNOSTIC_TRACE_ID,
    spanId: params.plan.spanId,
    // This logical ancestor is absent from every exact registry tier, forcing
    // ancestor capture through the first-trusted-span fallback.
    parentSpanId: TURN_ANCESTOR_SPAN_ID,
    traceFlags: "01",
  };
  params.recorders.recordHarnessRunStarted(
    harnessRunStartedEvent(params.plan.runId, runTrace),
    TRUSTED_EVENT_METADATA,
  );

  const requests: ContinueWorkRequest[] = [];
  const tool = createContinueWorkTool({
    agentSessionKey: CONTINUATION_WORK_SESSION_KEY,
    requestContinuation: (request) => requests.push(request),
  });
  await runWithDiagnosticTraceContext(runTrace, () =>
    tool.execute("call-1", { reason: "finish this turn's follow-up work" }),
  );

  const batch = await scheduleContinuationWorkBatch({
    sessionKey: CONTINUATION_WORK_SESSION_KEY,
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
  const durableTraceparent = durableQueuedWorkTraceparent(CONTINUATION_WORK_SESSION_KEY);

  params.recorders.recordHarnessRunCompleted(
    harnessRunCompletedEvent(params.plan.runId, runTrace),
    TRUSTED_EVENT_METADATA,
    {},
  );
  const runSpan = exportedSpans(params.exporter, "openclaw.harness.run").at(-1);
  if (!runSpan) {
    throw new Error("expected the recorder to export this turn's harness run span");
  }

  const [claimed] = consumePendingWork(CONTINUATION_WORK_SESSION_KEY);
  if (!claimed) {
    throw new Error("expected the durable continuation row to be claimable");
  }
  await executePendingContinuationWork(
    claimed,
    {
      ...CONTINUATION_RETRY_POLICY,
      reasonCategory: classifyContinuationWorkReason(claimed.reason),
    },
    new AbortController().signal,
  );

  return {
    runSpanContext: runSpan.spanContext(),
    persisted: claimed.traceparent,
    durableTraceparent,
  };
}

test("keeps a typed continuation tool's dispatch and fire on its executing turn's span", async () => {
  const originalContextManager = registeredContextManager();
  context.disable();
  const contextManager = new AsyncLocalStorageContextManager().enable();
  expect(context.setGlobalContextManager(contextManager)).toBe(true);

  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  resetTaskFlowRegistryForTests({ persist: false });
  const { traces, recorders } = installProductionDiagnostics(provider);
  try {
    const olderRootTrace = olderTurnRootTrace();
    recorders.recordMessageDispatchStarted(
      messageDispatchStartedEvent(olderRootTrace),
      TRUSTED_EVENT_METADATA,
    );
    recorders.recordMessageProcessed(messageProcessedEvent(olderRootTrace), TRUSTED_EVENT_METADATA);
    const olderRootSpan = exportedSpans(exporter, "openclaw.message.processed").at(0);
    if (!olderRootSpan) {
      throw new Error("expected the recorder to export the older turn's root message span");
    }
    const olderRootSpanContext = olderRootSpan.spanContext();

    const turns = [];
    for (const plan of CONTINUATION_TURN_PLANS) {
      turns.push(await runProductionContinuationTurn({ exporter, recorders, plan }));
    }
    const firstTurn = turns[0];
    const secondTurn = turns[1];
    if (!firstTurn || !secondTurn) {
      throw new Error("expected two recorded continuation turns");
    }

    const ancestorResolution = traces.resolveTrustedSpanContext({
      traceId: SESSION_DIAGNOSTIC_TRACE_ID,
      spanId: TURN_ANCESTOR_SPAN_ID,
      traceFlags: "01",
    });
    await provider.forceFlush();

    expect(ancestorResolution?.spanId).toBe(olderRootSpanContext.spanId);
    expect(turns.map((turn) => parseDiagnosticTraceparent(turn.persisted)?.spanId)).not.toContain(
      olderRootSpanContext.spanId,
    );

    for (const [index, turn] of turns.entries()) {
      const plan = CONTINUATION_TURN_PLANS[index];
      if (!plan) {
        throw new Error(`missing continuation turn plan ${index}`);
      }
      const expectedTraceparent = `00-${turn.runSpanContext.traceId}-${turn.runSpanContext.spanId}-01`;
      expect(turn.persisted).toBe(expectedTraceparent);
      expect(turn.durableTraceparent).toBe(expectedTraceparent);
      for (const name of ["continuation.work", "continuation.work.fire"]) {
        const span = spanForChain(exporter, name, plan.chainId);
        expect(span.spanContext().traceId).toBe(turn.runSpanContext.traceId);
        expect(span.parentSpanContext?.spanId).toBe(turn.runSpanContext.spanId);
      }
    }

    expect(secondTurn.runSpanContext.spanId).not.toBe(firstTurn.runSpanContext.spanId);
    expect(secondTurn.persisted).not.toBe(firstTurn.persisted);
  } finally {
    resetContinuationTracer();
    resetContinuationWorkDispatchForTests();
    resetTaskFlowRegistryForTests({ persist: false });
    resetSystemEventsForTest();
    traces.stopActiveTrustedSpans();
    await provider.shutdown();
    if (registeredContextManager() !== originalContextManager) {
      context.disable();
      if (originalContextManager) {
        context.setGlobalContextManager(originalContextManager);
      }
    }
  }
});
