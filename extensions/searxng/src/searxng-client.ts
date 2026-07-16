import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_SEARCH_COUNT,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveSearchCount,
  resolveSiteName,
  resolveTimeoutSeconds,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  assertHttpUrlTargetsPrivateNetwork,
  type LookupFn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import {
  resolveSearxngBaseUrl,
  resolveSearxngCategories,
  resolveSearxngLanguage,
} from "./config.js";

const DEFAULT_TIMEOUT_SECONDS = 20;
const MAX_RESPONSE_BYTES = 1_000_000;

const SEARXNG_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

type SearxngResult = {
  url: string;
  title: string;
  content?: string;
};

type SearxngResponse = {
  results?: SearxngResult[];
};

function normalizeSearxngResult(value: unknown): SearxngResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as { url?: unknown; title?: unknown; content?: unknown };
  if (typeof candidate.url !== "string" || typeof candidate.title !== "string") {
    return null;
  }

  return {
    url: candidate.url,
    title: candidate.title,
    content: typeof candidate.content === "string" ? candidate.content : undefined,
  };
}

function buildSearxngSearchUrl(params: {
  baseUrl: string;
  query: string;
  categories?: string;
  language?: string;
}): string {
  const url = new URL(params.baseUrl);
  const pathname = url.pathname.endsWith("/") ? `${url.pathname}search` : `${url.pathname}/search`;
  url.pathname = pathname;
  url.search = "";
  url.searchParams.set("q", params.query);
  url.searchParams.set("format", "json");
  if (params.categories) {
    url.searchParams.set("categories", params.categories);
  }
  if (params.language) {
    url.searchParams.set("language", params.language);
  }
  return url.toString();
}

async function validateSearxngBaseUrl(baseUrl: string, lookupFn?: LookupFn): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("SearXNG base URL must be a valid http:// or https:// URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("SearXNG base URL must use http:// or https://.");
  }

  if (parsed.protocol === "http:") {
    await assertHttpUrlTargetsPrivateNetwork(parsed.toString(), {
      dangerouslyAllowPrivateNetwork: true,
      lookupFn,
      errorMessage:
        "SearXNG HTTP base URL must target a trusted private or loopback host. Use https:// for public hosts.",
    });
  }
}

function parseSearxngResponseText(text: string, count: number): SearxngResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as SearxngResponse;
  } catch {
    throw new Error("SearXNG returned invalid JSON.");
  }

  if (!parsed || typeof parsed !== "object") {
    return [];
  }

  const response = parsed as SearxngResponse;
  const rawResults = Array.isArray(response.results) ? response.results : [];
  const results: SearxngResult[] = [];

  for (const rawResult of rawResults) {
    const result = normalizeSearxngResult(rawResult);
    if (result) {
      results.push(result);
    }
    if (results.length >= count) {
      break;
    }
  }

  return results;
}

export async function runSearxngSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
  categories?: string;
  language?: string;
  baseUrl?: string;
  timeoutSeconds?: number;
  cacheTtlMinutes?: number;
}): Promise<Record<string, unknown>> {
  const count = resolveSearchCount(params.count, DEFAULT_SEARCH_COUNT);
  const categories = params.categories ?? resolveSearxngCategories(params.config);
  const language = params.language ?? resolveSearxngLanguage(params.config);
  const baseUrl = params.baseUrl ?? resolveSearxngBaseUrl(params.config);
  const timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
  const cacheTtlMs = resolveCacheTtlMs(params.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);

  if (!baseUrl) {
    throw new Error(
      "SearXNG base URL is not configured. Set SEARXNG_BASE_URL or configure plugins.entries.searxng.config.webSearch.baseUrl.",
    );
  }
  await validateSearxngBaseUrl(baseUrl);

  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      provider: "searxng",
      query: params.query,
      count,
      categories: categories ?? "",
      language: language ?? "",
      baseUrl,
    }),
  );
  const cached = readCache(SEARXNG_SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const url = buildSearxngSearchUrl({
    baseUrl,
    query: params.query,
    categories,
    language,
  });

  const startedAt = Date.now();
  const results = await withTrustedWebSearchEndpoint(
    {
      url,
      timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      },
    },
    async (response) => {
      if (!response.ok) {
        const detail = (await readResponseText(response, { maxBytes: 64_000 })).text;
        throw new Error(
          `SearXNG search error (${response.status}): ${detail || response.statusText}`,
        );
      }

      const body = await readResponseText(response, { maxBytes: MAX_RESPONSE_BYTES });
      if (body.truncated) {
        throw new Error("SearXNG response too large.");
      }
      return parseSearxngResponseText(body.text, count);
    },
  );

  const payload = {
    query: params.query,
    provider: "searxng",
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "searxng",
      wrapped: true,
    },
    results: results.map((result) => ({
      title: wrapWebContent(result.title, "web_search"),
      url: result.url,
      snippet: result.content ? wrapWebContent(result.content, "web_search") : "",
      siteName: resolveSiteName(result.url) || undefined,
    })),
  } satisfies Record<string, unknown>;

  writeCache(SEARXNG_SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
  return payload;
}

export const __testing = {
  buildSearxngSearchUrl,
  normalizeSearxngResult,
  parseSearxngResponseText,
  validateSearxngBaseUrl,
  SEARXNG_SEARCH_CACHE,
};
