import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
} from "openclaw/plugin-sdk/channel-message";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageTelegramMock = vi.fn();

vi.mock("./send.js", () => ({
  sendMessageTelegram: (...args: unknown[]) => sendMessageTelegramMock(...args),
}));

import { telegramPlugin } from "./channel.js";

type TelegramMessageAdapter = NonNullable<typeof telegramPlugin.message>;

function requireTelegramMessageAdapter(): TelegramMessageAdapter {
  if (!telegramPlugin.message) {
    throw new Error("expected Telegram message adapter");
  }
  return telegramPlugin.message;
}

describe("telegram channel message adapter", () => {
  beforeEach(() => {
    sendMessageTelegramMock.mockReset();
  });

  it("backs declared durable-final capabilities with native send proofs", async () => {
    const adapter = requireTelegramMessageAdapter();

    const proveText = async () => {
      sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-text", chatId: "12345" });
      const result = await adapter.send!.text!({
        cfg: {} as never,
        to: "12345",
        text: "hello",
        deps: { sendTelegram: sendMessageTelegramMock },
      });
      expect(sendMessageTelegramMock).toHaveBeenLastCalledWith("12345", "hello", {
        cfg: {},
        verbose: false,
        messageThreadId: undefined,
        replyToMessageId: undefined,
        accountId: undefined,
        silent: undefined,
        gatewayClientScopes: undefined,
      });
      expect(result.receipt.platformMessageIds).toEqual(["tg-text"]);
    };

    const proveMedia = async () => {
      sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-media", chatId: "12345" });
      const result = await adapter.send!.media!({
        cfg: {} as never,
        to: "12345",
        text: "caption",
        mediaUrl: "https://example.com/a.png",
        mediaLocalRoots: ["/tmp/media"],
        deps: { sendTelegram: sendMessageTelegramMock },
      });
      expect(sendMessageTelegramMock).toHaveBeenLastCalledWith("12345", "caption", {
        cfg: {},
        verbose: false,
        messageThreadId: undefined,
        replyToMessageId: undefined,
        accountId: undefined,
        silent: undefined,
        gatewayClientScopes: undefined,
        mediaUrl: "https://example.com/a.png",
        mediaLocalRoots: ["/tmp/media"],
        mediaReadFile: undefined,
        forceDocument: false,
      });
      expect(result.receipt.parts[0]?.kind).toBe("media");
    };

    const provePayload = async () => {
      sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-payload", chatId: "12345" });
      const result = await adapter.send!.payload!({
        cfg: {} as never,
        to: "12345",
        text: "payload",
        payload: { text: "payload" },
        deps: { sendTelegram: sendMessageTelegramMock },
      });
      expect(sendMessageTelegramMock).toHaveBeenLastCalledWith("12345", "payload", {
        cfg: {},
        verbose: false,
        messageThreadId: undefined,
        replyToMessageId: undefined,
        accountId: undefined,
        silent: undefined,
        gatewayClientScopes: undefined,
        mediaLocalRoots: undefined,
        mediaReadFile: undefined,
        forceDocument: false,
        quoteText: undefined,
        buttons: undefined,
      });
      expect(result.receipt.platformMessageIds).toEqual(["tg-payload"]);
    };

    const proveReplyThreadSilent = async () => {
      sendMessageTelegramMock.mockResolvedValueOnce({ messageId: "tg-thread", chatId: "12345" });
      await adapter.send!.text!({
        cfg: {} as never,
        to: "12345",
        text: "threaded",
        replyToId: "900",
        threadId: "12",
        silent: true,
        deps: { sendTelegram: sendMessageTelegramMock },
      });
      expect(sendMessageTelegramMock).toHaveBeenLastCalledWith("12345", "threaded", {
        cfg: {},
        verbose: false,
        messageThreadId: 12,
        replyToMessageId: 900,
        accountId: undefined,
        silent: true,
        gatewayClientScopes: undefined,
      });
    };

    const proveBatch = async () => {
      const startCallCount = sendMessageTelegramMock.mock.calls.length;
      sendMessageTelegramMock
        .mockResolvedValueOnce({ messageId: "tg-batch-1", chatId: "12345" })
        .mockResolvedValueOnce({ messageId: "tg-batch-2", chatId: "12345" });
      await adapter.send!.payload!({
        cfg: {} as never,
        to: "12345",
        text: "batch",
        payload: {
          text: "batch",
          mediaUrls: ["https://example.com/a.png", "https://example.com/b.png"],
        },
        deps: { sendTelegram: sendMessageTelegramMock },
      });
      const batchCalls = sendMessageTelegramMock.mock.calls.slice(startCallCount);
      expect(batchCalls[0]).toEqual([
        "12345",
        "batch",
        {
          cfg: {},
          verbose: false,
          messageThreadId: undefined,
          replyToMessageId: undefined,
          accountId: undefined,
          silent: undefined,
          gatewayClientScopes: undefined,
          mediaLocalRoots: undefined,
          mediaReadFile: undefined,
          forceDocument: false,
          quoteText: undefined,
          mediaUrl: "https://example.com/a.png",
          buttons: undefined,
        },
      ]);
      expect(batchCalls[1]).toEqual([
        "12345",
        "",
        {
          cfg: {},
          verbose: false,
          messageThreadId: undefined,
          replyToMessageId: undefined,
          accountId: undefined,
          silent: undefined,
          gatewayClientScopes: undefined,
          mediaLocalRoots: undefined,
          mediaReadFile: undefined,
          forceDocument: false,
          quoteText: undefined,
          mediaUrl: "https://example.com/b.png",
        },
      ]);
    };

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "telegramMessageAdapter",
      adapter,
      proofs: {
        text: proveText,
        media: proveMedia,
        payload: provePayload,
        silent: proveReplyThreadSilent,
        replyTo: proveReplyThreadSilent,
        thread: proveReplyThreadSilent,
        messageSendingHooks: () => {
          expect(adapter.send!.text).toBeTypeOf("function");
        },
        batch: proveBatch,
      },
    });
  });

  it("backs declared live capabilities with adapter proofs", async () => {
    const adapter = requireTelegramMessageAdapter();

    await verifyChannelMessageLiveCapabilityAdapterProofs({
      adapterName: "telegramMessageAdapter",
      adapter,
      proofs: {
        draftPreview: () => {
          expect(adapter.receive?.defaultAckPolicy).toBe("after_agent_dispatch");
        },
        previewFinalization: () => {
          expect(adapter.durableFinal?.capabilities?.text).toBe(true);
        },
        progressUpdates: () => {
          expect(adapter.live?.capabilities?.draftPreview).toBe(true);
        },
      },
    });
  });

  it("backs declared live preview finalizer capabilities with adapter proofs", async () => {
    const adapter = requireTelegramMessageAdapter();

    await verifyChannelMessageLiveFinalizerProofs({
      adapterName: "telegramMessageAdapter",
      adapter,
      proofs: {
        finalEdit: () => {
          expect(adapter.live?.capabilities?.previewFinalization).toBe(true);
        },
        normalFallback: () => {
          expect(adapter.durableFinal?.capabilities?.text).toBe(true);
        },
        previewReceipt: () => {
          expect(adapter.live?.finalizer?.capabilities?.previewReceipt).toBe(true);
        },
        retainOnAmbiguousFailure: () => {
          expect(adapter.live?.finalizer?.capabilities?.retainOnAmbiguousFailure).toBe(true);
        },
      },
    });
  });

  it("backs declared receive ack policies with adapter proofs", async () => {
    const adapter = requireTelegramMessageAdapter();

    await verifyChannelMessageReceiveAckPolicyAdapterProofs({
      adapterName: "telegramMessageAdapter",
      adapter,
      proofs: {
        after_receive_record: () => {
          expect(adapter.receive?.supportedAckPolicies).toContain("after_receive_record");
        },
        after_agent_dispatch: () => {
          expect(adapter.receive?.defaultAckPolicy).toBe("after_agent_dispatch");
        },
      },
    });
  });
});
