import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const turnGrants: unknown[] = [];
const systemEvents: unknown[] = [];
const activeQueueDeliveries: unknown[] = [];
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
// #1144 test state: toggle continuation enablement (disabled-gate), capture the
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
    isActive: (sessionKey: string) => activeSessions.has(sessionKey),
    resolveSessionId: (sessionKey: string) =>
      activeSessions.has(sessionKey) ? `active-session:${sessionKey}` : undefined,
    waitForIdle: (sessionKey: string, _timeoutMs?: number, opts?: { signal?: AbortSignal }) =>
      waitForMockIdle(
        replyIdleWaiters,
        sessionKey,
        () => !activeSessions.has(sessionKey),
        opts?.signal,
      ),
  },
}));

vi.mock("../../agents/embedded-agent-runner/runs.js", () => ({
  isEmbeddedAgentRunHandleActive: vi.fn(() => activeQueueHandleAvailable),
  queueEmbeddedAgentMessageWithOutcomeAsync: vi.fn(async (sessionId: string, text: string) => {
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
    if (observeSubordinateAdmission) {
      const { isGatewaySubordinateWorkAdmissionClosed } =
        await import("../../process/gateway-work-admission.js");
      observedSubordinateAdmissionClosed.push(isGatewaySubordinateWorkAdmissionClosed());
    }
    // Capture the active diagnostic traceparent so tests can assert the
    // continuation turn re-enters the persisted work.traceparent (#1144).
    const { formatActiveDiagnosticTraceparent } =
      await import("../../infra/diagnostic-trace-context.js");
    capturedReplyTraceparents.push(formatActiveDiagnosticTraceparent());
    // Simulate a revision/cancel race landing between claim and delivered-mark:
    // bump every continuation-work flow revision so markPendingWorkDelivered
    // fails its expected-revision check after the turn already ran (#1144).
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
import {
  resetGatewayWorkAdmission,
  runWithGatewayRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
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

describe("durable continuation_work dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    turnGrants.length = 0;
    systemEvents.length = 0;
    activeQueueDeliveries.length = 0;
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

  it("honors hot-disabled continuation before consuming or driving queued work (#1144)", async () => {
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

  it("re-enters the persisted work.traceparent around the continuation turn (#1144)", async () => {
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
    // inbound context or options (#1152/#1156 boundary).
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

  it("does not replay a turn when the durable delivered-mark loses the revision race (#1144)", async () => {
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

    // #1144 round-6: the reconciled row is terminalized immediately, not left
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
      },
      timeoutMs: 10_000,
    });
  });

  it("retains a child session while a queued continuation delegate is pending (#1144)", async () => {
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

  it("retains a child session while a claimed (running) continuation delegate is dispatching (#1144)", async () => {
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
    });
    // Must still defer: a queued-only gate would delete the child out from under
    // the running delegate (#1144).
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

  it("drives a freshly created SQLite session that is absent from the legacy snapshot", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-continuation-work-"));
    mockStorePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:fresh-sqlite-session";
    const actualAccessor = await vi.importActual<
      typeof import("../../config/sessions/session-accessor.js")
    >("../../config/sessions/session-accessor.js");
    try {
      await actualAccessor.upsertSessionEntry(
        { sessionKey, storePath: mockStorePath },
        {
          sessionId: "fresh-sqlite-session-id",
          updatedAt: Date.now(),
        },
      );
      expect(mockSessionStore[sessionKey]).toBeUndefined();
      loadSessionEntryMock.mockImplementation((scope) => actualAccessor.loadSessionEntry(scope));
      enqueuePendingWork({
        sessionKey,
        hop: 2,
        delayMs: 0,
        electedAt: Date.now(),
        dueAt: Date.now(),
        maxChainLength: 8,
        reason: "fresh SQLite proof",
      });

      const result = await dispatchPendingContinuationWork({ sessionKey });

      expect(result).toEqual({ dispatched: 1, failed: 0, reaped: 0 });
      expect(turnGrants).toEqual([
        expect.objectContaining({
          context: expect.objectContaining({
            SessionKey: sessionKey,
            Body: expect.stringContaining("fresh SQLite proof"),
          }),
        }),
      ]);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("recovers persisted idle-retry rows without waiting for the slow hedge", async () => {
    const sessionKey = "agent:main:recover-idle-retry";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "recover idle retry",
    });

    await dispatchPendingContinuationWork({ sessionKey });
    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    resetContinuationWorkDispatchForTests();
    activeSessions.delete(sessionKey);

    await recoverPendingContinuationWork();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("recover idle retry"),
        }),
      }),
    ]);
    expect(replyIdleWaiters.has(sessionKey)).toBe(false);
  });

  it("recovers running idle-retry rows on the stale-running window instead of the future hedge", async () => {
    const sessionKey = "agent:main:running-idle-retry-recovery";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 300_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 300_000,
      maxChainLength: 8,
      reason: "running idle retry recovery",
    });
    const flow = [...mockFlows.values()][0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    flow.stateJson = {
      ...(flow.stateJson as object),
      idleRetry: {
        trigger: "reply-run-ended",
        reasonCategory: "follow-up-work",
        armedAt: Date.now(),
      },
    };
    consumePendingWork(sessionKey, { includeIdleRetry: true });

    await vi.advanceTimersByTimeAsync(59_999);
    await recoverPendingContinuationWork();
    expect(turnGrants).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await recoverPendingContinuationWork();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("running idle retry recovery"),
        }),
      }),
    ]);
  });

  it("lets the armed hedge timer recover running idle-retry rows before the future hedge", async () => {
    const sessionKey = "agent:main:running-idle-retry-timer-recovery";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 300_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 300_000,
      maxChainLength: 8,
      reason: "running idle retry timer recovery",
    });
    const flow = [...mockFlows.values()][0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    flow.stateJson = {
      ...(flow.stateJson as object),
      idleRetry: {
        trigger: "reply-run-ended",
        reasonCategory: "follow-up-work",
        armedAt: Date.now(),
      },
    };
    consumePendingWork(sessionKey, { includeIdleRetry: true });

    await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now() - 60_000,
    });

    await vi.advanceTimersByTimeAsync(59_999);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("running idle retry timer recovery"),
        }),
      }),
    ]);
  });

  it("does not let idle-event dispatch clear a running idle-retry recovery timer", async () => {
    const sessionKey = "agent:main:idle-dispatch-preserves-running-recovery";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 300_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 300_000,
      maxChainLength: 8,
      reason: "preserved running recovery",
    });
    const flow = [...mockFlows.values()][0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    flow.stateJson = {
      ...(flow.stateJson as object),
      idleRetry: {
        trigger: "reply-run-ended",
        reasonCategory: "follow-up-work",
        armedAt: Date.now(),
      },
    };
    consumePendingWork(sessionKey, { includeIdleRetry: true });

    await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now() - 60_000,
    });
    await dispatchPendingContinuationWork({ sessionKey, includeIdleRetry: true });

    await vi.advanceTimersByTimeAsync(60_000);
    await flushAsyncWork();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("preserved running recovery"),
        }),
      }),
    ]);
  });

  it("retries busy same-session work from the reply-run end event instead of near-1Hz polling", async () => {
    const sessionKey = "agent:main:busy";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "busy proof",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    const flow = [...mockFlows.values()][0];
    expect(flow).toMatchObject({ status: "queued" });
    expect(flow?.currentStep).toBe("Requeued same-session continuation wake");
    expect(flow?.stateJson).toMatchObject({
      busySkipCount: 1,
      dueAt: Date.now() + 60_000,
      idleRetry: {
        trigger: "reply-run-ended",
        reasonCategory: "follow-up-work",
        armedAt: Date.now(),
      },
    });
    expect(systemEvents).toEqual([]);
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();

    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(0);

    resolveReplyRunIdle(sessionKey);
    await waitForTurnGrantCount(1);

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("busy proof"),
        }),
        options: expect.objectContaining({ continuationTrigger: "work-wake" }),
      }),
    ]);
  });

  it("arms zero-delay work for the next tick so callers can persist chain state first", async () => {
    const sessionKey = "agent:main:immediate";
    mockSessionStore[sessionKey] = { sessionKey };
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
        accumulatedChainTokens: 3,
      },
      request: { delaySeconds: 0, reason: "persist first" },
      config: immediateConfig,
    });

    expect(turnGrants).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(0);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("persist first"),
        }),
      }),
    ]);
  });

  it("enters fresh gateway admission when delayed work fires after its request ends", async () => {
    const sessionKey = "agent:main:released-parent-timer";
    mockSessionStore[sessionKey] = { sessionKey };
    observeSubordinateAdmission = true;
    const immediateConfig = {
      ...config,
      defaultDelayMs: 0,
      minDelayMs: 0,
    } satisfies ContinuationRuntimeConfig;

    await runWithGatewayRootWorkAdmission(async () => {
      await scheduleContinuationWork({
        sessionKey,
        chainState: {
          currentChainCount: 0,
          chainStartedAt: Date.now(),
          accumulatedChainTokens: 0,
        },
        request: { delaySeconds: 0, reason: "fire after request release" },
        config: immediateConfig,
      });
    });

    await vi.advanceTimersByTimeAsync(0);
    await flushTimers();

    expect(observedSubordinateAdmissionClosed).toEqual([false]);
    expect(turnGrants).toHaveLength(1);
  });

  it("enters fresh gateway admission when an idle retry outlives its request", async () => {
    const sessionKey = "agent:main:released-parent-idle-retry";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    observeSubordinateAdmission = true;
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "idle retry after request release",
    });

    await runWithGatewayRootWorkAdmission(async () => {
      await dispatchPendingContinuationWork({ sessionKey });
      await waitForMockWaiter(replyIdleWaiters, sessionKey);
    });

    resolveReplyRunIdle(sessionKey);
    await waitForTurnGrantCount(1);

    expect(observedSubordinateAdmissionClosed).toEqual([false]);
    expect(turnGrants).toHaveLength(1);
  });

  it("retries main-session work from the command-lane idle event instead of polling queue busy", async () => {
    const sessionKey = "agent:main:queued-user-turn";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "queued user turn",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(0);
    expect([...mockFlows.values()][0]).toMatchObject({
      status: "queued",
      currentStep: "Requeued same-session continuation wake",
      stateJson: expect.objectContaining({
        dueAt: Date.now() + 60_000,
        idleRetry: expect.objectContaining({
          trigger: "command-lane-idle",
          reasonCategory: "follow-up-work",
        }),
      }),
    });
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();

    await waitForMockWaiter(laneIdleWaiters, "main");
    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(0);

    resolveCommandLaneIdle();
    await waitForTurnGrantCount(1);

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("queued user turn"),
        }),
      }),
    ]);
  });

  it("recovers queued idle-retry work promptly when idle waiter registration fails", async () => {
    const sessionKey = "agent:main:idle-waiter-registration-fails";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    commandLaneIdleError = new Error("idle waiter unavailable");
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "recover after idle waiter failure",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(0);
    expect([...mockFlows.values()][0]).toMatchObject({
      status: "queued",
      stateJson: expect.objectContaining({
        dueAt: Date.now() + 60_000,
        idleRetry: expect.objectContaining({ trigger: "command-lane-idle" }),
      }),
    });

    commandLaneIdleError = undefined;
    mainQueueSize = 0;
    await vi.advanceTimersByTimeAsync(30_000);
    await waitForTurnGrantCount(1);

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("recover after idle waiter failure"),
        }),
      }),
    ]);
  });

  it("keeps idle-retry failure recovery when normal scheduling arms the session timer", async () => {
    const sessionKey = "agent:main:idle-waiter-failure-plus-normal-work";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    commandLaneIdleError = new Error("idle waiter unavailable");
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "parked after idle waiter failure",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    commandLaneIdleError = undefined;
    mainQueueSize = 0;

    await scheduleContinuationWork({
      config,
      sessionKey,
      chainState: {
        currentChainCount: 0,
        chainStartedAt: Date.now(),
        accumulatedChainTokens: 0,
      },
      request: {
        delaySeconds: 45,
        reason: "normal work should not clobber idle-retry recovery",
      },
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await waitForTurnGrantCount(1);
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          Body: expect.stringContaining("parked after idle waiter failure"),
        }),
      }),
    ]);

    await vi.advanceTimersByTimeAsync(15_000);
    await waitForTurnGrantCount(2);
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          Body: expect.stringContaining("parked after idle waiter failure"),
        }),
      }),
      expect.objectContaining({
        context: expect.objectContaining({
          Body: expect.stringContaining("normal work should not clobber idle-retry recovery"),
        }),
      }),
    ]);
  });

  it("busy-skips a main-session continuation when the global main lane is busy", async () => {
    const sessionKey = "agent:main:main-lane-busy-positive-control";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "main lane positive control",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(0);
  });

  it("keeps a slow hedge as the safety net when an idle event is lost", async () => {
    const sessionKey = "agent:main:lost-idle-event";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "follow up after busy turn",
    });

    await dispatchPendingContinuationWork({ sessionKey });
    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    activeSessions.delete(sessionKey);

    await vi.advanceTimersByTimeAsync(59_999);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("follow up after busy turn"),
        }),
      }),
    ]);
  });

  it("parks wait-shaped continuation rows behind idle events without a high-frequency wake loop", async () => {
    const sessionKey = "agent:main:wait-shaped";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    enqueuePendingWork({
      sessionKey,
      hop: 41,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 200,
      reason: "Clearing wake cascade. Yielding and standing by.",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
    const flow = [...mockFlows.values()][0];
    expect(flow).toMatchObject({
      status: "queued",
      stateJson: expect.objectContaining({
        dueAt: Date.now() + 60_000,
        idleRetry: {
          trigger: "reply-run-ended",
          reasonCategory: "wait-shaped",
          armedAt: Date.now(),
        },
      }),
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();

    expect(turnGrants).toHaveLength(0);
    expect([...mockFlows.values()][0]?.status).toBe("queued");
  });

  it("terminal-parks a continuation work row without a provider call once the no-op replay streak is tripped (#1138/#1142)", async () => {
    const sessionKey = "agent:main:noop-rearm";
    mockSessionStore[sessionKey] = { sessionKey };

    // Seed the per-session no-op streak to the threshold via self-rearm no-op
    // outcomes, as repeated low-value continuation turns would in production.
    for (let i = 0; i < DEFAULT_NO_OP_REARM_THRESHOLD; i += 1) {
      recordNoOpRearmOutcome({
        sessionKey,
        wakeClass: { kind: "self_rearm", source: "continuation" },
        runId: `seed-${i}`,
        outcome: { kind: "no_op", reason: "seed" },
      });
    }

    enqueuePendingWork({
      sessionKey,
      hop: 12,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 200,
      reason: "Holding off-board and standing by.",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    // The guard blocks before getReplyFromConfig: no provider turn is bought.
    expect(getReplyFromConfigMock).not.toHaveBeenCalled();
    expect(result).toEqual({ dispatched: 0, failed: 1, reaped: 0 });
    // The row is superseded (clean terminal: finishFlow), not requeued or failed,
    // so it stops re-arming and emits no re-waking system warning.
    const flow = [...mockFlows.values()][0];
    expect(flow?.status).toBe("succeeded");
    expect(flow?.endedAt).toBeDefined();
    expect(String(flow?.currentStep)).toContain("superseded");
    expect(systemEvents).toHaveLength(0);
  });

  it("does not let a busy slow hedge delay another continuation due sooner", async () => {
    const sessionKey = "agent:main:busy-with-sooner-sibling";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "busy now",
    });
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 5_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 5_000,
      maxChainLength: 8,
      reason: "due sooner than busy hedge",
    });

    await dispatchPendingContinuationWork({ sessionKey });

    await vi.advanceTimersByTimeAsync(4_999);
    await flushAsyncWork();
    const siblingBeforeDue = [...mockFlows.values()].find((flow) =>
      String((flow.stateJson as { reason?: string } | undefined)?.reason).includes("due sooner"),
    );
    if (!siblingBeforeDue) {
      throw new Error("expected sibling continuation flow");
    }
    expect(
      (siblingBeforeDue.stateJson as { busySkipCount?: number }).busySkipCount,
    ).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await flushAsyncWork();

    const siblingAfterDue = [...mockFlows.values()].find((flow) =>
      String((flow.stateJson as { reason?: string } | undefined)?.reason).includes("due sooner"),
    );
    if (!siblingAfterDue) {
      throw new Error("expected sibling continuation flow");
    }
    expect((siblingAfterDue.stateJson as { busySkipCount?: number }).busySkipCount).toBe(1);
    expect(turnGrants).toHaveLength(0);
  });

  it("does not let a busy slow hedge delay running recovery due sooner", async () => {
    const sessionKey = "agent:main:busy-with-running-recovery";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "running recovery sooner",
    });
    const runningFlow = [...mockFlows.values()][0];
    if (!runningFlow) {
      throw new Error("expected running continuation flow");
    }
    runningFlow.status = "running";
    runningFlow.updatedAt = Date.now() - 50_000;
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "busy slow hedge",
    });
    mainQueueSize = 1;

    await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now() - 60_000,
    });
    expect(turnGrants).toHaveLength(0);
    await waitForMockWaiter(laneIdleWaiters, "main");
    mainQueueSize = 0;
    await vi.advanceTimersByTimeAsync(5_000);
    await flushAsyncWork();
    expect(turnGrants).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(5_000);
    await waitForTurnGrantCount(1);

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          Body: expect.stringContaining("running recovery sooner"),
        }),
      }),
    ]);
  });

  it("keeps the shared idle waiter when a hedge delivers one of several parked rows", async () => {
    const sessionKey = "agent:main:sibling-idle-retry";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "first parked row",
    });
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 5_000,
      electedAt: Date.now(),
      dueAt: Date.now() + 5_000,
      maxChainLength: 8,
      reason: "second parked row",
    });

    await dispatchPendingContinuationWork({ sessionKey });
    await waitForMockWaiter(replyIdleWaiters, sessionKey);
    await vi.advanceTimersByTimeAsync(5_000);
    await flushAsyncWork();

    activeSessions.delete(sessionKey);
    await vi.advanceTimersByTimeAsync(55_000);
    await flushAsyncWork();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("first parked row") }),
      }),
    ]);
    expect(replyIdleWaiters.has(sessionKey)).toBe(true);

    resolveReplyRunIdle(sessionKey);
    await waitForTurnGrantCount(2);

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("first parked row") }),
      }),
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("second parked row") }),
      }),
    ]);
  });

  it("drives a subagent continuation to completion on its own session lane when main is busy (#1057)", async () => {
    const sessionKey = "agent:main:subagent:cross-session-independence-1057";
    mockSessionStore[sessionKey] = { sessionKey };
    mainQueueSize = 1;
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "cross-session independence",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 1, failed: 0, reaped: 0 });
    expect([...mockFlows.values()][0]).toMatchObject({ status: "succeeded" });
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("cross-session independence"),
        }),
        options: expect.objectContaining({
          continuationTrigger: "work-wake",
          lane: `session:${sessionKey}`,
        }),
      }),
    ]);
  });

  it("recovers only stale running continuation work", async () => {
    const sessionKey = "agent:main:running-recovery";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "running recovery",
    });
    const flow = [...mockFlows.values()][0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    flow.status = "running";
    flow.updatedAt = Date.now();

    await recoverPendingContinuationWork();

    expect(turnGrants).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({
          SessionKey: sessionKey,
          Body: expect.stringContaining("running recovery"),
        }),
      }),
    ]);
  });

  it("does not reclaim stale running work while an in-process reply still owns the session", async () => {
    const sessionKey = "agent:main:active-running-recovery";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "active running recovery",
    });
    const flow = [...mockFlows.values()][0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    flow.status = "running";
    flow.updatedAt = Date.now() - 200_000;
    activeSessions.add(sessionKey);

    const result = await recoverPendingContinuationWork();

    expect(result).toEqual({ sessions: 1, dispatched: 0, failed: 0, reaped: 0 });
    expect(flow).toMatchObject({ status: "running" });
    expect(flow.stateJson).not.toMatchObject({ busySkipCount: expect.any(Number) });
    expect(turnGrants).toHaveLength(0);
  });

  it("still finalizes delivered-marked running rows while active-reply recovery is blocked", async () => {
    const sessionKey = "agent:main:active-delivered-recovery";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "active delivered recovery",
    });
    const flow = [...mockFlows.values()][0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    flow.status = "running";
    flow.updatedAt = Date.now() - 200_000;
    flow.stateJson = {
      ...(flow.stateJson as object),
      succeeded: { point: "optimal", durability: "durable" },
    };
    activeSessions.add(sessionKey);

    const result = await recoverPendingContinuationWork();

    expect(result).toEqual({ sessions: 1, dispatched: 0, failed: 0, reaped: 0 });
    expect(flow.status).toBe("succeeded");
    expect(flow.currentStep).toBe("Same-session continuation turn granted");
    expect(turnGrants).toHaveLength(0);
  });

  it("finalizes a completed turn when the gateway starts draining after the grant", async () => {
    const sessionKey = "agent:main:draining-after-grant";
    mockSessionStore[sessionKey] = { sessionKey };
    drainAfterReply = true;
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "drain after grant",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 1, failed: 0, reaped: 0 });
    expect([...mockFlows.values()][0]).toMatchObject({ status: "succeeded" });
    expect(systemEvents).toEqual([]);

    drainAfterReply = false;
    gatewayDraining = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("drain after grant") }),
      }),
    ]);
  });

  it("requeues when gateway drain prevents the turn grant", async () => {
    const sessionKey = "agent:main:draining-before-grant";
    mockSessionStore[sessionKey] = { sessionKey };
    gatewayDraining = true;
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "drain before grant",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toEqual([]);
    expect(systemEvents).toEqual([]);
    expect([...mockFlows.values()][0]).toMatchObject({
      status: "queued",
      currentStep: "Requeued same-session continuation wake",
    });

    gatewayDraining = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("drain before grant") }),
      }),
    ]);
  });

  it("requeues when getReply returns only the gateway-draining notice", async () => {
    const sessionKey = "agent:main:drain-payload";
    mockSessionStore[sessionKey] = { sessionKey };
    drainAfterReply = true;
    replyPayloadOverride = {
      text: "⚠️ Gateway is restarting. Please wait a few seconds and try again.",
    };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "drain payload",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toEqual([]);
    expect(systemEvents).toEqual([]);
    expect([...mockFlows.values()][0]).toMatchObject({
      status: "queued",
      currentStep: "Requeued same-session continuation wake",
    });
  });

  it("requeues transient turn-grant errors instead of failing the durable work", async () => {
    const sessionKey = "agent:main:transient-error";
    mockSessionStore[sessionKey] = { sessionKey };
    replyError = new Error("provider unavailable");
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "transient proof",
    });

    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    const flow = [...mockFlows.values()][0];
    expect(flow).toMatchObject({
      status: "queued",
      currentStep: "Requeued same-session continuation wake",
    });
    expect(flow?.stateJson).toMatchObject({ retryCount: 1 });

    replyError = undefined;
    await vi.advanceTimersByTimeAsync(5_000);
    await flushTimers();

    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("transient proof") }),
      }),
    ]);
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

  it("delivers a distinct wake for every continue_work election scheduled in one turn (#982)", async () => {
    // Regression for #982: N continue_work() calls in one model turn must each
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

  it("bounds the observed 3x same-turn continue_work delays as three scheduled terminal wakes (#1147)", async () => {
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

  it("parks a 3x same-turn continue_work burst while requests are in flight without a tight wake loop (#1147)", async () => {
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

  it("never supersedes a recovered running wake folded against a newer queued election (#988-P2-1)", async () => {
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

  it("uses the busy-skip ceiling as a slow hedge while idle events own normal retry", async () => {
    const sessionKey = "agent:main:busy-slow-hedge";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "storm",
    });

    for (let i = 0; i < 4; i++) {
      await dispatchPendingContinuationWork({ sessionKey });
      // Drop the just-armed idle listener/timer so each re-consume is deterministic.
      resetContinuationWorkDispatchForTests();
      const flow = [...mockFlows.values()][0];
      expect(flow?.status).toBe("queued");
      const state = flow?.stateJson as {
        dueAt: number;
        busySkipCount?: number;
        retryCount?: number;
      };
      expect(state.dueAt - Date.now()).toBe(60_000);
      expect(state.busySkipCount).toBe(i + 1);
      expect(state.retryCount).toBeUndefined(); // busy-skip never penalizes
      await vi.advanceTimersByTimeAsync(60_000);
    }

    expect(turnGrants).toHaveLength(0); // never driven while busy, never dropped
    expect(systemEvents).toEqual([]); // never failed
  });

  it("never increments retryCount or drops the flow across many busy-skips (rate-cap-forever, #952 never-penalize)", async () => {
    const sessionKey = "agent:main:busy-forever";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "forever busy",
    });

    // Far more skips than MAX_TRANSIENT_ERROR_RETRY_COUNT (8): a busy-defer must
    // never approach the fail-bound, never fail, never drop.
    for (let i = 0; i < 20; i++) {
      await dispatchPendingContinuationWork({ sessionKey });
      resetContinuationWorkDispatchForTests();
      await vi.advanceTimersByTimeAsync(60_000); // mature past the ceiling each loop
    }

    const flow = [...mockFlows.values()][0];
    expect(flow?.status).toBe("queued"); // never failed/dropped — still deliverable
    const state = flow?.stateJson as { busySkipCount?: number; retryCount?: number };
    expect(state.busySkipCount).toBe(20);
    expect(state.retryCount).toBeUndefined();
    expect(turnGrants).toHaveLength(0);
    expect(systemEvents).toEqual([]); // no failure warning ever enqueued
  });

  it("resets busySkipCount to 0 and delivers once a busy-deferred flow finally drives (#990 Pillar-0 + #952-preserve)", async () => {
    const sessionKey = "agent:main:busy-then-drive";
    mockSessionStore[sessionKey] = { sessionKey };
    activeSessions.add(sessionKey);
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "deferred then drives",
    });

    for (let i = 0; i < 3; i++) {
      await dispatchPendingContinuationWork({ sessionKey });
      resetContinuationWorkDispatchForTests();
      await vi.advanceTimersByTimeAsync(60_000);
    }
    const deferredState = [...mockFlows.values()][0]?.stateJson as { busySkipCount?: number };
    expect(deferredState.busySkipCount).toBe(3);

    // Seat quiets: the legit-deferred flow delivers (never dropped, #952), and the
    // granted record clears the backoff counter (rate-cap, never permanent).
    activeSessions.clear();
    const result = await dispatchPendingContinuationWork({ sessionKey });

    expect(result).toEqual({ dispatched: 1, failed: 0, reaped: 0 });
    const flow = [...mockFlows.values()][0];
    expect(flow?.status).toBe("succeeded");
    const state = flow?.stateJson as { busySkipCount?: number; turnGrantedAt?: number };
    expect(state.busySkipCount).toBe(0);
    expect(state.turnGrantedAt).toBeGreaterThan(0);
    expect(turnGrants).toEqual([
      expect.objectContaining({
        context: expect.objectContaining({ Body: expect.stringContaining("deferred then drives") }),
      }),
    ]);
  });

  it("does not re-consume a cancel-requested continuation work flow (:259 dedup harden, #990 Pillar-0)", async () => {
    const sessionKey = "agent:main:cancel-requested";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "cancel requested",
    });
    const flow = [...mockFlows.values()][0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    // User requested cancel; the maintenance reaper has not yet finalized it.
    flow.cancelRequestedAt = Date.now();

    const result = await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now(),
    });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(0);
    // Left untouched (still queued) for the reaper to finalize — not driven.
    expect([...mockFlows.values()][0]?.status).toBe("queued");
  });

  it("does not re-consume a terminal (succeeded) continuation work flow (:259 structural dedup)", async () => {
    const sessionKey = "agent:main:already-succeeded";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "already succeeded",
    });
    const flow = [...mockFlows.values()][0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    flow.status = "succeeded";
    flow.stateJson = {
      ...(flow.stateJson as object),
      succeeded: { point: "optimal", durability: "durable" },
    };
    const revisionBefore = flow.revision;
    const updatedAtBefore = flow.updatedAt;

    const result = await dispatchPendingContinuationWork({
      sessionKey,
      recoverRunning: true,
      includeRunningUpdatedAtOrBefore: Date.now(),
    });

    expect(result).toEqual({ dispatched: 0, failed: 0, reaped: 0 });
    expect(turnGrants).toHaveLength(0);
    expect(flow).toMatchObject({ status: "succeeded", revision: revisionBefore });
    expect(flow.updatedAt).toBe(updatedAtBefore);
  });

  it("does not count a delivered-marked-but-still-running flow as live work (#990 P2 / #996 — cleanup-guard matches the consume-guard)", () => {
    // Crash in the markPendingWorkDelivered -> finishFlow gap leaves the flow
    // `status:running` with `stateJson.succeeded` set. The consume-guards (:221,
    // :485) already exclude it from re-delivery; hasLiveOrRecentlyDispatchedContinuationWork
    // must match, or deleteSubagentSessionForCleanup / the registry sweep treat
    // the delivered row as live and strand its child session forever.
    const sessionKey = "agent:main:delivered-but-running";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "delivered but crashed before finishFlow",
    });
    const flow = [...mockFlows.values()][0];
    if (!flow) {
      throw new Error("expected mock flow");
    }
    // delivered-marked, but finishFlow never ran (process died in the gap):
    flow.status = "running";
    flow.stateJson = {
      ...(flow.stateJson as Record<string, unknown>),
      succeeded: { point: "optimal", durability: "durable" },
    };

    expect(hasLiveOrRecentlyDispatchedContinuationWork(sessionKey)).toBe(false);
  });

  describe("#990 bucket-1 parent-lineage reap (design-pass §5)", () => {
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
      addSubagentRun(sessionKey, { endedAt: Date.now() - 1 });
      const result = await dispatchPendingContinuationWork({ sessionKey });
      expect(result.reaped).toBe(0);
      const flow = flowFor(sessionKey);
      expect(flow?.status).toBe("queued"); // rate-capped, not reaped
      expect((flow?.stateJson as { busySkipCount?: number } | undefined)?.busySkipCount).toBe(1);
    });

    it("delegate-flow + parent-CONFIDENT-terminal → reap", async () => {
      const sessionKey = "agent:main:child-terminal";
      enqueueDelegateBusyFlow(sessionKey, { parentRunId: "run-parent" });
      addSubagentRun(sessionKey, { endedAt: Date.now() - 1 }); // explicit termination
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
        record.endedAt = REALISTIC_NOW;
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
        record.endedAt = REALISTIC_NOW; // parent dies between reads
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

    it("confidence-gate at bound: persistently-uncertain → quiesce UNBOUNDED, never reap-on-bound (#952 back-door closed)", async () => {
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

  describe("#952 own-turn subagent continue_work survives a busy-defer (never orphan-reaped)", () => {
    it("does NOT reap a no-parentRunId own-turn flow whose own subagent run is confident-terminal, then drives hop-2 once its own session quiets", async () => {
      // The #952 regression: a tool-less subagent elects continue_work for itself.
      // Its electing run completes (endedAt set → confident-terminal) and the wake
      // arms. While the subagent's OWN session is still mid-turn, driveContinuationTurn
      // busy-skips on the own-session readiness gate (a subagent's direct grant runs on
      // its own session lane, not the cross-session main lane — #1057). Pre-fix the
      // producer tagged parentRunId with the subagent's own electing run, so #990
      // bucket-1 read that run as a confident-terminal "orphan" and reaped the flow —
      // hop-2 never ran. The fix omits parentRunId for own-turn work, so the flow stays
      // on the never-reap rate-cap path and delivers when its own session quiets. This
      // pins that even a confident-terminal OWN run cannot authorize a reap of a
      // same-session own-turn election.
      const sessionKey = "agent:main:subagent:s952-ownturn";
      mockSessionStore[sessionKey] = { sessionKey };
      // The subagent's electing run has finished — confident-terminal in the registry.
      addSubagentRun(sessionKey, { endedAt: Date.now() - 1 });
      activeSessions.add(sessionKey); // own session still mid-turn → drive busy-skips
      enqueuePendingWork({
        sessionKey,
        hop: 2,
        delayMs: 0,
        electedAt: Date.now(),
        dueAt: Date.now(),
        maxChainLength: 8,
        reason: "own-turn continuation",
        // NO parentRunId — own-turn continue_work carries no spawning lineage (#952 fix).
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

  describe("#990 locus-3 durable delivered-mark restart-gap (PART B)", () => {
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

describe("#1135 continue_work end-of-turn finalization park + cross-turn coalesce", () => {
  const immediateConfig = {
    ...config,
    defaultDelayMs: 0,
    minDelayMs: 0,
  } satisfies ContinuationRuntimeConfig;

  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    turnGrants.length = 0;
    systemEvents.length = 0;
    activeQueueDeliveries.length = 0;
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
    for (const key of Object.keys(mockSessionStore)) {
      delete mockSessionStore[key];
    }
    mockFlows.clear();
    flowCounter = 0;
    subagentRuns.clear();
    getReplyFromConfigMock.mockClear();
    continuationEnabledForTest = true;
    capturedReplyTraceparents.length = 0;
    bumpWorkRevisionOnReply = false;
    resetContinuationWorkDispatchForTests();
    resetSubagentSessionCleanupForTests();
  });

  afterEach(() => {
    subagentRuns.clear();
    replyIdleWaiters.clear();
    laneIdleWaiters.clear();
    resetContinuationWorkDispatchForTests();
    resetSubagentSessionCleanupForTests();
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

  it("schedules durable wait-shaped continuation work instead of refusing it by reason (#1135 cure, not #1136 quiesce)", async () => {
    // #1136 made scheduleContinuationWork refuse any wait-shaped reason and made
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

  it("does not coalesce distinct elections fanned out within a single turn (#982 preserved)", async () => {
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

  it("aggregates multiple matured active-overlap rows into one bounded provenance note", async () => {
    const sessionKey = "agent:main:fold-aggregate";
    mockSessionStore[sessionKey] = { sessionKey };
    for (let index = 0; index < 7; index++) {
      enqueuePendingWork({
        sessionKey,
        hop: index + 1,
        delayMs: 1_000,
        electedAt: Date.now() - 10_000 - index,
        anchorFinalizedAt: Date.now() - 9_000,
        dueAt: Date.now() - 8_000,
        maxChainLength: 8,
        reason: `folded row ${index}`,
        originRunId: `run-${index}`,
      });
    }
    activeSessions.add(sessionKey);

    await dispatchPendingContinuationWork({ sessionKey });

    expect(activeQueueDeliveries).toHaveLength(1);
    const note = (activeQueueDeliveries[0] as { text: string }).text;
    expect(note).toContain("7 prior same-session continue_work intents matured");
    expect(note).toContain("older folded continuations omitted");
    expect(note).toContain("sample flowIds");
    expect([...mockFlows.values()].filter((flow) => flow.status === "succeeded")).toHaveLength(7);
    expect(turnGrants).toHaveLength(0);
  });

  it("quotes imperative reasons as prior intent rather than a fresh active-turn command", async () => {
    const sessionKey = "agent:main:fold-no-naked-imperative";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now() - 1,
      anchorFinalizedAt: Date.now() - 1,
      dueAt: Date.now() - 1,
      maxChainLength: 8,
      reason: "push the danger button now",
      originRunId: "run-danger",
    });
    activeSessions.add(sessionKey);

    await dispatchPendingContinuationWork({ sessionKey });

    const note = (activeQueueDeliveries[0] as { text: string }).text;
    expect(note).toContain('Prior reason: "push the danger button now"');
    expect(note).toContain("Treat these as prior-turn context, not fresh commands");
    expect(note).toContain("Re-evaluate before acting");
    expect(note).not.toContain("Reason: push the danger button now");
  });

  it("recovers due anchored rows after restart into fold+inform while active", async () => {
    const sessionKey = "agent:main:fold-restart";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 300_000,
      electedAt: Date.now() - 400_000,
      anchorFinalizedAt: Date.now() - 300_000,
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "restart fold proof",
      originRunId: "run-origin-R",
    });
    resetContinuationWorkDispatchForTests();
    activeSessions.add(sessionKey);

    await recoverPendingContinuationWork();

    expect(activeQueueDeliveries).toHaveLength(1);
    expect(turnGrants).toHaveLength(0);
    expect([...mockFlows.values()][0]?.stateJson).toMatchObject({
      disposition: "folded-active",
      dueAt: 1_000_000,
    });
  });

  it("anchors pending work from a finalized origin turn even when a later turn is active", async () => {
    const sessionKey = "agent:main:fold-anchor-successor-active";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 0,
      electedAt: Date.now() - 1_000,
      dueAt: Date.now() + 60_000,
      maxChainLength: 8,
      reason: "successor active fold proof",
      anchorPending: true,
      originRunId: "run-origin-A",
      originTurnId: "turn-origin-A",
    });
    activeSessions.add(sessionKey);

    await dispatchPendingContinuationWork({ sessionKey, includeIdleRetry: true });

    expect(activeQueueDeliveries).toHaveLength(1);
    expect(turnGrants).toHaveLength(0);
    expect([...mockFlows.values()][0]?.stateJson).toMatchObject({
      anchorFinalizedAt: 1_000_000,
      dueAt: 1_000_000,
      disposition: "folded-active",
      originTurnId: "turn-origin-A",
    });
  });

  it("does not add a fresh full delay when recovery anchors already-overdue pending work", async () => {
    const sessionKey = "agent:main:fold-anchor-recovery-overdue";
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 30_000,
      electedAt: Date.now() - 60_000,
      dueAt: Date.now() + 60_000,
      maxChainLength: 8,
      reason: "overdue restart fold proof",
      anchorPending: true,
      originRunId: "run-origin-RO",
      originTurnId: "turn-origin-RO",
    });
    activeSessions.add(sessionKey);

    await dispatchPendingContinuationWork({ sessionKey, recoverRunning: true });

    expect(activeQueueDeliveries).toHaveLength(1);
    expect(turnGrants).toHaveLength(0);
    expect([...mockFlows.values()][0]?.stateJson).toMatchObject({
      anchorFinalizedAt: 970_000,
      dueAt: 1_000_000,
      disposition: "folded-active",
    });
  });

  it("folds Cael-style active body plus +20/+21/+22 delayed rows instead of sequential later turns", async () => {
    const sessionKey = "agent:main:cael-active-overlap";
    mockSessionStore[sessionKey] = { sessionKey };
    for (const [index, delaySeconds] of [20, 21, 22].entries()) {
      enqueuePendingWork({
        sessionKey,
        hop: index + 1,
        delayMs: delaySeconds * 1000,
        electedAt: Date.now() - 30_000,
        anchorFinalizedAt: Date.now() - delaySeconds * 1000,
        dueAt: Date.now(),
        maxChainLength: 8,
        reason: `+${delaySeconds} delayed row`,
        chainId: "chain-cael",
        originRunId: "run-cael",
      });
    }
    activeSessions.add(sessionKey);

    await dispatchPendingContinuationWork({ sessionKey });

    expect(activeQueueDeliveries).toHaveLength(1);
    const note = (activeQueueDeliveries[0] as { text: string }).text;
    expect(note).toContain("3 prior same-session continue_work intents matured");
    expect(turnGrants).toHaveLength(0);
    expect([...mockFlows.values()].filter((flow) => flow.status === "succeeded")).toHaveLength(3);
  });
});

describe("#990 Pillar-0 computeBusySkipBackoffMs (exp-backoff)", () => {
  const params = (ceilingMs: number) => ({ baseMs: 1_000, ceilingMs, factor: 2 });
  it("grows by factor per consecutive busy-skip and caps at the ceiling", () => {
    const p = params(60_000);
    expect(computeBusySkipBackoffMs(0, p)).toBe(1_000);
    expect(computeBusySkipBackoffMs(1, p)).toBe(2_000);
    expect(computeBusySkipBackoffMs(2, p)).toBe(4_000);
    expect(computeBusySkipBackoffMs(3, p)).toBe(8_000);
    expect(computeBusySkipBackoffMs(4, p)).toBe(16_000);
    expect(computeBusySkipBackoffMs(5, p)).toBe(32_000);
    expect(computeBusySkipBackoffMs(6, p)).toBe(60_000); // 64s clamped to 60s
    expect(computeBusySkipBackoffMs(7, p)).toBe(60_000);
  });

  it("clamps to the ceiling without overflow for very large counts", () => {
    expect(computeBusySkipBackoffMs(1_000, params(60_000))).toBe(60_000); // factor**1000 -> Infinity, clamped
    expect(computeBusySkipBackoffMs(-5, params(60_000))).toBe(1_000); // negative guarded to factor^0
  });

  it("honors tunable baseMs and factor", () => {
    expect(computeBusySkipBackoffMs(0, { baseMs: 500, ceilingMs: 60_000, factor: 3 })).toBe(500);
    expect(computeBusySkipBackoffMs(1, { baseMs: 500, ceilingMs: 60_000, factor: 3 })).toBe(1_500);
    expect(computeBusySkipBackoffMs(2, { baseMs: 500, ceilingMs: 60_000, factor: 3 })).toBe(4_500);
  });
});

describe("classifyContinuationWorkReason", () => {
  it("keeps wait-shaped continuation reasons observable without text-driving dispatch", () => {
    expect(classifyContinuationWorkReason("Clearing wake cascade. Yielding and standing by.")).toBe(
      "wait-shaped",
    );
    expect(classifyContinuationWorkReason("Follow up with the package summary.")).toBe(
      "follow-up-work",
    );
    expect(classifyContinuationWorkReason(undefined)).toBe("unknown");
  });
});

function work(
  partial: Partial<{
    hop: number;
    electedAt: number;
    dueAt: number;
    status: "queued" | "running";
  }> = {},
): Parameters<typeof partitionSupersededWork>[0][number] {
  return {
    sessionKey: "agent:main:s",
    hop: partial.hop ?? 1,
    delayMs: 1_000,
    electedAt: partial.electedAt ?? 1_000,
    dueAt: partial.dueAt ?? 2_000,
    maxChainLength: 8,
    status: partial.status ?? "queued",
    flowId: `f-${partial.hop ?? 1}`,
    expectedRevision: 0,
  };
}

describe("#986 partitionSupersededWork (drain-superseded)", () => {
  const GRACE = 120_000;
  const NOW = 1_000_000;

  it("passes a single matured work through untouched", () => {
    const works = [work({ hop: 1, electedAt: 1, dueAt: 1 })];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive).toHaveLength(1);
    expect(superseded).toHaveLength(0);
  });

  it("never collapses when grace is non-positive (guard disabled)", () => {
    const works = [
      work({ hop: 1, electedAt: 1, dueAt: 1 }),
      work({ hop: 2, electedAt: 2, dueAt: 2 }),
      work({ hop: 3, electedAt: 3, dueAt: 3 }),
    ];
    const { drive, superseded } = partitionSupersededWork(works, 0, NOW);
    expect(drive).toHaveLength(3);
    expect(superseded).toHaveLength(0);
  });

  it("folds stale older siblings into the newest-elected member (backlog)", () => {
    // All three matured long ago (overdue >> grace): a genuine stale pile.
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000 }),
      work({ hop: 2, electedAt: 200, dueAt: NOW - 400_000 }),
      work({ hop: 3, electedAt: 300, dueAt: NOW - 300_000 }),
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive.map((w) => w.hop)).toEqual([3]); // newest-elected drives
    expect(superseded.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([1, 2]);
  });

  it("preserves a close burst that is not yet stale (within grace)", () => {
    // Three matured just now, none overdue past grace: distinct close burst.
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 10 }),
      work({ hop: 2, electedAt: 200, dueAt: NOW - 5 }),
      work({ hop: 3, electedAt: 300, dueAt: NOW }),
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive).toHaveLength(3);
    expect(superseded).toHaveLength(0);
  });

  it("keeps the newest even if it is itself overdue, folds only stale older", () => {
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000 }), // stale older
      work({ hop: 2, electedAt: 200, dueAt: NOW - 1_000 }), // recent, not stale
      work({ hop: 3, electedAt: 300, dueAt: NOW - 300_000 }), // newest, stale-but-newest
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    // newest (hop 3) always drives; hop 2 within grace drives; hop 1 stale folds.
    expect(drive.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([2, 3]);
    expect(superseded.map((w) => w.hop)).toEqual([1]);
  });

  it("tie-breaks same-millisecond electedAt by hop — keeps the highest-hop newest intent (#988 :252)", () => {
    // Synchronous batch enqueue can stamp identical electedAt; the newest intent
    // is the highest hop, NOT the first array-order row. consumePendingWork
    // sorts createdAt asc, so the stale older sibling appears first.
    const works = [
      work({ hop: 1, electedAt: 5_000, dueAt: NOW - 500_000 }), // same ms, oldest hop, stale
      work({ hop: 2, electedAt: 5_000, dueAt: NOW - 400_000 }), // same ms, middle hop, stale
      work({ hop: 3, electedAt: 5_000, dueAt: NOW - 300_000 }), // same ms, NEWEST hop
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    // The highest-hop (3) is the kept newest — NOT the first array row (hop 1).
    expect(drive.map((w) => w.hop)).toEqual([3]);
    expect(superseded.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([1, 2]);
  });

  it("never supersedes a recovered running member even when stale and not newest (#988-P2-1)", () => {
    // A recovered `running` turn is actively executing (it may be observing
    // requests-in-flight). It must drive, never fold, even though it is overdue
    // past grace and a newer queued election exists. RED before the write-guard:
    // the stale, non-newest running member was classified `superseded`.
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000, status: "running" }), // stale running, oldest
      work({ hop: 2, electedAt: 300, dueAt: NOW - 300_000, status: "queued" }), // newest queued election
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([1, 2]);
    expect(superseded).toHaveLength(0);
  });

  it("still folds a stale queued member into a newer election (#986 Guard 2 intact)", () => {
    // The only supersede-eligible member is `queued`; the #986 behavior is
    // unchanged for genuine queued backlog.
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000, status: "queued" }), // stale queued backlog
      work({ hop: 2, electedAt: 300, dueAt: NOW - 300_000, status: "queued" }), // newest queued election
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive.map((w) => w.hop)).toEqual([2]);
    expect(superseded.map((w) => w.hop)).toEqual([1]);
  });

  it("mixed batch: stale running drives, stale queued folds, newest queued drives (#988-P2-1)", () => {
    const works = [
      work({ hop: 1, electedAt: 100, dueAt: NOW - 500_000, status: "running" }), // stale running → drives
      work({ hop: 2, electedAt: 200, dueAt: NOW - 400_000, status: "queued" }), // stale queued → folds
      work({ hop: 3, electedAt: 300, dueAt: NOW - 300_000, status: "queued" }), // newest queued → drives
    ];
    const { drive, superseded } = partitionSupersededWork(works, GRACE, NOW);
    expect(drive.map((w) => w.hop).toSorted((a, b) => a - b)).toEqual([1, 3]);
    expect(superseded.map((w) => w.hop)).toEqual([2]);
  });
});

