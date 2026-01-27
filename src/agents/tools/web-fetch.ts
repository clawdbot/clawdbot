import { Type } from "@sinclair/typebox";

import type { MoltbotConfig } from "../../config/config.js";
import {
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostname,
  SsrFBlockedError,
} from "../../infra/net/ssrf.js";
import type { Dispatcher } from "undici";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
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
import {
  extractReadableContent,
  htmlToMarkdown,
  markdownToText,
  truncateText,
  type ExtractMode,
} from "./web-fetch-utils.js";

export { extractReadableContent } from "./web-fetch-utils.js";

const EXTRACT_MODES = ["markdown", "text"] as const;

const DEFAULT_FETCH_MAX_CHARS = 50_000;
const DEFAULT_FETCH_MAX_REDIRECTS = 3;
const DEFAULT_ERROR_MAX_CHARS = 4_000;
const DEFAULT_FIRECRAWL_BASE_URL = "https://api.firecrawl.dev";
const DEFAULT_FIRECRAWL_MAX_AGE_MS = 172_800_000;
const DEFAULT_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const FETCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const WebFetchSchema = Type.Object({
  url: Type.String({ description: "HTTP or HTTPS URL to fetch." }),
  extractMode: Type.Optional(
    stringEnum(EXTRACT_MODES, {
      description: 'Extraction mode ("markdown" or "text").',
      default: "markdown",
    }),
  ),
  maxChars: Type.Optional(
    Type.Number({
      description: "Maximum characters to return (truncates when exceeded).",
      minimum: 100,
    }),
  ),
});

type WebFetchConfig = NonNullable<MoltbotConfig["tools"]>["web"] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;

type FirecrawlFetchConfig =
  | {
      enabled?: boolean;
      apiKey?: string;
      baseUrl?: string;
      onlyMainContent?: boolean;
      maxAgeMs?: number;
      timeoutSeconds?: number;
    }
  | undefined;

function resolveFetchConfig(cfg?: MoltbotConfig): WebFetchConfig {
  const fetch = cfg?.tools?.web?.fetch;
  if (!fetch || typeof fetch !== "object") return undefined;
  return fetch as WebFetchConfig;
}

function resolveFetchEnabled(params: { fetch?: WebFetchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.fetch?.enabled === "boolean") return params.fetch.enabled;
  return true;
}

function resolveFetchReadabilityEnabled(fetch?: WebFetchConfig): boolean {
  if (typeof fetch?.readability === "boolean") return fetch.readability;
  return true;
}

function resolveFirecrawlConfig(fetch?: WebFetchConfig): FirecrawlFetchConfig {
  if (!fetch || typeof fetch !== "object") return undefined;
  const firecrawl = "firecrawl" in fetch ? fetch.firecrawl : undefined;
  if (!firecrawl || typeof firecrawl !== "object") return undefined;
  return firecrawl as FirecrawlFetchConfig;
}

function resolveFirecrawlApiKey(firecrawl?: FirecrawlFetchConfig): string | undefined {
  const fromConfig =
    firecrawl && "apiKey" in firecrawl && typeof firecrawl.apiKey === "string"
      ? firecrawl.apiKey.trim()
      : "";
  const fromEnv = (process.env.FIRECRAWL_API_KEY ?? "").trim();
  return fromConfig || fromEnv || undefined;
}

function resolveFirecrawlEnabled(params: {
  firecrawl?: FirecrawlFetchConfig;
  apiKey?: string;
}): boolean {
  if (typeof params.firecrawl?.enabled === "boolean") return params.firecrawl.enabled;
  return Boolean(params.apiKey);
}

function resolveFirecrawlBaseUrl(firecrawl?: FirecrawlFetchConfig): string {
  const raw =
    firecrawl && "baseUrl" in firecrawl && typeof firecrawl.baseUrl === "string"
      ? firecrawl.baseUrl.trim()
      : "";
  return raw || DEFAULT_FIRECRAWL_BASE_URL;
}

