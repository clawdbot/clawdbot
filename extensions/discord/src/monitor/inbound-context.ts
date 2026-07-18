// Discord plugin module implements inbound context behavior.
import { resolveInboundSupplementalSenderAllowed } from "openclaw/plugin-sdk/channel-inbound";
import type { MsgContext } from "openclaw/plugin-sdk/reply-runtime";
import {
  resolveDiscordMemberAllowed,
  resolveDiscordOwnerAllowFrom,
  type DiscordChannelConfigResolved,
  type DiscordGuildEntryResolved,
} from "./allow-list.js";

type DiscordSupplementalContextSender = {
  id?: string;
  name?: string;
  tag?: string;
  memberRoleIds?: string[];
};

export function createDiscordSupplementalContextAccessChecker(params: {
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  allowNameMatching?: boolean;
  isGuild: boolean;
}) {
  const userAllowList = params.channelConfig?.users ?? params.guildInfo?.users ?? [];
  const roleAllowList = params.channelConfig?.roles ?? params.guildInfo?.roles ?? [];
  const allowFrom = [...userAllowList, ...roleAllowList];
  return (sender: DiscordSupplementalContextSender): boolean => {
    return resolveInboundSupplementalSenderAllowed({
      isGroup: params.isGuild,
      groupPolicy: allowFrom.length === 0 ? "open" : "allowlist",
      allowFrom,
      isSenderAllowed: () =>
        resolveDiscordMemberAllowed({
          userAllowList,
          roleAllowList,
          memberRoleIds: sender.memberRoleIds ?? [],
          userId: sender.id ?? "",
          userName: sender.name,
          userTag: sender.tag,
          allowNameMatching: params.allowNameMatching,
        }),
    });
  };
}

export function buildDiscordGroupSystemPrompt(
  channelConfig?: DiscordChannelConfigResolved | null,
): string | undefined {
  const systemPromptParts = [channelConfig?.systemPrompt?.trim() || null].filter(
    (entry): entry is string => Boolean(entry),
  );
  return systemPromptParts.length > 0 ? systemPromptParts.join("\n\n") : undefined;
}

function buildDiscordUntrustedContext(params: {
  isGuild: boolean;
  channelTopic?: string;
}): MsgContext["UntrustedStructuredContext"] | undefined {
  if (!params.isGuild) {
    return undefined;
  }
  const entries: NonNullable<MsgContext["UntrustedStructuredContext"]> = [];
  if (typeof params.channelTopic === "string" && params.channelTopic.trim().length > 0) {
    entries.push({
      label: "Discord channel metadata",
      source: "discord",
      type: "channel_metadata",
      payload: {
        topic: params.channelTopic.trim(),
      },
    });
  }
  return entries.length > 0 ? entries : undefined;
}

export function buildDiscordInboundAccessContext(params: {
  channelConfig?: DiscordChannelConfigResolved | null;
  guildInfo?: DiscordGuildEntryResolved | null;
  sender: {
    id: string;
    name?: string;
    tag?: string;
  };
  allowNameMatching?: boolean;
  isGuild: boolean;
  channelTopic?: string;
}) {
  return {
    groupSystemPrompt: params.isGuild
      ? buildDiscordGroupSystemPrompt(params.channelConfig)
      : undefined,
    untrustedContext: buildDiscordUntrustedContext({
      isGuild: params.isGuild,
      channelTopic: params.channelTopic,
    }),
    ownerAllowFrom: resolveDiscordOwnerAllowFrom({
      channelConfig: params.channelConfig,
      guildInfo: params.guildInfo,
      sender: params.sender,
      allowNameMatching: params.allowNameMatching,
    }),
  };
}
