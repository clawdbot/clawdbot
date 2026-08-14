import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type MockTaskFlowRecord = {
  flowId: string;
  syncMode: "managed";
  ownerKey: string;
  controllerId: string;
  status: string;
  stateJson: unknown;
  goal: string;
  currentStep: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};

const mockFlows = new Map<string, MockTaskFlowRecord>();
let flowIdCounter = 0;

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({
    agents: {
      defaults: {
        continuation: {
          enabled: true,
          maxChainLength: 10,
          maxDelegatesPerTurn: 5,
        },
      },
    },
  }),
}));

vi.mock("../../tasks/task-flow-registry.js", () => ({
  createManagedTaskFlow: vi.fn(
    (params: {
      ownerKey: string;
      controllerId: string;
      stateJson: unknown;
      goal: string;
      currentStep: string;
    }) => {
      const flowId = `flow-${++flowIdCounter}`;
      mockFlows.set(flowId, {
        flowId,
        syncMode: "managed",
        ownerKey: params.ownerKey,
        controllerId: params.controllerId,
        status: "queued",
        stateJson: params.stateJson,
        goal: params.goal,
        currentStep: params.currentStep,
        revision: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      return mockFlows.get(flowId);
    },
  ),
  listTaskFlowsForOwnerKey: vi.fn((ownerKey: string) =>
    [...mockFlows.values()].filter((flow) => flow.ownerKey === ownerKey),
  ),
  getTaskFlowById: vi.fn((flowId: string) => mockFlows.get(flowId)),
  updateFlowRecordByIdExpectedRevision: vi.fn(
    (params: { flowId: string; expectedRevision: number; patch: Record<string, unknown> }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return {
          applied: false,
          reason: flow ? "revision_conflict" : "not_found",
          current: flow ? { ...flow } : undefined,
        };
      }
      Object.assign(flow, params.patch);
      flow.revision += 1;
      return { applied: true, flow: { ...flow } };
    },
  ),
  finishFlow: vi.fn(
    (params: {
      flowId: string;
      expectedRevision: number;
      updatedAt?: number;
      endedAt?: number;
      stateJson?: unknown;
    }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return { applied: false, reason: flow ? "revision_conflict" : "not_found" };
      }
      flow.status = "succeeded";
      flow.stateJson = params.stateJson ?? flow.stateJson;
      flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
      flow.updatedAt = params.updatedAt ?? flow.endedAt;
      flow.revision += 1;
      return { applied: true, flow: { ...flow } };
    },
  ),
  failFlow: vi.fn((params: { flowId: string; updatedAt?: number; endedAt?: number }) => {
    const flow = mockFlows.get(params.flowId);
    if (flow) {
      flow.status = "failed";
      flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
      flow.updatedAt = flow.endedAt;
      flow.revision += 1;
    }
    return { applied: Boolean(flow) };
  }),
  deleteTaskFlowRecordById: vi.fn((flowId: string) => {
    mockFlows.delete(flowId);
  }),
}));

import { createContinueDelegateTool } from "../../agents/tools/continue-delegate-tool.js";
import {
  emitContinuationDelegateSpan,
  emitContinuationCompactionReleasedSpan,
  emitContinuationQueueDrainSpan,
  emitContinuationWorkSpan,
  getContinuationTracer,
  resetContinuationTracer,
  setContinuationTracer,
  type Span,
  type SpanAttributes,
  type SpanStatus,
  type StartSpanOptions,
  type Tracer,
} from "../../infra/continuation-tracer.js";
import {
  parseDiagnosticTraceparent,
  runWithDiagnosticTraceparent,
} from "../../infra/diagnostic-trace-context.js";
import {
  enqueueSessionDelivery,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
} from "../../infra/session-delivery-queue-storage.js";
import { recoverPendingSessionDeliveries } from "../../infra/session-delivery-queue-recovery.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { consumePendingDelegates, resetDelegateStoreForTests } from "./delegate-store.js";
import { enqueueContinuationReturnDeliveries } from "./targeting.js";

const rootTraceId = "0af7651916cd43dd8448eb211c80319c";
const rootSpanId = "1111111111111111";
const rootTraceparent = `00-${rootTraceId}-${rootSpanId}-01`;

type RecordedSpan = {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  inputTraceparent?: string;
  attributes?: SpanAttributes;
  statusCalls: Array<{ status: SpanStatus; message?: string }>;
  ended: boolean;
};

function spanIdForIndex(index: number): string {
  return index.toString(16).padStart(16, "0");
}

