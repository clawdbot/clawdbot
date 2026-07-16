import {
  resolveScopeRequireMention,
  resolveScopeToolsPolicy,
  type ScopeTree,
} from "openclaw/plugin-sdk/channel-policy";
// Nextcloud Talk plugin module implements policy behavior.
import {
  buildChannelKeyCandidates,
  normalizeChannelSlug,
  resolveChannelEntryMatchWithFallback,
} from "openclaw/plugin-sdk/channel-targets";
import type { AllowlistMatch, ChannelGroupContext, GroupToolPolicyConfig } from "../runtime-api.js";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import type { CoreConfig, NextcloudTalkRoomConfig } from "./types.js";

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
  return allowFrom.includes(senderId)
    ? { allowed: true, matchKey: senderId, matchSource: "id" }
    : { allowed: false };
}

export function resolveNextcloudTalkRoomMatch(params: {
  rooms?: Record<string, NextcloudTalkRoomConfig>;
  roomToken: string;
}) {
  const rooms = params.rooms ?? {};
  const allowlistConfigured = Object.keys(rooms).length > 0;
  const match = resolveChannelEntryMatchWithFallback({
    entries: rooms,
    keys: buildChannelKeyCandidates(params.roomToken),
    wildcardKey: "*",
    normalizeKey: normalizeChannelSlug,
  });
  const roomConfig = match.entry;
  const allowed = !allowlistConfigured || Boolean(roomConfig);

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
  const roomToken = params.groupId?.trim();
  if (!roomToken) {
    return undefined;
  }
  const account = resolveNextcloudTalkAccount({
    cfg: params.cfg as CoreConfig,
    accountId: params.accountId,
  });
  const { tree, toolsPath } = buildNextcloudTalkRoomScope(account.config.rooms, roomToken);
  return resolveScopeToolsPolicy({ tree, path: toolsPath });
}

function buildNextcloudTalkRoomScope(
  rooms: Record<string, NextcloudTalkRoomConfig> | undefined,
  roomToken: string,
) {
  const { "*": defaults, ...scopes } = rooms ?? {};
  const tree: ScopeTree = { defaults, scopes };
  // Mentions use exact room tokens; tools retain legacy slug matching.
  // Separate paths prevent one question from widening the other.
  const exactPath = Object.hasOwn(scopes, roomToken) ? [roomToken] : [];
  const toolsMatch = resolveChannelEntryMatchWithFallback({
    entries: scopes,
    keys: buildChannelKeyCandidates(roomToken),
    normalizeKey: normalizeChannelSlug,
  });
  return { tree, exactPath, toolsPath: toolsMatch.matchKey ? [toolsMatch.matchKey] : [] };
}

export function resolveNextcloudTalkGroupRequireMention(params: ChannelGroupContext): boolean {
  if (!params.groupId) {
    return true;
  }
  const account = resolveNextcloudTalkAccount({
    cfg: params.cfg as CoreConfig,
    accountId: params.accountId,
  });
  const { tree, exactPath } = buildNextcloudTalkRoomScope(account.config.rooms, params.groupId);
  return resolveScopeRequireMention({ tree, path: exactPath });
}
