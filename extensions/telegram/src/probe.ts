import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type { TelegramBotInfo } from "./bot-info.js";
import { resolveTelegramApiBase, resolveTelegramFetch } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";

export type TelegramProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  bot?: {
    id?: number | null;
    isBot?: boolean | null;
    firstName?: string | null;
    username?: string | null;
    canJoinGroups?: boolean | null;
    canReadAllGroupMessages?: boolean | null;
    canManageBots?: boolean | null;
    supportsInlineQueries?: boolean | null;
    canConnectToBusiness?: boolean | null;
    hasMainWebApp?: boolean | null;
    hasTopicsEnabled?: boolean | null;
    allowsUsersToCreateTopics?: boolean | null;
  };
  botInfo?: TelegramBotInfo;
  webhook?: { url?: string | null; hasCustomCert?: boolean | null };
};

export type TelegramProbeOptions = {
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
  accountId?: string;
  apiRoot?: string;
  includeWebhookInfo?: boolean;
};

const probeFetcherCache = new Map<string, typeof fetch>();
const MAX_PROBE_FETCHER_CACHE_SIZE = 64;

export function resetTelegramProbeFetcherCacheForTests(): void {
  probeFetcherCache.clear();
}

function resolveProbeOptions(
  proxyOrOptions?: string | TelegramProbeOptions,
): TelegramProbeOptions | undefined {
  if (!proxyOrOptions) {
    return undefined;
  }
  if (typeof proxyOrOptions === "string") {
    return { proxyUrl: proxyOrOptions };
  }
  return proxyOrOptions;
}

function shouldUseProbeFetcherCache(): boolean {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}

function buildProbeFetcherCacheKey(token: string, options?: TelegramProbeOptions): string {
  const cacheIdentity = options?.accountId?.trim() || token;
  const cacheIdentityKind = options?.accountId?.trim() ? "account" : "token";
  const proxyKey = options?.proxyUrl?.trim() ?? "";
  const autoSelectFamily = options?.network?.autoSelectFamily;
  const autoSelectFamilyKey =
    typeof autoSelectFamily === "boolean" ? String(autoSelectFamily) : "default";
  const dnsResultOrderKey = options?.network?.dnsResultOrder ?? "default";
  const apiRootKey = options?.apiRoot?.trim() ?? "";
  return `${cacheIdentityKind}:${cacheIdentity}::${proxyKey}::${autoSelectFamilyKey}::${dnsResultOrderKey}::${apiRootKey}`;
}

function setCachedProbeFetcher(cacheKey: string, fetcher: typeof fetch): typeof fetch {
  probeFetcherCache.set(cacheKey, fetcher);
  if (probeFetcherCache.size > MAX_PROBE_FETCHER_CACHE_SIZE) {
    const oldestKey = probeFetcherCache.keys().next().value;
    if (oldestKey !== undefined) {
      probeFetcherCache.delete(oldestKey);
    }
  }
  return fetcher;
}

function resolveProbeFetcher(token: string, options?: TelegramProbeOptions): typeof fetch {
  const cacheEnabled = shouldUseProbeFetcherCache();
  const cacheKey = cacheEnabled ? buildProbeFetcherCacheKey(token, options) : null;
  if (cacheKey) {
    const cachedFetcher = probeFetcherCache.get(cacheKey);
    if (cachedFetcher) {
      return cachedFetcher;
    }
  }

  const proxyUrl = options?.proxyUrl?.trim();
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  const resolved = resolveTelegramFetch(proxyFetch, {
    network: options?.network,
  });

  if (cacheKey) {
    return setCachedProbeFetcher(cacheKey, resolved);
  }
  return resolved;
}

function normalizeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function normalizeTelegramBotInfo(value: unknown): TelegramBotInfo | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const bot = value as Record<string, unknown>;
  if (
    typeof bot.id !== "number" ||
    bot.is_bot !== true ||
    typeof bot.first_name !== "string" ||
    typeof bot.username !== "string"
  ) {
    return undefined;
  }
  return {
    id: bot.id,
    is_bot: true,
    first_name: bot.first_name,
    username: bot.username,
    ...(typeof bot.last_name === "string" ? { last_name: bot.last_name } : {}),
    ...(typeof bot.language_code === "string" ? { language_code: bot.language_code } : {}),
    can_join_groups: normalizeBoolean(bot.can_join_groups) ?? false,
    can_read_all_group_messages: normalizeBoolean(bot.can_read_all_group_messages) ?? false,
    can_manage_bots: normalizeBoolean(bot.can_manage_bots) ?? false,
    supports_inline_queries: normalizeBoolean(bot.supports_inline_queries) ?? false,
    can_connect_to_business: normalizeBoolean(bot.can_connect_to_business) ?? false,
    has_main_web_app: normalizeBoolean(bot.has_main_web_app) ?? false,
    has_topics_enabled: normalizeBoolean(bot.has_topics_enabled) ?? false,
    allows_users_to_create_topics: normalizeBoolean(bot.allows_users_to_create_topics) ?? false,
  };
}

