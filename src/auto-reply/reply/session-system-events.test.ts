import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SystemEvent } from "../../infra/system-events.js";

const RECIPIENT_AUTHORITY_EPOCH = "11111111-1111-4111-8111-111111111111";

const mocks = vi.hoisted(() => ({
  emitContinuationQueueDrainSpan: vi.fn(),
  peekSystemEventEntries: vi.fn(),
  consumeSelectedSystemEventEntries: vi.fn(),
  buildChannelSummary: vi.fn(async () => []),
  ackSessionDelivery: vi.fn(async () => undefined),
  loadPendingSessionDelivery: vi.fn(),
  loadSessionEntry: vi.fn(),
  loadTranscriptEvents: vi.fn<() => Promise<unknown[]>>(async () => []),
  isSessionRecipientAuthorityCurrent: vi.fn(() => true),
  markDelegateArtifactDeliveryUnavailable: vi.fn(),
  prepareDelegateArtifactDelivery: vi.fn(),
  recordDelegateArtifactDeliveryBinding: vi.fn(),
  replaceManagedDelegateReturnInPrompt: vi.fn(),
  resolveContinuationRuntimeConfig: vi.fn(),
}));

vi.mock("../../infra/continuation-tracer.js", () => ({
  emitContinuationQueueDrainSpan: mocks.emitContinuationQueueDrainSpan,
}));

vi.mock("../../infra/system-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../infra/system-events.js")>();
  return {
    ...actual,
    peekSystemEventEntries: mocks.peekSystemEventEntries,
    consumeSelectedSystemEventEntries: mocks.consumeSelectedSystemEventEntries,
  };
});

vi.mock("../../infra/channel-summary.js", () => ({
  buildChannelSummary: mocks.buildChannelSummary,
}));
vi.mock("../../infra/session-delivery-queue-storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/session-delivery-queue-storage.js")>();
  return {
    ...actual,
    ackSessionDelivery: mocks.ackSessionDelivery,
    loadPendingSessionDelivery: mocks.loadPendingSessionDelivery,
  };
});
vi.mock("../../agents/delegate-artifacts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/delegate-artifacts.js")>();
  return {
    ...actual,
    markDelegateArtifactDeliveryUnavailable: mocks.markDelegateArtifactDeliveryUnavailable,
    prepareDelegateArtifactDelivery: mocks.prepareDelegateArtifactDelivery,
    recordDelegateArtifactDeliveryBinding: mocks.recordDelegateArtifactDeliveryBinding,
  };
});
vi.mock("../../agents/internal-events.js", () => ({
  replaceManagedDelegateReturnInPrompt: mocks.replaceManagedDelegateReturnInPrompt,
}));
vi.mock("../../config/sessions/session-accessor.js", () => ({
  isSessionRecipientAuthorityCurrent: mocks.isSessionRecipientAuthorityCurrent,
  loadSessionEntry: mocks.loadSessionEntry,
  loadTranscriptEvents: mocks.loadTranscriptEvents,
}));
vi.mock("../continuation/config.js", () => ({
  resolveContinuationRuntimeConfig: mocks.resolveContinuationRuntimeConfig,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: {
    log: vi.fn(),
  },
}));

const { drainFormattedSystemEvents, prepareFormattedSystemEvents } =
  await import("./session-system-events.js");
const { resolveFinalSystemEventAdoption, settleManagedSystemEventsAfterTurnAdoption } =
  await import("./session-system-event-adoption.js");

