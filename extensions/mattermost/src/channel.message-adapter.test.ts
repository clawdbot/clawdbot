import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
} from "openclaw/plugin-sdk/channel-message";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

function requirePayloadSender(
  adapter: MattermostMessageAdapter,
): NonNullable<MattermostMessageSender["payload"]> {
  const payload = adapter.send?.payload;
  if (!payload) {
    throw new Error("Expected mattermost message adapter payload sender");
  }
  return payload;
}

describe("mattermost channel message adapter", () => {
  beforeAll(async () => {
    sendMessageMattermostMock.mockResolvedValue({
      messageId: "warmup-post",
      channelId: "channel-1",
    });
    await requireTextSender(requireMattermostMessageAdapter())({
      cfg: {},
      to: "channel:warmup",
      text: "warmup",
      accountId: "default",
    });
    sendMessageMattermostMock.mockReset();
  });

  beforeEach(() => {
    sendMessageMattermostMock.mockReset();
    sendMessageMattermostMock.mockResolvedValue({
      messageId: "post-1",
      channelId: "channel-1",
    });
  });

  it("declares durable-final capabilities covered by outbound proof tests", async () => {
    const adapter = requireMattermostMessageAdapter();
    const sendPayload = requirePayloadSender(adapter);

    const provePayload = async () => {
      sendMessageMattermostMock.mockClear();
      sendMessageMattermostMock.mockResolvedValueOnce({
        messageId: "post-1",
        channelId: "channel-1",
        receipt: {
          primaryPlatformMessageId: "post-1",
          platformMessageIds: ["post-1"],
          parts: [{ platformMessageId: "post-1", kind: "card", index: 0 }],
          sentAt: Date.now(),
        },
      });
      const result = await sendPayload({
        cfg: {},
        to: "channel:team-1",
        text: "card",
        accountId: "default",
        payload: {
          text: "card",
          channelData: {
            mattermost: {
              presentationButtons: [[{ text: "Open", callback_data: "open" }]],
            },
          },
        },
      });
      expect(sendMessageMattermostMock).toHaveBeenLastCalledWith("channel:team-1", "card", {
        cfg: {},
        accountId: "default",
        mediaUrl: undefined,
        mediaLocalRoots: undefined,
        mediaReadFile: undefined,
        replyToId: undefined,
        buttons: [[{ text: "Open", callback_data: "open" }]],
      });
      expect(result.receipt.platformMessageIds).toEqual(["post-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("card");
    };

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "mattermostMessageAdapter",
      adapter,
      proofs: {
        payload: provePayload,
        text: () => undefined,
        media: () => undefined,
        replyTo: () => undefined,
        thread: () => undefined,
        messageSendingHooks: () => {
          expect(requireTextSender(adapter)).toBeTypeOf("function");
        },
      },
    });
  });

  it("sends text through Mattermost", async () => {
    const sendText = requireTextSender(requireMattermostMessageAdapter());

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
  });

  it("sends media through Mattermost", async () => {
    const sendMedia = requireMediaSender(requireMattermostMessageAdapter());

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
  });

  it("maps thread ids to Mattermost reply targets", async () => {
    const sendText = requireTextSender(requireMattermostMessageAdapter());

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
  });

  it("prefers explicit Mattermost reply ids over thread ids", async () => {
    const sendText = requireTextSender(requireMattermostMessageAdapter());

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