export async function probeTelegram(
  token: string,
  timeoutMs: number,
  proxyOrOptions?: string | TelegramProbeOptions,
): Promise<TelegramProbe> {
  const started = Date.now();
  const timeoutBudgetMs = Math.max(1, Math.floor(timeoutMs));
  const deadlineMs = started + timeoutBudgetMs;
  const options = resolveProbeOptions(proxyOrOptions);
  const includeWebhookInfo = options?.includeWebhookInfo !== false;
  const fetcher = resolveProbeFetcher(token, options);
  const apiBase = resolveTelegramApiBase(options?.apiRoot);
  const base = `${apiBase}/bot${token}`;
  const retryDelayMs = Math.max(50, Math.min(1000, Math.floor(timeoutBudgetMs / 5)));
  const resolveRemainingBudgetMs = () => Math.max(0, deadlineMs - Date.now());

  const result: TelegramProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
  };

  try {
    let meRes: Response | null = null;
    let fetchError: unknown = null;

    // Retry loop for initial connection (handles network/DNS startup races)
    for (let i = 0; i < 3; i++) {
      const remainingBudgetMs = resolveRemainingBudgetMs();
      if (remainingBudgetMs <= 0) {
        break;
      }
      try {
        meRes = await fetchWithTimeout(
          `${base}/getMe`,
          {},
          Math.max(1, Math.min(timeoutBudgetMs, remainingBudgetMs)),
          fetcher,
        );
        break;
      } catch (err) {
        fetchError = err;
        if (i < 2) {
          const remainingAfterAttemptMs = resolveRemainingBudgetMs();
          if (remainingAfterAttemptMs <= 0) {
            break;
          }
          const delayMs = Math.min(retryDelayMs, remainingAfterAttemptMs);
          if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }
    }

    if (!meRes) {
      throw fetchError ?? new Error(`probe timed out after ${timeoutBudgetMs}ms`);
    }

    const meJson = (await meRes.json()) as {
      ok?: boolean;
      description?: string;
      result?: unknown;
    };
    if (!meRes.ok || !meJson?.ok) {
      result.status = meRes.status;
      result.error = meJson?.description ?? `getMe failed (${meRes.status})`;
      return { ...result, elapsedMs: Date.now() - started };
    }

    const botInfo = normalizeTelegramBotInfo(meJson.result);
    const rawBot = meJson.result && typeof meJson.result === "object" ? meJson.result : {};
    const bot = rawBot as Record<string, unknown>;
    if (botInfo) {
      result.botInfo = botInfo;
    }
    result.bot = {
      id: typeof bot.id === "number" ? bot.id : null,
      isBot: normalizeBoolean(bot.is_bot),
      firstName: typeof bot.first_name === "string" ? bot.first_name : null,
      username: typeof bot.username === "string" ? bot.username : null,
      canJoinGroups: normalizeBoolean(bot.can_join_groups),
      canReadAllGroupMessages: normalizeBoolean(bot.can_read_all_group_messages),
      canManageBots: normalizeBoolean(bot.can_manage_bots),
      supportsInlineQueries: normalizeBoolean(bot.supports_inline_queries),
      canConnectToBusiness: normalizeBoolean(bot.can_connect_to_business),
      hasMainWebApp: normalizeBoolean(bot.has_main_web_app),
      hasTopicsEnabled: normalizeBoolean(bot.has_topics_enabled),
      allowsUsersToCreateTopics: normalizeBoolean(bot.allows_users_to_create_topics),
    };

    if (includeWebhookInfo) {
      // Try to fetch webhook info, but don't fail health if it errors.
      try {
        const webhookRemainingBudgetMs = resolveRemainingBudgetMs();
        if (webhookRemainingBudgetMs > 0) {
          const webhookRes = await fetchWithTimeout(
            `${base}/getWebhookInfo`,
            {},
            Math.max(1, Math.min(timeoutBudgetMs, webhookRemainingBudgetMs)),
            fetcher,
          );
          const webhookJson = (await webhookRes.json()) as {
            ok?: boolean;
            result?: { url?: string; has_custom_certificate?: boolean };
          };
          if (webhookRes.ok && webhookJson?.ok) {
            result.webhook = {
              url: webhookJson.result?.url ?? null,
              hasCustomCert: webhookJson.result?.has_custom_certificate ?? null,
            };
          }
        }
      } catch {
        // ignore webhook errors for probe
      }
    }

    result.ok = true;
    result.status = null;
    result.error = null;
    result.elapsedMs = Date.now() - started;
    return result;
  } catch (err) {
    return {
      ...result,
      status: err instanceof Response ? err.status : result.status,
      error: formatErrorMessage(err),
      elapsedMs: Date.now() - started,
    };
  }
}