describe("#986 maxPendingWork cap (Guard 1)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    mockFlows.clear();
    flowCounter = 0;
    resetContinuationWorkDispatchForTests();
  });
  afterEach(() => {
    resetContinuationWorkDispatchForTests();
    vi.useRealTimers();
  });

  const sessionKey = "agent:main:flood";
  const baseChain = { currentChainCount: 0, chainStartedAt: 1_000_000, accumulatedChainTokens: 0 };

  it("rejects a new election once pendingWorkCount is at maxPendingWork", async () => {
    const capped = {
      ...config,
      maxPendingWork: 2,
      maxChainLength: 100,
    } satisfies ContinuationRuntimeConfig;
    // Pre-fill the store to the cap (2 queued flows).
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: 1_000_000,
      dueAt: 1_001_000,
      maxChainLength: 100,
    });
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 1_000,
      electedAt: 1_000_000,
      dueAt: 1_001_000,
      maxChainLength: 100,
    });

    const result = await scheduleContinuationWork({
      sessionKey,
      chainState: baseChain,
      request: { delaySeconds: 1, reason: "over the pending cap" },
      config: capped,
    });

    expect(result.scheduled).toBe(false);
    expect(result.capped).toBe(true);
  });

  it("batch ends early on pending-cap but preserves earlier scheduled elections (#982 partial-success)", async () => {
    const capped = {
      ...config,
      maxPendingWork: 3,
      maxChainLength: 100,
    } satisfies ContinuationRuntimeConfig;
    // Start empty; a 5-election batch should schedule 3, then hit the cap.
    const result = await scheduleContinuationWorkBatch({
      sessionKey,
      chainState: baseChain,
      requests: [
        { delaySeconds: 1, reason: "a" },
        { delaySeconds: 1, reason: "b" },
        { delaySeconds: 1, reason: "c" },
        { delaySeconds: 1, reason: "d" },
        { delaySeconds: 1, reason: "e" },
      ],
      config: capped,
    });

    expect(result.scheduledCount).toBe(3);
    expect(result.cappedCount).toBe(2);
    expect(result.capped).toBe(true);
    // The 3 earlier elections stayed durably enqueued (not silently dropped).
    const queued = [...mockFlows.values()].filter((f) => f.ownerKey === sessionKey);
    expect(queued).toHaveLength(3);
  });

  it("does NOT count the active driving (running) wake against the cap — serial maxPendingWork:1 still schedules its successor (#988 :403)", async () => {
    const capOne = {
      ...config,
      maxPendingWork: 1,
      maxChainLength: 100,
    } satisfies ContinuationRuntimeConfig;
    // Simulate the in-flight driver: one continuation-work flow currently
    // `running` (its turn is being driven; markPendingWorkTurnGranted hasn't run
    // yet). A serial chain at maxPendingWork:1 must still schedule the successor
    // — the running driver is NOT a pending future wake.
    enqueuePendingWork({
      sessionKey,
      hop: 1,
      delayMs: 1_000,
      electedAt: 1_000_000,
      dueAt: 1_001_000,
      maxChainLength: 100,
    });
    const driver = [...mockFlows.values()].find((f) => f.ownerKey === sessionKey);
    if (driver) {
      driver.status = "running";
    }

    const result = await scheduleContinuationWork({
      sessionKey,
      chainState: { currentChainCount: 1, chainStartedAt: 1_000_000, accumulatedChainTokens: 0 },
      request: { delaySeconds: 1, reason: "serial successor under cap 1" },
      config: capOne,
    });

    // Pre-fix this rejected (running driver counted → pending 1 >= cap 1).
    // Post-fix the running driver is excluded, so the successor schedules.
    expect(result.scheduled).toBe(true);
    expect(result.capped).toBe(false);
  });
});
