/**
 * web_fetch built-in tool.
 *
 * Fetches HTTP(S) content through SSRF guards, provider config, caching, and bounded extraction.
 */
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { Type } from "typebox";
import { resolveWebProviderConfig } from "../../../packages/web-content-core/src/provider-runtime-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { SsrFBlockedError, type LookupFn, type SsrFPolicy } from "../../infra/net/ssrf.js";
import { logDebug } from "../../logger.js";
import type { RuntimeWebFetchMetadata } from "../../secrets/runtime-web-tools.types.js";
import { wrapExternalContent, wrapWebContent } from "../../security/external-content.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { isRecord } from "../../utils.js";
import { extractReadableContent } from "../../web-fetch/content-extractors.runtime.js";
import { stringEnum } from "../schema/string-enum.js";
import { writePrivateTempFile } from "../sessions/tools/private-temp-file.js";
import { formatFullOutputFooter } from "../sessions/tools/tool-contracts.js";
import { setToolTerminalPresentation } from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readStringParam,
  scheduleToolProgress,
} from "./common.js";
import {
  extractBasicHtmlContent,
  htmlToMarkdown,
  markdownToText,
  truncateText,
  type ExtractMode,
} from "./web-fetch-utils.js";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  writeCache,
} from "./web-shared.js";
import type { CacheEntry } from "./web-shared.js";
import { resolveWebFetchToolRuntimeContext } from "./web-tool-runtime-context.js";

const EXTRACT_MODES = ["markdown", "text"] as const;

const DEFAULT_FETCH_MAX_CHARS = 20_000;
const DEFAULT_FETCH_MAX_RESPONSE_BYTES = 750_000;
const FETCH_MAX_RESPONSE_BYTES_MIN = 32_000;
const FETCH_MAX_RESPONSE_BYTES_MAX = 10_000_000;
const DEFAULT_FETCH_MAX_REDIRECTS = 3;
const WEB_FETCH_PROGRESS_THRESHOLD_MS = 5_000;
const WEB_FETCH_PROGRESS_TEXT = "Fetching page content...";
const DEFAULT_ERROR_MAX_CHARS = 4_000;
const DEFAULT_ERROR_MAX_BYTES = 64_000;
export const WEB_FETCH_SPILL_MAX_CHARS = 2_000_000;
const DEFAULT_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const FETCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

const WebFetchSchema = Type.Object({
  url: Type.String({ description: "HTTP(S) URL." }),
  extractMode: Type.Optional(
    stringEnum(EXTRACT_MODES, {
      description: "Extract as markdown/text.",
      default: "markdown",
    }),
  ),
  maxChars: Type.Optional(
    Type.Integer({
      description: "Max chars returned; truncates.",
      minimum: 100,
    }),
  ),
});

type WebFetchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web
  ? Web extends { fetch?: infer Fetch }
    ? Fetch
    : undefined
  : undefined;
type ResolveWebFetchDefinition =
  (typeof import("../../web-fetch/runtime.js"))["resolveWebFetchDefinition"];
type WebFetchProviderFallback = ReturnType<ResolveWebFetchDefinition>;
type WebFetchRuntimeModule = Pick<
  typeof import("../../web-fetch/runtime.js"),
  "resolveWebFetchDefinition"
>;
type WebGuardedFetchModule = Pick<
  typeof import("./web-guarded-fetch.js"),
  "fetchWithWebToolsNetworkGuard"
>;

const webFetchRuntimeLoader = createLazyImportLoader<WebFetchRuntimeModule>(
  () => import("../../web-fetch/runtime.js"),
);
const webGuardedFetchLoader = createLazyImportLoader<WebGuardedFetchModule>(
  () => import("./web-guarded-fetch.js"),
);

async function loadWebFetchRuntime(): Promise<WebFetchRuntimeModule> {
  return await webFetchRuntimeLoader.load();
}

async function loadWebGuardedFetch(): Promise<
  WebGuardedFetchModule["fetchWithWebToolsNetworkGuard"]
> {
  return (await webGuardedFetchLoader.load()).fetchWithWebToolsNetworkGuard;
}

function resolveFetchConfig(cfg?: OpenClawConfig): WebFetchConfig {
  return resolveWebProviderConfig(cfg, "fetch") as NonNullable<WebFetchConfig> | undefined;
}

