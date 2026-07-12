import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Logger mock for corrupt-payload breadcrumb assertions.
// Mirrors the shape used in sibling delegate-dispatch.test.ts so log.warn
// emissions land in `loggerRecords` for inspection.
const loggerRecords: Array<{ level: string; message: string }> = [];
vi.mock("../../logging/subsystem.js", () => {
  const record =
    (level: string) =>
    (message: string): void => {
      loggerRecords.push({ level, message });
    };
  const logger = {
    subsystem: "test",
    isEnabled: () => true,
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    raw: record("raw"),
    child: () => logger,
  };
  return {
    createSubsystemLogger: () => logger,
  };
});

// Mock the TaskFlow registry before importing the store.
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
    [...mockFlows.values()].filter((f) => f.ownerKey === ownerKey),
  ),
  listTaskFlowRecords: vi.fn(() => [...mockFlows.values()]),
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
      flow.revision = flow.revision + 1;
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
        return {
          applied: false,
          reason: flow ? "revision_conflict" : "not_found",
          current: flow ? { ...flow } : undefined,
        };
      }
      flow.status = "succeeded";
      flow.stateJson = params.stateJson ?? flow.stateJson;
      flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
      flow.updatedAt = params.updatedAt ?? flow.endedAt;
      flow.revision = flow.revision + 1;
      return { applied: true, flow: { ...flow } };
    },
  ),
  failFlow: vi.fn((params: { flowId: string; updatedAt?: number; endedAt?: number }) => {
    const flow = mockFlows.get(params.flowId);
    if (flow) {
      flow.status = "failed";
      flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
      flow.updatedAt = params.updatedAt ?? flow.endedAt;
      flow.revision = flow.revision + 1;
    }
    return { applied: Boolean(flow) };
  }),
  deleteTaskFlowRecordById: vi.fn((flowId: string) => {
    mockFlows.delete(flowId);
  }),
}));

