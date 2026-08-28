import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/config.js";

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
  cancelRequestedAt?: number;
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
  failFlow: vi.fn(
    (params: {
      flowId: string;
      expectedRevision: number;
      stateJson?: unknown;
      updatedAt?: number;
      endedAt?: number;
    }) => {
      const flow = mockFlows.get(params.flowId);
      if (!flow || flow.revision !== params.expectedRevision) {
        return {
          applied: false,
          reason: flow ? "revision_conflict" : "not_found",
          current: flow ? { ...flow } : undefined,
        };
      }
      if (flow) {
        flow.status = "failed";
        if (params.stateJson !== undefined) {
          flow.stateJson = params.stateJson;
        }
        flow.endedAt = params.endedAt ?? params.updatedAt ?? Date.now();
        flow.updatedAt = params.updatedAt ?? flow.endedAt;
        flow.revision = flow.revision + 1;
      }
      return { applied: Boolean(flow) };
    },
  ),
  deleteTaskFlowRecordById: vi.fn((flowId: string) => {
    mockFlows.delete(flowId);
  }),
}));

import {
  CONTINUATION_DELEGATE_CONTROLLER_ID,
  CONTINUATION_POST_COMPACTION_CONTROLLER_ID,
} from "./delegate-flow-store.js";
import { registerDelegateStoreConsumptionSuite } from "./delegate-store-consumption.test-harness.js";
import {
  claimStagedPostCompactionTaskFlowDelegates,
  consumeStagedPostCompactionDelegates as consumeSessionPostCompactionDelegates,
  finalizeStagedPostCompactionDelegates,
  listRecoverableStagedPostCompactionDelegates,
  requeueReleasedPostCompactionDelegate as requeueSessionPostCompactionDelegate,
  stagePostCompactionDelegate as stageSessionPostCompactionDelegate,
  stagePostCompactionTaskFlowDelegate,
  stagedPostCompactionDelegateCount,
} from "./delegate-store-post-compaction.js";
import {
  consumePendingDelegates,
  enqueuePendingDelegate,
  listPendingDelegateSessionKeysForRecovery,
  resetDelegateStoreForTests,
  revalidatePendingDelegateForSpawn,
} from "./delegate-store.js";

const VALID_TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

