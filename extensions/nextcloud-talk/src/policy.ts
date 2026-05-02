import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
  resolveNestedAllowlistDecision,
} from "openclaw/plugin-sdk/channel-targets";
import { evaluateMatchedGroupAccessForPolicy } from "openclaw/plugin-sdk/group-access";
import type {
  AllowlistMatch,
  ChannelGroupContext,
  GroupPolicy,
  GroupToolPolicyConfig,
} from "../runtime-api.js";
import type { NextcloudTalkRoomConfig } from "./types.js";

function normalizeAllowEntry(raw: string): string {
  return raw
    .trim()
    .replace(/^(nextcloud-talk|nc-talk|nc):/i, "")
    .toLowerCase();
}

export function normalizeNextcloudTalkAllowlist(
  values: Array<string | number> | undefined,
): string[] {
  return (values ?? []).map((value) => normalizeAllowEntry(String(value))).filter(Boolean);
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
  const senderId = normalizeAllowEntry(params.senderId);
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

export function resolveNextcloudTalkGroupAllow(params: {
  groupPolicy: GroupPolicy;
  outerAllowFrom: Array<string | number> | undefined;
  innerAllowFrom: Array<string | number> | undefined;
  senderId: string;
}): { allowed: boolean; outerMatch: AllowlistMatch; innerMatch: AllowlistMatch } {
  const outerAllow = normalizeNextcloudTalkAllowlist(params.outerAllowFrom);
  const innerAllow = normalizeNextcloudTalkAllowlist(params.innerAllowFrom);
  const outerMatch = resolveNextcloudTalkAllowlistMatch({
    allowFrom: params.outerAllowFrom,
    senderId: params.senderId,
  });
  const innerMatch = resolveNextcloudTalkAllowlistMatch({
    allowFrom: params.innerAllowFrom,
    senderId: params.senderId,
  });
  const access = evaluateMatchedGroupAccessForPolicy({
    groupPolicy: params.groupPolicy,
    allowlistConfigured: outerAllow.length > 0 || innerAllow.length > 0,
    allowlistMatched: resolveNestedAllowlistDecision({
      outerConfigured: outerAllow.length > 0 || innerAllow.length > 0,
      outerMatched: outerAllow.length > 0 ? outerMatch.allowed : true,
      innerConfigured: innerAllow.length > 0,
      innerMatched: innerMatch.allowed,
    }),
  });

  return {
    allowed: access.allowed,
    outerMatch:
      params.groupPolicy === "open"
        ? { allowed: true }
        : params.groupPolicy === "disabled"
          ? { allowed: false }
          : outerMatch,
    innerMatch:
      params.groupPolicy === "open"
        ? { allowed: true }
        : params.groupPolicy === "disabled"
          ? { allowed: false }
          : innerMatch,
  };
}

export function resolveNextcloudTalkMentionGate(params: {
  isGroup: boolean;
  requireMention: boolean;
  wasMentioned: boolean;
  allowTextCommands: boolean;
  hasControlCommand: boolean;
  commandAuthorized: boolean;
}): { shouldSkip: boolean; shouldBypassMention: boolean } {
  const shouldBypassMention =
    params.isGroup &&
    params.requireMention &&
    !params.wasMentioned &&
    params.allowTextCommands &&
    params.commandAuthorized &&
    params.hasControlCommand;
  return {
    shouldBypassMention,
    shouldSkip: params.requireMention && !params.wasMentioned && !shouldBypassMention,
  };
}
