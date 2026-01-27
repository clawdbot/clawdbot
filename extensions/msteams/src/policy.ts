import type {
  AllowlistMatch,
  ChannelGroupContext,
  GroupPolicy,
  GroupToolPolicyConfig,
  MSTeamsChannelConfig,
  MSTeamsConfig,
  MSTeamsReplyStyle,
  MSTeamsTeamConfig,
} from "clawdbot/plugin-sdk";
import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveToolsBySender,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "clawdbot/plugin-sdk";

export type MSTeamsResolvedRouteConfig = {
  teamConfig?: MSTeamsTeamConfig;
  channelConfig?: MSTeamsChannelConfig;
  allowlistConfigured: boolean;
  allowed: boolean;
  teamKey?: string;
  channelKey?: string;
  channelMatchKey?: string;
  channelMatchSource?: "direct" | "wildcard";
};

export function resolveMSTeamsRouteConfig(params: {
  cfg?: MSTeamsConfig;
  teamId?: string | null | undefined;
  teamName?: string | null | undefined;
  conversationId?: string | null | undefined;
  channelName?: string | null | undefined;
}): MSTeamsResolvedRouteConfig {
  const teamId = params.teamId?.trim();
  const teamName = params.teamName?.trim();
  const conversationId = params.conversationId?.trim();
  const channelName = params.channelName?.trim();
  const teams = params.cfg?.teams ?? {};
  const allowlistConfigured = Object.keys(teams).length > 0;
  const teamCandidates = buildChannelKeyCandidates(
    teamId,
    teamName,
    teamName ? normalizeChannelSlug(teamName) : undefined,
  );
  const teamMatch = resolveChannelEntryMatchWithFallback({
    entries: teams,
    keys: teamCandidates,
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug,
  });
  const teamConfig = teamMatch.entry;
  const channels = teamConfig?.channels ?? {};
  const channelAllowlistConfigured = Object.keys(channels).length > 0;
  const channelCandidates = buildChannelKeyCandidates(
    conversationId,
    channelName,
    channelName ? normalizeChannelSlug(channelName) : undefined,
  );
  const channelMatch = resolveChannelEntryMatchWithFallback({
    entries: channels,
    keys: channelCandidates,
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug,
  });
  const channelConfig = channelMatch.entry;

  const allowed = resolveNestedAllowlistDecision({
    outerConfigured: allowlistConfigured,
    outerMatched: Boolean(teamConfig),
    innerConfigured: channelAllowlistConfigured,
    innerMatched: Boolean(channelConfig),
  });

  return {
    teamConfig,
    channelConfig,
    allowlistConfigured,
    allowed,
    teamKey: teamMatch.matchKey ?? teamMatch.key,
    channelKey: channelMatch.matchKey ?? channelMatch.key,
    channelMatchKey: channelMatch.matchKey,
    channelMatchSource:
      channelMatch.matchSource === "direct" || channelMatch.matchSource === "wildcard"
        ? channelMatch.matchSource
        : undefined,
  };
}

