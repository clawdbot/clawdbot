import { verifyChannelMessageAdapterCapabilityProofs } from "openclaw/plugin-sdk/channel-message";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendMedia: vi.fn(),
}));

vi.mock("./channel.runtime.js", () => ({
  tlonRuntimeOutbound: {
    sendText: mocks.sendText,
    sendMedia: mocks.sendMedia,
  },
}));

import { tlonPlugin } from "./channel.js";

const cfg = {
  channels: {
    tlon: {
      ship: "~zod",
      url: "https://zod.example",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
} as OpenClawConfig;

describe("tlon channel message adapter", () => {
  beforeEach(() => {
    mocks.sendText.mockReset();
    mocks.sendMedia.mockReset();
    mocks.sendText.mockResolvedValue({
      channel: "tlon",
      messageId: "~zod/1700000000000",
      conversationId: "~nec/general",
    });
    mocks.sendMedia.mockResolvedValue({
      channel: "tlon",
      messageId: "~zod/1700000000001",
      conversationId: "~nec/general",
    });
  });

  it("backs declared durable-final capabilities with outbound send proofs", async () => {
    const adapter = tlonPlugin.message;
    if (!adapter?.send?.text || !adapter.send.media) {
      throw new Error("expected tlon channel message adapter with text and media senders");
    }
    const sendText = adapter.send.text;
    const sendMedia = adapter.send.media;

    const proveText = async () => {
      mocks.sendText.mockClear();
      const result = await sendText({
        cfg,
        to: "chat/~nec/general",
        text: "hello",
        accountId: "default",
      });
      expect(mocks.sendText).toHaveBeenLastCalledWith(
        expect.objectContaining({
          cfg,
          to: "chat/~nec/general",
          text: "hello",
          accountId: "default",
        }),
      );
      expect(result.receipt.platformMessageIds).toEqual(["~zod/1700000000000"]);
      expect(result.receipt.parts[0]?.kind).toBe("text");
    };

    const proveMedia = async () => {
      mocks.sendMedia.mockClear();
      const result = await sendMedia({
        cfg,
        to: "chat/~nec/general",
        text: "image",
        mediaUrl: "https://example.com/image.png",
        accountId: "default",
      });
      expect(mocks.sendMedia).toHaveBeenLastCalledWith(
        expect.objectContaining({
          cfg,
          to: "chat/~nec/general",
          text: "image",
          mediaUrl: "https://example.com/image.png",
          accountId: "default",
        }),
      );
      expect(result.receipt.platformMessageIds).toEqual(["~zod/1700000000001"]);
      expect(result.receipt.parts[0]?.kind).toBe("media");
    };

    const proveReplyThread = async () => {
      mocks.sendText.mockClear();
      const result = await adapter.send!.text!({
        cfg,
        to: "chat/~nec/general",
        text: "threaded",
        accountId: "default",
        replyToId: "1700000000000",
        threadId: "1700000000000",
      });
      expect(mocks.sendText).toHaveBeenLastCalledWith(
        expect.objectContaining({
          replyToId: "1700000000000",
          threadId: "1700000000000",
        }),
      );
      expect(result.receipt.replyToId).toBe("1700000000000");
      expect(result.receipt.threadId).toBe("1700000000000");
    };

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "tlonMessageAdapter",
      adapter: adapter,
      proofs: {
        text: proveText,
        media: proveMedia,
        replyTo: proveReplyThread,
        thread: proveReplyThread,
        messageSendingHooks: () => {
          expect(adapter.send!.text).toBeTypeOf("function");
        },
      },
    });
  });
});