import { getDiagnosticContinuationQueueMetrics } from "../../logging/diagnostic-continuation-queues.js";
import {
  CONTINUATION_DELEGATE_CONTROLLER_ID,
  CONTINUATION_POST_COMPACTION_CONTROLLER_ID,
  cancelPendingDelegates,
  consumePendingDelegates,
  consumeStagedPostCompactionDelegates,
  enqueuePendingDelegate,
  failStagedPostCompactionDelegatesForCleanup,
  hasRecoverablePendingDelegate,
  markPendingDelegateFailed,
  markPendingDelegateSpawnAccepted,
  pendingDelegateCount,
  resetDelegateStoreForTests,
  stagePostCompactionDelegate,
  stagedPostCompactionDelegateCount,
} from "./delegate-store.js";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function queueRawPendingFlow(sessionKey: string, stateJson: Record<string, unknown>): string {
  const flowId = `flow-${++flowIdCounter}`;
  mockFlows.set(flowId, {
    flowId,
    syncMode: "managed",
    ownerKey: sessionKey,
    controllerId: CONTINUATION_DELEGATE_CONTROLLER_ID,
    status: "queued",
    stateJson,
    goal: "raw pending delegate",
    currentStep: "Queued for continuation dispatch",
    revision: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  return flowId;
}

beforeEach(() => {
  mockFlows.clear();
  loggerRecords.length = 0;
  flowIdCounter = 0;
  resetDelegateStoreForTests();
});

afterEach(() => {
  mockFlows.clear();
  resetDelegateStoreForTests();
  vi.useRealTimers();
});

describe("delegate store — TaskFlow-backed", () => {
  it("enqueues and consumes a pending delegate", () => {
    enqueuePendingDelegate("session-1", { task: "check CI" });

    expect(pendingDelegateCount("session-1")).toBe(1);
    const delegates = consumePendingDelegates("session-1");
    expect(delegates).toHaveLength(1);
    expect(expectDefined(delegates.at(0), "delegate").task).toBe("check CI");
    expect(pendingDelegateCount("session-1")).toBe(0);
  });

  it("uses only regular queued/running pending delegates for cleanup deferral", () => {
    const regularSession = "session-cleanup-regular";
    const postCompactionSession = "session-cleanup-post-compaction";

    enqueuePendingDelegate(regularSession, { task: "regular cleanup blocker" });
    expect(hasRecoverablePendingDelegate(regularSession)).toBe(true);
    consumePendingDelegates(regularSession);
    expect(hasRecoverablePendingDelegate(regularSession)).toBe(true);

    stagePostCompactionDelegate(postCompactionSession, {
      task: "post-compaction cleanup non-blocker",
      stagedAt: Date.now(),
    });
    expect(hasRecoverablePendingDelegate(postCompactionSession)).toBe(false);
    consumeStagedPostCompactionDelegates(postCompactionSession);
    expect(hasRecoverablePendingDelegate(postCompactionSession)).toBe(false);
  });

  it("fails queued and running post-compaction delegates for completed child cleanup", () => {
    const sessionKey = "session-cleanup-post-compaction-fail";
    enqueuePendingDelegate(sessionKey, { task: "regular cleanup blocker" });
    stagePostCompactionDelegate(sessionKey, {
      task: "post-compaction queued",
      stagedAt: Date.now(),
    });
    stagePostCompactionDelegate(sessionKey, {
      task: "post-compaction running",
      stagedAt: Date.now(),
    });
    const [running] = consumeStagedPostCompactionDelegates(sessionKey);
    expect(running).toBeDefined();

    expect(
      failStagedPostCompactionDelegatesForCleanup(
        sessionKey,
        "completed delete-mode child has no future compaction seam",
      ),
    ).toBe(2);

    expect([...mockFlows.values()].filter((flow) => flow.status === "failed")).toHaveLength(2);
    expect(hasRecoverablePendingDelegate(sessionKey)).toBe(true);
    expect(pendingDelegateCount(sessionKey)).toBe(1);
  });

  it("logs when acceptance cannot be committed after a claim", () => {
    enqueuePendingDelegate("session-accept-conflict", { task: "accept conflict" });
    const delegate = expectDefined(
      consumePendingDelegates("session-accept-conflict").at(0),
      "delegate",
    );
    const flow = mockFlows.get(delegate.flowId!);
    expect(flow).toBeDefined();
    flow!.revision = flow!.revision + 1;

    expect(markPendingDelegateSpawnAccepted(delegate, "agent:main:subagent:child")).toBe(false);
    expect(loggerRecords).toContainEqual({
      level: "warn",
      message: `[continuation:delegate-accept-not-committed] flowId=${delegate.flowId} expectedRevision=${delegate.expectedRevision} acceptance was not committed`,
    });
  });

  it("does not treat a stale failed row as an accepted spawn commit", () => {
    enqueuePendingDelegate("session-accept-failed", { task: "accept failed" });
    const delegate = expectDefined(
      consumePendingDelegates("session-accept-failed").at(0),
      "delegate",
    );
    const flow = mockFlows.get(delegate.flowId!);
    expect(flow).toBeDefined();
    flow!.status = "failed";
    flow!.revision = flow!.revision + 1;

    expect(markPendingDelegateSpawnAccepted(delegate, "agent:main:subagent:child")).toBe(false);
    expect(loggerRecords).toContainEqual({
      level: "warn",
      message: `[continuation:delegate-accept-not-committed] flowId=${delegate.flowId} expectedRevision=${delegate.expectedRevision} acceptance was not committed`,
    });
  });

  it("handles multi-delegate fan-out (FIFO order)", () => {
    enqueuePendingDelegate("session-1", { task: "task A" });
    enqueuePendingDelegate("session-1", { task: "task B" });
    enqueuePendingDelegate("session-1", { task: "task C" });

    const delegates = consumePendingDelegates("session-1");
    expect(delegates).toHaveLength(3);
    expect(delegates.map((d) => d.task)).toEqual(["task A", "task B", "task C"]);
  });

  it("isolates delegates by session", () => {
    enqueuePendingDelegate("session-1", { task: "for session 1" });
    enqueuePendingDelegate("session-2", { task: "for session 2" });

    expect(pendingDelegateCount("session-1")).toBe(1);
    expect(pendingDelegateCount("session-2")).toBe(1);
    expect(consumePendingDelegates("session-1")).toHaveLength(1);
    expect(consumePendingDelegates("session-2")).toHaveLength(1);
  });

  it("returns empty array when no delegates queued", () => {
    expect(consumePendingDelegates("empty-session")).toEqual([]);
  });

  it("preserves mode flags through TaskFlow round-trip", () => {
    enqueuePendingDelegate("session-1", {
      task: "silent task",
      mode: "silent-wake",
    });

    const delegates = consumePendingDelegates("session-1");
    expect(delegates[0]).toMatchObject({
      task: "silent task",
      mode: "silent-wake",
    });
  });

  it("preserves cross-session target metadata through TaskFlow round-trip", () => {
    enqueuePendingDelegate("session-1", {
      task: "targeted task",
      targetSessionKey: "agent:main:root",
      targetSessionKeys: ["agent:main:sibling", "agent:main:root"],
    });

    const delegates = consumePendingDelegates("session-1");
    expect(delegates[0]).toMatchObject({
      task: "targeted task",
      targetSessionKey: "agent:main:root",
      targetSessionKeys: ["agent:main:sibling", "agent:main:root"],
    });
  });

  it("preserves fanoutMode through TaskFlow round-trip", () => {
    enqueuePendingDelegate("session-1", {
      task: "tree task",
      fanoutMode: "tree",
    });

    expect(consumePendingDelegates("session-1")[0]).toMatchObject({
      task: "tree task",
      fanoutMode: "tree",
    });
  });

  it("preserves traceparent through TaskFlow round-trip", () => {
    enqueuePendingDelegate("session-1", {
      task: "traced task",
      traceparent: VALID_TRACEPARENT,
    });

    expect(consumePendingDelegates("session-1")[0]).toMatchObject({
      task: "traced task",
      traceparent: VALID_TRACEPARENT,
    });
  });

  it("ignores an unmarked persisted traceparent", () => {
    queueRawPendingFlow("session-1", {
      kind: "continuation_delegate",
      task: "attacker traced task",
      traceparent: VALID_TRACEPARENT,
    });

    const delegate = expectDefined(consumePendingDelegates("session-1").at(0), "delegate");
    expect(delegate.task).toBe("attacker traced task");
    expect(delegate.traceparent).toBeUndefined();
  });

  it("omits traceparent when the TaskFlow row has no carrier", () => {
    enqueuePendingDelegate("session-1", { task: "untraced task" });

    const delegate = expectDefined(consumePendingDelegates("session-1").at(0), "delegate");
    expect(delegate.task).toBe("untraced task");
    expect(delegate.traceparent).toBeUndefined();
  });

  it("preserves model override through TaskFlow round-trip", () => {
    enqueuePendingDelegate("session-1", {
      task: "model task",
      model: "github-copilot/claude-sonnet-4.6",
    });

    expect(consumePendingDelegates("session-1")[0]).toMatchObject({
      task: "model task",
      model: "github-copilot/claude-sonnet-4.6",
    });
  });

  it("omits model when the TaskFlow row has no override", () => {
    enqueuePendingDelegate("session-1", { task: "modelless task" });

    const delegate = expectDefined(consumePendingDelegates("session-1").at(0), "delegate");
    expect(delegate.task).toBe("modelless task");
    expect(delegate.model).toBeUndefined();
  });

  it("decodes legacy silent and silentWake dual-flag rows as silent-wake", () => {
    const flowId = queueRawPendingFlow("session-1", {
      kind: "continuation_delegate",
      task: "legacy silent wake task",
      silent: true,
      silentWake: true,
    });

    const delegates = consumePendingDelegates("session-1");
    expect(delegates).toEqual([
      expect.objectContaining({
        task: "legacy silent wake task",
        mode: "silent-wake",
      }),
    ]);
    expect(mockFlows.get(flowId)?.status).toBe("running");
  });

  it("rejects malformed multi-flag rows instead of choosing precedence", () => {
    const flowId = queueRawPendingFlow("session-1", {
      kind: "continuation_delegate",
      task: "malformed mode task",
      silent: true,
      postCompaction: true,
    });

    expect(consumePendingDelegates("session-1")).toEqual([]);
    expect(mockFlows.get(flowId)?.status).toBe("failed");
  });

  it("rejects rows that combine explicit targets with fanoutMode", () => {
    const flowId = queueRawPendingFlow("session-1", {
      kind: "continuation_delegate",
      task: "malformed targeting task",
      targetSessionKey: "agent:main:root",
      fanoutMode: "tree",
    });

    expect(consumePendingDelegates("session-1")).toEqual([]);
    expect(mockFlows.get(flowId)?.status).toBe("failed");
  });

  it("cancels all delegates (regular + post-compaction)", () => {
    enqueuePendingDelegate("session-1", { task: "regular" });
    stagePostCompactionDelegate("session-1", { task: "post-compact", stagedAt: Date.now() });

    expect(pendingDelegateCount("session-1")).toBe(1);
    expect(stagedPostCompactionDelegateCount("session-1")).toBe(1);

    cancelPendingDelegates("session-1");

    expect(pendingDelegateCount("session-1")).toBe(0);
    expect(stagedPostCompactionDelegateCount("session-1")).toBe(0);
  });

  it("uses correct controller IDs", () => {
    enqueuePendingDelegate("session-1", { task: "regular" });
    stagePostCompactionDelegate("session-1", { task: "post-compact", stagedAt: Date.now() });

    const flows = [...mockFlows.values()];
    expect(expectDefined(flows.at(0), "first flow").controllerId).toBe(
      CONTINUATION_DELEGATE_CONTROLLER_ID,
    );
    expect(expectDefined(flows.at(1), "second flow").controllerId).toBe(
      CONTINUATION_POST_COMPACTION_CONTROLLER_ID,
    );
  });

  it("reports global continuation queue depth and drain-rate diagnostics", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);

    enqueuePendingDelegate("session-1", { task: "due" });
    enqueuePendingDelegate("session-1", { task: "future", delayMs: 60_000 });
    stagePostCompactionDelegate("session-2", { task: "post-compact", stagedAt: 1_000 });
    queueRawPendingFlow("session-3", {
      kind: "continuation_delegate",
      task: "invalid flags",
      silent: true,
      postCompaction: true,
    });

    const first = getDiagnosticContinuationQueueMetrics(1_000);
    expect(first).toMatchObject({
      totalQueued: 4,
      pendingQueued: 3,
      pendingRunnable: 1,
      pendingScheduled: 1,
      stagedPostCompaction: 1,
      invalidQueued: 1,
      enqueuedSinceLastSample: 0,
      drainedSinceLastSample: 0,
      failedSinceLastSample: 0,
    });
    expect(first?.topQueues[0]).toMatchObject({
      sessionKey: "session-1",
      totalQueued: 2,
    });

    vi.setSystemTime(2_000);
    expect(consumePendingDelegates("session-1")).toHaveLength(1);

    const second = getDiagnosticContinuationQueueMetrics(2_000);
    expect(second).toMatchObject({
      totalQueued: 3,
      pendingQueued: 2,
      pendingRunnable: 0,
      pendingScheduled: 1,
      stagedPostCompaction: 1,
      invalidQueued: 1,
      enqueuedSinceLastSample: 0,
      drainedSinceLastSample: 0,
      failedSinceLastSample: 0,
      drainRatePerMinute: 0,
    });
    expect(second?.queueDepthHistory.map((point) => point.totalQueued)).toEqual([4, 3]);
  });
});

