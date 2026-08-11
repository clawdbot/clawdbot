import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const turnGrants: unknown[] = [];
const systemEvents: unknown[] = [];
const activeQueueDeliveries: unknown[] = [];
const workTransitionEvents: string[] = [];
const replyRegistryReceivers = new Set<unknown>();
const activeSessions = new Set<string>();
const replyIdleWaiters = new Map<string, Array<(idle: boolean) => void>>();
const laneIdleWaiters = new Map<string, Array<(idle: boolean) => void>>();
let mainQueueSize = 0;
let gatewayDraining = false;
let replyError: Error | undefined;
let commandLaneIdleError: Error | undefined;
let drainAfterReply = false;
let replyPayloadOverride: unknown;
let activeQueueMode: "delivered" | "queued-without-proof" | "rejected" = "delivered";
let activeQueueHandleAvailable = true;
const mockSessionStore: Record<string, unknown> = {};
const loadSessionEntryMock = vi.fn();
let mockStorePath = "test-store";
let observeSubordinateAdmission = false;
const observedSubordinateAdmissionClosed: boolean[] = [];
// test state: toggle continuation enablement (disabled-gate), capture the
// active diagnostic traceparent at reply time (traceparent re-entry), and force
// a revision race after the turn ran (failed durable delivered-mark).
let continuationEnabledForTest = true;
const capturedReplyTraceparents: Array<string | undefined> = [];
let bumpWorkRevisionOnReply = false;
const { emitContinuationWorkFireSpanMock, resolveContinuationTraceparentMock } = vi.hoisted(() => ({
  emitContinuationWorkFireSpanMock: vi.fn(),
  resolveContinuationTraceparentMock: vi.fn((traceparent: string | undefined) => traceparent),
}));

function removeWaiter(
  waiters: Map<string, Array<(idle: boolean) => void>>,
  key: string,
  waiter: (idle: boolean) => void,
): void {
  const current = waiters.get(key);
  if (!current) {
    return;
  }
  const index = current.indexOf(waiter);
  if (index >= 0) {
    current.splice(index, 1);
  }
  if (current.length === 0) {
    waiters.delete(key);
  }
}

function waitForMockIdle(
  waiters: Map<string, Array<(idle: boolean) => void>>,
  key: string,
  isIdle: () => boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  if (isIdle()) {
    return Promise.resolve(true);
  }
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    let settled = false;
    let abortHandler: (() => void) | undefined;
    const finish = (idle: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      removeWaiter(waiters, key, finish);
      if (abortHandler) {
        signal?.removeEventListener("abort", abortHandler);
      }
      resolve(idle);
    };
    const current = waiters.get(key) ?? [];
    current.push(finish);
    waiters.set(key, current);
    if (signal) {
      abortHandler = () => finish(false);
      signal.addEventListener("abort", abortHandler, { once: true });
    }
  });
}

function resolveReplyRunIdle(sessionKey: string): void {
  activeSessions.delete(sessionKey);
  const waiters = replyIdleWaiters.get(sessionKey) ?? [];
  for (const finish of Array.from(waiters)) {
    finish(true);
  }
}

function resolveCommandLaneIdle(lane = "main"): void {
  mainQueueSize = 0;
  const waiters = laneIdleWaiters.get(lane) ?? [];
  for (const finish of Array.from(waiters)) {
    finish(true);
  }
}

async function flushAsyncWork(iterations = 8): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

async function waitForMockWaiter(
  waiters: Map<string, Array<(idle: boolean) => void>>,
  key: string,
): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if ((waiters.get(key)?.length ?? 0) > 0) {
      return;
    }
    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();
  }
  throw new Error(`expected idle waiter for ${key}`);
}

async function waitForTurnGrantCount(count: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (turnGrants.length >= count) {
      return;
    }
    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();
  }
  throw new Error(`expected at least ${count} turn grant(s), got ${turnGrants.length}`);
}

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: () => ({ session: { store: "test-store" } }),
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveSessionStorePathCore: () => mockStorePath,
}));

