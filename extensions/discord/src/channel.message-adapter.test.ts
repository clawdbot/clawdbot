import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
} from "openclaw/plugin-sdk/channel-message";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDiscordOutboundHoisted,
  installDiscordOutboundModuleSpies,
  resetDiscordOutboundMocks,
} from "./outbound-adapter.test-harness.js";

const hoisted = createDiscordOutboundHoisted();
await installDiscordOutboundModuleSpies(hoisted);

let discordPlugin: typeof import("./channel.js").discordPlugin;

beforeAll(async () => {
  ({ discordPlugin } = await import("./channel.js"));
});

type DiscordMessageAdapter = NonNullable<typeof discordPlugin.message>;
type DiscordMessageSender = NonNullable<DiscordMessageAdapter["send"]>;

function requireDiscordMessageAdapter(): DiscordMessageAdapter {
  const adapter = discordPlugin.message;
  if (!adapter) {
    throw new Error("Expected discord plugin to expose a channel message adapter");
  }
  return adapter;
}

function requireTextSender(
  adapter: DiscordMessageAdapter,
): NonNullable<DiscordMessageSender["text"]> {
  const text = adapter.send?.text;
  if (!text) {
    throw new Error("Expected discord message adapter text sender");
  }
  return text;
}

function requireMediaSender(
  adapter: DiscordMessageAdapter,
): NonNullable<DiscordMessageSender["media"]> {
  const media = adapter.send?.media;
  if (!media) {
    throw new Error("Expected discord message adapter media sender");
  }
  return media;
}

function requirePayloadSender(
  adapter: DiscordMessageAdapter,
): NonNullable<DiscordMessageSender["payload"]> {
  const payload = adapter.send?.payload;
  if (!payload) {
    throw new Error("Expected discord message adapter payload sender");
  }
  return payload;
}

describe("discord channel message adapter", () => {
  beforeEach(() => {
    resetDiscordOutboundMocks(hoisted);
  });

  it("backs declared durable-final capabilities with outbound send proofs", async () => {
    const adapter = requireDiscordMessageAdapter();
    const sendText = requireTextSender(adapter);
    const sendMedia = requireMediaSender(adapter);
    const sendPayload = requirePayloadSender(adapter);

    const proveText = async () => {
      resetDiscordOutboundMocks(hoisted);
      const result = await sendText({
        cfg: {},
        to: "channel:123456",
        text: "hello",
        accountId: "default",
      });
      expect(hoisted.sendMessageDiscordMock).toHaveBeenLastCalledWith("channel:123456", "hello", {
        verbose: false,
        replyTo: undefined,
        accountId: "default",
        silent: undefined,
        cfg: {},
        textLimit: undefined,
        maxLinesPerMessage: undefined,
        tableMode: undefined,
        chunkMode: undefined,
      });
      expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("text");
    };

    const proveMedia = async () => {
      resetDiscordOutboundMocks(hoisted);
      const result = await sendMedia({
        cfg: {},
        to: "channel:123456",
        text: "caption",
        mediaUrl: "https://example.com/a.png",
        accountId: "default",
      });
      expect(hoisted.sendMessageDiscordMock).toHaveBeenLastCalledWith("channel:123456", "caption", {
        verbose: false,
        mediaUrl: "https://example.com/a.png",
        mediaAccess: undefined,
        mediaLocalRoots: undefined,
        mediaReadFile: undefined,
        replyTo: undefined,
        accountId: "default",
        silent: undefined,
        cfg: {},
        textLimit: undefined,
        maxLinesPerMessage: undefined,
        tableMode: undefined,
        chunkMode: undefined,
      });
      expect(result.receipt.parts[0]?.kind).toBe("media");
    };

    const provePayload = async () => {
      resetDiscordOutboundMocks(hoisted);
      const result = await sendPayload({
        cfg: {},
        to: "channel:123456",
        text: "payload",
        payload: { text: "payload" },
        accountId: "default",
      });
      expect(hoisted.sendMessageDiscordMock).toHaveBeenLastCalledWith("channel:123456", "payload", {
        verbose: false,
        replyTo: undefined,
        accountId: "default",
        silent: undefined,
        cfg: {},
        textLimit: undefined,
        maxLinesPerMessage: undefined,
        tableMode: undefined,
        chunkMode: undefined,
      });
      expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
    };

    const proveReplyThreadSilent = async () => {
      resetDiscordOutboundMocks(hoisted);
      const result = await sendText({
        cfg: {},
        to: "channel:parent-1",
        text: "threaded",
        accountId: "default",
        replyToId: "reply-1",
        threadId: "thread-1",
        silent: true,
      });
      expect(hoisted.sendMessageDiscordMock).toHaveBeenLastCalledWith(
        "channel:thread-1",
        "threaded",
        {
          verbose: false,
          accountId: "default",
          replyTo: "reply-1",
          silent: true,
          cfg: {},
          textLimit: undefined,
          maxLinesPerMessage: undefined,
          tableMode: undefined,
          chunkMode: undefined,
        },
      );
      expect(result.receipt.threadId).toBe("thread-1");
      expect(result.receipt.replyToId).toBe("reply-1");
    };

    await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "discordMessageAdapter",
      adapter,
      proofs: {
        text: proveText,
        media: proveMedia,
        payload: provePayload,
        silent: proveReplyThreadSilent,
        replyTo: proveReplyThreadSilent,
        thread: proveReplyThreadSilent,
        messageSendingHooks: () => {
          expect(sendText).toBeTypeOf("function");
        },
      },
    });
  });

  it("backs declared live preview finalizer capabilities with adapter proofs", async () => {
    const adapter = requireDiscordMessageAdapter();
    const sendText = requireTextSender(adapter);

    await verifyChannelMessageLiveCapabilityAdapterProofs({
      adapterName: "discordMessageAdapter",
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
      adapterName: "discordMessageAdapter",
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