function resolveFetchEnabled(params: { fetch?: WebFetchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.fetch?.enabled === "boolean") {
    return params.fetch.enabled;
  }
  return true;
}

function resolveFetchReadabilityEnabled(fetch?: WebFetchConfig): boolean {
  if (typeof fetch?.readability === "boolean") {
    return fetch.readability;
  }
  return true;
}

function resolveFetchUseTrustedEnvProxy(fetch?: WebFetchConfig): boolean {
  return fetch?.useTrustedEnvProxy === true;
}

function resolveFetchMaxCharsCap(fetch?: WebFetchConfig): number {
  const raw =
    fetch && "maxCharsCap" in fetch && typeof fetch.maxCharsCap === "number"
      ? fetch.maxCharsCap
      : undefined;
  return resolveIntegerOption(raw, DEFAULT_FETCH_MAX_CHARS, { min: 100 });
}

function resolveFetchMaxResponseBytes(fetch?: WebFetchConfig): number {
  const raw =
    fetch && "maxResponseBytes" in fetch && typeof fetch.maxResponseBytes === "number"
      ? fetch.maxResponseBytes
      : undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    return DEFAULT_FETCH_MAX_RESPONSE_BYTES;
  }
  const value = Math.floor(raw);
  return Math.min(FETCH_MAX_RESPONSE_BYTES_MAX, Math.max(FETCH_MAX_RESPONSE_BYTES_MIN, value));
}

function resolveMaxChars(value: unknown, fallback: number, cap: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(100, Math.floor(parsed));
  return Math.min(clamped, cap);
}

function resolveMaxRedirects(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.floor(parsed));
}

function looksLikeHtml(value: string): boolean {
  const trimmed = value.trimStart();
  if (!trimmed) {
    return false;
  }
  const head = normalizeLowercaseStringOrEmpty(trimmed.slice(0, 256));
  return head.startsWith("<!doctype html") || head.startsWith("<html");
}

function formatWebFetchErrorDetail(params: {
  detail: string;
  contentType?: string | null;
  maxChars: number;
}): string {
  const { detail, contentType, maxChars } = params;
  if (!detail) {
    return "";
  }
  let text = detail;
  const contentTypeLower = normalizeOptionalLowercaseString(contentType);
  if (contentTypeLower?.includes("text/html") || looksLikeHtml(detail)) {
    const rendered = htmlToMarkdown(detail);
    const withTitle = rendered.title ? `${rendered.title}\n${rendered.text}` : rendered.text;
    text = markdownToText(withTitle);
  }
  const truncated = truncateText(text.trim(), maxChars);
  return truncated.text;
}

function redactUrlForDebugLog(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    return parsed.pathname && parsed.pathname !== "/" ? `${parsed.origin}/...` : parsed.origin;
  } catch {
    return "[invalid-url]";
  }
}

const WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD = wrapWebContent("", "web_fetch").length;
const WEB_FETCH_WRAPPER_NO_WARNING_OVERHEAD = wrapExternalContent("", {
  source: "web_fetch",
  includeWarning: false,
}).length;

function formatTerminalWebFetchOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.origin;
  } catch {
    return undefined;
  }
}

function formatWebFetchTerminalPresentation(result: unknown): { text: string } | undefined {
  if (!isRecord(result) || !isRecord(result.details)) {
    return undefined;
  }
  const details = result.details;
  const origin =
    formatTerminalWebFetchOrigin(details.finalUrl) ?? formatTerminalWebFetchOrigin(details.url);
  const status = typeof details.status === "number" ? details.status : undefined;
  if (!origin || status === undefined) {
    return undefined;
  }
  const lines = [`Web fetch completed.`, `Origin: ${origin}`, `Status: ${status}`];
  if (typeof details.contentType === "string" && details.contentType.trim()) {
    lines.push(`Content type: ${details.contentType.trim()}`);
  }
  if (typeof details.rawLength === "number" && Number.isFinite(details.rawLength)) {
    lines.push(`Content length: ${Math.max(0, Math.floor(details.rawLength))} characters`);
  }
  if (details.truncated === true) {
    lines.push("Truncated: yes");
  }
  return { text: lines.join("\n") };
}