vi.mock("../../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/sessions/session-accessor.js")>()),
  loadSessionEntry: (scope: { sessionKey: string }) => loadSessionEntryMock(scope),
}));

vi.mock("../../sessions/session-key-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sessions/session-key-utils.js")>()),
  parseAgentSessionKey: (sessionKey: string) => {
    const match = /^agent:([^:]+)/.exec(sessionKey);
    return match ? { agentId: match[1] } : undefined;
  },
  isSubagentSessionKey: (sessionKey: string) => {
    if (typeof sessionKey !== "string" || sessionKey.length === 0) {
      return false;
    }
    const lower = sessionKey.toLowerCase();
    if (lower.startsWith("subagent:")) {
      return true;
    }
    return lower.replace(/^agent:[^:]+:/, "").startsWith("subagent:");
  },
}));

vi.mock("../reply/reply-run-registry.js", () => ({
  replyRunRegistry: {
    isActive(sessionKey: string) {
      replyRegistryReceivers.add(this);
      return activeSessions.has(sessionKey);
    },
    resolveSessionId(sessionKey: string) {
      replyRegistryReceivers.add(this);
      return activeSessions.has(sessionKey) ? `active-session:${sessionKey}` : undefined;
    },
    waitForIdle(sessionKey: string, _timeoutMs?: number, opts?: { signal?: AbortSignal }) {
      replyRegistryReceivers.add(this);
      return waitForMockIdle(
        replyIdleWaiters,
        sessionKey,
        () => !activeSessions.has(sessionKey),
        opts?.signal,
      );
    },
  },
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  isEmbeddedAgentRunHandleActive: vi.fn(() => activeQueueHandleAvailable),
  queueEmbeddedAgentMessageWithOutcomeAsync: vi.fn(async (sessionId: string, text: string) => {
    workTransitionEvents.push("fold-transcript-committed");
    activeQueueDeliveries.push({ sessionId, text });
    if (activeQueueMode === "delivered") {
      return {
        queued: true,
        sessionId,
        target: "embedded_run" as const,
        gatewayHealth: "live" as const,
        enqueuedAtMs: Date.now(),
        deliveredAtMs: Date.now(),
      };
    }
    if (activeQueueMode === "queued-without-proof") {
      return {
        queued: true,
        sessionId,
        target: "reply_run" as const,
        gatewayHealth: "live" as const,
        enqueuedAtMs: Date.now(),
      };
    }
    return {
      queued: false,
      sessionId,
      reason: "no_active_run" as const,
      gatewayHealth: "live" as const,
    };
  }),
}));

vi.mock("../../process/command-queue.js", () => ({
  getQueueSize: () => mainQueueSize,
  isGatewayDraining: () => gatewayDraining,
  waitForCommandLaneIdle: async (
    lane = "main",
    _timeoutMs?: number,
    opts?: { signal?: AbortSignal },
  ) => ({
    idle: await (async () => {
      if (commandLaneIdleError) {
        throw commandLaneIdleError;
      }
      return await waitForMockIdle(laneIdleWaiters, lane, () => mainQueueSize <= 0, opts?.signal);
    })(),
  }),
}));

vi.mock("../reply/get-reply.js", () => ({
  getReplyFromConfig: vi.fn(async (context: unknown, options: unknown, cfg: unknown) => {
    workTransitionEvents.push("provider-called");
    if (observeSubordinateAdmission) {
      const { isGatewaySubordinateWorkAdmissionClosed } =
        await import("../../process/gateway-work-admission.js");
      observedSubordinateAdmissionClosed.push(isGatewaySubordinateWorkAdmissionClosed());
    }
    // Capture the active diagnostic traceparent so tests can assert the
    // continuation turn re-enters the persisted work.traceparent.
    const { formatActiveDiagnosticTraceparent } =
      await import("../../infra/diagnostic-trace-context.js");
    capturedReplyTraceparents.push(formatActiveDiagnosticTraceparent());
    // Simulate a revision/cancel race landing between claim and delivered-mark:
    // bump every continuation-work flow revision so markPendingWorkDelivered
    // fails its expected-revision check after the turn already ran.
    if (bumpWorkRevisionOnReply) {
      for (const flow of mockFlows.values()) {
        if (flow.controllerId === "core/continuation-work") {
          flow.revision += 1;
        }
      }
    }
    if (replyError) {
      throw replyError;
    }
    if (replyPayloadOverride !== undefined) {
      if (drainAfterReply) {
        gatewayDraining = true;
      }
      return replyPayloadOverride;
    }
    turnGrants.push({ context, options, cfg });
    if (drainAfterReply) {
      gatewayDraining = true;
    }
    return [{ text: "ok" }];
  }),
}));

