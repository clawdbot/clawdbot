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
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { SsrFBlockedError, type LookupFn, type SsrFPolicy } from "../../infra/net/ssrf.js";
import { logDebug, logWarn } from "../../logger.js";
import { assertSecretOwnerAvailable } from "../../secrets/runtime-degraded-state.js";
import { runtimeWebSecretOwnerId } from "../../secrets/runtime-web-secret-owner.js";
import type { RuntimeWebFetchMetadata } from "../../secrets/runtime-web-tools.types.js";
import {
  truncateSanitizedExternalContent,
  wrapExternalContent,
  wrapWebContent,
} from "../../security/external-content.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { isRecord } from "../../utils.js";
import { extractReadableContent } from "../../web-fetch/content-extractors.runtime.js";
import { resolveWebProviderConfig } from "../../web/provider-runtime-shared.js";
import { stringEnum } from "../schema/string-enum.js";
import { writePrivateTempFile } from "../sessions/tools/private-temp-file.js";
import { formatFullOutputFooter } from "../sessions/tools/tool-contracts.js";
import { setToolTerminalPresentation } from "../tool-terminal-presentation.js";
import type { AnyAgentTool } from "./common.js";
import {
  jsonResult,
  readPositiveIntegerParam,
  readToolStringParam,
  scheduleToolProgress,
} from "./common.js";
import {
  extractBasicHtmlContent,
  htmlToMarkdown,
  markdownToText,
  truncateWebFetchText,
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
const WEB_FETCH_SPILL_MAX_CHARS = 2_000_000;
// Titles and warnings are display metadata: 256 chars each is ample. Their
// shared wrapped allowance leaves at least half of maxChars for page content.
const WEB_FETCH_FIELD_MAX_CHARS = 256;
const WEB_FETCH_METADATA_MAX_CHARS = 512;
// Keep URLs whole for tool chaining, matching the fetch-provider URL bound.
const WEB_FETCH_RESULT_URL_MAX_CHARS = 2_048;
const DEFAULT_FETCH_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const FETCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();

// Accept and Accept-Language are part of the fetch/readability contract,
// User-Agent has its own tools.web.fetch.userAgent key, and Undici owns
// Sec-Fetch-Mode.
const FETCH_BLOCKED_HEADER_NAMES = new Set([
  "accept",
  "accept-language",
  "user-agent",
  "sec-fetch-mode",
  "connection",
  "content-length",
  "expect",
  "host",
  "keep-alive",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

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

const WebFetchOutputSchema = Type.Object(
  {
    url: Type.String(),
    finalUrl: Type.String(),
    status: Type.Integer({ minimum: 0 }),
    contentType: Type.Optional(Type.String()),
    title: Type.Optional(Type.String()),
    extractMode: stringEnum(EXTRACT_MODES),
    extractor: Type.String(),
    externalContent: Type.Object(
      {
        untrusted: Type.Literal(true),
        source: Type.Literal("web_fetch"),
        wrapped: Type.Literal(true),
        provider: Type.Optional(Type.String()),
      },
      { additionalProperties: false },
    ),
    truncated: Type.Boolean(),
    length: Type.Integer({ minimum: 0 }),
    rawLength: Type.Integer({ minimum: 0 }),
    spill: Type.Optional(
      Type.Object(
        {
          path: Type.String(),
          chars: Type.Integer({ minimum: 0 }),
          truncated: Type.Optional(Type.Literal(true)),
        },
        { additionalProperties: false },
      ),
    ),
    fetchedAt: Type.String(),
    tookMs: Type.Integer({ minimum: 0 }),
    text: Type.String(),
    warning: Type.Optional(Type.String()),
    cached: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

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

function resolveFetchReadabilityEnabled(fetch?: WebFetchConfig): boolean {
  if (typeof fetch?.readability === "boolean") {
    return fetch.readability;
  }
  return true;
}

function resolveFetchUseTrustedEnvProxy(fetch?: WebFetchConfig): boolean {
  return fetch?.useTrustedEnvProxy === true;
}

/**
 * Operator headers web_fetch may actually send. Every dropped entry gets its own
 * warning: a silently ignored routing header looks exactly like working egress.
 * Header names are safe to log; values are not.
 */
function resolveFetchHeaders(fetch?: WebFetchConfig): Record<string, string> | undefined {
  const configured = fetch?.headers;
  if (!configured) {
    return undefined;
  }
  const resolved = new Map<string, { name: string; value: string }>();
  for (const [rawName, rawValue] of Object.entries(configured)) {
    const name = rawName.trim();
    const lowerName = name.toLowerCase();
    const prior = resolved.get(lowerName);
    if (prior) {
      resolved.delete(lowerName);
      logWarn(
        `[web-fetch] dropped case-colliding tools.web.fetch.headers entry: ${JSON.stringify(prior.name)}`,
      );
    }
    let value: string;
    try {
      value = new Headers([[name, rawValue]]).get(name) ?? "";
    } catch {
      logWarn(
        `[web-fetch] dropped tools.web.fetch.headers entry a request cannot carry: ${JSON.stringify(rawName)}`,
      );
      continue;
    }
    if (FETCH_BLOCKED_HEADER_NAMES.has(lowerName)) {
      logWarn(`[web-fetch] dropped reserved or framing tools.web.fetch.headers entry: ${name}`);
      continue;
    }
    resolved.set(lowerName, { name, value });
  }
  const entries = [...resolved.values()]
    .map(({ name, value }) => [name, value] as const)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Secret-free cache discriminator for operator headers. The fetch cache is a
 * process-wide map and routing headers can point the same URL at a different
 * backend, so the header set must partition the cache without storing its values.
 */
function resolveFetchHeadersCacheKey(headers?: Record<string, string>): string | undefined {
  if (!headers) {
    return undefined;
  }
  return sha256Hex(JSON.stringify(Object.entries(headers)));
}

/**
 * Builds the outgoing header record. Fetch-owned headers keep their canonical
 * casing and order because a plain record reaches the wire verbatim: undici does
 * not re-normalize it, so switching to `Headers` here would change the request
 * fingerprint of every fetch, including ones with no configured headers.
 * `resolveFetchHeaders` has already removed anything that could collide.
 */
function buildWebFetchRequestHeaders(params: {
  userAgent: string;
  operatorHeaders?: Record<string, string>;
}): Record<string, string> {
  return {
    Accept: "text/markdown, text/html;q=0.9, */*;q=0.1",
    "User-Agent": params.userAgent,
    "Accept-Language": "en-US,en;q=0.9",
    ...params.operatorHeaders,
  };
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
  const truncated = truncateWebFetchText(text.trim(), maxChars);
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
    return { text: "", truncated: true, rawLength: value.length, length: 0 };
  }
  const includeWarning = maxChars >= WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD;
  const wrapperOverhead = includeWarning
    ? WEB_FETCH_WRAPPER_WITH_WARNING_OVERHEAD
    : WEB_FETCH_WRAPPER_NO_WARNING_OVERHEAD;
  if (wrapperOverhead > maxChars) {
    const minimal = includeWarning
      ? wrapWebContent("", "web_fetch")
      : wrapExternalContent("", { source: "web_fetch", includeWarning: false });
    const truncatedWrapper = truncateWebFetchText(minimal, maxChars);
    return {
      text: truncatedWrapper.text,
      truncated: true,
      rawLength: value.length,
      length: truncatedWrapper.text.length,
    };
  }
  const maxInner = Math.max(0, maxChars - wrapperOverhead);
  // Charge sanitizer expansion before wrapping; clipping a later marker can
  // increase output size, so a second raw-length adjustment is not sufficient.
  const truncated = truncateSanitizedExternalContent(value, maxInner);
  const wrappedText = includeWarning
    ? wrapWebContent(truncated.text, "web_fetch")
    : wrapExternalContent(truncated.text, { source: "web_fetch", includeWarning: false });

  return {
    text: wrappedText,
    truncated: truncated.truncated,
    rawLength: value.length,
    length: wrappedText.length,
  };
}

type WebFetchWrappedContent = {
  text: string;
  truncated: boolean;
  rawLength: number;
  length: number;
  spill?: {
    path: string;
    chars: number;
    truncated?: true;
  };
};

async function spillWebFetchContent(
  value: string,
  wrapped: WebFetchWrappedContent,
  maxChars: number,
  sourceTruncated = false,
): Promise<WebFetchWrappedContent> {
  if (!wrapped.truncated) {
    return sourceTruncated ? { ...wrapped, truncated: true } : wrapped;
  }
  // maxChars/maxCharsCap bound the model-visible return text. Recoverable spill
  // uses this fixed file cap so vanished pages can still be read after truncation.
  const content = truncateUtf16Safe(value, WEB_FETCH_SPILL_MAX_CHARS);
  const spillChars = content.length;
  const spillPath = await writePrivateTempFile(
    "openclaw-web-fetch",
    wrapWebContent(content, "web_fetch"),
  );
  const spillCapped = value.length > WEB_FETCH_SPILL_MAX_CHARS;
  const isSpillTruncated = sourceTruncated || spillCapped;
  const spillNote = sourceTruncated
    ? " Spilled available content from truncated response."
    : spillCapped
      ? ` Spilled first ${spillChars} chars.`
      : "";
  const fullOutputFooter = formatFullOutputFooter(spillPath);
  const footer = `\n\n[Showing truncated web_fetch content. ${fullOutputFooter}.${spillNote}]`;
  const compactFooter = `[${fullOutputFooter}]`;
  let visible = wrapped;
  let text = wrapped.text;
  if (footer.length <= maxChars) {
    visible = wrapWebFetchContent(value, maxChars - footer.length);
    text = `${visible.text}${footer}`;
  } else if (compactFooter.length <= maxChars) {
    visible = { ...wrapped, text: "", length: 0 };
    text = compactFooter;
  }
  return {
    ...visible,
    truncated: true,
    text,
    length: text.length,
    spill: {
      path: spillPath,
      chars: spillChars,
      ...(isSpillTruncated ? { truncated: true } : {}),
    },
  };
}

function normalizeContentType(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const [raw] = value.split(";");
  const trimmed = raw?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function isJsonMediaType(value: string): boolean {
  // Structured +json subtypes are single JSON documents; sequence formats are not.
  return value === "application/json" || value.endsWith("+json");
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
  headers?: Record<string, string>;
  readabilityEnabled: boolean;
  config?: OpenClawConfig;
  useTrustedEnvProxy: boolean;
  ssrfPolicy?: SsrFPolicy;
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
  // Async fetch, provider, and payload work can finish after an abort. Recheck
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
function sanitizeWebFetchUrl(raw: string): string {
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) <= 0x20) {
    end -= 1;
  }
  const trimmed = raw.slice(0, end).replace(/^\s+/, "");
  const repaired = trimmed.replace(/^(https?:\/\/)\s+/i, "$1");
  return repaired.replace(/^(https?:\/\/[^/?#\s]+)\s+$/i, "$1");
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.webFetchTestApi")] = {
    sanitizeWebFetchUrl,
  };
}

async function buildWebFetchPayload(params: {
  providerId?: string;
  payload: unknown;
  requestedUrl: string;
  extractMode: ExtractMode;
  maxChars: number;
  tookMs: number;
}): Promise<Record<string, unknown>> {
  const payload = isRecord(params.payload) ? params.payload : {};
  let metadataTruncated = false;
  const boundProtocolField = (value: string, limit: number): string => {
    const bounded = truncateWebFetchText(value, limit);
    metadataTruncated ||= bounded.truncated;
    return bounded.text;
  };
  let remainingMetadataChars = Math.min(
    WEB_FETCH_METADATA_MAX_CHARS,
    Math.floor(params.maxChars / 2),
  );
  const wrapMetadata = (value: unknown): string | undefined => {
    if (typeof value !== "string" || !value) {
      return undefined;
    }
    const maxInner = Math.max(0, remainingMetadataChars - WEB_FETCH_WRAPPER_NO_WARNING_OVERHEAD);
    const bounded = truncateSanitizedExternalContent(
      value,
      Math.min(WEB_FETCH_FIELD_MAX_CHARS, maxInner),
    );
    metadataTruncated ||= bounded.truncated;
    if (!bounded.text) {
      return undefined;
    }
    const wrapped = wrapExternalContent(bounded.text, {
      source: "web_fetch",
      includeWarning: false,
    });
    remainingMetadataChars -= wrapped.length;
    return wrapped;
  };
  // Preserve the incomplete-response warning before spending the allowance on a title.
  const warning = wrapMetadata(payload.warning);
  const title = wrapMetadata(payload.title);
  const bodyMaxChars = params.maxChars - (title?.length ?? 0) - (warning?.length ?? 0);
  const rawText = typeof payload.text === "string" ? payload.text : "";
  const wrapped = await spillWebFetchContent(
    rawText,
    wrapWebFetchContent(rawText, bodyMaxChars),
    bodyMaxChars,
    payload.truncated === true,
  );
  const providerRawLength =
    typeof payload.rawLength === "number" && Number.isFinite(payload.rawLength)
      ? Math.max(0, Math.floor(payload.rawLength))
      : wrapped.rawLength;
  const url = params.requestedUrl;
  const resolvedFinalUrl = normalizeProviderFinalUrl(payload.finalUrl) ?? url;
  const oversizedFinalUrl =
    resolvedFinalUrl !== url && resolvedFinalUrl.length > WEB_FETCH_RESULT_URL_MAX_CHARS;
  // As with invalid provider URLs, retain the requested URL rather than invent
  // a different destination by clipping a redirect's path or query.
  const finalUrl = oversizedFinalUrl ? url : resolvedFinalUrl;
  metadataTruncated ||= oversizedFinalUrl;
  const status =
    typeof payload.status === "number" && Number.isFinite(payload.status)
      ? Math.max(0, Math.floor(payload.status))
      : 200;
  const contentType =
    typeof payload.contentType === "string" ? normalizeContentType(payload.contentType) : undefined;
  const extractor =
    typeof payload.extractor === "string" && payload.extractor.trim()
      ? payload.extractor
      : (params.providerId ?? "raw");
  // These protocol fields are not prose and stay unwrapped, but provider or
  // response-controlled strings must not bypass the display-content budget.
  const boundedContentType = contentType ? boundProtocolField(contentType, 256) : undefined;
  const boundedExtractor = boundProtocolField(extractor, 128);
  const fetchedAt = boundProtocolField(
    typeof payload.fetchedAt === "string" && payload.fetchedAt
      ? payload.fetchedAt
      : new Date().toISOString(),
    64,
  );

  return {
    url,
    finalUrl,
    ...(boundedContentType ? { contentType: boundedContentType } : {}),
    status,
    ...(title ? { title } : {}),
    extractMode: params.extractMode,
    extractor: boundedExtractor,
    externalContent: {
      untrusted: true,
      source: "web_fetch",
      wrapped: true,
      ...(params.providerId ? { provider: params.providerId } : {}),
    },
    truncated: wrapped.truncated || metadataTruncated,
    length: wrapped.length,
    rawLength: providerRawLength,
    ...(wrapped.spill ? { spill: wrapped.spill } : {}),
    fetchedAt,
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
    tookMs: number;
  },
): Promise<Record<string, unknown> | null> {
  const providerFallback = await params.resolveProviderFallback();
  throwIfFetchAborted(params.signal);
  if (!providerFallback) {
    return null;
  }
  let rawPayload: unknown;
  try {
    rawPayload = await providerFallback.definition.execute(
      { url: params.urlToFetch, extractMode: params.extractMode, maxChars: params.maxChars },
      { signal: params.signal },
    );
  } catch (error) {
    // A provider failure landing after cancellation must surface the caller's abort
    // reason, not a late error from fallback work the caller already abandoned.
    throwIfFetchAborted(params.signal);
    throw error;
  }
  throwIfFetchAborted(params.signal);
  return await buildWebFetchPayload({
    providerId: providerFallback.provider.id,
    payload: rawPayload,
    requestedUrl: params.url,
    extractMode: params.extractMode,
    maxChars: params.maxChars,
    tookMs: params.tookMs,
  });
}

async function runWebFetch(params: WebFetchRuntimeParams): Promise<Record<string, unknown>> {
  throwIfFetchAborted(params.signal);
  const ssrfPolicy = params.ssrfPolicy;
  const useTrustedEnvProxy = params.useTrustedEnvProxy;
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(params.url);
  } catch {
    throw new Error("Invalid URL: must be http or https");
  }
  if (!["http:", "https:"].includes(parsedUrl.protocol)) {
    throw new Error("Invalid URL: must be http or https");
  }
  const headersCacheKey = resolveFetchHeadersCacheKey(params.headers);
  // Append the operator header set after the existing cache discriminators so
  // requests without custom headers keep their current cache key.
  const cacheDiscriminators = [
    `user-agent:${sha256Hex(params.userAgent)}`,
    params.providerCacheKey ? `provider:${params.providerCacheKey}` : "",
    ssrfPolicy ? `ssrf-policy:${sha256Hex(JSON.stringify(ssrfPolicy))}` : "",
    useTrustedEnvProxy ? "trusted-env-proxy" : "",
    headersCacheKey ? `headers:${headersCacheKey}` : "",
  ].filter(Boolean);
  const cacheKey = normalizeCacheKey(
    [
      `fetch:${parsedUrl.href}:${params.extractMode}:${params.maxChars}`,
      ...cacheDiscriminators,
    ].join(":"),
  );
  const cached = readCache(FETCH_CACHE, cacheKey, params.cacheTtlMs);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  // Preserve the direct fetch's rejection; replacing it with signal.reason would
  // discard the transport's own error detail.
  const payload = await fetchWebPayload(params);
  // Publish only after guard release: cancellation or cleanup failure must not
  // leave a successful cache entry for a call that never returned its content.
  throwIfFetchAborted(params.signal);
  writeCache(FETCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

async function fetchWebPayload(params: WebFetchRuntimeParams): Promise<Record<string, unknown>> {
  const start = Date.now();
  let res: Response;
  let release: () => Promise<void>;
  let finalUrl = params.url;
  try {
    const fetchWithWebToolsNetworkGuard = await loadWebGuardedFetch();
    const result = await fetchWithWebToolsNetworkGuard({
      url: params.url,
      maxRedirects: params.maxRedirects,
      timeoutSeconds: params.timeoutSeconds,
      signal: params.signal,
      lookupFn: params.lookupFn,
      useEnvProxy: params.useTrustedEnvProxy,
      policy: params.ssrfPolicy,
      capture: params.headers
        ? { sensitiveRequestHeaderNames: Object.keys(params.headers) }
        : undefined,
      init: {
        headers: buildWebFetchRequestHeaders({
          userAgent: params.userAgent,
          operatorHeaders: params.headers,
        }),
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
    if (error instanceof SsrFBlockedError || params.signal?.aborted) {
      throw error;
    }
    const payload = await maybeFetchProviderWebFetchPayload({
      ...params,
      urlToFetch: finalUrl,
      tookMs: Date.now() - start,
    });
    if (payload) {
      return payload;
    }
    throw error;
  }

  try {
    if (!res.ok) {
      throwIfFetchAborted(params.signal);
      const payload = await maybeFetchProviderWebFetchPayload({
        ...params,
        urlToFetch: params.url,
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
    if (normalizedContentType === "text/markdown") {
      // Cloudflare Markdown for Agents: server returned pre-rendered markdown
      extractor = "cf-markdown";
      if (params.extractMode === "text") {
        text = markdownToText(body);
      }
    } else if (["text/html", "application/xhtml+xml"].includes(normalizedContentType)) {
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
              tookMs: Date.now() - start,
            });
          } catch {
            throwIfFetchAborted(params.signal);
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
          tookMs: Date.now() - start,
        });
        if (payload) {
          return payload;
        }
        throw new Error(
          "Web fetch extraction failed: Readability disabled and no fetch provider is available.",
        );
      }
    } else if (isJsonMediaType(normalizedContentType)) {
      try {
        text = JSON.stringify(JSON.parse(body), null, 2);
        extractor = "json";
      } catch {
        text = body;
        extractor = "raw";
      }
    }

    return await buildWebFetchPayload({
      payload: {
        finalUrl,
        status: res.status,
        contentType: normalizedContentType,
        title,
        extractor,
        text,
        warning: responseTruncatedWarning,
        truncated: bodyResult.truncated,
      },
      requestedUrl: params.url,
      extractMode: params.extractMode,
      maxChars: params.maxChars,
      tookMs: Date.now() - start,
    });
  } finally {
    if (!res.bodyUsed) {
      // Fallbacks and provider failures can abandon the upstream stream. Cancel
      // without awaiting so a stalled cancellation cannot block guard release.
      void res.body?.cancel().catch(() => undefined);
    }
    await release();
  }
}

export function createWebFetchTool(options?: {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
  lateBindRuntimeConfig?: boolean;
  lookupFn?: LookupFn;
  hostnameAllowlistRef?: { value?: string[] };
}): AnyAgentTool | null {
  const fetch = resolveFetchConfig(options?.config);
  if (fetch?.enabled === false) {
    return null;
  }
  const tool: AnyAgentTool = {
    label: "Web Fetch",
    name: "web_fetch",
    resultContentSource: "network",
    description: "Fetch URL; extract readable markdown/text. Lightweight; no browser automation.",
    parameters: WebFetchSchema,
    outputSchema: WebFetchOutputSchema,
    execute: async (_toolCallId, args, signal, onUpdate) => {
      const { config, preferRuntimeProviders, providerSelectionId, runtimeWebFetch } =
        resolveWebFetchToolRuntimeContext({
          config: options?.config,
          lateBindRuntimeConfig: options?.lateBindRuntimeConfig,
          runtimeWebFetch: options?.runtimeWebFetch,
        });
      const executionFetch = resolveFetchConfig(config);
      if (executionFetch?.enabled === false) {
        throw new Error("web_fetch is disabled.");
      }
      if (providerSelectionId) {
        assertSecretOwnerAvailable(
          "capability",
          runtimeWebSecretOwnerId("fetch", providerSelectionId),
        );
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
        readToolStringParam(params, "url", { required: true, trim: false }),
      );
      const extractMode =
        readToolStringParam(params, "extractMode") === "text" ? "text" : "markdown";
      const maxChars = readPositiveIntegerParam(params, "maxChars");
      const maxCharsCap = resolveFetchMaxCharsCap(executionFetch);
      const hostnameAllowlist = options?.hostnameAllowlistRef?.value;
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
          headers: resolveFetchHeaders(executionFetch),
          readabilityEnabled,
          config,
          useTrustedEnvProxy: resolveFetchUseTrustedEnvProxy(executionFetch),
          ssrfPolicy: hostnameAllowlist
            ? { ...executionFetch?.ssrfPolicy, hostnameAllowlist }
            : executionFetch?.ssrfPolicy,
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
