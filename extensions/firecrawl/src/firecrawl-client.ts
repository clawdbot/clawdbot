// Firecrawl plugin module implements firecrawl client behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  markdownToText,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  withSelfHostedWebToolsEndpoint,
  withStrictWebToolsEndpoint,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-fetch";
import { normalizeSecretInput } from "openclaw/plugin-sdk/secret-input";
import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
  wrapWebContent,
} from "openclaw/plugin-sdk/security-runtime";
import {
  SsrFBlockedError,
  isBlockedHostnameOrIp,
  isPrivateIpAddress,
  resolvePinnedHostnameWithPolicy,
  type LookupFn,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  DEFAULT_FIRECRAWL_BASE_URL,
  resolveFirecrawlApiKey,
  resolveFirecrawlBaseUrl,
  resolveFirecrawlMaxAgeMs,
  resolveFirecrawlOnlyMainContent,
  resolveFirecrawlScrapeTimeoutSeconds,
  resolveFirecrawlSearchTimeoutSeconds,
} from "./config.js";

const SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const SCRAPE_CACHE = new Map<
  string,
  { value: Record<string, unknown>; expiresAt: number; insertedAt: number }
>();
const DEFAULT_SEARCH_COUNT = 5;
const FIRECRAWL_SEARCH_MAX_RESULTS = 100;
const FIRECRAWL_SEARCH_MAX_CONTENT_CHARS = 20_000;
const DEFAULT_SCRAPE_MAX_CHARS = 50_000;
const FIRECRAWL_SCRAPE_METADATA_MAX_CHARS = 4_000;
const FIRECRAWL_RESULT_URL_MAX_CHARS = 2_048;
const FIRECRAWL_SCRAPE_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;
const ALLOWED_FIRECRAWL_HOSTS = new Set(["api.firecrawl.dev"]);
const FIRECRAWL_PUBLISHED_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.+Z-]{0,20})?$/u;
const FIRECRAWL_SELF_HOSTED_PRIVATE_ERROR =
  "Firecrawl custom baseUrl must target a private or internal self-hosted endpoint.";
const FIRECRAWL_HTTP_PRIVATE_ERROR =
  "Firecrawl HTTP baseUrl must target a private or internal self-hosted endpoint. Use https:// for public hosts.";

type FirecrawlEndpointMode = "selfHosted" | "strict";
type FirecrawlResolvedEndpoint = {
  url: string;
  mode: FirecrawlEndpointMode;
};

type FirecrawlSearchItem = {
  title: string;
  url: string;
  description?: string;
  content?: string;
  published?: string;
  siteName?: string;
};

async function readFirecrawlJsonResponse(
  response: Response,
  label: string,
  opts?: { maxBytes?: number },
): Promise<Record<string, unknown>> {
  return await readProviderJsonObjectResponse(response, label, opts);
}

type FirecrawlSearchParams = {
  cfg?: OpenClawConfig;
  query: string;
  count?: number;
  timeoutSeconds?: number;
  sources?: string[];
  categories?: string[];
  scrapeResults?: boolean;
  includeDomains?: string[];
  excludeDomains?: string[];
  tbs?: string;
  location?: string;
  country?: string;
  access?: "credential" | "keyless";
  signal?: AbortSignal;
};

type FirecrawlScrapeParams = {
  cfg?: OpenClawConfig;
  url: string;
  extractMode: "markdown" | "text";
  access?: "credential" | "keyless";
  maxChars?: number;
  onlyMainContent?: boolean;
  maxAgeMs?: number;
  proxy?: "auto" | "basic" | "stealth";
  storeInCache?: boolean;
  timeoutSeconds?: number;
  signal?: AbortSignal;
};

export function assertFirecrawlScrapeTargetAllowed(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SsrFBlockedError("Invalid URL supplied to Firecrawl scrape");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SsrFBlockedError(
      `Blocked non-HTTP(S) protocol in Firecrawl scrape URL: ${parsed.protocol}`,
    );
  }
  if (isBlockedHostnameOrIp(parsed.hostname)) {
    throw new SsrFBlockedError(
      `Blocked hostname or private/internal IP in Firecrawl scrape URL: ${parsed.hostname}`,
    );
  }
}

