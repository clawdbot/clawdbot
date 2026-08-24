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
  clearReplyRunForResetBySessionId: vi.fn(),
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
  clearCommandLane: vi.fn(),
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
  consumeSelectedSystemEventEntries: () => [],
  enqueueSystemEventRaw: (text: string, options: unknown) => {
    systemEvents.push({ text, options });
  },
  peekSystemEventEntries: () => [],
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
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
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
let flowUpdateFailureReason: string | undefined;

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
      if (flowUpdateFailureReason) {
        return { applied: false, reason: flowUpdateFailureReason };
      }
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
import { clearSessionResetRuntimeState } from "../reply/session-reset-cleanup.js";
import {
  cancelPendingDelegates,
  enqueuePendingDelegate,
  pendingDelegateCount,
} from "./delegate-store.js";
import { cancelSessionContinuations } from "./session-reset.js";
import type { ContinuationRuntimeConfig } from "./types.js";
import {
  bucket1ReapVerdict,
  classifyContinuationWorkReason,
  clearContinuationWorkDispatch,
  computeBusySkipBackoffMs,
  dispatchPendingContinuationWork,
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
  os,
  path,
  resolveReplyRunIdle,
  resolveCommandLaneIdle,
  waitForTurnGrantCount,
  STALE_UNENDED_SUBAGENT_RUN_MS,
  deleteSubagentSessionForCleanup,
  runWithGatewayRootWorkAdmission,
  DEFAULT_NO_OP_REARM_THRESHOLD,
  recordNoOpRearmOutcome,
  cancelPendingDelegates,
  enqueuePendingDelegate,
  pendingDelegateCount,
  bucket1ReapVerdict,
  classifyContinuationWorkReason,
  computeBusySkipBackoffMs,
  partitionSupersededWork,
  recoverPendingContinuationWork,
  scheduleContinuationWorkBatch,
  hasLiveOrRecentlyDispatchedContinuationWork,
  addSubagentRun,
  flushTimers,
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
    flowUpdateFailureReason = undefined;
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

  it("returns the committed revision without mutating delivered-work input", () => {
    const work = claimMaturedWork("agent:main:immutable-delivered");
    const input = structuredClone(work);

    const result = markPendingWorkDelivered(work);

    expect(result).toEqual({
      applied: true,
      work: {
        ...input,
        expectedRevision: (input.expectedRevision ?? 0) + 1,
        deliveredAt: Date.now(),
        disposition: "granted",
        succeeded: { point: "optimal", durability: "durable" },
      },
    });
    expect(work).toEqual(input);
    expect(mockFlows.get(work.flowId ?? "")).toMatchObject({
      revision: (input.expectedRevision ?? 0) + 1,
      stateJson: {
        deliveredAt: Date.now(),
        disposition: "granted",
        succeeded: { point: "optimal", durability: "durable" },
      },
    });
  });

  it("returns the committed revision without mutating fold-delivered input", () => {
    const work = claimMaturedWork("agent:main:immutable-fold-delivered");
    const input = structuredClone(work);

    const result = markPendingWorkFoldDelivered(work, {
      foldedAt: Date.now(),
      overdueByMs: 250,
    });

    expect(result).toEqual({
      applied: true,
      work: {
        ...input,
        expectedRevision: (input.expectedRevision ?? 0) + 1,
        disposition: "folded-active",
        foldedAt: Date.now(),
        overdueByMs: 250,
        busySkipCount: 0,
        succeeded: { point: "optimal", durability: "durable" },
      },
    });
    expect(work).toEqual(input);
    expect(mockFlows.get(work.flowId ?? "")).toMatchObject({
      revision: (input.expectedRevision ?? 0) + 1,
      stateJson: {
        disposition: "folded-active",
        foldedAt: Date.now(),
        overdueByMs: 250,
        busySkipCount: 0,
        succeeded: { point: "optimal", durability: "durable" },
      },
    });
  });

  it.each([
    {
      name: "delivered",
      apply: (work: ReturnType<typeof claimMaturedWork>) => markPendingWorkDelivered(work),
    },
    {
      name: "fold-delivered",
      apply: (work: ReturnType<typeof claimMaturedWork>) =>
        markPendingWorkFoldDelivered(work, { foldedAt: Date.now(), overdueByMs: 250 }),
    },
  ])("returns the original $name work on a CAS conflict", ({ apply }) => {
    const work = claimMaturedWork("agent:main:immutable-cas-conflict");
    const input = structuredClone(work);
    const flow = mockFlows.get(work.flowId ?? "");
    if (!flow) {
      throw new Error("expected claimed continuation work flow");
    }
    const stateBeforeConflict = structuredClone(flow.stateJson);
    flow.revision += 1;

    const result = apply(work);

    expect(result).toEqual({ applied: false, work });
    expect(work).toEqual(input);
    expect(flow.stateJson).toEqual(stateBeforeConflict);
  });

  it("fences a claimed work turn when reset lands before final admission", async () => {
    const sessionKey = "agent:main:reset-before-work-admission";
    mockSessionStore[sessionKey] = {
      sessionId: "reset-before-work-admission-session",
      lifecycleRevision: "reset-before-work-admission-revision",
    };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "must not run after reset",
    });
    const dispatch = dispatchPendingContinuationWork({ sessionKey });
    for (let i = 0; i < 1_000 && [...mockFlows.values()].at(0)?.status !== "running"; i += 1) {
      await Promise.resolve();
    }
    expect([...mockFlows.values()].at(0)?.status).toBe("running");
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();

    cancelSessionContinuations(sessionKey);
    clearContinuationWorkDispatch(sessionKey);
    const result = await dispatch;

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
    expect(turnGrants).toStrictEqual([]);
    expect([...mockFlows.values()].at(0)?.status).toBe("cancelled");
    expect(consumePendingWork(sessionKey, { includeRunning: true })).toStrictEqual([]);
  });

  it("requeues claimed work when an implicit rollover changes lifecycle before admission", async () => {
    const sessionKey = "agent:main:rollover-before-work-admission";
    const previousEntry = {
      sessionId: "rollover-before-work-admission-session",
      lifecycleRevision: "previous-lifecycle-revision",
    };
    const successorEntry = {
      sessionId: previousEntry.sessionId,
      lifecycleRevision: "successor-lifecycle-revision",
    };
    let sessionReadCount = 0;
    loadSessionEntryMock.mockImplementation(() => {
      sessionReadCount += 1;
      return sessionReadCount === 1 ? previousEntry : successorEntry;
    });
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "continue after implicit rollover",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
    expect([...mockFlows.values()].at(0)?.status).toBe("queued");
  });

  it("keeps scheduled timers and idle ownership when durable reset cancellation fails", async () => {
    const sessionKey = "agent:main:reset-persist-failure";
    mockSessionStore[sessionKey] = {
      sessionId: "reset-persist-failure-session",
      lifecycleRevision: "reset-persist-failure-revision",
    };
    activeSessions.add(sessionKey);
    await scheduleContinuationWork({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
      },
      request: { delaySeconds: 1, reason: "survive failed reset" },
      config,
    });
    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    const timersBeforeReset = vi.getTimerCount();
    flowUpdateFailureReason = "persist_failed";

    expect(() =>
      clearSessionResetRuntimeState([sessionKey], {
        agentId: "main",
        reason: "reset",
        activeReplySessionId: "reset-persist-failure-session",
      }),
    ).toThrow("could not cancel continuation flow");

    expect(replyIdleWaiters.has(sessionKey)).toBe(true);
    expect(vi.getTimerCount()).toBe(timersBeforeReset);
    expect([...mockFlows.values()].at(0)?.status).toBe("queued");

    flowUpdateFailureReason = undefined;
    clearSessionResetRuntimeState([sessionKey], {
      agentId: "main",
      reason: "reset",
      activeReplySessionId: "reset-persist-failure-session",
    });
    await flushAsyncWork();

    expect(replyIdleWaiters.has(sessionKey)).toBe(false);
    expect(vi.getTimerCount()).toBeLessThan(timersBeforeReset);
    expect([...mockFlows.values()].at(0)?.status).toBe("cancelled");
  });

  it("keeps one reply-run registry identity across election, idle retry, and execution", async () => {
    const sessionKey = "agent:main:registry-singleton";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    const immediateConfig = {
      ...config,
      defaultDelayMs: 0,
      minDelayMs: 0,
    } satisfies ContinuationRuntimeConfig;

    await scheduleContinuationWork({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
      },
      request: { delaySeconds: 0, reason: "singleton registry proof" },
      config: immediateConfig,
    });
    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    expect(replyRegistryReceivers.size).toBe(1);

    // Drive the persisted idle-retry row directly after the active run ends.
    // This keeps the identity proof deterministic even when the execution
    // owner's first dynamic provider/session imports are cold on CI.
    activeSessions.delete(sessionKey);
    const result = await dispatchPendingContinuationWork({
      sessionKey,
      includeIdleRetry: true,
    });

    expect(replyRegistryReceivers.size).toBe(1);
    expect(result).toEqual({ dispatched: 1, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(1);
  });

  it("keeps registry memoization singular and timer/controller state lifecycle-owned", () => {
    const canonicalSource = fs.readFileSync(new URL("./work-dispatch.ts", import.meta.url), "utf8");
    const executionUrl = new URL("./work-dispatch-execution.ts", import.meta.url);
    const executionSource = fs.existsSync(executionUrl)
      ? fs.readFileSync(executionUrl, "utf8")
      : "";
    const combinedSource = `${canonicalSource}\n${executionSource}`;

    expect(combinedSource.match(/let replyRunRegistryModulePromise/g)).toHaveLength(1);
    expect(
      combinedSource.match(
        /replyRunRegistryModulePromise \?\?= import\("\.\.\/reply\/reply-run-registry\.js"\)/g,
      ),
    ).toHaveLength(1);
    expect(canonicalSource).toMatch(/const workTimers = new Map/);
    expect(canonicalSource).toMatch(/const idleRetryFailureTimers = new Map/);
    expect(canonicalSource).toMatch(/const idleRetryControllers = new Map/);
    expect(executionSource).not.toMatch(
      /const (?:workTimers|idleRetryFailureTimers|idleRetryControllers) =/,
    );
    expect(executionSource).not.toMatch(/from "\.\/work-dispatch\.js"/);
    expect(executionSource).not.toMatch(
      /\b(?:armWorkTimer|armNextWorkTimer|armIdleRetryFailureTimer|registerIdleRetry)\s*\(/,
    );
    expect(canonicalSource).not.toMatch(
      /\b(?:markPendingWorkDelivered|markPendingWorkFoldDelivered|markPendingWorkTurnGranted|markPendingWorkFolded|markPendingWorkFailed|markPendingWorkReaped)\s*\(/,
    );
    expect(executionSource).toMatch(/export type ContinuationWorkExecutionDirective = Readonly</);
    expect(canonicalSource).toMatch(/applyExecutionDirective\(directive\)/);
  });

  it("commits provider delivery before finishing the claimed row", async () => {
    const sessionKey = "agent:main:provider-finish-order";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "provider finish ordering",
    });

    await dispatchPendingContinuationWork({ sessionKey });

    expect(workTransitionEvents).toEqual([
      "provider-called",
      "delivered-mark-committed",
      "flow-finished:Same-session continuation turn granted",
    ]);
  });

  it("commits an active-turn transcript and fold delivery before finishing the row", async () => {
    const sessionKey = "agent:main:fold-finish-order";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now() - 1,
      anchorFinalizedAt: Date.now() - 1,
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "fold finish ordering",
    });

    await dispatchPendingContinuationWork({ sessionKey });

    expect(workTransitionEvents).toEqual([
      "fold-transcript-committed",
      "fold-delivered-mark-committed",
      "flow-finished:folded-into-active-turn: matured while a later turn was active",
    ]);
  });

  it("reset aborts lifecycle-owned idle waiters and clears every dispatch timer", async () => {
    const replySessionKey = "agent:main:reset-reply-idle";
    const laneSessionKey = "agent:main:reset-lane-idle";
    mockSessionStore[replySessionKey] = { sessionKey: replySessionKey };
    mockSessionStore[laneSessionKey] = { sessionKey: laneSessionKey };
    activeSessions.add(replySessionKey);
    mainQueueSize = 1;
    for (const sessionKey of [replySessionKey, laneSessionKey]) {
      enqueuePendingWork({
        sessionKey,
        hop: 1,
        delayMs: 0,
        electedAt: Date.now(),
        dueAt: Date.now(),
        maxChainLength: 8,
        reason: "reset cleanup proof",
      });
      await dispatchPendingContinuationWork({ sessionKey });
    }
    await waitForMockWaiter(replyIdleWaiters, replySessionKey);
    await waitForMockWaiter(laneIdleWaiters, "main");
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    resetContinuationWorkDispatchForTests();
    await flushAsyncWork();

    expect(replyIdleWaiters.has(replySessionKey)).toBe(false);
    expect(laneIdleWaiters.has("main")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("requeues without mutating its claimed work input and clears retry-only state", () => {
    const sessionKey = "agent:main:immutable-requeue";
    const enqueued = enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      recoveryDueAt: Date.now(),
      maxChainLength: 8,
      idleRetry: {
        trigger: "reply-run-ended",
        reasonCategory: "wait-shaped",
        armedAt: Date.now(),
      },
    });
    if (!enqueued) {
      throw new Error("expected continuation work enqueue");
    }
    const [work] = consumePendingWork(sessionKey, { includeIdleRetry: true });
    if (!work) {
      throw new Error("expected continuation work claim");
    }
    const input = structuredClone(work);
    const nextDueAt = Date.now() + 5_000;

    expect(
      requeuePendingWork(work, {
        dueAt: nextDueAt,
        summary: "immutable requeue characterization",
        busySkipCount: 2,
      }),
    ).toBe(true);

    expect(work).toEqual(input);
    const flow = mockFlows.get(work.flowId ?? "");
    expect(flow).toMatchObject({
      status: "queued",
      revision: (input.expectedRevision ?? 0) + 1,
      stateJson: { dueAt: nextDueAt, busySkipCount: 2 },
    });
    expect(flow?.stateJson).not.toMatchObject({ idleRetry: expect.anything() });
    expect(flow?.stateJson).not.toMatchObject({ recoveryDueAt: expect.anything() });
  });

  it("honors hot-disabled continuation before consuming or driving queued work", async () => {
    const sessionKey = "agent:main:disabled-gate";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 1_000,
      maxChainLength: 8,
      reason: "disabled gate",
    });
    await vi.advanceTimersByTimeAsync(1_000);

    // Operator hot-disables continuation after the wake was armed.
    continuationEnabledForTest = false;
    const result = await dispatchPendingContinuationWork({ sessionKey });
    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    // The queued row was not consumed/mutated, and the disabled callback left a
    // recheck timer so hot re-enable recovers it without waiting for startup or
    // unrelated traffic.
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
});
