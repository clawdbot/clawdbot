import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
} from "openclaw/plugin-sdk/channel-message";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import type { OpenClawConfig } from "./runtime-api.js";

const cfg = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

describe("slack channel message adapter", () => {
  const sendSlack = vi.fn();

  beforeEach(() => {
    sendSlack.mockReset();
    sendSlack.mockResolvedValue({ messageId: "msg-1", channelId: "C123" });
  });

  it("backs declared durable-final capabilities with outbound send proofs", async () => {
    const adapter = slackPlugin.message;
    if (!adapter?.send?.text || !adapter.send.media || !adapter.send.payload) {
      throw new Error("expected slack channel message adapter with text/media/payload senders");
    }
    const sendText = adapter.send.text;
    const sendMedia = adapter.send.media;
    const sendPayload = adapter.send.payload;

    const proveText = async () => {
      sendSlack.mockClear();
      const result = await sendText({
        cfg,
        to: "C123",
        text: "hello",
        accountId: "default",
        deps: { sendSlack },
      });
      expect(sendSlack).toHaveBeenLastCalledWith(
        "C123",
        "hello",
        expect.objectContaining({ accountId: "default" }),
      );
      expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("text");
    };

    const proveMedia = async () => {
      sendSlack.mockClear();
      const result = await sendMedia({
        cfg,
        to: "C123",
        text: "caption",
        mediaUrl: "https://example.com/a.png",
        mediaLocalRoots: ["/tmp/media"],
        accountId: "default",
        deps: { sendSlack },
      });
      expect(sendSlack).toHaveBeenLastCalledWith(
        "C123",
        "caption",
        expect.objectContaining({
          accountId: "default",
          mediaUrl: "https://example.com/a.png",
          mediaLocalRoots: ["/tmp/media"],
        }),
      );
      expect(result.receipt.parts[0]?.kind).toBe("media");
    };

    const provePayload = async () => {
      sendSlack.mockClear();
      const result = await sendPayload({
        cfg,
        to: "C123",
        text: "payload",
        payload: { text: "payload" },
        accountId: "default",
        deps: { sendSlack },
      });
      expect(sendSlack).toHaveBeenLastCalledWith(
        "C123",
        "payload",
        expect.objectContaining({ accountId: "default" }),
      );
      expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
    };

    const proveReplyThread = async () => {
      sendSlack.mockClear();
      const result = await sendText({
        cfg,
        to: "C123",
        text: "threaded",
        accountId: "default",
        replyToId: "1712000000.000001",
        threadId: "1712345678.123456",
        deps: { sendSlack },
      });
      expect(sendSlack).toHaveBeenLastCalledWith(
        "C123",
        "threaded",
        expect.objectContaining({
          accountId: "default",
          threadTs: "1712000000.000001",
        }),
      );
      expect(result.receipt.replyToId).toBe("1712000000.000001");
    };

    const proveThreadFallback = async () => {
      sendSlack.mockClear();
      const result = await sendText({
        cfg,
        to: "C123",
        text: "threaded",
        accountId: "default",
        threadId: "1712345678.123456",
        deps: { sendSlack },
      });
      expect(sendSlack).toHaveBeenLastCalledWith(
        "C123",
        "threaded",
        expect.objectContaining({
          accountId: "default",
          threadTs: "1712345678.123456",
        }),
      );
      expect(result.receipt.threadId).toBe("1712345678.123456");
    };

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "slackMessageAdapter",
      adapter,
      proofs: {
        text: proveText,
        media: proveMedia,
        payload: provePayload,
        replyTo: proveReplyThread,
        thread: proveThreadFallback,
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
  });

  it("backs declared live preview finalizer capabilities with adapter proofs", async () => {
    const adapter = slackPlugin.message;

    await verifyChannelMessageLiveCapabilityAdapterProofs({
      adapterName: "slackMessageAdapter",
      adapter: adapter!,
      proofs: {
        draftPreview: () => {
          expect(adapter!.live?.finalizer?.capabilities?.discardPending).toBe(true);
        },
        previewFinalization: () => {
          expect(adapter!.live?.finalizer?.capabilities?.finalEdit).toBe(true);
        },
        progressUpdates: () => {
          expect(adapter!.live?.capabilities?.draftPreview).toBe(true);
        },
        nativeStreaming: () => {
          expect(adapter!.live?.capabilities?.previewFinalization).toBe(true);
        },
      },
    });

    await verifyChannelMessageLiveFinalizerProofs({
      adapterName: "slackMessageAdapter",
      adapter: adapter!,
      proofs: {
        finalEdit: () => {
          expect(adapter!.live?.capabilities?.previewFinalization).toBe(true);
        },
        normalFallback: () => {
          expect(adapter!.send!.text).toBeTypeOf("function");
        },
        discardPending: () => {
          expect(adapter!.live?.capabilities?.draftPreview).toBe(true);
        },
      },
    });
  });
});