function isOfficialFirecrawlEndpoint(url: URL): boolean {
  return url.protocol === "https:" && ALLOWED_FIRECRAWL_HOSTS.has(url.hostname);
}

async function firecrawlEndpointTargetsPrivateNetwork(
  url: URL,
  lookupFn?: LookupFn,
): Promise<boolean> {
  if (isBlockedHostnameOrIp(url.hostname)) {
    return true;
  }
  try {
    const pinned = await resolvePinnedHostnameWithPolicy(url.hostname, {
      lookupFn,
      policy: { allowPrivateNetwork: true },
    });
    return pinned.addresses.every((address) => isPrivateIpAddress(address));
  } catch {
    return false;
  }
}

async function validateFirecrawlBaseUrl(
  baseUrl: string,
  lookupFn?: LookupFn,
): Promise<FirecrawlEndpointMode> {
  let url: URL;
  try {
    url = new URL(baseUrl.trim() || DEFAULT_FIRECRAWL_BASE_URL);
  } catch {
    throw new Error("Firecrawl baseUrl must be a valid http:// or https:// URL.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Firecrawl baseUrl must use http:// or https://.");
  }
  if (isOfficialFirecrawlEndpoint(url)) {
    return "strict";
  }

  const isPrivateTarget = await firecrawlEndpointTargetsPrivateNetwork(url, lookupFn);
  if (isPrivateTarget) {
    return "selfHosted";
  }
  if (url.protocol === "http:") {
    throw new Error(FIRECRAWL_HTTP_PRIVATE_ERROR);
  }
  throw new Error(`${FIRECRAWL_SELF_HOSTED_PRIVATE_ERROR} Host: ${url.hostname}`);
}

async function resolveEndpoint(
  baseUrl: string,
  pathname: "/v2/search" | "/v2/scrape",
  lookupFn?: LookupFn,
): Promise<FirecrawlResolvedEndpoint> {
  const url = new URL(baseUrl.trim() || DEFAULT_FIRECRAWL_BASE_URL);
  const mode = await validateFirecrawlBaseUrl(url.toString(), lookupFn);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.pathname = pathname;
  return { url: url.toString(), mode };
}

async function postFirecrawlJson<T>(
  params: {
    url: string;
    mode?: FirecrawlEndpointMode;
    timeoutSeconds: number;
    apiKey?: string;
    body: Record<string, unknown>;
    errorLabel: string;
    signal?: AbortSignal;
  },
  parse: (response: Response) => Promise<T>,
): Promise<T> {
  const apiKey = normalizeSecretInput(params.apiKey);
  const mode = params.mode ?? (await validateFirecrawlBaseUrl(params.url));
  const withEndpoint =
    mode === "selfHosted" ? withSelfHostedWebToolsEndpoint : withStrictWebToolsEndpoint;
  return await withEndpoint(
    {
      url: params.url,
      timeoutSeconds: params.timeoutSeconds,
      ...(params.signal ? { signal: params.signal } : {}),
      init: {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Hosted Firecrawl accepts starter scrape requests without a token.
          // Send one only when configured so higher-limit accounts still apply.
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify(params.body),
      },
    },
    async ({ response }) => {
      if (!response.ok) {
        let detail =
          typeof response.statusText === "string" && response.statusText.trim()
            ? response.statusText.trim()
            : "request failed";

        const readJsonPayload = async (): Promise<Record<string, unknown> | null> => {
          const candidate = response as Response & { clone?: () => Response };
          const jsonResponse = typeof candidate.clone === "function" ? candidate.clone() : response;
          try {
            const body = await readResponseText(jsonResponse, { maxBytes: 64_000 });
            const payload = JSON.parse(body.text) as unknown;
            return payload && typeof payload === "object" && !Array.isArray(payload)
              ? (payload as Record<string, unknown>)
              : null;
          } catch {
            return null;
          }
        };

        const payload = await readJsonPayload();
        if (payload) {
          detail =
            typeof payload.error === "string"
              ? payload.error
              : typeof payload.message === "string"
                ? payload.message
                : detail;
        } else {
          const errorBody = await readResponseText(response, { maxBytes: 64_000 });
          if (errorBody.text) {
            detail = errorBody.text;
          }
        }
        const safeDetail = wrapWebContent(
          truncateSanitizedExternalContent(detail, 1_000).text,
          "web_fetch",
        );
        throw new Error(`${params.errorLabel} API error (${response.status}): ${safeDetail}`);
      }
      return await parse(response);
    },
  );
}

