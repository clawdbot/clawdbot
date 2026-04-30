import type { APIAttachment, APIStickerItem } from "discord-api-types/v10";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import type { createReplyReferencePlanner } from "openclaw/plugin-sdk/reply-reference";
import type { ChannelType, Client, MessageCreateListener } from "../internal/discord.js";
import type { DiscordChannelConfigResolved } from "./allow-list.js";

export type DiscordThreadChannel = {
  id: string;
  name?: string | null;
  parentId?: string | null;
  parent?: { id?: string; name?: string };
  ownerId?: string | null;
};

export type DiscordThreadStarter = {
  text: string;
  author: string;
  authorId?: string;
  authorName?: string;
  authorTag?: string;
  memberRoleIds?: string[];
  timestamp?: number;
};

export type DiscordThreadParentInfo = {
  id?: string;
  name?: string;
  type?: ChannelType;
};

export type DiscordThreadStarterRestEmbed = {
  title?: string | null;
  description?: string | null;
};

export type DiscordThreadStarterRestSnapshotMessage = {
  content?: string | null;
  attachments?: APIAttachment[] | null;
  embeds?: DiscordThreadStarterRestEmbed[] | null;
  sticker_items?: APIStickerItem[] | null;
};

export type DiscordThreadStarterRestAuthor = {
  id?: string | null;
  username?: string | null;
  discriminator?: string | null;
};

export type DiscordThreadStarterRestMember = {
  nick?: string | null;
  displayName?: string | null;
  roles?: string[];
};

export type DiscordThreadStarterRestMessage = {
  content?: string | null;
  embeds?: DiscordThreadStarterRestEmbed[] | null;
  message_snapshots?: Array<{ message?: DiscordThreadStarterRestSnapshotMessage | null }> | null;
  member?: DiscordThreadStarterRestMember | null;
  author?: DiscordThreadStarterRestAuthor | null;
  timestamp?: string | null;
};

export type DiscordMessageEvent = Parameters<MessageCreateListener["handle"]>[0];

export type DiscordReplyDeliveryPlan = {
  deliverTarget: string;
  replyTarget: string;
  replyReference: ReturnType<typeof createReplyReferencePlanner>;
};

export type DiscordAutoThreadContext = {
  createdThreadId: string;
  From: string;
  To: string;
  OriginatingTo: string;
  SessionKey: string;
  ModelParentSessionKey?: string;
  ParentSessionKey?: string;
};

export type DiscordAutoThreadReplyPlan = DiscordReplyDeliveryPlan & {
  createdThreadId?: string;
  autoThreadContext: DiscordAutoThreadContext | null;
};

export type MaybeCreateDiscordAutoThreadParams = {
  client: Client;
  message: DiscordMessageEvent["message"];
  messageChannelId?: string;
  channel?: string;
  isGuildMessage: boolean;
  channelConfig?: DiscordChannelConfigResolved | null;
  threadChannel?: DiscordThreadChannel | null;
  channelType?: ChannelType;
  channelName?: string;
  channelDescription?: string;
  baseText: string;
  combinedBody: string;
  cfg: OpenClawConfig;
  agentId?: string;
};
