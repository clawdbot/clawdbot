import { makeProxyFetch } from "./proxy.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export type TelegramProbe = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
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

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetcher: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function probeTelegram(
  token: string,
  timeoutMs: number,
  proxyUrl?: string,
): Promise<TelegramProbe> {
  const started = Date.now();
  const fetcher = proxyUrl ? makeProxyFetch(proxyUrl) : fetch;
  const base = `${TELEGRAM_API_BASE}/bot${token}`;

  const result: TelegramProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
  };

  try {
    const meRes = await fetchWithTimeout(`${base}/getMe`, timeoutMs, fetcher);
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

    // Try to fetch webhook info, but don't fail health if it errors.
    try {
      const webhookRes = await fetchWithTimeout(`${base}/getWebhookInfo`, timeoutMs, fetcher);
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
    } catch {
      // ignore webhook errors for probe
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
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Date.now() - started,
    };
  }
}
