// Messaging tool extraction tests cover channel/provider normalization, thread
// evidence, and plugin-provided send extraction hooks.
import { beforeEach, describe, expect, it } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { extractMessagingToolSend } from "./embedded-agent-subscribe.tools.js";

function normalizeTelegramMessagingTargetForTest(raw: string): string | undefined {
  // Test normalizer mirrors channel plugins that canonicalize human targets
  // before subscription delivery tracking stores them.
  const trimmed = raw.trim();
  return trimmed ? `telegram:${trimmed}` : undefined;
}

describe("extractMessagingToolSend", () => {
  beforeEach(() => {
    // Active registry state drives provider-specific extraction; reset it for
    // each case so channel plugin behavior is deterministic.
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "telegram",
          plugin: {
            ...createChannelTestPluginBase({ id: "telegram" }),
            messaging: { normalizeTarget: normalizeTelegramMessagingTargetForTest },
            threading: { resolveAutoThreadId: () => "456" },
          },
          source: "test",
        },
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            messaging: { normalizeTarget: (raw: string) => raw.trim().toLowerCase() },
            actions: {
              extractToolSend: (params: { args: Record<string, unknown> }) => {
                const { args } = params;
                return args.action === "sendMessage" && typeof args.to === "string"
                  ? {
                      to: args.to,
                      accountId: typeof args.accountId === "string" ? args.accountId : undefined,
                      threadId: typeof args.threadId === "string" ? args.threadId : undefined,
                    }
                  : null;
              },
            },
          },
          source: "test",
        },
        {
          pluginId: "discord",
          plugin: createChannelTestPluginBase({ id: "discord" }),
          source: "test",
        },
      ]),
    );
  });

  it("uses channel as provider for message tool", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      to: "123",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("telegram");
    expect(result?.to).toBe("telegram:123");
  });

  it("prefers provider when both provider and channel are set", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      provider: "slack",
      channel: "telegram",
      to: "channel:C1",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("slack");
    expect(result?.to).toBe("channel:c1");
  });

  it("accepts target alias when to is omitted", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      target: "123",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("telegram");
    expect(result?.to).toBe("telegram:123");
  });

  it("recognizes attachment-style message tool sends", () => {
    const upload = extractMessagingToolSend("message", {
      action: "upload-file",
      channel: "discord",
      to: "channel:123",
      path: "/tmp/song.mp3",
    });
    const attachment = extractMessagingToolSend("message", {
      action: "sendAttachment",
      provider: "discord",
      to: "channel:123",
      filePath: "/tmp/song.mp3",
    });
    const effect = extractMessagingToolSend("message", {
      action: "sendWithEffect",
      provider: "discord",
      to: "channel:123",
      content: "done",
    });

    expect(upload?.tool).toBe("message");
    expect(upload?.provider).toBe("discord");
    expect(upload?.to).toBe("channel:123");
    expect(attachment?.tool).toBe("message");
    expect(attachment?.provider).toBe("discord");
    expect(attachment?.to).toBe("channel:123");
    expect(effect?.tool).toBe("message");
    expect(effect?.provider).toBe("discord");
    expect(effect?.to).toBe("channel:123");
  });

  it("keeps thread id evidence for thread replies", () => {
    const result = extractMessagingToolSend("message", {
      action: "thread-reply",
      provider: "discord",
      to: "channel:123",
      threadId: "456",
      content: "done",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("discord");
    expect(result?.to).toBe("channel:123");
    expect(result?.threadId).toBe("456");
  });

  it("records when message sends can inherit the current thread", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      provider: "telegram",
      to: "123",
      content: "done",
    });

    expect(result?.threadImplicit).toBe(true);
  });

  it("keeps provider-tool extracted thread id evidence", () => {
    const result = extractMessagingToolSend("slack", {
      action: "sendMessage",
      to: " Channel:C1 ",
      threadId: "171.222",
      accountId: "bot-a",
      content: "done",
    });

    expect(result).toMatchObject({
      tool: "slack",
      provider: "slack",
      accountId: "bot-a",
      to: "channel:c1",
      threadId: "171.222",
    });
  });

  it("records when message sends explicitly suppress implicit thread delivery", () => {
    const topLevel = extractMessagingToolSend("message", {
      action: "send",
      provider: "telegram",
      to: "123",
      topLevel: true,
      content: "done",
    });
    const nullThread = extractMessagingToolSend("message", {
      action: "send",
      provider: "telegram",
      to: "123",
      threadId: null,
      content: "done",
    });

    expect(topLevel?.threadSuppressed).toBe(true);
    expect(topLevel?.threadImplicit).toBeUndefined();
    expect(nullThread?.threadSuppressed).toBe(true);
    expect(nullThread?.threadImplicit).toBeUndefined();
  });
});
