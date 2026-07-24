// Mattermost plugin module implements target resolution behavior.
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveMattermostAccount } from "./accounts.js";
import {
  createMattermostClient,
  fetchMattermostChannel,
  fetchMattermostUser,
  normalizeMattermostBaseUrl,
} from "./client.js";
import { mapMattermostChannelTypeToChatType } from "./monitor-auth.js";
import type { OpenClawConfig } from "./runtime-api.js";

type MattermostOpaqueTargetResolution = {
  kind: "user" | "channel" | "group";
  id: string;
  to: string;
};

export type MattermostTarget =
  | { kind: "channel"; id: string }
  | { kind: "channel-name"; name: string }
  | { kind: "user"; id?: string; username?: string };

const MATTERMOST_OPAQUE_TARGET_CACHE_MAX_ENTRIES = 1024;
const MATTERMOST_OPAQUE_TARGET_CACHE_TTL_MS = 5 * 60 * 1000;
type MattermostOpaqueTargetCacheEntry = {
  kind: MattermostOpaqueTargetResolution["kind"];
  expiresAt: number;
};
const mattermostOpaqueTargetCache = new Map<string, MattermostOpaqueTargetCacheEntry>();

function cacheMattermostOpaqueTarget(
  key: string,
  kind: MattermostOpaqueTargetResolution["kind"],
): void {
  mattermostOpaqueTargetCache.set(key, {
    kind,
    expiresAt: Date.now() + MATTERMOST_OPAQUE_TARGET_CACHE_TTL_MS,
  });
  // Keep the newest authoritative classifications while bounding retention.
  pruneMapToMaxSize(mattermostOpaqueTargetCache, MATTERMOST_OPAQUE_TARGET_CACHE_MAX_ENTRIES);
}

function getCachedMattermostOpaqueTargetKind(
  key: string,
): MattermostOpaqueTargetResolution["kind"] | undefined {
  const cached = mattermostOpaqueTargetCache.get(key);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= Date.now()) {
    mattermostOpaqueTargetCache.delete(key);
    return undefined;
  }
  return cached.kind;
}

function cacheKey(baseUrl: string, token: string, id: string): string {
  return `${baseUrl}::${token}::${id}`;
}

/** Mattermost IDs are 26-character lowercase alphanumeric strings. */
function isMattermostId(value: string): boolean {
  return /^[a-z0-9]{26}$/.test(value);
}

export function parseMattermostTarget(raw: string): MattermostTarget {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for Mattermost sends");
  }
  const lower = normalizeLowercaseStringOrEmpty(trimmed);
  if (lower.startsWith("channel:")) {
    const id = trimmed.slice("channel:".length).trim();
    if (!id) {
      throw new Error("Channel id is required for Mattermost sends");
    }
    if (id.startsWith("#")) {
      const name = id.slice(1).trim();
      if (!name) {
        throw new Error("Channel name is required for Mattermost sends");
      }
      return { kind: "channel-name", name };
    }
    if (!isMattermostId(id)) {
      return { kind: "channel-name", name: id };
    }
    return { kind: "channel", id };
  }
  if (lower.startsWith("user:")) {
    const id = trimmed.slice("user:".length).trim();
    if (!id) {
      throw new Error("User id is required for Mattermost sends");
    }
    return { kind: "user", id };
  }
  if (lower.startsWith("mattermost:")) {
    const id = trimmed.slice("mattermost:".length).trim();
    if (!id) {
      throw new Error("User id is required for Mattermost sends");
    }
    return { kind: "user", id };
  }
  if (trimmed.startsWith("@")) {
    const username = trimmed.slice(1).trim();
    if (!username) {
      throw new Error("Username is required for Mattermost sends");
    }
    return { kind: "user", username };
  }
  if (trimmed.startsWith("#")) {
    const name = trimmed.slice(1).trim();
    if (!name) {
      throw new Error("Channel name is required for Mattermost sends");
    }
    return { kind: "channel-name", name };
  }
  if (!isMattermostId(trimmed)) {
    return { kind: "channel-name", name: trimmed };
  }
  return { kind: "channel", id: trimmed };
}

function isExplicitMattermostTarget(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) {
    return false;
  }
  return (
    /^(channel|user|mattermost):/i.test(trimmed) ||
    trimmed.startsWith("@") ||
    trimmed.startsWith("#")
  );
}

function parseMattermostApiStatus(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const msg = "message" in err && typeof err.message === "string" ? err.message : "";
  const match = /Mattermost API (\d{3})\b/.exec(msg);
  if (!match) {
    return undefined;
  }
  const code = Number(match[1]);
  return Number.isFinite(code) ? code : undefined;
}

export async function resolveMattermostOpaqueTarget(params: {
  input: string;
  cfg?: OpenClawConfig;
  accountId?: string | null;
  token?: string;
  baseUrl?: string;
}): Promise<MattermostOpaqueTargetResolution | null> {
  const input = params.input.trim();
  if (!input || isExplicitMattermostTarget(input) || !isMattermostId(input)) {
    return null;
  }

  const account =
    params.cfg && (!params.token || !params.baseUrl)
      ? resolveMattermostAccount({ cfg: params.cfg, accountId: params.accountId })
      : null;
  if (account && !account.enabled) {
    throw new Error(`Mattermost account "${account.accountId}" is disabled`);
  }
  const token = normalizeOptionalString(params.token) ?? normalizeOptionalString(account?.botToken);
  const baseUrl = normalizeMattermostBaseUrl(params.baseUrl ?? account?.baseUrl);
  if (!token || !baseUrl) {
    return null;
  }

  const key = cacheKey(baseUrl, token, input);
  const cachedKind = getCachedMattermostOpaqueTargetKind(key);
  if (cachedKind) {
    const to = cachedKind === "user" ? `user:${input}` : `channel:${input}`;
    return { kind: cachedKind, id: input, to };
  }

  const client = createMattermostClient({
    baseUrl,
    botToken: token,
    allowPrivateNetwork: isPrivateNetworkOptInEnabled(account?.config),
  });
  try {
    await fetchMattermostUser(client, input);
    cacheMattermostOpaqueTarget(key, "user");
    return { kind: "user", id: input, to: `user:${input}` };
  } catch (err) {
    if (parseMattermostApiStatus(err) !== 404) {
      // Unknown lookup error: stay best-effort and do not cache the result.
      return { kind: "channel", id: input, to: `channel:${input}` };
    }
  }

  // A user 404 means this ID may be a channel. Only a successful channel lookup
  // is authoritative enough to cache: caching a fallback after a transient error
  // can permanently fork a private channel's `group:<id>` session as `channel:<id>`.
  try {
    const channel = await fetchMattermostChannel(client, input);
    const channelKind =
      mapMattermostChannelTypeToChatType(channel.type) === "group" ? "group" : "channel";
    cacheMattermostOpaqueTarget(key, channelKind);
    return { kind: channelKind, id: input, to: `channel:${input}` };
  } catch {
    return { kind: "channel", id: input, to: `channel:${input}` };
  }
}