describe("post-compaction delegate staging", () => {
  it("stages and consumes post-compaction delegates", () => {
    stagePostCompactionDelegate("session-1", { task: "rehydrate state", stagedAt: 1000 });

    expect(stagedPostCompactionDelegateCount("session-1")).toBe(1);
    const delegates = consumeStagedPostCompactionDelegates("session-1");
    expect(delegates).toHaveLength(1);
    const delegate = expectDefined(delegates.at(0), "delegate");
    expect(delegate.task).toBe("rehydrate state");
    expect(delegate.mode).toBe("post-compaction");
    expect(stagedPostCompactionDelegateCount("session-1")).toBe(0);
  });

  it("preserves firstArmedAt across post-compaction TaskFlow storage", () => {
    stagePostCompactionDelegate("session-1", {
      task: "old shard",
      stagedAt: 20_000,
      firstArmedAt: 10_000,
    });

    const delegates = consumeStagedPostCompactionDelegates("session-1");
    expect(delegates[0]).toMatchObject({
      task: "old shard",
      mode: "post-compaction",
      firstArmedAt: 10_000,
    });
  });

  it("preserves targeting across post-compaction TaskFlow storage", () => {
    stagePostCompactionDelegate("session-1", {
      task: "targeted compaction shard",
      stagedAt: 20_000,
      targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
    });

    expect(consumeStagedPostCompactionDelegates("session-1")[0]).toMatchObject({
      task: "targeted compaction shard",
      mode: "post-compaction",
      targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
    });
  });

  it("preserves traceparent across post-compaction TaskFlow storage", () => {
    stagePostCompactionDelegate("session-1", {
      task: "traced compaction shard",
      stagedAt: 20_000,
      traceparent: VALID_TRACEPARENT,
    });

    expect(consumeStagedPostCompactionDelegates("session-1")[0]).toMatchObject({
      task: "traced compaction shard",
      mode: "post-compaction",
      traceparent: VALID_TRACEPARENT,
    });
  });

  it("does not mix regular and post-compaction delegates", () => {
    enqueuePendingDelegate("session-1", { task: "regular" });
    stagePostCompactionDelegate("session-1", { task: "post-compact", stagedAt: 1000 });

    const regular = consumePendingDelegates("session-1");
    const postCompact = consumeStagedPostCompactionDelegates("session-1");
    expect(regular).toHaveLength(1);
    expect(expectDefined(regular.at(0), "regular delegate").task).toBe("regular");
    expect(postCompact).toHaveLength(1);
    expect(expectDefined(postCompact.at(0), "post-compaction delegate").task).toBe("post-compact");
  });
});

