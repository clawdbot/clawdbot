import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-types";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithTimeout } from "openclaw/plugin-sdk/text-runtime";
import { resolveTelegramApiBase, resolveTelegramFetch } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";

export type TelegramProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  bot?: {
    id?: number | null;
    username?: string | null;
    canJoinGroups?: boolean | null;
    canReadAllGroupMessages?: boolean | null;
    supportsInlineQueries?: boolean | null;
  };
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
      result?: {
        id?: number;
        username?: string;
        can_join_groups?: boolean;
        can_read_all_group_messages?: boolean;
        supports_inline_queries?: boolean;
      };
    };
    if (!meRes.ok || !meJson?.ok) {
      result.status = meRes.status;
      result.error = meJson?.description ?? `getMe failed (${meRes.status})`;
      return { ...result, elapsedMs: Date.now() - started };
    }

    result.bot = {
      id: meJson.result?.id ?? null,
      username: meJson.result?.username ?? null,
      canJoinGroups:
        typeof meJson.result?.can_join_groups === "boolean" ? meJson.result?.can_join_groups : null,
      canReadAllGroupMessages:
        typeof meJson.result?.can_read_all_group_messages === "boolean"
          ? meJson.result?.can_read_all_group_messages
          : null,
      supportsInlineQueries:
        typeof meJson.result?.supports_inline_queries === "boolean"
          ? meJson.result?.supports_inline_queries
          : null,
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
