import { describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  filterMessagingToolMediaDuplicates,
  resolveMessagingToolPayloadDedupe,
  shouldDedupeMessagingToolRepliesForRoute,
} from "./reply-payloads.js";

function targetsMatchTelegramReplySuppression(params: {
  originTarget: string;
  targetKey: string;
  targetThreadId?: string;
}): boolean {
  const baseTarget = (value: string) =>
    value
      .replace(/^telegram:(group|channel):/u, "")
      .replace(/^telegram:/u, "")
      .replace(/:topic:.*$/u, "");
  const originTopic = params.originTarget.match(/:topic:([^:]+)$/u)?.[1];
  return (
    baseTarget(params.originTarget) === baseTarget(params.targetKey) &&
    (originTopic === undefined || originTopic === params.targetThreadId)
  );
}

vi.mock("../../channels/plugins/bundled.js", () => ({
  getBundledChannelPlugin: (channel: string) =>
    channel === "telegram"
      ? {
          outbound: {
            targetsMatchForReplySuppression: targetsMatchTelegramReplySuppression,
          },
        }
      : undefined,
}));

describe("filterMessagingToolMediaDuplicates", () => {
  it("strips mediaUrl when it matches sentMediaUrls", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("preserves mediaUrl when it is not in sentMediaUrls", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      sentMediaUrls: ["file:///tmp/other.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }]);
  });

  it("filters matching entries from mediaUrls array", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [
        {
          text: "gallery",
          mediaUrls: ["file:///tmp/a.jpg", "file:///tmp/b.jpg", "file:///tmp/c.jpg"],
        },
      ],
      sentMediaUrls: ["file:///tmp/b.jpg"],
    });
    expect(result).toEqual([
      { text: "gallery", mediaUrls: ["file:///tmp/a.jpg", "file:///tmp/c.jpg"] },
    ]);
  });

  it("clears mediaUrls when all entries match", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "gallery", mediaUrls: ["file:///tmp/a.jpg"] }],
      sentMediaUrls: ["file:///tmp/a.jpg"],
    });
    expect(result).toEqual([{ text: "gallery", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("returns payloads unchanged when no media present", () => {
    const payloads = [{ text: "plain text" }];
    const result = filterMessagingToolMediaDuplicates({
      payloads,
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toStrictEqual(payloads);
  });

  it("returns payloads unchanged when sentMediaUrls is empty", () => {
    const payloads = [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }];
    const result = filterMessagingToolMediaDuplicates({
      payloads,
      sentMediaUrls: [],
    });
    expect(result).toBe(payloads);
  });

  it("dedupes equivalent file and local path variants", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "/tmp/photo.jpg" }],
      sentMediaUrls: ["file:///tmp/photo.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
  });

  it("dedupes encoded file:// paths against local paths", () => {
    const result = filterMessagingToolMediaDuplicates({
      payloads: [{ text: "hello", mediaUrl: "/tmp/photo one.jpg" }],
      sentMediaUrls: ["file:///tmp/photo%20one.jpg"],
    });
    expect(result).toEqual([{ text: "hello", mediaUrl: undefined, mediaUrls: undefined }]);
  });
});

