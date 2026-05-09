import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
} from "openclaw/plugin-sdk/channel-message";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendMessageMatrix: vi.fn(),
}));

vi.mock("./matrix/send.js", () => ({
  sendMessageMatrix: mocks.sendMessageMatrix,
  sendPollMatrix: vi.fn(),
  sendTypingMatrix: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getMatrixRuntime: () => ({
    channel: {
      text: {
        chunkMarkdownText: (text: string) => [text],
      },
    },
  }),
}));

import { matrixPlugin } from "./channel.js";

const cfg = {
  channels: {
    matrix: {
      accessToken: "resolved-token",
    },
  },
} as OpenClawConfig;

describe("matrix channel message adapter", () => {
  beforeEach(() => {
    mocks.sendMessageMatrix.mockReset();
    mocks.sendMessageMatrix.mockResolvedValue({ messageId: "$event-1", roomId: "!room:example" });
  });

  it("backs declared durable-final capabilities with runtime outbound proofs", async () => {
    const adapter = matrixPlugin.message;
    expect(adapter).toBeDefined();
    if (!adapter?.send?.text || !adapter.send.media) {
      throw new Error("Expected Matrix message adapter send capabilities.");
    }
    const sendText = adapter.send.text;
    const sendMedia = adapter.send.media;

    const proveText = async () => {
      mocks.sendMessageMatrix.mockClear();
      const result = await sendText({
        cfg,
        to: "room:!room:example",
        text: "hello",
        accountId: "default",
      });
      expect(mocks.sendMessageMatrix).toHaveBeenLastCalledWith(
        "room:!room:example",
        "hello",
        expect.objectContaining({ cfg, accountId: "default" }),
      );
      expect(result.receipt.platformMessageIds).toEqual(["$event-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("text");
    };

    const proveMedia = async () => {
      mocks.sendMessageMatrix.mockClear();
      const result = await sendMedia({
        cfg,
        to: "room:!room:example",
        text: "caption",
        mediaUrl: "file:///tmp/cat.png",
        mediaLocalRoots: ["/tmp/openclaw"],
        accountId: "default",
        audioAsVoice: true,
      });
      expect(mocks.sendMessageMatrix).toHaveBeenLastCalledWith(
        "room:!room:example",
        "caption",
        expect.objectContaining({
          cfg,
          mediaUrl: "file:///tmp/cat.png",
          mediaLocalRoots: ["/tmp/openclaw"],
          audioAsVoice: true,
        }),
      );
      expect(result.receipt.parts[0]?.kind).toBe("voice");
    };

    const proveReplyThread = async () => {
      mocks.sendMessageMatrix.mockClear();
      const result = await sendText({
        cfg,
        to: "room:!room:example",
        text: "threaded",
        accountId: "default",
        replyToId: "$reply",
        threadId: "$thread",
      });
      expect(mocks.sendMessageMatrix).toHaveBeenLastCalledWith(
        "room:!room:example",
        "threaded",
        expect.objectContaining({
          cfg,
          replyToId: "$reply",
          threadId: "$thread",
        }),
      );
      expect(result.receipt.replyToId).toBe("$reply");
      expect(result.receipt.threadId).toBe("$thread");
    };

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "matrixMessageAdapter",
      adapter,
      proofs: {
        text: proveText,
        media: proveMedia,
        replyTo: proveReplyThread,
        thread: proveReplyThread,
        messageSendingHooks: () => {
          expect(adapter.send?.text).toBeTypeOf("function");
        },
      },
    });
  });

  it("backs declared live preview finalizer capabilities with adapter proofs", async () => {
    const adapter = matrixPlugin.message;

    await verifyChannelMessageLiveCapabilityAdapterProofs({
      adapterName: "matrixMessageAdapter",
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
        quietFinalization: () => {
          expect(adapter!.live?.finalizer?.capabilities?.previewReceipt).toBe(true);
        },
      },
    });

    await verifyChannelMessageLiveFinalizerProofs({
      adapterName: "matrixMessageAdapter",
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
        previewReceipt: () => {
          expect(adapter!.live?.capabilities?.quietFinalization).toBe(true);
        },
      },
    });
  });
});
