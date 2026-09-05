// Matrix tests cover channel.message adapter plugin behavior.
import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageLiveCapabilityAdapterProofs,
  verifyChannelMessageLiveFinalizerProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const mocks = vi.hoisted(() => ({
  sendMessageMatrix: vi.fn(),
}));

vi.mock("./matrix/send.js", () => ({
  editMessageMatrix: vi.fn(),
  reactMatrixMessage: vi.fn(),
  resolveMatrixRoomId: vi.fn(),
  sendMessageMatrix: mocks.sendMessageMatrix,
  sendPollMatrix: vi.fn(),
  sendTypingMatrix: vi.fn(),
}));

vi.mock("./runtime.js", () => ({
  getOptionalMatrixRuntime: () => undefined,
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
      homeserver: "https://matrix.example.org",
      userId: "@bot:example.org",
      accessToken: "resolved-token",
    },
  },
} as OpenClawConfig;

function lastMatrixSendOptions() {
  const options = mocks.sendMessageMatrix.mock.lastCall?.[2];
  if (!options || typeof options !== "object") {
    throw new Error("Expected Matrix send options");
  }
  return options as Record<string, unknown>;
}

describe("matrix channel message adapter", () => {
  beforeAll(async () => {
    mocks.sendMessageMatrix.mockResolvedValue({ messageId: "$warmup", roomId: "!room:example" });
    const sendText = matrixPlugin.message?.send?.text;
    if (!sendText) {
      throw new Error("Expected Matrix message adapter text sender");
    }
    await sendText({
      cfg,
      to: "room:!room:example",
      text: "warmup",
      accountId: "default",
    });
    mocks.sendMessageMatrix.mockReset();
  });

  it("declares Matrix markdown rendering support for shared reply payloads", () => {
    expect(matrixPlugin.meta.markdownCapable).toBe(true);
  });

  it("opts ordinary durable text and media sends into Matrix reconciliation", () => {
    expect(matrixPlugin.message?.durableFinal).toMatchObject({
      automaticUnknownSendReconciliation: true,
      capabilities: {
        text: true,
        media: true,
        afterCommit: true,
        reconcileUnknownSend: true,
      },
      reconcileUnknownSendKinds: { text: true, media: true },
    });
    expect(matrixPlugin.message?.durableFinal?.capabilities?.payload).not.toBe(true);
    expect(matrixPlugin.message?.durableFinal?.capabilities?.batch).not.toBe(true);
  });

  it("forwards the exact durable part topology into Matrix sends", async () => {
    const sendText = matrixPlugin.message?.send?.text;
    if (!sendText) {
      throw new Error("Expected Matrix message adapter text sender");
    }
    await sendText({
      cfg,
      to: "room:!room:example",
      text: "durable",
      accountId: "default",
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 2,
      deliveryPartCount: 3,
    });

    expect(lastMatrixSendOptions()).toMatchObject({
      deliveryQueueId: "queue-1",
      deliveryPartIndex: 2,
      deliveryPartCount: 3,
    });
  });

  it("keeps all owner-provided Matrix receipt parts across the message adapter boundary", async () => {
    const receipt = {
      primaryPlatformMessageId: "$image",
      platformMessageIds: ["$image", "$overflow"],
      parts: [
        { platformMessageId: "$image", kind: "media" as const, index: 0, replyToId: "$reply" },
        { platformMessageId: "$overflow", kind: "text" as const, index: 1 },
      ],
      replyToId: "$reply",
      sentAt: 1,
    };
    mocks.sendMessageMatrix.mockResolvedValueOnce({
      messageId: "$overflow",
      roomId: "!room:example",
      primaryMessageId: "$image",
      receipt,
      content: "image\noverflow",
    });
    const sendMedia = matrixPlugin.message?.send?.media;
    if (!sendMedia) {
      throw new Error("Expected Matrix message adapter media sender");
    }

    const result = await sendMedia({
      cfg,
      to: "room:!room:example",
      text: "image\noverflow",
      mediaUrl: "file:///tmp/photo.png",
      replyToId: "$reply",
      accountId: "default",
    });

    expect(result.messageId).toBe("$overflow");
    expect(result.receipt).toBe(receipt);
    expect(result.receipt.primaryPlatformMessageId).toBe("$image");
    expect(result.receipt.platformMessageIds).toEqual(["$image", "$overflow"]);
    expect(result.receipt.parts[1]).not.toHaveProperty("replyToId");
  });

  it("routes the standard Matrix send action through canonical durable delivery", async () => {
    const prepareSendPayload = matrixPlugin.actions?.prepareSendPayload;
    if (!prepareSendPayload) {
      throw new Error("Expected Matrix prepared-send adapter");
    }
    const payload = { text: "durable tool send" };

    expect(prepareSendPayload({ ctx: { action: "send", cfg } as never, payload } as never)).toBe(
      payload,
    );
    expect(
      prepareSendPayload({ ctx: { action: "edit", cfg } as never, payload } as never),
    ).toBeNull();
  });

  it.each([
    {
      name: "the current room with reply quoting disabled",
      to: "room:!room:example",
      replyToMode: "off" as const,
      expectedThreadId: "$thread",
    },
    {
      name: "an equivalent room target prefix",
      to: "matrix:channel:!room:example",
      replyToMode: "all" as const,
      expectedThreadId: "$thread",
    },
    {
      name: "a different room",
      to: "room:!another:example",
      replyToMode: "all" as const,
      expectedThreadId: undefined,
    },
    {
      name: "a direct user target without proven room identity",
      to: "user:@alice:example",
      replyToMode: "all" as const,
      expectedThreadId: undefined,
    },
  ])("routes a native Matrix message action in $name", async (testCase) => {
    const threading = matrixPlugin.threading;
    const handleAction = matrixPlugin.actions?.handleAction;
    if (!threading?.resolveAutoThreadId || !handleAction) {
      throw new Error("Expected Matrix threaded message action adapters");
    }
    const toolContext = {
      currentChannelProvider: "matrix" as const,
      currentChannelId: "room:!room:example",
      currentThreadTs: "$thread",
      currentMessageId: "$reply",
      replyToMode: testCase.replyToMode,
      hasRepliedRef: { value: true },
    };
    const threadId = threading.resolveAutoThreadId({
      cfg,
      accountId: "default",
      to: testCase.to,
      toolContext,
      replyToId: "$explicit-reply",
    });

    await handleAction({
      cfg,
      channel: "matrix",
      action: "send",
      accountId: "default",
      toolContext,
      params: {
        to: testCase.to,
        message: "threaded native action",
        replyTo: "$explicit-reply",
        ...(threadId ? { threadId } : {}),
      },
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledOnce();
    expect(mocks.sendMessageMatrix.mock.lastCall?.[0]).toBe(testCase.to);
    expect(lastMatrixSendOptions()).toMatchObject({
      cfg,
      accountId: "default",
      replyToId: "$explicit-reply",
      threadId: testCase.expectedThreadId,
    });
  });

  beforeEach(() => {
    mocks.sendMessageMatrix.mockReset();
    mocks.sendMessageMatrix.mockResolvedValue({ messageId: "$event-1", roomId: "!room:example" });
  });

  it("backs declared durable-final capabilities with runtime outbound proofs", async () => {
    const adapter = matrixPlugin.message;
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
      expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(1);
      expect(mocks.sendMessageMatrix.mock.lastCall?.[0]).toBe("room:!room:example");
      expect(mocks.sendMessageMatrix.mock.lastCall?.[1]).toBe("hello");
      const options = lastMatrixSendOptions();
      expect(options.cfg).toBe(cfg);
      expect(options.accountId).toBe("default");
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
      expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(1);
      expect(mocks.sendMessageMatrix.mock.lastCall?.[0]).toBe("room:!room:example");
      expect(mocks.sendMessageMatrix.mock.lastCall?.[1]).toBe("caption");
      const options = lastMatrixSendOptions();
      expect(options.cfg).toBe(cfg);
      expect(options.mediaUrl).toBe("file:///tmp/cat.png");
      expect(options.mediaLocalRoots).toEqual(["/tmp/openclaw"]);
      expect(options.audioAsVoice).toBe(true);
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
      expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(1);
      expect(mocks.sendMessageMatrix.mock.lastCall?.[0]).toBe("room:!room:example");
      expect(mocks.sendMessageMatrix.mock.lastCall?.[1]).toBe("threaded");
      const options = lastMatrixSendOptions();
      expect(options.cfg).toBe(cfg);
      expect(options.replyToId).toBe("$reply");
      expect(options.threadId).toBe("$thread");
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
        afterCommit: () => {
          expect(adapter.send?.lifecycle?.afterCommit).toBeTypeOf("function");
        },
        reconcileUnknownSend: () => {
          expect(adapter.durableFinal?.reconcileUnknownSend).toBeTypeOf("function");
          expect(adapter.durableFinal?.afterUnknownSendTerminal).toBeTypeOf("function");
        },
      },
    });
  });

  it("forwards presentation payload hooks through the registered outbound adapter", async () => {
    const outbound = matrixPlugin.outbound;
    expect(outbound?.presentationCapabilities?.supported).toBe(true);
    expect(outbound?.presentationCapabilities?.buttons).toBe(true);
    expect(outbound?.presentationCapabilities?.selects).toBe(true);
    expect(outbound?.presentationCapabilities?.context).toBe(true);
    expect(outbound?.presentationCapabilities?.divider).toBe(true);
    if (!outbound?.renderPresentation || !outbound.sendPayload) {
      throw new Error("Expected Matrix outbound presentation payload hooks.");
    }

    const presentation = {
      title: "Select thinking level",
      tone: "info" as const,
      blocks: [
        {
          type: "buttons" as const,
          buttons: [{ label: "Low", value: "/think low" }],
        },
      ],
    };
    const rendered = await outbound.renderPresentation({
      payload: { text: "fallback", presentation },
      presentation,
      ctx: {} as never,
    });

    const matrixChannelData = rendered?.channelData?.matrix as
      | { extraContent?: Record<string, unknown> }
      | undefined;
    expect(matrixChannelData?.extraContent).toEqual({
      "com.openclaw.presentation": {
        ...presentation,
        version: 1,
        type: "message.presentation",
      },
    });

    await outbound.sendPayload({
      cfg,
      to: "room:!room:example",
      text: rendered?.text ?? "",
      payload: rendered!,
      accountId: "default",
      threadId: "$thread",
    });

    expect(mocks.sendMessageMatrix).toHaveBeenCalledTimes(1);
    expect(mocks.sendMessageMatrix.mock.lastCall?.[0]).toBe("room:!room:example");
    expect(mocks.sendMessageMatrix.mock.lastCall?.[1]).toBe(rendered?.text);
    const options = lastMatrixSendOptions();
    expect(options.cfg).toBe(cfg);
    expect(options.accountId).toBe("default");
    expect(options.threadId).toBe("$thread");
    expect(options.extraContent).toEqual({
      "com.openclaw.presentation": {
        ...presentation,
        version: 1,
        type: "message.presentation",
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

  it("declares native blocks as the markdown table default", () => {
    expect(matrixPlugin.messaging?.defaultMarkdownTableMode).toBe("block");
  });
});