vi.mock("../../infra/heartbeat-runner.js", () => {
  throw new Error("continuation_work dispatch must not use the heartbeat runner");
});

vi.mock("../../infra/heartbeat-wake.js", () => ({
  isRetryableHeartbeatBusySkipReason: (reason: string) => reason === "requests-in-flight",
  requestHeartbeatNow: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (text: string, options: unknown) => {
    systemEvents.push({ text, options });
  },
}));

vi.mock("../../infra/continuation-tracer.js", () => ({
  emitContinuationWorkFireSpan: emitContinuationWorkFireSpanMock,
  emitContinuationWorkSpan: vi.fn(),
  resolveContinuationTraceparent: resolveContinuationTraceparentMock,
}));

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    resolveContinuationRuntimeConfig: () => ({
      enabled: continuationEnabledForTest,
      maxChainLength: 8,
      maxDelegatesPerTurn: 4,
      maxPendingWork: 32,
      defaultDelayMs: 1_000,
      minDelayMs: 1_000,
      maxDelayMs: 60_000,
      costCapTokens: 0,
      crossSessionTargeting: "enabled",
      busySkipBackoff: { baseMs: 1_000, ceilingMs: 60_000, factor: 2 },
    }),
  };
});

vi.mock("../../logging/subsystem.js", () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { createSubsystemLogger: () => logger };
});

type MockFlow = {
  flowId: string;
  syncMode: "managed";
  ownerKey: string;
  chainId?: string;
  controllerId: string;
  status: "queued" | "running" | "succeeded" | "failed";
  notifyPolicy: "silent";
  goal: string;
  currentStep?: string;
  stateJson?: unknown;
  revision: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
  cancelRequestedAt?: number;
};

const mockFlows = new Map<string, MockFlow>();
let flowCounter = 0;

function cloneFlow(flow: MockFlow): MockFlow {
  return { ...flow };
}

