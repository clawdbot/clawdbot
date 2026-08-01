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
  resolveCommandLaneIdle,
  STALE_UNENDED_SUBAGENT_RUN_MS,
  deleteSubagentSessionForCleanup,
  resetGatewayWorkAdmission,
  runWithGatewayRootWorkAdmission,
  DEFAULT_NO_OP_REARM_THRESHOLD,
  recordNoOpRearmOutcome,
  cancelPendingDelegates,
  enqueuePendingDelegate,
  pendingDelegateCount,
  bucket1ReapVerdict,
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

describe("continue_work end-of-turn finalization park + cross-turn coalesce", () => {
  const immediateConfig = {
    ...config,
    defaultDelayMs: 0,
    minDelayMs: 0,
  } satisfies ContinuationRuntimeConfig;

  beforeEach(async () => {
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

    const warmupSessionKey = "agent:main:disabled-idle-retry-warmup";
    mockSessionStore[warmupSessionKey] = { sessionKey: warmupSessionKey };
    enqueuePendingWork({
      sessionKey: warmupSessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 1_000,
      maxChainLength: 8,
      reason: "disabled idle retry warmup",
      idleRetry: {
        trigger: "reply-run-ended",
        reasonCategory: "follow-up-work",
        armedAt: Date.now(),
      },
    });
    continuationEnabledForTest = false;
    await dispatchPendingContinuationWork({
      sessionKey: warmupSessionKey,
      includeIdleRetry: true,
    });
    continuationEnabledForTest = true;
    await dispatchPendingContinuationWork({
      sessionKey: warmupSessionKey,
      includeIdleRetry: true,
    });
    delete mockSessionStore[warmupSessionKey];
    mockFlows.clear();
    turnGrants.length = 0;
    getReplyFromConfigMock.mockClear();
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

  it("parks a delaySeconds=0 election captured during an active turn and fires exactly once after finalization (no pre-finalization hedge)", async () => {
    const sessionKey = "agent:main:park-zero";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);

    await scheduleContinuationWork({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      request: { delaySeconds: 0, reason: "draft the next section" },
      config: immediateConfig,
    });

    // The captured wake parks behind the end-of-turn event; no immediate timer
    // fires, no requests-in-flight skip, and the durable row carries the marker.
    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    const flow = [...mockFlows.values()][0];
    expect(flow).toMatchObject({
      status: "queued",
      stateJson: expect.objectContaining({
        dueAt: Date.now() + immediateConfig.maxDelayMs,
        idleRetry: {
          trigger: "reply-run-ended",
          reasonCategory: "follow-up-work",
          armedAt: Date.now(),
        },
      }),
    });
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();

    // The Jun7/Jun8 signature was a sub-second hedge loop firing while the same
    // session was still active. Advancing far past any 1s hedge must NOT fire.
    await vi.advanceTimersByTimeAsync(5_000);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(0);

    // Finalize the current turn → the parked wake fires exactly once.
    resolveReplyRunIdle(sessionKey);
    await waitForTurnGrantCount(1);
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("draft the next section"),
        }),
      }),
    ]);
  });

  it("fires a delaySeconds>0 election once at finalization + offset, not via a busy hedge loop", async () => {
    const sessionKey = "agent:main:park-delay";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);

    await scheduleContinuationWork({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      request: { delaySeconds: 5, reason: "resume after the offset" },
      config,
    });

    // Finalize the electing turn; the offset is measured from this post-turn point.
    resolveReplyRunIdle(sessionKey);

    await vi.advanceTimersByTimeAsync(4_999);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await flushTimers();
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("resume after the offset"),
        }),
      }),
    ]);
  });

  it("arms active-captured delayed work at the persisted recovery hedge, not the tool-call-relative due", async () => {
    const sessionKey = "agent:main:active-delay-hedge";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);

    await scheduleContinuationWork({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      request: { delaySeconds: 20, reason: "do not fire at tool-call plus delay" },
      config: immediateConfig,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    await flushAsyncWork();

    expect(turnGrants).toHaveLength(0);
    expect(activeQueueDeliveries).toHaveLength(0);
    expect([...mockFlows.values()][0]?.stateJson).toMatchObject({
      anchorPending: true,
      dueAt: 1_060_000,
    });
  });

  it("coalesces repeated hold/ack/wait elections across turns into the newest, bounded and fired once (no accumulation, no hedge loop)", async () => {
    const sessionKey = "agent:main:coalesce";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);

    // Successive turns each elect a delaySeconds=0 hold while the session stays
    // active (the courtesy/off-board churn shape). Each turn schedules via the
    // batch helper, exactly like the runtime.
    const reasons = [
      "standing by",
      "holding position",
      "all tasks complete",
      "standing by once more",
    ];
    for (const reason of reasons) {
      await scheduleContinuationWorkBatch({
        sessionKey,
        chainState: {
          currentChainCount: 0,
          chainStartedAt: Date.now(),
          accumulatedChainTokens: 0,
          chainId: "chain-hold",
        },
        requests: [{ reason, delaySeconds: 0 }],
        config: immediateConfig,
      });
    }

    // Rows stay bounded: only the newest election remains queued; the older
    // parked duplicates were folded (succeeded), not dropped by reason text.
    const queued = [...mockFlows.values()].filter((flow) => flow.status === "queued");
    expect(queued).toHaveLength(1);
    expect(queued[0]?.stateJson).toMatchObject({ reason: "standing by once more" });
    const folded = [...mockFlows.values()].filter((flow) => flow.status === "succeeded");
    expect(folded).toHaveLength(reasons.length - 1);

    // No high-frequency wake loop while the session is active.
    await vi.advanceTimersByTimeAsync(5_000);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(0);

    // Finalize → the newest valid election fires exactly once.
    resolveReplyRunIdle(sessionKey);
    await waitForTurnGrantCount(1);
    expect(turnGrants).toHaveLength(1);
    expect(turnGrants[0]).toMatchObject({
      context: expect.objectContaining({
        Body: expect.stringContaining("standing by once more"),
      }),
    });
  });

  it("schedules durable wait-shaped continuation work instead of refusing it by reason (repair, not quiesce)", async () => {
    // made scheduleContinuationWork refuse any wait-shaped reason and made
    // the tool's `scheduled` result untrue. The contract is the opposite: reason
    // is diagnostic only, the durable work is created, and it actually fires.
    const sessionKey = "agent:main:wait-shaped-schedules";
    mockSessionStore[sessionKey] = { sessionKey };

    const result = await scheduleContinuationWork({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      request: { delaySeconds: 0, reason: "standing by and yielding" },
      config: immediateConfig,
    });

    // Truthful: durable work was created (not refused by reason classification).
    expect(result.scheduled).toBe(true);
    expect(classifyContinuationWorkReason("standing by and yielding")).toBe("wait-shaped");
    const flow = [...mockFlows.values()][0];
    expect(flow?.status).toBe("queued");

    // And it delivers — the wait-shaped wake is not silently dropped.
    await vi.advanceTimersByTimeAsync(0);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(1);
  });

  it("does not coalesce distinct elections fanned out within a single turn (preserved)", async () => {
    const sessionKey = "agent:main:coalesce-respects-982";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);

    const batch = await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-fanout",
      },
      requests: [
        { reason: "fanout-A", delaySeconds: 0 },
        { reason: "fanout-B", delaySeconds: 0 },
      ],
      config: immediateConfig,
    });

    // Both elections from THIS turn survive — cross-turn coalesce folds only
    // prior-turn parked rows, never the within-turn fan-out.
    expect(batch).toMatchObject({ scheduledCount: 2, cappedCount: 0 });
    const queued = [...mockFlows.values()].filter((flow) => flow.status === "queued");
    expect(queued).toHaveLength(2);
  });

  it("folds matured delayed active-overlap work into the active turn instead of stacking later naked wakes", async () => {
    const sessionKey = "agent:main:fold-active";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);

    await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
        chainId: "chain-fold-active",
      },
      requests: [{ reason: "summarize after the active turn", delaySeconds: 20 }],
      config,
      originRunId: "run-origin-A",
      originTurnId: "turn-origin-A",
    });
    await waitForMockWaiter(replyIdleWaiters, sessionKey);

    resolveReplyRunIdle(sessionKey);
    await vi.advanceTimersByTimeAsync(19_999);
    activeSessions.add(sessionKey);
    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();

    expect(turnGrants).toHaveLength(0);
    expect(activeQueueDeliveries).toHaveLength(1);
    const note = (activeQueueDeliveries[0] as { text: string }).text;
    expect(note).toContain(
      "A prior same-session continue_work intent matured while this session was active",
    );
    expect(note).toContain("Origin run: run-origin-A");
    expect(note).toContain("Origin turn: turn-origin-A");
    expect(note).toContain("Disposition: folded-active");
    expect(note).toContain("Re-evaluate before acting");
    const flow = [...mockFlows.values()][0];
    expect(flow?.status).toBe("succeeded");
    expect(flow?.stateJson).toMatchObject({
      anchorFinalizedAt: 1_000_000,
      dueAt: 1_020_000,
      disposition: "folded-active",
      originRunId: "run-origin-A",
      originTurnId: "turn-origin-A",
    });

    resolveReplyRunIdle(sessionKey);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(0);
  });

  it("still grants due delayed work when the session is idle", async () => {
    const sessionKey = "agent:main:fold-idle-grants";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);

    await scheduleContinuationWork({
      sessionKey,
      chainState: { currentChainCount: 0, chainStartedAt: Date.now(), accumulatedChainTokens: 0 },
      request: { delaySeconds: 5, reason: "idle grant proof" },
      config,
      originRunId: "run-origin-G",
      originTurnId: "turn-origin-G",
    });
    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    resolveReplyRunIdle(sessionKey);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushAsyncWork();

    expect(turnGrants).toHaveLength(1);
    expect((turnGrants[0] as { context: { Body: string } }).context.Body).toContain(
      "Origin run: run-origin-G",
    );
    expect((turnGrants[0] as { context: { Body: string } }).context.Body).toContain(
      "Disposition: granted",
    );
  });

  it("keeps active-fold rows recoverable when durable note delivery fails", async () => {
    const sessionKey = "agent:main:fold-note-fails";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 5_000,
      electedAt: Date.now() - 10_000,
      anchorFinalizedAt: Date.now() - 5_000,
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "fold after retry",
      originRunId: "run-origin-F",
    });
    activeSessions.add(sessionKey);
    activeQueueMode = "rejected";

    await dispatchPendingContinuationWork({ sessionKey });

    expect(activeQueueDeliveries).toHaveLength(1);
    const flow = [...mockFlows.values()][0];
    expect(flow?.status).toBe("queued");
    expect(flow?.stateJson).toMatchObject({
      dueAt: 1_000_000,
      recoveryDueAt: 1_030_000,
      anchorFinalizedAt: 995_000,
      originRunId: "run-origin-F",
    });
    expect(flow?.stateJson).not.toMatchObject({ disposition: "folded-active" });
  });

  it("parks active-fold rows for idle grant when the active run cannot prove note delivery", async () => {
    const sessionKey = "agent:main:fold-active-no-proof";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 5_000,
      electedAt: Date.now() - 10_000,
      anchorFinalizedAt: Date.now() - 5_000,
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "grant after unsupported active fold",
      originRunId: "run-origin-UP",
    });
    activeSessions.add(sessionKey);
    activeQueueHandleAvailable = false;

    await dispatchPendingContinuationWork({ sessionKey });

    expect(activeQueueDeliveries).toHaveLength(0);
    let flow = [...mockFlows.values()][0];
    expect(flow?.status).toBe("queued");
    expect(flow?.stateJson).toMatchObject({
      dueAt: 1_000_000,
      recoveryDueAt: 1_030_000,
      idleRetry: expect.objectContaining({ trigger: "reply-run-ended" }),
    });

    activeQueueHandleAvailable = true;
    resolveReplyRunIdle(sessionKey);
    await waitForTurnGrantCount(1);

    expect(turnGrants).toHaveLength(1);
    flow = [...mockFlows.values()][0];
    expect(flow?.status).toBe("succeeded");
    expect(flow?.stateJson).toMatchObject({
      disposition: "granted",
      dueAt: 1_000_000,
      originRunId: "run-origin-UP",
    });
  });
});
