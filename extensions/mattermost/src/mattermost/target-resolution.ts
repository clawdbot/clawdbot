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
  fetchMattermostUser,
  normalizeMattermostBaseUrl,
} from "./client.js";
import type { OpenClawConfig } from "./runtime-api.js";

type MattermostOpaqueTargetResolution = {
  kind: "user" | "channel";
  id: string;
  to: string;
};

export type MattermostTarget =
  | { kind: "channel"; id: string }
  | { kind: "channel-name"; name: string }
  | { kind: "user"; id?: string; username?: string };

const MATTERMOST_OPAQUE_TARGET_CACHE_MAX_ENTRIES = 1024;
const mattermostOpaqueTargetCache = new Map<string, MattermostOpaqueTargetResolution["kind"]>();

function cacheMattermostOpaqueTarget(
  key: string,
  kind: MattermostOpaqueTargetResolution["kind"],
): void {
  mattermostOpaqueTargetCache.set(key, kind);
  // Keep the newest resolved IDs while bounding process-lifetime retention.
  pruneMapToMaxSize(mattermostOpaqueTargetCache, MATTERMOST_OPAQUE_TARGET_CACHE_MAX_ENTRIES);
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
  const token = normalizeOptionalString(params.token) ?? normalizeOptionalString(account?.botToken);
  const baseUrl = normalizeMattermostBaseUrl(params.baseUrl ?? account?.baseUrl);
  if (!token || !baseUrl) {
    return null;
  }

  const key = cacheKey(baseUrl, token, input);
  const cachedKind = mattermostOpaqueTargetCache.get(key);
  if (cachedKind) {
    return { kind: cachedKind, id: input, to: `${cachedKind}:${input}` };
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
    if (parseMattermostApiStatus(err) === 404) {
      cacheMattermostOpaqueTarget(key, "channel");
    }
    return { kind: "channel", id: input, to: `channel:${input}` };
  }
}