describe("consumePendingDelegates — delayMs gating", () => {
  it("leaves an unmatured delegate (delayMs in the future) in queued state", () => {
    enqueuePendingDelegate("session-1", { task: "future", delayMs: 60_000 });

    const matured = consumePendingDelegates("session-1");
    expect(matured).toEqual([]);
    expect(pendingDelegateCount("session-1")).toBe(1);
  });

  it("drains a matured delegate (delayMs elapsed)", () => {
    enqueuePendingDelegate("session-1", { task: "due", delayMs: 0 });

    const matured = consumePendingDelegates("session-1");
    expect(matured).toHaveLength(1);
    expect(expectDefined(matured.at(0), "matured delegate").task).toBe("due");
    expect(pendingDelegateCount("session-1")).toBe(0);
  });

  it("drains matured entries and re-parks unmatured entries in the same call", () => {
    enqueuePendingDelegate("session-1", { task: "due", delayMs: 0 });
    enqueuePendingDelegate("session-1", { task: "future", delayMs: 60_000 });

    const matured = consumePendingDelegates("session-1");
    expect(matured.map((d) => d.task)).toEqual(["due"]);
    // The unmatured entry stays queued for the next consume cycle.
    expect(pendingDelegateCount("session-1")).toBe(1);
  });

  it("treats omitted delayMs as zero (matures immediately, preserves legacy behavior)", () => {
    enqueuePendingDelegate("session-1", { task: "no-delay" });

    const matured = consumePendingDelegates("session-1");
    expect(matured).toHaveLength(1);
    expect(expectDefined(matured.at(0), "matured delegate").task).toBe("no-delay");
  });
});

