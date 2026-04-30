import type { DiscordAccountConfig, OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type {
  ButtonInteraction,
  ChannelSelectMenuInteraction,
  MentionableSelectMenuInteraction,
  ModalInteraction,
  RoleSelectMenuInteraction,
  StringSelectMenuInteraction,
  UserSelectMenuInteraction,
} from "../internal/discord.js";
import type { DiscordGuildEntryResolved } from "./allow-list.js";
import type { formatDiscordUserTag } from "./format.js";

export type DiscordUser = Parameters<typeof formatDiscordUserTag>[0];

export type AgentComponentMessageInteraction =
  | ButtonInteraction
  | StringSelectMenuInteraction
  | RoleSelectMenuInteraction
  | UserSelectMenuInteraction
  | MentionableSelectMenuInteraction
  | ChannelSelectMenuInteraction;

export type AgentComponentInteraction = AgentComponentMessageInteraction | ModalInteraction;

export type DiscordChannelContext = {
  channelName: string | undefined;
  channelSlug: string;
  channelType: number | undefined;
  isThread: boolean;
  parentId: string | undefined;
  parentName: string | undefined;
  parentSlug: string;
};

export type AgentComponentContext = {
  cfg: OpenClawConfig;
  accountId: string;
  discordConfig?: DiscordAccountConfig;
  runtime?: import("openclaw/plugin-sdk/runtime-env").RuntimeEnv;
  token?: string;
  guildEntries?: Record<string, DiscordGuildEntryResolved>;
  allowFrom?: string[];
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
};

export type ComponentInteractionContext = {
  channelId: string;
  user: DiscordUser;
  username: string;
  userId: string;
  replyOpts: { ephemeral?: boolean };
  rawGuildId: string | undefined;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  memberRoleIds: string[];
};