function resolveFirecrawlOnlyMainContent(firecrawl?: FirecrawlFetchConfig): boolean {
  if (typeof firecrawl?.onlyMainContent === "boolean") return firecrawl.onlyMainContent;
  return true;
}

function resolveFirecrawlMaxAgeMs(firecrawl?: FirecrawlFetchConfig): number | undefined {
  const raw =
    firecrawl && "maxAgeMs" in firecrawl && typeof firecrawl.maxAgeMs === "number"
      ? firecrawl.maxAgeMs
      : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  const parsed = Math.max(0, Math.floor(raw));
  return parsed > 0 ? parsed : undefined;
}

function resolveFirecrawlMaxAgeMsOrDefault(firecrawl?: FirecrawlFetchConfig): number {
  const resolved = resolveFirecrawlMaxAgeMs(firecrawl);
  if (typeof resolved === "number") return resolved;
  return DEFAULT_FIRECRAWL_MAX_AGE_MS;
}

function resolveMaxChars(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(100, Math.floor(parsed));
}

function resolveMaxRedirects(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.floor(parsed));
}

function looksLikeHtml(value: string): boolean {
  const trimmed = value.trimStart();
  if (!trimmed) return false;
  const head = trimmed.slice(0, 256).toLowerCase();
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

async function fetchWithRedirects(params: {
  url: string;
  maxRedirects: number;
  timeoutSeconds: number;
  userAgent: string;
}): Promise<{ response: Response; finalUrl: string; dispatcher: Dispatcher }> {
  const signal = withTimeout(undefined, params.timeoutSeconds * 1000);
  const visited = new Set<string>();
  let currentUrl = params.url;
  let redirectCount = 0;

  while (true) {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(currentUrl);
    } catch {
      throw new Error("Invalid URL: must be http or https");
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      throw new Error("Invalid URL: must be http or https");
    }

    const pinned = await resolvePinnedHostname(parsedUrl.hostname);
    const dispatcher = createPinnedDispatcher(pinned);
    let res: Response;
    try {
      res = await fetch(parsedUrl.toString(), {
        method: "GET",
        headers: {
          Accept: "*/*",
          "User-Agent": params.userAgent,
          "Accept-Language": "en-US,en;q=0.9",
        },
        signal,
        redirect: "manual",
        dispatcher,
      } as RequestInit);
    } catch (err) {
      await closeDispatcher(dispatcher);
      throw err;
    }

    if (isRedirectStatus(res.status)) {
      const location = res.headers.get("location");
      if (!location) {
        await closeDispatcher(dispatcher);
        throw new Error(`Redirect missing location header (${res.status})`);
      }
      redirectCount += 1;
      if (redirectCount > params.maxRedirects) {
        await closeDispatcher(dispatcher);
        throw new Error(`Too many redirects (limit: ${params.maxRedirects})`);
      }
      const nextUrl = new URL(location, parsedUrl).toString();
      if (visited.has(nextUrl)) {
        await closeDispatcher(dispatcher);
        throw new Error("Redirect loop detected");
      }
      visited.add(nextUrl);
      void res.body?.cancel();
      await closeDispatcher(dispatcher);
      currentUrl = nextUrl;
      continue;
    }

    return { response: res, finalUrl: currentUrl, dispatcher };
  }
}