vi.mock("../../tasks/task-flow-registry.js", () => ({
  createManagedTaskFlow: vi.fn((params: Partial<MockFlow> & { ownerKey: string }) => {
    const now = Date.now();
    const flow: MockFlow = {
      flowId: `flow-${++flowCounter}`,
      syncMode: "managed",
      ownerKey: params.ownerKey,
      chainId: params.chainId,
      controllerId: params.controllerId ?? "tests/controller",
      status: params.status ?? "queued",
      notifyPolicy: "silent",
      goal: params.goal ?? "goal",
      currentStep: params.currentStep,
      stateJson: params.stateJson,
      revision: 0,
      createdAt: params.createdAt ?? now,
      updatedAt: params.updatedAt ?? params.createdAt ?? now,
    };
    mockFlows.set(flow.flowId, flow);
    return cloneFlow(flow);
  }),
  listTaskFlowsForOwnerKey: vi.fn((ownerKey: string) =>
    Array.from(
      [...mockFlows.values()].filter((flow) => flow.ownerKey === ownerKey),
      cloneFlow,
    ),
  ),
  listTaskFlowRecords: vi.fn(() => Array.from(mockFlows.values(), cloneFlow)),
  getTaskFlowById: vi.fn((flowId: string) => {
    const flow = mockFlows.get(flowId);
    return flow ? cloneFlow(flow) : undefined;
  }),
  updateFlowRecordByIdExpectedRevision: vi.fn(
    (params: { flowId: string; expectedRevision: number; patch: Partial<MockFlow> }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return { applied: false, reason: flow ? "revision_conflict" : "not_found" };
      }
      if (params.patch.currentStep === "Continuation wake delivered (durable mark)") {
        workTransitionEvents.push("delivered-mark-committed");
      } else if (params.patch.currentStep === "Continuation fold note delivered (durable mark)") {
        workTransitionEvents.push("fold-delivered-mark-committed");
      }
      Object.assign(flow, params.patch, { revision: flow.revision + 1 });
      return { applied: true, flow: cloneFlow(flow) };
    },
  ),
  finishFlow: vi.fn(
    (params: {
      flowId: string;
      expectedRevision: number;
      currentStep?: string;
      stateJson?: unknown;
      updatedAt?: number;
      endedAt?: number;
    }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return { applied: false, reason: flow ? "revision_conflict" : "not_found" };
      }
      workTransitionEvents.push(`flow-finished:${params.currentStep ?? "unknown"}`);
      const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
      flow.status = "succeeded";
      flow.currentStep = params.currentStep;
      flow.stateJson = params.stateJson ?? flow.stateJson;
      flow.updatedAt = params.updatedAt ?? endedAt;
      flow.endedAt = endedAt;
      flow.revision += 1;
      return { applied: true, flow: cloneFlow(flow) };
    },
  ),
  failFlow: vi.fn((params: { flowId: string }) => {
    const flow = mockFlows.get(params.flowId);
    if (flow) {
      flow.status = "failed";
      flow.revision += 1;
    }
    return { applied: Boolean(flow) };
  }),
  deleteTaskFlowRecordById: vi.fn((flowId: string) => {
    mockFlows.delete(flowId);
  }),
}));

import { subagentRuns } from "../../agents/subagents/registry/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.types.js";
import { STALE_UNENDED_SUBAGENT_RUN_MS } from "../../agents/subagents/registry/subagent-run-liveness.js";
import {
  deleteSubagentSessionForCleanup,
  resetSubagentSessionCleanupForTests,
} from "../../agents/subagents/registry/subagent-session-cleanup.js";
import { resetGatewayWorkAdmission } from "../../process/gateway-work-admission.js";
import { runWithGatewayRootWorkAdmissionForTest as runWithGatewayRootWorkAdmission } from "../../process/gateway-work-admission.test-helpers.js";
import { getReplyFromConfig } from "../reply/get-reply.js";
import {
  DEFAULT_NO_OP_REARM_THRESHOLD,
  recordNoOpRearmOutcome,
} from "../reply/no-op-rearm-guard.js";
import {
  cancelPendingDelegates,
  enqueuePendingDelegate,
  pendingDelegateCount,
} from "./delegate-store.js";
import type { ContinuationRuntimeConfig } from "./types.js";
import {
  dispatchPendingContinuationWork,
  bucket1ReapVerdict,
  classifyContinuationWorkReason,
  computeBusySkipBackoffMs,
  partitionSupersededWork,
  recoverPendingContinuationWork,
  resetContinuationWorkDispatchForTests,
  scheduleContinuationWork,
  scheduleContinuationWorkBatch,
} from "./work-dispatch.js";
import {
  consumePendingWork,
  enqueuePendingWork,
  hasLiveOrRecentlyDispatchedContinuationWork,
  markPendingWorkDelivered,
  markPendingWorkFoldDelivered,
  requeuePendingWork,
} from "./work-store.js";

const getReplyFromConfigMock = vi.mocked(getReplyFromConfig);

function addSubagentRun(childSessionKey: string, overrides: Partial<SubagentRunRecord> = {}): void {
  const runId = overrides.runId ?? `run-${childSessionKey}-${subagentRuns.size + 1}`;
  subagentRuns.set(runId, {
    runId,
    childSessionKey,
    requesterSessionKey: overrides.requesterSessionKey ?? "agent:main:requester",
    requesterDisplayKey: overrides.requesterDisplayKey ?? "requester",
    task: overrides.task ?? "delegated task",
    cleanup: overrides.cleanup ?? "keep",
    createdAt: overrides.createdAt ?? Date.now(),
    execution: overrides.execution ?? { status: "running" },
    ...overrides,
  });
}

