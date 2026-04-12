import { afterEach, beforeEach } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";

export function makeCtx(overrides: Partial<MsgContext>): MsgContext {
  return {
    Body: "",
    From: "",
    To: "",
    ...overrides,
  } as MsgContext;
}

export function installDiscordSessionKeyNormalizerFixture(): void {
  beforeEach(() => {
    const discordPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "discord",
        label: "Discord",
        docsPath: "/channels/discord",
      }),
      messaging: {
        normalizeExplicitSessionKey: ({ sessionKey, ctx }) => {
          const normalizedChatType = ctx.ChatType?.trim().toLowerCase();
          let normalized = sessionKey.trim().toLowerCase();
          if (normalizedChatType !== "direct" && normalizedChatType !== "dm") {
            return normalized;
          }
          normalized = normalized.replace(/^(discord:)dm:/, "$1direct:");
          normalized = normalized.replace(/^(agent:[^:]+:discord:)dm:/, "$1direct:");
          const match = normalized.match(/^((?:agent:[^:]+:)?)discord:channel:([^:]+)$/);
          if (!match) {
            return normalized;
          }
          const from = (ctx.From ?? "").trim().toLowerCase();
          const senderId = (ctx.SenderId ?? "").trim().toLowerCase();
          const fromDiscordId =
            from.startsWith("discord:") && !from.includes(":channel:") && !from.includes(":group:")
              ? from.slice("discord:".length)
              : "";
          const directId = senderId || fromDiscordId;
          return directId && directId === match[2]
            ? `${match[1]}discord:direct:${match[2]}`
            : normalized;
        },
      },
    };
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "discord",
          plugin: discordPlugin,
          source: "test",
        },
      ]),
    );
  });

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });
}
