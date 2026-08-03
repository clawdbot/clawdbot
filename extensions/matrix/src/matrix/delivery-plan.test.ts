import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  resetPluginBlobStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../test-runtime.js";
import {
  cleanupMatrixDeliveryPlans,
  createMatrixPlannedEvents,
  loadMatrixDeliveryPlan,
  persistMatrixDeliveryPlan,
  reconcileMatrixUnknownSend,
  resolveMatrixDurableDeliveryIdentity,
} from "./delivery-plan.js";

const client = {
  getTransactionScopeId: vi.fn(async () => "scope-1"),
  getMessageWireEventType: vi.fn(async () => "m.room.message" as const),
  sendMessage: vi.fn(
    async (
      roomId: string,
      _content: unknown,
      transactionId?: string,
      beforeWireDispatch?: (dispatch: {
        roomId: string;
        eventType: "m.room.message";
        transactionId: string;
        requestPath: string;
      }) => Promise<void>,
    ) => {
      const resolvedTransactionId = transactionId ?? "missing";
      await beforeWireDispatch?.({
        roomId,
        eventType: "m.room.message",
        transactionId: resolvedTransactionId,
        requestPath: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${resolvedTransactionId}`,
      });
      return `$${resolvedTransactionId}`;
    },
  ),
};

vi.mock("./send/client.js", () => ({
  withResolvedMatrixSendClient: async (
    _opts: unknown,
    run: (resolved: typeof client) => Promise<unknown>,
  ) => await run(client),
}));

vi.mock("./send/targets.js", () => ({
  resolveMatrixRoomId: vi.fn(async () => "!room:example.org"),
}));

let stateDir = "";

function identity(queueId = "queue-1", partIndex = 0, partCount = 1) {
  const resolved = resolveMatrixDurableDeliveryIdentity({ queueId, partIndex, partCount });
  if (!resolved) {
    throw new Error("expected durable Matrix identity");
  }
  return resolved;
}

function events(deliveryIdentity = identity()) {
  return createMatrixPlannedEvents({
    identity: deliveryIdentity,
    events: [
      {
        receiptKind: "text",
        content: { msgtype: "m.text", body: "durable hello" },
      },
    ],
  });
}

async function persist(
  params: {
    queueId?: string;
    partIndex?: number;
    partCount?: number;
    accountId?: string;
    scope?: string;
  } = {},
) {
  const deliveryIdentity = identity(params.queueId, params.partIndex, params.partCount);
  const plannedEvents = events(deliveryIdentity);
  return await persistMatrixDeliveryPlan({
    identity: deliveryIdentity,
    accountId: params.accountId ?? "default",
    roomId: "!room:example.org",
    transactionScopeId: params.scope ?? "scope-1",
    wireEventType: "m.room.message",
    events: plannedEvents,
    dispatch: {
      roomId: "!room:example.org",
      eventType: "m.room.message",
      transactionId: plannedEvents[0]!.transactionId,
      requestPath: `/_matrix/client/v3/rooms/!room%3Aexample.org/send/m.room.message/${plannedEvents[0]!.transactionId}`,
    },
  });
}

function reconciliationContext(queueId = "queue-1") {
  return {
    cfg: {},
    queueId,
    channel: "matrix",
    to: "room:!room:example.org",
    accountId: "default",
    enqueuedAt: 1,
    payloads: [{ text: "durable hello" }],
    retryCount: 0,
  } as const;
}

describe("Matrix durable delivery plans", () => {
  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-plan-"));
    installMatrixTestRuntime({ stateDir });
    client.getTransactionScopeId.mockReset().mockResolvedValue("scope-1");
    client.getMessageWireEventType.mockReset().mockResolvedValue("m.room.message");
    client.sendMessage.mockClear();
  });

  afterEach(() => {
    resetPluginBlobStoreForTests({ closeDatabase: false });
    resetPluginStateStoreForTests();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists one exact plan and rejects a different plan for the same queue part", async () => {
    const plan = await persist();
    const deliveryIdentity = identity();
    expect(plan.events[0]).toMatchObject({
      receiptKind: "text",
      content: { msgtype: "m.text", body: "durable hello" },
    });
    expect(plan.events[0]?.transactionId).toMatch(/^oc_/);
    await expect(
      loadMatrixDeliveryPlan({
        identity: deliveryIdentity,
        accountId: "default",
        roomId: "!room:example.org",
        transactionScopeId: "scope-1",
        wireEventType: "m.room.message",
      }),
    ).resolves.toEqual(plan);

    const changedEvents = createMatrixPlannedEvents({
      identity: deliveryIdentity,
      events: [{ receiptKind: "text", content: { msgtype: "m.text", body: "changed" } }],
    });
    await expect(
      persistMatrixDeliveryPlan({
        identity: deliveryIdentity,
        accountId: "default",
        roomId: "!room:example.org",
        transactionScopeId: "scope-1",
        wireEventType: "m.room.message",
        events: changedEvents,
        dispatch: {
          roomId: "!room:example.org",
          eventType: "m.room.message",
          transactionId: changedEvents[0]!.transactionId,
          requestPath: `/_matrix/client/v3/rooms/!room%3Aexample.org/send/m.room.message/${changedEvents[0]!.transactionId}`,
        },
      }),
    ).rejects.toThrow("no longer matches the prepared event batch");
  });

  it("reissues the exact stored event with its transaction id and reports the provider event id", async () => {
    const plan = await persist();
    client.sendMessage.mockImplementationOnce(
      async (roomId, _content, transactionId, beforeWireDispatch) => {
        await beforeWireDispatch?.({
          roomId,
          eventType: "m.room.message",
          transactionId: transactionId ?? "missing",
          requestPath: `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`,
        });
        return "$event-1";
      },
    );

    await expect(reconcileMatrixUnknownSend(reconciliationContext())).resolves.toMatchObject({
      status: "sent",
      messageId: "$event-1",
      receipt: {
        primaryPlatformMessageId: "$event-1",
        platformMessageIds: ["$event-1"],
        parts: [{ platformMessageId: "$event-1", kind: "text" }],
      },
    });
    expect(client.sendMessage).toHaveBeenCalledWith(
      "!room:example.org",
      plan.events[0]!.content,
      plan.events[0]!.transactionId,
      expect.any(Function),
    );
  });

  it("preserves the unknown-error fallback for non-error send failures", async () => {
    await persist();
    client.sendMessage.mockRejectedValueOnce({ code: "M_UNKNOWN" });

    await expect(reconcileMatrixUnknownSend(reconciliationContext())).resolves.toMatchObject({
      status: "unresolved",
      error: "unknown error",
      retryable: true,
    });
  });

  it("preserves ordered typed receipt parts and the final event identity", async () => {
    const deliveryIdentity = identity("queue-multi-event");
    const plannedEvents = createMatrixPlannedEvents({
      identity: deliveryIdentity,
      events: [
        { receiptKind: "media", content: { msgtype: "m.image", body: "caption" } },
        { receiptKind: "text", content: { msgtype: "m.text", body: "follow-up" } },
      ],
    });
    await persistMatrixDeliveryPlan({
      identity: deliveryIdentity,
      accountId: "default",
      roomId: "!room:example.org",
      transactionScopeId: "scope-1",
      wireEventType: "m.room.message",
      events: plannedEvents,
      dispatch: {
        roomId: "!room:example.org",
        eventType: "m.room.message",
        transactionId: plannedEvents[0]!.transactionId,
        requestPath: `/_matrix/client/v3/rooms/!room%3Aexample.org/send/m.room.message/${plannedEvents[0]!.transactionId}`,
      },
    });
    client.sendMessage.mockResolvedValueOnce("$media-event").mockResolvedValueOnce("$text-event");

    await expect(
      reconcileMatrixUnknownSend({
        ...reconciliationContext("queue-multi-event"),
        effectiveReplyToId: "$reply",
        threadId: "$thread",
      }),
    ).resolves.toMatchObject({
      status: "sent",
      messageId: "$text-event",
      receipt: {
        primaryPlatformMessageId: "$media-event",
        platformMessageIds: ["$media-event", "$text-event"],
        replyToId: "$reply",
        threadId: "$thread",
        parts: [
          {
            platformMessageId: "$media-event",
            kind: "media",
            index: 0,
            replyToId: "$reply",
            threadId: "$thread",
          },
          {
            platformMessageId: "$text-event",
            kind: "text",
            index: 1,
            replyToId: "$reply",
            threadId: "$thread",
          },
        ],
      },
    });
  });

  it("fails closed without provider I/O when any expected part plan is missing", async () => {
    const incompleteIdentity = identity("queue-incomplete", 0, 2);
    await persist({ queueId: "queue-incomplete", partIndex: 0, partCount: 2 });

    await expect(
      reconcileMatrixUnknownSend(reconciliationContext("queue-incomplete")),
    ).resolves.toMatchObject({
      status: "unresolved",
      retryable: false,
      error: expect.stringContaining("incomplete event plan"),
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
    await expect(
      loadMatrixDeliveryPlan({
        identity: incompleteIdentity,
        accountId: "default",
        roomId: "!room:example.org",
        transactionScopeId: "scope-1",
        wireEventType: "m.room.message",
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when the active transaction scope differs", async () => {
    const scopeIdentity = identity("queue-scope");
    await persist({ queueId: "queue-scope", scope: "old-scope" });

    await expect(
      reconcileMatrixUnknownSend(reconciliationContext("queue-scope")),
    ).resolves.toMatchObject({
      status: "unresolved",
      retryable: false,
      error: expect.stringContaining("no longer matches the active delivery target"),
    });
    expect(client.sendMessage).not.toHaveBeenCalled();
    await expect(
      loadMatrixDeliveryPlan({
        identity: scopeIdentity,
        accountId: "default",
        roomId: "!room:example.org",
        transactionScopeId: "old-scope",
        wireEventType: "m.room.message",
      }),
    ).resolves.toBeNull();
  });

  it("fails closed when the SDK selects a different Matrix endpoint path", async () => {
    await persist({ queueId: "queue-route" });
    client.sendMessage.mockImplementationOnce(
      async (roomId, _content, transactionId, beforeWireDispatch) => {
        await beforeWireDispatch?.({
          roomId,
          eventType: "m.room.message",
          transactionId: transactionId ?? "missing",
          requestPath: `/_matrix/client/v4/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`,
        });
        return "$must-not-send";
      },
    );

    await expect(
      reconcileMatrixUnknownSend(reconciliationContext("queue-route")),
    ).resolves.toMatchObject({
      status: "unresolved",
      retryable: false,
      error: expect.stringContaining("no longer matches the prepared event batch"),
    });
  });

  it("removes all plans for a committed queue without touching another queue", async () => {
    await persist({ queueId: "queue-clean" });
    await persist({ queueId: "queue-keep" });

    await cleanupMatrixDeliveryPlans({ queueId: "queue-clean" });

    await expect(
      loadMatrixDeliveryPlan({
        identity: identity("queue-clean"),
        accountId: "default",
        roomId: "!room:example.org",
        transactionScopeId: "scope-1",
        wireEventType: "m.room.message",
      }),
    ).resolves.toBeNull();
    await expect(
      loadMatrixDeliveryPlan({
        identity: identity("queue-keep"),
        accountId: "default",
        roomId: "!room:example.org",
        transactionScopeId: "scope-1",
        wireEventType: "m.room.message",
      }),
    ).resolves.not.toBeNull();
  });
});
