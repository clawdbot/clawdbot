import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";

const REQUESTER = "agent:main:main";
const deliverSpy = vi.fn(async (_params: Record<string, unknown>) => ({
  delivered: true,
  path: "direct",
}));
const completeBatchSpy = vi.fn();

const { registryRuntimeMock } = vi.hoisted(() => ({
  registryRuntimeMock: {
    hasDescendantRunAwaitingSettle: vi.fn(() => false),
    listSubagentRunsForRequester: vi.fn((_requesterSessionKey: string): unknown[] => []),
    getLatestSubagentRunByChildSessionKey: vi.fn(() => undefined),
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
  resolveMainSessionKey: vi.fn(() => REQUESTER),
  resolveSessionStorePathCore: vi.fn(() => "/tmp/sessions.json"),
  waitForEmbeddedAgentRunEnd: vi.fn(async () => true),
}));
vi.mock("./subagent-announce-delivery.js", () => ({
  deliverSubagentAnnouncement: (params: Record<string, unknown>) => deliverSpy(params),
  loadRequesterSessionEntry: (sessionKey: string) => ({
    entry: { sessionId: `session:${sessionKey}` },
    canonicalKey: sessionKey,
  }),
  loadSessionEntryByKey: () => undefined,
  runAnnounceDeliveryWithRetry: async <T>(params: { run: () => Promise<T> }) => await params.run(),
  resolveSubagentAnnounceTimeoutMs: () => 10_000,
  resolveSubagentCompletionOrigin: async (params: { requesterOrigin?: unknown }) =>
    params.requesterOrigin,
}));
vi.mock("../spawn/subagent-depth.js", () => ({
  getSubagentDepthFromSessionStore: () => 0,
}));

import { maybeWakeRequesterAfterAllChildrenSettled } from "./subagent-announce.requester-settle-wake.js";

function makeChild(params: {
  runId: string;
  requesterOrigin?: DeliveryContext;
  parentOnly?: boolean;
}): SubagentRunRecord {
  return {
    runId: params.runId,
    childSessionKey: `agent:main:subagent:${params.runId}`,
    requesterSessionKey: REQUESTER,
    requesterDisplayKey: "main",
    requesterOrigin: params.requesterOrigin,
    task: "investigate",
    cleanup: "keep",
    createdAt: 1_000,
    execution: { status: "terminal", startedAt: 2_000, endedAt: 3_000 },
    completion: { required: true, resultText: `${params.runId} findings` },
    completionTarget: params.parentOnly ? "parent" : undefined,
    expectsCompletionMessage: true,
    delivery: { status: "pending" },
    requesterSettleWake: { status: "pending", attemptCount: 0 },
  };
}

async function wake(params: {
  settledEntry: SubagentRunRecord;
  requesterOrigin?: DeliveryContext;
}) {
  return await maybeWakeRequesterAfterAllChildrenSettled({
    requesterSessionKey: REQUESTER,
    settledEntry: params.settledEntry,
    requesterOrigin: params.requesterOrigin,
    transitionBatch: vi.fn(),
    completeBatch: completeBatchSpy,
  });
}

function deliveryParams(): Record<string, unknown> {
  const params = deliverSpy.mock.calls[0]?.[0];
  if (!params) {
    throw new Error("expected settle delivery");
  }
  return params;
}

describe("parent-only requester settle wake routing", () => {
  beforeEach(() => {
    deliverSpy.mockReset().mockResolvedValue({ delivered: true, path: "direct" });
    completeBatchSpy.mockReset();
    registryRuntimeMock.hasDescendantRunAwaitingSettle.mockReset().mockReturnValue(false);
    registryRuntimeMock.listSubagentRunsForRequester.mockReset().mockReturnValue([]);
    registryRuntimeMock.getLatestSubagentRunByChildSessionKey
      .mockReset()
      .mockReturnValue(undefined);
  });

  it("propagates the strict parent-only receipt contract", async () => {
    const child = makeChild({ runId: "run-parent-only", parentOnly: true });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([child]);

    await expect(wake({ settledEntry: child })).resolves.toBe(true);

    expect(deliveryParams()).toMatchObject({
      completionTarget: "parent",
      expectsCompletionMessage: false,
      requireDirectDelivery: true,
    });
  });

  it("credits only the scheduling row's persisted route partition", async () => {
    const telegram = makeChild({
      runId: "run-telegram",
      parentOnly: true,
      requesterOrigin: { channel: "telegram", to: "telegram:123", accountId: "primary" },
    });
    const slack = makeChild({
      runId: "run-slack",
      parentOnly: true,
      requesterOrigin: { channel: "slack", to: "channel:C123", accountId: "primary" },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([telegram, slack]);

    await expect(
      wake({ settledEntry: telegram, requesterOrigin: telegram.requesterOrigin }),
    ).resolves.toBe(true);

    expect(deliveryParams()).toMatchObject({
      completionTarget: "parent",
      requesterSessionOrigin: telegram.requesterOrigin,
    });
    expect(completeBatchSpy).toHaveBeenCalledWith(["run-telegram"], undefined, {
      delivered: true,
      path: "direct",
    });
    expect(completeBatchSpy.mock.calls.every(([runIds]) => !runIds.includes("run-slack"))).toBe(
      true,
    );
  });

  it("keeps same-route ordinary siblings in the strict partition", async () => {
    const requesterOrigin = { channel: "telegram", to: "telegram:123", accountId: "primary" };
    const parentOnly = makeChild({
      runId: "run-parent-only",
      parentOnly: true,
      requesterOrigin,
    });
    const ordinary = makeChild({ runId: "run-ordinary", requesterOrigin });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([parentOnly, ordinary]);

    await expect(wake({ settledEntry: parentOnly, requesterOrigin })).resolves.toBe(true);

    expect(deliveryParams()).toMatchObject({
      completionTarget: "parent",
      requesterSessionOrigin: requesterOrigin,
    });
    expect(completeBatchSpy).toHaveBeenCalledWith(["run-ordinary", "run-parent-only"], undefined, {
      delivered: true,
      path: "direct",
    });
  });

  it("preserves ordinary cross-route batching without a parent-only obligation", async () => {
    const telegram = makeChild({
      runId: "run-telegram-ordinary",
      requesterOrigin: { channel: "telegram", to: "telegram:123" },
    });
    const slack = makeChild({
      runId: "run-slack-ordinary",
      requesterOrigin: { channel: "slack", to: "channel:C123" },
    });
    registryRuntimeMock.listSubagentRunsForRequester.mockReturnValue([telegram, slack]);

    await expect(
      wake({ settledEntry: telegram, requesterOrigin: telegram.requesterOrigin }),
    ).resolves.toBe(true);

    expect(completeBatchSpy).toHaveBeenCalledWith(
      ["run-slack-ordinary", "run-telegram-ordinary"],
      undefined,
      { delivered: true, path: "direct" },
    );
  });
});
