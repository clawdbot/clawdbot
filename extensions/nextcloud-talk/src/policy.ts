import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "openclaw/plugin-sdk/channel-targets";
import type { AllowlistMatch, ChannelGroupContext, GroupToolPolicyConfig } from "../runtime-api.js";
import type { NextcloudTalkRoomConfig } from "./types.js";

export function normalizeNextcloudTalkAllowEntry(raw: string): string {
  return raw
    .trim()
    .replace(/^(nextcloud-talk|nc-talk|nc):/i, "")
    .toLowerCase();
}

export function normalizeNextcloudTalkAllowlist(
  values: Array<string | number> | undefined,
): string[] {
  return (values ?? [])
    .map((value) => normalizeNextcloudTalkAllowEntry(String(value)))
    .filter(Boolean);
}

export function resolveNextcloudTalkAllowlistMatch(params: {
  allowFrom: Array<string | number> | undefined;
  senderId: string;
}): AllowlistMatch<"wildcard" | "id"> {
  const allowFrom = normalizeNextcloudTalkAllowlist(params.allowFrom);
  if (allowFrom.length === 0) {
    return { allowed: false };
  }
  if (allowFrom.includes("*")) {
    return { allowed: true, matchKey: "*", matchSource: "wildcard" };
  }
  const senderId = normalizeNextcloudTalkAllowEntry(params.senderId);
  if (allowFrom.includes(senderId)) {
    return { allowed: true, matchKey: senderId, matchSource: "id" };
  }
  return { allowed: false };
}

type NextcloudTalkRoomMatch = {
  roomConfig?: NextcloudTalkRoomConfig;
  wildcardConfig?: NextcloudTalkRoomConfig;
  roomKey?: string;
  matchSource?: "direct" | "parent" | "wildcard";
  allowed: boolean;
  allowlistConfigured: boolean;
};

export function resolveNextcloudTalkRoomMatch(params: {
  rooms?: Record<string, NextcloudTalkRoomConfig>;
  roomToken: string;
}): NextcloudTalkRoomMatch {
  const rooms = params.rooms ?? {};
  const allowlistConfigured = Object.keys(rooms).length > 0;
  const roomCandidates = buildChannelKeyCandidates(params.roomToken);
  const match = resolveChannelEntryMatchWithFallback({
    entries: rooms,
    keys: roomCandidates,
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug,
  });
  const roomConfig = match.entry;
  const allowed = resolveNestedAllowlistDecision({
    outerConfigured: allowlistConfigured,
    outerMatched: Boolean(roomConfig),
    innerConfigured: false,
    innerMatched: false,
  });

  return {
    roomConfig,
    wildcardConfig: match.wildcardEntry,
    roomKey: match.matchKey ?? match.key,
    matchSource: match.matchSource,
    allowed,
    allowlistConfigured,
  };
}

export function resolveNextcloudTalkGroupToolPolicy(
  params: ChannelGroupContext,
): GroupToolPolicyConfig | undefined {
  const cfg = params.cfg as {
    channels?: { "nextcloud-talk"?: { rooms?: Record<string, NextcloudTalkRoomConfig> } };
  };
  const roomToken = params.groupId?.trim();
  if (!roomToken) {
    return undefined;
  }
  const match = resolveNextcloudTalkRoomMatch({
    rooms: cfg.channels?.["nextcloud-talk"]?.rooms,
    roomToken,
  });
  return match.roomConfig?.tools ?? match.wildcardConfig?.tools;
}

export function resolveNextcloudTalkRequireMention(params: {
  roomConfig?: NextcloudTalkRoomConfig;
  wildcardConfig?: NextcloudTalkRoomConfig;
}): boolean {
  if (typeof params.roomConfig?.requireMention === "boolean") {
    return params.roomConfig.requireMention;
  }
  if (typeof params.wildcardConfig?.requireMention === "boolean") {
    return params.wildcardConfig.requireMention;
  }
  return true;
}
