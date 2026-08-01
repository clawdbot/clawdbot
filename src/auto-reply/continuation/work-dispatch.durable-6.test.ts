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
  resolveStorePath: () => mockStorePath,
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

import { subagentRuns } from "../../agents/subagent-registry-memory.js";
import type { SubagentRunRecord } from "../../agents/subagent-registry.types.js";
import { STALE_UNENDED_SUBAGENT_RUN_MS } from "../../agents/subagent-run-liveness.js";
import {
  deleteSubagentSessionForCleanup,
  resetSubagentSessionCleanupForTests,
} from "../../agents/subagent-session-cleanup.js";
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
  hasLiveOrRecentlyDispatchedContinuationWork,
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

  it("enqueues warning events only for non-retryable skips", async () => {
    const sessionKey = "agent:main:missing";
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "missing session",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 1, reaped: 0 });
    expect(systemEvents).toEqual([
      expect.objectContaining({ text: expect.stringContaining("was not granted") }),
    ]);
  });

  it("delivers a distinct wake for every continue_work election scheduled in one turn", async () => {
    // Regression for N continue_work() calls in one model turn must each
    // deliver their own wake at their own offset. The single-variable capture
    // dropped all but the last; the batch helper fans out all N, and the
    // wake-timer re-arms for the soonest pending after each fire.
    const sessionKey = "agent:main:multi-fanout";
    mockSessionStore[sessionKey] = { sessionKey };

    const batch = await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-multi",
      },
      requests: [
        { reason: "work-A", delaySeconds: 1 },
        { reason: "work-B", delaySeconds: 2 },
        { reason: "work-C", delaySeconds: 3 },
      ],
      config,
      parentRunId: "run-multi",
    });

    expect(batch).toMatchObject({ scheduledCount: 3, cappedCount: 0, capped: false });
    expect(turnGrants).toHaveLength(0);

    // Advance one offset at a time. Each fire delivers exactly one wake and
    // re-arms for the next pending dueAt — proving distinct delivery, not the
    // single collapsed wake of the regression. `advanceTimersByTimeAsync` only
    // runs timers due within the window (unlike `flushTimers`, which drains the
    // re-armed future timers too).
    await vi.advanceTimersByTimeAsync(1_000);
    expect(turnGrants).toHaveLength(1);
    expect(turnGrants[0]).toMatchObject({
      context: expect.objectContaining({ Body: expect.stringContaining("work-A") }),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(turnGrants).toHaveLength(2);
    expect(turnGrants[1]).toMatchObject({
      context: expect.objectContaining({ Body: expect.stringContaining("work-B") }),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(turnGrants).toHaveLength(3);
    expect(turnGrants[2]).toMatchObject({
      context: expect.objectContaining({ Body: expect.stringContaining("work-C") }),
    });
  });

  it("bounds the observed 3x same-turn continue_work delays as three scheduled terminal wakes", async () => {
    const sessionKey = "agent:main:three-continue-work";
    mockSessionStore[sessionKey] = { sessionKey };
    const threeWorkConfig = { ...config, maxDelayMs: 65_000 } satisfies ContinuationRuntimeConfig;

    const batch = await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-three-work",
      },
      requests: [
        { reason: "1 of 3 - did this fire for you", delaySeconds: 55 },
        { reason: "2 of 3 - did this turn compress with the next", delaySeconds: 60 },
        { reason: "3 of 3 - or this one?", delaySeconds: 61 },
      ],
      config: threeWorkConfig,
    });

    expect(batch).toMatchObject({ scheduledCount: 3, cappedCount: 0, capped: false });
    expect(turnGrants).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(55_000);
    expect(turnGrants).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(turnGrants).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(turnGrants).toHaveLength(3);

    expect(
      turnGrants.map((grant) => (grant as { context: { Body: string } }).context.Body),
    ).toEqual([
      expect.stringContaining("1 of 3 - did this fire for you"),
      expect.stringContaining("2 of 3 - did this turn compress with the next"),
      expect.stringContaining("3 of 3 - or this one?"),
    ]);
    expect([...mockFlows.values()].map((flow) => flow.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(
      [...mockFlows.values()].map(
        (flow) =>
          (
            flow.stateJson as {
              busySkipCount?: number;
              parentRunId?: string;
              turnGrantedAt?: number;
            }
          ).busySkipCount,
      ),
    ).toEqual([0, 0, 0]);
    expect(
      [...mockFlows.values()].map(
        (flow) => (flow.stateJson as { parentRunId?: string }).parentRunId,
      ),
    ).toEqual([undefined, undefined, undefined]);
  });

  it("parks a 3x same-turn continue_work burst while requests are in flight without a tight wake loop", async () => {
    const sessionKey = "agent:main:three-continue-work-busy";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    const threeWorkConfig = { ...config, maxDelayMs: 65_000 } satisfies ContinuationRuntimeConfig;

    await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-three-work-busy",
      },
      requests: [
        { reason: "1 of 3 - busy", delaySeconds: 55 },
        { reason: "2 of 3 - busy", delaySeconds: 60 },
        { reason: "3 of 3 - busy", delaySeconds: 61 },
      ],
      config: threeWorkConfig,
    });

    await vi.advanceTimersByTimeAsync(61_000);
    await flushAsyncWork();

    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
    expect(
      [...mockFlows.values()].map((flow) => ({
        status: flow.status,
        busySkipCount: (flow.stateJson as { busySkipCount?: number }).busySkipCount,
        anchorPending: (flow.stateJson as { anchorPending?: boolean }).anchorPending,
        idleRetry: (flow.stateJson as { idleRetry?: unknown }).idleRetry,
      })),
    ).toEqual([
      {
        status: "queued",
        busySkipCount: undefined,
        anchorPending: true,
        idleRetry: expect.objectContaining({ trigger: "reply-run-ended" }),
      },
      {
        status: "queued",
        busySkipCount: undefined,
        anchorPending: true,
        idleRetry: expect.objectContaining({ trigger: "reply-run-ended" }),
      },
      {
        status: "queued",
        busySkipCount: undefined,
        anchorPending: true,
        idleRetry: expect.objectContaining({ trigger: "reply-run-ended" }),
      },
    ]);

    activeSessions.delete(sessionKey);
    const recovered = await dispatchPendingContinuationWork({ sessionKey, includeIdleRetry: true });

    expect(recovered).toEqual({ dispatched: 3, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(3);
    expect([...mockFlows.values()].map((flow) => flow.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
  });

  it("does not let a delayed batch election postpone an already-due zero-delay wake", async () => {
    const sessionKey = "agent:main:zero-delay-batch";
    mockSessionStore[sessionKey] = { sessionKey };

    await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-zero-delay",
      },
      requests: [
        { reason: "immediate batch work", delaySeconds: 0 },
        { reason: "delayed batch work", delaySeconds: 5 },
      ],
      config,
    });

    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("immediate batch work") }),
      }),
    ]);

    await vi.advanceTimersByTimeAsync(4_999);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("immediate batch work") }),
      }),
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("delayed batch work") }),
      }),
    ]);
  });

  it("schedules the valid elections and caps the overflow without dropping the earlier ones", async () => {
    // Partial-success is load-bearing: when the cumulative chain cap rejects a
    // later election, the earlier valid ones must still schedule and deliver.
    const sessionKey = "agent:main:partial-cap";
    mockSessionStore[sessionKey] = { sessionKey };
    const cappedConfig = { ...config, maxChainLength: 2 } satisfies ContinuationRuntimeConfig;

    const batch = await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-partial",
      },
      requests: [
        { reason: "fit-1", delaySeconds: 1 },
        { reason: "fit-2", delaySeconds: 1 },
        { reason: "over-cap", delaySeconds: 1 },
      ],
      config: cappedConfig,
      parentRunId: "run-partial",
    });

    expect(batch).toMatchObject({ scheduledCount: 2, cappedCount: 1, capped: true });
    expect(batch.chainState.currentChainCount).toBe(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await flushTimers();

    const deliveredReasons = turnGrants.map(
      (grant) => (grant as { context: { Body: string } }).context.Body,
    );
    expect(deliveredReasons).toHaveLength(2);
    expect(deliveredReasons.some((body) => body.includes("fit-1"))).toBe(true);
    expect(deliveredReasons.some((body) => body.includes("fit-2"))).toBe(true);
    expect(deliveredReasons.some((body) => body.includes("over-cap"))).toBe(false);
  });

  it("does not let a hedge reclaim freshly running continuation work", async () => {
    const sessionKey = "agent:main:fresh-running";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "fresh running",
    });
    const runningFlow = [...mockFlows.values()][0];
    if (!runningFlow) {
      throw new Error("expected mock flow");
    }
    runningFlow.status = "running";
    runningFlow.updatedAt = Date.now();

    await scheduleContinuationWork({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 1,
      },
      request: { delaySeconds: 0, reason: "new queued" },
      config: { ...config, defaultDelayMs: 0, minDelayMs: 0 },
    });

    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();

    expect(runningFlow.status).toBe("running");
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("new queued") }),
      }),
    ]);
  });

  it("never supersedes a recovered running wake folded against a newer queued election", async () => {
    // End-to-end proof that the PRE-claim status is carried through
    // consumePendingWork into partitionSupersededWork: a stale, recovered
    // `running` wake co-drained with a newer `queued` election must DRIVE, not
    // be finished-as-superseded. Without the carry-status guard the running
    // wake (stale, not newest) would be folded and only the queued one would run.
    const sessionKey = "agent:main:recovered-running-fold";
    mockSessionStore[sessionKey] = { sessionKey };
    const now = Date.now();

    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: now - 500_000,
      dueAt: now - 500_000, // matured and stale (overdue >> 120s grace)
      maxChainLength: 8,
      reason: "recovered running",
    });
    const runningFlow = [...mockFlows.values()][0];
    if (!runningFlow) {
      throw new Error("expected running mock flow");
    }
    runningFlow.status = "running";
    runningFlow.updatedAt = now - 200_000; // older than the 60s recovery staleness window

    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 1_000,
      electedAt: now - 1_000, // newest election
      dueAt: now - 1_000, // matured
      maxChainLength: 8,
      reason: "newest queued",
    });

    const result = await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: now - 60_000,
    });

    expect(result).toEqual({ dispatched: 2, failed: 0, reaped: 0 });
    const bodies = turnGrants.map((grant) => (grant as { context: { Body: string } }).context.Body);
    expect(bodies.some((body) => body.includes("recovered running"))).toBe(true);
    expect(bodies.some((body) => body.includes("newest queued"))).toBe(true);
    expect(systemEvents.some((event) => (event as { text: string }).text.includes("folded"))).toBe(
      false,
    );
  });
});
