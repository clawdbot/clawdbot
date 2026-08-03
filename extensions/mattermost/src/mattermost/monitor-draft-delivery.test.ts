// Mattermost tests cover draft-preview delivery settlement.
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as clientModule from "./client.js";
import type { MattermostClient } from "./client.js";
import { deliverMattermostReplyWithDraftPreview } from "./monitor-draft-delivery.js";

const updateMattermostPostSpy = vi.spyOn(clientModule, "updateMattermostPost");

function createMattermostClientMock(): MattermostClient {
  return {
    baseUrl: "https://chat.example.com",
    apiBaseUrl: "https://chat.example.com/api/v4",
    token: "token",
    request: vi.fn(async () => ({})) as MattermostClient["request"],
    fetchImpl: vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as MattermostClient["fetchImpl"],
  };
}

function createMattermostReceipt(messageId: string, kind: "text" | "preview" | "media") {
  return createMessageReceiptFromOutboundResults({
    results: [{ channel: "mattermost", messageId }],
    kind,
  });
}

function createConfirmedPreviewDelivery(messageId: string, content: string) {
  return {
    outcome: "text" as const,
    messageIds: [messageId],
    receipt: createMattermostReceipt(messageId, "preview"),
    visibleReplySent: true,
    content,
  };
}

function createDraftStreamMock(postId: string | null | undefined = "preview-post-1") {
  return {
    flush: vi.fn(async () => {}),
    postId: vi.fn(() => postId ?? undefined),
    clear: vi.fn(async () => {}),
    discardPending: vi.fn(async () => {}),
    seal: vi.fn(async () => {}),
  };
}

function createDeliverFinalMock() {
  return vi.fn(async (payload: { text?: string }) => ({
    outcome: "text" as const,
    messageIds: ["delivered-post-1"],
    receipt: createMattermostReceipt("delivered-post-1", "text"),
    visibleReplySent: true,
    content: payload.text ?? "",
  }));
}

function resolvePreviewFinalText(text?: string) {
  const editText = text?.trim();
  return editText ? { editText, alreadyDelivered: false } : undefined;
}

type DraftDeliveryParams = Parameters<typeof deliverMattermostReplyWithDraftPreview>[0];

function deliverDraftPreview(
  params: Pick<DraftDeliveryParams, "payload" | "draftStream" | "deliverPayload"> &
    Partial<Omit<DraftDeliveryParams, "payload" | "draftStream" | "deliverPayload">>,
) {
  return deliverMattermostReplyWithDraftPreview({
    info: { kind: "final" },
    kind: "channel",
    client: createMattermostClientMock(),
    resolvePreviewFinalText,
    previewState: { finalizedViaPreviewPost: false },
    logVerboseMessage: vi.fn(),
    ...params,
  });
}

function mockCall(mock: { mock: { calls: unknown[][] } }, index: number, label: string): unknown[] {
  const resolvedIndex = index < 0 ? mock.mock.calls.length + index : index;
  const call = mock.mock.calls[resolvedIndex];
  if (!call) {
    throw new Error(`expected ${label} call ${index}`);
  }
  return call;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMattermostPostSpy.mockResolvedValue({ id: "patched" } as never);
});

