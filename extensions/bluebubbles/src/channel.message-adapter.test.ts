import {
  createMessageReceiptFromOutboundResults,
  verifyChannelMessageAdapterCapabilityProofs,
} from "openclaw/plugin-sdk/channel-message";
import { afterAll, describe, expect, it, vi } from "vitest";
import { bluebubblesPlugin } from "./channel.js";

const sendMessageBlueBubblesMock = vi.hoisted(() => vi.fn());
const sendBlueBubblesMediaMock = vi.hoisted(() => vi.fn());
const resolveBlueBubblesMessageIdMock = vi.hoisted(() => vi.fn());

vi.mock("./channel.runtime.js", () => ({
  blueBubblesChannelRuntime: {
    sendMessageBlueBubbles: sendMessageBlueBubblesMock,
    sendBlueBubblesMedia: sendBlueBubblesMediaMock,
    resolveBlueBubblesMessageId: resolveBlueBubblesMessageIdMock,
  },
}));

afterAll(() => {
  vi.doUnmock("./channel.runtime.js");
  vi.resetModules();
});

describe("bluebubbles message adapter", () => {
  it("declares durable text, media, and reply target capabilities with receipt proofs", async () => {
    sendMessageBlueBubblesMock.mockImplementation(
      async (_to: string, _text: string, opts: { replyToMessageGuid?: string } = {}) => ({
        messageId: opts.replyToMessageGuid ? "bb-reply-1" : "bb-text-1",
        receipt: createMessageReceiptFromOutboundResults({
          results: [
            {
              channel: "bluebubbles",
              messageId: opts.replyToMessageGuid ? "bb-reply-1" : "bb-text-1",
            },
          ],
          kind: "text",
          ...(opts.replyToMessageGuid ? { replyToId: opts.replyToMessageGuid } : {}),
        }),
      }),
    );
    sendBlueBubblesMediaMock.mockResolvedValue({
      messageId: "bb-media-1",
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "bluebubbles", messageId: "bb-media-1" }],
        kind: "media",
      }),
    });
    resolveBlueBubblesMessageIdMock.mockReturnValue("guid-reply-1");

    await expect(
      verifyChannelMessageAdapterCapabilityProofs({
        adapterName: "bluebubbles",
        adapter: bluebubblesPlugin.message!,
        proofs: {
          text: async () => {
            const result = await bluebubblesPlugin.message?.send?.text?.({
              cfg: {},
              to: "+15551234567",
              text: "hello",
            });
            expect(sendMessageBlueBubblesMock).toHaveBeenCalledWith("+15551234567", "hello", {
              cfg: {},
              accountId: undefined,
              replyToMessageGuid: undefined,
            });
            expect(result?.receipt.platformMessageIds).toEqual(["bb-text-1"]);
          },
          media: async () => {
            const result = await bluebubblesPlugin.message?.send?.media?.({
              cfg: {},
              to: "+15551234567",
              text: "image",
              mediaUrl: "https://example.com/image.png",
            });
            expect(sendBlueBubblesMediaMock).toHaveBeenCalledWith(
              expect.objectContaining({
                to: "+15551234567",
                mediaUrl: "https://example.com/image.png",
                caption: "image",
              }),
            );
            expect(result?.receipt.platformMessageIds).toEqual(["bb-media-1"]);
          },
          replyTo: async () => {
            const result = await bluebubblesPlugin.message?.send?.text?.({
              cfg: {},
              to: "chat_guid:chat-1",
              text: "reply",
              replyToId: "short-1",
            });
            expect(resolveBlueBubblesMessageIdMock).toHaveBeenCalledWith(
              "short-1",
              expect.objectContaining({ requireKnownShortId: true }),
            );
            expect(sendMessageBlueBubblesMock).toHaveBeenCalledWith("chat_guid:chat-1", "reply", {
              cfg: {},
              accountId: undefined,
              replyToMessageGuid: "guid-reply-1",
            });
            expect(result?.receipt.replyToId).toBe("guid-reply-1");
          },
          messageSendingHooks: async () => {
            const beforeSendAttempt = vi.fn(() => "pending-1");
            const afterSendFailure = vi.fn();
            const ctx = {
              cfg: {},
              kind: "text" as const,
              to: "+15551234567",
              text: "hello",
              deps: {
                bluebubblesMessageLifecycle: {
                  beforeSendAttempt,
                  afterSendFailure,
                },
              },
            };
            const attemptToken =
              await bluebubblesPlugin.message?.send?.lifecycle?.beforeSendAttempt?.(ctx);
            await bluebubblesPlugin.message?.send?.lifecycle?.afterSendFailure?.({
              ...ctx,
              error: new Error("send failed"),
              attemptToken,
            });
            expect(beforeSendAttempt).toHaveBeenCalledWith(ctx);
            expect(afterSendFailure).toHaveBeenCalledWith(
              expect.objectContaining({
                kind: "text",
                attemptToken: "pending-1",
                error: expect.any(Error),
              }),
            );
          },
          afterSendSuccess: async () => {
            const beforeSendAttempt = vi.fn(() => "pending-1");
            const afterSendSuccess = vi.fn();
            const ctx = {
              cfg: {},
              kind: "text" as const,
              to: "+15551234567",
              text: "hello",
              deps: {
                bluebubblesMessageLifecycle: {
                  beforeSendAttempt,
                  afterSendSuccess,
                },
              },
            };
            const attemptToken =
              await bluebubblesPlugin.message?.send?.lifecycle?.beforeSendAttempt?.(ctx);
            await bluebubblesPlugin.message?.send?.lifecycle?.afterSendSuccess?.({
              ...ctx,
              result: {
                messageId: "bb-text-1",
                receipt: createMessageReceiptFromOutboundResults({
                  results: [{ channel: "bluebubbles", messageId: "bb-text-1" }],
                  kind: "text",
                }),
              },
              attemptToken,
            });
            expect(beforeSendAttempt).toHaveBeenCalledWith(ctx);
            expect(afterSendSuccess).toHaveBeenCalledWith(
              expect.objectContaining({
                kind: "text",
                attemptToken: "pending-1",
                result: expect.objectContaining({ messageId: "bb-text-1" }),
              }),
            );
          },
        },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { capability: "text", status: "verified" },
        { capability: "media", status: "verified" },
        { capability: "replyTo", status: "verified" },
        { capability: "messageSendingHooks", status: "verified" },
        { capability: "afterSendSuccess", status: "verified" },
      ]),
    );
  });
});
