// Restart-persistent outbox coverage for requester settle wake: retained
// delete rows, frozen-batch persistence, and replay after cold restore.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

const deliverSpy = vi.fn(
  async (
    _params: Record<string, unknown>,
  ): Promise<{
    delivered: boolean;
    path: string;
    disposition?: "ambiguous" | "permanent_failure" | "intentional_non_delivery" | "retryable";
    reason?: string;
  }> => ({
    delivered: true,
    path: "direct",
  }),
);

let sessionStore: Record<string, { sessionId?: string; lastChannel?: string; lastTo?: string }>;

const { registryRuntimeMock } = vi.hoisted(() => ({
  registryRuntimeMock: {
    countActiveDescendantRuns: vi.fn((_rootSessionKey: string) => 0),
    countPendingDescendantRuns: vi.fn((_rootSessionKey: string) => 0),
    isSubagentSessionRunActive: vi.fn((_childSessionKey: string) => true),
    shouldIgnorePostCompletionAnnounceForSession: vi.fn((_childSessionKey: string) => false),
    hasDescendantRunAwaitingSettle: vi.fn(
      (_rootSessionKey: string, _excludeRunId?: string) => false,
    ),
    listSubagentRunsForRequester: vi.fn((_requesterSessionKey: string): unknown[] => []),
    getLatestSubagentRunByChildSessionKey: vi.fn(
      (
        _childSessionKey: string,
      ): Pick<SubagentRunRecord, "runId" | "requesterSessionKey"> | undefined => undefined,
    ),
    resolveRequesterForChildSession: vi.fn((_childSessionKey: string) => null),
  },
}));

vi.mock("../registry/subagent-registry-read.js", () => registryRuntimeMock);

vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: vi.fn(async () => ({})),
  dispatchGatewayMethodInProcess: vi.fn(async () => ({})),
  isEmbeddedAgentRunActive: vi.fn(() => false),
  getRuntimeConfig: () => ({ session: { mainKey: "main", scope: "per-sender" } }),
  loadSessionStore: vi.fn(() => ({})),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSubagentSessionEntry: vi.fn(() => undefined),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveMainSessionKey: vi.fn(() => "agent:main:main"),
  resolveSessionStorePathCore: vi.fn(() => "/tmp/sessions.json"),
  waitForEmbeddedAgentRunEnd: vi.fn(async () => true),
}));

vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (params: Record<string, unknown>) => deliverSpy(params),
  loadRequesterSessionEntry: (sessionKey: string) => ({
    entry: sessionStore[sessionKey],
    canonicalKey: sessionKey,
  }),
  loadSessionEntryByKey: (sessionKey: string) => sessionStore[sessionKey],
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
}));

vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: (sessionKey: string) =>
    sessionKey.split(":subagent:").length - 1,
}));

import {
  maybeWakeRequesterAfterAllChildrenSettled,
  type RequesterSettleWakeBatchState,
} from "./subagent-announce.requester-settle-wake.js";

const REQUESTER = "agent:main:main";
const requesterSettleKey = (suffix: string) =>
  `announce:requester-settle:main:${REQUESTER}:${suffix}`;

type SettledChildOverrides = Omit<Partial<SubagentRunRecord>, "execution"> & {
  startedAt?: number;
  endedAt?: number;
  outcome?: SubagentRunRecord["execution"]["outcome"];
  execution?: SubagentRunRecord["execution"];
};

