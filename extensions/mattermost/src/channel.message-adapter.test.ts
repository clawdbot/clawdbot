import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
} from "openclaw/plugin-sdk/channel-message";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMessageMattermostMock = vi.hoisted(() => vi.fn());

vi.mock("./mattermost/send.js", () => ({
  sendMessageMattermost: sendMessageMattermostMock,
}));

import { mattermostPlugin } from "./channel.js";

type MattermostMessageAdapter = NonNullable<typeof mattermostPlugin.message>;
type MattermostMessageSender = NonNullable<MattermostMessageAdapter["send"]>;

function requireMattermostMessageAdapter(): MattermostMessageAdapter {
  const adapter = mattermostPlugin.message;
  if (!adapter) {
    throw new Error("Expected mattermost plugin to expose a channel message adapter");
  }
  return adapter;
}

function requireTextSender(
  adapter: MattermostMessageAdapter,
): NonNullable<MattermostMessageSender["text"]> {
  const text = adapter.send?.text;
  if (!text) {
    throw new Error("Expected mattermost message adapter text sender");
  }
  return text;
}

function requireMediaSender(
  adapter: MattermostMessageAdapter,
): NonNullable<MattermostMessageSender["media"]> {
  const media = adapter.send?.media;
  if (!media) {
    throw new Error("Expected mattermost message adapter media sender");
  }
  return media;
}

describe("mattermost channel message adapter", () => {
  beforeEach(() => {
    sendMessageMattermostMock.mockReset();
    sendMessageMattermostMock.mockResolvedValue({
      messageId: "post-1",
      channelId: "channel-1",
    });
  });

  it("backs declared durable-final capabilities with outbound send proofs", async () => {
    const adapter = requireMattermostMessageAdapter();
    const sendText = requireTextSender(adapter);
    const sendMedia = requireMediaSender(adapter);

    const proveText = async () => {
      sendMessageMattermostMock.mockClear();
      const result = await sendText({
        cfg: {},
        to: "channel:team-1",
        text: "hello",
        accountId: "default",
      });
      expect(sendMessageMattermostMock).toHaveBeenLastCalledWith("channel:team-1", "hello", {
        cfg: {},
        accountId: "default",
        replyToId: undefined,
      });
      expect(result.receipt.platformMessageIds).toEqual(["post-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("text");
    };

    const proveMedia = async () => {
      sendMessageMattermostMock.mockClear();
      const result = await sendMedia({
        cfg: {},
        to: "channel:team-1",
        text: "caption",
        mediaUrl: "https://example.com/a.png",
        mediaLocalRoots: ["/tmp/media"],
        accountId: "default",
      });
      expect(sendMessageMattermostMock).toHaveBeenLastCalledWith("channel:team-1", "caption", {
        cfg: {},
        accountId: "default",
        mediaUrl: "https://example.com/a.png",
        mediaLocalRoots: ["/tmp/media"],
        replyToId: undefined,
      });
      expect(result.receipt.parts[0]?.kind).toBe("media");
    };

    const proveReplyThread = async () => {
      sendMessageMattermostMock.mockClear();
      const result = await sendText({
        cfg: {},
        to: "channel:parent-1",
        text: "threaded",
        accountId: "default",
        threadId: "thread-1",
      });
      expect(sendMessageMattermostMock).toHaveBeenLastCalledWith("channel:parent-1", "threaded", {
        cfg: {},
        accountId: "default",
        replyToId: "thread-1",
      });
      expect(result.receipt.threadId).toBe("thread-1");
    };

    const proveExplicitReply = async () => {
      sendMessageMattermostMock.mockClear();
      const result = await sendText({
        cfg: {},
        to: "channel:parent-1",
        text: "reply",
        accountId: "default",
        replyToId: "post-parent-1",
        threadId: "thread-1",
      });
      expect(sendMessageMattermostMock).toHaveBeenLastCalledWith("channel:parent-1", "reply", {
        cfg: {},
        accountId: "default",
        replyToId: "post-parent-1",
      });
      expect(result.receipt.replyToId).toBe("post-parent-1");
    };

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "mattermostMessageAdapter",
      adapter,
      proofs: {
        text: proveText,
        media: proveMedia,
        replyTo: proveExplicitReply,
        thread: proveReplyThread,
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
  });

  it("backs declared live preview finalizer capabilities with adapter proofs", async () => {
    const adapter = requireMattermostMessageAdapter();
    const sendText = requireTextSender(adapter);

    await verifyChannelMessageLiveCapabilityAdapterProofs({
      adapterName: "mattermostMessageAdapter",
      adapter,
      proofs: {
        draftPreview: () => {
          expect(adapter.live?.finalizer?.capabilities?.discardPending).toBe(true);
        },
        previewFinalization: () => {
          expect(adapter.live?.finalizer?.capabilities?.finalEdit).toBe(true);
        },
        progressUpdates: () => {
          expect(adapter.live?.capabilities?.draftPreview).toBe(true);
        },
      },
    });

    await verifyChannelMessageLiveFinalizerProofs({
      adapterName: "mattermostMessageAdapter",
      adapter,
      proofs: {
        finalEdit: () => {
          expect(adapter.live?.capabilities?.previewFinalization).toBe(true);
        },
        normalFallback: () => {
          expect(sendText).toBeTypeOf("function");
        },
        discardPending: () => {
          expect(adapter.live?.capabilities?.draftPreview).toBe(true);
        },
      },
    });
  });
});