describe("deliverMattermostReplyWithDraftPreview", () => {
  it("suppresses reasoning-prefixed finals before preview finalization", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();
    const recordThreadParticipation = vi.fn();

    await deliverDraftPreview({
      payload: { text: "  \n > Reasoning:\n> _hidden_" } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      recordThreadParticipation,
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).not.toHaveBeenCalled();
    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(updateMattermostPostSpy).not.toHaveBeenCalled();
    // No visible reply was sent, so the thread must not be marked as participated.
    expect(recordThreadParticipation).not.toHaveBeenCalled();
  });

  it("records thread participation when a same-thread final finalizes the preview in place", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();
    const recordThreadParticipation = vi.fn();

    const result = await deliverDraftPreview({
      payload: { text: "All good" } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      recordThreadParticipation,
      deliverPayload: deliverFinal,
    });

    // Default streaming finalizes by editing the preview post, bypassing deliverPayload —
    // participation must still be recorded (regression: PR #95552 review P1).
    expect(updateMattermostPostSpy).toHaveBeenCalledWith(expect.anything(), "preview-post-1", {
      message: "All good",
    });
    expect(deliverFinal).not.toHaveBeenCalled();
    expect(recordThreadParticipation).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "text",
      messageIds: ["patched"],
      visibleReplySent: true,
      content: "All good",
    });
  });

  it("reports a final already published in a sealed preview generation", async () => {
    const draftStream = createDraftStreamMock(null);
    const deliverFinal = createDeliverFinalMock();
    const confirmedDelivery = createConfirmedPreviewDelivery("sealed-post-1", "Already visible");

    const result = await deliverDraftPreview({
      payload: { text: "Already visible" } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: () => ({
        alreadyDelivered: true,
        confirmedDelivery,
      }),
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      outcome: "text",
      messageIds: ["sealed-post-1"],
      visibleReplySent: true,
      content: "Already visible",
    });
  });

  it("still delivers media when the text is already published", async () => {
    const draftStream = createDraftStreamMock(null);
    const confirmedDelivery = createConfirmedPreviewDelivery("sealed-post-1", "Already visible");
    const mediaReceipt = createMattermostReceipt("media-post-1", "media");
    const deliverFinal = vi.fn(async () => ({
      outcome: "media" as const,
      messageIds: ["media-post-1"],
      receipt: mediaReceipt,
      visibleReplySent: true,
      content: "",
    }));

    const result = await deliverDraftPreview({
      payload: { text: "Already visible", mediaUrl: "https://example.com/image.png" } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: () => ({
        alreadyDelivered: true,
        confirmedDelivery,
      }),
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledExactlyOnceWith({
      text: "",
      mediaUrl: "https://example.com/image.png",
    });
    expect(result).toMatchObject({
      outcome: "media",
      messageIds: ["sealed-post-1", "media-post-1"],
      visibleReplySent: true,
      content: "Already visible",
    });
  });

  it("aggregates sealed and current preview posts into one terminal result", async () => {
    const draftStream = createDraftStreamMock("current-preview");
    const deliverFinal = createDeliverFinalMock();
    const confirmedDelivery = createConfirmedPreviewDelivery("sealed-post-1", "First block");

    const result = await deliverDraftPreview({
      payload: { text: "First block\n\nSecond block" } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: () => ({
        editText: "Second block",
        alreadyDelivered: false,
        confirmedDelivery,
      }),
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      outcome: "text",
      messageIds: ["sealed-post-1", "patched"],
      visibleReplySent: true,
      content: "First block\nSecond block",
    });
    expect(result.receipt?.parts.map((part) => part.platformMessageId)).toEqual([
      "sealed-post-1",
      "patched",
    ]);
  });

  it("sends only the remaining suffix after a partial boundary publish", async () => {
    const draftStream = createDraftStreamMock(null);
    const deliverFinal = createDeliverFinalMock();
    const confirmedDelivery = createConfirmedPreviewDelivery("partial-post-1", "First half");

    const result = await deliverDraftPreview({
      payload: { text: "First half Second half" } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: () => ({
        editText: "Second half",
        deliveryText: "Second half",
        alreadyDelivered: false,
        confirmedDelivery,
      }),
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledExactlyOnceWith({ text: "Second half" });
    expect(result).toMatchObject({
      messageIds: ["partial-post-1", "delivered-post-1"],
      visibleReplySent: true,
      content: "First half\nSecond half",
    });
  });

  it("keeps a finalized preview when a later tool warning is delivered", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();
    const previewState = { finalizedViaPreviewPost: false };
    const params = {
      kind: "direct" as const,
      client: createMattermostClientMock(),
      draftStream,
      resolvePreviewFinalText,
      previewState,
      logVerboseMessage: vi.fn(),
      deliverPayload: deliverFinal,
    };

    await deliverMattermostReplyWithDraftPreview({
      ...params,
      payload: { text: "Successful assistant final" } as never,
      info: { kind: "final" },
    });
    await deliverMattermostReplyWithDraftPreview({
      ...params,
      payload: { text: "Tool error warning", isError: true } as never,
      info: { kind: "final" },
    });

    expect(previewState.finalizedViaPreviewPost).toBe(true);
    expect(deliverFinal).toHaveBeenCalledExactlyOnceWith({
      text: "Tool error warning",
      isError: true,
    });
    expect(draftStream.discardPending).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("deletes the preview after a successful normal final send", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();

    await deliverDraftPreview({
      payload: { text: "All good", replyToId: "reply-1" } as never,
      draftStream,
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledTimes(1);
    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(updateMattermostPostSpy).not.toHaveBeenCalled();
  });

  it("preserves a completed normal send when preview cleanup fails", async () => {
    const draftStream = createDraftStreamMock();
    draftStream.clear.mockRejectedValueOnce(new Error("preview cleanup failed"));
    const deliverFinal = createDeliverFinalMock();

    let caught: unknown;
    try {
      await deliverDraftPreview({
        payload: { text: "Already visible", replyToId: "reply-1" } as never,
        draftStream,
        deliverPayload: deliverFinal,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected a partial Mattermost preview delivery error");
    }
    expect(caught.deliveryResult).toMatchObject({
      messageIds: ["delivered-post-1"],
      visibleReplySent: true,
      content: "Already visible",
    });
    expect(deliverFinal).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("deletes the preview after a successful non-finalizable media final", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();

    await deliverDraftPreview({
      payload: {
        text: "Photo",
        replyToId: "reply-1",
        mediaUrl: "https://example.com/a.png",
      } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledTimes(1);
    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("keeps the preview and sends media-only for TTS supplement finals", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();

    await deliverDraftPreview({
      payload: {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      deliverPayload: deliverFinal,
    });

    expect(updateMattermostPostSpy).toHaveBeenCalledWith(expect.anything(), "preview-post-1", {
      message: "Spoken answer",
    });
    expect(draftStream.discardPending).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(deliverFinal).toHaveBeenCalledWith({
      mediaUrl: "https://example.com/tts.mp3",
      audioAsVoice: true,
      spokenText: "Spoken answer",
      ttsSupplement: { spokenText: "Spoken answer" },
    });
  });

  it("retries an explicitly unsent TTS supplement through normal delivery", async () => {
    const draftStream = createDraftStreamMock();
    let deliveryAttempt = 0;
    const deliverFinal = vi.fn(async (payload: { text?: string }) => {
      deliveryAttempt += 1;
      if (deliveryAttempt === 1) {
        return {
          outcome: "empty" as const,
          visibleReplySent: false,
          suppression: { reason: "no_visible_result" as const },
        };
      }
      return {
        outcome: "text" as const,
        messageIds: ["supplement-post-1"],
        receipt: createMattermostReceipt("supplement-post-1", "media"),
        visibleReplySent: true,
        content: payload.text ?? "",
      };
    });

    const result = await deliverDraftPreview({
      payload: {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledTimes(2);
    expect(deliverFinal.mock.calls[1]?.[0]).not.toHaveProperty("text");
    expect(result).toMatchObject({
      messageIds: ["patched", "supplement-post-1"],
      visibleReplySent: true,
      content: "Spoken answer",
    });
  });

  it("preserves the finalized preview receipt when its supplement fails after sending", async () => {
    const draftStream = createDraftStreamMock();
    const mediaReceipt = createMattermostReceipt("media-post-1", "media");
    const deliverFinal = vi.fn(async () => {
      throw createChannelPartialDeliveryError(new Error("supplement bookkeeping failed"), {
        messageIds: ["media-post-1"],
        receipt: mediaReceipt,
        visibleReplySent: true,
        content: "",
      });
    });

    let caught: unknown;
    try {
      await deliverDraftPreview({
        payload: {
          mediaUrl: "https://example.com/tts.mp3",
          audioAsVoice: true,
          spokenText: "Spoken answer",
          ttsSupplement: { spokenText: "Spoken answer" },
        } as never,
        draftStream,
        effectiveReplyToId: "thread-root-1",
        deliverPayload: deliverFinal,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected a partial Mattermost preview delivery error");
    }
    expect(caught.deliveryResult).toMatchObject({
      messageIds: ["patched", "media-post-1"],
      visibleReplySent: true,
      content: "Spoken answer",
    });
  });

  it("falls back with visible text when TTS supplement preview finalization fails", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();
    updateMattermostPostSpy.mockRejectedValueOnce(new Error("edit failed"));

    await deliverDraftPreview({
      payload: {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: (text) => ({
        editText: text?.trim(),
        deliveryText: "",
        alreadyDelivered: false,
      }),
      deliverPayload: deliverFinal,
    });

    expect(updateMattermostPostSpy).toHaveBeenCalledTimes(1);
    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
    expect(deliverFinal).toHaveBeenCalledWith({
      text: "Spoken answer",
      mediaUrl: "https://example.com/tts.mp3",
      audioAsVoice: true,
      spokenText: "Spoken answer",
      ttsSupplement: { spokenText: "Spoken answer" },
    });
  });

  it("keeps already-delivered TTS supplement fallback audio-only", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();
    updateMattermostPostSpy.mockRejectedValueOnce(new Error("edit failed"));

    await deliverDraftPreview({
      payload: {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: {
          spokenText: "Spoken answer",
          visibleTextAlreadyDelivered: true,
        },
      } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: (text) => ({
        editText: text?.trim(),
        deliveryText: text?.trim(),
        alreadyDelivered: false,
      }),
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledWith({
      mediaUrl: "https://example.com/tts.mp3",
      audioAsVoice: true,
      spokenText: "Spoken answer",
      ttsSupplement: {
        spokenText: "Spoken answer",
        visibleTextAlreadyDelivered: true,
      },
    });
  });

  it("keeps provider-confirmed TTS preview text out of normal media fallback", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();

    await deliverDraftPreview({
      payload: {
        mediaUrl: "https://example.com/tts.mp3",
        audioAsVoice: true,
        spokenText: "Spoken answer",
        ttsSupplement: { spokenText: "Spoken answer" },
      } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      resolvePreviewFinalText: () => ({
        deliveryText: "",
        confirmedDelivery: createConfirmedPreviewDelivery("preview-post-1", "Spoken answer"),
        alreadyDelivered: true,
      }),
      deliverPayload: deliverFinal,
    });

    expect(deliverFinal).toHaveBeenCalledWith({
      mediaUrl: "https://example.com/tts.mp3",
      audioAsVoice: true,
      spokenText: "Spoken answer",
      ttsSupplement: { spokenText: "Spoken answer" },
    });
  });

  it("does not flush error finals before normal delivery", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();

    await deliverDraftPreview({
      payload: { text: "Error", isError: true } as never,
      draftStream,
      effectiveReplyToId: "thread-root-1",
      deliverPayload: deliverFinal,
    });

    expect(draftStream.flush).not.toHaveBeenCalled();
    expect(deliverFinal).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).toHaveBeenCalledTimes(1);
  });

  it("finalizes the preview in place when the final targets the same thread", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = createDeliverFinalMock();
    const client = createMattermostClientMock();

    await deliverDraftPreview({
      payload: { text: "Final answer", replyToId: "child-post-789" } as never,
      client,
      draftStream,
      effectiveReplyToId: "thread-root-456",
      deliverPayload: deliverFinal,
    });

    expect(updateMattermostPostSpy).toHaveBeenCalledTimes(1);
    const [updateClient, updatePostId, updateParams] = mockCall(
      updateMattermostPostSpy,
      0,
      "updateMattermostPost",
    );
    expect(updateClient).toBe(client);
    expect(updatePostId).toBe("preview-post-1");
    expect(updateParams).toStrictEqual({ message: "Final answer" });
    expect(draftStream.flush).toHaveBeenCalledTimes(1);
    expect(draftStream.seal).toHaveBeenCalledTimes(1);
    expect(draftStream.seal.mock.invocationCallOrder[0]).toBeLessThan(
      updateMattermostPostSpy.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(deliverFinal).not.toHaveBeenCalled();
    expect(draftStream.clear).not.toHaveBeenCalled();
  });

  it("keeps the existing preview unchanged when final delivery fails", async () => {
    const draftStream = createDraftStreamMock();
    const deliverFinal = vi.fn(async () => {
      throw new Error("send failed");
    });

    await expect(
      deliverDraftPreview({
        payload: { text: "Broken", replyToId: "reply-1" } as never,
        draftStream,
        deliverPayload: deliverFinal,
      }),
    ).rejects.toThrow("send failed");

    expect(draftStream.discardPending).toHaveBeenCalledTimes(1);
    expect(draftStream.clear).not.toHaveBeenCalled();
    expect(updateMattermostPostSpy).not.toHaveBeenCalled();
  });
});