function wrapWebFetchContent(value: string, maxChars: number): WebFetchWrappedContent {
  if (maxChars <= 0) {
    return { text: "", truncated: true, rawLength: 0, wrappedLength: 0 };
  }
  const includeWarning = maxChars >= WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD;
  const wrapperOverhead = includeWarning
    ? WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD
    : WEB_FETCH_WRAPPER_NO_WARNING_OVERHEAD;
  if (wrapperOverhead > maxChars) {
    const minimal = includeWarning
      ? wrapWebContent("", "web_fetch")
      : wrapExternalContent("", { source: "web_fetch", includeWarning: false });
    const truncatedWrapper = truncateText(minimal, maxChars);
    return {
      text: truncatedWrapper.text,
      truncated: true,
      rawLength: 0,
      wrappedLength: truncatedWrapper.text.length,
    };
  }
  const maxInner = Math.max(0, maxChars - wrapperOverhead);
  let truncated = truncateText(value, maxInner);
  let wrappedText = includeWarning
    ? wrapWebContent(truncated.text, "web_fetch")
    : wrapExternalContent(truncated.text, { source: "web_fetch", includeWarning: false });

  if (wrappedText.length > maxChars) {
    const excess = wrappedText.length - maxChars;
    const adjustedMaxInner = Math.max(0, maxInner - excess);
    truncated = truncateText(value, adjustedMaxInner);
    wrappedText = includeWarning
      ? wrapWebContent(truncated.text, "web_fetch")
      : wrapExternalContent(truncated.text, { source: "web_fetch", includeWarning: false });
  }

  return {
    text: wrappedText,
    truncated: truncated.truncated,
    rawLength: truncated.text.length,
    wrappedLength: wrappedText.length,
  };
}

type WebFetchWrappedContent = {
  text: string;
  truncated: boolean;
  rawLength: number;
  wrappedLength: number;
  fullOutputPath?: string;
  spilledChars?: number;
  spillTruncated?: boolean;
};

async function spillWebFetchContent(
  value: string,
  wrapped: WebFetchWrappedContent,
  maxChars: number,
  sourceTruncated = false,
): Promise<WebFetchWrappedContent> {
  if (!wrapped.truncated) {
    return wrapped;
  }
  // maxChars/maxCharsCap bound the model-visible return text. Recoverable spill
  // uses this fixed file cap so vanished pages can still be read after truncation.
  const content = truncateUtf16Safe(value, WEB_FETCH_SPILL_MAX_CHARS);
  const spilledChars = content.length;
  const fullOutputPath = await writePrivateTempFile(
    "openclaw-web-fetch",
    wrapWebContent(content, "web_fetch"),
  );
  const spillCapped = value.length > WEB_FETCH_SPILL_MAX_CHARS;
  const spillTruncated = sourceTruncated || spillCapped;
  const spillNote = sourceTruncated
    ? " Spilled available content from truncated response."
    : spillCapped
      ? ` Spilled first ${spilledChars} chars.`
      : "";
  const fullOutputFooter = formatFullOutputFooter(fullOutputPath);
  const footer = `\n\n[Showing truncated web_fetch content. ${fullOutputFooter}.${spillNote}]`;
  const compactFooter = `[${fullOutputFooter}]`;
  let visible = wrapped;
  let text = wrapped.text;
  if (footer.length <= maxChars) {
    visible = wrapWebFetchContent(value, maxChars - footer.length);
    text = `${visible.text}${footer}`;
  } else if (compactFooter.length <= maxChars) {
    visible = { ...wrapped, text: "", rawLength: 0, wrappedLength: 0 };
    text = compactFooter;
  }
  return {
    ...visible,
    truncated: true,
    text,
    wrappedLength: text.length,
    fullOutputPath,
    spilledChars,
    spillTruncated,
  };
}

function wrapWebFetchField(value: string | undefined): string | undefined {
  if (!value) {
    return value;
  }
  return wrapExternalContent(value, { source: "web_fetch", includeWarning: false });
}

function normalizeContentType(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const [raw] = value.split(";");
  const trimmed = raw?.trim();
  return trimmed || undefined;
}

