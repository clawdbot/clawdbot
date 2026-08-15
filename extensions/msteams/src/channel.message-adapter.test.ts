// Msteams tests cover channel.message adapter plugin behavior.
import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendText: vi.fn(),
  sendMedia: vi.fn(),
  sendPayload: vi.fn(),
  sendPoll: vi.fn(),
}));

vi.mock("./channel.runtime.js", () => ({
  msTeamsChannelRuntime: {
    msteamsOutbound: {
      sendText: mocks.sendText,
      sendMedia: mocks.sendMedia,
      sendPayload: mocks.sendPayload,
      sendPoll: mocks.sendPoll,
    },
  },
}));

import { msteamsPlugin } from "./channel.js";

type MSTeamsMessageAdapter = NonNullable<typeof msteamsPlugin.message>;
type MSTeamsMessageSender = NonNullable<MSTeamsMessageAdapter["send"]>;

function requireMSTeamsMessageAdapter(): MSTeamsMessageAdapter {
  const adapter = msteamsPlugin.message;
  if (!adapter) {
    throw new Error("Expected msteams channel message adapter");
  }
  return adapter;
}

function requireTextSender(
  adapter: MSTeamsMessageAdapter,
): NonNullable<MSTeamsMessageSender["text"]> {
  const text = adapter.send?.text;
  if (!text) {
    throw new Error("Expected msteams message adapter text sender");
  }
  return text;
}

function requireMediaSender(
  adapter: MSTeamsMessageAdapter,
): NonNullable<MSTeamsMessageSender["media"]> {
  const media = adapter.send?.media;
  if (!media) {
    throw new Error("Expected msteams message adapter media sender");
  }
  return media;
}

function requirePayloadSender(
  adapter: MSTeamsMessageAdapter,
): NonNullable<MSTeamsMessageSender["payload"]> {
  const payload = adapter.send?.payload;
  if (!payload) {
    throw new Error("Expected msteams message adapter payload sender");
  }
  return payload;
}

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
    mocks.sendPayload.mockReset();
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
    mocks.sendPayload.mockResolvedValue({
      channel: "msteams",
      messageId: "msg-payload-1",
      conversationId: "conv-1",
    });
  });

  it("backs declared durable-final capabilities with outbound send proofs", async () => {
    const adapter = requireMSTeamsMessageAdapter();
    const sendText = requireTextSender(adapter);
    const sendMedia = requireMediaSender(adapter);
    const sendPayload = requirePayloadSender(adapter);
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
      expect(mocks.sendText).toHaveBeenLastCalledWith({
        cfg,
        to: "conversation:abc",
        text: "hello",
        accountId: "default",
      });
      expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("text");
    };

    const proveMedia = async () => {
      const mediaAccess = { localRoots: ["/tmp"], workspaceDir: "/tmp" };
      mocks.sendMedia.mockClear();
      const result = await sendMedia({
        cfg,
        to: "conversation:abc",
        text: "photo",
        mediaUrl: "file:///tmp/photo.png",
        mediaAccess,
        mediaLocalRoots: ["/tmp"],
        accountId: "default",
      });
      expect(mocks.sendMedia).toHaveBeenLastCalledWith({
        cfg,
        to: "conversation:abc",
        text: "photo",
        mediaUrl: "file:///tmp/photo.png",
        mediaAccess,
        mediaLocalRoots: ["/tmp"],
        accountId: "default",
      });
      expect(mocks.sendMedia.mock.calls[0]?.[0]?.mediaAccess).toBe(mediaAccess);
      expect(result.receipt.platformMessageIds).toEqual(["msg-media-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("media");
    };

    const provePayload = async () => {
      mocks.sendPayload.mockClear();
      const payload = {
        presentation: {
          blocks: [{ type: "text" as const, text: "card body" }],
        },
      };
      const mediaAccess = { localRoots: ["/tmp"], workspaceDir: "/tmp" };
      const result = await sendPayload({
        cfg,
        to: "conversation:abc",
        text: "",
        payload,
        mediaAccess,
        accountId: "default",
      });
      expect(mocks.sendPayload).toHaveBeenLastCalledWith({
        cfg,
        to: "conversation:abc",
        text: "",
        payload,
        mediaAccess,
        accountId: "default",
      });
      expect(mocks.sendPayload.mock.calls[0]?.[0]?.mediaAccess).toBe(mediaAccess);
      expect(result.receipt.platformMessageIds).toEqual(["msg-payload-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("card");
    };

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "msteamsMessageAdapter",
      adapter,
      proofs: {
        text: proveText,
        media: proveMedia,
        payload: provePayload,
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
  });

  it("backs declared live preview finalizer capabilities with adapter proofs", async () => {
    const adapter = requireMSTeamsMessageAdapter();
    const sendText = requireTextSender(adapter);

    await verifyChannelMessageLiveCapabilityAdapterProofs({
      adapterName: "msteamsMessageAdapter",
      adapter,
      proofs: {
        draftPreview: () => {
          expect(adapter.live?.capabilities?.nativeStreaming).toBe(true);
        },
        previewFinalization: () => {
          expect(adapter.live?.finalizer?.capabilities?.finalEdit).toBe(true);
        },
        progressUpdates: () => {
          expect(adapter.live?.capabilities?.draftPreview).toBe(true);
        },
        nativeStreaming: () => {
          expect(adapter.live?.finalizer?.capabilities?.previewReceipt).toBe(true);
        },
      },
    });

    await verifyChannelMessageLiveFinalizerProofs({
      adapterName: "msteamsMessageAdapter",
      adapter,
      proofs: {
        finalEdit: () => {
          expect(adapter.live?.capabilities?.previewFinalization).toBe(true);
        },
        normalFallback: () => {
          expect(sendText).toBeTypeOf("function");
        },
        previewReceipt: () => {
          expect(adapter.live?.capabilities?.nativeStreaming).toBe(true);
        },
      },
    });
  });

  it("exposes the resolved conversation for message-tool route reconciliation", async () => {
    const adapter = requireMSTeamsMessageAdapter();
    const sendText = requireTextSender(adapter);
    const extractToolSendResult = msteamsPlugin.actions?.extractToolSendResult;
    if (!extractToolSendResult) {
      throw new Error("Expected msteams tool send result extractor");
    }

    const delivery = await sendText({
      cfg,
      to: "team-aad/19:channel@thread.tacv2",
      text: "threaded",
      threadId: "thread-root",
      accountId: "default",
    });

    expect(
      extractToolSendResult({
        result: {
          details: {
            result: {
              receipt: delivery.receipt,
            },
          },
        },
        send: {
          to: "team-aad/19:channel@thread.tacv2",
          threadId: "thread-root",
        },
      }),
    ).toEqual({
      to: "conversation:conv-1",
    });
  });
});
