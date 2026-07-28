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
  it.each(["conversations_send", "conversations_turn"])(
    "records opaque targets for %s",
    (toolName) => {
      expect(
        extractMessagingToolSend(toolName, {
          conversationRef: "conv_0123456789abcdef0123456789abcdef",
          message: "hello",
        }),
      ).toEqual({
        tool: toolName,
        provider: "conversation",
        to: "conv_0123456789abcdef0123456789abcdef",
      });
    },
  );

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
            actions: {
              extractToolSend: ({ args }: { args: Record<string, unknown> }) =>
                args.action === "sendMessage" && typeof args.to === "string"
                  ? { to: args.to }
                  : null,
            },
            threading: {
              resolveAutoThreadId: ({
                to,
                toolContext,
              }: {
                to: string;
                toolContext?: { currentThreadTs?: string };
              }) => (to.includes(":topic:") ? undefined : toolContext?.currentThreadTs),
            },
          },
          source: "test",
        },
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            messaging: { normalizeTarget: (raw: string) => raw.trim().toLowerCase() },
            actions: {
              messageActionTargetAliases: {
                reply: {
                  aliases: ["chatGuid", "messageId"],
                  deliveryTargetAliases: ["chatGuid"],
                },
              },
              extractToolSend: (params: { args: Record<string, unknown> }) => {
                const { args } = params;
                if (
                  (args.action !== "sendMessage" &&
                    args.action !== "uploadFile" &&
                    args.action !== "send" &&
                    args.action !== "upload-file") ||
                  typeof args.to !== "string"
                ) {
                  return null;
                }
                const nativeThreadId =
                  typeof args.threadTs === "string"
                    ? args.threadTs
                    : typeof args.threadId === "string"
                      ? args.threadId
                      : undefined;
                const replyTo = typeof args.replyTo === "string" ? args.replyTo : undefined;
                const threadId =
                  args.action === "send"
                    ? (replyTo ?? nativeThreadId)
                    : args.action === "upload-file"
                      ? (nativeThreadId ?? replyTo)
                      : nativeThreadId;
                const threadSuppressed =
                  args.topLevel === true || args.threadTs === null || args.threadId === null;
                return {
                  to: args.to,
                  accountId: typeof args.accountId === "string" ? args.accountId : undefined,
                  threadId,
                  threadSuppressed,
                  threadImplicit: !threadId && !threadSuppressed,
                };
              },
            },
            threading: {
              resolveAutoThreadId: ({
                to,
                toolContext,
                replyToId,
              }: {
                to: string;
                replyToId?: string | null;
                toolContext?: {
                  currentChannelId?: string;
                  currentMessagingTarget?: string;
                  currentThreadTs?: string;
                  replyToMode?: "off" | "first" | "all" | "batched";
                  hasRepliedRef?: { value: boolean };
                };
              }) => {
                if (
                  replyToId ||
                  (to !== toolContext?.currentMessagingTarget &&
                    to !== toolContext?.currentChannelId) ||
                  toolContext.replyToMode === "off" ||
                  ((toolContext.replyToMode === "first" || toolContext.replyToMode === "batched") &&
                    toolContext.hasRepliedRef?.value)
                ) {
                  return undefined;
                }
                return toolContext.currentThreadTs;
              },
              resolveReplyTransport: ({ replyToId }: { replyToId?: string | null }) => ({
                replyToId,
                threadId: null,
              }),
            },
          },
          source: "test",
        },
        {
          pluginId: "discord",
          plugin: createChannelTestPluginBase({ id: "discord" }),
          source: "test",
        },
        {
          pluginId: "mattermost",
          plugin: {
            ...createChannelTestPluginBase({ id: "mattermost" }),
            actions: {
              extractToolSend: ({ args }: { args: Record<string, unknown> }) => {
                if (args.action !== "send" || typeof args.to !== "string") {
                  return null;
                }
                const threadId =
                  typeof args.replyToId === "string"
                    ? args.replyToId
                    : typeof args.replyTo === "string"
                      ? args.replyTo
                      : undefined;
                const threadSuppressed = args.topLevel === true || args.threadId === null;
                return {
                  to: args.to,
                  threadId,
                  threadImplicit: !threadId && !threadSuppressed,
                  threadSuppressed,
                };
              },
            },
            threading: {
              resolveAutoThreadId: ({
                to,
                replyToId,
                toolContext,
              }: {
                to: string;
                replyToId?: string | null;
                toolContext?: {
                  currentChannelId?: string;
                  currentThreadTs?: string;
                  currentMessageId?: string | number;
                  replyToMode?: "off" | "first" | "all" | "batched";
                  hasRepliedRef?: { value: boolean };
                };
              }) => {
                if (replyToId) {
                  const currentMessageId =
                    typeof toolContext?.currentMessageId === "number"
                      ? String(toolContext.currentMessageId)
                      : toolContext?.currentMessageId;
                  if (replyToId !== currentMessageId) {
                    return replyToId;
                  }
                }
                if (to !== toolContext?.currentChannelId || !toolContext.currentThreadTs) {
                  return undefined;
                }
                return toolContext.currentThreadTs;
              },
              resolveReplyTransport: ({
                threadId,
                replyToId,
              }: {
                threadId?: string | number | null;
                replyToId?: string | null;
              }) => {
                const resolvedThreadId =
                  replyToId ?? (threadId != null ? String(threadId) : undefined);
                return {
                  replyToId: resolvedThreadId,
                  threadId: resolvedThreadId,
                };
              },
            },
          },
          source: "test",
        },
        {
          pluginId: "numeric-thread",
          plugin: {
            ...createChannelTestPluginBase({ id: "numeric-thread" }),
            threading: {
              resolveReplyTransport: () => ({
                threadId: 42,
              }),
            },
          },
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

  it("accepts channelId alias when earlier target aliases are blank", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      target: " ",
      to: "",
      channelId: "123",
    });

    expect(result?.tool).toBe("message");
    expect(result?.provider).toBe("telegram");
    expect(result?.to).toBe("telegram:123");
  });

  it("prefers canonical target over legacy target aliases", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      channel: "telegram",
      target: "123",
      to: "456",
      channelId: "789",
    });

    expect(result?.to).toBe("telegram:123");
  });

  it.each(["poll", "reply", "sticker"] as const)(
    "extracts target evidence for visible %s actions",
    (action) => {
      const result = extractMessagingToolSend("message", {
        action,
        provider: "slack",
        target: "Channel:C1",
      });

      expect(result).toMatchObject({
        tool: "message",
        provider: "slack",
        to: "channel:c1",
      });
    },
  );

  it("extracts implicit current-target evidence for visible reply actions", () => {
    const result = extractMessagingToolSend(
      "message",
      {
        action: "reply",
        provider: "slack",
      },
      {
        currentChannelId: "channel:c1",
        currentMessagingTarget: "user:u123",
      },
    );

    expect(result).toMatchObject({
      tool: "message",
      provider: "slack",
      to: "user:u123",
    });
  });

  it("extracts provider-declared target aliases for visible reply actions", () => {
    const result = extractMessagingToolSend("message", {
      action: "reply",
      provider: "slack",
      chatGuid: "Channel:C1",
    });

    expect(result).toMatchObject({
      tool: "message",
      provider: "slack",
      to: "channel:c1",
    });
  });

  it("does not treat provider message-id aliases as delivery targets", () => {
    const result = extractMessagingToolSend(
      "message",
      {
        action: "reply",
        provider: "slack",
        messageId: "message-1",
      },
      {
        currentMessagingTarget: "user:u123",
      },
    );

    expect(result).toMatchObject({
      tool: "message",
      provider: "slack",
      to: "user:u123",
    });
    expect(
      extractMessagingToolSend("message", {
        action: "reply",
        provider: "slack",
        messageId: "message-1",
      }),
    ).toBeUndefined();
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

  it("keeps explicit thread evidence when the message provider is implicit", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      to: "channel:123",
      threadId: "456",
      content: "done",
    });

    expect(result?.provider).toBe("message");
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

  it("captures the active session thread for implicit threaded sends", () => {
    const result = extractMessagingToolSend(
      "message",
      {
        action: "send",
        provider: "telegram",
        to: "123",
        content: "done",
      },
      {
        currentChannelId: "telegram:123",
        currentThreadId: "456",
        replyToMode: "all",
      },
    );

    expect(result?.threadImplicit).toBe(true);
    expect(result?.threadId).toBe("456");
  });

  it("captures the active Slack DM thread through its routable target", () => {
    const result = extractMessagingToolSend(
      "message",
      {
        action: "send",
        provider: "slack",
        to: "user:U123",
        content: "done",
      },
      {
        currentChannelId: "D123",
        currentMessagingTarget: "user:u123",
        currentThreadId: "171.222",
        replyToMode: "all",
      },
    );

    expect(result).toMatchObject({
      provider: "slack",
      to: "user:u123",
      threadId: "171.222",
      threadImplicit: true,
    });
  });

  it("does not attach the ambient thread to an explicit topic target", () => {
    const result = extractMessagingToolSend(
      "message",
      {
        action: "send",
        provider: "telegram",
        to: "-1001:topic:99",
        content: "done",
      },
      {
        currentChannelId: "telegram:-1001:topic:77",
        currentThreadId: "77",
      },
    );

    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBeUndefined();
  });

  it("does not attach the ambient thread when reply mode disables auto-threading", () => {
    const result = extractMessagingToolSend(
      "message",
      {
        action: "send",
        provider: "slack",
        to: "channel:C1",
        content: "done",
      },
      {
        currentChannelId: "channel:c1",
        currentThreadId: "171.222",
        replyToMode: "off",
      },
    );

    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBeUndefined();
  });

  it("defaults implicit threaded sends to all mode when reply mode is omitted", () => {
    const result = extractMessagingToolSend(
      "message",
      {
        action: "send",
        provider: "slack",
        to: "channel:C1",
        content: "done",
      },
      {
        currentChannelId: "channel:c1",
        currentThreadId: "171.222",
      },
    );

    expect(result?.threadImplicit).toBe(true);
    expect(result?.threadId).toBe("171.222");
  });

  it("records an explicit Slack replyTo as the destination thread", () => {
    const result = extractMessagingToolSend(
      "message",
      {
        action: "send",
        provider: "slack",
        to: "channel:C1",
        replyTo: "999.000",
        content: "done",
      },
      {
        currentChannelId: "channel:c1",
        currentThreadId: "171.222",
        replyToMode: "all",
      },
    );

    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBe("999.000");
  });

  it("uses Slack transport precedence when threadId and replyTo are both present", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      provider: "slack",
      to: "channel:C1",
      threadId: "111.000",
      replyTo: "999.000",
      content: "done",
    });

    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBe("999.000");
  });

  it("keeps plugin-action thread precedence outside normal sends", () => {
    const result = extractMessagingToolSend("message", {
      action: "upload-file",
      provider: "slack",
      to: "channel:C1",
      threadId: "111.000",
      replyTo: "999.000",
      path: "/tmp/report.pdf",
    });

    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBe("111.000");
  });

  it("records a plugin-dispatched upload reply target", () => {
    const result = extractMessagingToolSend("message", {
      action: "upload-file",
      provider: "slack",
      to: "channel:C1",
      replyTo: "999.000",
      path: "/tmp/report.pdf",
    });

    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBe("999.000");
  });

  it("records a plugin-dispatched upload reply target with the target alias", () => {
    const result = extractMessagingToolSend("message", {
      action: "upload-file",
      provider: "slack",
      target: "channel:C1",
      replyTo: "999.000",
      path: "/tmp/report.pdf",
    });

    expect(result?.to).toBe("channel:c1");
    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBe("999.000");
  });

  it("does not treat a Discord replyTo as a destination thread", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      provider: "discord",
      to: "channel:123",
      replyTo: "native-message-1",
      content: "done",
    });

    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBeUndefined();
  });

  it("records a Mattermost replyTo as the destination thread", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      provider: "mattermost",
      to: "channel:123",
      replyTo: "post-1",
      content: "done",
    });

    expect(result?.threadId).toBe("post-1");
  });

  it("captures the active Mattermost root for implicit sends", () => {
    const result = extractMessagingToolSend(
      "message",
      {
        action: "send",
        provider: "mattermost",
        to: "channel:123",
        content: "done",
      },
      {
        currentChannelId: "channel:123",
        currentThreadId: "root-1",
        currentMessageId: "child-1",
        replyToMode: "off",
      },
    );

    expect(result).toMatchObject({
      provider: "mattermost",
      to: "channel:123",
      threadId: "root-1",
      threadImplicit: true,
    });
  });

  it("preserves numeric thread ids returned by provider transport resolution", () => {
    const result = extractMessagingToolSend("message", {
      action: "send",
      provider: "numeric-thread",
      to: "channel:123",
      replyTo: "post-1",
      content: "done",
    });

    expect(result?.threadId).toBe("42");
  });

  it("keeps provider-tool extracted thread id evidence", () => {
    const result = extractMessagingToolSend("slack", {
      action: "sendMessage",
      to: " Channel:C1 ",
      threadTs: "171.222",
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

  it("captures the active thread for native provider sends", () => {
    const result = extractMessagingToolSend(
      "slack",
      {
        action: "sendMessage",
        to: "Channel:C1",
        content: "done",
      },
      {
        currentChannelId: "channel:c1",
        currentThreadId: "171.222",
        replyToMode: "all",
      },
    );

    expect(result).toMatchObject({
      provider: "slack",
      to: "channel:c1",
      threadId: "171.222",
      threadImplicit: true,
    });
  });

  it.each([
    { name: "missing reply mode", options: { currentThreadId: "171.222" } },
    {
      name: "single-use mode without reply state",
      options: { currentThreadId: "171.222", replyToMode: "first" as const },
    },
  ])("does not infer native provider threads with $name", ({ options }) => {
    const result = extractMessagingToolSend(
      "slack",
      {
        action: "sendMessage",
        to: "Channel:C1",
        content: "done",
      },
      {
        currentChannelId: "channel:c1",
        ...options,
      },
    );

    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBeUndefined();
  });

  it("infers a native first-mode thread when reply state is available", () => {
    const hasRepliedRef = { value: false };
    const result = extractMessagingToolSend(
      "slack",
      {
        action: "sendMessage",
        to: "Channel:C1",
        content: "done",
      },
      {
        currentChannelId: "channel:c1",
        currentThreadId: "171.222",
        replyToMode: "first",
        hasRepliedRef,
      },
    );

    expect(result?.threadImplicit).toBe(true);
    expect(result?.threadId).toBe("171.222");
    expect(hasRepliedRef.value).toBe(false);
  });

  it("captures the active thread for native provider uploads", () => {
    const result = extractMessagingToolSend(
      "slack",
      {
        action: "uploadFile",
        to: "Channel:C1",
        filePath: "/tmp/report.png",
      },
      {
        currentChannelId: "channel:c1",
        currentThreadId: "171.222",
        replyToMode: "all",
      },
    );

    expect(result).toMatchObject({
      provider: "slack",
      to: "channel:c1",
      threadId: "171.222",
      threadImplicit: true,
    });
  });

  it("does not infer ambient threads for native providers that do not opt in", () => {
    const result = extractMessagingToolSend(
      "telegram",
      {
        action: "sendMessage",
        to: "123",
        content: "done",
      },
      {
        currentChannelId: "telegram:123",
        currentThreadId: "456",
        replyToMode: "all",
      },
    );

    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBeUndefined();
  });

  it("records native provider sends that suppress ambient threading", () => {
    const result = extractMessagingToolSend(
      "slack",
      {
        action: "sendMessage",
        to: "Channel:C1",
        topLevel: true,
        content: "done",
      },
      {
        currentChannelId: "channel:c1",
        currentThreadId: "171.222",
        replyToMode: "all",
      },
    );

    expect(result?.threadSuppressed).toBe(true);
    expect(result?.threadImplicit).toBeUndefined();
    expect(result?.threadId).toBeUndefined();
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