const config = {
  enabled: true,
  maxChainLength: 8,
  maxDelegatesPerTurn: 4,
  maxPendingWork: 32,
  defaultDelayMs: 1_000,
  minDelayMs: 1_000,
  maxDelayMs: 60_000,
  costCapTokens: 0,
  crossSessionTargeting: "enabled",
  busySkipBackoff: { baseMs: 1_000, ceilingMs: 60_000, factor: 2 },
} satisfies ContinuationRuntimeConfig;

async function flushTimers(): Promise<void> {
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
}

function claimMaturedWork(sessionKey: string) {
  const enqueued = enqueuePendingWork({
    sessionKey,
    hop: 1,
    delayMs: 0,
    electedAt: Date.now(),
    dueAt: Date.now(),
    maxChainLength: 8,
    reason: "immutable transition characterization",
  });
  if (!enqueued) {
    throw new Error("expected continuation work enqueue");
  }
  const [work] = consumePendingWork(sessionKey);
  if (!work) {
    throw new Error("expected matured continuation work claim");
  }
  return work;
}
const splitLintUse = [
  fs,
  os,
  path,
  resolveReplyRunIdle,
  resolveCommandLaneIdle,
  waitForMockWaiter,
  STALE_UNENDED_SUBAGENT_RUN_MS,
  runWithGatewayRootWorkAdmission,
  DEFAULT_NO_OP_REARM_THRESHOLD,
  recordNoOpRearmOutcome,
  bucket1ReapVerdict,
  classifyContinuationWorkReason,
  computeBusySkipBackoffMs,
  partitionSupersededWork,
  scheduleContinuationWorkBatch,
  markPendingWorkDelivered,
  markPendingWorkFoldDelivered,
  requeuePendingWork,
  addSubagentRun,
  claimMaturedWork,
];
void splitLintUse;