function formatWebFetchErrorDetail(params: {
  detail: string;
  contentType?: string | null;
  maxChars: number;
}): string {
  const { detail, contentType, maxChars } = params;
  if (!detail) return "";
  let text = detail;
  const contentTypeLower = contentType?.toLowerCase();
  if (contentTypeLower?.includes("text/html") || looksLikeHtml(detail)) {
    const rendered = htmlToMarkdown(detail);
    const withTitle = rendered.title ? `${rendered.title}\n${rendered.text}` : rendered.text;
    text = markdownToText(withTitle);
  }
  const truncated = truncateText(text.trim(), maxChars);
  return truncated.text;
}
export async function fetchFirecrawlContent(params: {
  url: string;
  extractMode: ExtractMode;
  apiKey: string;
  baseUrl: string;
  onlyMainContent: boolean;
  maxAgeMs: number;
  proxy: "auto" | "basic" | "stealth";
  storeInCache: boolean;
  timeoutSeconds: number;
}): Promise<{
  text: string;
  title?: string;
  finalUrl?: string;
  status?: number;
  warning?: string;
}> {
  const endpoint = resolveFirecrawlEndpoint(params.baseUrl);
  const body: Record<string, unknown> = {
    url: params.url,
    formats: ["markdown"],
    onlyMainContent: params.onlyMainContent,
    timeout: params.timeoutSeconds * 1000,
    maxAge: params.maxAgeMs,
    proxy: params.proxy,
    storeInCache: params.storeInCache,
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${params.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  const payload = (await res.json()) as {
    success?: boolean;
    data?: {
      markdown?: string;
      content?: string;
      metadata?: {
        title?: string;
        sourceURL?: string;
        statusCode?: number;
      };
    };
    warning?: string;
    error?: string;
  };

  if (!res.ok || payload?.success === false) {
    const detail = payload?.error || res.statusText;
    throw new Error(`Firecrawl fetch failed (${res.status}): ${detail}`.trim());
  }

  const data = payload?.data ?? {};
  const rawText =
    typeof data.markdown === "string"
      ? data.markdown
      : typeof data.content === "string"
        ? data.content
        : "";
  const text = params.extractMode === "text" ? markdownToText(rawText) : rawText;
  return {
    text,
    title: data.metadata?.title,
    finalUrl: data.metadata?.sourceURL,
    status: data.metadata?.statusCode,
    warning: payload?.warning,
  };
}

async function runWebFetch(params: {
  url: string;
  extractMode: ExtractMode;
  maxChars: number;
  maxRedirects: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
  userAgent: string;
  readabilityEnabled: boolean;
  firecrawlEnabled: boolean;
  firecrawlApiKey?: string;
  firecrawlBaseUrl: string;
  firecrawlOnlyMainContent: boolean;
  firecrawlMaxAgeMs: number;
  firecrawlProxy: "auto" | "basic" | "stealth";
  firecrawlStoreInCache: boolean;
  firecrawlTimeoutSeconds: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    `fetch:${params.url}:${params.extractMode}:${params.maxChars}`,
  );
  const cached = readCache(FETCH_CACHE, cacheKey);
  if (cached) return { ...cached.value, cached: true };

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error("Invalid URL: must be http or https");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Invalid URL: must be http or https");
  }

  const start = Date.now();
  let res: Response;
  let dispatcher: Dispatcher | null = null;
  let finalUrl = params.url;
  try {
    const result = await fetchWithRedirects({
      url: params.url,
      maxRedirects: params.maxRedirects,
      timeoutSeconds: params.timeoutSeconds,
      userAgent: params.userAgent,
    });
    res = result.response;
    finalUrl = result.finalUrl;
    dispatcher = result.dispatcher;
  } catch (error) {
    if (error instanceof SsrFBlockedError) {
      throw error;
    }
    if (params.firecrawlEnabled && params.firecrawlApiKey) {
      const firecrawl = await fetchFirecrawlContent({
        url: finalUrl,
        extractMode: params.extractMode,
        apiKey: params.firecrawlApiKey,
        baseUrl: params.firecrawlBaseUrl,
        onlyMainContent: params.firecrawlOnlyMainContent,
        maxAgeMs: params.firecrawlMaxAgeMs,
        proxy: params.firecrawlProxy,
        storeInCache: params.firecrawlStoreInCache,
        timeoutSeconds: params.firecrawlTimeoutSeconds,
      });
      const truncated = truncateText(firecrawl.text, params.maxChars);
      const payload = {
        url: params.url,
        finalUrl: firecrawl.finalUrl || finalUrl,
        status: firecrawl.status ?? 200,
        contentType: "text/markdown",
        title: firecrawl.title,
        extractMode: params.extractMode,
        extractor: "firecrawl",
        truncated: truncated.truncated,
        length: truncated.text.length,
        fetchedAt: new Date().toISOString(),
        tookMs: Date.now() - start,
        text: truncated.text,
        warning: firecrawl.warning,
      };
      writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
      return payload;
    }
    throw error;
  }

  try {
    if (!res.ok) {
      if (params.firecrawlEnabled && params.firecrawlApiKey) {
        const firecrawl = await fetchFirecrawlContent({
          url: params.url,
          extractMode: params.extractMode,
          apiKey: params.firecrawlApiKey,
          baseUrl: params.firecrawlBaseUrl,
          onlyMainContent: params.firecrawlOnlyMainContent,
          maxAgeMs: params.firecrawlMaxAgeMs,
          proxy: params.firecrawlProxy,
          storeInCache: params.firecrawlStoreInCache,
          timeoutSeconds: params.firecrawlTimeoutSeconds,
        });
        const truncated = truncateText(firecrawl.text, params.maxChars);
        const payload = {
          url: params.url,
          finalUrl: firecrawl.finalUrl || finalUrl,
          status: firecrawl.status ?? res.status,
          contentType: "text/markdown",
          title: firecrawl.title,
          extractMode: params.extractMode,
          extractor: "firecrawl",
          truncated: truncated.truncated,
          length: truncated.text.length,
          fetchedAt: new Date().toISOString(),
          tookMs: Date.now() - start,
          text: truncated.text,
          warning: firecrawl.warning,
        };
        writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
        return payload;
      }
      const rawDetail = await readResponseText(res);
      const detail = formatWebFetchErrorDetail({
        detail: rawDetail,
        contentType: res.headers.get("content-type"),
        maxChars: DEFAULT_ERROR_MAX_CHARS,
      });
      throw new Error(`Web fetch failed (${res.status}): ${detail || res.statusText}`);
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const body = await readResponseText(res);

    let title: string | undefined;
    let extractor = "raw";
    let text = body;
    if (contentType.includes("text/html")) {
      if (params.readabilityEnabled) {
        const readable = await extractReadableContent({
          html: body,
          url: finalUrl,
          extractMode: params.extractMode,
        });
        if (readable?.text) {
          text = readable.text;
          title = readable.title;
          extractor = "readability";
        } else {
          const firecrawl = await tryFirecrawlFallback({ ...params, url: finalUrl });
          if (firecrawl) {
            text = firecrawl.text;
            title = firecrawl.title;
            extractor = "firecrawl";
          } else {
            throw new Error(
              "Web fetch extraction failed: Readability and Firecrawl returned no content.",
            );
          }
        }
      } else {
        throw new Error(
          "Web fetch extraction failed: Readability disabled and Firecrawl unavailable.",
        );
      }
    } else if (contentType.includes("application/json")) {
      try {
        text = JSON.stringify(JSON.parse(body), null, 2);
        extractor = "json";
      } catch {
        text = body;
        extractor = "raw";
      }
    }

    const truncated = truncateText(text, params.maxChars);
    const payload = {
      url: params.url,
      finalUrl,
      status: res.status,
      contentType,
      title,
      extractMode: params.extractMode,
      extractor,
      truncated: truncated.truncated,
      length: truncated.text.length,
      fetchedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
      text: truncated.text,
    };
    writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  } finally {
    await closeDispatcher(dispatcher);
  }
}

async function tryFirecrawlFallback(params: {
  url: string;
  extractMode: ExtractMode;
  firecrawlEnabled: boolean;
  firecrawlApiKey?: string;
  firecrawlBaseUrl: string;
  firecrawlOnlyMainContent: boolean;
  firecrawlMaxAgeMs: number;
  firecrawlProxy: "auto" | "basic" | "stealth";
  firecrawlStoreInCache: boolean;
  firecrawlTimeoutSeconds: number;
}): Promise<{ text: string; title?: string } | null> {
  if (!params.firecrawlEnabled || !params.firecrawlApiKey) return null;
  try {
    const firecrawl = await fetchFirecrawlContent({
      url: params.url,
      extractMode: params.extractMode,
      apiKey: params.firecrawlApiKey,
      baseUrl: params.firecrawlBaseUrl,
      onlyMainContent: params.firecrawlOnlyMainContent,
      maxAgeMs: params.firecrawlMaxAgeMs,
      proxy: params.firecrawlProxy,
      storeInCache: params.firecrawlStoreInCache,
      timeoutSeconds: params.firecrawlTimeoutSeconds,
    });
    return { text: firecrawl.text, title: firecrawl.title };
  } catch {
    return null;
  }
}

function resolveFirecrawlEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return `${DEFAULT_FIRECRAWL_BASE_URL}/v2/scrape`;
  try {
    const url = new URL(trimmed);
    if (url.pathname && url.pathname !== "/") {
      return url.toString();
    }
    url.pathname = "/v2/scrape";
    return url.toString();
  } catch {
    return `${DEFAULT_FIRECRAWL_BASE_URL}/v2/scrape`;
  }
}

export function createWebFetchTool(options?: {
  config?: MoltbotConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const fetch = resolveFetchConfig(options?.config);
  if (!resolveFetchEnabled({ fetch, sandboxed: options?.sandboxed })) return null;
  const readabilityEnabled = resolveFetchReadabilityEnabled(fetch);
  const firecrawl = resolveFirecrawlConfig(fetch);
  const firecrawlApiKey = resolveFirecrawlApiKey(firecrawl);
  const firecrawlEnabled = resolveFirecrawlEnabled({ firecrawl, apiKey: firecrawlApiKey });
  const firecrawlBaseUrl = resolveFirecrawlBaseUrl(firecrawl);
  const firecrawlOnlyMainContent = resolveFirecrawlOnlyMainContent(firecrawl);
  const firecrawlMaxAgeMs = resolveFirecrawlMaxAgeMsOrDefault(firecrawl);
  const firecrawlTimeoutSeconds = resolveTimeoutSeconds(
    firecrawl?.timeoutSeconds ?? fetch?.timeoutSeconds,
    DEFAULT_TIMEOUT_SECONDS,
  );
  const userAgent =
    (fetch && "userAgent" in fetch && typeof fetch.userAgent === "string" && fetch.userAgent) ||
    DEFAULT_FETCH_USER_AGENT;
  return {
    label: "Web Fetch",
    name: "web_fetch",
    description:
      "Fetch and extract readable content from a URL (HTML → markdown/text). Use for lightweight page access without browser automation.",
    parameters: WebFetchSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const url = readStringParam(params, "url", { required: true });
      const extractMode = readStringParam(params, "extractMode") === "text" ? "text" : "markdown";
      const maxChars = readNumberParam(params, "maxChars", { integer: true });
      const result = await runWebFetch({
        url,
        extractMode,
        maxChars: resolveMaxChars(maxChars ?? fetch?.maxChars, DEFAULT_FETCH_MAX_CHARS),
        maxRedirects: resolveMaxRedirects(fetch?.maxRedirects, DEFAULT_FETCH_MAX_REDIRECTS),
        timeoutSeconds: resolveTimeoutSeconds(fetch?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(fetch?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        userAgent,
        readabilityEnabled,
        firecrawlEnabled,
        firecrawlApiKey,
        firecrawlBaseUrl,
        firecrawlOnlyMainContent,
        firecrawlMaxAgeMs,
        firecrawlProxy: "auto",
        firecrawlStoreInCache: true,
        firecrawlTimeoutSeconds,
      });
      return jsonResult(result);
    },
  };
}