describe("shouldDedupeMessagingToolRepliesForRoute", () => {
  const installTelegramSuppressionRegistry = () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram-plugin",
          source: "test",
          plugin: createOutboundTestPlugin({
            id: "telegram",
            outbound: {
              deliveryMode: "direct",
              targetsMatchForReplySuppression: targetsMatchTelegramReplySuppression,
            },
          }),
        },
      ]),
    );
  };

  it("matches when target provider is missing but target matches current provider route", () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "", to: "123" }],
      }),
    ).toBe(true);
  });

  it('matches when target provider uses "message" placeholder and target matches', () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "message", to: "123" }],
      }),
    ).toBe(true);
  });

  it("does not match when providerless target does not match origin route", () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "", to: "456" }],
      }),
    ).toBe(false);
  });

  it("matches when only one side carries the account id", () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "123",
        accountId: "work",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "123" }],
      }),
    ).toBe(true);
  });

  it("does not match when route accounts differ", () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "123",
        accountId: "work",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "123", accountId: "personal" },
        ],
      }),
    ).toBe(false);
  });

  it("matches telegram topic-origin replies when explicit threadId matches", () => {
    installTelegramSuppressionRegistry();
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "77" },
        ],
      }),
    ).toBe(true);
  });

  it("preserves string thread ids before plugin reply-suppression matching", () => {
    installTelegramSuppressionRegistry();
    const largeThreadId = "9007199254740993";

    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: `telegram:group:-100123:topic:${largeThreadId}`,
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: largeThreadId },
        ],
      }),
    ).toBe(true);
  });

  it("does not match telegram topic-origin replies when explicit threadId differs", () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "88" },
        ],
      }),
    ).toBe(false);
  });

  it("does not match telegram topic-origin replies when target omits topic metadata", () => {
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "-100123" }],
      }),
    ).toBe(false);
  });

  it("matches telegram replies when chatId matches but target forms differ", () => {
    installTelegramSuppressionRegistry();
    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "-100123" }],
      }),
    ).toBe(true);
  });

  it("matches telegram replies even when the active plugin registry omits telegram", () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry([]));

    expect(
      shouldDedupeMessagingToolRepliesForRoute({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "77" },
        ],
      }),
    ).toBe(true);
  });
});

describe("resolveMessagingToolPayloadDedupe", () => {
  it("dedupes by content when messaging tool target metadata is unavailable", () => {
    expect(
      resolveMessagingToolPayloadDedupe({
        messageProvider: "telegram",
        originatingTo: "123",
      }),
    ).toEqual({
      shouldDedupePayloads: true,
      matchingRoute: false,
      routeSentTexts: [],
      routeSentMediaUrls: [],
      useGlobalSentTextEvidenceFallback: false,
      useGlobalSentMediaUrlEvidenceFallback: false,
    });
  });

  it("dedupes final replies by content when a messaging tool sent to the same route", () => {
    expect(
      resolveMessagingToolPayloadDedupe({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [
          {
            tool: "message",
            provider: "telegram",
            to: "123",
            text: "sent text",
            mediaUrls: ["file:///tmp/sent.png"],
          },
        ],
      }),
    ).toEqual({
      shouldDedupePayloads: true,
      matchingRoute: true,
      routeSentTexts: ["sent text"],
      routeSentMediaUrls: ["file:///tmp/sent.png"],
      useGlobalSentTextEvidenceFallback: false,
      useGlobalSentMediaUrlEvidenceFallback: false,
    });
  });

  it("preserves global evidence fallback for legacy multi-target records", () => {
    expect(
      resolveMessagingToolPayloadDedupe({
        messageProvider: "slack",
        originatingTo: "channel:C1",
        messagingToolSentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1" },
          { tool: "discord", provider: "discord", to: "channel:C2" },
        ],
      }),
    ).toEqual({
      shouldDedupePayloads: true,
      matchingRoute: true,
      routeSentTexts: [],
      routeSentMediaUrls: [],
      useGlobalSentTextEvidenceFallback: true,
      useGlobalSentMediaUrlEvidenceFallback: true,
    });
  });

  it("scopes matching-route evidence to the matched target", () => {
    expect(
      resolveMessagingToolPayloadDedupe({
        messageProvider: "slack",
        originatingTo: "channel:C1",
        messagingToolSentTargets: [
          { tool: "slack", provider: "slack", to: "channel:C1", text: "slack text" },
          {
            tool: "discord",
            provider: "discord",
            to: "channel:C2",
            text: "discord text",
            mediaUrls: ["file:///tmp/discord.png"],
          },
        ],
      }),
    ).toEqual({
      shouldDedupePayloads: true,
      matchingRoute: true,
      routeSentTexts: ["slack text"],
      routeSentMediaUrls: [],
      useGlobalSentTextEvidenceFallback: false,
      useGlobalSentMediaUrlEvidenceFallback: false,
    });
  });

  it("keeps final payloads intact when a messaging tool sent to another route", () => {
    expect(
      resolveMessagingToolPayloadDedupe({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
      }),
    ).toEqual({
      shouldDedupePayloads: false,
      matchingRoute: false,
      routeSentTexts: [],
      routeSentMediaUrls: [],
      useGlobalSentTextEvidenceFallback: false,
      useGlobalSentMediaUrlEvidenceFallback: false,
    });
  });
});