function createRecordingTracer(): { tracer: Tracer; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = [];
  const tracer: Tracer = {
    startSpan(name: string, options?: StartSpanOptions): Span {
      const parsed = parseDiagnosticTraceparent(options?.traceparent);
      const span: RecordedSpan = {
        name,
        traceId: parsed?.traceId ?? rootTraceId,
        spanId: spanIdForIndex(spans.length + 1),
        ...(parsed?.spanId ? { parentSpanId: parsed.spanId } : {}),
        ...(options?.traceparent ? { inputTraceparent: options.traceparent } : {}),
        ...(options?.attributes ? { attributes: options.attributes } : {}),
        statusCalls: [],
        ended: false,
      };
      spans.push(span);
      return {
        setAttributes(attrs) {
          span.attributes = span.attributes ? { ...span.attributes, ...attrs } : attrs;
        },
        setStatus(status, message) {
          span.statusCalls.push({ status, message });
        },
        recordException() {},
        end() {
          span.ended = true;
        },
      };
    },
  };
  return { tracer, spans };
}

function traceparentFromSpan(span: RecordedSpan): string {
  return `00-${span.traceId}-${span.spanId}-01`;
}

function startSyntheticChildSpan(name: string, traceparent: string): RecordedSpan {
  const span = getContinuationTracer().startSpan(name, { traceparent });
  span.setStatus("OK");
  span.end();
  const tracerState = getContinuationTracer() as unknown as { spans?: RecordedSpan[] };
  const spans = tracerState.spans;
  if (!spans?.length) {
    throw new Error("recording tracer did not expose spans");
  }
  return spans.at(-1)!;
}

function installRecordingTracer(): { spans: RecordedSpan[] } {
  const { tracer, spans } = createRecordingTracer();
  setContinuationTracer(Object.assign(tracer, { spans }));
  return { spans };
}