describe("durable continuation_work dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    turnGrants.length = 0;
    systemEvents.length = 0;
    activeQueueDeliveries.length = 0;
    workTransitionEvents.length = 0;
    replyRegistryReceivers.clear();
    activeSessions.clear();
    replyIdleWaiters.clear();
    laneIdleWaiters.clear();
    mainQueueSize = 0;
    gatewayDraining = false;
    replyError = undefined;
    commandLaneIdleError = undefined;
    drainAfterReply = false;
    replyPayloadOverride = undefined;
    activeQueueMode = "delivered";
    activeQueueHandleAvailable = true;
    observeSubordinateAdmission = false;
    observedSubordinateAdmissionClosed.length = 0;
    for (const key of Object.keys(mockSessionStore)) {
      delete mockSessionStore[key];
    }
    loadSessionEntryMock
      .mockReset()
      .mockImplementation(
        ({ sessionKey }: { sessionKey: string }) => mockSessionStore[sessionKey.trim()],
      );
    mockStorePath = "test-store";
    mockFlows.clear();
    flowCounter = 0;
    subagentRuns.clear();
    getReplyFromConfigMock.mockClear();
    continuationEnabledForTest = true;
    capturedReplyTraceparents.length = 0;
    bumpWorkRevisionOnReply = false;
    emitContinuationWorkFireSpanMock.mockReset();
    resolveContinuationTraceparentMock
      .mockReset()
      .mockImplementation((traceparent: string | undefined) => traceparent);
    resetContinuationWorkDispatchForTests();
    resetSubagentSessionCleanupForTests();
    resetGatewayWorkAdmission();
  });

  afterEach(() => {
    subagentRuns.clear();
    replyIdleWaiters.clear();
    laneIdleWaiters.clear();
    resetContinuationWorkDispatchForTests();
    resetSubagentSessionCleanupForTests();
    resetGatewayWorkAdmission();
    commandLaneIdleError = undefined;
    vi.useRealTimers();
  });

  it("uses the idle-retry timer while hot-disabled idle recovery waits", async () => {
    const sessionKey = "agent:main:disabled-idle-retry";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 1_000,
      maxChainLength: 8,
      reason: "disabled idle retry",
      idleRetry: {
        trigger: "reply-run-ended",
        reasonCategory: "follow-up-work",
        armedAt: Date.now(),
      },
    });
    continuationEnabledForTest = false;
    const disabled = await dispatchPendingContinuationWork({
      sessionKey,
      includeIdleRetry: true,
    });
    expect(disabled).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();

    expect(vi.getTimerCount()).toBeGreaterThan(0);
    continuationEnabledForTest = true;
    await dispatchPendingContinuationWork({
      sessionKey,
      includeIdleRetry: true,
    });
    await vi.waitFor(() => {
      expect(turnGrants).toHaveLength(1);
    });
  });

  it("preserves queued idle-retry mode across disabled-continuation rechecks", async () => {
    const sessionKey = "agent:main:disabled-idle-retry-recheck";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 60_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 60_000,
      maxChainLength: 8,
      reason: "disabled idle retry recheck",
      idleRetry: {
        trigger: "reply-run-ended",
        reasonCategory: "follow-up-work",
        armedAt: Date.now(),
      },
    });

    continuationEnabledForTest = false;
    await dispatchPendingContinuationWork({ sessionKey, includeIdleRetry: true });

    continuationEnabledForTest = true;
    await vi.advanceTimersByTimeAsync(15_000);
    await waitForTurnGrantCount(1);

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("disabled idle retry recheck"),
        }),
      }),
    ]);
  });

  it("re-enters the persisted work.traceparent around the continuation turn", async () => {
    const sessionKey = "agent:main:traceparent-reentry";
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 1_000,
      maxChainLength: 8,
      reason: "trace re-entry",
      traceparent,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await dispatchPendingContinuationWork({ sessionKey });
    await Promise.resolve();

    expect(getReplyFromConfigMock).toHaveBeenCalledTimes(1);
    // The active diagnostic trace at reply time carries the persisted trace id.
    expect(capturedReplyTraceparents).toHaveLength(1);
    expect(capturedReplyTraceparents[0]).toContain("0af7651916cd43dd8448eb211c80319c");
    // ...but the trace stays internal: it is never surfaced in the model-facing
    // inbound context or options (boundary).
    const grant = turnGrants[0] as { context: unknown; options: unknown };
    expect(JSON.stringify(grant.context)).not.toContain("0af7651916cd43dd8448eb211c80319c");
    expect(JSON.stringify(grant.options)).not.toContain("0af7651916cd43dd8448eb211c80319c");
  });

  it("forwards the resolved persisted traceparent to work fire spans", async () => {
    const sessionKey = "agent:main:work-fire-traceparent";
    const persistedTraceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const exportedTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    resolveContinuationTraceparentMock.mockReturnValue(exportedTraceparent);
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 1_000,
      maxChainLength: 8,
      reason: "trace work fire",
      traceparent: persistedTraceparent,
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await dispatchPendingContinuationWork({ sessionKey });

    expect(resolveContinuationTraceparentMock).toHaveBeenCalledWith(persistedTraceparent);
    expect(emitContinuationWorkFireSpanMock).toHaveBeenCalledWith(
      expect.objectContaining({ traceparent: exportedTraceparent }),
    );
  });

  it("does not forward an unmarked persisted traceparent to work fire spans", async () => {
    const sessionKey = "agent:main:untrusted-work-fire-traceparent";
    const attackerTraceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 1_000,
      maxChainLength: 8,
      reason: "untrusted trace work fire",
      traceparent: attackerTraceparent,
    });
    const flow = [...mockFlows.values()].find((candidate) => candidate.ownerKey === sessionKey);
    if (!flow) {
      throw new Error("expected queued continuation work flow");
    }
    const state = { ...(flow.stateJson as Record<string, unknown>) };
    delete state.traceparentProvenance;
    flow.stateJson = state;
    await vi.advanceTimersByTimeAsync(1_000);

    await dispatchPendingContinuationWork({ sessionKey });

    expect(emitContinuationWorkFireSpanMock).toHaveBeenCalledWith(
      expect.not.objectContaining({ traceparent: attackerTraceparent }),
    );
    expect(capturedReplyTraceparents).not.toContain(attackerTraceparent);
  });

  it("does not replay a turn when the durable delivered-mark loses the revision race", async () => {
    const sessionKey = "agent:main:delivered-mark-race";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 1_000,
      maxChainLength: 8,
      reason: "delivered-mark race",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    // A revision/cancel race bumps the flow revision during the turn, so the
    // durable delivered-mark fails AFTER getReplyFromConfig already executed.
    bumpWorkRevisionOnReply = true;
    const result = await dispatchPendingContinuationWork({ sessionKey });
    await Promise.resolve();
    expect(getReplyFromConfigMock).toHaveBeenCalledTimes(1);
    expect(result.dispatched).toBe(1);

    // round-6: the reconciled row is terminalized immediately, not left
    // `running` behind a read-guard for a later consume/recovery pass. A
    // lingering running row keeps running-flow bookkeeping non-terminal even
    // though the provider turn is already spent.
    const raceFlow = [...mockFlows.values()][0];
    expect(raceFlow?.status).toBe("succeeded");
    expect(hasLiveOrRecentlyDispatchedContinuationWork(sessionKey)).toBe(false);

    // Restart recovery must NOT re-drive the already-executed turn: the row was
    // reconciled to a delivered/succeeded (or non-retryable) terminal state.
    bumpWorkRevisionOnReply = false;
    await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now(),
    });
    await Promise.resolve();
    expect(getReplyFromConfigMock).toHaveBeenCalledTimes(1);
  });

  it("retains a continue_delegate child session while its continue_work wake is pending", async () => {
    const childSessionKey = "agent:main:continuation-child";
    mockSessionStore[childSessionKey] = { sessionKey: childSessionKey };
    enqueuePendingWork({
      sessionKey: childSessionKey,
      hop: 2,
      delayMs: 1_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 1_000,
      maxChainLength: 8,
      reason: "nested hop",
    });

    expect(hasLiveOrRecentlyDispatchedContinuationWork(childSessionKey)).toBe(true);

    const callGateway = vi.fn();
    await deleteSubagentSessionForCleanup({
      callGateway: callGateway as never,
      childSessionKey,
      spawnMode: "run",
      expectedSessionId: "continuation-child-session",
      expectedLifecycleRevision: "continuation-child-revision",
    });
    expect(callGateway).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    await dispatchPendingContinuationWork({ sessionKey: childSessionKey });
    await Promise.resolve();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: childSessionKey,
          Provider: "system",
          Body: expect.stringContaining("nested hop"),
        }),
        options: expect.objectContaining({ continuationTrigger: "work-wake" }),
      }),
    ]);

    expect(hasLiveOrRecentlyDispatchedContinuationWork(childSessionKey)).toBe(false);

    await vi.advanceTimersByTimeAsync(4_000);
    await Promise.resolve();

    expect(callGateway).toHaveBeenCalledWith({
      method: "sessions.delete",
      params: {
        key: childSessionKey,
        deleteTranscript: true,
        emitLifecycleHooks: false,
        expectedSessionId: "continuation-child-session",
        expectedLifecycleRevision: "continuation-child-revision",
      },
      timeoutMs: 10_000,
    });
  });

  it("retains a child session while a queued continuation delegate is pending", async () => {
    const childSessionKey = "agent:main:continuation-delegate-child";
    mockSessionStore[childSessionKey] = { sessionKey: childSessionKey };
    // A delayed delegate queued under the child (e.g. a durable delayed bracket
    // delegate) owns the child's chain/requester state until it drains.
    enqueuePendingDelegate(childSessionKey, { task: "delayed hop", delayMs: 60_000 });
    expect(pendingDelegateCount(childSessionKey)).toBeGreaterThan(0);

    const callGateway = vi.fn();
    await deleteSubagentSessionForCleanup({
      callGateway: callGateway as never,
      childSessionKey,
      spawnMode: "run",
      expectedSessionId: "continuation-delegate-child-session",
      expectedLifecycleRevision: "continuation-delegate-child-revision",
    });
    // Deletion is deferred while the delegate is queued so the child session (and
    // its chain state) survives until the delegate's hedge fires.
    expect(callGateway).not.toHaveBeenCalled();

    // Once the delegate is gone, the deferred retry deletes the child.
    cancelPendingDelegates(childSessionKey);
    expect(pendingDelegateCount(childSessionKey)).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.delete" }),
    );
  });

  it("retains a child session while a claimed (running) continuation delegate is dispatching", async () => {
    const childSessionKey = "agent:main:continuation-delegate-running";
    mockSessionStore[childSessionKey] = { sessionKey: childSessionKey };
    enqueuePendingDelegate(childSessionKey, { task: "delayed hop", delayMs: 60_000 });

    // The dispatcher/hedge claims the delegate to `running` before
    // spawnSubagentDirect finishes; pendingDelegateCount (queued-only) drops to 0
    // here, but the running delegate still depends on the child's chain state.
    const flow = [...mockFlows.values()].find((entry) => entry.ownerKey === childSessionKey);
    expect(flow).toBeDefined();
    flow!.status = "running";
    expect(pendingDelegateCount(childSessionKey)).toBe(0);

    const callGateway = vi.fn();
    await deleteSubagentSessionForCleanup({
      callGateway: callGateway as never,
      childSessionKey,
      spawnMode: "run",
      expectedSessionId: "continuation-running-child-session",
      expectedLifecycleRevision: "continuation-running-child-revision",
    });
    // Must still defer: a queued-only gate would delete the child out from under
    // the running delegate.
    expect(callGateway).not.toHaveBeenCalled();

    // Once the delegate flow reaches a terminal state, the deferred retry deletes.
    flow!.status = "succeeded";
    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.resolve();
    expect(callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "sessions.delete" }),
    );
  });

  it("re-arms a delayed continue_work election after simulated gateway restart", async () => {
    const sessionKey = "agent:main:main";
    mockSessionStore[sessionKey] = { sessionKey };
    await scheduleContinuationWork({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 12,
        chainId: "chain-1",
      },
      request: { delaySeconds: 1, reason: "restart proof" },
      config,
      parentRunId: "run-1",
    });
    expect(turnGrants).toHaveLength(0);

    resetContinuationWorkDispatchForTests();
    await recoverPendingContinuationWork();
    await vi.advanceTimersByTimeAsync(999);
    expect(turnGrants).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("restart proof"),
        }),
        options: expect.objectContaining({
          continuationTrigger: "work-wake",
          parentRunId: "run-1",
        }),
      }),
    ]);
    expect(systemEvents).toEqual([]);
  });

  it("writes continuation chainId into the managed TaskFlow row", () => {
    enqueuePendingWork({
      sessionKey: "agent:main:main",
      hop: 1,
      delayMs: 1_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 1_000,
      maxChainLength: 8,
      reason: "chain id persistence",
      chainId: "chain-persisted",
    });

    expect([...mockFlows.values()][0]?.chainId).toBe("chain-persisted");
  });

  it("resolves normalized accessor aliases before treating work as missing-session", async () => {
    const normalizedSessionKey = "agent:main:alias";
    const queuedSessionKey = `${normalizedSessionKey} `;
    mockSessionStore[normalizedSessionKey] = { sessionKey: normalizedSessionKey };
    enqueuePendingWork({
      sessionKey: queuedSessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "alias proof",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey: queuedSessionKey });

    expect(result).toEqual({ dispatched: 1, failed: 0, reaped: 0 });
    expect(loadSessionEntryMock).toHaveBeenCalledWith({
      clone: false,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
      sessionKey: queuedSessionKey,
      storePath: "test-store",
    });
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: queuedSessionKey,
          Body: expect.stringContaining("alias proof"),
        }),
      }),
    ]);
  });
});
