import type { CommandArgs } from "openclaw/plugin-sdk/command-auth-native";
import { finalizeInboundContext } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import { resolveDiscordConversationIdentity } from "../conversation-identity.js";
import { type DiscordChannelConfigResolved, type DiscordGuildEntryResolved } from "./allow-list.js";
import { buildDiscordInboundAccessContext } from "./inbound-context.js";

type BuildDiscordNativeCommandContextParams = {
  prompt: string;
  commandArgs: CommandArgs;
  sessionKey: string;
  commandTargetSessionKey: string;
  accountId?: string | null;
  interactionId: string;
  channelId: string;
  threadParentId?: string;
  memberRoleIds?: string[];
  guildId?: string;
  guildName?: string;
  channelTopic?: string;
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  allowNameMatching?: boolean;
  commandAuthorized: boolean;
  isDirectMessage: boolean;
  isGroupDm: boolean;
  isGuild: boolean;
  isThreadChannel: boolean;
  user: {
    id: string;
    username: string;
    globalName?: string | null;
  };
  sender: {
    id: string;
    name?: string;
    tag?: string;
  };
  timestampMs?: number;
};

export function buildDiscordNativeCommandContext(params: BuildDiscordNativeCommandContextParams) {
  const conversationLabel = params.isDirectMessage
    ? (params.user.globalName ?? params.user.username)
    : params.channelId;
  const { groupSystemPrompt, ownerAllowFrom, untrustedContext } = buildDiscordInboundAccessContext({
    channelConfig: params.channelConfig,
    guildInfo: params.guildInfo,
    sender: params.sender,
    allowNameMatching: params.allowNameMatching,
    isGuild: params.isGuild,
    channelTopic: params.channelTopic,
  });

  return finalizeInboundContext({
    Body: params.prompt,
    BodyForAgent: params.prompt,
    RawBody: params.prompt,
    CommandBody: params.prompt,
    CommandArgs: params.commandArgs,
    From: params.isDirectMessage
      ? `discord:${params.user.id}`
      : params.isGroupDm
        ? `discord:group:${params.channelId}`
        : `discord:channel:${params.channelId}`,
    To: `slash:${params.user.id}`,
    SessionKey: params.sessionKey,
    CommandTargetSessionKey: params.commandTargetSessionKey,
    AccountId: params.accountId ?? undefined,
    ChatType: params.isDirectMessage ? "direct" : params.isGroupDm ? "group" : "channel",
    ConversationLabel: conversationLabel,
    GroupSubject: params.isGuild ? params.guildName : undefined,
    GroupSpace: params.isGuild
      ? (params.guildInfo?.id ?? params.guildInfo?.slug ?? params.guildId)
      : undefined,
    MemberRoleIds: params.memberRoleIds,
    GroupSystemPrompt: groupSystemPrompt,
    UntrustedContext: untrustedContext,
    OwnerAllowFrom: ownerAllowFrom,
    SenderName: params.user.globalName ?? params.user.username,
    SenderId: params.user.id,
    SenderUsername: params.user.username,
    SenderTag: params.sender.tag,
    Provider: "discord" as const,
    Surface: "discord" as const,
    WasMentioned: true,
    MessageSid: params.interactionId,
    MessageThreadId: params.isThreadChannel ? params.channelId : undefined,
    Timestamp: params.timestampMs ?? Date.now(),
    CommandAuthorized: params.commandAuthorized,
    CommandSource: "native" as const,
    // Native slash contexts use To=slash:<user> for interaction routing.
    // For follow-up delivery (for example subagent completion announces),
    // preserve the real Discord target separately.
    OriginatingChannel: "discord" as const,
    OriginatingTo:
      resolveDiscordConversationIdentity({
        isDirectMessage: params.isDirectMessage,
        userId: params.user.id,
        channelId: params.channelId,
      }) ?? (params.isDirectMessage ? `user:${params.user.id}` : `channel:${params.channelId}`),
    ThreadParentId: params.isThreadChannel ? params.threadParentId : undefined,
  });
}
