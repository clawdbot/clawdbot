import type { SlackReactionNotificationMode } from "../../config/config.js";
import type { SlackMessageEvent } from "../types.js";
import { allowListMatches, normalizeAllowListLower, normalizeSlackSlug } from "./allow-list.js";

export type SlackChannelConfigResolved = {
  allowed: boolean;
  requireMention: boolean;
  allowBots?: boolean;
  users?: Array<string | number>;
  skills?: string[];
  systemPrompt?: string;
};

function firstDefined<T>(...values: Array<T | undefined>) {
  for (const value of values) {
    if (typeof value !== "undefined") return value;
  }
  return undefined;
}

export function shouldEmitSlackReactionNotification(params: {
  mode: SlackReactionNotificationMode | undefined;
  botId?: string | null;
  messageAuthorId?: string | null;
  userId: string;
  userName?: string | null;
  allowlist?: Array<string | number> | null;
}) {
  const { mode, botId, messageAuthorId, userId, userName, allowlist } = params;
  const effectiveMode = mode ?? "own";
  if (effectiveMode === "off") return false;
  if (effectiveMode === "own") {
    if (!botId || !messageAuthorId) return false;
    return messageAuthorId === botId;
  }
  if (effectiveMode === "allowlist") {
    if (!Array.isArray(allowlist) || allowlist.length === 0) return false;
    const users = normalizeAllowListLower(allowlist);
    return allowListMatches({
      allowList: users,
      id: userId,
      name: userName ?? undefined,
    });
  }
  return true;
}

export function resolveSlackChannelLabel(params: { channelId?: string; channelName?: string }) {
  const channelName = params.channelName?.trim();
  if (channelName) {
    const slug = normalizeSlackSlug(channelName);
    return `#${slug || channelName}`;
  }
  const channelId = params.channelId?.trim();
  return channelId ? `#${channelId}` : "unknown channel";
}

export function resolveSlackChannelConfig(params: {
  channelId: string;
  channelName?: string;
  channels?: Record<
    string,
    {
      enabled?: boolean;
      allow?: boolean;
      requireMention?: boolean;
      allowBots?: boolean;
      users?: Array<string | number>;
      skills?: string[];
      systemPrompt?: string;
    }
  >;
  defaultRequireMention?: boolean;
}): SlackChannelConfigResolved | null {
  const { channelId, channelName, channels, defaultRequireMention } = params;
  const entries = channels ?? {};
  const keys = Object.keys(entries);
  const normalizedName = channelName ? normalizeSlackSlug(channelName) : "";
  const directName = channelName ? channelName.trim() : "";
  const candidates = [
    channelId,
    channelName ? `#${directName}` : "",
    directName,
    normalizedName,
  ].filter(Boolean);

  let matched:
    | {
        enabled?: boolean;
        allow?: boolean;
        requireMention?: boolean;
        allowBots?: boolean;
        users?: Array<string | number>;
        skills?: string[];
        systemPrompt?: string;
      }
    | undefined;
  for (const candidate of candidates) {
    if (candidate && entries[candidate]) {
      matched = entries[candidate];
      break;
    }
  }
  const fallback = entries["*"];

  const requireMentionDefault = defaultRequireMention ?? true;
  if (keys.length === 0) {
    return { allowed: true, requireMention: requireMentionDefault };
  }
  if (!matched && !fallback) {
    return { allowed: false, requireMention: requireMentionDefault };
  }

  const resolved = matched ?? fallback ?? {};
  const allowed =
    firstDefined(resolved.enabled, resolved.allow, fallback?.enabled, fallback?.allow, true) ??
    true;
  const requireMention =
    firstDefined(resolved.requireMention, fallback?.requireMention, requireMentionDefault) ??
    requireMentionDefault;
  const allowBots = firstDefined(resolved.allowBots, fallback?.allowBots);
  const users = firstDefined(resolved.users, fallback?.users);
  const skills = firstDefined(resolved.skills, fallback?.skills);
  const systemPrompt = firstDefined(resolved.systemPrompt, fallback?.systemPrompt);
  return { allowed, requireMention, allowBots, users, skills, systemPrompt };
}

export type { SlackMessageEvent };