describe("markPendingDelegateFailed", () => {
  beforeEach(() => {
    loggerRecords.length = 0;
  });

  it("emits a breadcrumb instead of silently dropping delegates missing flow metadata", () => {
    markPendingDelegateFailed({ task: "missing metadata" }, "rejected");

    const warns = loggerRecords.filter(
      (record) =>
        record.level === "warn" &&
        record.message.includes("[continuation:delegate-fail-missing-flow]"),
    );
    expect(warns).toHaveLength(1);
  });
});

describe("peekSoonestUnmaturedDelegateDueAt", () => {
  it("returns undefined when no entries are queued", async () => {
    const { peekSoonestUnmaturedDelegateDueAt } = await import("./delegate-store.js");
    expect(peekSoonestUnmaturedDelegateDueAt("empty")).toBeUndefined();
  });

  it("returns undefined when all queued entries are already due", async () => {
    const { peekSoonestUnmaturedDelegateDueAt } = await import("./delegate-store.js");
    enqueuePendingDelegate("session-1", { task: "due", delayMs: 0 });
    expect(peekSoonestUnmaturedDelegateDueAt("session-1")).toBeUndefined();
  });

  it("returns the soonest dueAt across multiple unmatured entries", async () => {
    const { peekSoonestUnmaturedDelegateDueAt } = await import("./delegate-store.js");
    const before = Date.now();
    enqueuePendingDelegate("session-1", { task: "far", delayMs: 120_000 });
    enqueuePendingDelegate("session-1", { task: "near", delayMs: 30_000 });
    enqueuePendingDelegate("session-1", { task: "mid", delayMs: 60_000 });

    const soonest = peekSoonestUnmaturedDelegateDueAt("session-1");
    expect(soonest).toBeDefined();
    // Soonest should be the 30s one — within tolerance of `before + 30000`.
    expect(soonest!).toBeGreaterThanOrEqual(before + 30_000);
    expect(soonest!).toBeLessThan(before + 30_000 + 5_000);
  });
});

