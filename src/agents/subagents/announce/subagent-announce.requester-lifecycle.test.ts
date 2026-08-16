import { beforeEach, describe, expect, it, vi } from "vitest";
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

let sessionStore: Record<
  string,
  { sessionId?: string; lastChannel?: string; lastTo?: string; lifecycleRevision?: string }
>;

const { registryRuntimeMock } = vi.hoisted(() => ({
  registryRuntimeMock: {
    countPendingDescendantRuns: vi.fn((_rootSessionKey: string) => 0),
    isSubagentSessionRunActive: vi.fn((_childSessionKey: string) => true),
    shouldIgnorePostCompletionAnnounceForSession: vi.fn((_childSessionKey: string) => false),
    hasDescendantRunAwaitingSettle: vi.fn(
      (_rootSessionKey: string, _excludeRunId?: string) => false,
    ),
    listSubagentRunsForRequester: vi.fn((_requesterSessionKey: string): unknown[] => []),
    getLatestSubagentRunByChildSessionKey: vi.fn((_childSessionKey: string) => undefined),
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
    expectedRequesterLifecycleRevision: "revision-1",
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

function completeBatch(
  runIds: readonly string[],
  rearmGeneration?: number,
  outcome?: SubagentAnnounceDeliveryResult,
): void {
  if (outcome) {
    completeBatchSpy(runIds, rearmGeneration, outcome);
  } else if (rearmGeneration === undefined) {
    completeBatchSpy(runIds);
  } else {
    completeBatchSpy(runIds, rearmGeneration);
  }
  const selected = new Set(runIds);
  for (const entry of listedRequesterRuns()) {
    if (
      selected.has(entry.runId) &&
      entry.requesterSettleWake?.rearmGeneration === rearmGeneration
    ) {
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

describe("requester lifecycle fencing", () => {
  beforeEach(() => {
    deliverSpy.mockReset().mockResolvedValue({ delivered: true, path: "direct" });
    transitionBatchSpy.mockClear();
    completeBatchSpy.mockClear();
    sessionStore = { [REQUESTER]: { sessionId: "sess-main", lifecycleRevision: "revision-1" } };
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReset().mockReturnValue(false);
    registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    registryRuntimeMock.getLatestSubagentRunByChildSessionKey
      .mockReset()
      .mockReturnValue(undefined);
  });

  it("delivers to the unchanged requester lifecycle exactly once", async () => {
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a" }),
      makeSettledChild({ runId: "run-b" }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(true);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(completeBatchSpy.mock.calls.at(-1)?.[0]).toEqual(["run-a", "run-b"]);
  });

  it("fences a stale completion out of a replaced requester lifecycle", async () => {
    sessionStore = { [REQUESTER]: { sessionId: "sess-main", lifecycleRevision: "revision-2" } };
    const children = [makeSettledChild({ runId: "run-a" }), makeSettledChild({ runId: "run-b" })];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(completeBatchSpy).not.toHaveBeenCalled();
    expect(transitionBatchSpy).toHaveBeenCalledWith(
      ["run-a", "run-b"],
      expect.objectContaining({
        status: "pending",
        lifecycleMismatch: "requester_replaced",
      }),
    );
    for (const child of children) {
      expect(child.requesterSettleWake?.lifecycleMismatch).toBe("requester_replaced");
      expect(child.requesterSettleWake?.lastError).toContain("requester_replaced");
    }

    const secondWoke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());
    expect(secondWoke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(transitionBatchSpy).toHaveBeenCalledTimes(1);
  });

  it("fences a wake rejected at final gateway admission after a requester reset", async () => {
    const children = [makeSettledChild({ runId: "run-a" }), makeSettledChild({ runId: "run-b" })];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    deliverSpy.mockImplementation(async () => {
      throw new Error('Session "agent:main:main" changed while starting expected work. Retry.');
    });

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(deliveredCallArg().expectedRequesterLifecycleRevision).toBe("revision-1");
    expect(completeBatchSpy).not.toHaveBeenCalled();
    expect(transitionBatchSpy).toHaveBeenLastCalledWith(
      ["run-a", "run-b"],
      expect.objectContaining({ lifecycleMismatch: "requester_replaced" }),
    );
    for (const child of children) {
      expect(child.requesterSettleWake?.lifecycleMismatch).toBe("requester_replaced");
      expect(child.requesterSettleWake?.lastError).toContain("requester_replaced");
    }
  });

  it("fences legacy persisted wakes when the requester lifecycle was replaced", async () => {
    sessionStore = { [REQUESTER]: { sessionId: "sess-main", lifecycleRevision: "revision-2" } };
    const children = [
      makeSettledChild({ runId: "run-a", expectedRequesterLifecycleRevision: undefined }),
      makeSettledChild({ runId: "run-b", expectedRequesterLifecycleRevision: undefined }),
    ];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(completeBatchSpy).not.toHaveBeenCalled();
    expect(children[0]?.requesterSettleWake?.lifecycleMismatch).toBe("requester_replaced");
    expect(children[0]?.requesterSettleWake?.lastError).toContain("requester_replaced");
  });

  it("delivers for an initial lifecycle without a persisted revision", async () => {
    sessionStore = { [REQUESTER]: { sessionId: "sess-main" } };
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([
      makeSettledChild({ runId: "run-a", expectedRequesterLifecycleRevision: null }),
      makeSettledChild({ runId: "run-b", expectedRequesterLifecycleRevision: null }),
    ]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(wakeParams());

    expect(woke).toBe(true);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    expect(deliveredCallArg().expectedRequesterLifecycleRevision).toBeNull();
    expect(completeBatchSpy.mock.calls.at(-1)?.[0]).toEqual(["run-a", "run-b"]);
  });

  it.each([
    ["stale member first", ["run-stale", "run-current"]],
    ["matching member first", ["run-current", "run-stale"]],
  ] as const)(
    "partitions a mixed batch (%s): fences stale members and delivers only matching completions",
    async (_label, order) => {
      sessionStore = { [REQUESTER]: { sessionId: "sess-main", lifecycleRevision: "revision-2" } };
      const stale = makeSettledChild({
        runId: "run-stale",
        expectedRequesterLifecycleRevision: "revision-1",
        completion: { required: true, resultText: "stale findings" },
      });
      const current = makeSettledChild({
        runId: "run-current",
        expectedRequesterLifecycleRevision: "revision-2",
        completion: { required: true, resultText: "current findings" },
        delivery: { status: "pending" },
      });
      const byRunId = { "run-stale": stale, "run-current": current };
      registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(
        order.map((runId) => byRunId[runId]),
      );

      const woke = await maybeWakeRequesterAfterAllChildrenSettled(
        wakeParams({ settledEntry: current }),
      );

      expect(woke).toBe(true);
      expect(deliverSpy).toHaveBeenCalledTimes(1);
      const message = String(deliveredCallArg().triggerMessage);
      expect(message).toContain("current findings");
      expect(message).not.toContain("stale findings");
      expect(transitionBatchSpy).toHaveBeenCalledWith(
        ["run-stale"],
        expect.objectContaining({ lifecycleMismatch: "requester_replaced" }),
      );
      expect(stale.requesterSettleWake?.lifecycleMismatch).toBe("requester_replaced");
      expect(current.requesterSettleWake).toBeUndefined();
      expect(completeBatchSpy.mock.calls.at(-1)?.[0]).toEqual(["run-current"]);
    },
  );

  it("fences legacy members of a mixed batch while delivering matching completions", async () => {
    sessionStore = { [REQUESTER]: { sessionId: "sess-main", lifecycleRevision: "revision-1" } };
    const legacy = makeSettledChild({
      runId: "run-legacy",
      expectedRequesterLifecycleRevision: undefined,
      completion: { required: true, resultText: "legacy findings" },
    });
    const current = makeSettledChild({
      runId: "run-current",
      completion: { required: true, resultText: "current findings" },
      delivery: { status: "pending" },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([legacy, current]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: current }),
    );

    expect(woke).toBe(true);
    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const message = String(deliveredCallArg().triggerMessage);
    expect(message).toContain("current findings");
    expect(message).not.toContain("legacy findings");
    expect(legacy.requesterSettleWake?.lifecycleMismatch).toBe("requester_replaced");
    expect(current.requesterSettleWake).toBeUndefined();
  });

  it("completes a matching subset whose completions were already delivered after fencing stale members", async () => {
    sessionStore = { [REQUESTER]: { sessionId: "sess-main", lifecycleRevision: "revision-2" } };
    const stale = makeSettledChild({
      runId: "run-stale",
      expectedRequesterLifecycleRevision: "revision-1",
      delivery: { status: "pending" },
    });
    const current = makeSettledChild({
      runId: "run-current",
      expectedRequesterLifecycleRevision: "revision-2",
      delivery: { status: "delivered" },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([stale, current]);

    const woke = await maybeWakeRequesterAfterAllChildrenSettled(
      wakeParams({ settledEntry: current }),
    );

    expect(woke).toBe(false);
    expect(deliverSpy).not.toHaveBeenCalled();
    expect(stale.requesterSettleWake?.lifecycleMismatch).toBe("requester_replaced");
    expect(current.requesterSettleWake).toBeUndefined();
    expect(completeBatchSpy.mock.calls.at(-1)?.[0]).toEqual(["run-current"]);
  });
});
