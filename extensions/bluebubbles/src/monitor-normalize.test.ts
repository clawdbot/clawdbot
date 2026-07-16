import { describe, expect, it } from "vitest";
import { normalizeWebhookMessage, normalizeWebhookReaction } from "./monitor-normalize.js";

function createFallbackDmPayload(overrides: Record<string, unknown> = {}) {
  return {
    guid: "msg-1",
    isGroup: false,
    isFromMe: false,
    handle: null,
    chatGuid: "iMessage;-;+15551234567",
    ...overrides,
  };
}

describe("normalizeWebhookMessage", () => {
  it("falls back to DM chatGuid handle when sender handle is missing", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: createFallbackDmPayload({
        text: "hello",
      }),
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
    expect(result?.senderIdExplicit).toBe(false);
    expect(result?.chatGuid).toBe("iMessage;-;+15551234567");
  });

  it("marks explicit sender handles as explicit identity", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-explicit-1",
        text: "hello",
        isGroup: false,
        isFromMe: true,
        handle: { address: "+15551234567" },
        chatGuid: "iMessage;-;+15551234567",
      },
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
    expect(result?.senderIdExplicit).toBe(true);
  });

  it("does not infer sender from group chatGuid when sender handle is missing", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-1",
        text: "hello group",
        isGroup: true,
        isFromMe: false,
        handle: null,
        chatGuid: "iMessage;+;chat123456",
      },
    });

    expect(result).toBeNull();
  });

  it("accepts array-wrapped payload data", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: [
        {
          guid: "msg-1",
          text: "hello",
          handle: { address: "+15551234567" },
          isGroup: false,
          isFromMe: false,
        },
      ],
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
  });

  it("normalizes participant handles from the handles field", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-handles-1",
        text: "hello group",
        isGroup: true,
        isFromMe: false,
        handle: { address: "+15550000000" },
        chatGuid: "iMessage;+;chat123456",
        handles: [
          { address: "+15551234567", displayName: "Alice" },
          { address: "+15557654321", displayName: "Bob" },
        ],
      },
    });

    expect(result).not.toBeNull();
    expect(result?.participants).toEqual([
      { id: "+15551234567", name: "Alice" },
      { id: "+15557654321", name: "Bob" },
    ]);
  });

  it("normalizes participant handles from the participantHandles field", () => {
    const result = normalizeWebhookMessage({
      type: "new-message",
      data: {
        guid: "msg-participant-handles-1",
        text: "hello group",
        isGroup: true,
        isFromMe: false,
        handle: { address: "+15550000000" },
        chatGuid: "iMessage;+;chat123456",
        participantHandles: [{ address: "+15551234567" }, "+15557654321"],
      },
    });

    expect(result).not.toBeNull();
    expect(result?.participants).toEqual([{ id: "+15551234567" }, { id: "+15557654321" }]);
  });
});

describe("normalizeWebhookReaction", () => {
  it("falls back to DM chatGuid handle when reaction sender handle is missing", () => {
    const result = normalizeWebhookReaction({
      type: "updated-message",
      data: createFallbackDmPayload({
        guid: "msg-2",
        associatedMessageGuid: "p:0/msg-1",
        associatedMessageType: 2000,
      }),
    });

    expect(result).not.toBeNull();
    expect(result?.senderId).toBe("+15551234567");
    expect(result?.senderIdExplicit).toBe(false);
    expect(result?.messageId).toBe("p:0/msg-1");
    expect(result?.action).toBe("added");
  });
});