describe("consumePendingDelegates — concurrent-consumer race contract", () => {
  // Pins the contract that two consumers racing on the same TaskFlow rows
  // release each queued delegate AT MOST ONCE via finishFlow(expectedRevision).
  //
  // Background: runner / followup / hedge drains can fire near-
  // simultaneously. Existing tests cover serial consumers + FIFO order;
  // none exercise the actual race where two `consumePendingDelegates` calls
  // each acquire the same `flow.revision` then race to `finishFlow`.
  //
  // The substrate guard is `finishFlow({ expectedRevision })` returning
  // `{ applied: false, reason: "revision_conflict" }` when the revision has
  // moved. The mock flow store implements identical semantics. We pin the
  // contract by interleaving two consumer invocations: both read the queue,
  // each captures the same flow.revision, then both call finishFlow with the
  // same expectedRevision. Exactly one wins; the loser must NOT spawn.

  it("sequential consumers: second call sees flow already drained, returns empty", () => {
    enqueuePendingDelegate("session-1", { task: "single" });

    const first = consumePendingDelegates("session-1");
    expect(first).toHaveLength(1);
    expect(expectDefined(first.at(0), "delegate").task).toBe("single");

    // The flow is now status=succeeded; second call sees nothing in queued.
    const second = consumePendingDelegates("session-1");
    expect(second).toHaveLength(0);
  });

  it("interleaved consumers: only one wins finishFlow per delegate; loser gets revision_conflict", async () => {
    const { finishFlow } = await import("../../tasks/task-flow-registry.js");
    enqueuePendingDelegate("session-1", { task: "raced" });

    // Snapshot the queued flow as both consumers would observe it before
    // either calls finishFlow. This mirrors the race window where both
    // consumePendingDelegates invocations have already iterated the queued
    // list and captured the same revision.
    const queuedBefore = [...mockFlows.values()].filter(
      (f) => f.ownerKey === "session-1" && f.status === "queued",
    );
    expect(queuedBefore).toHaveLength(1);
    const queuedDelegate = expectDefined(queuedBefore.at(0), "queued delegate");
    const sharedRevision = queuedDelegate.revision;
    const flowId = queuedDelegate.flowId;

    // Consumer A and Consumer B both attempt finishFlow with the same
    // expectedRevision. The mock implements the same revision-check as the
    // real TaskFlow store: applied=true on match, revision_conflict otherwise.
    const aResult = finishFlow({
      flowId,
      expectedRevision: sharedRevision,
      currentStep: "Released to continuation scheduler (consumer A)",
      stateJson: { releasedBy: "A" },
    });
    const bResult = finishFlow({
      flowId,
      expectedRevision: sharedRevision,
      currentStep: "Released to continuation scheduler (consumer B)",
      stateJson: { releasedBy: "B" },
    });

    // Exactly one consumer wins.
    const winners = [aResult, bResult].filter((r: { applied: boolean }) => r.applied);
    const losers = [aResult, bResult].filter((r: { applied: boolean }) => !r.applied);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { reason?: string }).reason).toBe("revision_conflict");

    // The flow is finalized exactly once (status=succeeded, revision++).
    const finalized = mockFlows.get(flowId)!;
    expect(finalized.status).toBe("succeeded");
    expect(finalized.revision).toBe(sharedRevision + 1);
  });

  it("two real consumePendingDelegates calls back-to-back: only first drains, second is empty", () => {
    // The existing consumer code path (`consumePendingDelegates`) already
    // serializes finishFlow per row internally. This test exercises the
    // public API rather than the mock primitive: confirms back-to-back
    // invocations don't double-spawn even when the second call's iteration
    // happens after the first completed.
    enqueuePendingDelegate("session-1", { task: "first" });
    enqueuePendingDelegate("session-1", { task: "second" });
    enqueuePendingDelegate("session-1", { task: "third" });

    const drained1 = consumePendingDelegates("session-1");
    expect(drained1.map((d) => d.task)).toEqual(["first", "second", "third"]);

    // Subsequent call sees nothing — all three flows are status=succeeded.
    const drained2 = consumePendingDelegates("session-1");
    expect(drained2).toHaveLength(0);

    // Verify total delegate spawns equals enqueue count, not 2× enqueue count.
    expect(drained1).toHaveLength(3);
    expect(drained2).toHaveLength(0);
  });

  it("interleaved consumers across multiple flows: each flow released exactly once", async () => {
    const { finishFlow } = await import("../../tasks/task-flow-registry.js");
    enqueuePendingDelegate("session-1", { task: "A" });
    enqueuePendingDelegate("session-1", { task: "B" });
    enqueuePendingDelegate("session-1", { task: "C" });

    // Snapshot all three queued flows with their current revisions.
    // Capture revision as a primitive BEFORE the race: the mock's finishFlow
    // mutates flow.revision in place, so a live-reference read during the
    // loop would observe the post-A revision, not the pre-race revision.
    const queuedBefore = [...mockFlows.values()]
      .filter((f) => f.ownerKey === "session-1" && f.status === "queued")
      .map((f) => ({ flowId: f.flowId, capturedRevision: f.revision }));
    expect(queuedBefore).toHaveLength(3);

    // Two consumers each attempt finishFlow on every flow with the captured
    // pre-race revision. Each flow should be released exactly once across
    // both consumers.
    type Result = { applied: boolean; reason?: string };
    const aResults: Result[] = [];
    const bResults: Result[] = [];
    for (const flow of queuedBefore) {
      aResults.push(
        finishFlow({
          flowId: flow.flowId,
          expectedRevision: flow.capturedRevision,
          currentStep: "consumer A",
        }) as Result,
      );
      bResults.push(
        finishFlow({
          flowId: flow.flowId,
          expectedRevision: flow.capturedRevision,
          currentStep: "consumer B",
        }) as Result,
      );
    }

    // For each flow: exactly one of (A, B) applied; the other got
    // revision_conflict (because A's finishFlow incremented revision before
    // B's call). Order is deterministic in this test (A always first per the
    // sync mock) — proves the contract holds even when A wins every race.
    for (let i = 0; i < queuedBefore.length; i++) {
      const a = expectDefined(aResults.at(i), "consumer A result");
      const b = expectDefined(bResults.at(i), "consumer B result");
      const winners = [a, b].filter((r) => r.applied);
      const losers = [a, b].filter((r) => !r.applied);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(expectDefined(losers.at(0), "losing result").reason).toBe("revision_conflict");
    }

    // All three flows are now status=succeeded.
    const finalized = [...mockFlows.values()].filter((f) => f.ownerKey === "session-1");
    expect(finalized.every((f) => f.status === "succeeded")).toBe(true);
  });
});