describe("drainFormattedSystemEvents trace context", () => {
  beforeEach(() => {
    mocks.emitContinuationQueueDrainSpan.mockClear();
    mocks.peekSystemEventEntries.mockReset();
    mocks.consumeSelectedSystemEventEntries.mockReset();
    mocks.buildChannelSummary.mockClear();
    mocks.ackSessionDelivery.mockClear();
    mocks.loadPendingSessionDelivery.mockReset();
    mocks.loadSessionEntry.mockReset().mockReturnValue({ sessionId: "current-session" });
    mocks.loadTranscriptEvents.mockReset().mockResolvedValue([]);
    mocks.isSessionRecipientAuthorityCurrent.mockReset().mockReturnValue(true);
    mocks.markDelegateArtifactDeliveryUnavailable.mockClear();
    mocks.prepareDelegateArtifactDelivery.mockReset();
    mocks.recordDelegateArtifactDeliveryBinding.mockClear();
    mocks.replaceManagedDelegateReturnInPrompt.mockReset();
    mocks.resolveContinuationRuntimeConfig.mockReset().mockReturnValue({
      enabled: true,
      crossSessionTargeting: "enabled",
    });
  });

  it("parents the queue-drain span to the first traced drained entry", async () => {
    const traceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const events: SystemEvent[] = [
      { text: "ordinary event", ts: 1 },
      { text: "[continuation:resume] traced event", ts: 2, traceparent },
      {
        text: "[continuation:resume] later traced event",
        ts: 3,
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    ];
    mocks.peekSystemEventEntries.mockReturnValue(events);
    mocks.consumeSelectedSystemEventEntries.mockReturnValue(events);

    await drainFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(mocks.emitContinuationQueueDrainSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        drainedCount: 3,
        drainedContinuationCount: 2,
        traceparent,
      }),
    );
  });

  it("omits traceparent for untraced drained entries", async () => {
    const events: SystemEvent[] = [{ text: "[continuation:resume] untraced", ts: 1 }];
    mocks.peekSystemEventEntries.mockReturnValue(events);
    mocks.consumeSelectedSystemEventEntries.mockReturnValue(events);

    await drainFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(mocks.emitContinuationQueueDrainSpan).toHaveBeenCalledWith(
      expect.not.objectContaining({ traceparent: expect.any(String) }),
    );
  });

  it("preserves a bound logical recipient across a session id rollover", async () => {
    const event: SystemEvent = {
      text: "accepted delegate result",
      ts: 1,
      sessionDeliveryAckId: "delivery-rollover",
      sessionDeliveryAwaitsTurnAdoption: true,
      recipientAuthority: {
        state: "bound",
        epoch: RECIPIENT_AUTHORITY_EPOCH,
      },
    };
    mocks.peekSystemEventEntries.mockReturnValue([event]);
    mocks.consumeSelectedSystemEventEntries.mockImplementation(
      (_sessionKey: string, entries: SystemEvent[]) => entries,
    );
    mocks.loadSessionEntry.mockReturnValue({ sessionId: "new-session-incarnation" });

    const prepared = await prepareFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(prepared.blocks).toEqual([
      expect.objectContaining({
        key: "session-delivery:delivery-rollover",
        text: expect.stringContaining("accepted delegate result"),
      }),
    ]);
    expect(prepared.managedDeliveries).toHaveLength(1);
    expect(mocks.ackSessionDelivery).not.toHaveBeenCalled();
  });

  it("settles a stale bound recipient before prompt adoption", async () => {
    const event: SystemEvent = {
      text: "stale delegate result",
      ts: 1,
      sessionDeliveryAckId: "delivery-stale-authority",
      sessionDeliveryAwaitsTurnAdoption: true,
      recipientAuthority: {
        state: "bound",
        epoch: RECIPIENT_AUTHORITY_EPOCH,
      },
    };
    mocks.peekSystemEventEntries.mockReturnValue([event]);
    mocks.consumeSelectedSystemEventEntries.mockImplementation(
      (_sessionKey: string, entries: SystemEvent[]) => entries,
    );
    mocks.loadSessionEntry.mockReturnValue({ sessionId: "replacement-session" });
    mocks.isSessionRecipientAuthorityCurrent.mockReturnValue(false);

    const prepared = await prepareFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(prepared).toEqual({ blocks: [], managedDeliveries: [] });
    expect(mocks.ackSessionDelivery).toHaveBeenCalledWith("delivery-stale-authority", undefined);
    expect(mocks.consumeSelectedSystemEventEntries).toHaveBeenCalledWith("main", [event]);
  });

  it("terminalizes a managed delivery before settling a stale-incarnation queue row", async () => {
    const event: SystemEvent = {
      text: "managed return",
      ts: 1,
      expectedSessionId: "replaced-session",
      sessionDeliveryAckId: "delivery-1",
      delegateArtifactReceipt: {
        kind: "delegate-artifact",
        dispatchId: "dispatch-1",
        recipientSessionKey: "main",
        recipientSessionId: "replaced-session",
      },
    };
    mocks.peekSystemEventEntries.mockReturnValue([event]);
    mocks.consumeSelectedSystemEventEntries.mockReturnValue([event]);
    mocks.loadPendingSessionDelivery.mockResolvedValue({
      kind: "systemEvent",
      managedDelegateArtifactDelivery: {
        receipt: event.delegateArtifactReceipt,
        projection: {
          artifacts: [],
          arrivalContext: {
            deliveryClass: "delegate result",
            deliveryMode: "announced",
            dispatchId: "dispatch-1",
            producer: { sessionKey: "child", runId: "run-1" },
            completionId: "completion-1",
            binding: {
              recipientSessionKey: "main",
              recipientSessionId: "replaced-session",
            },
            dispatchAcceptedAt: 1,
            completedAt: 2,
            deliveredAt: 3,
            policyVersion: 1,
            availability: "available",
          },
        },
      },
    });
    mocks.prepareDelegateArtifactDelivery.mockReturnValue({ status: "unavailable" });

    await drainFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(mocks.markDelegateArtifactDeliveryUnavailable).toHaveBeenCalledWith({
      dispatchId: "dispatch-1",
      recipientSessionKey: "main",
      recipientSessionId: "replaced-session",
      reason: "recipient-incarnation-changed",
    });
    expect(mocks.recordDelegateArtifactDeliveryBinding).not.toHaveBeenCalled();
    expect(mocks.ackSessionDelivery).toHaveBeenCalledWith("delivery-1", undefined);
  });

  it("leaves a managed return queued while its runtime gate is disabled", async () => {
    const receipt = {
      kind: "delegate-artifact" as const,
      dispatchId: "dispatch-1",
      recipientSessionKey: "main",
      recipientSessionId: "current-session",
    };
    const projection = {
      artifacts: [],
      arrivalContext: {
        deliveryClass: "delegate result" as const,
        deliveryMode: "announced" as const,
        dispatchId: "dispatch-1",
        producer: { sessionKey: "child", runId: "run-1" },
        completionId: "completion-1",
        binding: {
          recipientSessionKey: "main",
          recipientSessionId: "current-session",
        },
        dispatchAcceptedAt: 1,
        completedAt: 2,
        deliveredAt: 3,
        policyVersion: 1 as const,
        availability: "available" as const,
      },
    };
    const event: SystemEvent = {
      text: "managed return",
      ts: 1,
      expectedSessionId: "current-session",
      sessionDeliveryAckId: "delivery-1",
      delegateArtifactReceipt: receipt,
    };
    mocks.peekSystemEventEntries.mockReturnValue([event]);
    mocks.consumeSelectedSystemEventEntries.mockReturnValue([]);
    mocks.loadPendingSessionDelivery.mockResolvedValue({
      kind: "systemEvent",
      managedDelegateArtifactDelivery: { receipt, projection },
    });
    mocks.prepareDelegateArtifactDelivery.mockReturnValue({ status: "deferred" });

    await drainFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(mocks.consumeSelectedSystemEventEntries).toHaveBeenCalledWith("main", []);
    expect(mocks.ackSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.recordDelegateArtifactDeliveryBinding).not.toHaveBeenCalled();
  });

  it("refreshes managed context from durable state before prompt delivery", async () => {
    const receipt = {
      kind: "delegate-artifact" as const,
      dispatchId: "dispatch-1",
      recipientSessionKey: "main",
      recipientSessionId: "current-session",
    };
    const projection = {
      artifacts: [],
      arrivalContext: {
        deliveryClass: "delegate result" as const,
        deliveryMode: "announced" as const,
        dispatchId: "dispatch-1",
        producer: { sessionKey: "child", runId: "run-1" },
        completionId: "completion-1",
        binding: {
          recipientSessionKey: "main",
          recipientSessionId: "current-session",
        },
        dispatchAcceptedAt: 1,
        completedAt: 2,
        deliveredAt: 3,
        replayedAt: 4,
        policyVersion: 1 as const,
        availability: "available" as const,
      },
    };
    const event: SystemEvent = {
      text: "stored managed return",
      ts: 1,
      expectedSessionId: "current-session",
      sessionDeliveryAckId: "delivery-1",
      delegateArtifactReceipt: receipt,
    };
    mocks.peekSystemEventEntries.mockReturnValue([event]);
    mocks.consumeSelectedSystemEventEntries.mockImplementation(
      (_sessionKey: string, selected: SystemEvent[]) => selected,
    );
    mocks.loadPendingSessionDelivery.mockResolvedValue({
      kind: "systemEvent",
      managedDelegateArtifactDelivery: { receipt, projection },
    });

    mocks.prepareDelegateArtifactDelivery.mockReturnValue({
      status: "ready",
      projection,
    });
    mocks.replaceManagedDelegateReturnInPrompt.mockReturnValue("refreshed managed return");

    const prompt = await drainFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(prompt).toContain("refreshed managed return");
    expect(prompt).not.toContain("stored managed return");
    expect(mocks.recordDelegateArtifactDeliveryBinding).toHaveBeenCalledWith({
      dispatchId: "dispatch-1",
      recipientSessionKey: "main",
      recipientSessionId: "current-session",
      phase: "acknowledged",
    });
    expect(mocks.ackSessionDelivery).toHaveBeenCalledWith("delivery-1", undefined);
  });

  it("replays the same managed completion until the recipient turn adopts it", async () => {
    const receipt = {
      kind: "delegate-artifact" as const,
      dispatchId: "dispatch-1",
      recipientSessionKey: "main",
      recipientSessionId: "current-session",
    };
    const projection = {
      artifacts: [],
      arrivalContext: {
        deliveryClass: "delegate result" as const,
        deliveryMode: "announced" as const,
        dispatchId: "dispatch-1",
        producer: { sessionKey: "child", runId: "run-1" },
        completionId: "completion-1",
        binding: {
          recipientSessionKey: "main",
          recipientSessionId: "current-session",
        },
        dispatchAcceptedAt: 1,
        completedAt: 2,
        deliveredAt: 3,
        replayedAt: 4,
        policyVersion: 1 as const,
        availability: "available" as const,
      },
    };
    const event: SystemEvent = {
      text: "stored managed return",
      ts: 1,
      expectedSessionId: "current-session",
      sessionDeliveryAckId: "delivery-1",
      delegateArtifactReceipt: receipt,
    };
    mocks.peekSystemEventEntries.mockReturnValue([event]);
    mocks.consumeSelectedSystemEventEntries.mockReturnValue([]);
    mocks.loadPendingSessionDelivery.mockResolvedValue({
      kind: "systemEvent",
      managedDelegateArtifactDelivery: { receipt, projection },
    });
    mocks.prepareDelegateArtifactDelivery.mockReturnValue({
      status: "ready",
      projection,
    });
    mocks.replaceManagedDelegateReturnInPrompt.mockReturnValue("refreshed managed return");

    const first = await prepareFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });
    const replay = await prepareFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(replay.blocks).toEqual(first.blocks);
    expect(replay.managedDeliveries.map((delivery) => delivery.id)).toEqual(["delivery-1"]);
    expect(mocks.ackSessionDelivery).not.toHaveBeenCalled();
    expect(mocks.recordDelegateArtifactDeliveryBinding).not.toHaveBeenCalledWith(
      expect.objectContaining({ phase: "acknowledged" }),
    );

    await first.managedDeliveries[0]?.acknowledge();

    expect(mocks.recordDelegateArtifactDeliveryBinding).toHaveBeenCalledWith({
      dispatchId: "dispatch-1",
      recipientSessionKey: "main",
      recipientSessionId: "current-session",
      phase: "acknowledged",
    });
    expect(mocks.ackSessionDelivery).toHaveBeenCalledWith("delivery-1", undefined);
    expect(mocks.consumeSelectedSystemEventEntries).toHaveBeenCalledWith("main", [event]);
  });

  it("binds a replayed managed delivery and its block to the same recipient authority", async () => {
    const receipt = {
      kind: "delegate-artifact" as const,
      dispatchId: "dispatch-authority",
      recipientSessionKey: "main",
      recipientSessionId: "current-session",
    };
    const projection = {
      artifacts: [],
      arrivalContext: {
        deliveryClass: "delegate result" as const,
        deliveryMode: "announced" as const,
        dispatchId: "dispatch-authority",
        producer: { sessionKey: "child", runId: "run-authority" },
        completionId: "completion-authority",
        binding: {
          recipientSessionKey: "main",
          recipientSessionId: "current-session",
        },
        dispatchAcceptedAt: 1,
        completedAt: 2,
        deliveredAt: 3,
        policyVersion: 1 as const,
        availability: "available" as const,
      },
    };
    const event: SystemEvent = {
      id: "event-authority",
      text: "stored managed return",
      ts: 1,
      expectedSessionId: "current-session",
      sessionDeliveryAckId: "delivery-authority",
      recipientAuthority: {
        state: "bound",
        epoch: RECIPIENT_AUTHORITY_EPOCH,
      },
      delegateArtifactReceipt: receipt,
    };
    mocks.peekSystemEventEntries.mockReturnValue([event]);
    mocks.consumeSelectedSystemEventEntries.mockReturnValue([]);
    mocks.loadPendingSessionDelivery.mockResolvedValue({
      kind: "systemEvent",
      managedDelegateArtifactDelivery: { receipt, projection },
    });
    mocks.prepareDelegateArtifactDelivery.mockReturnValue({
      status: "ready",
      projection,
    });
    mocks.replaceManagedDelegateReturnInPrompt.mockReturnValue("refreshed managed return");

    const prepared = await prepareFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });
    expect(prepared.blocks[0]?.authorityKey).toBe("event-authority");
    expect(prepared.managedDeliveries[0]?.authorityKey).toBe("event-authority");

    mocks.isSessionRecipientAuthorityCurrent.mockReturnValue(false);
    const stale = resolveFinalSystemEventAdoption({ prepared: [prepared] });
    expect(stale.kind).toBe("settle-stale");
    if (stale.kind !== "settle-stale") {
      throw new Error("expected stale recipient settlement");
    }
    await stale.settle();
    expect(resolveFinalSystemEventAdoption({ prepared: [prepared] })).toMatchObject({
      kind: "adopted",
      blocks: [],
      managedDeliveries: new Map(),
    });
    expect(mocks.ackSessionDelivery).toHaveBeenCalledWith("delivery-authority", undefined);
  });

  it("acknowledges only deliveries evidenced by the persisted recipient turn", async () => {
    const delivery1 = vi.fn(async () => undefined);
    const delivery2 = vi.fn(async () => undefined);
    const deliveries = [
      { id: "delivery-1", acknowledge: delivery1 },
      { id: "delivery-2", acknowledge: delivery2 },
    ];

    await settleManagedSystemEventsAfterTurnAdoption({
      deliveries,
      persistedMessage: {
        role: "user",
        content: "older idempotent turn",
      },
    });

    expect(delivery1).not.toHaveBeenCalled();
    expect(delivery2).not.toHaveBeenCalled();

    await settleManagedSystemEventsAfterTurnAdoption({
      deliveries,
      persistedMessage: {
        role: "user",
        content: "adopted managed turn",
        __openclaw: { sessionDeliveryAckIds: ["delivery-2"] },
      },
    });

    expect(delivery1).not.toHaveBeenCalled();
    expect(delivery2).toHaveBeenCalledOnce();
  });

  it("finalizes ingress adoption before fallible managed delivery settlement", async () => {
    const order: string[] = [];
    const settlementError = new Error("managed settlement failed");
    const onTurnAdopted = vi.fn(async () => {
      order.push("ingress-adopted");
    });
    const acknowledge = vi.fn(async () => {
      order.push("managed-settlement");
      throw settlementError;
    });

    await expect(
      settleManagedSystemEventsAfterTurnAdoption({
        deliveries: [{ id: "delivery-1", acknowledge }],
        persistedMessage: {
          role: "user",
          content: "adopted managed turn",
          __openclaw: { sessionDeliveryAckIds: ["delivery-1"] },
        },
        onTurnAdopted,
      }),
    ).rejects.toBe(settlementError);

    expect(order).toEqual(["ingress-adopted", "managed-settlement"]);
    expect(onTurnAdopted).toHaveBeenCalledOnce();
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("settles an already-adopted managed delivery without creating another prompt", async () => {
    const receipt = {
      kind: "delegate-artifact" as const,
      dispatchId: "dispatch-1",
      recipientSessionKey: "main",
      recipientSessionId: "current-session",
    };
    const projection = {
      artifacts: [],
      arrivalContext: {
        deliveryClass: "delegate result" as const,
        deliveryMode: "announced" as const,
        dispatchId: "dispatch-1",
        producer: { sessionKey: "child", runId: "run-1" },
        completionId: "completion-1",
        binding: {
          recipientSessionKey: "main",
          recipientSessionId: "current-session",
        },
        dispatchAcceptedAt: 1,
        completedAt: 2,
        deliveredAt: 3,
        policyVersion: 1 as const,
        availability: "available" as const,
      },
    };
    const event: SystemEvent = {
      text: "stored managed return",
      ts: 1,
      expectedSessionId: "current-session",
      sessionDeliveryAckId: "delivery-1",
      delegateArtifactReceipt: receipt,
    };
    mocks.peekSystemEventEntries.mockReturnValue([event]);
    mocks.consumeSelectedSystemEventEntries.mockImplementation(
      (_sessionKey: string, selected: SystemEvent[]) => selected,
    );
    mocks.loadTranscriptEvents.mockResolvedValue([
      {
        type: "message",
        message: {
          role: "user",
          content: "adopted prompt",
          __openclaw: { sessionDeliveryAckIds: ["delivery-1"] },
        },
      },
    ]);
    mocks.loadPendingSessionDelivery.mockResolvedValue({
      kind: "systemEvent",
      managedDelegateArtifactDelivery: { receipt, projection },
    });
    mocks.prepareDelegateArtifactDelivery.mockReturnValue({
      status: "ready",
      projection,
    });
    mocks.replaceManagedDelegateReturnInPrompt.mockReturnValue("refreshed managed return");

    const replay = await prepareFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(replay).toEqual({ blocks: [], managedDeliveries: [] });
    expect(mocks.recordDelegateArtifactDeliveryBinding).toHaveBeenCalledWith({
      dispatchId: "dispatch-1",
      recipientSessionKey: "main",
      recipientSessionId: "current-session",
      phase: "acknowledged",
    });
    expect(mocks.ackSessionDelivery).toHaveBeenCalledWith("delivery-1", undefined);
    expect(mocks.consumeSelectedSystemEventEntries).toHaveBeenCalledWith("main", [event]);
  });

  it("terminalizes a managed return that becomes unavailable during prompt refresh", async () => {
    const receipt = {
      kind: "delegate-artifact" as const,
      dispatchId: "dispatch-1",
      recipientSessionKey: "main",
      recipientSessionId: "current-session",
    };
    const projection = {
      artifacts: [],
      arrivalContext: {
        deliveryClass: "delegate result" as const,
        deliveryMode: "announced" as const,
        dispatchId: "dispatch-1",
        producer: { sessionKey: "child", runId: "run-1" },
        completionId: "completion-1",
        binding: {
          recipientSessionKey: "main",
          recipientSessionId: "current-session",
        },
        dispatchAcceptedAt: 1,
        completedAt: 2,
        deliveredAt: 3,
        policyVersion: 1 as const,
        availability: "available" as const,
      },
    };
    const event: SystemEvent = {
      text: "stored managed return",
      ts: 1,
      expectedSessionId: "current-session",
      sessionDeliveryAckId: "delivery-1",
      delegateArtifactReceipt: receipt,
    };
    mocks.peekSystemEventEntries.mockReturnValue([event]);
    mocks.consumeSelectedSystemEventEntries.mockImplementation(
      (_sessionKey: string, selected: SystemEvent[]) => selected,
    );
    mocks.loadPendingSessionDelivery.mockResolvedValue({
      kind: "systemEvent",
      managedDelegateArtifactDelivery: { receipt, projection },
    });
    mocks.prepareDelegateArtifactDelivery
      .mockReturnValueOnce({ status: "ready", projection })
      .mockReturnValueOnce({ status: "unavailable" });

    const prompt = await drainFormattedSystemEvents({
      cfg: {},
      agentId: "main",
      sessionKey: "main",
      isMainSession: false,
      isNewSession: false,
    });

    expect(prompt).toBeUndefined();
    expect(mocks.markDelegateArtifactDeliveryUnavailable).toHaveBeenCalledWith({
      dispatchId: "dispatch-1",
      recipientSessionKey: "main",
      recipientSessionId: "current-session",
      reason: "delivery-state-unavailable",
    });
    expect(mocks.ackSessionDelivery).toHaveBeenCalledWith("delivery-1", undefined);
  });
});
