// Line tests cover channel.sendPayload plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import { chunkMarkdownText as chunkMarkdownTextForLine } from "openclaw/plugin-sdk/reply-runtime";
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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function lineResult(messageId: string, chatId = "c1") {
  return {
    messageId,
    chatId,
    receipt: createLineSendReceipt({ messageId, chatId, kind: "text" }),
  };
}

function createCredentialBearingHttpUrl(): string {
  const url = new URL("http://example.com/image.jpg");
  url.username = ["line", "user"].join("-");
  url.password = ["line", "fixture"].join("-");
  url.searchParams.set("auth", ["line", "query"].join("-"));
  return url.href;
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
  it.each([
    { name: "without quick replies", quickReplies: [] as string[] },
    { name: "with final quick replies", quickReplies: ["Continue"] },
  ])("sends oversized tables in their source position $name", async ({ quickReplies }) => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    mocks.resolveTextChunkLimit.mockReturnValue(5000);
    mocks.chunkMarkdownText.mockImplementation((text: string) =>
      chunkMarkdownTextForLine(text, 5000),
    );
    const markdown = `First\n\n| Small | Value |\n|---|---|\n| Kept | card |\n\nBetween\n\n| Name | Value |\n|---|---|\n| Large | ${"x".repeat(30_000)} |\n\nAfter\n\n\`\`\`js\nconsole.log("still a card")\n\`\`\``;

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:ordered",
      text: markdown,
      payload: {
        text: markdown,
        ...(quickReplies.length > 0 ? { channelData: { line: { quickReplies } } } : {}),
      },
      accountId: "default",
      cfg: { channels: { line: {} } } as OpenClawConfig,
    });

    const messages = [
      ...mocks.pushFlexMessage.mock.calls.map((args, index) => ({
        position: mocks.pushFlexMessage.mock.invocationCallOrder[index],
        type: args[1] === "Code" ? "code-card" : "valid-table-card",
      })),
      ...mocks.pushMessageLine.mock.calls.map((args, index) => ({
        position: mocks.pushMessageLine.mock.invocationCallOrder[index],
        type: String(args[1]).includes("Large") ? "oversized-table-text" : "text",
      })),
      ...mocks.pushMessagesLine.mock.calls.flatMap((args, index) =>
        args[1].map((message: { type: string; altText?: string }) => ({
          position: mocks.pushMessagesLine.mock.invocationCallOrder[index],
          type: message.altText === "Code" ? "code-card" : message.type,
        })),
      ),
    ]
      .toSorted((left, right) => left.position - right.position)
      .map((message) => message.type)
      .filter((type) => type !== "text");

    expect(messages).toEqual(["valid-table-card", "oversized-table-text", "code-card"]);
    expect(mocks.pushMessageLine.mock.calls.every((args) => String(args[1]).length <= 5000)).toBe(
      true,
    );
    if (quickReplies.length > 0) {
      expect(mocks.pushMessagesLine).toHaveBeenCalledExactlyOnceWith(
        "line:user:ordered",
        [expect.objectContaining({ altText: "Code", quickReply: { items: quickReplies } })],
        expect.any(Object),
      );
      expect(mocks.pushTextMessageWithQuickReplies).not.toHaveBeenCalled();
    }
  });

  it.each([
    { name: "empty", text: "" },
    { name: "whitespace-only", text: "   " },
  ])("rejects a $name payload instead of fabricating a delivery", async ({ text }) => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text,
        payload: { text },
        accountId: "default",
        cfg: { channels: { line: {} } } as OpenClawConfig,
      }),
    ).rejects.toThrow("Message must be non-empty for LINE sends");
    expect(mocks.pushMessageLine).not.toHaveBeenCalled();
    expect(mocks.pushMessagesLine).not.toHaveBeenCalled();
  });

  it.each([
    { name: "title", title: " ", address: "1 Main Street" },
    { name: "address", title: "Meet here", address: " " },
  ])("skips a direct location with a blank $name while delivering text", async (location) => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:U123",
      text: "Meet me there.",
      payload: {
        text: "Meet me there.",
        channelData: {
          line: {
            location: { ...location, latitude: 35.6895, longitude: 139.6917 },
          },
        },
      },
      accountId: "default",
      cfg: { channels: { line: {} } } as OpenClawConfig,
    });

    expect(mocks.pushLocationMessage).not.toHaveBeenCalled();
    expect(mocks.pushMessageLine).toHaveBeenCalledWith(
      "line:user:U123",
      "Meet me there.",
      expect.any(Object),
    );
  });

  it("omits an invalid direct location from the quick-reply inline batch", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:U123",
      text: "",
      payload: {
        text: "",
        channelData: {
          line: {
            quickReplies: ["Continue"],
            location: {
              title: "Meet here",
              address: " ",
              latitude: 35.6895,
              longitude: 139.6917,
            },
          },
        },
      },
      accountId: "default",
      cfg: { channels: { line: {} } } as OpenClawConfig,
    });

    expect(mocks.pushLocationMessage).not.toHaveBeenCalled();
    expect(mocks.pushMessagesLine).not.toHaveBeenCalled();
    expect(mocks.pushTextMessageWithQuickReplies).toHaveBeenCalledWith(
      "line:user:U123",
      expect.stringContaining("Continue"),
      ["Continue"],
      expect.any(Object),
    );
  });

  it("preserves the finalized receipt when its delivery observer rejects", async () => {
    const { runtime } = createRuntime();
    setLineRuntime(runtime);
    const onDeliveryResult = vi.fn(async () => {
      throw new Error("delivery observer unavailable");
    });

    let caught: unknown;
    try {
      await lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text: "Hello",
        payload: { text: "Hello" },
        accountId: "default",
        cfg: { channels: { line: {} } } as OpenClawConfig,
        onDeliveryResult,
      });
    } catch (error) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected a partial LINE delivery error");
    }
    expect(caught.deliveryResult).toMatchObject({
      messageIds: ["m-text"],
      receipt: { primaryPlatformMessageId: "m-text" },
      visibleReplySent: true,
    });
    expect(onDeliveryResult).toHaveBeenCalledOnce();
  });

  it("returns the provider receipt for a Flex-only legacy text send", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = {
      channels: { line: { channelAccessToken: "line-fixture-token" } },
    } as OpenClawConfig;
    const providerResponse = new Response(JSON.stringify({ sentMessages: [{ id: "m-flex" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetch = vi.fn(async () => providerResponse);
    vi.stubGlobal("fetch", fetch);
    const onDeliveryResult = vi.fn();

    const result = await lineOutboundAdapter.sendText!({
      to: "line:user:U123",
      text: "| Name | Status |\n|---|---|\n| OpenClaw | ready |",
      accountId: "default",
      cfg,
      onDeliveryResult,
    });

    expect(result.messageId).toBe("m-flex");
    expect(result.receipt?.platformMessageIds).toEqual(["m-flex"]);
    expect(result.receipt?.threadId).toBe("c1");
    expect(mocks.pushFlexMessage).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledWith(expect.objectContaining({ messageId: "m-flex" }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("publishes completed Flex receipts before a later legacy text send fails", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = {
      channels: { line: { channelAccessToken: "line-fixture-token" } },
    } as OpenClawConfig;
    const laterFailure = new Error("second LINE Flex send failed");
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ sentMessages: [{ id: "m-first-flex" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockRejectedValueOnce(laterFailure);
    vi.stubGlobal("fetch", fetch);
    mocks.pushFlexMessage
      .mockResolvedValueOnce(lineResult("m-first-flex"))
      .mockRejectedValueOnce(laterFailure);
    const onDeliveryResult = vi.fn();

    await expect(
      lineOutboundAdapter.sendText!({
        to: "line:user:U123",
        text: "```js\nfirst()\n```\n\n```js\nsecond()\n```",
        accountId: "default",
        cfg,
        onDeliveryResult,
      }),
    ).rejects.toThrow("second LINE Flex send failed");

    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "m-first-flex",
        receipt: expect.objectContaining({ platformMessageIds: ["m-first-flex"] }),
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

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

  it("reports each platform result for text and media payloads", async () => {
    const { runtime } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const onDeliveryResult = vi.fn();

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:progress",
      text: "Hello",
      payload: {
        text: "Hello",
        mediaUrl: "https://example.com/image.jpg",
      },
      accountId: "default",
      cfg,
      onDeliveryResult,
    });

    expect(onDeliveryResult).toHaveBeenCalledTimes(2);
    expect(onDeliveryResult.mock.calls.map(([result]) => result.messageId)).toEqual([
      "m-text",
      "m-media",
    ]);
  });

  it("preserves every provider receipt and conversation for an inline LINE batch", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const providerMessageIds = ["line-provider-first", "line-provider-second"] as const;
    mocks.pushMessagesLine.mockResolvedValueOnce({
      messageId: providerMessageIds[0],
      chatId: "C123",
      receipt: createLineSendReceipt({
        messageId: providerMessageIds[0],
        messageIds: providerMessageIds,
        chatId: "C123",
        kind: "card",
        messageCount: 2,
      }),
    });
    const onDeliveryResult = vi.fn();

    const result = await lineOutboundAdapter.sendPayload!({
      to: "line:group:C123",
      text: "",
      payload: {
        text: "",
        channelData: {
          line: {
            quickReplies: ["Confirm"],
            flexMessage: { altText: "Review", contents: { type: "bubble" } },
            location: {
              title: "Meet here",
              address: "1 Main Street",
              latitude: 37.7,
              longitude: -122.4,
            },
          },
        },
      },
      accountId: "default",
      cfg,
      onDeliveryResult,
    });

    expect(result.messageId).toBe("line-provider-first");
    expect(result.receipt?.platformMessageIds).toEqual(providerMessageIds);
    expect(result.receipt?.parts.map((part) => part.platformMessageId)).toEqual(providerMessageIds);
    expect(result.receipt?.threadId).toBe("C123");
    expect(onDeliveryResult).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "line-provider-first",
        receipt: expect.objectContaining({
          platformMessageIds: providerMessageIds,
          threadId: "C123",
        }),
      }),
    );
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

  it("attaches quick replies while preserving the provider's full Flex alternative-text limit", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;
    const altText = "a".repeat(1600);

    const payload = {
      channelData: {
        line: {
          quickReplies: ["One", "Two"],
          flexMessage: {
            altText,
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
          altText: "a".repeat(1500),
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
    expect(expectDefined(mediaOrder, "LINE media invocation")).toBeLessThan(
      expectDefined(quickReplyOrder, "LINE quick-reply invocation"),
    );
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

  it("keeps generic quick-reply media on the validated image route", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    await lineOutboundAdapter.sendPayload!({
      to: "line:user:U123",
      text: "",
      payload: {
        mediaUrl: "https://example.com/clip.mp4",
        channelData: { line: { quickReplies: ["One"] } },
      },
      accountId: "default",
      cfg,
    });

    expect(mocks.pushMessagesLine).toHaveBeenCalledWith(
      "line:user:U123",
      [
        {
          type: "image",
          originalContentUrl: "https://example.com/clip.mp4",
          previewImageUrl: "https://example.com/clip.mp4",
          quickReply: { items: ["One"] },
        },
      ],
      { verbose: false, accountId: "default", cfg },
    );
    expect(ssrfMocks.resolvePinnedHostnameWithPolicy).toHaveBeenCalledWith("example.com", {
      policy: { allowPrivateNetwork: false },
    });
  });

  it("rejects insecure generic media before quick-reply batch sends", async () => {
    const { runtime, mocks } = createRuntime();
    setLineRuntime(runtime);
    const cfg = { channels: { line: {} } } as OpenClawConfig;

    await expect(
      lineOutboundAdapter.sendPayload!({
        to: "line:user:U123",
        text: "",
        payload: {
          mediaUrl: createCredentialBearingHttpUrl(),
          channelData: { line: { quickReplies: ["One"] } },
        },
        accountId: "default",
        cfg,
      }),
    ).rejects.toThrow(new Error("LINE outbound media URL must use HTTPS"));

    expect(mocks.pushMessagesLine).not.toHaveBeenCalled();
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

  it("declares receive ack policies for immediate LINE webhook acknowledgement", async () => {
    const proofResults = await verifyChannelMessageReceiveAckPolicyAdapterProofs({
      adapterName: "line",
      adapter: linePlugin.message!,
      proofs: {
        after_receive_record: () => {
          expect(linePlugin.message?.receive?.defaultAckPolicy).toBe("after_receive_record");
          expect(linePlugin.message?.receive?.supportedAckPolicies).toContain(
            "after_receive_record",
          );
        },
      },
    });

    expect(proofResults.find((result) => result.policy === "after_receive_record")?.status).toBe(
      "verified",
    );
    expect(proofResults.find((result) => result.policy === "after_agent_dispatch")?.status).toBe(
      "not_declared",
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
