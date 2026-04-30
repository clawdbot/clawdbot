import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { ChannelType } from "../internal/discord.js";
import type { preflightDiscordMessage } from "./message-handler.preflight.js";
import { createNoopThreadBindingManager } from "./thread-bindings.js";

export type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];
export type DiscordMessageEvent = import("./listeners.js").DiscordMessageEvent;
export type DiscordClient = import("../internal/discord.js").Client;

export const DEFAULT_PREFLIGHT_CFG = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
} as OpenClawConfig;

export function createGuildTextClient(channelId: string): DiscordClient {
  return {
    fetchChannel: async (id: string) => {
      if (id === channelId) {
        return {
          id: channelId,
          type: ChannelType.GuildText,
          name: "general",
        };
      }
      return null;
    },
  } as unknown as DiscordClient;
}

export function createGuildEvent(params: {
  channelId: string;
  guildId: string;
  author: import("../internal/discord.js").Message["author"];
  message: import("../internal/discord.js").Message;
  includeGuildObject?: boolean;
}): DiscordMessageEvent {
  return {
    channel_id: params.channelId,
    guild_id: params.guildId,
    ...(params.includeGuildObject === false
      ? {}
      : {
          guild: {
            id: params.guildId,
            name: "Guild One",
          },
        }),
    author: params.author,
    message: params.message,
  } as unknown as DiscordMessageEvent;
}

export function createDiscordMessage(params: {
  id: string;
  channelId: string;
  content: string;
  author: {
    id: string;
    bot: boolean;
    username?: string;
  };
  mentionedUsers?: Array<{ id: string }>;
  mentionedEveryone?: boolean;
  attachments?: Array<Record<string, unknown>>;
}): import("../internal/discord.js").Message {
  return {
    id: params.id,
    content: params.content,
    timestamp: new Date().toISOString(),
    channelId: params.channelId,
    attachments: params.attachments ?? [],
    mentionedUsers: params.mentionedUsers ?? [],
    mentionedRoles: [],
    mentionedEveryone: params.mentionedEveryone ?? false,
    author: params.author,
  } as unknown as import("../internal/discord.js").Message;
}

export function createDiscordPreflightArgs(params: {
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  data: DiscordMessageEvent;
  client: DiscordClient;
  botUserId?: string;
}): Parameters<typeof preflightDiscordMessage>[0] {
  return {
    cfg: params.cfg,
    discordConfig: params.discordConfig,
    accountId: "default",
    token: "token",
    runtime: {} as import("openclaw/plugin-sdk/runtime-env").RuntimeEnv,
    botUserId: params.botUserId ?? "openclaw-bot",
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1_000_000,
    textLimit: 2_000,
    replyToMode: "all",
    dmEnabled: true,
    groupDmEnabled: true,
    dmPolicy: params.discordConfig?.dmPolicy ?? params.discordConfig?.dm?.policy ?? "pairing",
    ackReactionScope: "direct",
    groupPolicy: "open",
    threadBindings: createNoopThreadBindingManager("default"),
    data: params.data,
    client: params.client,
  };
}
