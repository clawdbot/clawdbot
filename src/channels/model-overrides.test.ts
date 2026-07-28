// Model override tests cover channel-level model selection and override precedence.
import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { createSessionConversationTestRegistry } from "../test-utils/session-conversation-registry.js";
import { resolveChannelModelOverride } from "./model-overrides.js";

describe("resolveChannelModelOverride", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(createSessionConversationTestRegistry());
  });

  it.each([
    {
      name: "matches parent group id when topic suffix is present",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              telegram: {
                "-100123": "demo-provider/demo-parent-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "telegram",
        groupId: "-100123:topic:99",
      },
      expected: { model: "demo-provider/demo-parent-model", matchKey: "-100123" },
    },
    {
      name: "prefers topic-specific match over parent group id",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              telegram: {
                "-100123": "demo-provider/demo-parent-model",
                "-100123:topic:99": "demo-provider/demo-topic-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "telegram",
        groupId: "-100123:topic:99",
      },
      expected: { model: "demo-provider/demo-topic-model", matchKey: "-100123:topic:99" },
    },
    {
      name: "falls back to parent session key when thread id does not match",
      input: {
        cfg: {
          channels: {
            modelByChannel: {
              "demo-thread": {
                "123": "demo-provider/demo-parent-model",
              },
            },
          },
        } as unknown as OpenClawConfig,
        channel: "demo-thread",
        groupId: "999",
        parentSessionKey: "agent:main:demo-thread:channel:123:thread:456",
      },
      expected: { model: "demo-provider/demo-parent-model", matchKey: "123" },
    },
  ] as const)("$name", ({ input, expected }) => {
    const resolved = resolveChannelModelOverride(input);
    expect(resolved?.model).toBe(expected.model);
    expect(resolved?.matchKey).toBe(expected.matchKey);
  });

  it("passes channel kind to plugin-owned parent fallback resolution", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "channel-kind",
          source: "test",
          plugin: {
            id: "channel-kind",
            meta: {
              id: "channel-kind",
              label: "Channel Kind",
              selectionLabel: "Channel Kind",
              docsPath: "/channels/channel-kind",
              blurb: "test stub.",
            },
            capabilities: { chatTypes: ["group", "channel"] },
            messaging: {
              resolveSessionConversation: ({
                kind,
                rawId,
              }: {
                kind: "group" | "channel";
                rawId: string;
              }) => ({
                id: rawId,
                parentConversationCandidates: kind === "channel" ? ["thread-parent"] : [],
              }),
            },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
          },
        },
      ]),
    );

    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            "channel-kind": {
              "thread-parent": "demo-provider/demo-channel-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "channel-kind",
      groupId: "thread-123",
      groupChatType: "channel",
    });

    expect(resolved?.model).toBe("demo-provider/demo-channel-model");
    expect(resolved?.matchKey).toBe("thread-parent");
  });

  it("uses plugin-owned parent fallback candidates", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "scoped-chat",
          source: "test",
          plugin: {
            id: "scoped-chat",
            meta: {
              id: "scoped-chat",
              label: "Scoped Chat",
              selectionLabel: "Scoped Chat",
              docsPath: "/channels/scoped-chat",
              blurb: "test stub.",
            },
            capabilities: { chatTypes: ["group"] },
            conversationBindings: {
              buildModelOverrideParentCandidates: ({
                parentConversationId,
              }: {
                parentConversationId?: string | null;
              }) =>
                parentConversationId === "room:topic:thread:sender:user"
                  ? ["room:topic:thread", "room"]
                  : [],
            },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
          },
        },
      ]),
    );

    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            "scoped-chat": {
              "room:topic:thread": "demo-provider/demo-scoped-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "scoped-chat",
      groupId: "unrelated",
      parentSessionKey: "agent:main:scoped-chat:group:room:topic:thread:sender:user",
    });

    expect(resolved?.model).toBe("demo-provider/demo-scoped-model");
    expect(resolved?.matchKey).toBe("room:topic:thread");
  });

  it("applies provider wildcard model overrides to direct chats", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              "*": "demo-provider/demo-direct-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "telegram",
      groupChatType: "direct",
    });

    expect(resolved?.model).toBe("demo-provider/demo-direct-model");
    expect(resolved?.matchKey).toBe("*");
    expect(resolved?.matchSource).toBe("wildcard");
  });

  it("prefers parent conversation ids over channel-name fallbacks", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              "-100123": "demo-provider/demo-parent-model",
              "#general": "demo-provider/demo-channel-name-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "telegram",
      groupId: "-100123:topic:99",
      groupChannel: "#general",
    });

    expect(resolved?.model).toBe("demo-provider/demo-parent-model");
    expect(resolved?.matchKey).toBe("-100123");
  });

  it("matches direct-user-specific model override via directUserId", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              user123: "demo-provider/demo-direct-user-model",
              "*": "demo-provider/demo-wildcard-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "telegram",
      groupChatType: "direct",
      directUserIds: ["user123"],
    });

    expect(resolved?.model).toBe("demo-provider/demo-direct-user-model");
    expect(resolved?.matchKey).toBe("user123");
  });

  it("falls back to wildcard when no directUserId match exists", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              user999: "demo-provider/demo-other-user-model",
              "*": "demo-provider/demo-wildcard-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "telegram",
      groupChatType: "direct",
      directUserIds: ["user123"],
    });

    expect(resolved?.model).toBe("demo-provider/demo-wildcard-model");
    expect(resolved?.matchKey).toBe("*");
    expect(resolved?.matchSource).toBe("wildcard");
  });

  it("matches direct-user-specific model override via directUserId from origin.from", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            slack: {
              "user:U12345": "demo-provider/demo-slack-dm-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "slack",
      groupChatType: "direct",
      directUserIds: ["user:U12345"],
    });

    expect(resolved?.model).toBe("demo-provider/demo-slack-dm-model");
    expect(resolved?.matchKey).toBe("user:U12345");
  });

  it("ignores directUserId when a groupId is present (group takes precedence)", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              "-100123": "demo-provider/demo-group-model",
              user456: "demo-provider/demo-direct-user-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "telegram",
      groupId: "-100123",
      directUserIds: ["user456"],
    });

    expect(resolved?.model).toBe("demo-provider/demo-group-model");
    expect(resolved?.matchKey).toBe("-100123");
  });

  it("matches slack DM when origin.from is slack:U... but config has user:U... (multi-candidate)", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            slack: {
              "user:U12345": "demo-provider/demo-slack-dm-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "slack",
      groupChatType: "direct",
      directUserIds: ["slack:U12345", "user:U12345"],
    });

    expect(resolved?.model).toBe("demo-provider/demo-slack-dm-model");
    expect(resolved?.matchKey).toBe("user:U12345");
  });

  it("matches discord DM when multiple candidate forms are present", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            discord: {
              "12345": "demo-provider/demo-discord-dm-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "discord",
      groupChatType: "direct",
      directUserIds: ["discord:12345", "user:12345", "12345"],
    });

    expect(resolved?.model).toBe("demo-provider/demo-discord-dm-model");
    expect(resolved?.matchKey).toBe("12345");
  });

  it("matches telegram DM when raw SenderId is in candidates alongside prefixed forms", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              "67890": "demo-provider/demo-telegram-dm-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "telegram",
      groupChatType: "direct",
      directUserIds: ["telegram:67890", "user:67890", "67890"],
    });

    expect(resolved?.model).toBe("demo-provider/demo-telegram-dm-model");
    expect(resolved?.matchKey).toBe("67890");
  });

  it("prefers first matching candidate over later candidates", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            slack: {
              "slack:U12345": "demo-provider/demo-prefixed-model",
              "user:U12345": "demo-provider/demo-user-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "slack",
      groupChatType: "direct",
      directUserIds: ["slack:U12345", "user:U12345"],
    });

    expect(resolved?.model).toBe("demo-provider/demo-prefixed-model");
    expect(resolved?.matchKey).toBe("slack:U12345");
  });

  it("derives raw peer ID from channel-prefixed origin.from for telegram DM", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              "12345": "demo-provider/demo-telegram-dm-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "telegram",
      groupChatType: "direct",
      directUserIds: ["telegram:12345"],
    });

    expect(resolved?.model).toBe("demo-provider/demo-telegram-dm-model");
    expect(resolved?.matchKey).toBe("12345");
  });

  it("derives raw peer ID from channel-prefixed origin.from for discord DM", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            discord: {
              "67890": "demo-provider/demo-discord-dm-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "discord",
      groupChatType: "direct",
      directUserIds: ["discord:67890"],
    });

    expect(resolved?.model).toBe("demo-provider/demo-discord-dm-model");
    expect(resolved?.matchKey).toBe("67890");
  });

  it("does not strip prefix for a different channel", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              "12345": "demo-provider/demo-telegram-dm-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "telegram",
      groupChatType: "direct",
      directUserIds: ["discord:12345"],
    });

    expect(resolved).toBeNull();
  });

  it("does not leak directUserId match into non-direct conversations", () => {
    const resolved = resolveChannelModelOverride({
      cfg: {
        channels: {
          modelByChannel: {
            telegram: {
              user123: "demo-provider/demo-dm-model",
            },
          },
        },
      } as unknown as OpenClawConfig,
      channel: "telegram",
      groupChatType: "group",
      groupId: "some-group",
      directUserIds: ["user123"],
    });

    expect(resolved).toBeNull();
  });
});