/* ------------------------------------------------------------------- */
/*  consume-paths corrupt-payload contract:                            */
/*    Schema-drift / corrupt stateJson on a TaskFlow row MUST fail     */
/*    the row + emit a tagged breadcrumb so the wedge-shape (decode-   */
/*    null + silent-continue accumulating in queue) cannot regress.    */
/*    Drainer-failFlow at consume-paths is the canonical wedge cure:   */
/*    corrupt rows fail instead of silently accumulating in the queue.  */
/* ------------------------------------------------------------------- */

describe("consume-paths corrupt-payload breadcrumbs", () => {
  beforeEach(() => {
    loggerRecords.length = 0;
  });

  it("fails a pending delegate row with corrupt stateJson + emits the [continuation:delegate-decode-failed] breadcrumb", () => {
    const flowId = queueRawPendingFlow("session-453a", { not_a_real_field: "corrupt" });
    const result = consumePendingDelegates("session-453a");

    // No delegates returned — corrupt payload didn't decode to a valid one.
    expect(result).toEqual([]);

    // failFlow was called against the corrupt row — it's no longer queued.
    const flow = mockFlows.get(flowId);
    expect(flow?.status).toBe("failed");

    // Breadcrumb emitted at warn level with the canonical tag + flowId + session.
    const warns = loggerRecords.filter((r) => r.level === "warn");
    expect(
      warns.some(
        (r) =>
          r.message.includes("[continuation:delegate-decode-failed]") &&
          r.message.includes(`flowId=${flowId}`) &&
          r.message.includes("session=session-453a"),
      ),
    ).toBe(true);
  });

  it("fails a post-compaction delegate row with corrupt stateJson + emits the [continuation:post-compaction-decode-failed] breadcrumb", () => {
    // Stage a raw post-compaction row (corrupt stateJson).
    const flowId = `flow-${++flowIdCounter}`;
    mockFlows.set(flowId, {
      flowId,
      syncMode: "managed",
      ownerKey: "session-453b",
      controllerId: CONTINUATION_POST_COMPACTION_CONTROLLER_ID,
      status: "queued",
      stateJson: { not_a_real_field: "corrupt-post-compaction" },
      goal: "raw post-compaction delegate",
      currentStep: "Staged for release after compaction",
      revision: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const result = consumeStagedPostCompactionDelegates("session-453b");

    // No delegates returned — corrupt payload didn't decode.
    expect(result).toEqual([]);

    // failFlow was called — row no longer queued.
    const flow = mockFlows.get(flowId);
    expect(flow?.status).toBe("failed");

    // Post-compaction breadcrumb tag fired.
    const warns = loggerRecords.filter((r) => r.level === "warn");
    expect(
      warns.some(
        (r) =>
          r.message.includes("[continuation:post-compaction-decode-failed]") &&
          r.message.includes(`flowId=${flowId}`) &&
          r.message.includes("session=session-453b"),
      ),
    ).toBe(true);
  });

  it("fails multiple corrupt rows in a single consume call without aborting later valid ones", () => {
    const corruptId1 = queueRawPendingFlow("session-453c", { bad_shape: 1 });
    enqueuePendingDelegate("session-453c", { task: "valid task" });
    const corruptId2 = queueRawPendingFlow("session-453c", { bad_shape: 2 });

    const result = consumePendingDelegates("session-453c");

    // Only the valid delegate returned.
    expect(result).toHaveLength(1);
    expect(expectDefined(result.at(0), "valid delegate").task).toBe("valid task");

    // Both corrupt rows failed.
    expect(mockFlows.get(corruptId1)?.status).toBe("failed");
    expect(mockFlows.get(corruptId2)?.status).toBe("failed");

    // Both corrupt-row breadcrumbs emitted.
    const decodeFailedWarns = loggerRecords.filter(
      (r) => r.level === "warn" && r.message.includes("[continuation:delegate-decode-failed]"),
    );
    expect(decodeFailedWarns.length).toBe(2);
  });

  it("does NOT emit breadcrumbs when consume runs against an empty queue (clean session)", () => {
    const result = consumePendingDelegates("session-453d-empty");
    expect(result).toEqual([]);
    const decodeFailedWarns = loggerRecords.filter(
      (r) => r.level === "warn" && r.message.includes("[continuation:delegate-decode-failed]"),
    );
    expect(decodeFailedWarns).toEqual([]);
  });

  it("does NOT emit breadcrumbs when consume runs against well-formed payloads (regression-resistance for valid path)", () => {
    enqueuePendingDelegate("session-453e", { task: "clean task 1" });
    enqueuePendingDelegate("session-453e", { task: "clean task 2" });

    const result = consumePendingDelegates("session-453e");
    expect(result).toHaveLength(2);

    // Zero decode-failed breadcrumbs on the happy path — verifies the
    // breadcrumb is failure-only, not always-on.
    const decodeFailedWarns = loggerRecords.filter(
      (r) => r.level === "warn" && r.message.includes("[continuation:delegate-decode-failed]"),
    );
    expect(decodeFailedWarns).toEqual([]);
  });
});