type WebFetchRuntimeParams = {
  url: string;
  extractMode: ExtractMode;
  maxChars: number;
  maxResponseBytes: number;
  maxRedirects: number;
  timeoutSeconds: number;
  cacheTtlMs: number;
  userAgent: string;
  readabilityEnabled: boolean;
  config?: OpenClawConfig;
  useTrustedEnvProxy: boolean;
  ssrfPolicy?: {
    allowRfc2544BenchmarkRange?: boolean;
    allowIpv6UniqueLocalRange?: boolean;
  };
  providerCacheKey?: string;
  lookupFn?: LookupFn;
  signal?: AbortSignal;
  resolveProviderFallback: () => Promise<WebFetchProviderFallback>;
};

function normalizeProviderFinalUrl(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  for (const char of trimmed) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f) {
      return undefined;
    }
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function throwIfFetchAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  // readResponseText may finish after an abort races with body reading. Recheck
  // before wrapping, caching, or returning content from a canceled tool call.
  throw signal.reason instanceof Error ? signal.reason : new Error("aborted");
}

/**
 * Sanitize a web_fetch URL parameter that may contain LLM-injected whitespace.
 *
 * Fixes the reported case where a model emits a space between the scheme and
 * authority (e.g. `https:// docs.openclaw.ai`), which causes `new URL()` to
 * throw. Path and query whitespace is intentionally preserved — the WHATWG URL
 * parser percent-encodes those characters correctly per RFC 3986.
 */
