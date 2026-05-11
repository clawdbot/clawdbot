import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
} from "openclaw/plugin-sdk/channel-message";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../api.js";
import { linePlugin } from "./channel.js";
import { lineConfigAdapter } from "./config-adapter.js";
import { resolveLineGroupRequireMention } from "./group-policy.js";
import { lineOutboundAdapter } from "./outbound.js";
import { setLineRuntime } from "./runtime.js";
import { createLineSendReceipt } from "./send-receipt.js";

const ssrfMocks = vi.hoisted(() => ({
  resolvePinnedHostnameWithPolicy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  resolvePinnedHostnameWithPolicy: ssrfMocks.resolvePinnedHostnameWithPolicy,
}));

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

type LineRuntimeMocks = {
  pushMessageLine: ReturnType<typeof vi.fn>;
  pushMessagesLine: ReturnType<typeof vi.fn>;
  pushFlexMessage: ReturnType<typeof vi.fn>;
  pushTemplateMessage: ReturnType<typeof vi.fn>;
  pushLocationMessage: ReturnType<typeof vi.fn>;
  pushTextMessageWithQuickReplies: ReturnType<typeof vi.fn>;
  createQuickReplyItems: ReturnType<typeof vi.fn>;
  buildTemplateMessageFromPayload: ReturnType<typeof vi.fn>;
  sendMessageLine: ReturnType<typeof vi.fn>;
  chunkMarkdownText: ReturnType<typeof vi.fn>;
  resolveLineAccount: ReturnType<typeof vi.fn>;
  resolveTextChunkLimit: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.setSystemTime(1_800_000_000_000);
  ssrfMocks.resolvePinnedHostnameWithPolicy.mockReset();
  ssrfMocks.resolvePinnedHostnameWithPolicy.mockResolvedValue({
    hostname: "example.com",
    addresses: ["93.184.216.34"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function lineResult(messageId: string, chatId = "c1") {
  return {
    messageId,
    chatId,
    receipt: createLineSendReceipt({ messageId, chatId, kind: "text" }),
  };
}

function createRuntime(): { runtime: PluginRuntime; mocks: LineRuntimeMocks } {
  const pushMessageLine = vi.fn(async () => lineResult("m-text"));
  const pushMessagesLine = vi.fn(async () => lineResult("m-batch"));
  const pushFlexMessage = vi.fn(async () => lineResult("m-flex"));
  const pushTemplateMessage = vi.fn(async () => lineResult("m-template"));
  const pushLocationMessage = vi.fn(async () => lineResult("m-loc"));
  const pushTextMessageWithQuickReplies = vi.fn(async () => lineResult("m-quick"));
  const createQuickReplyItems = vi.fn((labels: string[]) => ({ items: labels }));
  const buildTemplateMessageFromPayload = vi.fn(() => ({ type: "buttons" }));
  const sendMessageLine = vi.fn(async () => lineResult("m-media"));
  const chunkMarkdownText = vi.fn((text: string) => [text]);
  const resolveTextChunkLimit = vi.fn(() => 123);
  const resolveLineAccount = vi.fn(
    ({ cfg, accountId }: { cfg: OpenClawConfig; accountId?: string }) => {
      const resolved = accountId ?? "default";
      const lineConfig = (cfg.channels?.line ?? {}) as {
        accounts?: Record<string, Record<string, unknown>>;
      };
      const accountConfig = resolved !== "default" ? (lineConfig.accounts?.[resolved] ?? {}) : {};
      return {
        accountId: resolved,
        config: { ...lineConfig, ...accountConfig },
      };
    },
  );

  const runtime = {
    channel: {
      line: {
        pushMessageLine,
        pushMessagesLine,
        pushFlexMessage,
        pushTemplateMessage,
        pushLocationMessage,
        pushTextMessageWithQuickReplies,
        createQuickReplyItems,
        buildTemplateMessageFromPayload,
        sendMessageLine,
        resolveLineAccount,
      },
      text: {
        chunkMarkdownText,
        resolveTextChunkLimit,
      },
    },
  } as unknown as PluginRuntime;

  return {
    runtime,
    mocks: {
      pushMessageLine,
      pushMessagesLine,
      pushFlexMessage,
      pushTemplateMessage,
      pushLocationMessage,
      pushTextMessageWithQuickReplies,
      createQuickReplyItems,
      buildTemplateMessageFromPayload,
      sendMessageLine,
      chunkMarkdownText,
      resolveLineAccount,
      resolveTextChunkLimit,
    },
  };
}

describe("line outbound sendPayload", () => {
  it("sends flex message without dropping text", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      text: "Now playing:",
      channelData: {
        line: {
          flexMessage: {
            altText: "Now playing",
            contents: { type: "bubble" },
          },
        },
      },
    };

    await lineOutboundAdapter.sendPayload!({
      to: "line:group:1",
      text: payload.text,
      payload,
      accountId: "default",
      cfg,
    });

    expect(mocks.pushFlexMessage).toHaveBeenCalledTimes(1);
    expect(mocks.pushMessageLine).toHaveBeenCalledWith("line:group:1", "Now playing:", {
      verbose: false,
      accountId: "default",
      cfg,
    });
  });

  it("sends template message without dropping text", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      text: "Choose one:",
      channelData: {
        line: {
          templateMessage: {
            type: "confirm",
            text: "Continue?",
            confirmLabel: "Yes",
            confirmData: "yes",
            cancelLabel: "No",
            cancelData: "no",
          },
        },
      },
    };

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:1",
      text: payload.text,
      payload,
      accountId: "default",
      cfg,
    });

    expect(mocks.buildTemplateMessageFromPayload).toHaveBeenCalledTimes(1);
    expect(mocks.pushTemplateMessage).toHaveBeenCalledTimes(1);
    expect(mocks.pushMessageLine).toHaveBeenCalledWith("line:user:1", "Choose one:", {
      verbose: false,
      accountId: "default",
      cfg,
    });
  });

  it("attaches quick replies when no text chunks are present", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      channelData: {
        line: {
          quickReplies: ["One", "Two"],
          flexMessage: {
            altText: "Card",
            contents: { type: "bubble" },
          },
        },
      },
    };

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:2",
      text: "",
      payload,
      accountId: "default",
      cfg,
    });

    expect(mocks.pushFlexMessage).not.toHaveBeenCalled();
    expect(mocks.pushMessagesLine).toHaveBeenCalledWith(
      "line:user:2",
      [
        {
          type: "flex",
          altText: "Card",
          contents: { type: "bubble" },
          quickReply: { items: ["One", "Two"] },
        },
      ],
      { verbose: false, accountId: "default", cfg },
    );
    expect(mocks.createQuickReplyItems).toHaveBeenCalledWith(["One", "Two"]);
  });

  it("sends quick-reply-only payloads with fallback text", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const result = await lineOutboundAdapter.sendPayload!({
      to: "line:user:quick",
      text: "",
      payload: {
        channelData: {
          line: {
            quickReplies: ["One", "Two"],
          },
        },
      },
      accountId: "default",
      cfg,
    });

    expect(mocks.pushTextMessageWithQuickReplies).toHaveBeenCalledWith(
      "line:user:quick",
      "Options:\n- One\n- Two",
      ["One", "Two"],
      { verbose: false, accountId: "default", cfg },
    );
    expect(result).toEqual({
      channel: "line",
      chatId: "c1",
      messageId: "m-quick",
      receipt: {
        parts: [
          {
            index: 0,
            kind: "text",
            platformMessageId: "m-quick",
            raw: {
              channel: "line",
              chatId: "c1",
              conversationId: "c1",
              messageId: "m-quick",
              meta: { messageCount: 1 },
            },
            threadId: "c1",
          },
        ],
        platformMessageIds: ["m-quick"],
        primaryPlatformMessageId: "m-quick",
        raw: [
          {
            channel: "line",
            chatId: "c1",
            conversationId: "c1",
            messageId: "m-quick",
            meta: { messageCount: 1 },
          },
        ],
        sentAt: 1_800_000_000_000,
        threadId: "c1",
      },
    });
  });

  it("sends media before quick-reply text so buttons stay visible", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      text: "Hello",
      mediaUrl: "https://example.com/img.jpg",
      channelData: {
        line: {
          quickReplies: ["One", "Two"],
        },
      },
    };

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:3",
      text: payload.text,
      payload,
      accountId: "default",
      cfg,
    });

    expect(mocks.sendMessageLine).toHaveBeenCalledWith("line:user:3", "", {
      verbose: false,
      mediaUrl: "https://example.com/img.jpg",
      mediaKind: undefined,
      previewImageUrl: undefined,
      durationMs: undefined,
      trackingId: undefined,
      accountId: "default",
      cfg,
    });
    expect(mocks.pushTextMessageWithQuickReplies).toHaveBeenCalledWith(
      "line:user:3",
      "Hello",
      ["One", "Two"],
      { verbose: false, accountId: "default", cfg },
    );
    const mediaOrder = mocks.sendMessageLine.mock.invocationCallOrder[0];
    const quickReplyOrder = mocks.pushTextMessageWithQuickReplies.mock.invocationCallOrder[0];
    expect(mediaOrder).toBeLessThan(quickReplyOrder);
  });

  it("keeps generic media payloads on the image-only send path", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:4",
      text: "",
      payload: {
        mediaUrl: "https://example.com/video.mp4",
      },
      accountId: "default",
      cfg,
    });

    expect(mocks.sendMessageLine).toHaveBeenCalledWith("line:user:4", "", {
      verbose: false,
      mediaUrl: "https://example.com/video.mp4",
      accountId: "default",
      cfg,
    });
  });

  it("uses LINE-specific media options for rich media payloads", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:5",
      text: "",
      payload: {
        mediaUrl: "https://example.com/video.mp4",
        channelData: {
          line: {
            mediaKind: "video",
            previewImageUrl: "https://example.com/preview.jpg",
            trackingId: "track-123",
          },
        },
      },
      accountId: "default",
      cfg,
    });

    expect(mocks.sendMessageLine).toHaveBeenCalledWith("line:user:5", "", {
      verbose: false,
      mediaUrl: "https://example.com/video.mp4",
      mediaKind: "video",
      previewImageUrl: "https://example.com/preview.jpg",
      durationMs: undefined,
      trackingId: "track-123",
      accountId: "default",
      cfg,
    });
  });

  it("uses configured text chunk limit for payloads", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: { textChunkLimit: 123 } } } as OpenClawConfig;

    const payload = {
      text: "Hello world",
      channelData: {
        line: {
          flexMessage: {
            altText: "Card",
            contents: { type: "bubble" },
          },
        },
      },
    };

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:3",
      text: payload.text,
      payload,
      accountId: "primary",
      cfg,
    });

    expect(mocks.resolveTextChunkLimit).toHaveBeenCalledWith(cfg, "line", "primary", {
      fallbackLimit: 5000,
    });
    expect(mocks.chunkMarkdownText).toHaveBeenCalledWith("Hello world", 123);
  });

  it("omits trackingId for non-user quick-reply inline video media", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      text: "",
      mediaUrl: "https://example.com/video.mp4",
      channelData: {
        line: {
          quickReplies: ["One"],
          mediaKind: "video" as const,
          previewImageUrl: "https://example.com/preview.jpg",
          trackingId: "track-group",
        },
      },
    };

    await lineOutboundAdapter.sendPayload!({
      to: "line:group:C123",
      text: payload.text,
      payload,
      accountId: "default",
      cfg,
    });

    expect(mocks.pushMessagesLine).toHaveBeenCalledWith(
      "line:group:C123",
      [
        {
          type: "video",
          originalContentUrl: "https://example.com/video.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
          quickReply: { items: ["One"] },
        },
      ],
      { verbose: false, accountId: "default", cfg },
    );
  });

  it("keeps trackingId for user quick-reply inline video media", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      text: "",
      mediaUrl: "https://example.com/video.mp4",
      channelData: {
        line: {
          quickReplies: ["One"],
          mediaKind: "video" as const,
          previewImageUrl: "https://example.com/preview.jpg",
          trackingId: "track-user",
        },
      },
    };

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:U123",
      text: payload.text,
      payload,
      accountId: "default",
      cfg,
    });

    expect(mocks.pushMessagesLine).toHaveBeenCalledWith(
      "line:user:U123",
      [
        {
          type: "video",
          originalContentUrl: "https://example.com/video.mp4",
          previewImageUrl: "https://example.com/preview.jpg",
          trackingId: "track-user",
          quickReply: { items: ["One"] },
        },
      ],
      { verbose: false, accountId: "default", cfg },
    );
  });

  it("rejects quick-reply inline video media without previewImageUrl", async () => {
    const { runtime } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const payload = {
      text: "",
      mediaUrl: "https://example.com/video.mp4",
      channelData: {
        line: {
          quickReplies: ["One"],
          mediaKind: "video" as const,
        },
      },
    };

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text: payload.text,
        payload,
        accountId: "default",
        cfg,
      }),
    ).rejects.toThrow(/require previewimageurl/i);
  });

  it("declares message adapter durable text and media with receipt proofs", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    const proofResults = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "line",
      adapter: linePlugin.message!,
      proofs: {
        text: async () => {
          const result = await linePlugin.message?.send?.text?.({
            cfg,
            to: "line:user:U123",
            text: "hello",
            accountId: "primary",
          });
          expect(mocks.pushMessageLine).toHaveBeenCalledWith("line:user:U123", "hello", {
            verbose: false,
            accountId: "primary",
            cfg,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["m-text"]);
        },
        media: async () => {
          const result = await linePlugin.message?.send?.media?.({
            cfg,
            to: "line:user:U123",
            text: "image",
            mediaUrl: "https://example.com/image.jpg",
            accountId: "primary",
          });
          expect(mocks.sendMessageLine).toHaveBeenCalledWith("line:user:U123", "", {
            verbose: false,
            mediaUrl: "https://example.com/image.jpg",
            accountId: "primary",
            cfg,
          });
          expect(result?.receipt.platformMessageIds).toEqual(["m-media"]);
        },
        messageSendingHooks: () => {
          expect(linePlugin.message?.send?.text).toBeTypeOf("function");
        },
      },
    });

    expect(proofResults.find((result) => result.capability === "text")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "media")?.status).toBe("verified");
    expect(proofResults.find((result) => result.capability === "messageSendingHooks")?.status).toBe(
      "verified",
    );
  });

  it("declares receive ack policies for deferred LINE webhook acknowledgement", async () => {
    const proofResults = await verifyChannelMessageReceiveAckPolicyAdapterProofs({
      adapterName: "line",
      adapter: linePlugin.message!,
      proofs: {
        after_receive_record: () => {
          expect(linePlugin.message?.receive?.supportedAckPolicies).toContain(
            "after_receive_record",
          );
        },
        after_agent_dispatch: () => {
          expect(linePlugin.message?.receive?.defaultAckPolicy).toBe("after_agent_dispatch");
        },
      },
    });

    expect(proofResults.find((result) => result.policy === "after_receive_record")?.status).toBe(
      "verified",
    );
    expect(proofResults.find((result) => result.policy === "after_agent_dispatch")?.status).toBe(
      "verified",
    );
  });
});

describe("linePlugin config.formatAllowFrom", () => {
  it("strips line:user: prefixes without lowercasing", () => {
    const formatted = lineConfigAdapter.formatAllowFrom!({
      cfg: {} as OpenClawConfig,
      allowFrom: ["line:user:UABC", "line:UDEF"],
    });
    expect(formatted).toEqual(["UABC", "UDEF"]);
  });
});

describe("linePlugin groups.resolveRequireMention", () => {
  it("uses account-level group settings when provided", () => {
    const { runtime } = createRuntime();
    setLineRuntime(runtime);

    const cfg = {
      channels: {
        line: {
          groups: {
            "*": { requireMention: false },
          },
          accounts: {
            primary: {
              groups: {
                "group-1": { requireMention: true },
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const requireMention = resolveLineGroupRequireMention({
      cfg,
      accountId: "primary",
      groupId: "group-1",
    });

    expect(requireMention).toBe(true);
  });
});
