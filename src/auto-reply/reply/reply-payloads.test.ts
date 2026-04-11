import { describe, expect, it, vi } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  filterMessagingToolMediaDuplicates,
  shouldSuppressMessagingToolReplies,
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

describe("shouldSuppressMessagingToolReplies", () => {
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

  it("suppresses when target provider is missing but target matches current provider route", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "", to: "123" }],
      }),
    ).toBe(true);
  });

  it('suppresses when target provider uses "message" placeholder and target matches', () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "message", to: "123" }],
      }),
    ).toBe(true);
  });

  it("does not suppress when providerless target does not match origin route", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "123",
        messagingToolSentTargets: [{ tool: "message", provider: "", to: "456" }],
      }),
    ).toBe(false);
  });

  it("suppresses telegram topic-origin replies when explicit threadId matches", () => {
    installTelegramSuppressionRegistry();
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "77" },
        ],
      }),
    ).toBe(true);
  });

  it("does not suppress telegram topic-origin replies when explicit threadId differs", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "88" },
        ],
      }),
    ).toBe(false);
  });

  it("does not suppress telegram topic-origin replies when target omits topic metadata", () => {
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "-100123" }],
      }),
    ).toBe(false);
  });

  it("suppresses telegram replies when chatId matches but target forms differ", () => {
    installTelegramSuppressionRegistry();
    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123",
        messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "-100123" }],
      }),
    ).toBe(true);
  });

  it("suppresses telegram replies even when the active plugin registry omits telegram", () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createTestRegistry([]));

    expect(
      shouldSuppressMessagingToolReplies({
        messageProvider: "telegram",
        originatingTo: "telegram:group:-100123:topic:77",
        messagingToolSentTargets: [
          { tool: "message", provider: "telegram", to: "-100123", threadId: "77" },
        ],
      }),
    ).toBe(true);
  });
});
