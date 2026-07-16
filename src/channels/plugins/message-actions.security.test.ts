// Message action security tests cover channel message action authorization and validation.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResult } from "../../agents/tools/common.js";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { dispatchChannelMessageAction } from "./message-action-dispatch.js";
import type { ChannelMessageActionContext, ChannelPlugin } from "./types.js";

const handleAction = vi.fn(async (_ctx: ChannelMessageActionContext) => jsonResult({ ok: true }));

const emptyRegistry = createTestRegistry([]);

const discordPlugin: ChannelPlugin = {
  ...createChannelTestPluginBase({
    id: "discord",
    label: "Discord",
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => ["default"],
    },
  }),
  actions: {
    describeMessageTool: () => ({ actions: ["kick"] }),
    supportsAction: ({ action }) => action === "kick",
    requiresTrustedRequesterSender: ({ action, toolContext }) =>
      Boolean(action === "kick" && toolContext),
    handleAction,
  },
};

describe("dispatchChannelMessageAction trusted sender guard", () => {
  beforeEach(() => {
    handleAction.mockClear();
    setActivePluginRegistry(
      createTestRegistry([{ pluginId: "discord", source: "test", plugin: discordPlugin }]),
    );
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("rejects privileged discord moderation action without trusted sender in tool context", async () => {
    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "kick",
        cfg: {} as OpenClawConfig,
        params: { guildId: "g1", userId: "u1" },
        toolContext: { currentChannelProvider: "discord" },
      }),
    ).rejects.toThrow("Trusted sender identity is required for discord:kick");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("allows privileged discord moderation action with trusted sender in tool context", async () => {
    await dispatchChannelMessageAction({
      channel: "discord",
      action: "kick",
      cfg: {} as OpenClawConfig,
      params: { guildId: "g1", userId: "u1" },
      requesterSenderId: "trusted-user",
      toolContext: { currentChannelProvider: "discord" },
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("does not require trusted sender without tool context", async () => {
    await dispatchChannelMessageAction({
      channel: "discord",
      action: "kick",
      cfg: {} as OpenClawConfig,
      params: { guildId: "g1", userId: "u1" },
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });
});

describe("dispatchChannelMessageAction conversation-read provenance", () => {
  const supportsAction = vi.fn(() => true);
  const requiresTrustedRequesterSender = vi.fn(() => false);

  function setReadPlugin(params?: {
    channel?: ChannelPlugin["id"];
    origin?: string;
    strayPolicy?: string;
    normalizeTarget?: (raw: string) => string | undefined;
    targetPrefixes?: readonly string[];
    messageActionTargetAliases?: NonNullable<
      NonNullable<ChannelPlugin["actions"]>["messageActionTargetAliases"]
    >;
  }) {
    const channel = params?.channel ?? "discord";
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: channel,
        label: channel,
        capabilities: { chatTypes: ["direct", "group"] },
        config: {
          listAccountIds: () => ["default"],
        },
      }),
      ...(params?.normalizeTarget || params?.targetPrefixes
        ? {
            messaging: {
              normalizeTarget: params.normalizeTarget,
              targetPrefixes: params.targetPrefixes,
            },
          }
        : {}),
      actions: {
        ...(params?.strayPolicy
          ? ({ conversationReadPolicy: params.strayPolicy } as Record<string, unknown>)
          : {}),
        describeMessageTool: () => ({ actions: ["read", "send"] }),
        supportsAction,
        requiresTrustedRequesterSender,
        messageActionTargetAliases: params?.messageActionTargetAliases,
        handleAction,
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: channel,
          source: "test",
          plugin,
          ...(params?.origin ? { origin: params.origin as never } : {}),
        },
      ]),
    );
  }

  beforeEach(() => {
    handleAction.mockClear();
    supportsAction.mockClear();
    requiresTrustedRequesterSender.mockClear();
  });

  afterEach(() => {
    setActivePluginRegistry(emptyRegistry);
  });

  it("allows a non-bundled delegated read of the exact current conversation and account", async () => {
    setReadPlugin();

    await dispatchChannelMessageAction({
      channel: "discord",
      action: "read",
      cfg: {} as OpenClawConfig,
      params: { channelId: "channel:current" },
      accountId: "Work",
      requesterAccountId: "work",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "discord:channel:current",
      },
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("matches a sanitized channelId to a typed current-channel target", async () => {
    setReadPlugin();

    await dispatchChannelMessageAction({
      channel: "discord",
      action: "read",
      cfg: {} as OpenClawConfig,
      params: {
        target: "current",
        channelId: "current",
      },
      accountId: "default",
      requesterAccountId: "default",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "discord",
        currentChannelId: "channel:current",
      },
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "cross-conversation target",
      params: { channelId: "other" },
      accountId: "default",
      requesterAccountId: "default",
    },
    {
      name: "missing target",
      params: {},
      accountId: "default",
      requesterAccountId: "default",
    },
    {
      name: "wrong account",
      params: { channelId: "current" },
      accountId: "other",
      requesterAccountId: "default",
    },
    {
      name: "missing requester account",
      params: { channelId: "current" },
      accountId: "default",
      requesterAccountId: undefined,
    },
    {
      name: "invalid account",
      params: { channelId: "current" },
      accountId: "!!!",
      requesterAccountId: "default",
    },
    {
      name: "missing current provider",
      params: { channelId: "current" },
      accountId: "default",
      requesterAccountId: "default",
      currentChannelProvider: undefined,
    },
    {
      name: "different current provider",
      params: { channelId: "current" },
      accountId: "default",
      requesterAccountId: "default",
      currentChannelProvider: "slack",
    },
  ])("rejects a non-bundled delegated read with $name before plugin code", async (testCase) => {
    setReadPlugin();

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: testCase.params,
        accountId: testCase.accountId,
        requesterAccountId: testCase.requesterAccountId,
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider:
            "currentChannelProvider" in testCase ? testCase.currentChannelProvider : "discord",
          currentChannelId: "current",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(supportsAction).not.toHaveBeenCalled();
    expect(requiresTrustedRequesterSender).not.toHaveBeenCalled();
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("allows direct operators through a non-bundled adapter", async () => {
    setReadPlugin();

    await dispatchChannelMessageAction({
      channel: "discord",
      action: "read",
      cfg: {} as OpenClawConfig,
      params: { channelId: "other" },
      conversationReadOrigin: "direct-operator",
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("does not confuse user and channel targets that share an identifier", async () => {
    setReadPlugin();

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: { channelId: "channel:123" },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentMessagingTarget: "user:123",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("does not match a typed request to an untyped current target", async () => {
    setReadPlugin();

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: { target: "user:123" },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "123",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("does not let a bare current-channel alias erase a trusted target kind", async () => {
    setReadPlugin();

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          target: "channel:123",
          channelId: "123",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "123",
          currentMessagingTarget: "user:123",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("fails closed when trusted current targets disagree on semantic kind", async () => {
    setReadPlugin();

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          target: "123",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "channel:123",
          currentMessagingTarget: "user:123",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("rejects conflicting target aliases even when one names the current conversation", async () => {
    setReadPlugin();

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          channelId: "current",
          target: "channel:other",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "channel:current",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("keeps non-read actions compatible on a non-bundled adapter", async () => {
    setReadPlugin();

    await dispatchChannelMessageAction({
      channel: "discord",
      action: "send",
      cfg: {} as OpenClawConfig,
      params: { to: "other" },
      conversationReadOrigin: "delegated",
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("delegates configured-target policy to a bundled adapter", async () => {
    setReadPlugin({ origin: "bundled" });

    await dispatchChannelMessageAction({
      channel: "discord",
      action: "read",
      cfg: {} as OpenClawConfig,
      params: { channelId: "configured" },
      conversationReadOrigin: "delegated",
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("keeps unaudited bundled adapters on the exact-current host limit", async () => {
    setReadPlugin({ channel: "telegram", origin: "bundled" });

    await expect(
      dispatchChannelMessageAction({
        channel: "telegram",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: { channelId: "configured" },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "telegram",
          currentChannelId: "current",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("uses bundled provider target normalization for equivalent exact-current forms", async () => {
    const normalizeTarget = vi.fn((raw: string) => {
      const room = raw
        .trim()
        .replace(/^(?:nextcloud-talk|nc-talk|nc):/i, "")
        .replace(/^room:/i, "")
        .trim();
      return room ? `nextcloud-talk:${room.toLowerCase()}` : undefined;
    });
    setReadPlugin({
      channel: "nextcloud-talk",
      origin: "bundled",
      normalizeTarget,
    });

    await dispatchChannelMessageAction({
      channel: "nextcloud-talk",
      action: "read",
      cfg: {} as OpenClawConfig,
      params: { to: "nc:room:Current" },
      accountId: "default",
      requesterAccountId: "default",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "nextcloud-talk",
        currentChannelId: "nextcloud-talk:current",
      },
    });

    expect(normalizeTarget).toHaveBeenCalled();
    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("does not use an external provider normalizer to widen delegated reads", async () => {
    const normalizeTarget = vi.fn(() => "discord:channel:current");
    setReadPlugin({
      channel: "discord",
      origin: "workspace",
      normalizeTarget,
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: { channelId: "other" },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "channel:current",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(normalizeTarget).not.toHaveBeenCalled();
    expect(handleAction).not.toHaveBeenCalled();
  });

  it.each(["nextcloud-talk:current", "nc-talk:current", "nc:current", "room:current"])(
    "allows the external exact-current provider spelling %s",
    async (target) => {
      const normalizeTarget = vi.fn(() => "nextcloud-talk:other");
      setReadPlugin({
        channel: "nextcloud-talk",
        origin: "workspace",
        targetPrefixes: ["nextcloud-talk", "nc-talk", "nc"],
        normalizeTarget,
      });

      await dispatchChannelMessageAction({
        channel: "nextcloud-talk",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          target,
          to: "nextcloud-talk:current",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "nextcloud-talk",
          currentChannelId: "nextcloud-talk:current",
          currentChatType: "group",
        },
      });

      expect(normalizeTarget).not.toHaveBeenCalled();
      expect(handleAction.mock.calls[0]?.[0].params.target).toBe("nextcloud-talk:current");
      expect(handleAction).toHaveBeenCalledOnce();
    },
  );

  it("does not let an external provider prefix erase a conflicting target kind", async () => {
    setReadPlugin({
      channel: "nextcloud-talk",
      origin: "workspace",
      targetPrefixes: ["user"],
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "nextcloud-talk",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          target: "user:current",
          to: "nextcloud-talk:current",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "nextcloud-talk",
          currentChannelId: "nextcloud-talk:current",
          currentChatType: "group",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("requires a canonical sibling before accepting a typed external room target", async () => {
    setReadPlugin({
      channel: "nextcloud-talk",
      origin: "workspace",
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "nextcloud-talk",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          target: "room:current",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "nextcloud-talk",
          currentChannelId: "nextcloud-talk:current",
          currentChatType: "group",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("does not confuse group and channel targets that share an identifier", async () => {
    setReadPlugin({
      channel: "nextcloud-talk",
      origin: "workspace",
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "nextcloud-talk",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          target: "group:current",
          to: "nextcloud-talk:current",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "nextcloud-talk",
          currentChannelId: "nextcloud-talk:current",
          currentChatType: "channel",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("does not let failed bundled target normalization fall through as resource-only", async () => {
    setReadPlugin({
      channel: "imessage",
      origin: "bundled",
      normalizeTarget: (raw) => (raw.includes("current") ? raw : undefined),
      messageActionTargetAliases: {
        read: {
          aliases: ["messageId"],
        },
      },
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "imessage",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          target: "malformed-target",
          to: "chat_guid:iMessage;+;current",
          messageId: "current-message",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "imessage",
          currentChannelId: "chat_guid:iMessage;+;current",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("uses bundled delivery aliases for an exact-current provider target", async () => {
    const resolveDeliveryTarget = vi.fn(({ args }: { args: Record<string, unknown> }) => {
      const chatGuid = typeof args.chatGuid === "string" ? args.chatGuid.trim() : "";
      return chatGuid ? `chat_guid:${chatGuid}` : undefined;
    });
    setReadPlugin({
      channel: "imessage",
      origin: "bundled",
      normalizeTarget: (raw) => raw.trim() || undefined,
      messageActionTargetAliases: {
        read: {
          aliases: ["chatGuid", "messageId"],
          deliveryTargetAliases: ["chatGuid"],
          resolveDeliveryTarget,
        },
      },
    });

    await dispatchChannelMessageAction({
      channel: "imessage",
      action: "read",
      cfg: {} as OpenClawConfig,
      params: { chatGuid: "iMessage;+;current" },
      accountId: "default",
      requesterAccountId: "default",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "imessage",
        currentChannelId: "chat_guid:iMessage;+;current",
      },
    });

    expect(resolveDeliveryTarget).toHaveBeenCalledOnce();
    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("uses a bundled numeric chatId delivery alias for an exact-current provider target", async () => {
    const resolveDeliveryTarget = vi.fn(({ args }: { args: Record<string, unknown> }) =>
      typeof args.chatId === "number" && Number.isInteger(args.chatId) && args.chatId > 0
        ? `chat_id:${args.chatId}`
        : undefined,
    );
    setReadPlugin({
      channel: "imessage",
      origin: "bundled",
      normalizeTarget: (raw) => raw.trim() || undefined,
      messageActionTargetAliases: {
        react: {
          aliases: ["chatId", "messageId"],
          deliveryTargetAliases: ["chatId"],
          resolveDeliveryTarget,
        },
      },
    });

    await dispatchChannelMessageAction({
      channel: "imessage",
      action: "react",
      cfg: {} as OpenClawConfig,
      params: { chatId: 42, messageId: "current-message" },
      accountId: "default",
      requesterAccountId: "default",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "imessage",
        currentChannelId: "chat_id:42",
      },
    });

    expect(resolveDeliveryTarget).toHaveBeenCalledOnce();
    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("uses a bundled owner matcher for equivalent provider-native current targets", async () => {
    const matchesCurrentConversation = vi.fn(() => true);
    setReadPlugin({
      channel: "imessage",
      origin: "bundled",
      normalizeTarget: (raw) => raw.trim() || undefined,
      messageActionTargetAliases: {
        react: {
          aliases: ["chatId", "messageId"],
          deliveryTargetAliases: ["chatId"],
          resolveDeliveryTarget: ({ args }) => `chat_id:${String(args.chatId)}`,
          matchesCurrentConversation,
        },
      },
    });

    await dispatchChannelMessageAction({
      channel: "imessage",
      action: "react",
      cfg: {} as OpenClawConfig,
      params: { chatId: 42, messageId: "current-message" },
      accountId: "Work",
      requesterAccountId: "work",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "imessage",
        currentChannelId: "imessage:current-handle",
        currentMessageId: "current-message",
      },
    });

    expect(matchesCurrentConversation).toHaveBeenCalledWith({
      args: { chatId: 42, messageId: "current-message" },
      accountId: "work",
      toolContext: {
        currentChannelProvider: "imessage",
        currentChannelId: "imessage:current-handle",
        currentMessageId: "current-message",
      },
    });
    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("does not mistake a normalized delivery alias target for a conflicting target", async () => {
    const matchesCurrentConversation = vi.fn(() => true);
    setReadPlugin({
      channel: "imessage",
      origin: "bundled",
      messageActionTargetAliases: {
        react: {
          aliases: ["chatId", "messageId"],
          deliveryTargetAliases: ["chatId"],
          resolveDeliveryTarget: ({ args }) => `chat_id:${String(args.chatId)}`,
          matchesCurrentConversation,
        },
      },
    });

    const normalizedAliasTarget = "chat_id:42";
    await dispatchChannelMessageAction({
      channel: "imessage",
      action: "react",
      cfg: {} as OpenClawConfig,
      params: {
        target: normalizedAliasTarget,
        to: normalizedAliasTarget,
        chatId: 42,
        messageId: "current-message",
      },
      accountId: "default",
      requesterAccountId: "default",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "imessage",
        currentChannelId: "current-handle",
        currentMessageId: "current-message",
      },
    });

    expect(matchesCurrentConversation).toHaveBeenCalledOnce();
    expect(handleAction).toHaveBeenCalledOnce();
  });

  it("fails closed when a bundled owner matcher cannot prove alias equivalence", async () => {
    const matchesCurrentConversation = vi.fn(() => false);
    setReadPlugin({
      channel: "imessage",
      origin: "bundled",
      messageActionTargetAliases: {
        react: {
          aliases: ["chatId", "messageId"],
          deliveryTargetAliases: ["chatId"],
          resolveDeliveryTarget: ({ args }) => `chat_id:${String(args.chatId)}`,
          matchesCurrentConversation,
        },
      },
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "imessage",
        action: "react",
        cfg: {} as OpenClawConfig,
        params: { chatId: 42, messageId: "current-message" },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "imessage",
          currentChannelId: "current-handle",
          currentMessageId: "current-message",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(matchesCurrentConversation).toHaveBeenCalledOnce();
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("does not consult an external plugin owner matcher", async () => {
    const matchesCurrentConversation = vi.fn(() => true);
    setReadPlugin({
      channel: "imessage",
      origin: "workspace",
      messageActionTargetAliases: {
        react: {
          aliases: ["chatId", "messageId"],
          deliveryTargetAliases: ["chatId"],
          resolveDeliveryTarget: ({ args }) => `chat_id:${String(args.chatId)}`,
          matchesCurrentConversation,
        },
      },
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "imessage",
        action: "react",
        cfg: {} as OpenClawConfig,
        params: { chatId: 42, messageId: "current-message" },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "imessage",
          currentChannelId: "current-handle",
          currentMessageId: "current-message",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(matchesCurrentConversation).not.toHaveBeenCalled();
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("does not let an alias matcher override a conflicting canonical target", async () => {
    const matchesCurrentConversation = vi.fn(() => true);
    setReadPlugin({
      channel: "imessage",
      origin: "bundled",
      messageActionTargetAliases: {
        react: {
          aliases: ["chatId", "messageId"],
          deliveryTargetAliases: ["chatId"],
          resolveDeliveryTarget: ({ args }) => `chat_id:${String(args.chatId)}`,
          matchesCurrentConversation,
        },
      },
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "imessage",
        action: "react",
        cfg: {} as OpenClawConfig,
        params: {
          target: "other-handle",
          chatId: 42,
          messageId: "current-message",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "imessage",
          currentChannelId: "current-handle",
          currentMessageId: "current-message",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(matchesCurrentConversation).not.toHaveBeenCalled();
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("rejects an unnormalizable bundled delivery alias even with a valid sibling target", async () => {
    setReadPlugin({
      channel: "imessage",
      origin: "bundled",
      normalizeTarget: (raw) => (raw.includes("current") ? raw : undefined),
      messageActionTargetAliases: {
        read: {
          aliases: ["chatGuid"],
          deliveryTargetAliases: ["chatGuid"],
          resolveDeliveryTarget: ({ args }) =>
            typeof args.chatGuid === "string" ? `chat_guid:${args.chatGuid}` : undefined,
        },
      },
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "imessage",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          to: "chat_guid:iMessage;+;current",
          chatGuid: "iMessage;+;other",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "imessage",
          currentChannelId: "chat_guid:iMessage;+;current",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it.each([
    { action: "react" as const, params: { messageId: "current-message" } },
    { action: "edit" as const, params: { messageId: "current-message" } },
    { action: "unsend" as const, params: { messageId: "current-message" } },
    { action: "poll-vote" as const, params: { pollId: "current-poll" } },
  ])(
    "does not treat bundled $action resource-only input as conversation authority",
    async (testCase) => {
      setReadPlugin({
        channel: "imessage",
        origin: "bundled",
        messageActionTargetAliases: {
          [testCase.action]: {
            aliases: Object.keys(testCase.params),
          },
        },
      });

      await expect(
        dispatchChannelMessageAction({
          channel: "imessage",
          action: testCase.action,
          cfg: {} as OpenClawConfig,
          params: testCase.params,
          accountId: "work",
          requesterAccountId: "work",
          conversationReadOrigin: "delegated",
          toolContext: {
            currentChannelProvider: "imessage",
            currentChannelId: "chat_guid:iMessage;+;current",
          },
        }),
      ).rejects.toThrow("requires the exact current conversation and account");
      expect(handleAction).not.toHaveBeenCalled();
    },
  );

  it("does not let a bundled resource id override an explicit cross-conversation target", async () => {
    setReadPlugin({
      channel: "imessage",
      origin: "bundled",
      messageActionTargetAliases: {
        read: {
          aliases: ["messageId"],
        },
      },
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "imessage",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: {
          target: "chat_guid:iMessage;+;other",
          messageId: "current-message",
        },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "imessage",
          currentChannelId: "chat_guid:iMessage;+;current",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("does not let an external resource alias opt into targetless delegated reads", async () => {
    const resolveDeliveryTarget = vi.fn(() => "chat_guid:iMessage;+;current");
    setReadPlugin({
      channel: "imessage",
      origin: "workspace",
      messageActionTargetAliases: {
        read: {
          aliases: ["messageId"],
          resolveDeliveryTarget,
        },
      },
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "imessage",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: { messageId: "current-message" },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "imessage",
          currentChannelId: "chat_guid:iMessage;+;current",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(resolveDeliveryTarget).not.toHaveBeenCalled();
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("allows bundled targetless sticker-cache reads only in matching current context", async () => {
    setReadPlugin({ channel: "telegram", origin: "bundled" });

    await dispatchChannelMessageAction({
      channel: "telegram",
      action: "sticker-search",
      cfg: {} as OpenClawConfig,
      params: { query: "party", limit: 5 },
      accountId: "work",
      requesterAccountId: "work",
      conversationReadOrigin: "delegated",
      toolContext: {
        currentChannelProvider: "telegram",
        currentChannelId: "123",
      },
    });

    expect(handleAction).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "missing current provider",
      accountId: "default",
      requesterAccountId: "default",
      currentChannelProvider: undefined,
    },
    {
      name: "wrong current provider",
      accountId: "default",
      requesterAccountId: "default",
      currentChannelProvider: "discord",
    },
    {
      name: "wrong account",
      accountId: "other",
      requesterAccountId: "default",
      currentChannelProvider: "telegram",
      currentChannelId: "123",
    },
    {
      name: "missing current target",
      accountId: "default",
      requesterAccountId: "default",
      currentChannelProvider: "telegram",
      currentChannelId: undefined,
    },
  ])("rejects bundled targetless sticker-cache reads with $name", async (testCase) => {
    setReadPlugin({ channel: "telegram", origin: "bundled" });

    await expect(
      dispatchChannelMessageAction({
        channel: "telegram",
        action: "sticker-search",
        cfg: {} as OpenClawConfig,
        params: { query: "party", limit: 5 },
        accountId: testCase.accountId,
        requesterAccountId: testCase.requesterAccountId,
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: testCase.currentChannelProvider,
          currentChannelId: "currentChannelId" in testCase ? testCase.currentChannelId : "123",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it("does not let an external adapter opt into bundled behavior with a stray property", async () => {
    setReadPlugin({
      origin: "workspace",
      strayPolicy: "current-or-configured-v1",
    });

    await expect(
      dispatchChannelMessageAction({
        channel: "discord",
        action: "read",
        cfg: {} as OpenClawConfig,
        params: { channelId: "configured" },
        accountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelProvider: "discord",
          currentChannelId: "current",
        },
      }),
    ).rejects.toThrow("requires the exact current conversation and account");
    expect(handleAction).not.toHaveBeenCalled();
  });

  it.each([undefined, "unknown", "global", "workspace", "config"] as const)(
    "treats %s channel provenance as non-bundled",
    async (origin) => {
      setReadPlugin(origin ? { origin } : undefined);

      await expect(
        dispatchChannelMessageAction({
          channel: "discord",
          action: "read",
          cfg: {} as OpenClawConfig,
          params: { channelId: "configured" },
          accountId: "default",
          requesterAccountId: "default",
          conversationReadOrigin: "delegated",
          toolContext: {
            currentChannelProvider: "discord",
            currentChannelId: "current",
          },
        }),
      ).rejects.toThrow("requires the exact current conversation and account");
      expect(handleAction).not.toHaveBeenCalled();
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
