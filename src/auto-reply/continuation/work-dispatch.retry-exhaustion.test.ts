import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const turnGrants: unknown[] = [];
const systemEvents: unknown[] = [];
const sessionDeliveryEnqueues: { idempotencyKey?: string }[] = [];
const scheduledDeliveries: string[] = [];
const heartbeatWakes: { sessionKey?: string }[] = [];
const sessionDeliveryAcks: string[] = [];
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

function resolveCommandLaneIdle(lane = "main"): void {
  mainQueueSize = 0;
  const waiters = laneIdleWaiters.get(lane) ?? [];
  for (const finish of Array.from(waiters)) {
    finish(true);
  }
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
  markTrustedContinuationHeartbeatWake: <T>(request: T) => request,
  requestHeartbeatNow: (opts?: { sessionKey?: string }) => {
    heartbeatWakes.push(opts ?? {});
  },
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: (text: string, options: unknown) => {
    systemEvents.push({ text, options });
  },
}));

// The durable queue has its own real-store proof in
// work-terminal-notice.durability.test.ts; here it is recorded so this unit
// suite can assert the handoff without touching SQLite.
vi.mock("../../infra/session-delivery-queue-runtime.js", () => ({
  scheduleSessionDelivery: (id: string) => {
    scheduledDeliveries.push(id);
    return Promise.resolve(true);
  },
}));

vi.mock("../../infra/session-delivery-queue-storage.js", () => ({
  enqueueSessionDeliveryWithStatus: (payload: { idempotencyKey?: string }) => {
    sessionDeliveryEnqueues.push(payload);
    return Promise.resolve({
      id: `delivery-${payload.idempotencyKey ?? sessionDeliveryEnqueues.length}`,
      status: "pending" as const,
    });
  },
  enqueueSessionDelivery: (payload: { idempotencyKey?: string }) => {
    sessionDeliveryEnqueues.push(payload);
    return Promise.resolve(`delivery-${payload.idempotencyKey ?? sessionDeliveryEnqueues.length}`);
  },
  ackSessionDelivery: (id: string) => {
    sessionDeliveryAcks.push(id);
    return Promise.resolve();
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

const { subsystemLoggerMock } = vi.hoisted(() => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return { subsystemLoggerMock: logger };
});

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => subsystemLoggerMock,
}));

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
  blockedSummary?: string | null;
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
  failFlow: vi.fn(
    (params: {
      flowId: string;
      expectedRevision: number;
      currentStep?: string | null;
      blockedSummary?: string | null;
      stateJson?: unknown;
      updatedAt?: number;
      endedAt?: number;
    }) => {
      // Mirrors updateFlowRecordByIdExpectedRevision. The expected-revision CAS
      // is the durable once-only fact that terminal side effects key off, so a
      // stale claim must lose here instead of always applying.
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return { applied: false, reason: flow ? "revision_conflict" : "not_found" };
      }
      const endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
      flow.status = "failed";
      flow.currentStep = params.currentStep ?? flow.currentStep;
      flow.blockedSummary = params.blockedSummary ?? null;
      flow.stateJson = params.stateJson ?? flow.stateJson;
      flow.updatedAt = params.updatedAt ?? endedAt;
      flow.endedAt = endedAt;
      flow.revision += 1;
      return { applied: true, flow: cloneFlow(flow) };
    },
  ),
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
  scheduleContinuationWork,
  scheduleContinuationWorkBatch,
  hasLiveOrRecentlyDispatchedContinuationWork,
  markPendingWorkDelivered,
  markPendingWorkFoldDelivered,
  requeuePendingWork,
  addSubagentRun,
  config,
  claimMaturedWork,
];
void splitLintUse;