function resolveSiteName(urlRaw: string): string | undefined {
  try {
    const host = new URL(urlRaw).hostname.replace(/^www\./, "");
    return host || undefined;
  } catch {
    return undefined;
  }
}

function normalizeFirecrawlResultUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > FIRECRAWL_RESULT_URL_MAX_CHARS) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.href.length > FIRECRAWL_RESULT_URL_MAX_CHARS
    ) {
      return undefined;
    }
    // Preserve shipped bare-origin spellings while percent-encoding all other untrusted input.
    return url.href === `${value}/` ? value : url.href;
  } catch {
    return undefined;
  }
}

function resolveSearchItems(payload: Record<string, unknown>): FirecrawlSearchItem[] {
  const candidates = [
    payload.data,
    payload.results,
    (payload.data as { results?: unknown } | undefined)?.results,
    (payload.data as { data?: unknown } | undefined)?.data,
    (payload.data as { web?: unknown } | undefined)?.web,
    (payload.web as { results?: unknown } | undefined)?.results,
  ];
  const rawItems = candidates.find((candidate) => Array.isArray(candidate));
  if (!Array.isArray(rawItems)) {
    return [];
  }
  const items: FirecrawlSearchItem[] = [];
  for (const entry of rawItems.slice(0, FIRECRAWL_SEARCH_MAX_RESULTS)) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const metadata =
      record.metadata && typeof record.metadata === "object"
        ? (record.metadata as Record<string, unknown>)
        : undefined;
    const rawUrl =
      (typeof record.url === "string" && record.url) ||
      (typeof record.sourceURL === "string" && record.sourceURL) ||
      (typeof record.sourceUrl === "string" && record.sourceUrl) ||
      (typeof metadata?.sourceURL === "string" && metadata.sourceURL) ||
      "";
    const url = normalizeFirecrawlResultUrl(rawUrl);
    if (!url) {
      continue;
    }
    const title =
      (typeof record.title === "string" && record.title) ||
      (typeof metadata?.title === "string" && metadata.title) ||
      "";
    const description =
      (typeof record.description === "string" && record.description) ||
      (typeof record.snippet === "string" && record.snippet) ||
      (typeof record.summary === "string" && record.summary) ||
      undefined;
    const content =
      (typeof record.markdown === "string" && record.markdown) ||
      (typeof record.content === "string" && record.content) ||
      (typeof record.text === "string" && record.text) ||
      undefined;
    const rawPublished =
      (typeof record.publishedDate === "string" && record.publishedDate) ||
      (typeof record.published === "string" && record.published) ||
      (typeof metadata?.publishedTime === "string" && metadata.publishedTime) ||
      (typeof metadata?.publishedDate === "string" && metadata.publishedDate) ||
      undefined;
    const published =
      rawPublished && FIRECRAWL_PUBLISHED_DATE_RE.test(rawPublished) ? rawPublished : undefined;
    items.push({
      title,
      url,
      description,
      content,
      published,
      siteName: resolveSiteName(url),
    });
  }
  return items;
}

