// Requester settle wake tests cover the registry-less top-level requester:
// drain gating, batch idempotency, and the guards that keep the wake out of
// nested/cron/single-delivered paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const deliverSpy = vi.fn(
  async (
    _params: Record<string, unknown>,
  ): Promise<{ delivered: boolean; path: string; terminal?: boolean; reason?: string }> => ({
    delivered: true,
    path: "direct",
  }),
);

let sessionStore: Record<string, { sessionId?: string; lastChannel?: string; lastTo?: string }>;

const { registryRuntimeMock } = vi.hoisted(() => ({
  registryRuntimeMock: {
    hasDescendantRunAwaitingSettle: vi.fn(
      (_rootSessionKey: string, _excludeRunId?: string) => false,
    ),
    listSubagentRunsForRequester: vi.fn((_requesterSessionKey: string): unknown[] => []),
    getLatestSubagentRunByChildSessionKey: vi.fn((_childSessionKey: string) => undefined),
  },
}));

vi.mock("./subagent-announce.registry.runtime.js", () => registryRuntimeMock);

vi.mock("./subagent-announce.runtime.js", () => ({
  callGateway: vi.fn(async () => ({})),
  dispatchGatewayMethodInProcess: vi.fn(async () => ({})),
  isEmbeddedAgentRunActive: vi.fn(() => false),
  getRuntimeConfig: () => ({ session: { mainKey: "main", scope: "per-sender" } }),
  loadSessionStore: vi.fn(() => ({})),
  readSessionMessagesAsync: vi.fn(async () => []),
  readSessionEntry: vi.fn(() => undefined),
  resolveAgentIdFromSessionKey: vi.fn(() => "main"),
  resolveMainSessionKey: vi.fn(() => "agent:main:main"),
  resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
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

vi.mock("./subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: (sessionKey: string) =>
    sessionKey.split(":subagent:").length - 1,
}));

import {
  maybeWakeRequesterAfterAllChildrenSettled,
  type RequesterSettleWakeBatchState,
} from "./subagent-announce.requester-settle-wake.js";

const REQUESTER = "agent:main:main";

function makeSettledChild(overrides: Partial<SubagentRunRecord>): SubagentRunRecord {
  const runId = overrides.runId ?? "run-child";
  return {
    runId,
    childSessionKey: overrides.childSessionKey ?? `agent:main:subagent:${runId}`,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    task: "investigate",
    cleanup: "keep",
    createdAt: 1_000,
    startedAt: 2_000,
    endedAt: 3_000,
    expectsCompletionMessage: true,
    delivery: { status: "delivered" },
    requesterSettleWake: { status: "pending", attemptCount: 0 },
    ...overrides,
  };
}

const transitionBatchSpy = vi.fn();
const completeBatchSpy = vi.fn();

function listedRequesterRuns(): SubagentRunRecord[] {
  return registryRuntimeMock.listSubagentRunsForRequester(REQUESTER) as SubagentRunRecord[];
}

function transitionBatch(runIds: readonly string[], state: RequesterSettleWakeBatchState): void {
  transitionBatchSpy(runIds, state);
  const selected = new Set(runIds);
  for (const entry of listedRequesterRuns()) {
    if (selected.has(entry.runId) && entry.requesterSettleWake) {
      entry.requesterSettleWake = {
        ...state,
        ...(entry.requesterSettleWake.retireAfterSettle ? { retireAfterSettle: true } : {}),
      };
    }
  }
}

function completeBatch(runIds: readonly string[]): void {
  completeBatchSpy(runIds);
  const selected = new Set(runIds);
  for (const entry of listedRequesterRuns()) {
    if (selected.has(entry.runId)) {
      entry.requesterSettleWake = undefined;
    }
  }
}

function wakeParams(
  overrides?: Partial<Parameters<typeof maybeWakeRequesterAfterAllChildrenSettled>[0]>,
) {
  return {
    requesterSessionKey: REQUESTER,
    settledEntry: makeSettledChild({ runId: "run-b" }),
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

describe("maybeWakeRequesterAfterAllChildrenSettled", () => {
  beforeEach(() => {
    deliverSpy.mockClear();
    transitionBatchSpy.mockClear();
    completeBatchSpy.mockClear();
    sessionStore = { [REQUESTER]: { sessionId: "sess-main" } };
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReset().mockReturnValue(false);
    registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    registryRuntimeMock.getLatestSubagentRunByChildSessionKey
      .mockReset()
      .mockReturnValue(undefined);
  });

  it("wakes the requester once with a batch-stable idempotency key when the fan-out drains", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({
        runId: "run-b",
        completion: { required: true, resultText: "network findings" },
      }),
      makeSettledChild({
        runId: "run-a",
        completion: { required: true, resultText: "social findings" },
      }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(true);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const call = deliveredCallArg();
    expect(call.targetRequesterSessionKey).toBe(REQUESTER);
    expect(call.requesterIsSubagent).toBe(false);
    expect(call.expectsCompletionMessage).toBe(false);
    expect(call.directIdempotencyKey).toBe(`announce:requester-settle:${REQUESTER}:run-a,run-b`);
    const message = String(call.triggerMessage);
    expect(message).toContain("settled");
    expect(message).toContain("social findings");
    expect(message).toContain("network findings");
    expect(registryRuntimeMock.hasDescendantRunAwaitingSettle).toHaveBeenCalledWith(
      REQUESTER,
      "run-b",
    );
  });

  it("coalesces concurrent last-sibling settles into one wake", async () => {
    const children = [makeSettledChild({ runId: "run-a" }), makeSettledChild({ runId: "run-b" })];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    let releaseDeliveries!: () => void;
    const deliveryGate = new Promise<void>((resolve) => {
      releaseDeliveries = resolve;
    });
    deliverSpy.mockImplementation(async () => {
      await deliveryGate;
      return { delivered: true, path: "direct" };
    });

    const wakeA = maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: children[0] }),
    );
    const wakeB = maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: children[1] }),
    );
    await vi.waitFor(() => expect(deliverSpy).toHaveBeenCalledOnce());
    releaseDeliveries();
    await expect(Promise.all([wakeA, wakeB])).resolves.toEqual(
      expect.arrayContaining([true, false]),
    );

    expect(deliveredCallArg().directIdempotencyKey).toBe(
      `announce:requester-settle:${REQUESTER}:run-a,run-b`,
    );
    deliverSpy.mockReset().mockResolvedValue({ delivered: true, path: "direct" });
  });

  it("uses a new batch signature for a later second batch", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
      makeSettledChild({ runId: "run-c" }),
      makeSettledChild({ runId: "run-d" }),
    ]);
    await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: makeSettledChild({ runId: "run-d" }) }),
    );

    const keys = deliverSpy.mock.calls.map(([arg]) => arg.directIdempotencyKey);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it("includes the whole connected drained wave for a staggered fan-out", async () => {
    // A overlaps B and B overlaps C, but A never overlaps C. When C settles
    // last, A's results must still ride the wake and the idempotency key must
    // cover the full component (any last-settler computes the same batch).
    const childA = makeSettledChild({
      runId: "run-a",
      createdAt: 1_000,
      startedAt: 1_000,
      endedAt: 2_000,
      completion: { required: true, resultText: "alpha findings" },
    });
    const childB = makeSettledChild({
      runId: "run-b",
      createdAt: 1_500,
      startedAt: 1_500,
      endedAt: 3_000,
      completion: { required: true, resultText: "bravo findings" },
    });
    const childC = makeSettledChild({
      runId: "run-c",
      createdAt: 2_500,
      startedAt: 2_500,
      endedAt: 4_000,
      completion: { required: true, resultText: "charlie findings" },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([childA, childB, childC]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: childC }),
    );

    expect(woke).toBe(true);
    const call = deliveredCallArg();
    expect(call.directIdempotencyKey).toBe(
      `announce:requester-settle:${REQUESTER}:run-a,run-b,run-c`,
    );
    const message = String(call.triggerMessage);
    expect(message).toContain("alpha findings");
    expect(message).toContain("bravo findings");
    expect(message).toContain("charlie findings");
  });

  it("keeps capacity-queued siblings in the same spawned wave", async () => {
    const first = makeSettledChild({
      runId: "run-first",
      createdAt: 1_000,
      startedAt: 1_000,
      endedAt: 2_000,
    });
    const queued = makeSettledChild({
      runId: "run-queued",
      createdAt: 1_500,
      startedAt: 3_000,
      endedAt: 4_000,
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([first, queued]);

    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: queued })),
    ).toBe(true);
    expect(deliveredCallArg().directIdempotencyKey).toBe(
      `announce:requester-settle:${REQUESTER}:run-first,run-queued`,
    );
  });

  it("ignores long-settled children from earlier non-overlapping spawns", async () => {
    // A one-off completion after an old fan-out must not re-wake the requester
    // about the historical batch: the old children ended before this one began.
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-old-1", createdAt: 100, startedAt: 100, endedAt: 200 }),
      makeSettledChild({ runId: "run-old-2", createdAt: 100, startedAt: 110, endedAt: 250 }),
      makeSettledChild({ runId: "run-b" }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("does not wake while other children still await settle", async () => {
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReturnValue(true);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("leaves nested orchestrators to the descendant-settle wake", async () => {
    const nestedRequester = "agent:main:subagent:middle";
    sessionStore[nestedRequester] = { sessionId: "sess-middle" };
    // A qualifying drained wave, so the depth guard is what rejects.
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a", requesterSessionKey: nestedRequester }),
      makeSettledChild({ runId: "run-b", requesterSessionKey: nestedRequester }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ requesterSessionKey: nestedRequester }),
    );

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("skips cron requester sessions", async () => {
    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ requesterSessionKey: "agent:main:cron:daily-report" }),
    );

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("skips requesters whose session entry is gone", async () => {
    sessionStore = {};
    // A qualifying drained wave, so the missing session entry is what rejects.
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("does not add a wake turn after a single delivered completion", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-b", delivery: { status: "delivered" } }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("wakes for a single required completion whose announce never delivered", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({
        runId: "run-b",
        delivery: { status: "suspended", suspendedAt: 4_000 },
        completion: { required: true, resultText: "orphaned findings" },
      }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(true);
    expect(String(deliveredCallArg().triggerMessage)).toContain("orphaned findings");
  });

  it("wakes with captured fallback output after a resumed completion returns NO_REPLY", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({
        runId: "run-b",
        delivery: { status: "failed" },
        completion: {
          required: true,
          resultText: "NO_REPLY",
          fallbackResultText: "findings captured before the wake",
        },
        outcome: { status: "ok" },
      }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(true);
    const message = String(deliveredCallArg().triggerMessage);
    expect(message).toContain("findings captured before the wake");
    expect(message).not.toContain("<prompt-data>\nNO_REPLY\n</prompt-data>");
  });

  it("stays out of pure fire-and-forget batches", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({
        runId: "run-a",
        expectsCompletionMessage: false,
        delivery: { status: "not_required" },
      }),
      makeSettledChild({
        runId: "run-b",
        expectsCompletionMessage: false,
        delivery: { status: "not_required" },
      }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("retries a transiently failed wake with a fresh idempotency suffix", async () => {
    // The wake is the only event after a drained fan-out; a wake turn lost to
    // a provider stall must not re-park the requester. The gateway dedupe
    // caches terminal outcomes per key, so each retry needs a fresh suffix.
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    deliverSpy.mockResolvedValueOnce({ delivered: false, path: "direct" });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams())).toBe(false);
      expect(deliverSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

      expect(woke).toBe(true);
      expect(deliverSpy).toHaveBeenCalledTimes(2);
      const keys = deliverSpy.mock.calls.map(([arg]) => arg.directIdempotencyKey);
      expect(keys[0]).toBe(`announce:requester-settle:${REQUESTER}:run-a,run-b`);
      expect(keys[1]).toBe(`announce:requester-settle:${REQUESTER}:run-a,run-b:retry-1`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("replays an ambiguous transport failure with the same idempotency key", async () => {
    const firstChild = makeSettledChild({ runId: "run-a" });
    const secondChild = makeSettledChild({ runId: "run-b" });
    const children = [firstChild, secondChild];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
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
        `announce:requester-settle:${REQUESTER}:run-a,run-b`,
        `announce:requester-settle:${REQUESTER}:run-a,run-b`,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers a retry when the requester spawned another active descendant", async () => {
    const firstChild = makeSettledChild({ runId: "run-a" });
    const secondChild = makeSettledChild({ runId: "run-b" });
    const children = [firstChild, secondChild];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
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
    } finally {
      vi.useRealTimers();
      deliverSpy.mockReset().mockResolvedValue({ delivered: true, path: "direct" });
    }
  });

  it("does not retry a terminal delivery failure", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);
    deliverSpy.mockResolvedValueOnce({ delivered: false, path: "direct", terminal: true });

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
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

  describe("restart-persistent outbox", () => {
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
      expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"]);
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
      expect(deliveredCallArg().directIdempotencyKey).toBe(
        `announce:requester-settle:${REQUESTER}:run-a,run-b`,
      );
    });

    it("defers a frozen batch replay until a newer descendant settles", async () => {
      const state = {
        status: "dispatching" as const,
        attemptCount: 1,
        batchRunIds: ["run-a", "run-b"],
      };
      const firstChild = makeSettledChild({
        runId: "run-a",
        requesterSettleWake: { ...state },
      });
      const children = [
        firstChild,
        makeSettledChild({ runId: "run-b", requesterSettleWake: { ...state } }),
        makeSettledChild({
          runId: "run-new",
          endedAt: undefined,
          requesterSettleWake: undefined,
        }),
      ];
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
      registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReturnValue(true);

      vi.useFakeTimers();
      vi.setSystemTime(0);
      try {
        expect(
          await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: firstChild })),
        ).toBe(false);
        expect(deliverSpy).not.toHaveBeenCalled();
        expect(firstChild.requesterSettleWake).toMatchObject({
          ...state,
          nextAttemptAt: 30_000,
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it("coalesces concurrent row restores for one persisted batch", async () => {
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
      let releaseDelivery: (() => void) | undefined;
      deliverSpy.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseDelivery = () => resolve({ delivered: true, path: "direct" });
          }),
      );

      const firstWake = maybeWakeRequesterAfterAllChildrenSettled(
        wakeParams({ settledEntry: children[0] }),
      );
      await vi.waitFor(() => expect(deliverSpy).toHaveBeenCalledOnce());
      const duplicateWake = maybeWakeRequesterAfterAllChildrenSettled(
        wakeParams({ settledEntry: children[1] }),
      );

      await expect(duplicateWake).resolves.toBe(false);
      expect(deliverSpy).toHaveBeenCalledOnce();
      releaseDelivery?.();
      await expect(firstWake).resolves.toBe(true);
    });

    it("does not replay after the durable success transition retired the rows", async () => {
      const children = [makeSettledChild({ runId: "run-a" }), makeSettledChild({ runId: "run-b" })];
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[1] }));
      deliverSpy.mockClear();

      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[1] })),
      ).toBe(false);
      expect(deliverSpy).not.toHaveBeenCalled();
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
          await maybeWakeRequesterAfterAllChildrenSettled(
            wakeParams({ settledEntry: children[0] }),
          ),
        ).toBe(false);
        await vi.advanceTimersByTimeAsync(29_999);
        expect(deliverSpy).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(
          await maybeWakeRequesterAfterAllChildrenSettled(
            wakeParams({ settledEntry: children[0] }),
          ),
        ).toBe(true);
        expect(deliveredCallArg().directIdempotencyKey).toBe(
          `announce:requester-settle:${REQUESTER}:run-a,run-b:retry-1`,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("resolves mixed keep/delete, nested, cron, and fire-and-forget obligations", async () => {
      const mixed = [
        makeSettledChild({ runId: "run-delete", cleanup: "delete" }),
        makeSettledChild({ runId: "run-keep", cleanup: "keep" }),
      ];
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(mixed);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: mixed[1] })),
      ).toBe(true);
      expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-delete", "run-keep"]);

      deliverSpy.mockClear();
      completeBatchSpy.mockClear();
      const fireAndForget = [
        makeSettledChild({
          runId: "run-ff-a",
          expectsCompletionMessage: false,
          delivery: { status: "not_required" },
        }),
        makeSettledChild({
          runId: "run-ff-b",
          expectsCompletionMessage: false,
          delivery: { status: "not_required" },
        }),
      ];
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(fireAndForget);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(
          wakeParams({ settledEntry: fireAndForget[1] }),
        ),
      ).toBe(false);
      expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-ff-a", "run-ff-b"]);
      expect(deliverSpy).not.toHaveBeenCalled();

      completeBatchSpy.mockClear();
      const nestedRequester = "agent:main:subagent:middle";
      const nested = [
        makeSettledChild({ runId: "run-nested-a", requesterSessionKey: nestedRequester }),
        makeSettledChild({ runId: "run-nested-b", requesterSessionKey: nestedRequester }),
      ];
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(nested);
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(
          wakeParams({ requesterSessionKey: nestedRequester, settledEntry: nested[1] }),
        ),
      ).toBe(false);
      expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-nested-a", "run-nested-b"]);

      completeBatchSpy.mockClear();
      const cron = makeSettledChild({ runId: "run-cron" });
      expect(
        await maybeWakeRequesterAfterAllChildrenSettled(
          wakeParams({ requesterSessionKey: "agent:main:cron:daily", settledEntry: cron }),
        ),
      ).toBe(false);
      expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-cron"]);
    });
  });
});