describe("continuation_work transient-error retry exhaustion", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
    turnGrants.length = 0;
    systemEvents.length = 0;
    sessionDeliveryEnqueues.length = 0;
    sessionDeliveryAcks.length = 0;
    scheduledDeliveries.length = 0;
    heartbeatWakes.length = 0;
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
    subsystemLoggerMock.info.mockClear();
    subsystemLoggerMock.warn.mockClear();
    subsystemLoggerMock.error.mockClear();
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

  const TRANSIENT_RETRY_ADVANCE_MS = 5_000;
  const MAX_TRANSIENT_RETRIES = 8;
  const DRIVE_GUARD = 40;

  function workFlow(): MockFlow | undefined {
    return [...mockFlows.values()][0];
  }

  function workRetryCount(): number {
    return (workFlow()?.stateJson as { retryCount?: number } | undefined)?.retryCount ?? 0;
  }

  function enqueueErroringWork(sessionKey: string): void {
    mockSessionStore[sessionKey] = { sessionKey };
    enqueuePendingWork({
      sessionKey,
      hop: 2,
      delayMs: 0,
      electedAt: Date.now(),
      dueAt: Date.now(),
      maxChainLength: 8,
      reason: "exhaustion proof",
    });
  }

  /**
   * Drive wake attempts while `replyError` is set, advancing the armed retry
   * timer until `stop()` reports the wanted state. Observation-driven rather
   * than attempt-counted so it cannot silently drift when one tick fires more
   * than a single attempt.
   */
  async function driveTransientErrorRetries(
    sessionKey: string,
    stop: () => boolean,
  ): Promise<void> {
    await dispatchPendingContinuationWork({ sessionKey });
    for (let tick = 0; tick < DRIVE_GUARD && !stop(); tick += 1) {
      await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_ADVANCE_MS);
    }
  }

  function terminalExhaustionEvents(): { text: string; options: unknown }[] {
    return systemEvents.filter(
      (event): event is { text: string; options: unknown } =>
        typeof (event as { text?: unknown }).text === "string" &&
        (event as { text: string }).text.includes("permanently failed"),
    );
  }

  function terminalExhaustionLogs(): string[] {
    return subsystemLoggerMock.error.mock.calls
      .map((call) => call[0])
      .filter(
        (message): message is string =>
          typeof message === "string" &&
          message.includes("continuation:work-drive-error-exhausted"),
      );
  }

  it("keeps every pre-terminal attempt retryable and emits no terminal outcome", async () => {
    const sessionKey = "agent:main:exhaustion-pre-terminal";
    replyError = new Error("provider unavailable");
    enqueueErroringWork(sessionKey);

    await driveTransientErrorRetries(sessionKey, () => workRetryCount() >= MAX_TRANSIENT_RETRIES);

    // The retry budget is fully consumed but the row is still recoverable.
    expect(workRetryCount()).toBe(MAX_TRANSIENT_RETRIES);
    expect(workFlow()).toMatchObject({
      status: "queued",
      currentStep: "Requeued same-session continuation wake",
    });
    expect(systemEvents).toEqual([]);
    expect(terminalExhaustionLogs()).toHaveLength(0);
  });

  it("terminalizes the row and emits exactly one actionable outcome once retries are exhausted", async () => {
    const sessionKey = "agent:main:exhaustion-terminal";
    replyError = new Error("provider unavailable");
    enqueueErroringWork(sessionKey);

    await driveTransientErrorRetries(sessionKey, () => workFlow()?.status === "failed");

    expect(workFlow()).toMatchObject({
      status: "failed",
      currentStep: "Continuation work wake failed",
    });

    // Exactly one agent-visible outcome, and nothing else was announced.
    expect(terminalExhaustionEvents()).toHaveLength(1);
    expect(systemEvents).toHaveLength(1);
    const [terminalEvent] = terminalExhaustionEvents();
    expect(terminalEvent?.text).toContain("continue_work permanently failed");
    expect(terminalEvent?.text).toContain("Reissue continue_work");
    expect(terminalEvent?.options).toMatchObject({ sessionKey, trusted: true });

    expect(terminalExhaustionLogs()).toHaveLength(1);
    expect(terminalExhaustionLogs()[0]).toContain(`session=${sessionKey}`);
    expect(terminalExhaustionLogs()[0]).toContain(`maxRetries=${MAX_TRANSIENT_RETRIES}`);

    // The notice is handed to the durable queue before the volatile fast path,
    // and the in-memory event carries that row's ack id so it is acknowledged
    // only after the prompt consumes it.
    expect(sessionDeliveryEnqueues).toHaveLength(1);
    expect(sessionDeliveryEnqueues[0]).toMatchObject({
      kind: "systemEvent",
      sessionKey,
      idempotencyKey: `continuation-work-terminal-notice:${workFlow()?.flowId}`,
    });
    expect(sessionDeliveryAcks).toEqual([]);
    // The row is actively armed and the target woken, so the outcome does not
    // wait for unrelated traffic.
    expect(scheduledDeliveries).toHaveLength(1);
    expect(heartbeatWakes).toEqual([expect.objectContaining({ sessionKey })]);
    expect(terminalEvent?.options).toMatchObject({
      sessionDeliveryAckId: expect.stringContaining("continuation-work-terminal-notice:"),
    });
    // The obligation is released only after that handoff.
    expect(
      (workFlow()?.stateJson as { terminalNoticePending?: string } | undefined)
        ?.terminalNoticePending,
    ).toBeUndefined();
  });

  it("does not re-announce the terminal outcome when a concurrent writer already advanced the row", async () => {
    // Crash/recovery and repeated terminal handling both surface as a lost
    // expected-revision CAS: another writer advanced the row while this attempt
    // was in flight. The visible outcome is keyed off that CAS, so the loser
    // must stay silent instead of enqueueing a duplicate.
    const sessionKey = "agent:main:exhaustion-revision-race";
    replyError = new Error("provider unavailable");
    enqueueErroringWork(sessionKey);

    await driveTransientErrorRetries(sessionKey, () => workRetryCount() >= MAX_TRANSIENT_RETRIES);
    expect(systemEvents).toEqual([]);

    // The terminal attempt now races a competing writer that bumps the revision
    // before this attempt reaches its own terminalization.
    bumpWorkRevisionOnReply = true;
    const revisionBeforeTerminalAttempt = workFlow()?.revision ?? 0;
    await vi.advanceTimersByTimeAsync(TRANSIENT_RETRY_ADVANCE_MS);

    expect(workFlow()?.revision).toBeGreaterThan(revisionBeforeTerminalAttempt);
    expect(terminalExhaustionEvents()).toHaveLength(0);
    expect(systemEvents).toEqual([]);
    expect(terminalExhaustionLogs()).toHaveLength(0);
    // The competing writer owns the row; this attempt committed nothing.
    expect(workFlow()?.currentStep).not.toBe("Continuation work wake failed");
  });

  it("keeps the raw driver error out of the agent-visible outcome", async () => {
    const sessionKey = "agent:main:exhaustion-redaction";
    const secret = "sk-live-9f3c1d2b7a";
    replyError = new Error(`provider rejected token ${secret} at https://api.example/v1/messages`);
    enqueueErroringWork(sessionKey);

    await driveTransientErrorRetries(sessionKey, () => workFlow()?.status === "failed");

    const [terminalEvent] = terminalExhaustionEvents();
    expect(terminalEvent?.text).toBeDefined();
    expect(terminalEvent?.text).not.toContain(secret);
    expect(terminalEvent?.text).not.toContain("https://api.example");
    expect(terminalEvent?.text).not.toContain("provider rejected token");
    // The detail is still recorded for operators: durable row + terminal log.
    expect(workFlow()?.blockedSummary).toContain(secret);
    expect(terminalExhaustionLogs()[0]).toContain(secret);
  });

  it("leaves the sibling non-retryable skip outcome unchanged", async () => {
    // `missing-session` is not retryable, so it must still terminalize on the
    // first attempt through the pre-existing "was not granted" branch.
    const sessionKey = "agent:main:exhaustion-sibling";
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
    expect(terminalExhaustionEvents()).toHaveLength(0);
    expect(terminalExhaustionLogs()).toHaveLength(0);
  });
  it("drains an already-owed terminal notice even while continuation is disabled", async () => {
    // The obligation was incurred while continuation was enabled; turning the
    // feature off afterwards must not strand a debt the agent is already owed.
    const sessionKey = "agent:main:exhaustion-disabled-recovery";
    replyError = new Error("provider unavailable");
    enqueueErroringWork(sessionKey);
    await driveTransientErrorRetries(sessionKey, () => workFlow()?.status === "failed");
    expect(sessionDeliveryEnqueues).toHaveLength(1);

    // Re-arm the obligation as a restart would observe it, then disable the
    // feature before recovery runs.
    const flow = workFlow();
    const state = flow?.stateJson as Record<string, unknown> | undefined;
    if (!flow?.flowId || !state) {
      throw new Error("expected a terminalized flow");
    }
    flow.stateJson = { ...state, terminalNoticePending: "retry-exhausted" };
    sessionDeliveryEnqueues.length = 0;
    continuationEnabledForTest = false;

    const summary = await recoverPendingContinuationWork();

    expect(summary.terminalNotices).toBe(1);
    expect(summary.sessions).toBe(0);
    expect(sessionDeliveryEnqueues).toHaveLength(1);
    expect(sessionDeliveryEnqueues[0]).toMatchObject({
      idempotencyKey: `continuation-work-terminal-notice:${flow.flowId}`,
    });
  });
});