function buildSearchPayload(params: {
  query: string;
  provider: "firecrawl" | "firecrawl-free";
  items: FirecrawlSearchItem[];
  tookMs: number;
  scrapeResults: boolean;
}): Record<string, unknown> {
  let remainingContentChars = FIRECRAWL_SEARCH_MAX_CONTENT_CHARS;
  let truncated = false;
  const wrapBoundedContent = (value: string): string => {
    const bounded = truncateSanitizedExternalContent(value, remainingContentChars);
    truncated ||= bounded.truncated;
    remainingContentChars -= bounded.text.length;
    return wrapWebContent(bounded.text, "web_search");
  };
  const results = params.items.map((entry) => ({
    title: entry.title ? wrapBoundedContent(entry.title) : "",
    url: entry.url,
    description: entry.description ? wrapBoundedContent(entry.description) : "",
    ...(entry.published ? { published: entry.published } : {}),
    ...(entry.siteName ? { siteName: entry.siteName } : {}),
    ...(params.scrapeResults && entry.content
      ? { content: wrapBoundedContent(entry.content) }
      : {}),
  }));
  return {
    query: params.query,
    provider: params.provider,
    count: params.items.length,
    tookMs: params.tookMs,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: params.provider,
      wrapped: true,
    },
    results,
    ...(truncated ? { truncated: true } : {}),
  };
}

