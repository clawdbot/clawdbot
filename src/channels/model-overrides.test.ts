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
});
