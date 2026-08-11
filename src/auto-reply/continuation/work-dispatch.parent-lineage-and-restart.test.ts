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
  waitForTurnGrantCount,
  deleteSubagentSessionForCleanup,
  runWithGatewayRootWorkAdmission,
  DEFAULT_NO_OP_REARM_THRESHOLD,
  recordNoOpRearmOutcome,
  cancelPendingDelegates,
  enqueuePendingDelegate,
  pendingDelegateCount,
  classifyContinuationWorkReason,
  computeBusySkipBackoffMs,
  partitionSupersededWork,
  recoverPendingContinuationWork,
  scheduleContinuationWork,
  scheduleContinuationWorkBatch,
  hasLiveOrRecentlyDispatchedContinuationWork,
  markPendingWorkDelivered,
  markPendingWorkFoldDelivered,
  requeuePendingWork,
  config,
  flushTimers,
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

  describe("bucket-1 parent-lineage reap (design-pass §5)", () => {
    const REALISTIC_NOW = Date.parse("2026-04-25T12:00:00Z");

    function enqueueDelegateBusyFlow(
      sessionKey: string,
      opts: { parentRunId?: string; reason?: string } = {},
    ): void {
      mockSessionStore[sessionKey] = { sessionKey };
      activeSessions.add(sessionKey); // force a PRE-drive busy-skip (requests-in-flight)
      enqueuePendingWork({
        sessionKey,
        hop: 2,
        delayMs: 0,
        electedAt: Date.now(),
        dueAt: Date.now(),
        maxChainLength: 8,
        reason: opts.reason ?? "delegate continuation",
        ...(opts.parentRunId !== undefined ? { parentRunId: opts.parentRunId } : {}),
      });
    }

    function flowFor(sessionKey: string): MockFlow | undefined {
      return [...mockFlows.values()].find((f) => f.ownerKey === sessionKey);
    }

    it("same-session continue_work (no parentRunId) NEVER reaps → rate-cap-forever", async () => {
      const sessionKey = "agent:main:same-session";
      enqueueDelegateBusyFlow(sessionKey); // no parentRunId
      // Even a confident-terminal record for the key cannot reap — the gate fires first.
      addSubagentRun(sessionKey, { execution: { status: "terminal", endedAt: Date.now() - 1 } });
      const result = await dispatchPendingContinuationWork({ sessionKey });
      expect(result.reaped).toBe(0);
      const flow = flowFor(sessionKey);
      expect(flow?.status).toBe("queued"); // rate-capped, not reaped
      expect((flow?.stateJson as { busySkipCount?: number } | undefined)?.busySkipCount).toBe(1);
    });

    it("delegate-flow + parent-CONFIDENT-terminal → reap", async () => {
      const sessionKey = "agent:main:child-terminal";
      enqueueDelegateBusyFlow(sessionKey, { parentRunId: "run-parent" });
      addSubagentRun(sessionKey, { execution: { status: "terminal", endedAt: Date.now() - 1 } }); // explicit termination
      const result = await dispatchPendingContinuationWork({ sessionKey });
      expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 1 });
      const flow = flowFor(sessionKey);
      expect(flow?.status).toBe("succeeded");
      expect(flow?.currentStep?.startsWith("reaped:")).toBe(true);
      expect(turnGrants).toHaveLength(0);
    });

    it("delegate-flow + parent-ALIVE → rate-cap-forever", async () => {
      const sessionKey = "agent:main:child-alive";
      vi.setSystemTime(REALISTIC_NOW);
      enqueueDelegateBusyFlow(sessionKey, { parentRunId: "run-parent" });
      addSubagentRun(sessionKey, { createdAt: REALISTIC_NOW - 60_000 }); // fresh unended
      const result = await dispatchPendingContinuationWork({ sessionKey });
      expect(result.reaped).toBe(0);
      const flow = flowFor(sessionKey);
      expect(flow?.status).toBe("queued");
      expect((flow?.stateJson as { busySkipCount?: number } | undefined)?.busySkipCount).toBe(1);
    });

    it("delegate-flow + parent-UNCERTAIN (no run record) → rate-cap-forever (never wrongful-reap)", async () => {
      const sessionKey = "agent:main:child-uncertain";
      enqueueDelegateBusyFlow(sessionKey, { parentRunId: "run-parent" });
      // No subagent run record for this session → uncertain → quiesce.
      const result = await dispatchPendingContinuationWork({ sessionKey });
      expect(result.reaped).toBe(0);
      expect(flowFor(sessionKey)?.status).toBe("queued");
    });

    it("orphan in staleness-window reads-live → uncertain → rate-cap (not reap)", async () => {
      const sessionKey = "agent:main:child-stalewindow";
      vi.setSystemTime(REALISTIC_NOW);
      enqueueDelegateBusyFlow(sessionKey, { parentRunId: "run-parent" });
      // Unended, aged but still WITHIN the 2h stale window → reads alive → quiesce.
      addSubagentRun(sessionKey, {
        createdAt: REALISTIC_NOW - (STALE_UNENDED_SUBAGENT_RUN_MS - 60_000),
      });
      const result = await dispatchPendingContinuationWork({ sessionKey });
      expect(result.reaped).toBe(0);
      expect(flowFor(sessionKey)?.status).toBe("queued");
    });

    it("orphan post-staleness-cutoff → confident-terminal → reap", async () => {
      const sessionKey = "agent:main:child-stale";
      vi.setSystemTime(REALISTIC_NOW);
      enqueueDelegateBusyFlow(sessionKey, { parentRunId: "run-parent" });
      addSubagentRun(sessionKey, { createdAt: REALISTIC_NOW - STALE_UNENDED_SUBAGENT_RUN_MS - 1 });
      const result = await dispatchPendingContinuationWork({ sessionKey });
      expect(result.reaped).toBe(1);
      const flow = flowFor(sessionKey);
      expect(flow?.status).toBe("succeeded");
      expect(flow?.currentStep?.startsWith("reaped:")).toBe(true);
    });

    it("parent-liveness is read-time JOIN, never persisted (verdict recomputed each read)", async () => {
      const sessionKey = "agent:main:readtime-join";
      vi.setSystemTime(REALISTIC_NOW);
      enqueueDelegateBusyFlow(sessionKey, { parentRunId: "run-parent" });
      const run = "run-rtj";
      addSubagentRun(sessionKey, { runId: run, createdAt: REALISTIC_NOW - 60_000 }); // alive
      await dispatchPendingContinuationWork({ sessionKey });
      resetContinuationWorkDispatchForTests();
      const flow = flowFor(sessionKey);
      expect(flow?.status).toBe("queued"); // alive → rate-cap
      // No liveness verdict is ever frozen onto the durable row.
      expect(flow?.stateJson).not.toHaveProperty("parentState");
      expect(flow?.stateJson).not.toHaveProperty("parentLiveness");
      expect(flow?.stateJson).not.toHaveProperty("succeeded");

      // Parent dies AFTER the first classify. The next dispatch re-reads live.
      const record = subagentRuns.get(run);
      if (record) {
        record.execution = { ...record.execution, status: "terminal", endedAt: REALISTIC_NOW };
      }
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await dispatchPendingContinuationWork({ sessionKey });
      expect(result.reaped).toBe(1); // re-read → confident-terminal → reap (not a stale verdict)
    });

    it("specimen 14b1e6f9: classified in-flight×skip parent-alive THEN parent dies → reap on next read", async () => {
      const sessionKey = "agent:main:specimen-14b1e6f9";
      vi.setSystemTime(REALISTIC_NOW);
      enqueueDelegateBusyFlow(sessionKey, { parentRunId: "run-parent" });
      const run = "run-specimen";
      addSubagentRun(sessionKey, { runId: run, createdAt: REALISTIC_NOW - 60_000 });
      const first = await dispatchPendingContinuationWork({ sessionKey });
      expect(first.reaped).toBe(0); // alive → rate-cap, classified in-flight×skip
      resetContinuationWorkDispatchForTests();
      const record = subagentRuns.get(run);
      if (record) {
        record.execution = { ...record.execution, status: "terminal", endedAt: REALISTIC_NOW }; // parent dies between reads
      }
      await vi.advanceTimersByTimeAsync(60_000);
      const second = await dispatchPendingContinuationWork({ sessionKey });
      expect(second.reaped).toBe(1); // reaped on the next read, not a frozen verdict
    });

    it("in-flight×busy at re-arm bound → quiesce-not-fail (retryCount stays 0, alive parent)", async () => {
      const sessionKey = "agent:main:bound-quiesce";
      vi.setSystemTime(REALISTIC_NOW);
      enqueueDelegateBusyFlow(sessionKey, { parentRunId: "run-parent" });
      addSubagentRun(sessionKey, { createdAt: REALISTIC_NOW - 60_000 }); // alive throughout
      for (let i = 0; i < 12; i++) {
        const r = await dispatchPendingContinuationWork({ sessionKey });
        expect(r.failed).toBe(0);
        expect(r.reaped).toBe(0);
        resetContinuationWorkDispatchForTests();
        await vi.advanceTimersByTimeAsync(60_000);
      }
      const flow = flowFor(sessionKey);
      expect(flow?.status).toBe("queued");
      const state = flow?.stateJson as { busySkipCount?: number; retryCount?: number };
      expect(state.busySkipCount).toBe(12);
      expect(state.retryCount).toBeUndefined(); // busy-skip never feeds the fail-bound
      expect(systemEvents).toEqual([]);
    });

    it("confidence-gate at bound: persistently-uncertain → quiesce UNBOUNDED, never reap-on-bound (back-door closed)", async () => {
      const sessionKey = "agent:main:uncertain-forever";
      enqueueDelegateBusyFlow(sessionKey, { parentRunId: "run-parent" });
      // No run record ever → uncertain on every read.
      for (let i = 0; i < 15; i++) {
        const r = await dispatchPendingContinuationWork({ sessionKey });
        expect(r.reaped).toBe(0); // never reaps at the backoff bound
        expect(r.failed).toBe(0);
        resetContinuationWorkDispatchForTests();
        await vi.advanceTimersByTimeAsync(60_000);
      }
      const flow = flowFor(sessionKey);
      expect(flow?.status).toBe("queued"); // unbounded rate-cap, never dropped
      expect((flow?.stateJson as { retryCount?: number } | undefined)?.retryCount).toBeUndefined();
    });

    it("fail-cap (MAX_TRANSIENT_ERROR_RETRY_COUNT) is only reached by interrupted (threw), never by in-flight busy-skip", async () => {
      // The transient-error fail-bound (retryCount) is a THREW path; a busy-skip
      // (in-flight×skip) must never touch it. Prove both halves on delegate flows.
      const busyKey = "agent:main:failcap-busy";
      enqueueDelegateBusyFlow(busyKey, { parentRunId: "run-parent" }); // uncertain → rate-cap
      for (let i = 0; i < 10; i++) {
        await dispatchPendingContinuationWork({ sessionKey: busyKey });
        resetContinuationWorkDispatchForTests();
        await vi.advanceTimersByTimeAsync(60_000);
      }
      expect(
        (flowFor(busyKey)?.stateJson as { retryCount?: number } | undefined)?.retryCount,
      ).toBeUndefined();

      // Threw path DOES increment retryCount toward the fail-cap.
      const throwKey = "agent:main:failcap-threw";
      mockSessionStore[throwKey] = { sessionKey: throwKey };
      replyError = new Error("boom");
      enqueuePendingWork({
        sessionKey: throwKey,
        hop: 1,
        delayMs: 0,
        electedAt: Date.now(),
        dueAt: Date.now(),
        maxChainLength: 8,
        parentRunId: "run-parent",
        reason: "throws",
      });
      await dispatchPendingContinuationWork({ sessionKey: throwKey });
      expect(
        (flowFor(throwKey)?.stateJson as { retryCount?: number } | undefined)?.retryCount,
      ).toBe(1);
    });

    it("bucket1ReapVerdict gate matrix is pure (delegate-gate FIRST, only confident-terminal reaps)", () => {
      expect(bucket1ReapVerdict(undefined, "confident-terminal")).toBe("rate-cap-forever");
      expect(bucket1ReapVerdict(undefined, "alive")).toBe("rate-cap-forever");
      expect(bucket1ReapVerdict(undefined, "uncertain")).toBe("rate-cap-forever");
      expect(bucket1ReapVerdict("run-1", "confident-terminal")).toBe("reap");
      expect(bucket1ReapVerdict("run-1", "alive")).toBe("rate-cap-forever");
      expect(bucket1ReapVerdict("run-1", "uncertain")).toBe("rate-cap-forever");
    });
  });

  describe("own-turn subagent continue_work survives a busy-defer (never orphan-reaped)", () => {
    it("does NOT reap a no-parentRunId own-turn flow whose own subagent run is confident-terminal, then drives hop-2 once its own session quiets", async () => {
      // The regression: a tool-less subagent elects continue_work for itself.
      // Its electing run completes (endedAt set → confident-terminal) and the wake
      // arms. While the subagent's OWN session is still mid-turn, driveContinuationTurn
      // busy-skips on the own-session readiness gate (a subagent's direct grant runs on
      // its own session lane, not the cross-session main lane —). Pre-fix the
      // producer tagged parentRunId with the subagent's own electing run, so
      // bucket-1 read that run as a confident-terminal "orphan" and reaped the flow —
      // hop-2 never ran. The fix omits parentRunId for own-turn work, so the flow stays
      // on the never-reap rate-cap path and delivers when its own session quiets. This
      // pins that even a confident-terminal OWN run cannot authorize a reap of a
      // same-session own-turn election.
      const sessionKey = "agent:main:subagent:s952-ownturn";
      mockSessionStore[sessionKey] = { sessionKey };
      // The subagent's electing run has finished — confident-terminal in the registry.
      addSubagentRun(sessionKey, { execution: { status: "terminal", endedAt: Date.now() - 1 } });
      activeSessions.add(sessionKey); // own session still mid-turn → drive busy-skips
      enqueuePendingWork({
        sessionKey,
        hop: 2,
        delayMs: 0,
        electedAt: Date.now(),
        dueAt: Date.now(),
        maxChainLength: 8,
        reason: "own-turn continuation",
        // NO parentRunId — own-turn continue_work carries no spawning lineage (fix).
      });

      const skip = await dispatchPendingContinuationWork({ sessionKey });
      // Rate-capped, NOT reaped — the confident-terminal own run must not cull it.
      expect(skip).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
      expect([...mockFlows.values()][0]?.status).toBe("queued");
      expect(turnGrants).toHaveLength(0);

      // Own session quiets → the requeued wake matures and drives hop-2 into the subagent.
      resetContinuationWorkDispatchForTests();
      await vi.advanceTimersByTimeAsync(60_000);
      activeSessions.delete(sessionKey);
      const driven = await dispatchPendingContinuationWork({ sessionKey });
      expect(driven.dispatched).toBe(1);
      expect(turnGrants).toEqual([
        expect.objectContaining({
          context: expect.objectContaining({
            SessionKey: sessionKey,
            Body: expect.stringContaining("own-turn continuation"),
          }),
          options: expect.objectContaining({ continuationTrigger: "work-wake" }),
        }),
      ]);
    });
  });

  describe("locus-3 durable delivered-mark restart-gap (PART B)", () => {
    function enqueueMatured(sessionKey: string, reason: string): void {
      mockSessionStore[sessionKey] = { sessionKey };
      enqueuePendingWork({
        sessionKey,
        hop: 1,
        delayMs: 0,
        electedAt: Date.now(),
        dueAt: Date.now(),
        maxChainLength: 8,
        reason,
      });
    }

    it("writes the durable optimal+durable succeeded mark when a wake is delivered", async () => {
      const sessionKey = "agent:main:locus3-deliver";
      enqueueMatured(sessionKey, "deliver");
      const result = await dispatchPendingContinuationWork({ sessionKey });
      expect(result.dispatched).toBe(1);
      const flow = [...mockFlows.values()][0];
      expect(flow?.status).toBe("succeeded");
      expect((flow?.stateJson as { succeeded?: unknown } | undefined)?.succeeded).toEqual({
        point: "optimal",
        durability: "durable",
      });
    });

    it("mark optimal+durable BEFORE restart-window → reboot read-guard SKIPs (no dup)", async () => {
      const sessionKey = "agent:main:locus3-skip";
      enqueueMatured(sessionKey, "delivered then crashed");
      // Simulate a crash AFTER the durable deliver-mark but BEFORE finishFlow:
      // the row is durably `running` WITH the succeeded marker persisted.
      const flow = [...mockFlows.values()][0];
      if (!flow) {
        throw new Error("expected flow");
      }
      flow.status = "running";
      flow.updatedAt = Date.now() - 200_000; // older than the 60s recovery window
      flow.stateJson = {
        ...(flow.stateJson as object),
        succeeded: { point: "optimal", durability: "durable" },
      };

      const result = await dispatchPendingContinuationWork({
        sessionKey,
        recoverRunning: true,
        includeRunningUpdatedAtOrBefore: Date.now() - 60_000,
      });
      expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
      expect(turnGrants).toHaveLength(0); // read-guard skipped → no re-delivery
      expect(flow.status).toBe("succeeded");
      expect(flow.currentStep).toBe("Same-session continuation turn granted");
    });

    it("durable-persist required: a running row WITHOUT the durable mark RE-DRIVES on reboot (coupling)", () => {
      // Coupling proof (test_durable_persist_required): mark-LOCATION alone is
      // insufficient — without the persisted `succeeded` marker the read-guard
      // cannot recognize the row as delivered, so consume returns it for re-drive.
      const sessionKey = "agent:main:locus3-couple";
      enqueueMatured(sessionKey, "unmarked crash");
      const flow = [...mockFlows.values()][0];
      if (!flow) {
        throw new Error("expected flow");
      }
      flow.status = "running";
      flow.updatedAt = Date.now() - 200_000;
      // No `succeeded` persisted → the read-guard is blind to it.
      const recovered = consumePendingWork(sessionKey, {
        includeRunning: true,
        includeRunningUpdatedAtOrBefore: Date.now() - 60_000,
      });
      expect(recovered).toHaveLength(1); // re-consumed (would re-deliver) — coupling required
    });

    it("a durably-marked running row is NOT re-consumed (read-guard)", () => {
      const sessionKey = "agent:main:locus3-guard";
      enqueueMatured(sessionKey, "delivered");
      const flow = [...mockFlows.values()][0];
      if (!flow) {
        throw new Error("expected flow");
      }
      flow.status = "running";
      flow.updatedAt = Date.now() - 200_000;
      flow.stateJson = {
        ...(flow.stateJson as object),
        succeeded: { point: "optimal", durability: "durable" },
      };
      const recovered = consumePendingWork(sessionKey, {
        includeRunning: true,
        includeRunningUpdatedAtOrBefore: Date.now() - 60_000,
      });
      expect(recovered).toHaveLength(0); // read-guard skipped the delivered row
    });
  });
});
