import type { Guild, Message, User } from "../internal/discord.js";
import { resolveTimestampMs } from "./format.js";
import { resolveDiscordSenderIdentity } from "./sender-identity.js";

type DiscordReplyContext = {
  id: string;
  channelId: string;
  sender: string;
  senderId?: string;
  senderName?: string;
  senderTag?: string;
  memberRoleIds?: string[];
  body: string;
  timestamp?: number;
};

export function resolveReplyContext(
  message: Message,
  resolveDiscordMessageText: (message: Message, options?: { includeForwarded?: boolean }) => string,
): DiscordReplyContext | null {
  const referenced = message.referencedMessage;
  if (!referenced?.author) {
    return null;
  }
  const referencedText = resolveDiscordMessageText(referenced, {
    includeForwarded: true,
  });
  if (!referencedText) {
    return null;
  }
  const sender = resolveDiscordSenderIdentity({
    author: referenced.author,
    pluralkitInfo: null,
  });
  return {
    id: referenced.id,
    channelId: referenced.channelId,
    sender: sender.tag ?? sender.label ?? "unknown",
    senderId: referenced.author.id,
    senderName: referenced.author.username ?? undefined,
    senderTag: sender.tag ?? undefined,
    memberRoleIds: (() => {
      const roles = (referenced as { member?: { roles?: string[] } }).member?.roles;
      return Array.isArray(roles) ? roles.map((roleId) => roleId) : undefined;
    })(),
    body: referencedText,
    timestamp: resolveTimestampMs(referenced.timestamp),
  };
}

export function buildDirectLabel(author: User, tagOverride?: string) {
  const username =
    tagOverride?.trim() || resolveDiscordSenderIdentity({ author, pluralkitInfo: null }).tag;
  return `${username ?? "unknown"} user id:${author.id}`;
}

export function buildGuildLabel(params: {
  guild?: Guild<true> | Guild;
  channelName: string;
  channelId: string;
}) {
  const { guild, channelName, channelId } = params;
  return `${guild?.name ?? "Guild"} #${channelName} channel id:${channelId}`;
}