describe("continuation trace-context propagation integration", () => {
  beforeEach(() => {
    mockFlows.clear();
    flowIdCounter = 0;
    resetDelegateStoreForTests();
  });

  afterEach(() => {
    mockFlows.clear();
    resetDelegateStoreForTests();
    resetContinuationTracer();
  });

  it("carries one optional traceparent through work, delegate, compaction, targeted, fanout, and restart replay seams", async () => {
    const { spans } = installRecordingTracer();
    const sessionKey = "agent:main:root";
    let carriedTraceparent = rootTraceparent;

    emitContinuationWorkSpan({
      chainId: "chain-integration",
      chainStepRemaining: 10,
      delayMs: 0,
      reason: "continue traced work",
      traceparent: carriedTraceparent,
    });
    const workSpan = spans.at(-1)!;
    expect(workSpan.name).toBe("continuation.work");
    expect(workSpan.inputTraceparent).toBe(carriedTraceparent);
    expect(workSpan.traceId).toBe(rootTraceId);

    for (let hop = 1; hop <= 3; hop += 1) {
      const tool = createContinueDelegateTool({ agentSessionKey: sessionKey });
      await runWithDiagnosticTraceparent(carriedTraceparent, () =>
        tool.execute(`tool-${hop}`, {
          task: `hop ${hop}`,
          mode: "silent-wake",
          targetSessionKey: "agent:main:root",
        }),
      );
      const [delegate] = consumePendingDelegates(sessionKey);
      expect(delegate?.traceparent).toBe(carriedTraceparent);

      emitContinuationDelegateSpan({
        chainId: "chain-integration",
        chainStepRemaining: 10 - hop,
        delayMs: 0,
        delivery: "immediate",
        delegateMode: delegate?.mode ?? "silent-wake",
        reason: delegate?.task,
        traceparent: delegate?.traceparent,
      });
      const dispatchSpan = spans.at(-1)!;
      expect(dispatchSpan.name).toBe("continuation.delegate.dispatch");
      expect(dispatchSpan.inputTraceparent).toBe(carriedTraceparent);
      expect(dispatchSpan.traceId).toBe(rootTraceId);

      const childFirstSpan = startSyntheticChildSpan(`child.hop.${hop}.first`, carriedTraceparent);
      expect(childFirstSpan.traceId).toBe(rootTraceId);
      expect(childFirstSpan.parentSpanId).toBe(
        parseDiagnosticTraceparent(carriedTraceparent)?.spanId,
      );

      // Current substrate carries the upstream traceparent through spawn
      // metadata. A future span-context extraction seam can replace this with
      // traceparentFromSpan(dispatchSpan) without changing the queue contract.
      carriedTraceparent = delegate?.traceparent ?? traceparentFromSpan(dispatchSpan);
    }
    emitContinuationCompactionReleasedSpan({
      releasedCount: 1,
      compactionId: 1,
      traceparent: carriedTraceparent,
    });
    const compactionReleaseSpan = spans.at(-1)!;
    expect(compactionReleaseSpan.name).toBe("continuation.compaction.released");
    expect(compactionReleaseSpan.inputTraceparent).toBe(carriedTraceparent);
    expect(compactionReleaseSpan.traceId).toBe(rootTraceId);

    const enqueuedTargeted: QueuedSessionDeliveryPayload[] = [];
    const targetedSystemEvents: Array<{ sessionKey: string; traceparent?: string }> = [];
    await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: ["agent:main:root"],
        text: "[continuation:enrichment-return] targeted result",
        idempotencyKeyBase: "trace-integration:targeted",
        traceparent: carriedTraceparent,
        chainStepRemaining: 7,
      },
      {
        enqueueSessionDelivery: vi.fn(async (payload: QueuedSessionDeliveryPayload) => {
          enqueuedTargeted.push(payload);
          return `targeted-${enqueuedTargeted.length}`;
        }),
        ackSessionDelivery: vi.fn(async () => undefined),
        enqueueSystemEvent: vi.fn((_text, opts) => {
          targetedSystemEvents.push({
            sessionKey: opts.sessionKey,
            ...(opts.traceparent ? { traceparent: opts.traceparent } : {}),
          });
          return true;
        }),
        requestHeartbeatNow: vi.fn(),
      },
    );

    expect(enqueuedTargeted).toHaveLength(1);
    expect(expectDefined(enqueuedTargeted.at(0), "targeted delivery").traceparent).toBe(
      carriedTraceparent,
    );
    expect(targetedSystemEvents).toEqual([
      { sessionKey: "agent:main:root", traceparent: carriedTraceparent },
    ]);

    const fanoutTargets = ["agent:main:root", "agent:main:sibling", "agent:main:observer"];
    await enqueueContinuationReturnDeliveries(
      {
        targetSessionKeys: fanoutTargets,
        text: "[continuation:enrichment-return] broadcast result",
        idempotencyKeyBase: "trace-integration:fanout",
        traceparent: carriedTraceparent,
        fanoutMode: "all",
        chainStepRemaining: 7,
      },
      {
        enqueueSessionDelivery: vi.fn(async (_payload: QueuedSessionDeliveryPayload) => "fanout"),
        ackSessionDelivery: vi.fn(async () => undefined),
        enqueueSystemEvent: vi.fn(() => true),
        requestHeartbeatNow: vi.fn(),
      },
    );
    const fanoutSpan = spans.find((span) => span.name === "continuation.queue.fanout");
    expect(fanoutSpan).toBeDefined();
    expect(fanoutSpan?.inputTraceparent).toBe(carriedTraceparent);
    expect(fanoutSpan?.traceId).toBe(rootTraceId);
    expect(fanoutSpan?.attributes?.["fanout.recipient_count"]).toBe(3);
    expect(fanoutSpan?.attributes?.["fanout.recipient.outcomes"]).toEqual(
      fanoutTargets.map(() => "delivered"),
    );

    await withTestDir({ prefix: "openclaw-trace-replay-" }, async (tempDir) => {
      await enqueueSessionDelivery(
        {
          kind: "systemEvent",
          sessionKey: "agent:main:root",
          text: "[continuation:enrichment-return] replayed after restart",
          traceparent: carriedTraceparent,
        },
        tempDir,
      );
      const replayed: QueuedSessionDelivery[] = [];
      const summary = await recoverPendingSessionDeliveries({
        stateDir: tempDir,
        log: {
          info() {},
          warn() {},
          error() {},
        },
        deliver: async (entry) => {
          replayed.push(entry);
          emitContinuationQueueDrainSpan({
            drainedCount: 1,
            drainedContinuationCount: 1,
            ...(entry.traceparent ? { traceparent: entry.traceparent } : {}),
          });
        },
      });

      expect(summary.recovered).toBe(1);
      expect(replayed).toHaveLength(1);
      const replayedDelivery = expectDefined(replayed.at(0), "replayed delivery");
      expect(replayedDelivery.traceparent).toBe(carriedTraceparent);
      const wakeSideLink = parseDiagnosticTraceparent(replayedDelivery.traceparent);
      expect(wakeSideLink?.traceId).toBe(rootTraceId);
      expect(wakeSideLink?.spanId).toBe(parseDiagnosticTraceparent(carriedTraceparent)?.spanId);
    });

    const replayDrainSpan = spans.find((span) => span.name === "continuation.queue.drain");
    expect(replayDrainSpan?.inputTraceparent).toBe(carriedTraceparent);
    expect(replayDrainSpan?.traceId).toBe(rootTraceId);
    expect(spans.filter((span) => span.name === "continuation.delegate.dispatch")).toHaveLength(3);
    expect(spans.every((span) => span.traceId === rootTraceId)).toBe(true);
  });
});
