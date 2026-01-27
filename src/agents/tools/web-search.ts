import { Type } from "@sinclair/typebox";

import type { MoltbotConfig } from "../../config/config.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringArrayParam, readStringParam } from "./common.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from "./web-shared.js";

const SEARCH_PROVIDERS = ["brave", "perplexity"] as const;
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const PERPLEXITY_SEARCH_ENDPOINT = "https://api.perplexity.ai/search";

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const PERPLEXITY_RECENCY_VALUES = new Set(["day", "week", "month", "year"]);

const FRESHNESS_TO_RECENCY: Record<string, string> = {
  pd: "day",
  pw: "week",
  pm: "month",
  py: "year",
};
const RECENCY_TO_FRESHNESS: Record<string, string> = {
  day: "pd",
  week: "pw",
  month: "pm",
  year: "py",
};

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERPLEXITY_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function isoToPerplexityDate(iso: string): string | undefined {
  const match = iso.match(ISO_DATE_PATTERN);
  if (!match) return undefined;
  const [, year, month, day] = match;
  return `${parseInt(month, 10)}/${parseInt(day, 10)}/${year}`;
}

function normalizeToIsoDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (ISO_DATE_PATTERN.test(trimmed)) return trimmed;
  const match = trimmed.match(PERPLEXITY_DATE_PATTERN);
  if (match) {
    const [, month, day, year] = match;
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  return undefined;
}

function createWebSearchSchema(provider: (typeof SEARCH_PROVIDERS)[number]) {
  const baseSchema = {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: MAX_SEARCH_COUNT,
      }),
    ),
    country: Type.Optional(
      Type.String({
        description:
          "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
      }),
    ),
    language: Type.Optional(
      Type.String({
        description: "ISO 639-1 language code for results (e.g., 'en', 'de', 'fr').",
      }),
    ),
    freshness: Type.Optional(
      Type.String({
        description: "Filter by time: 'day' (24h), 'week', 'month', or 'year'.",
      }),
    ),
    date_after: Type.Optional(
      Type.String({
        description: "Only results published after this date (YYYY-MM-DD).",
      }),
    ),
    date_before: Type.Optional(
      Type.String({
        description: "Only results published before this date (YYYY-MM-DD).",
      }),
    ),
  } as const;

  if (provider === "brave") {
    return Type.Object({
      ...baseSchema,
      ui_lang: Type.Optional(
        Type.String({
          description: "ISO language code for UI elements.",
        }),
      ),
    });
  }

  return Type.Object({
    ...baseSchema,
    domain_filter: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Domain filter (max 20). Allowlist: ['nature.com'] or denylist: ['-reddit.com']. Cannot mix.",
      }),
    ),
    max_tokens: Type.Optional(
      Type.Number({
        description: "Total content budget across all results (default: 25000, max: 1000000).",
        minimum: 1,
        maximum: 1000000,
      }),
    ),
    max_tokens_per_page: Type.Optional(
      Type.Number({
        description: "Max tokens extracted per page (default: 2048).",
        minimum: 1,
      }),
    ),
  });
}

type WebSearchConfig = NonNullable<MoltbotConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type PerplexityConfig = {
  apiKey?: string;
};

type PerplexityApiKeySource = "config" | "perplexity_env" | "none";

type PerplexitySearchApiResult = {
  title?: string;
  url?: string;
  snippet?: string;
  date?: string;
  last_updated?: string;
};

type PerplexitySearchApiResponse = {
  results?: PerplexitySearchApiResult[];
  id?: string;
};

function resolveSearchConfig(cfg?: MoltbotConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") return undefined;
  return search as WebSearchConfig;
}

function resolveSearchEnabled(params: { search?: WebSearchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.search?.enabled === "boolean") return params.search.enabled;
  if (params.sandboxed) return true;
  return true;
}

function resolveSearchApiKey(search?: WebSearchConfig): string | undefined {
  const fromConfig =
    search && "apiKey" in search && typeof search.apiKey === "string" ? search.apiKey.trim() : "";
  const fromEnv = (process.env.BRAVE_API_KEY ?? "").trim();
  return fromConfig || fromEnv || undefined;
}

