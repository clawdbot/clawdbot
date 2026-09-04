// Requester settle wake tests cover the registry-less top-level requester:
// drain gating, batch idempotency, and the guards that keep the wake out of
// nested/cron/single-delivered paths.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

const deliverSpy = vi.fn(
  async (
    _params: Record<string, unknown>,
  ): Promise<{
    delivered: boolean;
    path: string;
    disposition?: "ambiguous" | "permanent_failure" | "intentional_non_delivery";
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

describe("maybeWakeRequesterAfterAllChildrenSettled", () => {
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
    expect(call.requireDirectDelivery).toBe(true);
    expect(call.requireVisibleReply).toBeUndefined();
    expect(call.directIdempotencyKey).toBe(requesterSettleKey("run-a,run-b"));
    const message = String(call.triggerMessage);
    expect(message).toContain("settled");
    expect(message).toContain("social findings");
    expect(message).toContain("network findings");
    expect(message).toContain("NO_REPLY");
    expect(registryRuntimeMock.hasDescendantRunAwaitingSettle).toHaveBeenCalledWith(
      REQUESTER,
      "run-b",
      "main",
    );
  });

  it.each([
    { name: "coalesces concurrent last-sibling settles into one wake", restored: false },
    { name: "coalesces concurrent row restores for one persisted batch", restored: true },
  ])("$name", async ({ restored }) => {
    const children = ["run-a", "run-b"].map((runId) =>
      makeSettledChild({
        runId,
        requesterSettleWake: {
          status: restored ? "dispatching" : "pending",
          attemptCount: restored ? 1 : 0,
          ...(restored ? { batchRunIds: ["run-a", "run-b"] } : {}),
        },
      }),
    );
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    const deliveryGate = createDeferred<{ delivered: boolean; path: string }>();
    deliverSpy.mockReturnValueOnce(deliveryGate.promise);

    const wakeA = maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: children[0] }),
    );
    try {
      await vi.waitFor(() => expect(deliverSpy).toHaveBeenCalledOnce());
      await expect(
        maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: children[1] })),
      ).resolves.toBe(false);
      expect(deliverSpy).toHaveBeenCalledOnce();
    } finally {
      deliveryGate.resolve({ delivered: true, path: "direct" });
      await expect(wakeA).resolves.toBe(true);
    }
    expect(deliveredCallArg().directIdempotencyKey).toBe(requesterSettleKey("run-a,run-b"));
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
      wakeParams({ settledEntry: listedRequesterRuns().find((entry) => entry.runId === "run-d")! }),
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
    expect(call.directIdempotencyKey).toBe(requesterSettleKey("run-a,run-b,run-c"));
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
      requesterSettleKey("run-first,run-queued"),
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
    const children = [makeSettledChild({ runId: "run-a" }), makeSettledChild({ runId: "run-b" })];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReturnValue(true);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: children[1] }),
    );

    expect(woke).toBe(false);
    expect(registryRuntimeMock.hasDescendantRunAwaitingSettle).toHaveBeenCalledOnce();
    expect(transitionBatchSpy).not.toHaveBeenCalled();
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
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"]);
  });

  it("skips cron requester sessions", async () => {
    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ requesterSessionKey: "agent:main:cron:daily-report" }),
    );

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-b"]);
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

  it("does not add a wake turn for an ordinary frozen single completion", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({
        runId: "run-b",
        delivery: { status: "delivered" },
        requesterSettleWake: {
          status: "dispatching",
          attemptCount: 1,
          batchRunIds: ["run-b"],
          requesterYieldBatch: true,
        },
      }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "wakes after a yielded requester's active child completes",
      afterRequesterYield: undefined,
    },
    {
      name: "wakes after a requester yields with one already-delivered completion",
      afterRequesterYield: true,
    },
  ])("$name", async ({ afterRequesterYield }) => {
    const child = makeSettledChild({
      runId: "run-b",
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-b"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
        ...(afterRequesterYield ? { afterRequesterYield } : {}),
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: child }),
    );

    expect(woke).toBe(true);
    expect(deliverSpy).toHaveBeenCalledOnce();
    expect(deliveredCallArg().requireVisibleReply).toBe(true);
    const message = String(deliveredCallArg().triggerMessage);
    expect(message).not.toContain("NO_REPLY");
    expect(message).toContain("continue any remaining in-scope work before replying");
    expect(deliveredCallArg().directIdempotencyKey).toBe(requesterSettleKey("run-b:yield-1"));
    expect(completeBatchSpy).toHaveBeenCalledWith(["run-b"], 1, {
      delivered: true,
      path: "direct",
    });
  });

  it.each([
    ["is running without an end timestamp", { status: "running", startedAt: 2_000 }],
    [
      "is still marked running with an end timestamp",
      { status: "running", startedAt: 2_000, endedAt: 3_000 },
    ],
    ["has no end timestamp", { status: "terminal", startedAt: 2_000 }],
  ] as const)(
    "does not wake a yielded requester while its only frozen child %s",
    async (_description, execution) => {
      const activeChild = makeSettledChild({
        runId: "run-b",
        execution,
        delivery: { status: "pending" },
        requesterSettleWake: {
          status: "pending",
          attemptCount: 0,
          batchRunIds: ["run-b"],
          requesterYieldBatch: true,
          rearmGeneration: 1,
        },
      });
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([activeChild]);

      const woke = await maybeWakeRequesterAfterAllChildrenSettled(
        wakeParams({ settledEntry: activeChild }),
      );

      expect(woke).toBe(false);
      expect(deliverSpy).not.toHaveBeenCalled();
      expect(completeBatchSpy).not.toHaveBeenCalled();
    },
  );

  it("wakes after a retired frozen member disappears from the registry", async () => {
    const remainingChild = makeSettledChild({
      runId: "run-a",
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-a", "run-b"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([remainingChild]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: remainingChild }),
    );

    expect(woke).toBe(true);
    expect(deliverSpy).toHaveBeenCalledOnce();
    expect(completeBatchSpy).toHaveBeenCalledWith(["run-a"], 1, {
      delivered: true,
      path: "direct",
    });
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

  it.each([
    {
      name: "visible local route change",
      requesterOrigin: undefined,
      terminalReply: {
        disposition: "visible",
        text: "authoritative final output",
        modelRouteChange: "Model route changed: requested/model → actual/model.",
      } as const,
      resultText: "stale child output",
      expected: "authoritative final output",
      expectedRouteInstruction:
        "Preserve this runtime-authored model-route change notice in your final answer.",
      expectedRouteChange: "Model route changed: requested/model → actual/model.",
    },
    {
      name: "visible shared route change",
      requesterOrigin: { channel: "discord", to: "channel:shared" },
      terminalReply: {
        disposition: "visible",
        text: "authoritative final output",
        modelRouteChange: "Model route changed: requested/model → actual/model.",
      } as const,
      resultText: "stale child output",
      expected: "authoritative final output",
      expectedRouteInstruction:
        "Keep this runtime-authored model-route change notice internal on this shared surface.",
      expectedRouteChange: "Model route changed: requested/model → actual/model.",
    },
    {
      name: "silent",
      terminalReply: { disposition: "silent" } as const,
      resultText: "NO_REPLY",
      expected: undefined,
    },
    {
      name: "empty",
      terminalReply: { disposition: "empty" } as const,
      resultText: null,
      expected: undefined,
    },
  ])(
    "keeps producer-owned $name terminal evidence in the requester settle wake",
    async ({
      terminalReply,
      resultText,
      expected,
      expectedRouteChange,
      expectedRouteInstruction,
      requesterOrigin,
    }) => {
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
        makeSettledChild({ runId: "run-b" }),
        ...["run-a", "run-c"].map((runId) =>
          makeSettledChild({
            runId,
            delivery: { status: "failed" },
            completion: {
              required: true,
              resultText,
              fallbackResultText: "stale retained findings",
              terminalReply,
            },
            outcome: { status: "ok" },
          }),
        ),
      ]);

      expect(await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ requesterOrigin }))).toBe(
        true,
      );
      const message = String(deliveredCallArg().triggerMessage);
      expect(message).not.toContain("stale retained findings");
      expect(message).not.toContain("stale child output");
      if (expected) {
        expect(message).toContain(expected);
      }
      if (expectedRouteChange) {
        expect(message.split(expectedRouteChange)).toHaveLength(2);
        expect(message).toContain(expectedRouteInstruction);
      }
    },
  );

  it("bounds sorted route notices and excludes superseded child owners", async () => {
    const children = Array.from({ length: 8 }, (_, index) =>
      makeSettledChild({
        runId: `run-${index}`,
        completion: {
          required: true,
          terminalReply: {
            disposition: "visible",
            text: "done",
            modelRouteChange: `Model route changed: requested/${index} → actual/${"x".repeat(260)}.`,
          },
        },
      }),
    ).toReversed();
    const staleChild = makeSettledChild({
      runId: "run-stale",
      completion: {
        required: true,
        terminalReply: {
          disposition: "visible",
          text: "stale output",
          modelRouteChange: "Model route changed: old/owner → stale/route.",
        },
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([staleChild, ...children]);
    registryRuntimeMock.getLatestSubagentRunByChildSessionKey.mockImplementation((sessionKey) =>
      sessionKey === staleChild.childSessionKey
        ? { runId: "run-replacement", requesterSessionKey: "agent:other:main" }
        : undefined,
    );

    expect(
      await maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: staleChild })),
    ).toBe(true);
    const message = String(deliveredCallArg().triggerMessage);
    expect(message).not.toContain("stale output");
    expect(message).not.toContain("old/owner");
    const routeBlock = message.slice(
      message.indexOf("Model route changed:"),
      message.indexOf("\n[Subagent Context] Preserve this runtime-authored"),
    );
    expect(routeBlock).toMatch(/^Model route changed: requested\/0/u);
    expect(routeBlock).toContain("requested/1");
    expect(routeBlock).toContain("[model-route changes truncated]");
    expect(routeBlock.length).toBeLessThanOrEqual(1_024);
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
    expect(completeBatchSpy).toHaveBeenLastCalledWith(["run-a", "run-b"]);
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
      expect(keys[0]).toBe(requesterSettleKey("run-a,run-b"));
      expect(keys[1]).toBe(requesterSettleKey("run-a,run-b:retry-1"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains a yielded wake after a silent final and retries its visible reply", async () => {
    const child = makeSettledChild({
      runId: "run-b",
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-b"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);
    deliverSpy.mockResolvedValueOnce({
      delivered: false,
      path: "direct",
      reason: "visible_reply_missing",
    });

    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      await expect(
        maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child })),
      ).resolves.toBe(false);
      expect(completeBatchSpy).not.toHaveBeenCalled();
      expect(child.requesterSettleWake).toMatchObject({
        status: "pending",
        attemptCount: 1,
        nextAttemptAt: 30_000,
        requesterYieldBatch: true,
        rearmGeneration: 1,
        lastError: "visible_reply_missing",
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await expect(
        maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: child })),
      ).resolves.toBe(true);
      expect(deliverSpy.mock.calls.map(([arg]) => arg.directIdempotencyKey)).toEqual([
        requesterSettleKey("run-b:yield-1"),
        requesterSettleKey("run-b:yield-1:retry-1"),
      ]);
      expect(completeBatchSpy).toHaveBeenCalledWith(["run-b"], 1, {
        delivered: true,
        path: "direct",
      });
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
});
