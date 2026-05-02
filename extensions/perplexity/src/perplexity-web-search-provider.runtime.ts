import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  buildSearchCacheKey,
  DEFAULT_SEARCH_COUNT,
  isoToPerplexityDate,
  normalizeFreshness,
  normalizeToIsoDate,
  readCachedSearchPayload,
  readConfiguredSecretString,
  readProviderEnvValue,
  resolveSearchCacheTtlMs,
  resolveSearchCount,
  resolveSearchTimeoutSeconds,
  resolveSiteName,
  throwWebSearchApiError,
  type SearchConfigRecord,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCachedSearchPayload,
} from "openclaw/plugin-sdk/provider-web-search";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  DEFAULT_PERPLEXITY_BASE_URL,
  inferPerplexityBaseUrlFromApiKey,
  isDirectPerplexityBaseUrl,
  PERPLEXITY_DIRECT_BASE_URL,
  type PerplexityTransport,
} from "./perplexity-web-search-provider.shared.js";

const PERPLEXITY_SEARCH_ENDPOINT = "https://api.perplexity.ai/search";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";

type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
        url_citation?: {
          url?: string;
        };
      }>;
    };
  }>;
  citations?: string[];
};

type PerplexitySearchApiResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    snippet?: string;
    date?: string;
  }>;
};

function resolvePerplexityConfig(searchConfig?: SearchConfigRecord): PerplexityConfig {
  const perplexity = searchConfig?.perplexity;
  return perplexity && typeof perplexity === "object" && !Array.isArray(perplexity)
    ? (perplexity as PerplexityConfig)
    : {};
}

function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: "config" | "perplexity_env" | "openrouter_env" | "none";
} {
  const fromConfig = readConfiguredSecretString(
    perplexity?.apiKey,
    "tools.web.search.perplexity.apiKey",
  );
  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }
  const fromPerplexityEnv = readProviderEnvValue(["PERPLEXITY_API_KEY"]);
  if (fromPerplexityEnv) {
    return { apiKey: fromPerplexityEnv, source: "perplexity_env" };
  }
  const fromOpenRouterEnv = readProviderEnvValue(["OPENROUTER_API_KEY"]);
  if (fromOpenRouterEnv) {
    return { apiKey: fromOpenRouterEnv, source: "openrouter_env" };
  }
  return { apiKey: undefined, source: "none" };
}

function resolvePerplexityBaseUrl(
  perplexity?: PerplexityConfig,
  authSource: "config" | "perplexity_env" | "openrouter_env" | "none" = "none",
  configuredKey?: string,
): string {
  const fromConfig = normalizeOptionalString(perplexity?.baseUrl) ?? "";
  if (fromConfig) {
    return fromConfig;
  }
  if (authSource === "perplexity_env") {
    return PERPLEXITY_DIRECT_BASE_URL;
  }
  if (authSource === "openrouter_env") {
    return DEFAULT_PERPLEXITY_BASE_URL;
  }
  if (authSource === "config") {
    return inferPerplexityBaseUrlFromApiKey(configuredKey) === "openrouter"
      ? DEFAULT_PERPLEXITY_BASE_URL
      : PERPLEXITY_DIRECT_BASE_URL;
  }
  return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityModel(perplexity?: PerplexityConfig): string {
  const model = normalizeOptionalString(perplexity?.model) ?? "";
  return model || DEFAULT_PERPLEXITY_MODEL;
}

function resolvePerplexityRequestModel(baseUrl: string, model: string): string {
  if (!isDirectPerplexityBaseUrl(baseUrl)) {
    return model;
  }
  return model.startsWith("perplexity/") ? model.slice("perplexity/".length) : model;
}

function buildPerplexityRequestHeaders(apiKey: string, acceptJson = false): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(acceptJson ? { Accept: "application/json" } : {}),
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": "https://openclaw.ai",
    "X-Title": "OpenClaw Web Search",
  };
}