function queueRawPendingFlow(sessionKey: string, stateJson: unknown): string {
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
  setRuntimeConfigSnapshot({
    tools: { sessions_spawn: { attachments: { enabled: true } } },
  });
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

describe("post-compaction delegate staging", () => {
  it("stages and consumes post-compaction delegates", () => {
    stagePostCompactionTaskFlowDelegate("session-1", { task: "rehydrate state", stagedAt: 1000 });

    expect(stagedPostCompactionDelegateCount("session-1")).toBe(1);
    const delegates = claimStagedPostCompactionTaskFlowDelegates("session-1");
    expect(delegates).toHaveLength(1);
    const delegate = expectDefined(delegates.at(0), "delegate");
    expect(delegate.task).toBe("rehydrate state");
    expect(delegate.mode).toBe("post-compaction");
    expect(stagedPostCompactionDelegateCount("session-1")).toBe(0);
  });

  it("does not claim or recover cancel-requested post-compaction delegates and scrubs snapshots", () => {
    const queuedSessionKey = "session-cancel-requested-post-compaction-queued";
    const runningSessionKey = "session-cancel-requested-post-compaction-running";
    stagePostCompactionTaskFlowDelegate(queuedSessionKey, {
      task: "queued must not spawn",
      stagedAt: 1_000,
      attachments: [{ name: "queued.md", content: "QUEUED_CANCEL_SECRET" }],
      attachAs: { mountPath: "handoff" },
    });
    const queuedFlow = expectDefined([...mockFlows.values()].at(0), "queued flow");
    queuedFlow.cancelRequestedAt = Date.now();

    stagePostCompactionTaskFlowDelegate(runningSessionKey, {
      task: "running must not recover",
      stagedAt: 2_000,
      attachments: [{ name: "running.md", content: "RUNNING_CANCEL_SECRET" }],
      attachAs: { mountPath: "handoff" },
    });
    const runningDelegate = expectDefined(
      claimStagedPostCompactionTaskFlowDelegates(runningSessionKey).at(0),
      "running delegate",
    );
    const runningFlow = expectDefined(mockFlows.get(runningDelegate.flowId!), "running flow");
    runningFlow.cancelRequestedAt = Date.now();

    expect(claimStagedPostCompactionTaskFlowDelegates(queuedSessionKey)).toEqual([]);
    expect(listRecoverableStagedPostCompactionDelegates()).toEqual([]);
    expect(queuedFlow.status).toBe("queued");
    expect(runningFlow.status).toBe("running");
    for (const flow of [queuedFlow, runningFlow]) {
      expect(flow.cancelRequestedAt).toBeDefined();
      expect(flow.stateJson).not.toHaveProperty("attachments");
      expect(flow.stateJson).not.toHaveProperty("attachAs");
      expect(JSON.stringify(flow.stateJson)).not.toContain("CANCEL_SECRET");
    }
  });

  it("fails a post-compaction source cancelled after claim at the pre-spawn fence", () => {
    const sessionKey = "post-compaction-cancelled-after-claim";
    const secret = "POST_COMPACTION_CANCELLED_AFTER_CLAIM_SECRET";
    stagePostCompactionTaskFlowDelegate(sessionKey, {
      task: "must not spawn after cancellation",
      stagedAt: Date.now(),
      attachments: [{ name: "private.md", content: secret }],
      attachAs: { mountPath: "handoff" },
    });
    const delegate = expectDefined(
      claimStagedPostCompactionTaskFlowDelegates(sessionKey).at(0),
      "claimed post-compaction delegate",
    );
    const flow = expectDefined(mockFlows.get(delegate.flowId!), "claimed post-compaction flow");
    flow.cancelRequestedAt = Date.now();
    flow.revision += 1;

    expect(revalidatePendingDelegateForSpawn(delegate, "post-compaction")).toMatchObject({
      allowed: false,
      reason: "cancelled",
    });
    expect(flow.status).toBe("failed");
    expect(flow.stateJson).not.toHaveProperty("attachments");
    expect(flow.stateJson).not.toHaveProperty("attachAs");
    expect(JSON.stringify(flow.stateJson)).not.toContain(secret);
  });

  it("rejects one-sided source metadata at the pre-spawn fence", () => {
    for (const delegate of [
      { task: "missing expected revision", flowId: "source-flow" },
      { task: "missing source flow", expectedRevision: 7 },
    ]) {
      expect(revalidatePendingDelegateForSpawn(delegate, "post-compaction")).toEqual({
        allowed: false,
        reason: "stale",
        summary: "Continuation delegate source metadata is incomplete before spawn.",
      });
    }
    expect(
      revalidatePendingDelegateForSpawn({ task: "unmanaged delegate" }, "post-compaction"),
    ).toEqual({ allowed: true });
  });

  it("accepts the single source revision committed by durable post-compaction handoff", () => {
    const sessionKey = "post-compaction-durable-handoff-revision";
    stagePostCompactionTaskFlowDelegate(sessionKey, {
      task: "spawn from the durable handoff",
      stagedAt: Date.now(),
    });
    const delegate = expectDefined(
      claimStagedPostCompactionTaskFlowDelegates(sessionKey).at(0),
      "claimed post-compaction delegate",
    );

    expect(finalizeStagedPostCompactionDelegates([delegate.flowId])).toBe(1);
    expect(revalidatePendingDelegateForSpawn(delegate, "post-compaction")).toEqual({
      allowed: true,
    });
  });

  it("preserves firstArmedAt across post-compaction TaskFlow storage", () => {
    stagePostCompactionTaskFlowDelegate("session-1", {
      task: "old shard",
      stagedAt: 20_000,
      firstArmedAt: 10_000,
    });

    const delegates = claimStagedPostCompactionTaskFlowDelegates("session-1");
    expect(delegates[0]).toMatchObject({
      task: "old shard",
      mode: "post-compaction",
      firstArmedAt: 10_000,
    });
  });

  it("preserves targeting across post-compaction TaskFlow storage", () => {
    stagePostCompactionTaskFlowDelegate("session-1", {
      task: "targeted compaction shard",
      stagedAt: 20_000,
      targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
    });

    expect(claimStagedPostCompactionTaskFlowDelegates("session-1")[0]).toMatchObject({
      task: "targeted compaction shard",
      mode: "post-compaction",
      targetSessionKeys: ["agent:main:root", "agent:main:sibling"],
    });
  });

  it("preserves traceparent across post-compaction TaskFlow storage", () => {
    stagePostCompactionTaskFlowDelegate("session-1", {
      task: "traced compaction shard",
      stagedAt: 20_000,
      traceparent: VALID_TRACEPARENT,
    });

    expect(claimStagedPostCompactionTaskFlowDelegates("session-1")[0]).toMatchObject({
      task: "traced compaction shard",
      mode: "post-compaction",
      traceparent: VALID_TRACEPARENT,
    });
  });

  it("does not mix regular and post-compaction delegates", () => {
    enqueuePendingDelegate("session-1", { task: "regular" });
    stagePostCompactionTaskFlowDelegate("session-1", { task: "post-compact", stagedAt: 1000 });

    const regular = consumePendingDelegates("session-1");
    const postCompact = claimStagedPostCompactionTaskFlowDelegates("session-1");
    expect(regular).toHaveLength(1);
    expect(expectDefined(regular.at(0), "regular delegate").task).toBe("regular");
    expect(postCompact).toHaveLength(1);
    expect(expectDefined(postCompact.at(0), "post-compaction delegate").task).toBe("post-compact");
  });
});

describe("session post-compaction delegate contract", () => {
  it("persists the exact controller identity and JSON projection", () => {
    vi.useFakeTimers();
    vi.setSystemTime(25_000);

    stageSessionPostCompactionDelegate("session-adapter-json", {
      task: "rehydrate exact state",
      createdAt: 20_000,
      firstArmedAt: 10_000,
      silent: true,
      silentWake: true,
      targetSessionKey: "agent:main:root",
      traceparent: VALID_TRACEPARENT,
      traceparentProvenance: "internal",
      model: "github-copilot/claude-sonnet-4.6",
    });

    const flow = expectDefined([...mockFlows.values()].at(0), "staged flow");
    expect(flow.controllerId).toBe("core/continuation-post-compaction");
    expect(flow.controllerId).toBe(CONTINUATION_POST_COMPACTION_CONTROLLER_ID);
    expect(flow.status).toBe("queued");
    expect(flow.revision).toBe(0);
    expect(flow.stateJson).toEqual({
      kind: "continuation_delegate",
      task: "rehydrate exact state",
      postCompaction: true,
      firstArmedAt: 10_000,
      targetSessionKey: "agent:main:root",
      traceparent: VALID_TRACEPARENT,
      traceparentProvenance: "internal",
      model: "github-copilot/claude-sonnet-4.6",
    });
  });

  it("claims in stage order and returns the session adapter flags and revision handles", () => {
    for (const [task, createdAt] of [
      ["first", 100],
      ["second", 200],
      ["third", 300],
    ] as const) {
      stageSessionPostCompactionDelegate("session-adapter-order", {
        task,
        createdAt,
        silent: false,
        silentWake: false,
      });
    }

    const claimed = consumeSessionPostCompactionDelegates("session-adapter-order");
    expect(claimed.map((delegate) => delegate.task)).toEqual(["first", "second", "third"]);
    expect(claimed).toEqual(
      claimed.map((delegate, index) =>
        expect.objectContaining({
          task: ["first", "second", "third"][index],
          createdAt: [100, 200, 300][index],
          firstArmedAt: [100, 200, 300][index],
          silent: true,
          silentWake: true,
          flowId: expect.any(String),
          expectedRevision: 1,
        }),
      ),
    );
    expect(consumeSessionPostCompactionDelegates("session-adapter-order")).toEqual([]);
  });

  it("requeues only the expected revision and clears release-only state", () => {
    stageSessionPostCompactionDelegate("session-adapter-requeue", {
      task: "next compaction",
      createdAt: 100,
    });
    const delegate = expectDefined(
      consumeSessionPostCompactionDelegates("session-adapter-requeue", {
        claimFor: "next-seam-persist",
      }).at(0),
      "claimed session delegate",
    );
    const claimedFlow = expectDefined(mockFlows.get(delegate.flowId!), "claimed flow");
    expect(claimedFlow.stateJson).toMatchObject({
      awaitingNextCompaction: true,
      releasedAt: expect.any(Number),
    });

    expect(requeueSessionPostCompactionDelegate(delegate)).toBe(true);
    const requeuedFlow = expectDefined(mockFlows.get(delegate.flowId!), "requeued flow");
    expect(requeuedFlow.status).toBe("queued");
    expect(requeuedFlow.revision).toBe(2);
    expect(requeuedFlow.stateJson).not.toHaveProperty("releasedAt");
    expect(requeuedFlow.stateJson).not.toHaveProperty("awaitingNextCompaction");

    const rereleased = expectDefined(
      consumeSessionPostCompactionDelegates("session-adapter-requeue").at(0),
      "re-released delegate",
    );
    expect(rereleased.expectedRevision).toBe(3);
    expect(requeueSessionPostCompactionDelegate(delegate)).toBe(false);
  });

  it("finalizes exactly the claimed flow ids after durable handoff", () => {
    stageSessionPostCompactionDelegate("session-adapter-finalize", {
      task: "first",
      createdAt: 100,
      attachments: [{ name: "handoff.txt", content: "HANDOFF_SECRET" }],
      attachAs: { mountPath: "handoff" },
    });
    stageSessionPostCompactionDelegate("session-adapter-finalize", {
      task: "second",
      createdAt: 200,
    });
    const claimed = consumeSessionPostCompactionDelegates("session-adapter-finalize");
    const first = expectDefined(claimed.at(0), "first claim");
    const second = expectDefined(claimed.at(1), "second claim");

    expect(finalizeStagedPostCompactionDelegates([first.flowId])).toBe(1);
    expect(mockFlows.get(first.flowId!)?.status).toBe("succeeded");
    expect(mockFlows.get(first.flowId!)?.stateJson).not.toHaveProperty("attachments");
    expect(mockFlows.get(first.flowId!)?.stateJson).not.toHaveProperty("attachAs");
    expect(mockFlows.get(second.flowId!)?.status).toBe("running");
    expect(finalizeStagedPostCompactionDelegates([first.flowId])).toBe(0);
    expect(finalizeStagedPostCompactionDelegates([second.flowId])).toBe(1);
  });
});

registerDelegateStoreConsumptionSuite({ mockFlows, loggerRecords });

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

    const result = claimStagedPostCompactionTaskFlowDelegates("session-453b");

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

  it("summarizes corrupt attachment-bearing state without logging attachment content", () => {
    const attachmentContent = "CORRUPT_ATTACHMENT_CONTENT_MUST_NOT_LOG";
    const maliciousKey = "ATTACKER_CONTROLLED_KEY_MUST_NOT_LOG";
    const flowId = queueRawPendingFlow("session-redacted", {
      kind: "continuation_delegate",
      attachments: [{ name: "secret.txt", content: attachmentContent }],
      [maliciousKey]: true,
    });

    expect(consumePendingDelegates("session-redacted")).toEqual([]);
    const warningText = loggerRecords
      .filter((record) => record.level === "warn")
      .map((record) => record.message)
      .join("\n");
    expect(warningText).toContain("stateType=object keyCount=3");
    expect(warningText).not.toContain(attachmentContent);
    expect(warningText).not.toContain(maliciousKey);
    expect(mockFlows.get(flowId)?.stateJson).not.toHaveProperty("attachments");
  });

  it("terminalizes a malformed legacy attachment row without replaying or retaining content", () => {
    const secret = "LEGACY_MALFORMED_ATTACHMENT_SECRET";
    const flowId = queueRawPendingFlow("session-legacy-attachment", {
      kind: "continuation_delegate",
      task: "legacy malformed attachment",
      attachments: [{ name: "../brief.md", content: secret }],
    });

    expect(consumePendingDelegates("session-legacy-attachment")).toEqual([]);
    expect(mockFlows.get(flowId)?.status).toBe("failed");
    expect(JSON.stringify(mockFlows.get(flowId)?.stateJson)).not.toContain(secret);
  });

  it("terminalizes malformed attachment state while enumerating startup recovery owners", () => {
    const secret = "RECOVERY_OWNER_ENUMERATION_ATTACHMENT_SECRET";
    const flowId = queueRawPendingFlow("session-missing-owner", {
      kind: "continuation_delegate",
      task: "malformed before owner lookup",
      attachments: [{ name: "../brief.md", content: secret }],
    });

    expect(listPendingDelegateSessionKeysForRecovery()).toEqual([]);
    expect(mockFlows.get(flowId)?.status).toBe("failed");
    expect(JSON.stringify(mockFlows.get(flowId)?.stateJson)).not.toContain(secret);
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
