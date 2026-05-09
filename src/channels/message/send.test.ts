import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { OutboundDeliveryError } from "../../infra/outbound/deliver-types.js";
import type { OutboundPayloadDeliveryOutcome } from "../../infra/outbound/deliver-types.js";
import type { OutboundDeliveryIntent } from "../../infra/outbound/deliver.js";

const deliverOutboundPayloads = vi.hoisted(() => vi.fn());

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads,
  deliverOutboundPayloadsInternal: deliverOutboundPayloads,
}));

import { sendDurableMessageBatch, withDurableMessageSendContext } from "./send.js";

type DeliveryIntentCallbackParams = {
  onDeliveryIntent?: (intent: OutboundDeliveryIntent) => void;
  onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
};

const cfg = {} as OpenClawConfig;

describe("withDurableMessageSendContext", () => {
  it("renders and sends through a durable send context", async () => {
    deliverOutboundPayloads.mockImplementationOnce(async (params: DeliveryIntentCallbackParams) => {
      params.onDeliveryIntent?.({
        id: "intent-1",
        channel: "telegram",
        to: "chat-1",
        queuePolicy: "required",
      });
      return [{ channel: "telegram", messageId: "msg-1" }];
    });

    const result = await withDurableMessageSendContext(
      {
        cfg,
        channel: "telegram",
        to: "chat-1",
        payloads: [{ text: "hello" }],
        threadId: 42,
        replyToId: "reply-1",
      },
      async (ctx) => {
        expect(ctx).toEqual(
          expect.objectContaining({
            id: "telegram:chat-1",
            channel: "telegram",
            to: "chat-1",
            durability: "required",
            attempt: 1,
          }),
        );
        const rendered = await ctx.render();
        expect(rendered).toEqual({
          payloads: [{ text: "hello" }],
          plan: expect.objectContaining({
            payloadCount: 1,
            textCount: 1,
            mediaCount: 0,
            items: [{ index: 0, kinds: ["text"] as const, text: "hello", mediaUrls: [] }],
          }),
        });
        const send = await ctx.send(rendered);
        expect(ctx.intent).toEqual(
          expect.objectContaining({
            id: "intent-1",
            channel: "telegram",
            to: "chat-1",
            durability: "required",
            renderedBatch: rendered,
          }),
        );
        return send;
      },
    );

    expect(result).toEqual(
      expect.objectContaining({
        status: "sent",
        deliveryIntent: expect.objectContaining({ id: "intent-1" }),
        receipt: expect.objectContaining({
          platformMessageIds: ["msg-1"],
          threadId: "42",
          replyToId: "reply-1",
        }),
      }),
    );
    expect(deliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        queuePolicy: "required",
        payloads: [{ text: "hello" }],
        threadId: 42,
        replyToId: "reply-1",
      }),
    );
  });

  it("records a replayable rendered batch plan on the durable intent", async () => {
    deliverOutboundPayloads.mockImplementationOnce(async (params: DeliveryIntentCallbackParams) => {
      params.onDeliveryIntent?.({
        id: "intent-media",
        channel: "telegram",
        to: "chat-1",
        queuePolicy: "required",
      });
      return [{ channel: "telegram", messageId: "media-1" }];
    });
    let intent: unknown;

    await withDurableMessageSendContext(
      {
        cfg,
        channel: "telegram",
        to: "chat-1",
        payloads: [
          {
            text: "caption",
            mediaUrls: ["file:///tmp/a.png", "file:///tmp/b.png"],
            audioAsVoice: true,
            presentation: { blocks: [{ type: "text", text: "card" }] },
            interactive: { blocks: [{ type: "buttons", buttons: [{ label: "OK" }] }] },
            channelData: { native: true },
          },
        ],
      },
      async (ctx) => {
        const rendered = await ctx.render();
        await ctx.send(rendered);
        intent = ctx.intent;
      },
    );

    expect(intent).toEqual(
      expect.objectContaining({
        renderedBatch: expect.objectContaining({
          plan: {
            payloadCount: 1,
            textCount: 1,
            mediaCount: 2,
            voiceCount: 1,
            presentationCount: 1,
            interactiveCount: 1,
            channelDataCount: 1,
            items: [
              {
                index: 0,
                kinds: ["text", "voice", "presentation", "interactive", "channelData"] as const,
                text: "caption",
                mediaUrls: ["file:///tmp/a.png", "file:///tmp/b.png"],
                audioAsVoice: true,
                presentationBlockCount: 1,
                hasInteractive: true,
                hasChannelData: true,
              },
            ],
          },
        }),
      }),
    );
  });

  it("forwards the durable send context signal to outbound delivery", async () => {
    const abortController = new AbortController();
    deliverOutboundPayloads.mockImplementationOnce(
      async (params: DeliveryIntentCallbackParams & { abortSignal?: AbortSignal }) => {
        expect(params.abortSignal).toBe(abortController.signal);
        return [{ channel: "telegram", messageId: "msg-1" }];
      },
    );

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "telegram",
      to: "chat-1",
      payloads: [{ text: "hello" }],
      signal: abortController.signal,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "sent",
        receipt: expect.objectContaining({
          platformMessageIds: ["msg-1"],
        }),
      }),
    );
    expect(deliverOutboundPayloads).toHaveBeenLastCalledWith(
      expect.objectContaining({
        abortSignal: abortController.signal,
        queuePolicy: "required",
      }),
    );
  });

  it("maps best-effort durability to best-effort queue policy", async () => {
    deliverOutboundPayloads.mockImplementationOnce(async (params: DeliveryIntentCallbackParams) => {
      params.onDeliveryIntent?.({
        id: "intent-best-effort",
        channel: "telegram",
        to: "chat-1",
        queuePolicy: "best_effort",
      });
      return [{ channel: "telegram", messageId: "msg-1" }];
    });

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "telegram",
      to: "chat-1",
      payloads: [{ text: "hello" }],
      durability: "best_effort",
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "sent",
        deliveryIntent: expect.objectContaining({ id: "intent-best-effort" }),
      }),
    );
    expect(deliverOutboundPayloads).toHaveBeenLastCalledWith(
      expect.objectContaining({
        queuePolicy: "best_effort",
      }),
    );
  });

  it("preserves adapter-provided multipart receipts in durable sends", async () => {
    deliverOutboundPayloads.mockResolvedValueOnce([
      {
        channel: "telegram",
        messageId: "top-level-ignored",
        receipt: {
          primaryPlatformMessageId: "platform-1",
          platformMessageIds: ["platform-1", "platform-2"],
          parts: [
            { platformMessageId: "platform-1", kind: "text", index: 0 },
            { platformMessageId: "platform-2", kind: "media", index: 1 },
          ],
          sentAt: 123,
        },
      },
    ]);

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "telegram",
      to: "chat-1",
      payloads: [{ text: "hello" }],
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "sent",
        receipt: expect.objectContaining({
          primaryPlatformMessageId: "platform-1",
          platformMessageIds: ["platform-1", "platform-2"],
          parts: [
            expect.objectContaining({ platformMessageId: "platform-1", kind: "text" }),
            expect.objectContaining({ platformMessageId: "platform-2", kind: "media" }),
          ],
        }),
      }),
    );
  });

  it("supports preview, edit, and delete send-context hooks", async () => {
    const receipt = {
      primaryPlatformMessageId: "preview-1",
      platformMessageIds: ["preview-1"],
      parts: [],
      sentAt: 123,
    };
    const editedReceipt = {
      ...receipt,
      primaryPlatformMessageId: "preview-1-edited",
      platformMessageIds: ["preview-1-edited"],
    };
    const onEditReceipt = vi.fn(async () => editedReceipt);
    const onDeleteReceipt = vi.fn(async () => undefined);

    await withDurableMessageSendContext(
      {
        cfg,
        channel: "telegram",
        to: "chat-1",
        payloads: [{ text: "final" }],
        preview: {
          phase: "previewing",
          canFinalizeInPlace: true,
          receipt,
        },
        onEditReceipt,
        onDeleteReceipt,
      },
      async (ctx) => {
        const rendered = await ctx.render();
        const preview = await ctx.previewUpdate(rendered);
        expect(preview.lastRendered).toBe(rendered);

        await expect(ctx.edit(receipt, rendered)).resolves.toBe(editedReceipt);
        await ctx.delete(editedReceipt);
      },
    );

    expect(onEditReceipt).toHaveBeenCalledWith(
      receipt,
      expect.objectContaining({ payloads: [{ text: "final" }] }),
    );
    expect(onDeleteReceipt).toHaveBeenCalledWith(editedReceipt);
  });

  it("fails explicit edit and delete operations without a live adapter", async () => {
    const receipt = {
      primaryPlatformMessageId: "preview-1",
      platformMessageIds: ["preview-1"],
      parts: [],
      sentAt: 123,
    };

    await withDurableMessageSendContext(
      {
        cfg,
        channel: "telegram",
        to: "chat-1",
        payloads: [{ text: "final" }],
      },
      async (ctx) => {
        const rendered = await ctx.render();
        await expect(ctx.edit(receipt, rendered)).rejects.toThrow(
          "message send context edit is not configured",
        );
        await expect(ctx.delete(receipt)).rejects.toThrow(
          "message send context delete is not configured",
        );
      },
    );
  });

  it("treats no visible outbound result as a committed suppressed send", async () => {
    deliverOutboundPayloads.mockImplementationOnce(async (params: DeliveryIntentCallbackParams) => {
      params.onDeliveryIntent?.({
        id: "intent-2",
        channel: "whatsapp",
        to: "jid-1",
        queuePolicy: "required",
      });
      return [];
    });
    const onCommitReceipt = vi.fn();

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "whatsapp",
      to: "jid-1",
      payloads: [{ text: "hidden" }],
      onCommitReceipt,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "suppressed",
        reason: "no_visible_result",
        deliveryIntent: expect.objectContaining({ id: "intent-2" }),
      }),
    );
    expect(onCommitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({
        platformMessageIds: [],
      }),
    );
  });

  it("reports hook-cancelled deliveries as explicit suppressed sends", async () => {
    deliverOutboundPayloads.mockImplementationOnce(async (params: DeliveryIntentCallbackParams) => {
      params.onPayloadDeliveryOutcome?.({
        index: 0,
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
        hookEffect: { cancelReason: "owned-by-other-agent" },
      });
      return [];
    });
    const onCommitReceipt = vi.fn();

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "claimed elsewhere" }],
      onCommitReceipt,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
        payloadOutcomes: [
          expect.objectContaining({
            status: "suppressed",
            reason: "cancelled_by_message_sending_hook",
            hookEffect: { cancelReason: "owned-by-other-agent" },
          }),
        ],
      }),
    );
    expect(onCommitReceipt).toHaveBeenCalledWith(
      expect.objectContaining({ platformMessageIds: [] }),
    );
  });

  it("forwards payload delivery outcomes to callers while collecting durable outcomes", async () => {
    const onPayloadDeliveryOutcome = vi.fn();
    deliverOutboundPayloads.mockImplementationOnce(async (params: DeliveryIntentCallbackParams) => {
      params.onPayloadDeliveryOutcome?.({
        index: 0,
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
      });
      return [];
    });

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "slack",
      to: "C123",
      payloads: [{ text: "claimed elsewhere" }],
      onPayloadDeliveryOutcome,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "suppressed",
        payloadOutcomes: [
          expect.objectContaining({
            index: 0,
            status: "suppressed",
            reason: "cancelled_by_message_sending_hook",
          }),
        ],
      }),
    );
    expect(onPayloadDeliveryOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        index: 0,
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
      }),
    );
  });

  it("reports zero-result failed best-effort payloads as failed sends", async () => {
    const error = new Error("send failed");
    deliverOutboundPayloads.mockImplementationOnce(async (params: DeliveryIntentCallbackParams) => {
      params.onPayloadDeliveryOutcome?.({
        index: 0,
        status: "failed",
        error,
        sentBeforeError: false,
        stage: "platform_send",
      });
      return [];
    });
    const onCommitReceipt = vi.fn();
    const onSendFailure = vi.fn();

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "telegram",
      to: "chat-1",
      payloads: [{ text: "hello" }],
      bestEffort: true,
      onCommitReceipt,
      onSendFailure,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        error,
        stage: "platform_send",
        payloadOutcomes: [
          expect.objectContaining({
            index: 0,
            status: "failed",
            error,
            stage: "platform_send",
          }),
        ],
      }),
    );
    expect(onCommitReceipt).not.toHaveBeenCalled();
    expect(onSendFailure).toHaveBeenCalledWith(error);
  });

  it("reports best-effort partial failures with the delivered receipt prefix", async () => {
    const error = new Error("second payload failed");
    deliverOutboundPayloads.mockImplementationOnce(async (params: DeliveryIntentCallbackParams) => {
      params.onPayloadDeliveryOutcome?.({
        index: 0,
        status: "sent",
        results: [{ channel: "telegram", messageId: "msg-1" }],
      });
      params.onPayloadDeliveryOutcome?.({
        index: 1,
        status: "failed",
        error,
        sentBeforeError: true,
        stage: "platform_send",
      });
      return [{ channel: "telegram", messageId: "msg-1" }];
    });
    const onSendFailure = vi.fn();

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "telegram",
      to: "chat-1",
      payloads: [{ text: "first" }, { text: "second" }],
      onSendFailure,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "partial_failed",
        results: [{ channel: "telegram", messageId: "msg-1" }],
        receipt: expect.objectContaining({ platformMessageIds: ["msg-1"] }),
        error,
        sentBeforeError: true,
      }),
    );
    expect(onSendFailure).toHaveBeenCalledWith(error);
  });

  it("maps thrown outbound partial delivery errors to partial_failed", async () => {
    const cause = new Error("network reset");
    const error = new OutboundDeliveryError("network reset", {
      cause,
      results: [{ channel: "telegram", messageId: "msg-1" }],
      payloadOutcomes: [
        {
          index: 0,
          status: "sent",
          results: [{ channel: "telegram", messageId: "msg-1" }],
        },
        {
          index: 1,
          status: "failed",
          error: cause,
          sentBeforeError: true,
          stage: "platform_send",
        },
      ],
      stage: "platform_send",
    });
    deliverOutboundPayloads.mockRejectedValueOnce(error);
    const onSendFailure = vi.fn();

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "telegram",
      to: "chat-1",
      payloads: [{ text: "first" }, { text: "second" }],
      onSendFailure,
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "partial_failed",
        results: [{ channel: "telegram", messageId: "msg-1" }],
        receipt: expect.objectContaining({ platformMessageIds: ["msg-1"] }),
        error,
        sentBeforeError: true,
      }),
    );
    expect(onSendFailure).toHaveBeenCalledWith(error);
  });

  it("runs the failure hook when send-context orchestration throws", async () => {
    const onSendFailure = vi.fn();
    const error = new Error("boom");

    await expect(
      withDurableMessageSendContext(
        {
          cfg,
          channel: "telegram",
          to: "chat-1",
          payloads: [{ text: "hello" }],
          onSendFailure,
        },
        async () => {
          throw error;
        },
      ),
    ).rejects.toThrow("boom");

    expect(onSendFailure).toHaveBeenCalledWith(error);
  });

  it("preserves orchestration errors when the failure hook throws", async () => {
    const onSendFailure = vi.fn(async () => {
      throw new Error("cleanup failed");
    });
    const error = new Error("boom");

    await expect(
      withDurableMessageSendContext(
        {
          cfg,
          channel: "telegram",
          to: "chat-1",
          payloads: [{ text: "hello" }],
          onSendFailure,
        },
        async () => {
          throw error;
        },
      ),
    ).rejects.toThrow("boom");

    expect(onSendFailure).toHaveBeenCalledWith(error);
  });

  it("runs the failure hook when durable outbound delivery fails", async () => {
    const error = new Error("send failed");
    deliverOutboundPayloads.mockRejectedValueOnce(error);
    const onSendFailure = vi.fn();

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "telegram",
      to: "chat-1",
      payloads: [{ text: "hello" }],
      onSendFailure,
    });

    expect(result).toEqual({ status: "failed", error });
    expect(onSendFailure).toHaveBeenCalledWith(error);
  });

  it("preserves failed send results when the failure hook throws", async () => {
    const error = new Error("send failed");
    deliverOutboundPayloads.mockRejectedValueOnce(error);
    const onSendFailure = vi.fn(async () => {
      throw new Error("cleanup failed");
    });

    const result = await sendDurableMessageBatch({
      cfg,
      channel: "telegram",
      to: "chat-1",
      payloads: [{ text: "hello" }],
      onSendFailure,
    });

    expect(result).toEqual({ status: "failed", error });
    expect(onSendFailure).toHaveBeenCalledWith(error);
  });
});