export function sanitizeWebFetchUrl(raw: string): string {
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  const trimmed = raw.slice(0, end).replace(/^\s+/, "");
  const repaired = trimmed.replace(/^(https?:\/\/)\s+/i, "$1");
  return repaired.replace(/^(https?:\/\/[^/?#\s]+)\s+$/i, "$1");
}

async function normalizeProviderWebFetchPayload(params: {
  providerId: string;
  payload: unknown;
  requestedUrl: string;
  extractMode: ExtractMode;
  maxChars: number;
  tookMs: number;
}): Promise<Record<string, unknown>> {
  const payload = isRecord(params.payload) ? params.payload : {};
  const rawText = typeof payload.text === "string" ? payload.text : "";
  const wrapped = await spillWebFetchContent(
    rawText,
    wrapWebFetchContent(rawText, params.maxChars),
    params.maxChars,
    payload.truncated === true,
  );
  const url = params.requestedUrl;
  const finalUrl = normalizeProviderFinalUrl(payload.finalUrl) ?? url;
  const status =
    typeof payload.status === "number" && Number.isFinite(payload.status)
      ? Math.max(0, Math.floor(payload.status))
      : 200;
  const contentType =
    typeof payload.contentType === "string" ? normalizeContentType(payload.contentType) : undefined;
  const title = typeof payload.title === "string" ? wrapWebFetchField(payload.title) : undefined;
  const warning =
    typeof payload.warning === "string" ? wrapWebFetchField(payload.warning) : undefined;
  const extractor =
    typeof payload.extractor === "string" && payload.extractor.trim()
      ? payload.extractor
      : params.providerId;

  return {
    url,
    finalUrl,
    ...(contentType ? { contentType } : {}),
    status,
    ...(title ? { title } : {}),
    extractMode: params.extractMode,
    extractor,
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      wrapped: true,
      provider: params.providerId,
    },
    truncated: wrapped.truncated,
    length: wrapped.wrappedLength,
    rawLength: wrapped.rawLength,
    wrappedLength: wrapped.wrappedLength,
    ...(wrapped.fullOutputPath ? { fullOutputPath: wrapped.fullOutputPath } : {}),
    ...(wrapped.spilledChars !== undefined ? { spilledChars: wrapped.spilledChars } : {}),
    ...(wrapped.spillTruncated ? { spillTruncated: true } : {}),
    fetchedAt:
      typeof payload.fetchedAt === "string" && payload.fetchedAt
        ? payload.fetchedAt
        : new Date().toISOString(),
    tookMs:
      typeof payload.tookMs === "number" && Number.isFinite(payload.tookMs)
        ? Math.max(0, Math.floor(payload.tookMs))
        : params.tookMs,
    text: wrapped.text,
    ...(warning ? { warning } : {}),
  };
}

async function maybeFetchProviderWebFetchPayload(
  params: WebFetchRuntimeParams & {
    urlToFetch: string;
    cacheKey: string;
    tookMs: number;
  },
): Promise<Record<string, unknown> | null> {
  const providerFallback = await params.resolveProviderFallback();
  if (!providerFallback) {
    return null;
  }
  const rawPayload = await providerFallback.definition.execute({
    url: params.urlToFetch,
    extractMode: params.extractMode,
    maxChars: params.maxChars,
  });
  const payload = await normalizeProviderWebFetchPayload({
    providerId: providerFallback.provider.id,
    payload: rawPayload,
    requestedUrl: params.url,
    extractMode: params.extractMode,
    maxChars: params.maxChars,
    tookMs: params.tookMs,
  });
  writeCache(FETCH_CACHE, params.cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function runWebFetch(params: WebFetchRuntimeParams): Promise<Record<string, unknown>> {
  const allowRfc2544BenchmarkRange = params.ssrfPolicy?.allowRfc2544BenchmarkRange === true;
  const allowIpv6UniqueLocalRange = params.ssrfPolicy?.allowIpv6UniqueLocalRange === true;
  const useTrustedEnvProxy = params.useTrustedEnvProxy;
  const ssrfPolicy: SsrFPolicy | undefined =
    allowRfc2544BenchmarkRange || allowIpv6UniqueLocalRange
      ? {
          ...(allowRfc2544BenchmarkRange ? { allowRfc2544BenchmarkRange } : {}),
          ...(allowIpv6UniqueLocalRange ? { allowIpv6UniqueLocalRange } : {}),
        }
      : undefined;
  const cacheKey = normalizeCacheKey(
    `fetch:${params.url}:${params.extractMode}:${params.maxChars}${params.providerCacheKey ? `:provider:${params.providerCacheKey}` : ""}${allowRfc2544BenchmarkRange ? ":allow-rfc2544" : ""}${allowIpv6UniqueLocalRange ? ":allow-ipv6-ula" : ""}${useTrustedEnvProxy ? ":trusted-env-proxy" : ""}`,
  );
  const cached = readCache(FETCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

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
  let release: (() => Promise<void>) | null;
  let finalUrl = params.url;
  try {
    const fetchWithWebToolsNetworkGuard = await loadWebGuardedFetch();
    const result = await fetchWithWebToolsNetworkGuard({
      url: params.url,
      maxRedirects: params.maxRedirects,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      lookupFn: params.lookupFn,
      useEnvProxy: useTrustedEnvProxy,
      policy: ssrfPolicy,
      init: {
        headers: {
          Accept: "text/markdown, text/html;q=0.9, */*;q=0.1",
          "User-Agent": params.userAgent,
          "Accept-Language": "en-US,en;q=0.9",
        },
      },
    });
    res = result.response;
    finalUrl = result.finalUrl;
    release = result.release;

    // Cloudflare Markdown for Agents — log token budget hint when present
    const markdownTokens = res.headers.get("x-markdown-tokens");
    if (markdownTokens) {
      logDebug(
        `[web-fetch] x-markdown-tokens: ${markdownTokens} (${redactUrlForDebugLog(finalUrl)})`,
      );
    }
  } catch (error) {
    if (error instanceof SsrFBlockedError) {
      throw error;
    }
    if (params.signal?.aborted) {
      throw error;
    }
    const payload = await maybeFetchProviderWebFetchPayload({
      ...params,
      urlToFetch: finalUrl,
      cacheKey,
      tookMs: Date.now() - start,
    });
    if (payload) {
      return payload;
    }
    throw error;
  }

  try {
    if (!res.ok) {
      if (params.signal?.aborted) {
        throw params.signal.reason instanceof Error ? params.signal.reason : new Error("aborted");
      }
      const payload = await maybeFetchProviderWebFetchPayload({
        ...params,
        urlToFetch: params.url,
        cacheKey,
        tookMs: Date.now() - start,
      });
      if (payload) {
        return payload;
      }
      const rawDetailResult = await readResponseText(res, { maxBytes: DEFAULT_ERROR_MAX_BYTES });
      throwIfFetchAborted(params.signal);
      const rawDetail = rawDetailResult.text;
      const detail = formatWebFetchErrorDetail({
        detail: rawDetail,
        contentType: res.headers.get("content-type"),
        maxChars: DEFAULT_ERROR_MAX_CHARS,
      });
      const wrappedDetail = wrapWebFetchContent(detail || res.statusText, DEFAULT_ERROR_MAX_CHARS);
      throw new Error(`Web fetch failed (${res.status}): ${wrappedDetail.text}`);
    }

    const contentType = res.headers.get("content-type") ?? "application/octet-stream";
    const normalizedContentType = normalizeContentType(contentType) ?? "application/octet-stream";
    const bodyResult = await readResponseText(res, { maxBytes: params.maxResponseBytes });
    throwIfFetchAborted(params.signal);
    const body = bodyResult.text;
    const responseTruncatedWarning = bodyResult.truncated
      ? `Response body incomplete after ${bodyResult.bytesRead} bytes.`
      : undefined;

    let title: string | undefined;
    let extractor = "raw";
    let text = body;
    if (contentType.includes("text/markdown")) {
      // Cloudflare Markdown for Agents: server returned pre-rendered markdown
      extractor = "cf-markdown";
      if (params.extractMode === "text") {
        text = markdownToText(body);
      }
    } else if (contentType.includes("text/html")) {
      if (params.readabilityEnabled) {
        const readable = await extractReadableContent({
          html: body,
          url: finalUrl,
          extractMode: params.extractMode,
          config: params.config,
        });
        if (readable?.text) {
          text = readable.text;
          title = readable.title;
          extractor = readable.extractor;
        } else {
          let payload: Record<string, unknown> | null = null;
          try {
            payload = await maybeFetchProviderWebFetchPayload({
              ...params,
              urlToFetch: finalUrl,
              cacheKey,
              tookMs: Date.now() - start,
            });
          } catch {
            payload = null;
          }
          if (payload) {
            return payload;
          }
          const basic = await extractBasicHtmlContent({
            html: body,
            extractMode: params.extractMode,
          });
          if (basic?.text) {
            text = basic.text;
            title = basic.title;
            extractor = "raw-html";
          } else {
            const providerLabel =
              (await params.resolveProviderFallback())?.provider.label ?? "provider fallback";
            throw new Error(
              `Web fetch extraction failed: Readability, ${providerLabel}, and basic HTML cleanup returned no content.`,
            );
          }
        }
      } else {
        const payload = await maybeFetchProviderWebFetchPayload({
          ...params,
          urlToFetch: finalUrl,
          cacheKey,
          tookMs: Date.now() - start,
        });
        if (payload) {
          return payload;
        }
        throw new Error(
          "Web fetch extraction failed: Readability disabled and no fetch provider is available.",
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

    const wrapped = await spillWebFetchContent(
      text,
      wrapWebFetchContent(text, params.maxChars),
      params.maxChars,
      bodyResult.truncated,
    );
    throwIfFetchAborted(params.signal);
    const wrappedTitle = title ? wrapWebFetchField(title) : undefined;
    const wrappedWarning = wrapWebFetchField(responseTruncatedWarning);
    const payload = {
      url: params.url, // Keep raw for tool chaining
      finalUrl, // Keep raw
      status: res.status,
      contentType: normalizedContentType, // Protocol metadata, don't wrap
      title: wrappedTitle,
      extractMode: params.extractMode,
      extractor,
      externalContent: {
        untrusted: true,
        source: "web_fetch",
        wrapped: true,
      },
      truncated: wrapped.truncated,
      length: wrapped.wrappedLength,
      rawLength: wrapped.rawLength, // Actual content length, not wrapped
      wrappedLength: wrapped.wrappedLength,
      ...(wrapped.fullOutputPath ? { fullOutputPath: wrapped.fullOutputPath } : {}),
      ...(wrapped.spilledChars !== undefined ? { spilledChars: wrapped.spilledChars } : {}),
      ...(wrapped.spillTruncated ? { spillTruncated: true } : {}),
      fetchedAt: new Date().toISOString(),
      tookMs: Date.now() - start,
      text: wrapped.text,
      warning: wrappedWarning,
    };
    writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  } finally {
    if (release) {
      await release();
    }
  }
}

export function createWebFetchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
  lateBindRuntimeConfig?: boolean;
  lookupFn?: LookupFn;
}): AnyAgentTool | null {
  const fetch = resolveFetchConfig(options?.config);
  if (!resolveFetchEnabled({ fetch, sandboxed: options?.sandboxed })) {
    return null;
  }
  const tool: AnyAgentTool = {
    label: "Web Fetch",
    name: "web_fetch",
    description:
      "Fetch URL and extract readable markdown/text. Lightweight page access; no browser automation.",
    parameters: WebFetchSchema,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const { config, preferRuntimeProviders, runtimeWebFetch } = resolveWebFetchToolRuntimeContext(
        {
          config: options?.config,
          lateBindRuntimeConfig: options?.lateBindRuntimeConfig,
          runtimeWebFetch: options?.runtimeWebFetch,
        },
      );
      const executionFetch = resolveFetchConfig(config);
      if (!resolveFetchEnabled({ fetch: executionFetch, sandboxed: options?.sandboxed })) {
        throw new Error("web_fetch is disabled.");
      }
      const providerCacheKey =
        normalizeOptionalLowercaseString(runtimeWebFetch?.selectedProvider) ??
        normalizeOptionalLowercaseString(runtimeWebFetch?.providerConfigured) ??
        (executionFetch && "provider" in executionFetch
          ? normalizeOptionalLowercaseString(executionFetch.provider)
          : undefined);
      const readabilityEnabled = resolveFetchReadabilityEnabled(executionFetch);
      const userAgent =
        (executionFetch &&
          "userAgent" in executionFetch &&
          typeof executionFetch.userAgent === "string" &&
          executionFetch.userAgent) ||
        DEFAULT_FETCH_USER_AGENT;
      const maxResponseBytes = resolveFetchMaxResponseBytes(executionFetch);
      let providerFallbackResolved = false;
      let providerFallbackCache: WebFetchProviderFallback;
      const resolveProviderFallback = async () => {
        if (!providerFallbackResolved) {
          const { resolveWebFetchDefinition } = await loadWebFetchRuntime();
          providerFallbackCache = resolveWebFetchDefinition({
            config,
            sandboxed: options?.sandboxed,
            runtimeWebFetch,
            preferRuntimeProviders,
          });
          providerFallbackResolved = true;
        }
        return providerFallbackCache;
      };
      const params = args as Record<string, unknown>;
      const url = sanitizeWebFetchUrl(
        readStringParam(params, "url", { required: true, trim: false }),
      );
      const extractMode = readStringParam(params, "extractMode") === "text" ? "text" : "markdown";
      const maxChars = readPositiveIntegerParam(params, "maxChars");
      const maxCharsCap = resolveFetchMaxCharsCap(executionFetch);
      // The progress line is emitted only if the fetch is still pending after
      // the threshold; fast cache/network hits clear the timer before it fires.
      const clearProgressTimer = scheduleToolProgress(
        onUpdate,
        { text: WEB_FETCH_PROGRESS_TEXT, id: "web_fetch:fetching" },
        WEB_FETCH_PROGRESS_THRESHOLD_MS,
        { signal },
      );
      try {
        const result = await runWebFetch({
          url,
          extractMode,
          maxChars: resolveMaxChars(
            maxChars ?? executionFetch?.maxChars,
            DEFAULT_FETCH_MAX_CHARS,
            maxCharsCap,
          ),
          maxResponseBytes,
          maxRedirects: resolveMaxRedirects(
            executionFetch?.maxRedirects,
            DEFAULT_FETCH_MAX_REDIRECTS,
          ),
          timeoutSeconds: resolveTimeoutSeconds(
            executionFetch?.timeoutSeconds,
            DEFAULT_TIMEOUT_SECONDS,
          ),
          cacheTtlMs: resolveCacheTtlMs(executionFetch?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
          userAgent,
          readabilityEnabled,
          config,
          useTrustedEnvProxy: resolveFetchUseTrustedEnvProxy(executionFetch),
          ssrfPolicy: executionFetch?.ssrfPolicy,
          ...(providerCacheKey ? { providerCacheKey } : {}),
          lookupFn: options?.lookupFn,
          signal,
          resolveProviderFallback,
        });
        return jsonResult(result);
      } finally {
        clearProgressTimer();
      }
    },
  };
  return setToolTerminalPresentation(tool, (_params, result) =>
    formatWebFetchTerminalPresentation(result),
  );
}