export async function runFirecrawlSearch(
  params: FirecrawlSearchParams,
): Promise<Record<string, unknown>> {
  params.signal?.throwIfAborted();
  const keyless = params.access === "keyless";
  const providerId = keyless ? "firecrawl-free" : "firecrawl";
  const apiKey = keyless ? undefined : resolveFirecrawlApiKey(params.cfg);
  if (!apiKey && !keyless) {
    throw new Error(
      "web_search (firecrawl) needs a Firecrawl API key. Set FIRECRAWL_API_KEY in the Gateway environment, or configure plugins.entries.firecrawl.config.webSearch.apiKey.",
    );
  }
  const count =
    typeof params.count === "number" && Number.isFinite(params.count)
      ? Math.max(1, Math.min(100, Math.floor(params.count)))
      : DEFAULT_SEARCH_COUNT;
  const timeoutSeconds = resolveFirecrawlSearchTimeoutSeconds(params.timeoutSeconds);
  const scrapeResults = params.scrapeResults === true;
  const sources = Array.isArray(params.sources) ? params.sources.filter(Boolean) : [];
  const categories = Array.isArray(params.categories) ? params.categories.filter(Boolean) : [];
  const includeDomains = Array.isArray(params.includeDomains)
    ? params.includeDomains.filter(Boolean)
    : [];
  const excludeDomains = Array.isArray(params.excludeDomains)
    ? params.excludeDomains.filter(Boolean)
    : [];
  if (includeDomains.length > 0 && excludeDomains.length > 0) {
    throw new Error("Firecrawl search accepts includeDomains or excludeDomains, not both.");
  }
  const tbs = normalizeOptionalString(params.tbs);
  const location = normalizeOptionalString(params.location);
  const country = normalizeOptionalString(params.country);
  const baseUrl = resolveFirecrawlBaseUrl(params.cfg);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "firecrawl-search",
      provider: providerId,
      q: params.query,
      count,
      baseUrl,
      sources,
      categories,
      includeDomains,
      excludeDomains,
      tbs,
      location,
      country,
      scrapeResults,
    }),
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const body: Record<string, unknown> = {
    query: params.query,
    limit: count,
  };
  if (sources.length > 0) {
    body.sources = sources;
  }
  if (categories.length > 0) {
    body.categories = categories;
  }
  if (includeDomains.length > 0) {
    body.includeDomains = includeDomains;
  }
  if (excludeDomains.length > 0) {
    body.excludeDomains = excludeDomains;
  }
  if (tbs) {
    body.tbs = tbs;
  }
  if (location) {
    body.location = location;
  }
  if (country) {
    body.country = country;
  }
  if (scrapeResults) {
    body.scrapeOptions = {
      formats: ["markdown"],
    };
  }

  const start = Date.now();
  const endpoint = await resolveEndpoint(baseUrl, "/v2/search");
  const payload = await postFirecrawlJson(
    {
      url: endpoint.url,
      mode: endpoint.mode,
      timeoutSeconds,
      apiKey,
      body,
      errorLabel: "Firecrawl Search",
      ...(params.signal ? { signal: params.signal } : {}),
    },
    async (response) => {
      const payloadValue = await readFirecrawlJsonResponse(response, "Firecrawl Search API error");
      if (payloadValue.success === false) {
        const error =
          typeof payloadValue.error === "string"
            ? payloadValue.error
            : typeof payloadValue.message === "string"
              ? payloadValue.message
              : "unknown error";
        const safeError = wrapWebContent(
          truncateSanitizedExternalContent(error, 1_000).text,
          "web_search",
        );
        throw new Error(`Firecrawl Search API error: ${safeError}`);
      }
      return payloadValue;
    },
  );
  const result = buildSearchPayload({
    query: params.query,
    provider: providerId,
    items: resolveSearchItems(payload).slice(0, count),
    tookMs: Date.now() - start,
    scrapeResults,
  });
  writeCache(
    SEARCH_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

function resolveScrapeData(payload: Record<string, unknown>): Record<string, unknown> {
  const data = payload.data;
  if (data && typeof data === "object") {
    return data as Record<string, unknown>;
  }
  return {};
}

export function parseFirecrawlScrapePayload(params: {
  payload: Record<string, unknown>;
  url: string;
  extractMode: "markdown" | "text";
  maxChars: number;
}): Record<string, unknown> {
  const data = resolveScrapeData(params.payload);
  const metadata =
    data.metadata && typeof data.metadata === "object"
      ? (data.metadata as Record<string, unknown>)
      : undefined;
  const markdown =
    (typeof data.markdown === "string" && data.markdown) ||
    (typeof data.content === "string" && data.content) ||
    "";
  if (!markdown) {
    throw new Error("Firecrawl scrape returned no content.");
  }
  const rawText = params.extractMode === "text" ? markdownToText(markdown) : markdown;
  const boundedText = truncateSanitizedExternalContent(rawText, params.maxChars);
  let truncated = boundedText.truncated;
  let remainingMetadataChars = FIRECRAWL_SCRAPE_METADATA_MAX_CHARS;
  const wrapBoundedMetadata = (value: string): string => {
    const bounded = truncateSanitizedExternalContent(value, remainingMetadataChars);
    truncated ||= bounded.truncated;
    remainingMetadataChars -= bounded.text.length;
    return wrapExternalContent(bounded.text, { source: "web_fetch", includeWarning: false });
  };
  const wrappedText = wrapExternalContent(boundedText.text, {
    source: "web_fetch",
    includeWarning: false,
  });
  const status =
    (typeof metadata?.statusCode === "number" && metadata.statusCode) ||
    (typeof data.statusCode === "number" && data.statusCode) ||
    undefined;
  const title =
    typeof metadata?.title === "string" && metadata.title
      ? wrapBoundedMetadata(metadata.title)
      : undefined;
  const warning =
    typeof params.payload.warning === "string" && params.payload.warning
      ? wrapBoundedMetadata(params.payload.warning)
      : undefined;
  return {
    url: params.url,
    finalUrl:
      normalizeFirecrawlResultUrl(metadata?.sourceURL) ??
      normalizeFirecrawlResultUrl(data.url) ??
      params.url,
    ...(status !== undefined ? { status } : {}),
    ...(title ? { title } : {}),
    extractor: "firecrawl",
    extractMode: params.extractMode,
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      wrapped: true,
    },
    truncated,
    rawLength: rawText.length,
    length: wrappedText.length,
    text: wrappedText,
    ...(warning ? { warning } : {}),
  };
}