function resolvePerplexityTransport(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: "config" | "perplexity_env" | "openrouter_env" | "none";
  baseUrl: string;
  model: string;
  transport: PerplexityTransport;
} {
  const auth = resolvePerplexityApiKey(perplexity);
  const baseUrl = resolvePerplexityBaseUrl(perplexity, auth.source, auth.apiKey);
  const model = resolvePerplexityModel(perplexity);
  const hasLegacyOverride = Boolean(
    normalizeOptionalString(perplexity?.baseUrl) || normalizeOptionalString(perplexity?.model),
  );
  return {
    ...auth,
    baseUrl,
    model,
    transport:
      hasLegacyOverride || !isDirectPerplexityBaseUrl(baseUrl) ? "chat_completions" : "search_api",
  };
}

function extractPerplexityCitations(data: PerplexitySearchResponse): string[] {
  const topLevel = (data.citations ?? []).filter((url): url is string =>
    Boolean(normalizeOptionalString(url)),
  );
  if (topLevel.length > 0) {
    return [...new Set(topLevel)];
  }
  const citations: string[] = [];
  for (const choice of data.choices ?? []) {
    for (const annotation of choice.message?.annotations ?? []) {
      if (annotation.type !== "url_citation") {
        continue;
      }
      const url =
        typeof annotation.url_citation?.url === "string"
          ? annotation.url_citation.url
          : typeof annotation.url === "string"
            ? annotation.url
            : undefined;
      const normalizedUrl = normalizeOptionalString(url);
      if (normalizedUrl) {
        citations.push(normalizedUrl);
      }
    }
  }
  return [...new Set(citations)];
}

async function runPerplexitySearchApi(params: {
  query: string;
  apiKey: string;
  count: number;
  timeoutSeconds: number;
  country?: string;
  searchDomainFilter?: string[];
  searchRecencyFilter?: string;
  searchLanguageFilter?: string[];
  searchAfterDate?: string;
  searchBeforeDate?: string;
  maxTokens?: number;
  maxTokensPerPage?: number;
}): Promise<Array<Record<string, unknown>>> {
  const body: Record<string, unknown> = {
    query: params.query,
    max_results: params.count,
  };
  if (params.country) {
    body.country = params.country;
  }
  if (params.searchDomainFilter?.length) {
    body.search_domain_filter = params.searchDomainFilter;
  }
  if (params.searchRecencyFilter) {
    body.search_recency_filter = params.searchRecencyFilter;
  }
  if (params.searchLanguageFilter?.length) {
    body.search_language_filter = params.searchLanguageFilter;
  }
  if (params.searchAfterDate) {
    body.search_after_date = params.searchAfterDate;
  }
  if (params.searchBeforeDate) {
    body.search_before_date = params.searchBeforeDate;
  }
  if (params.maxTokens !== undefined) {
    body.max_tokens = params.maxTokens;
  }
  if (params.maxTokensPerPage !== undefined) {
    body.max_tokens_per_page = params.maxTokensPerPage;
  }

  return withTrustedWebSearchEndpoint(
    {
      url: PERPLEXITY_SEARCH_ENDPOINT,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: buildPerplexityRequestHeaders(params.apiKey, true),
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Perplexity Search");
      }
      const data = (await res.json()) as PerplexitySearchApiResponse;
      return (data.results ?? []).map((entry) => ({
        title: entry.title ? wrapWebContent(entry.title, "web_search") : "",
        url: entry.url ?? "",
        description: entry.snippet ? wrapWebContent(entry.snippet, "web_search") : "",
        published: entry.date ?? undefined,
        siteName: resolveSiteName(entry.url) || undefined,
      }));
    },
  );
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
  freshness?: string;
}): Promise<{ content: string; citations: string[] }> {
  const endpoint = `${params.baseUrl.trim().replace(/\/$/, "")}/chat/completions`;
  const body: Record<string, unknown> = {
    model: resolvePerplexityRequestModel(params.baseUrl, params.model),
    messages: [{ role: "user", content: params.query }],
  };
  if (params.freshness) {
    body.search_recency_filter = params.freshness;
  }

  return withTrustedWebSearchEndpoint(
    {
      url: endpoint,
      timeoutSeconds: params.timeoutSeconds,
      init: {
        method: "POST",
        headers: buildPerplexityRequestHeaders(params.apiKey),
        body: JSON.stringify(body),
      },
    },
    async (res) => {
      if (!res.ok) {
        return await throwWebSearchApiError(res, "Perplexity");
      }
      const data = (await res.json()) as PerplexitySearchResponse;
      return {
        content: data.choices?.[0]?.message?.content ?? "No response",
        citations: extractPerplexityCitations(data),
      };
    },
  );
}

