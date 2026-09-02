// Requester settle wake tests cover the registry-less top-level requester:
// drain gating, batch idempotency, and the guards that keep the wake out of
// nested/cron/single-delivered paths.
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

let sessionStore: Record<string, { sessionId?: string; lastChannel?: string; lastTo?: string }>;

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

describe("fast-settled successor requester settle wakes", () => {
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

  it("retires the predecessor wake when its fast-settled successor owns the final", async () => {
    const original = makeSettledChild({
      runId: "run-original",
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-original"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    const successor = makeSettledChild({
      runId: "run-successor",
      createdAt: 4_000,
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-successor"],
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration: 1,
      },
    });
    const children = [original];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    // The requester continued and the successor finished so quickly that its
    // own durable settle wake is persisted before this older wake returns.
    deliverSpy.mockImplementationOnce(async () => {
      children.push(successor);
      return {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
      };
    });

    await expect(
      maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: original })),
    ).resolves.toBe(false);
    expect(completeBatchSpy).toHaveBeenCalledWith(["run-original"], 1);
    expect(original.requesterSettleWake).toBeUndefined();
    expect(deliverSpy).toHaveBeenCalledOnce();
  });

  it("keeps the predecessor wake pending while its successor is still unsettled", async () => {
    const original = makeSettledChild({
      runId: "run-original",
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-original"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    const successor = makeSettledChild({
      runId: "run-successor",
      createdAt: 4_000,
      execution: { status: "running", startedAt: 4_500 },
    });
    const children = [original];
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue(children);
    registryRuntimeMock.hasDescendantRunAwaitingSettle
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);
    deliverSpy.mockImplementationOnce(async () => {
      children.push(successor);
      return {
        delivered: false,
        path: "direct",
        reason: "visible_reply_missing",
      };
    });

    await expect(
      maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: original })),
    ).resolves.toBe(false);

    expect(completeBatchSpy).not.toHaveBeenCalled();
    expect(original.requesterSettleWake).toMatchObject({
      status: "pending",
      attemptCount: 1,
      requesterYieldBatch: true,
      rearmGeneration: 1,
    });
    expect(deliverSpy).toHaveBeenCalledOnce();
  });

  it("retries a visible final despite an unrelated durable yielded wake", async () => {
    const original = makeSettledChild({
      runId: "run-original",
      createdAt: 1_000,
      startedAt: 2_000,
      endedAt: 3_000,
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-original"],
        requesterYieldBatch: true,
        rearmGeneration: 1,
      },
    });
    const unrelated = makeSettledChild({
      runId: "run-unrelated",
      createdAt: 2_000,
      startedAt: 2_100,
      endedAt: 2_500,
      delivery: { status: "delivered" },
      requesterSettleWake: {
        status: "pending",
        attemptCount: 0,
        batchRunIds: ["run-unrelated"],
        requesterYieldBatch: true,
        afterRequesterYield: true,
        rearmGeneration: 1,
      },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([original, unrelated]);
    deliverSpy.mockResolvedValueOnce({
      delivered: false,
      path: "direct",
      reason: "visible_reply_missing",
    });

    await expect(
      maybeWakeRequesterAfterAllChildrenSettled(wakeParams({ settledEntry: original })),
    ).resolves.toBe(false);

    expect(completeBatchSpy).not.toHaveBeenCalled();
    expect(original.requesterSettleWake).toMatchObject({
      status: "pending",
      attemptCount: 1,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      lastError: "visible_reply_missing",
    });
    expect(deliverSpy).toHaveBeenCalledOnce();
  });
});
