import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
} from "openclaw/plugin-sdk/channel-message";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendMedia: vi.fn(),
  sendPoll: vi.fn(),
}));

vi.mock("./channel.runtime.js", () => ({
  msTeamsChannelRuntime: {
    msteamsOutbound: {
      sendText: mocks.sendText,
      sendMedia: mocks.sendMedia,
      sendPoll: mocks.sendPoll,
    },
  },
}));

import { msteamsPlugin } from "./channel.js";

const cfg = {
  channels: {
    msteams: {
      appId: "resolved-app-id",
    },
  },
} as OpenClawConfig;

describe("msteams channel message adapter", () => {
  beforeEach(() => {
    mocks.sendText.mockReset();
    mocks.sendMedia.mockReset();
    mocks.sendPoll.mockReset();
    mocks.sendText.mockResolvedValue({
      channel: "msteams",
      messageId: "msg-1",
      conversationId: "conv-1",
    });
    mocks.sendMedia.mockResolvedValue({
      channel: "msteams",
      messageId: "msg-media-1",
      conversationId: "conv-1",
    });
  });

  it("backs declared durable-final capabilities with outbound send proofs", async () => {
    const adapter = msteamsPlugin.message;
    if (!adapter?.send?.text || !adapter.send.media) {
      throw new Error("expected msteams channel message adapter with text and media senders");
    }
    const sendText = adapter.send.text;
    const sendMedia = adapter.send.media;
    expect(adapter.durableFinal?.capabilities?.replyTo).toBeUndefined();
    expect(adapter.durableFinal?.capabilities?.thread).toBeUndefined();

    const proveText = async () => {
      mocks.sendText.mockClear();
      const result = await sendText({
        cfg,
        to: "conversation:abc",
        text: "hello",
        accountId: "default",
      });
      expect(mocks.sendText).toHaveBeenLastCalledWith(
        expect.objectContaining({
          cfg,
          to: "conversation:abc",
          text: "hello",
          accountId: "default",
        }),
      );
      expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("text");
    };

    const proveMedia = async () => {
      mocks.sendMedia.mockClear();
      const result = await sendMedia({
        cfg,
        to: "conversation:abc",
        text: "photo",
        mediaUrl: "file:///tmp/photo.png",
        mediaLocalRoots: ["/tmp"],
        accountId: "default",
      });
      expect(mocks.sendMedia).toHaveBeenLastCalledWith(
        expect.objectContaining({
          cfg,
          to: "conversation:abc",
          text: "photo",
          mediaUrl: "file:///tmp/photo.png",
          mediaLocalRoots: ["/tmp"],
        }),
      );
      expect(result.receipt.platformMessageIds).toEqual(["msg-media-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("media");
    };

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "msteamsMessageAdapter",
      adapter,
      proofs: {
        text: proveText,
        media: proveMedia,
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
  });

  it("backs declared live preview finalizer capabilities with adapter proofs", async () => {
    const adapter = msteamsPlugin.message;

    await verifyChannelMessageLiveCapabilityAdapterProofs({
      adapterName: "msteamsMessageAdapter",
      adapter: adapter!,
      proofs: {
        draftPreview: () => {
          expect(adapter!.live?.capabilities?.nativeStreaming).toBe(true);
        },
        previewFinalization: () => {
          expect(adapter!.live?.finalizer?.capabilities?.finalEdit).toBe(true);
        },
        progressUpdates: () => {
          expect(adapter!.live?.capabilities?.draftPreview).toBe(true);
        },
        nativeStreaming: () => {
          expect(adapter!.live?.finalizer?.capabilities?.previewReceipt).toBe(true);
        },
      },
    });

    await verifyChannelMessageLiveFinalizerProofs({
      adapterName: "msteamsMessageAdapter",
      adapter: adapter!,
      proofs: {
        finalEdit: () => {
          expect(adapter!.live?.capabilities?.previewFinalization).toBe(true);
        },
        normalFallback: () => {
          expect(adapter!.send!.text).toBeTypeOf("function");
        },
        previewReceipt: () => {
          expect(adapter!.live?.capabilities?.nativeStreaming).toBe(true);
        },
      },
    });
  });
});
