// Conversation resolution tests cover channel conversation lookup and fallback rules.
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  resolveChannelDefaultBindingPlacement,
  resolveCommandConversationResolution,
  resolveInboundConversationResolution,
} from "./conversation-resolution.js";
import type { ChannelPlugin } from "./plugins/types.plugin.js";

const testConfig = {} as OpenClawConfig;

function registerChannelPlugin(plugin: ChannelPlugin): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: plugin.id,
        source: "test",
        plugin,
      },
    ]),
  );
}

function createBindingProviderDefaults(): Pick<
  NonNullable<ChannelPlugin["bindings"]>,
  "compileConfiguredBinding" | "matchInboundConversation"
> {
  return {
    compileConfiguredBinding: (_params) => null,
    matchInboundConversation: (_params) => null,
  };
}

describe("conversation resolution", () => {
  afterEach(() => {
    setActivePluginRegistry(createTestRegistry());
  });

  it("uses the runtime command resolver and plugin default account", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({
        id: "discord",
        label: "Discord",
        config: {
          defaultAccountId: () => "work",
        },
      }),
      bindings: {
        ...createBindingProviderDefaults(),
        resolveCommandConversation: ({ originatingTo }) => {
          const conversationId = originatingTo?.trim().replace(/^discord:/i, "");
          return conversationId ? { conversationId } : null;
        },
      },
    });

    expect(
      resolveCommandConversationResolution({
        cfg: testConfig,
        channel: "discord",
        originatingTo: "discord:channel:123",
      }),
    ).toEqual({
      channel: "discord",
      accountId: "work",
      conversationId: "channel:123",
    });
  });

  it("applies provider-owned self-parent defaults in one core path", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "line", label: "LINE" }),
      bindings: {
        ...createBindingProviderDefaults(),
        selfParentConversationByDefault: true,
        resolveCommandConversation: () => ({
          conversationId: "user:U1234567890abcdef1234567890abcdef",
        }),
      },
    });

    expect(
      resolveCommandConversationResolution({
        cfg: testConfig,
        channel: "line",
        accountId: "default",
        originatingTo: "line:user:U1234567890abcdef1234567890abcdef",
      }),
    ).toEqual({
      channel: "line",
      accountId: "default",
      conversationId: "user:U1234567890abcdef1234567890abcdef",
      parentConversationId: "user:U1234567890abcdef1234567890abcdef",
    });
  });

  it.each(["command", "threading"] as const)(
    "normalizes conversation ids returned by the %s resolver",
    (resolver) => {
      const conversation = {
        conversationId: "  user:U1234567890abcdef1234567890abcdef  ",
        parentConversationId: "  room:R1234567890abcdef1234567890abcd  ",
      };
      registerChannelPlugin({
        ...createChannelTestPluginBase({ id: "line", label: "LINE" }),
        ...(resolver === "command"
          ? {
              bindings: {
                ...createBindingProviderDefaults(),
                resolveCommandConversation: () => conversation,
              },
            }
          : {
              threading: {
                resolveFocusedBinding: () => ({
                  ...conversation,
                  placement: "current" as const,
                  labelNoun: "conversation",
                }),
              },
            }),
      });

      expect(
        resolveCommandConversationResolution({
          cfg: testConfig,
          channel: "line",
          accountId: " default ",
          originatingTo: "ignored",
        }),
      ).toEqual({
        channel: "line",
        accountId: "default",
        conversationId: "user:U1234567890abcdef1234567890abcdef",
        parentConversationId: "room:R1234567890abcdef1234567890abcd",
      });
    },
  );

  it("falls back from command context to channel-prefixed parent plus explicit thread", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "test-chat", label: "Test chat" }),
    });

    expect(
      resolveCommandConversationResolution({
        cfg: testConfig,
        channel: "test-chat",
        accountId: "default",
        originatingTo: "test-chat:channel:parent-room",
        threadId: "child-thread",
      }),
    ).toEqual({
      channel: "test-chat",
      accountId: "default",
      conversationId: "child-thread",
      parentConversationId: "parent-room",
      threadId: "child-thread",
    });
  });

  it("strips provider prefixes from normalized fallback conversation targets", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
      messaging: {
        normalizeTarget: () => "telegram:-1001234567890:topic:77",
      },
    });

    expect(
      resolveCommandConversationResolution({
        cfg: testConfig,
        channel: "telegram",
        accountId: "default",
        originatingTo: "-1001234567890:topic:77",
      }),
    ).toEqual({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890",
    });
  });

  it("strips kind-prefixed normalized topic routes before fallback resolution", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
      messaging: {
        normalizeTarget: () => "telegram:group:-1001234567890:topic:77",
      },
    });

    expect(
      resolveCommandConversationResolution({
        cfg: testConfig,
        channel: "telegram",
        accountId: "default",
        originatingTo: "group:-1001234567890:topic:77",
      }),
    ).toEqual({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890",
    });
  });

  it("normalizes alias-prefixed topic routes before fallback resolution", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
      messaging: {
        targetPrefixes: ["tg"],
        normalizeTarget: () => "telegram:group:-1001234567890:topic:77",
      },
    });

    expect(
      resolveCommandConversationResolution({
        cfg: testConfig,
        channel: "telegram",
        accountId: "default",
        originatingTo: "tg:group:-1001234567890:topic:77",
      }),
    ).toEqual({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1001234567890",
    });
  });

  it.each([
    {
      name: "declared raw shorthand",
      channel: "telegram",
      declaresNumericShorthand: true,
      originatingTo: "-1001234567890:77",
      expectedConversationId: "-1001234567890",
    },
    {
      name: "undeclared raw shorthand",
      channel: "plainchat",
      declaresNumericShorthand: false,
      originatingTo: "-1001234567890:77",
      expectedConversationId: "-1001234567890:77",
    },
    {
      name: "declared normalized shorthand",
      channel: "telegram",
      declaresNumericShorthand: true,
      originatingTo: "topic-alias",
      expectedConversationId: "-1001234567890",
    },
    {
      name: "undeclared normalized shorthand",
      channel: "plainchat",
      declaresNumericShorthand: false,
      originatingTo: "topic-alias",
      expectedConversationId: "-1001234567890:77",
    },
  ])(
    "uses $name metadata in fallback resolution",
    ({ channel, declaresNumericShorthand, originatingTo, expectedConversationId }) => {
      registerChannelPlugin({
        ...createChannelTestPluginBase({ id: channel, label: channel }),
        messaging: {
          ...(declaresNumericShorthand ? { numericTopicShorthand: true as const } : {}),
          normalizeTarget: () => `${channel}:-1001234567890:77`,
        },
      });

      expect(
        resolveCommandConversationResolution({
          cfg: testConfig,
          channel,
          accountId: "default",
          originatingTo,
        }),
      ).toEqual({
        channel,
        accountId: "default",
        conversationId: expectedConversationId,
      });
    },
  );

  it("normalizes numeric command thread ids through the shared route contract", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "test-chat", label: "Test chat" }),
    });

    expect(
      resolveCommandConversationResolution({
        cfg: testConfig,
        channel: "test-chat",
        accountId: "default",
        originatingTo: "test-chat:channel:parent-room",
        threadId: 42.9,
      }),
    ).toEqual({
      channel: "test-chat",
      accountId: "default",
      conversationId: "42",
      parentConversationId: "parent-room",
      threadId: "42",
    });
  });

  it("uses the runtime inbound resolver and preserves provider canonical ids", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "discord", label: "Discord" }),
      messaging: {
        resolveInboundConversation: ({ conversationId, to }) => {
          const source = (conversationId ?? to ?? "").trim();
          const normalized = source.replace(/^discord:/i, "");
          return normalized ? { conversationId: normalized } : null;
        },
      },
    });

    expect(
      resolveInboundConversationResolution({
        cfg: testConfig,
        channel: "discord",
        accountId: "default",
        to: "discord:channel:123",
      }),
    ).toEqual({
      channel: "discord",
      accountId: "default",
      conversationId: "channel:123",
    });
  });

  it("keeps Matrix room casing when the channel resolver returns a child thread", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
      messaging: {
        resolveInboundConversation: ({ threadId, to }) => {
          const parent = to?.trim().replace(/^(?:matrix:)?(?:channel:|room:)/iu, "");
          return threadId && parent
            ? { conversationId: String(threadId), parentConversationId: parent }
            : null;
        },
      },
    });

    expect(
      resolveInboundConversationResolution({
        cfg: testConfig,
        channel: "matrix",
        to: "room:!Room:Example.org",
        threadId: "$thread-root",
      }),
    ).toEqual({
      channel: "matrix",
      accountId: "default",
      conversationId: "$thread-root",
      parentConversationId: "!Room:Example.org",
      threadId: "$thread-root",
    });
  });

  it("does not fall through when a channel explicitly rejects an inbound target", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
      messaging: {
        resolveInboundConversation: () => null,
      },
    });

    expect(
      resolveInboundConversationResolution({
        cfg: testConfig,
        channel: "matrix",
        to: "room:!Room:Example.org",
      }),
    ).toBeNull();
  });

  it("falls back from inbound context to channel-prefixed parent plus explicit thread", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "test-chat", label: "Test chat" }),
    });

    expect(
      resolveInboundConversationResolution({
        cfg: testConfig,
        channel: "test-chat",
        accountId: "default",
        to: "test-chat:channel:parent-room",
        threadId: "child-thread",
      }),
    ).toEqual({
      channel: "test-chat",
      accountId: "default",
      conversationId: "child-thread",
      parentConversationId: "parent-room",
      threadId: "child-thread",
    });
  });

  it("normalizes numeric inbound thread ids through the shared route contract", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "test-chat", label: "Test chat" }),
    });

    expect(
      resolveInboundConversationResolution({
        cfg: testConfig,
        channel: "test-chat",
        accountId: "default",
        to: "test-chat:channel:parent-room",
        threadId: 42.9,
      }),
    ).toEqual({
      channel: "test-chat",
      accountId: "default",
      conversationId: "42",
      parentConversationId: "parent-room",
      threadId: "42",
    });
  });

  it("resolves placement from runtime plugin metadata", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "telegram", label: "Telegram" }),
      conversationBindings: {
        supportsCurrentConversationBinding: true,
        defaultTopLevelPlacement: "current",
      },
    });

    expect(resolveChannelDefaultBindingPlacement("telegram")).toBe("current");
  });
});