export async function executePerplexitySearch(
  args: Record<string, unknown>,
  searchConfig?: SearchConfigRecord,
): Promise<Record<string, unknown>> {
  const perplexityConfig = resolvePerplexityConfig(searchConfig);
  const runtime = resolvePerplexityTransport(perplexityConfig);
  if (!runtime.apiKey) {
    return {
      error: "missing_perplexity_api_key",
      message:
        "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey. If you do not want to configure a search API key, use web_fetch for a specific URL or the browser tool for interactive pages.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const query = readStringParam(args, "query", { required: true });
  const count =
    readNumberParam(args, "count", { integer: true }) ?? searchConfig?.maxResults ?? undefined;
  const rawFreshness = readStringParam(args, "freshness");
  const freshness = rawFreshness ? normalizeFreshness(rawFreshness, "perplexity") : undefined;
  if (rawFreshness && !freshness) {
    return {
      error: "invalid_freshness",
      message: "freshness must be day, week, month, or year.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }

  const structured = runtime.transport === "search_api";
  const country = readStringParam(args, "country");
  const language = readStringParam(args, "language");
  const rawDateAfter = readStringParam(args, "date_after");
  const rawDateBefore = readStringParam(args, "date_before");
  const domainFilter = readStringArrayParam(args, "domain_filter");
  const maxTokens = readNumberParam(args, "max_tokens", { integer: true });
  const maxTokensPerPage = readNumberParam(args, "max_tokens_per_page", { integer: true });

  if (!structured) {
    if (country) {
      return {
        error: "unsupported_country",
        message:
          "country filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
    if (language) {
      return {
        error: "unsupported_language",
        message:
          "language filtering is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
    if (rawDateAfter || rawDateBefore) {
      return {
        error: "unsupported_date_filter",
        message:
          "date_after/date_before are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
    if (domainFilter?.length) {
      return {
        error: "unsupported_domain_filter",
        message:
          "domain_filter is only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable it.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
    if (maxTokens !== undefined || maxTokensPerPage !== undefined) {
      return {
        error: "unsupported_content_budget",
        message:
          "max_tokens and max_tokens_per_page are only supported by the native Perplexity Search API path. Remove Perplexity baseUrl/model overrides or use a direct PERPLEXITY_API_KEY to enable them.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
  }

  if (language && !/^[a-z]{2}$/iu.test(language)) {
    return {
      error: "invalid_language",
      message: "language must be a 2-letter ISO 639-1 code like 'en', 'de', or 'fr'.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (rawFreshness && (rawDateAfter || rawDateBefore)) {
    return {
      error: "conflicting_time_filters",
      message:
        "freshness and date_after/date_before cannot be used together. Use either freshness (day/week/month/year) or a date range (date_after/date_before), not both.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  const dateAfter = rawDateAfter ? normalizeToIsoDate(rawDateAfter) : undefined;
  const dateBefore = rawDateBefore ? normalizeToIsoDate(rawDateBefore) : undefined;
  if (rawDateAfter && !dateAfter) {
    return {
      error: "invalid_date",
      message: "date_after must be YYYY-MM-DD format.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (rawDateBefore && !dateBefore) {
    return {
      error: "invalid_date",
      message: "date_before must be YYYY-MM-DD format.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (dateAfter && dateBefore && dateAfter > dateBefore) {
    return {
      error: "invalid_date_range",
      message: "date_after must be before date_before.",
      docs: "https://docs.openclaw.ai/tools/web",
    };
  }
  if (domainFilter?.length) {
    const hasDeny = domainFilter.some((entry) => entry.startsWith("-"));
    const hasAllow = domainFilter.some((entry) => !entry.startsWith("-"));
    if (hasDeny && hasAllow) {
      return {
        error: "invalid_domain_filter",
        message:
          "domain_filter cannot mix allowlist and denylist entries. Use either all positive entries (allowlist) or all entries prefixed with '-' (denylist).",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
    if (domainFilter.length > 20) {
      return {
        error: "invalid_domain_filter",
        message: "domain_filter supports a maximum of 20 domains.",
        docs: "https://docs.openclaw.ai/tools/web",
      };
    }
  }

  const cacheKey = buildSearchCacheKey([
    "perplexity",
    runtime.transport,
    runtime.baseUrl,
    runtime.model,
    query,
    resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
    country,
    language,
    freshness,
    dateAfter,
    dateBefore,
    domainFilter?.join(","),
    maxTokens,
    maxTokensPerPage,
  ]);
  const cached = readCachedSearchPayload(cacheKey);
  if (cached) {
    return cached;
  }

  const start = Date.now();
  const timeoutSeconds = resolveSearchTimeoutSeconds(searchConfig);
  const payload =
    runtime.transport === "chat_completions"
      ? {
          query,
          provider: "perplexity",
          model: runtime.model,
          tookMs: Date.now() - start,
          externalContent: {
            untrusted: true,
            source: "web_search",
            provider: "perplexity",
            wrapped: true,
          },
          ...(await (async () => {
            const result = await runPerplexitySearch({
              query,
              apiKey: runtime.apiKey!,
              baseUrl: runtime.baseUrl,
              model: runtime.model,
              timeoutSeconds,
              freshness,
            });
            return {
              content: wrapWebContent(result.content, "web_search"),
              citations: result.citations,
            };
          })()),
        }
      : {
          query,
          provider: "perplexity",
          count: 0,
          tookMs: Date.now() - start,
          externalContent: {
            untrusted: true,
            source: "web_search",
            provider: "perplexity",
            wrapped: true,
          },
          results: await runPerplexitySearchApi({
            query,
            apiKey: runtime.apiKey,
            count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
            timeoutSeconds,
            country: country ?? undefined,
            searchDomainFilter: domainFilter,
            searchRecencyFilter: freshness,
            searchLanguageFilter: language ? [language] : undefined,
            searchAfterDate: dateAfter ? isoToPerplexityDate(dateAfter) : undefined,
            searchBeforeDate: dateBefore ? isoToPerplexityDate(dateBefore) : undefined,
            maxTokens: maxTokens ?? undefined,
            maxTokensPerPage: maxTokensPerPage ?? undefined,
          }),
        };

  if (Array.isArray((payload as { results?: unknown[] }).results)) {
    (payload as { count: number }).count = (payload as { results: unknown[] }).results.length;
    (payload as { tookMs: number }).tookMs = Date.now() - start;
  } else {
    (payload as { tookMs: number }).tookMs = Date.now() - start;
  }

  writeCachedSearchPayload(cacheKey, payload, resolveSearchCacheTtlMs(searchConfig));
  return payload;
}

export const __testing = {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  resolvePerplexityModel,
  resolvePerplexityTransport,
  isDirectPerplexityBaseUrl,
  resolvePerplexityRequestModel,
  resolvePerplexityApiKey,
  normalizeToIsoDate,
  isoToPerplexityDate,
} as const;
