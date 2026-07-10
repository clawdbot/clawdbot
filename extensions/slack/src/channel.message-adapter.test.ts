// Slack tests cover channel.message adapter plugin behavior.
import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { slackPlugin } from "./channel.js";
import { SLACK_PRESENTATION_CAPABILITIES } from "./presentation.js";
import type { OpenClawConfig } from "./runtime-api.js";

const cfg = {
  channels: {
    slack: {
      botToken: "xoxb-test",
      appToken: "xapp-test",
    },
  },
} as OpenClawConfig;

type SlackMessageAdapter = NonNullable<typeof slackPlugin.message>;
type SlackMessageSender = NonNullable<SlackMessageAdapter["send"]>;

function requireSlackMessageAdapter(): SlackMessageAdapter {
  const adapter = slackPlugin.message;
  if (!adapter) {
    throw new Error("Expected slack channel message adapter");
  }
  return adapter;
}

function requireTextSender(adapter: SlackMessageAdapter): NonNullable<SlackMessageSender["text"]> {
  const text = adapter.send?.text;
  if (!text) {
    throw new Error("Expected slack message adapter text sender");
  }
  return text;
}

function requireMediaSender(
  adapter: SlackMessageAdapter,
): NonNullable<SlackMessageSender["media"]> {
  const media = adapter.send?.media;
  if (!media) {
    throw new Error("Expected slack message adapter media sender");
  }
  return media;
}

function requirePayloadSender(
  adapter: SlackMessageAdapter,
): NonNullable<SlackMessageSender["payload"]> {
  const payload = adapter.send?.payload;
  if (!payload) {
    throw new Error("Expected slack message adapter payload sender");
  }
  return payload;
}

describe("slack channel message adapter", () => {
  const sendSlack = vi.fn();

  function expectLastSendSlackCall(): [string, string, Record<string, unknown>] {
    const call = sendSlack.mock.calls.at(-1) as unknown as
      | [string, string, Record<string, unknown>]
      | undefined;
    if (!call) {
      throw new Error("Expected sendSlack to be called");
    }
    return call;
  }

  beforeEach(() => {
    sendSlack.mockReset();
    sendSlack.mockResolvedValue({ messageId: "msg-1", channelId: "C123" });
  });

  it("backs declared durable-final capabilities with outbound send proofs", async () => {
    const adapter = requireSlackMessageAdapter();
    const sendText = requireTextSender(adapter);
    const sendMedia = requireMediaSender(adapter);
    const sendPayload = requirePayloadSender(adapter);
    expect(adapter.durableFinal?.reconcileUnknownSendKinds).toEqual({ text: true });

    const proveText = async () => {
      sendSlack.mockClear();
      const onPlatformSendDispatch = vi.fn();
      const result = await sendText({
        cfg,
        to: "C123",
        text: "hello",
        accountId: "default",
        deliveryQueueId: "queue-1",
        onPlatformSendDispatch,
        deps: { sendSlack },
      });
      const [to, text, options] = expectLastSendSlackCall();
      expect(to).toBe("C123");
      expect(text).toBe("hello");
      expect(options.accountId).toBe("default");
      expect(options.deliveryQueueId).toBe("queue-1");
      expect(options.onPlatformSendDispatch).toBe(onPlatformSendDispatch);
      expect(result.receipt.platformMessageIds).toEqual(["msg-1"]);
      expect(result.receipt.parts[0]?.kind).toBe("text");
    };

    const proveMedia = async () => {
      sendSlack.mockClear();
      const onPlatformSendDispatch = vi.fn();
      const result = await sendMedia({
        cfg,
        to: "C123",
        text: "caption",
        mediaUrl: "https://example.com/a.png",
        mediaLocalRoots: ["/tmp/media"],
        accountId: "default",
        deliveryQueueId: "queue-1",
        onPlatformSendDispatch,
        deps: { sendSlack },
      });
      const [to, text, options] = expectLastSendSlackCall();
      expect(to).toBe("C123");
      expect(text).toBe("caption");
      expect(options.accountId).toBe("default");
      expect(options.mediaUrl).toBe("https://example.com/a.png");
      expect(options.mediaLocalRoots).toEqual(["/tmp/media"]);
      expect(options.deliveryQueueId).toBeUndefined();
      expect(options.onPlatformSendDispatch).toBe(onPlatformSendDispatch);
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
        deliveryQueueId: "queue-1",
        deps: { sendSlack },
      });
      const [to, text, options] = expectLastSendSlackCall();
      expect(to).toBe("C123");
      expect(text).toBe("payload");
      expect(options.accountId).toBe("default");
      expect(options.deliveryQueueId).toBeUndefined();
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
      const [to, text, options] = expectLastSendSlackCall();
      expect(to).toBe("C123");
      expect(text).toBe("threaded");
      expect(options.accountId).toBe("default");
      expect(options.threadTs).toBe("1712000000.000001");
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
      const [to, text, options] = expectLastSendSlackCall();
      expect(to).toBe("C123");
      expect(text).toBe("threaded");
      expect(options.accountId).toBe("default");
      expect(options.threadTs).toBe("1712345678.123456");
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
        reconcileUnknownSend: () => {
          expect(adapter.durableFinal?.reconcileUnknownSend).toBeTypeOf("function");
        },
      },
    });
  });

  it("renders portable presentations through the facade as card receipts (#95440)", async () => {
    const outbound = slackPlugin.outbound;
    const renderPresentation = outbound?.renderPresentation;
    if (!renderPresentation) {
      throw new Error("Expected Slack presentation renderer");
    }
    expect(outbound.presentationCapabilities).toBe(SLACK_PRESENTATION_CAPABILITIES);

    const presentation = {
      title: "Status",
      blocks: [{ type: "divider" as const }],
    };
    const payload = { text: "Fallback", presentation };
    const rendered = await renderPresentation({
      payload,
      presentation,
      ctx: { cfg, to: "C123", text: payload.text, payload },
    });
    if (!rendered) {
      throw new Error("Expected rendered Slack presentation payload");
    }
    // Core consumes the portable presentation before handing the native payload to the adapter.
    const { presentation: _presentation, ...deliveryPayload } = rendered;

    const result = await requirePayloadSender(requireSlackMessageAdapter())({
      cfg,
      to: "C123",
      text: deliveryPayload.text ?? "",
      payload: deliveryPayload,
      accountId: "default",
      deps: { sendSlack },
    });

    const [to, text, options] = expectLastSendSlackCall();
    expect(to).toBe("C123");
    expect(text).toBe("Fallback");
    expect(options.blocks).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: "Fallback" },
      },
      {
        type: "header",
        text: { type: "plain_text", text: "Status", emoji: true },
      },
      { type: "divider" },
    ]);
    expect(result.receipt.parts[0]?.kind).toBe("card");
  });

  it("backs declared live preview finalizer capabilities with adapter proofs", async () => {
    const adapter = requireSlackMessageAdapter();
    const sendText = requireTextSender(adapter);

    await verifyChannelMessageLiveCapabilityAdapterProofs({
      adapterName: "slackMessageAdapter",
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
        nativeStreaming: () => {
          expect(adapter.live?.capabilities?.previewFinalization).toBe(true);
        },
      },
    });

    await verifyChannelMessageLiveFinalizerProofs({
      adapterName: "slackMessageAdapter",
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
