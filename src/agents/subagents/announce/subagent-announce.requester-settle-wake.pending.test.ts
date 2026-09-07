// Pending completion-handoff and retry-budget coverage for requester settle wake:
// same-key pending replays, announce-deadline expiry, and bounded failure retries.
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

describe("maybeWakeRequesterAfterAllChildrenSettled pending handoff", () => {
  beforeEach(() => {
    deliverSpy.mockReset().mockImplementation(async () => ({
      delivered: true,
      path: "direct",
    }));
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

  it("replays a pending completion handoff with the same idempotency key", async () => {
    const firstChild = makeSettledChild({ runId: "run-a" });
    const secondChild = makeSettledChild({ runId: "run-b" });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([firstChild, secondChild]);
    deliverSpy.mockResolvedValueOnce({
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(firstChild.requesterSettleWake).toMatchObject({
        status: "dispatching",
        attemptCount: 1,
        nextAttemptAt: 30_000,
        deadlineAt: 1_800_000,
        lastError: "completion_handoff_pending",
      });
      expect(firstChild.requesterSettleWake?.replayCount).toBeUndefined();
      expect(completeBatchSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(true);
      expect(deliverSpy).toHaveBeenCalledTimes(2);
      expect(deliverSpy.mock.calls.map(([arg]) => arg.directIdempotencyKey)).toEqual([
        requesterSettleKey("run-a,run-b"),
        requesterSettleKey("run-a,run-b"),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a pending handoff through both backoffs without spending the failure replay budget", async () => {
    const firstChild = makeSettledChild({ runId: "run-a" });
    const secondChild = makeSettledChild({ runId: "run-b" });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([firstChild, secondChild]);
    const pending = {
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
    } as const;
    deliverSpy
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce({ delivered: true, path: "direct" });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(firstChild.requesterSettleWake).toMatchObject({
        status: "dispatching",
        attemptCount: 1,
        nextAttemptAt: 30_000,
        deadlineAt: 1_800_000,
        lastError: "completion_handoff_pending",
      });
      expect(firstChild.requesterSettleWake?.replayCount).toBeUndefined();
      expect(completeBatchSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(firstChild.requesterSettleWake).toMatchObject({
        status: "dispatching",
        attemptCount: 1,
        nextAttemptAt: 150_000,
        deadlineAt: 1_800_000,
        lastError: "completion_handoff_pending",
      });
      expect(firstChild.requesterSettleWake?.replayCount).toBeUndefined();
      expect(completeBatchSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(firstChild.requesterSettleWake).toMatchObject({
        status: "dispatching",
        attemptCount: 1,
        nextAttemptAt: 270_000,
        deadlineAt: 1_800_000,
        lastError: "completion_handoff_pending",
      });
      expect(firstChild.requesterSettleWake?.replayCount).toBeUndefined();
      expect(completeBatchSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(120_000);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(true);
      expect(deliverSpy).toHaveBeenCalledTimes(4);
      expect(deliverSpy.mock.calls.map(([arg]) => arg.directIdempotencyKey)).toEqual([
        requesterSettleKey("run-a,run-b"),
        requesterSettleKey("run-a,run-b"),
        requesterSettleKey("run-a,run-b"),
        requesterSettleKey("run-a,run-b"),
      ]);
      expect(completeBatchSpy).toHaveBeenCalledWith(["run-a", "run-b"], undefined, {
        delivered: true,
        path: "direct",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retires pending settle observations past the announce lifecycle deadline", async () => {
    const firstChild = makeSettledChild({ runId: "run-a" });
    const secondChild = makeSettledChild({ runId: "run-b" });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([firstChild, secondChild]);
    const pending = {
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
    } as const;
    deliverSpy.mockResolvedValue(pending);

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(firstChild.requesterSettleWake).toMatchObject({
        status: "dispatching",
        attemptCount: 1,
        nextAttemptAt: 30_000,
        deadlineAt: 1_800_000,
        lastError: "completion_handoff_pending",
      });
      expect(firstChild.requesterSettleWake?.replayCount).toBeUndefined();
      expect(completeBatchSpy).not.toHaveBeenCalled();

      // Stay within the failure budget: pending observations keep the same key.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(firstChild.requesterSettleWake?.attemptCount).toBe(1);
      expect(firstChild.requesterSettleWake?.replayCount).toBeUndefined();
      expect(completeBatchSpy).not.toHaveBeenCalled();

      // Cross the announce hard-expiry bound; the wake must terminalize.
      await vi.advanceTimersByTimeAsync(1_770_000);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(completeBatchSpy).toHaveBeenCalledWith(["run-a", "run-b"], undefined, {
        delivered: false,
        path: "none",
        error: "requester settle wake expired",
      });
      expect(firstChild.requesterSettleWake).toBeUndefined();
      // Two pending observations only; expiry retires without another delivery call.
      expect(deliverSpy).toHaveBeenCalledTimes(2);
      expect(deliverSpy.mock.calls.map(([arg]) => arg.directIdempotencyKey)).toEqual([
        requesterSettleKey("run-a,run-b"),
        requesterSettleKey("run-a,run-b"),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors an inherited delivery.deadlineAt for pending settle expiry", async () => {
    const firstChild = makeSettledChild({
      runId: "run-a",
      delivery: { status: "delivered", deadlineAt: 90_000 },
    });
    const secondChild = makeSettledChild({
      runId: "run-b",
      delivery: { status: "delivered", deadlineAt: 120_000 },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([firstChild, secondChild]);
    deliverSpy.mockResolvedValue({
      delivered: false,
      path: "direct",
      reason: "completion_handoff_pending",
      disposition: "retryable",
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(firstChild.requesterSettleWake).toMatchObject({
        status: "dispatching",
        attemptCount: 1,
        nextAttemptAt: 30_000,
        deadlineAt: 90_000,
        lastError: "completion_handoff_pending",
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(firstChild.requesterSettleWake).toMatchObject({
        nextAttemptAt: 90_000,
        deadlineAt: 90_000,
        attemptCount: 1,
      });
      expect(firstChild.requesterSettleWake?.replayCount).toBeUndefined();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(completeBatchSpy).toHaveBeenCalledWith(["run-a", "run-b"], undefined, {
        delivered: false,
        path: "none",
        error: "requester settle wake expired",
      });
      expect(deliverSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays an ambiguous transport failure with the same idempotency key", async () => {
    const firstChild = makeSettledChild({ runId: "run-a" });
    const secondChild = makeSettledChild({ runId: "run-b" });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([firstChild, secondChild]);
    deliverSpy.mockRejectedValueOnce(new Error("connection lost after admission"));

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(firstChild.requesterSettleWake).toMatchObject({
        status: "dispatching",
        attemptCount: 1,
        replayCount: 1,
        nextAttemptAt: 30_000,
        lastError: "connection lost after admission",
      });

      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(true);
      expect(deliverSpy).toHaveBeenCalledTimes(2);
      expect(deliverSpy.mock.calls.map(([arg]) => arg.directIdempotencyKey)).toEqual([
        requesterSettleKey("run-a,run-b"),
        requesterSettleKey("run-a,run-b"),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers a retry when the requester spawned another active descendant", async () => {
    const firstChild = makeSettledChild({ runId: "run-a" });
    const secondChild = makeSettledChild({ runId: "run-b" });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([firstChild, secondChild]);
    registryRuntimeMock.hasDescendantRunAwaitingSettle
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    deliverSpy.mockResolvedValueOnce({ delivered: false, path: "direct" });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(deliverSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: secondChild })),
      ).toBe(false);
      expect(deliverSpy).toHaveBeenCalledTimes(1);
      expect(firstChild.requesterSettleWake?.status).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after bounded retries when the wake keeps failing", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    deliverSpy.mockResolvedValue({ delivered: false, path: "direct" });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
      await vi.advanceTimersByTimeAsync(120_000);
      const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

      expect(woke).toBe(false);
      expect(deliverSpy).toHaveBeenCalledTimes(3);
      expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"], undefined, {
        delivered: false,
        path: "direct",
        error: "undelivered",
      });
    } finally {
      vi.useRealTimers();
      deliverSpy.mockReset().mockResolvedValue({ delivered: true, path: "direct" });
    }
  });

  it("does not retry an ambiguous delivery failure", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    deliverSpy.mockResolvedValueOnce({
      delivered: false,
      path: "direct",
      disposition: "ambiguous",
    });

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"], undefined, {
      delivered: false,
      path: "direct",
      disposition: "ambiguous",
    });
  });

  it("does not consume retry budget when aborted before dispatch", async () => {
    const children = [makeSettledChild({ runId: "run-a" }), makeSettledChild({ runId: "run-b" })];
    const abortController = new AbortController();
    registryRuntimeMock.listSubagentRunsForRequester.mockImplementation(() => {
      abortController.abort();
      return children;
    });

    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(
        wakeParams({ settledEntry: children[1], signal: abortController.signal }),
      ),
    ).toBe(false);
    expect(transitionBatchSpy).not.toHaveBeenCalled();
    expect(deliverSpy).not.toHaveBeenCalled();
  });
});