export function resolveMSTeamsGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg.channels?.msteams;
  if (!cfg) return undefined;
  const groupId = params.groupId?.trim();
  const groupChannel = params.groupChannel?.trim();
  const groupSpace = params.groupSpace?.trim();

  const resolved = resolveMSTeamsRouteConfig({
    cfg,
    teamId: groupSpace,
    teamName: groupSpace,
    conversationId: groupId,
    channelName: groupChannel,
  });

  if (resolved.channelConfig) {
    const senderPolicy = resolveToolsBySender({
      toolsBySender: resolved.channelConfig.toolsBySender,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
    if (senderPolicy) return senderPolicy;
    if (resolved.channelConfig.tools) return resolved.channelConfig.tools;
    const teamSenderPolicy = resolveToolsBySender({
      toolsBySender: resolved.teamConfig?.toolsBySender,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
    if (teamSenderPolicy) return teamSenderPolicy;
    return resolved.teamConfig?.tools;
  }
  if (resolved.teamConfig) {
    const teamSenderPolicy = resolveToolsBySender({
      toolsBySender: resolved.teamConfig.toolsBySender,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
    });
    if (teamSenderPolicy) return teamSenderPolicy;
    if (resolved.teamConfig.tools) return resolved.teamConfig.tools;
  }

  if (!groupId) return undefined;

  const channelCandidates = buildChannelKeyCandidates(
    groupId,
    groupChannel,
    groupChannel ? normalizeChannelSlug(groupChannel) : undefined,
  );
  for (const teamConfig of Object.values(cfg.teams ?? {})) {
    const match = resolveChannelEntryMatchWithFallback({
      entries: teamConfig?.channels ?? {},
      keys: channelCandidates,
      wildcardKey: "*",
      normalizeKey: normalizeChannelSlug,
    });
    if (match.entry) {
      const senderPolicy = resolveToolsBySender({
        toolsBySender: match.entry.toolsBySender,
        senderId: params.senderId,
        senderName: params.senderName,
        senderUsername: params.senderUsername,
        senderE164: params.senderE164,
      });
      if (senderPolicy) return senderPolicy;
      if (match.entry.tools) return match.entry.tools;
      const teamSenderPolicy = resolveToolsBySender({
        toolsBySender: teamConfig?.toolsBySender,
        senderId: params.senderId,
        senderName: params.senderName,
        senderUsername: params.senderUsername,
        senderE164: params.senderE164,
      });
      if (teamSenderPolicy) return teamSenderPolicy;
      return teamConfig?.tools;
    }
  }

  return undefined;
}

export type MSTeamsReplyPolicy = {
  requireMention: boolean;
  replyStyle: MSTeamsReplyStyle;
};

export type MSTeamsAllowlistMatch = AllowlistMatch<"wildcard" | "id" | "name">;

export function resolveMSTeamsAllowlistMatch(params: {
  allowFrom: Array<string | number>;
  senderId: string;
  senderName?: string | null;
}): MSTeamsAllowlistMatch {
  const allowFrom = params.allowFrom
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean);
  if (allowFrom.length === 0) return { allowed: false };
  if (allowFrom.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  const senderId = params.senderId.toLowerCase();
  if (allowFrom.includes(senderId)) {
    return { allowed: true, matchKey: senderId, matchSource: "id" };
  }
  const senderName = params.senderName?.toLowerCase();
  if (senderName && allowFrom.includes(senderName)) {
    return { allowed: true, matchKey: senderName, matchSource: "name" };
  }
  return { allowed: false };
}

export function resolveMSTeamsReplyPolicy(params: {
  isDirectMessage: boolean;
  globalConfig?: MSTeamsConfig;
  teamConfig?: MSTeamsTeamConfig;
  channelConfig?: MSTeamsChannelConfig;
}): MSTeamsReplyPolicy {
  if (params.isDirectMessage) {
    return { requireMention: false, replyStyle: "thread" };
  }

  const requireMention =
    params.channelConfig?.requireMention ??
    params.teamConfig?.requireMention ??
    params.globalConfig?.requireMention ??
    true;

  const explicitReplyStyle =
    params.channelConfig?.replyStyle ??
    params.teamConfig?.replyStyle ??
    params.globalConfig?.replyStyle;

  const replyStyle: MSTeamsReplyStyle =
    explicitReplyStyle ?? (requireMention ? "thread" : "top-level");

  return { requireMention, replyStyle };
}

export function isMSTeamsGroupAllowed(params: {
  groupPolicy: GroupPolicy;
  allowFrom: Array<string | number>;
  senderId: string;
  senderName?: string | null;
}): boolean {
  const { groupPolicy } = params;
  if (groupPolicy === "disabled") return false;
  if (groupPolicy === "open") return true;
  return resolveMSTeamsAllowlistMatch(params).allowed;
}
