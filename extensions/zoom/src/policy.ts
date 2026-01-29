import type {
  AllowlistMatch,
  ChannelGroupContext,
  GroupPolicy,
  GroupToolPolicyConfig,
} from "clawdbot/plugin-sdk";
import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveToolsBySender,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "clawdbot/plugin-sdk";

import type { ZoomConfig, ZoomChannelConfig } from "./types.js";

export type ZoomResolvedRouteConfig = {
  channelConfig?: ZoomChannelConfig;
  allowlistConfigured: boolean;
  allowed: boolean;
  channelKey?: string;
  channelMatchKey?: string;
  channelMatchSource?: "direct" | "wildcard";
};

export function resolveZoomRouteConfig(params: {
  cfg?: ZoomConfig;
  channelJid?: string | null | undefined;
  channelName?: string | null | undefined;
}): ZoomResolvedRouteConfig {
  const channelJid = params.channelJid?.trim();
  const channelName = params.channelName?.trim();
  const channels = params.cfg?.channels ?? {};
  const allowlistConfigured = Object.keys(channels).length > 0;

  const channelCandidates = buildChannelKeyCandidates(
    channelJid,
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
    outerMatched: Boolean(channelConfig),
    innerConfigured: false,
    innerMatched: false,
  });

  return {
    channelConfig,
    allowlistConfigured,
    allowed,
    channelKey: channelMatch.matchKey ?? channelMatch.key,
    channelMatchKey: channelMatch.matchKey,
    channelMatchSource:
      channelMatch.matchSource === "direct" || channelMatch.matchSource === "wildcard"
        ? channelMatch.matchSource
        : undefined,
  };
}

export function resolveZoomGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg.channels?.zoom as ZoomConfig | undefined;
  if (!cfg) return undefined;
  const groupId = params.groupId?.trim();
  const groupChannel = params.groupChannel?.trim();

  const resolved = resolveZoomRouteConfig({
    cfg,
    channelJid: groupId,
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
  }

  return undefined;
}

export type ZoomAllowlistMatch = AllowlistMatch<"wildcard" | "id" | "name" | "email">;

export function resolveZoomAllowlistMatch(params: {
  allowFrom: Array<string | number>;
  senderId: string;
  senderName?: string | null;
  senderEmail?: string | null;
}): ZoomAllowlistMatch {
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
  const senderEmail = params.senderEmail?.toLowerCase();
  if (senderEmail && allowFrom.includes(senderEmail)) {
    return { allowed: true, matchKey: senderEmail, matchSource: "email" };
  }
  return { allowed: false };
}

export type ZoomReplyPolicy = {
  requireMention: boolean;
};

export function resolveZoomReplyPolicy(params: {
  isDirectMessage: boolean;
  globalConfig?: ZoomConfig;
  channelConfig?: ZoomChannelConfig;
}): ZoomReplyPolicy {
  if (params.isDirectMessage) {
    return { requireMention: false };
  }

  const requireMention =
    params.channelConfig?.requireMention ?? params.globalConfig?.requireMention ?? true;

  return { requireMention };
}

export function isZoomGroupAllowed(params: {
  groupPolicy: GroupPolicy;
  allowFrom: Array<string | number>;
  senderId: string;
  senderName?: string | null;
  senderEmail?: string | null;
}): boolean {
  const { groupPolicy } = params;
  if (groupPolicy === "disabled") return false;
  if (groupPolicy === "open") return true;
  return resolveZoomAllowlistMatch(params).allowed;
}
