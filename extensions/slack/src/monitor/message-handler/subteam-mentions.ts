import type { WebClient } from "@slack/web-api";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const SUBTEAM_MENTION_RE = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/gi;
const SUBTEAM_MEMBER_CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = {
  expiresAt: number;
  users: ReadonlySet<string>;
};

let subteamMemberCache = new WeakMap<WebClient, Map<string, CacheEntry>>();

function normalizeSlackId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toUpperCase() : undefined;
}

export function extractSlackSubteamMentionIds(text?: string | null): string[] {
  if (!text) {
    return [];
  }
  const ids = new Set<string>();
  for (const match of text.matchAll(SUBTEAM_MENTION_RE)) {
    const id = normalizeSlackId(match[1]);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

async function readSlackSubteamUsers(params: {
  client: WebClient;
  subteamId: string;
  teamId?: string;
  now: number;
  log?: (message: string) => void;
}): Promise<ReadonlySet<string>> {
  let bySubteam = subteamMemberCache.get(params.client);
  if (!bySubteam) {
    bySubteam = new Map<string, CacheEntry>();
    subteamMemberCache.set(params.client, bySubteam);
  }
  const cacheKey = `${normalizeSlackId(params.teamId) ?? ""}:${params.subteamId}`;
  const cached = bySubteam.get(cacheKey);
  if (cached && cached.expiresAt > params.now) {
    return cached.users;
  }

  try {
    const response = await params.client.usergroups.users.list({
      usergroup: params.subteamId,
      ...(params.teamId ? { team_id: params.teamId } : {}),
    });
    if (!response.ok) {
      params.log?.(
        `slack: failed to resolve user-group mention ${params.subteamId}: ${response.error ?? "unknown_error"}`,
      );
      return new Set();
    }
    const users = new Set(
      (response.users ?? []).map((userId) => normalizeSlackId(userId)).filter(Boolean) as string[],
    );
    bySubteam.set(cacheKey, {
      expiresAt: params.now + SUBTEAM_MEMBER_CACHE_TTL_MS,
      users,
    });
    return users;
  } catch (err) {
    params.log?.(
      `slack: failed to resolve user-group mention ${params.subteamId}: ${formatErrorMessage(err)}`,
    );
    return new Set();
  }
}

export async function isSlackSubteamMentionForBot(params: {
  client: WebClient;
  text?: string | null;
  botUserId?: string | null;
  teamId?: string;
  now?: number;
  log?: (message: string) => void;
}): Promise<boolean> {
  const botUserId = normalizeSlackId(params.botUserId);
  if (!botUserId) {
    return false;
  }
  const subteamIds = extractSlackSubteamMentionIds(params.text);
  if (subteamIds.length === 0) {
    return false;
  }
  const now = params.now ?? Date.now();
  for (const subteamId of subteamIds) {
    const users = await readSlackSubteamUsers({
      client: params.client,
      subteamId,
      teamId: normalizeOptionalString(params.teamId),
      now,
      log: params.log,
    });
    if (users.has(botUserId)) {
      return true;
    }
  }
  return false;
}

export function clearSlackSubteamMentionCacheForTest(): void {
  subteamMemberCache = new WeakMap<WebClient, Map<string, CacheEntry>>();
}
