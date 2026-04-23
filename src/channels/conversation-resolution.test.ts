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

  it("uses the runtime command resolver, plugin default account, and placement hint", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({
        id: "discord",
        label: "Discord",
        config: {
          defaultAccountId: () => "work",
        },
      }),
      conversationBindings: {
        supportsCurrentConversationBinding: true,
        defaultTopLevelPlacement: "child",
      },
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
      canonical: {
        channel: "discord",
        accountId: "work",
        conversationId: "channel:123",
      },
      placementHint: "child",
      source: "command-provider",
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
      })?.canonical,
    ).toEqual({
      channel: "line",
      accountId: "default",
      conversationId: "user:U1234567890abcdef1234567890abcdef",
      parentConversationId: "user:U1234567890abcdef1234567890abcdef",
    });
  });

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
      canonical: {
        channel: "test-chat",
        accountId: "default",
        conversationId: "child-thread",
        parentConversationId: "parent-room",
      },
      threadId: "child-thread",
      source: "command-fallback",
    });
  });

  it("uses the runtime inbound resolver and preserves provider canonical ids", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "discord", label: "Discord" }),
      conversationBindings: {
        supportsCurrentConversationBinding: true,
        defaultTopLevelPlacement: "child",
      },
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
      canonical: {
        channel: "discord",
        accountId: "default",
        conversationId: "channel:123",
      },
      placementHint: "child",
      source: "inbound-provider",
    });
  });

  it("keeps Matrix room casing when the channel resolver returns a child thread", () => {
    registerChannelPlugin({
      ...createChannelTestPluginBase({ id: "matrix", label: "Matrix" }),
      conversationBindings: {
        supportsCurrentConversationBinding: true,
        defaultTopLevelPlacement: "child",
      },
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
      })?.canonical,
    ).toEqual({
      channel: "matrix",
      accountId: "default",
      conversationId: "$thread-root",
      parentConversationId: "!Room:Example.org",
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
      canonical: {
        channel: "test-chat",
        accountId: "default",
        conversationId: "child-thread",
        parentConversationId: "parent-room",
      },
      threadId: "child-thread",
      source: "inbound-fallback",
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