export async function runFirecrawlScrape(
  params: FirecrawlScrapeParams,
): Promise<Record<string, unknown>> {
  params.signal?.throwIfAborted();
  assertFirecrawlScrapeTargetAllowed(params.url);

  const apiKey = resolveFirecrawlApiKey(params.cfg);
  // Hosted v2/scrape accepts starter requests without a bearer token.
  // Only the selected web_fetch provider opts into that access mode.
  if (!apiKey && params.access !== "keyless") {
    throw new Error(
      "firecrawl_scrape needs a Firecrawl API key. Set FIRECRAWL_API_KEY in the Gateway environment, or configure plugins.entries.firecrawl.config.webFetch.apiKey.",
    );
  }
  const baseUrl = resolveFirecrawlBaseUrl(params.cfg);
  const timeoutSeconds = resolveFirecrawlScrapeTimeoutSeconds(params.cfg, params.timeoutSeconds);
  const onlyMainContent = resolveFirecrawlOnlyMainContent(params.cfg, params.onlyMainContent);
  const maxAgeMs = resolveFirecrawlMaxAgeMs(params.cfg, params.maxAgeMs);
  const proxy = params.proxy ?? "auto";
  const storeInCache = params.storeInCache ?? true;
  const configuredMaxCharsCap = params.cfg?.tools?.web?.fetch?.maxCharsCap;
  const maxCharsCap =
    typeof configuredMaxCharsCap === "number" &&
    Number.isFinite(configuredMaxCharsCap) &&
    configuredMaxCharsCap > 0
      ? Math.floor(configuredMaxCharsCap)
      : DEFAULT_SCRAPE_MAX_CHARS;
  const requestedMaxChars =
    typeof params.maxChars === "number" && Number.isFinite(params.maxChars) && params.maxChars > 0
      ? Math.floor(params.maxChars)
      : DEFAULT_SCRAPE_MAX_CHARS;
  const maxChars = Math.min(requestedMaxChars, maxCharsCap);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      type: "firecrawl-scrape",
      url: params.url,
      extractMode: params.extractMode,
      baseUrl,
      onlyMainContent,
      maxAgeMs,
      proxy,
      storeInCache,
      maxChars,
    }),
  );
  const cached = readCache(SCRAPE_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const endpoint = await resolveEndpoint(baseUrl, "/v2/scrape");
  const payload = await postFirecrawlJson(
    {
      url: endpoint.url,
      mode: endpoint.mode,
      timeoutSeconds,
      apiKey,
      errorLabel: "Firecrawl",
      ...(params.signal ? { signal: params.signal } : {}),
      body: {
        url: params.url,
        formats: ["markdown"],
        onlyMainContent,
        timeout: timeoutSeconds * 1000,
        maxAge: maxAgeMs,
        proxy,
        storeInCache,
      },
    },
    async (response) => {
      const payloadLocal = await readFirecrawlJsonResponse(response, "Firecrawl fetch failed", {
        // Scrape can legitimately return page bodies before maxChars truncates parsed output.
        maxBytes: FIRECRAWL_SCRAPE_RESPONSE_MAX_BYTES,
      });
      if (payloadLocal.success === false) {
        const detail =
          typeof payloadLocal.error === "string"
            ? payloadLocal.error
            : typeof payloadLocal.message === "string"
              ? payloadLocal.message
              : response.statusText;
        throw new Error(
          `Firecrawl fetch failed (${response.status}): ${wrapWebContent(
            truncateSanitizedExternalContent(detail, FIRECRAWL_SCRAPE_METADATA_MAX_CHARS).text,
            "web_fetch",
          )}`.trim(),
        );
      }
      return payloadLocal;
    },
  );
  const result = parseFirecrawlScrapePayload({
    payload,
    url: params.url,
    extractMode: params.extractMode,
    maxChars,
  });
  writeCache(
    SCRAPE_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}

export const testing = {
  assertFirecrawlScrapeTargetAllowed,
  parseFirecrawlScrapePayload,
  postFirecrawlJson,
  readFirecrawlJsonResponse,
  resolveEndpoint,
  resolveSearchItems,
};