function makeSettledChild(overrides: SettledChildOverrides): SubagentRunRecord {
  const runId = overrides.runId ?? "run-child";
  const { startedAt = 2_000, endedAt = 3_000, outcome, execution, ...recordOverrides } = overrides;
  return {
    runId,
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${runId}`,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "investigate",
    cleanup: "keep",
    createdAt: 1_000,
    execution: execution ?? { status: "terminal", startedAt, endedAt, outcome },
    expectsCompletionMessage: true,
    delivery: { status: "delivered" },
    requesterSettleWake: { status: "pending", attemptCount: 0 },
    ...recordOverrides,
  };
}

const transitionBatchSpy = vi.fn();
const completeBatchSpy = vi.fn();

function listedRequesterRuns(): SubagentRunRecord[] {
  return registryRuntimeMock.listSubagentRunsForRequester(REQUESTER) as SubagentRunRecord[];
}

function transitionBatch(
  batch: readonly SubagentRunRecord[],
  state: RequesterSettleWakeBatchState,
): void {
  transitionBatchSpy(batch.map((entry) => entry.runId).toSorted(), state);
  for (const entry of batch) {
    if (entry.requesterSettleWake) {
      entry.requesterSettleWake = {
        ...state,
        ...(entry.requesterSettleWake.retireAfterSettle ? { retireAfterSettle: true } : {}),
      };
    }
  }
}

function completeBatch(
  batch: readonly SubagentRunRecord[],
  rearmGeneration?: number,
  outcome?: SubagentAnnounceDeliveryResult,
): void {
  const runIds = batch.map((entry) => entry.runId).toSorted();
  if (outcome) {
    completeBatchSpy(runIds, rearmGeneration, outcome);
  } else if (rearmGeneration === undefined) {
    completeBatchSpy(runIds);
  } else {
    completeBatchSpy(runIds, rearmGeneration);
  }
  for (const entry of batch) {
    if (entry.requesterSettleWake?.rearmGeneration === rearmGeneration) {
      entry.requesterSettleWake = undefined;
    }
  }
}

function wakeParams(
  overrides?: Partial<Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0]>,
) {
  return {
    requesterSessionKey: REQUESTER,
    settledEntry:
      listedRequesterRuns().find((entry) => entry.runId === "run-b") ??
      makeSettledChild({ runId: "run-b" }),
    transitionBatch,
    completeBatch,
    ...overrides,
  };
}

function deliveredCallArg(): Record<string, unknown> {
  const call = deliverSpy.mock.calls[0]?.[0];
  if (!call) {
    throw new Error("expected deliverSubagentAnnouncement call");
  }
  return call;
}

describe("maybeWakeRequesterAfterAllChildrenSettled restart-persistent outbox", () => {
  beforeEach(() => {
    deliverSpy.mockClear();
    transitionBatchSpy.mockClear();
    completeBatchSpy.mockClear();
    sessionStore = { [REQUESTER]: { sessionId: "sess-main" } };
    registryRuntimeMock.countActiveDescendantRuns.mockReset().mockReturnValue(0);
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReset().mockReturnValue(false);
    registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    registryRuntimeMock.getLatestSubagentRunByChildSessionKey
      .mockReset()
      .mockReturnValue(undefined);
  });

  it("keeps an earlier delete row pending across restart before the final settle", async () => {
    const childA = makeSettledChild({
      runId: "run-a",
      cleanup: "delete",
      requesterSettleWake: { status: "pending", attemptCount: 0, retireAfterSettle: true },
      completion: { required: true, resultText: "alpha findings" },
    });
    const childB = makeSettledChild({
      runId: "run-b",
      cleanup: "delete",
      requesterSettleWake: { status: "pending", attemptCount: 0, retireAfterSettle: true },
      completion: { required: true, resultText: "beta findings" },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([childA, childB]);
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReturnValue(true);

    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: childA })),
    ).toBe(false);
    expect(childA.requesterSettleWake?.status).toBe("pending");

    // Cold restore rehydrates both retained rows; the final settle drains
    // the same wave and carries both persisted results.
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReturnValue(false);
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: childB })),
    ).toBe(true);
    expect(String(deliveredCallArg().triggerMessage)).toContain("alpha findings");
    expect(String(deliveredCallArg().triggerMessage)).toContain("beta findings");
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"], undefined, {
      delivered: true,
      path: "direct",
    });
  });

  it("persists the frozen batch before dispatch", async () => {
    const children = [makeSettledChild({ runId: "run-a" }), makeSettledChild({ runId: "run-b" })];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);

    await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[1] }));

    expect(transitionBatchSpy).toHaveBeenNthCalledWith(1, ["run-a", "run-b"], {
      status: "dispatching",
      attemptCount: 1,
      batchRunIds: ["run-a", "run-b"],
    });
    expect(transitionBatchSpy.mock.invocationCallOrder[0]).toBeLessThan(
      deliverSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
  });

  it("replays the same attempt after restart following dispatch", async () => {
    const state = {
      status: "dispatching" as const,
      attemptCount: 1,
      batchRunIds: ["run-a", "run-b"],
    };
    const children = [
      makeSettledChild({ runId: "run-a", requesterSettleWake: { ...state } }),
      makeSettledChild({ runId: "run-b", requesterSettleWake: { ...state } }),
    ];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);

    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[0] })),
    ).toBe(true);

    expect(transitionBatchSpy).not.toHaveBeenCalled();
    expect(deliveredCallArg().directIdempotencyKey).toBe(requesterSettleKey("run-a,run-b"));
  });

  it("keeps active overlap pending and only caps a stale settle blocker", async () => {
    const child = makeSettledChild({
      runId: "run-a",
      delivery: { status: "pending" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-a"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReturnValue(true);
    registryRuntimeMock.countActiveDescendantRuns.mockReturnValue(1);

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      for (let recheck = 0; recheck < 12; recheck += 1) {
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }));
        await vi.advanceTimersByTimeAsync(30_000);
      }

      expect(child.requesterSettleWake?.deferralCount).toBe(0);

      registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReturnValue(false);
      await expect(
        maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child })),
      ).resolves.toBe(true);

      vi.clearAllMocks();
      child.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-a"],
        rearmGeneration: 1,
        deferralCount: 8,
      };
      registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReturnValue(true);
      registryRuntimeMock.countActiveDescendantRuns.mockReturnValue(0);

      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }));
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }));
      expect(transitionBatchSpy).toHaveBeenCalledOnce();
      expect(completeBatchSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30_000);
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child }));
      expect(completeBatchSpy).toHaveBeenCalledWith(["run-a"], 1, {
        delivered: false,
        path: "none",
        error: "requester settle wake deferred too many times",
      });
      expect(deliverSpy).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a persisted retry deadline and budget", async () => {
    const state = {
      status: "pending" as const,
      attemptCount: 1,
      nextAttemptAt: 30_000,
      batchRunIds: ["run-a", "run-b"],
      lastError: "provider timeout",
    };
    const children = [
      makeSettledChild({ runId: "run-a", requesterSettleWake: { ...state } }),
      makeSettledChild({ runId: "run-b", requesterSettleWake: { ...state } }),
    ];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[0] })),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(deliverSpy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[0] })),
      ).toBe(true);
      expect(deliveredCallArg().directIdempotencyKey).toBe(
        requesterSettleKey("run-a,run-b:retry-1"),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves mixed keep/delete obligations", async () => {
    const mixed = [
      makeSettledChild({ runId: "run-delete", cleanup: "delete" }),
      makeSettledChild({ runId: "run-keep", cleanup: "keep" }),
    ];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(mixed);
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: mixed[1] })),
    ).toBe(true);
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-delete", "run-keep"], undefined, {
      delivered: true,
      path: "direct",
    });
  });
});