function missingSearchKeyPayload(provider: (typeof SEARCH_PROVIDERS)[number]) {
  if (provider === "perplexity") {
    return {
      error: "missing_perplexity_api_key",
      message:
        "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
      docs: "https://docs.molt.bot/tools/web",
    };
  }
  return {
    error: "missing_brave_api_key",
    message: `web_search (brave) needs an API key. Run \`${formatCliCommand("moltbot configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
    docs: "https://docs.molt.bot/tools/web",
  };
}

function resolveSearchProvider(search?: WebSearchConfig): (typeof SEARCH_PROVIDERS)[number] {
  const raw =
    search && "provider" in search && typeof search.provider === "string"
      ? search.provider.trim().toLowerCase()
      : "";
  if (raw === "perplexity") return "perplexity";
  if (raw === "brave") return "brave";
  return "brave";
}

function resolvePerplexityConfig(search?: WebSearchConfig): PerplexityConfig {
  if (!search || typeof search !== "object") return {};
  const perplexity = "perplexity" in search ? search.perplexity : undefined;
  if (!perplexity || typeof perplexity !== "object") return {};
  return perplexity as PerplexityConfig;
}

function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: PerplexityApiKeySource;
} {
  const fromConfig = normalizeApiKey(perplexity?.apiKey);
  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }

  const fromEnvPerplexity = normalizeApiKey(process.env.PERPLEXITY_API_KEY);
  if (fromEnvPerplexity) {
    return { apiKey: fromEnvPerplexity, source: "perplexity_env" };
  }

  return { apiKey: undefined, source: "none" };
}

function normalizeApiKey(key: unknown): string {
  return typeof key === "string" ? key.trim() : "";
}

function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
  return clamped;
}

/**
 * Normalizes freshness shortcut to the provider's expected format.
 * Accepts both Brave format (pd/pw/pm/py) and Perplexity format (day/week/month/year).
 * Use date_after/date_before for specific date ranges.
 */
function normalizeFreshness(
  value: string | undefined,
  provider: (typeof SEARCH_PROVIDERS)[number],
): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();

  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) {
    return provider === "brave" ? lower : FRESHNESS_TO_RECENCY[lower];
  }

  if (PERPLEXITY_RECENCY_VALUES.has(lower)) {
    return provider === "perplexity" ? lower : RECENCY_TO_FRESHNESS[lower];
  }

  return undefined;
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
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
}): Promise<
  Array<{ title: string; url: string; description: string; published?: string; siteName?: string }>
> {
  const body: Record<string, unknown> = {
    query: params.query,
    max_results: params.count,
  };

  if (params.country) {
    body.country = params.country;
  }
  if (params.searchDomainFilter && params.searchDomainFilter.length > 0) {
    body.search_domain_filter = params.searchDomainFilter;
  }
  if (params.searchRecencyFilter) {
    body.search_recency_filter = params.searchRecencyFilter;
  }
  if (params.searchLanguageFilter && params.searchLanguageFilter.length > 0) {
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

  const res = await fetch(PERPLEXITY_SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${params.apiKey}`,
      "HTTP-Referer": "https://molt.bot",
      "X-Title": "Moltbot Web Search",
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Perplexity Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as PerplexitySearchApiResponse;
  const results = Array.isArray(data.results) ? data.results : [];

  // Map to align formats
  return results.map((entry) => ({
    title: entry.title ?? "",
    url: entry.url ?? "",
    description: entry.snippet ?? "",
    published: entry.date ?? undefined,
    siteName: resolveSiteName(entry.url ?? ""),
  }));
}

async function runWebSearch(params: {
  query: string;
  count: number;
  apiKey: string;
  timeoutSeconds: number;
  cacheTtlMs: number;
  provider: (typeof SEARCH_PROVIDERS)[number];
  country?: string;
  language?: string;
  ui_lang?: string;
  freshness?: string;
  dateAfter?: string;
  dateBefore?: string;
  searchDomainFilter?: string[];
  maxTokens?: number;
  maxTokensPerPage?: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.language || "default"}:${params.ui_lang || "default"}:${params.freshness || "default"}:${params.dateAfter || "default"}:${params.dateBefore || "default"}:${params.searchDomainFilter?.join(",") || "default"}:${params.maxTokens || "default"}:${params.maxTokensPerPage || "default"}`,
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) return { ...cached.value, cached: true };

  const start = Date.now();

  if (params.provider === "perplexity") {
    const results = await runPerplexitySearchApi({
      query: params.query,
      apiKey: params.apiKey,
      count: params.count,
      timeoutSeconds: params.timeoutSeconds,
      country: params.country,
      searchDomainFilter: params.searchDomainFilter,
      searchRecencyFilter: params.freshness,
      searchLanguageFilter: params.language ? [params.language] : undefined,
      searchAfterDate: params.dateAfter ? isoToPerplexityDate(params.dateAfter) : undefined,
      searchBeforeDate: params.dateBefore ? isoToPerplexityDate(params.dateBefore) : undefined,
      maxTokens: params.maxTokens,
      maxTokensPerPage: params.maxTokensPerPage,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      count: results.length,
      tookMs: Date.now() - start,
      results,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider !== "brave") {
    throw new Error("Unsupported web search provider.");
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.language) {
    url.searchParams.set("search_lang", params.language);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  } else if (params.dateAfter && params.dateBefore) {
    url.searchParams.set("freshness", `${params.dateAfter}to${params.dateBefore}`);
  } else if (params.dateAfter) {
    url.searchParams.set(
      "freshness",
      `${params.dateAfter}to${new Date().toISOString().slice(0, 10)}`,
    );
  } else if (params.dateBefore) {
    url.searchParams.set("freshness", `1970-01-01to${params.dateBefore}`);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": params.apiKey,
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
  const mapped = results.map((entry) => ({
    title: entry.title ?? "",
    url: entry.url ?? "",
    description: entry.description ?? "",
    published: entry.age ?? undefined,
    siteName: resolveSiteName(entry.url ?? ""),
  }));

  const payload = {
    query: params.query,
    provider: params.provider,
    count: mapped.length,
    tookMs: Date.now() - start,
    results: mapped,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createWebSearchTool(options?: {
  config?: MoltbotConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) return null;

  const provider = resolveSearchProvider(search);
  const perplexityConfig = resolvePerplexityConfig(search);

  const description =
    provider === "perplexity"
      ? "Search the web using the Perplexity Search API. Returns structured results (title, URL, snippet) for fast research. Supports a wide range of web search configurations including domain and region-specific filtering."
      : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.";

  return {
    label: "Web Search",
    name: "web_search",
    description,
    parameters: createWebSearchSchema(provider),
    execute: async (_toolCallId, args) => {
      const perplexityAuth =
        provider === "perplexity" ? resolvePerplexityApiKey(perplexityConfig) : undefined;
      const apiKey =
        provider === "perplexity" ? perplexityAuth?.apiKey : resolveSearchApiKey(search);

      if (!apiKey) {
        return jsonResult(missingSearchKeyPayload(provider));
      }
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ?? search?.maxResults ?? undefined;
      const country = readStringParam(params, "country");
      const language = readStringParam(params, "language");
      const ui_lang = readStringParam(params, "ui_lang");
      const rawFreshness = readStringParam(params, "freshness");
      const freshness = rawFreshness ? normalizeFreshness(rawFreshness, provider) : undefined;
      if (rawFreshness && !freshness) {
        return jsonResult({
          error: "invalid_freshness",
          message: "freshness must be day, week, month, or year.",
          docs: "https://docs.molt.bot/tools/web",
        });
      }
      const rawDateAfter = readStringParam(params, "date_after");
      const dateAfter = rawDateAfter ? normalizeToIsoDate(rawDateAfter) : undefined;
      if (rawDateAfter && !dateAfter) {
        return jsonResult({
          error: "invalid_date",
          message: "date_after must be YYYY-MM-DD format.",
          docs: "https://docs.molt.bot/tools/web",
        });
      }
      const rawDateBefore = readStringParam(params, "date_before");
      const dateBefore = rawDateBefore ? normalizeToIsoDate(rawDateBefore) : undefined;
      if (rawDateBefore && !dateBefore) {
        return jsonResult({
          error: "invalid_date",
          message: "date_before must be YYYY-MM-DD format.",
          docs: "https://docs.molt.bot/tools/web",
        });
      }
      const domainFilter = readStringArrayParam(params, "domain_filter");
      const maxTokens = readNumberParam(params, "max_tokens", { integer: true });
      const maxTokensPerPage = readNumberParam(params, "max_tokens_per_page", { integer: true });

      const result = await runWebSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        provider,
        country,
        language,
        ui_lang,
        freshness,
        dateAfter,
        dateBefore,
        searchDomainFilter: domainFilter,
        maxTokens: maxTokens ?? undefined,
        maxTokensPerPage: maxTokensPerPage ?? undefined,
      });
      return jsonResult(result);
    },
  };
}

export const __testing = {
  normalizeFreshness,
  normalizeToIsoDate,
  isoToPerplexityDate,
  SEARCH_CACHE,
  FRESHNESS_TO_RECENCY,
  RECENCY_TO_FRESHNESS,
} as const;
