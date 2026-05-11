import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { fetchWithTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { DiscordApiError, fetchDiscord } from "./api.js";
import { normalizeDiscordToken } from "./token.js";

const DISCORD_API_BASE = "https://discord.com/api/v10";

export type DiscordProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  bot?: { id?: string | null; username?: string | null };
  application?: DiscordApplicationSummary;
};

export type DiscordPrivilegedIntentStatus = "enabled" | "limited" | "disabled";

export type DiscordPrivilegedIntentsSummary = {
  messageContent: DiscordPrivilegedIntentStatus;
  guildMembers: DiscordPrivilegedIntentStatus;
  presence: DiscordPrivilegedIntentStatus;
};

export type DiscordApplicationSummary = {
  id?: string | null;
  flags?: number | null;
  intents?: DiscordPrivilegedIntentsSummary;
};

const DISCORD_APP_FLAG_GATEWAY_PRESENCE = 1 << 12;
const DISCORD_APP_FLAG_GATEWAY_PRESENCE_LIMITED = 1 << 13;
const DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS = 1 << 14;
const DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED = 1 << 15;
const DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT = 1 << 18;
const DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;

async function fetchDiscordApplicationMe(
  token: string,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<{ id?: string; flags?: number } | undefined> {
  try {
    const normalized = normalizeDiscordToken(token, "channels.discord.token");
    if (!normalized) {
      return undefined;
    }
    return await fetchDiscord<{ id?: string; flags?: number }>(
      "/oauth2/applications/@me",
      normalized,
      createDiscordTimeoutFetch(fetcher, timeoutMs),
      { retry: { attempts: 1 } },
    );
  } catch {
    return undefined;
  }
}

function createDiscordTimeoutFetch(fetcher: typeof fetch, timeoutMs: number): typeof fetch {
  const fetchImpl = getResolvedFetch(fetcher);
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithTimeout(
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      init ?? {},
      timeoutMs,
      fetchImpl,
    )) as typeof fetch;
}

export function resolveDiscordPrivilegedIntentsFromFlags(
  flags: number,
): DiscordPrivilegedIntentsSummary {
  const resolve = (enabledBit: number, limitedBit: number) => {
    if ((flags & enabledBit) !== 0) {
      return "enabled";
    }
    if ((flags & limitedBit) !== 0) {
      return "limited";
    }
    return "disabled";
  };
  return {
    presence: resolve(DISCORD_APP_FLAG_GATEWAY_PRESENCE, DISCORD_APP_FLAG_GATEWAY_PRESENCE_LIMITED),
    guildMembers: resolve(
      DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS,
      DISCORD_APP_FLAG_GATEWAY_GUILD_MEMBERS_LIMITED,
    ),
    messageContent: resolve(
      DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT,
      DISCORD_APP_FLAG_GATEWAY_MESSAGE_CONTENT_LIMITED,
    ),
  };
}

export async function fetchDiscordApplicationSummary(
  token: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<DiscordApplicationSummary | undefined> {
  const json = await fetchDiscordApplicationMe(token, timeoutMs, fetcher);
  if (!json) {
    return undefined;
  }
  const flags =
    typeof json.flags === "number" && Number.isFinite(json.flags) ? json.flags : undefined;
  return {
    id: json.id ?? null,
    flags: flags ?? null,
    intents:
      typeof flags === "number" ? resolveDiscordPrivilegedIntentsFromFlags(flags) : undefined,
  };
}

function getResolvedFetch(fetcher: typeof fetch): typeof fetch {
  const fetchImpl = resolveFetch(fetcher);
  if (!fetchImpl) {
    throw new Error("fetch is not available");
  }
  return fetchImpl;
}

export async function probeDiscord(
  token: string,
  timeoutMs: number,
  opts?: { fetcher?: typeof fetch; includeApplication?: boolean },
): Promise<DiscordProbe> {
  const started = Date.now();
  const fetcher = opts?.fetcher ?? fetch;
  const includeApplication = opts?.includeApplication === true;
  const normalized = normalizeDiscordToken(token, "channels.discord.token");
  const result: DiscordProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
  };
  if (!normalized) {
    return {
      ...result,
      error: "missing token",
      elapsedMs: Date.now() - started,
    };
  }
  try {
    const res = await fetchWithTimeout(
      `${DISCORD_API_BASE}/users/@me`,
      { headers: { Authorization: `Bot ${normalized}` } },
      timeoutMs,
      getResolvedFetch(fetcher),
    );
    if (!res.ok) {
      result.status = res.status;
      result.error = `getMe failed (${res.status})`;
      return { ...result, elapsedMs: Date.now() - started };
    }
    const json = (await res.json()) as { id?: string; username?: string };
    result.ok = true;
    result.bot = {
      id: json.id ?? null,
      username: json.username ?? null,
    };
    if (includeApplication) {
      result.application =
        (await fetchDiscordApplicationSummary(normalized, timeoutMs, fetcher)) ?? undefined;
    }
    return { ...result, elapsedMs: Date.now() - started };
  } catch (err) {
    return {
      ...result,
      status: err instanceof Response ? err.status : result.status,
      error: formatErrorMessage(err),
      elapsedMs: Date.now() - started,
    };
  }
}

/**
 * Extract the application (bot user) ID from a Discord bot token by
 * base64-decoding the first segment.  Discord tokens have the format:
 *   base64(user_id) . timestamp . hmac
 * The decoded first segment is the numeric snowflake ID as a plain string,
 * so we keep it as a string to avoid precision loss for IDs that exceed
 * Number.MAX_SAFE_INTEGER.
 */
export function parseApplicationIdFromToken(token: string): string | undefined {
  const normalized = normalizeDiscordToken(token, "channels.discord.token");
  if (!normalized) {
    return undefined;
  }
  const firstDot = normalized.indexOf(".");
  if (firstDot <= 0) {
    return undefined;
  }
  try {
    const decoded = Buffer.from(normalized.slice(0, firstDot), "base64").toString("utf-8");
    if (/^\d+$/.test(decoded)) {
      return decoded;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function fetchDiscordApplicationId(
  token: string,
  timeoutMs: number,
  fetcher: typeof fetch = fetch,
): Promise<string | undefined> {
  const normalized = normalizeDiscordToken(token, "channels.discord.token");
  if (!normalized) {
    return undefined;
  }
  const parsedApplicationId = parseApplicationIdFromToken(token);
  if (parsedApplicationId) {
    return parsedApplicationId;
  }
  try {
    const json = await fetchDiscord<{ id?: string }>(
      "/oauth2/applications/@me",
      normalized,
      createDiscordTimeoutFetch(fetcher, timeoutMs),
    );
    if (json?.id) {
      return json.id;
    }
    return undefined;
  } catch (error) {
    if (error instanceof DiscordApiError) {
      if (error.status === 429) {
        throw error;
      }
      return undefined;
    }
    return undefined;
  }
}
