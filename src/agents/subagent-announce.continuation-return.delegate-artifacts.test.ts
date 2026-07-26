import { beforeEach, describe, expect, it, vi } from "vitest";

type EnqueueContinuationReturnParams = Parameters<
  (typeof import("../auto-reply/continuation/targeting.js"))["enqueueContinuationReturnDeliveries"]
>[0];

const mocks = vi.hoisted(() => ({
  enqueueContinuationReturnDeliveries: vi.fn(
    async (_params: EnqueueContinuationReturnParams) => undefined,
  ),
  listSessionEntries: vi.fn(() => {
    throw new Error("managed return must not enumerate live sessions");
  }),
  resolveAllAgentSessionStoreTargetsSync: vi.fn(() => {
    throw new Error("managed return must not enumerate live stores");
  }),
  markDelegateArtifactDeliveryUnavailable: vi.fn(),
}));

vi.mock("../auto-reply/continuation/targeting.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auto-reply/continuation/targeting.js")>();
  return {
    ...actual,
    enqueueContinuationReturnDeliveries: mocks.enqueueContinuationReturnDeliveries,
    resolveContinuationReturnTargetSessionKeys: vi.fn(() => {
      throw new Error("managed return must not re-resolve its route");
    }),
  };
});
vi.mock("../config/sessions/session-accessor.js", () => ({
  listSessionEntries: mocks.listSessionEntries,
}));
vi.mock("../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargetsSync: mocks.resolveAllAgentSessionStoreTargetsSync,
}));
vi.mock("./delegate-artifacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./delegate-artifacts.js")>();
  return {
    ...actual,
    markDelegateArtifactDeliveryUnavailable: mocks.markDelegateArtifactDeliveryUnavailable,
  };
});

import { routeSubagentContinuationReturn } from "./subagent-announce.continuation-return.js";

const baseParams = {
  cfg: {},
  continuationEnabled: true,
  isContinuationChainDelegate: true,
  maxChainLength: 4,
  task: "produce a report",
  taskLabel: "report",
  triggerMessage: "legacy",
  managedArtifactReturn: true,
  announceId: "announce-1",
  childSessionKey: "agent:main:subagent:child",
  childRunId: "child-run-1",
  targetRequesterSessionKey: "agent:main:parent",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("managed delegate artifact return routing", () => {
  it("defers finalized returns while continuation is disabled", async () => {
    await expect(
      routeSubagentContinuationReturn({
        ...baseParams,
        continuationEnabled: false,
        continuationTargetSessionKey: "agent:main:target",
        triggerMessagesBySessionKey: new Map([["agent:main:target", "target envelope"]]),
      }),
    ).resolves.toEqual({ handled: true, deferred: true });
    expect(mocks.enqueueContinuationReturnDeliveries).not.toHaveBeenCalled();
  });

  it("uses only the stored recipient projection for host-wide fan-out", async () => {
    const messages = new Map([
      ["agent:main:alpha", "alpha envelope"],
      ["agent:main:beta", "beta envelope"],
    ]);
    const alphaProjection = {
      arrivalContext: {
        dispatchId: "dispatch-1",
        binding: { recipientSessionId: "alpha-session" },
      },
    } as never;
    const betaProjection = {
      arrivalContext: {
        dispatchId: "dispatch-1",
        binding: { recipientSessionId: "beta-session" },
      },
    } as never;

    await expect(
      routeSubagentContinuationReturn({
        ...baseParams,
        continuationFanoutMode: "all",
        triggerMessagesBySessionKey: messages,
        managedArtifactProjections: new Map([
          ["agent:main:alpha", alphaProjection],
          ["agent:main:beta", betaProjection],
        ]),
      }),
    ).resolves.toEqual({ handled: true });

    expect(mocks.resolveAllAgentSessionStoreTargetsSync).not.toHaveBeenCalled();
    expect(mocks.listSessionEntries).not.toHaveBeenCalled();
    expect(mocks.enqueueContinuationReturnDeliveries).toHaveBeenCalledTimes(1);
    const call = mocks.enqueueContinuationReturnDeliveries.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) {
      throw new Error("expected one continuation return delivery");
    }
    expect(call.targetSessionKeys).toEqual(["agent:main:alpha", "agent:main:beta"]);
    expect(call.textBySessionKey).toBe(messages);
    expect([...(call.expectedSessionIds?.entries() ?? [])]).toEqual([
      ["agent:main:alpha", "alpha-session"],
      ["agent:main:beta", "beta-session"],
    ]);
    expect([...(call.delegateArtifactReceipts?.values() ?? [])]).toEqual([
      expect.objectContaining({
        recipientSessionKey: "agent:main:alpha",
        recipientSessionId: "alpha-session",
      }),
      expect.objectContaining({
        recipientSessionKey: "agent:main:beta",
        recipientSessionId: "beta-session",
      }),
    ]);
    expect([...(call.delegateArtifactProjections?.values() ?? [])]).toEqual([
      alphaProjection,
      betaProjection,
    ]);
  });

  it("terminalizes a stored managed recipient filtered by lifecycle state", async () => {
    const sessionKey = "agent:main:cleaned";
    await expect(
      routeSubagentContinuationReturn({
        ...baseParams,
        triggerMessagesBySessionKey: new Map([[sessionKey, "managed envelope"]]),
        managedArtifactProjections: new Map([
          [
            sessionKey,
            {
              arrivalContext: {
                dispatchId: "dispatch-1",
                binding: {
                  recipientSessionId: "cleaned-session",
                },
              },
            } as never,
          ],
        ]),
        registryRuntime: {
          shouldIgnorePostCompletionAnnounceForSession: () => true,
        } as never,
      }),
    ).resolves.toEqual({ handled: true });

    expect(mocks.enqueueContinuationReturnDeliveries).not.toHaveBeenCalled();
    expect(mocks.markDelegateArtifactDeliveryUnavailable).toHaveBeenCalledWith({
      dispatchId: "dispatch-1",
      recipientSessionKey: sessionKey,
      recipientSessionId: "cleaned-session",
      reason: "recipient-no-longer-active",
    });
  });
});
