import { describe, expect, it } from "vitest";
import {
  buildMessagePlaceholder,
  isBlueBubblesAudioAttachment,
  normalizeWebhookMessage,
  normalizeWebhookReaction,
} from "./monitor-normalize.js";

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

describe("isBlueBubblesAudioAttachment", () => {
  it("detects audio by `audio/*` MIME type", () => {
    expect(isBlueBubblesAudioAttachment({ mimeType: "audio/x-m4a" })).toBe(true);
    expect(isBlueBubblesAudioAttachment({ mimeType: "audio/mp4" })).toBe(true);
  });

  it("detects audio by Apple UTI even when MIME is missing", () => {
    expect(isBlueBubblesAudioAttachment({ uti: "public.audio" })).toBe(true);
    expect(isBlueBubblesAudioAttachment({ uti: "public.mpeg-4-audio" })).toBe(true);
    expect(isBlueBubblesAudioAttachment({ uti: "com.apple.m4a-audio" })).toBe(true);
    expect(isBlueBubblesAudioAttachment({ uti: "com.apple.coreaudio-format" })).toBe(true);
  });

  it("treats UTI matching as case-insensitive", () => {
    expect(isBlueBubblesAudioAttachment({ uti: "Public.Audio" })).toBe(true);
  });

  it("returns false for image / video / unknown attachments", () => {
    expect(isBlueBubblesAudioAttachment({ mimeType: "image/jpeg" })).toBe(false);
    expect(isBlueBubblesAudioAttachment({ mimeType: "video/quicktime" })).toBe(false);
    expect(isBlueBubblesAudioAttachment({ uti: "public.jpeg" })).toBe(false);
    expect(isBlueBubblesAudioAttachment({})).toBe(false);
  });
});

describe("buildMessagePlaceholder audio detection", () => {
  function makeMsg(attachments: Array<{ mimeType?: string; uti?: string }>) {
    return {
      text: "",
      senderId: "+15551234567",
      senderIdExplicit: false,
      isGroup: false,
      attachments,
    } as Parameters<typeof buildMessagePlaceholder>[0];
  }

  it("emits <media:audio> for `audio/*` MIME (existing behavior)", () => {
    expect(buildMessagePlaceholder(makeMsg([{ mimeType: "audio/x-m4a" }]))).toContain(
      "<media:audio>",
    );
  });

  it("emits <media:audio> for Apple `public.audio` UTI when MIME is missing", () => {
    expect(buildMessagePlaceholder(makeMsg([{ uti: "public.audio" }]))).toContain("<media:audio>");
  });

  it("emits <media:audio> for Apple `com.apple.m4a-audio` UTI", () => {
    expect(buildMessagePlaceholder(makeMsg([{ uti: "com.apple.m4a-audio" }]))).toContain(
      "<media:audio>",
    );
  });

  it("falls back to <media:attachment> for non-audio mixes", () => {
    expect(
      buildMessagePlaceholder(makeMsg([{ uti: "public.audio" }, { mimeType: "image/jpeg" }])),
    ).toContain("<media:attachment>");
  });
});
