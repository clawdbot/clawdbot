import { normalizeOptionalString as readLiveModelCatalogString } from "../../packages/normalization-core/src/string-coerce.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { readProviderJsonResponse } from "../agents/provider-http-errors.js";
import { cancelUnreadResponseBody } from "../infra/http-body.js";
import { retainSafeHeadersForCrossOriginRedirect } from "../infra/net/redirect-headers.js";
import {
  isUpstreamProviderCatalogModel,
  readLiveModelCatalogId,
  readLiveModelCatalogRecord,
  readLiveModelCatalogStringField,
  type UpstreamProviderCatalog,
  type UpstreamProviderCatalogModel,
} from "./provider-catalog-live-normalize.internal.js";
import { LiveModelCatalogHttpError } from "./provider-catalog-live-outcome.internal.js";
import { getCachedLiveCatalogValue } from "./provider-catalog-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./provider-model-shared.js";
import {
  fetchWithSsrFGuard,
  type LookupFn,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  type SsrFPolicy,
} from "./ssrf-runtime.js";

export type LiveModelCatalogFetchGuard = typeof fetchWithSsrFGuard;

export type LiveModelCatalogHeaderContext = {
  apiKey?: string;
  discoveryApiKey?: string;
};

export type FetchLiveProviderModelIdsParams = {
  providerId: string;
  endpoint: string;
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
  timeoutMs?: number;
  auditContext?: string;
  policy?: SsrFPolicy;
  lookupFn?: LookupFn;
  requireHttps?: boolean;
  readRows?: (body: unknown) => readonly unknown[];
  readModelId?: (row: unknown) => string | undefined;
  buildRequestHeaders?: (ctx: LiveModelCatalogHeaderContext) => HeadersInit;
};

export type FetchLiveProviderModelRowsParams = Omit<FetchLiveProviderModelIdsParams, "readModelId">;

export type CachedLiveProviderModelRowsParams = FetchLiveProviderModelRowsParams & {
  ttlMs?: number;
  cacheKeyParts?: readonly unknown[];
  shouldCacheRows?: (rows: readonly unknown[]) => boolean;
};

export type GetCachedUpstreamProviderCatalogParams = {
  endpoint: string;
  providerId: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
  timeoutMs?: number;
  ttlMs?: number;
};

export type LiveModelRowProjection<T extends ModelDefinitionConfig = ModelDefinitionConfig> = (
  rows: readonly unknown[],
  fallback: ModelProviderConfig,
) => readonly T[];

// Live model catalogs are fetched at runtime from provider-controlled endpoints,
// so the success body is untrusted just like the error body. A faulty or hostile
// provider can stream an unbounded JSON document; reading it without a ceiling
// lets a single discovery call exhaust process memory. The cap is sized well
// above the largest known catalog (OpenRouter's live catalog is already >100KB
// and grows) while still bounding memory, matching the existing bounded reads
// for provider error bodies.
const LIVE_MODEL_CATALOG_BODY_MAX_BYTES = 4 * 1024 * 1024;
// Shared upstream feeds cover many providers and already exceed the ordinary
// single-provider ceiling; bound this explicitly without weakening that limit.
const UPSTREAM_PROVIDER_CATALOG_BODY_MAX_BYTES = 8 * 1024 * 1024;
const LIVE_MODEL_CATALOG_MAX_PAGES = 50;

function readDefaultLiveModelCatalogRows(body: unknown): readonly unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  // SAFETY: The JSON object guard permits reading an optional unknown data field.
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    // SAFETY: The array check above narrows the decoded JSON data field.
    return (body as { data: unknown[] }).data;
  }
  throw new Error("Live model catalog response must be an array or { data: [] }");
}

function normalizeLiveModelCatalogRequestApiKey(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || isNonSecretApiKeyMarker(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function selectLiveModelCatalogRequestApiKey(
  ctx: LiveModelCatalogHeaderContext,
): string | undefined {
  return (
    // Explicit discovery credentials are resolved bytes; only apiKey can be a placeholder.
    readLiveModelCatalogString(ctx.discoveryApiKey) ??
    normalizeLiveModelCatalogRequestApiKey(ctx.apiKey)
  );
}

function buildDefaultLiveModelCatalogHeaders(ctx: LiveModelCatalogHeaderContext): HeadersInit {
  const requestApiKey = selectLiveModelCatalogRequestApiKey(ctx);
  return {
    Accept: "application/json",
    ...(requestApiKey ? { Authorization: `Bearer ${requestApiKey}` } : {}),
  };
}

function buildHeaders(
  params: FetchLiveProviderModelIdsParams,
  safeReplayHeaders?: Headers,
): Headers {
  const headers = safeReplayHeaders
    ? new Headers(safeReplayHeaders)
    : new Headers(
        (params.buildRequestHeaders ?? buildDefaultLiveModelCatalogHeaders)({
          apiKey: normalizeLiveModelCatalogRequestApiKey(params.apiKey),
          discoveryApiKey: selectLiveModelCatalogRequestApiKey(params),
        }),
      );
  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }
  return headers;
}

async function readLiveModelCatalogJson(
  response: Response,
  params: { label: string; timeoutMs: number; maxBytes?: number; requestHeaders?: HeadersInit },
): Promise<unknown> {
  return await readProviderJsonResponse(response, params.label, {
    chunkTimeoutMs: params.timeoutMs,
    maxBytes: params.maxBytes ?? LIVE_MODEL_CATALOG_BODY_MAX_BYTES,
    requestHeaders: params.requestHeaders,
    onOverflow: ({ size, maxBytes }) =>
      new Error(`Live model catalog response exceeded ${maxBytes} bytes (${size} bytes received)`),
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`Live model catalog response stalled: no data received for ${chunkTimeoutMs}ms`),
  });
}

/** Loads one provider from a shared public metadata feed only when explicitly requested. */
export async function getCachedUpstreamProviderCatalog(
  params: GetCachedUpstreamProviderCatalogParams,
): Promise<UpstreamProviderCatalog | undefined> {
  const body = await getCachedLiveCatalogValue({
    // Provider ids intentionally stay out of this key: sibling providers share
    // one upstream document and must not download it once per provider.
    keyParts: ["upstream-provider-catalog", params.endpoint],
    ttlMs: params.ttlMs ?? 300_000,
    load: async () => {
      const timeoutMs = params.timeoutMs ?? 15_000;
      const { response, release } = await (params.fetchGuard ?? fetchWithSsrFGuard)({
        url: params.endpoint,
        init: { headers: { Accept: "application/json" } },
        signal: params.signal,
        timeoutMs,
        policy: ssrfPolicyFromHttpBaseUrlAllowedHostname(params.endpoint),
        requireHttps: true,
        auditContext: "upstream-provider-catalog-discovery",
      });
      try {
        if (!response.ok) {
          await cancelUnreadResponseBody(response);
          throw new LiveModelCatalogHttpError("upstream-provider-catalog", response.status);
        }
        const catalog = readLiveModelCatalogRecord(
          await readLiveModelCatalogJson(response, {
            label: "upstream-provider-catalog",
            timeoutMs,
            maxBytes: UPSTREAM_PROVIDER_CATALOG_BODY_MAX_BYTES,
          }),
        );
        if (!catalog) {
          throw new Error("Upstream provider catalog response must be an object");
        }
        return catalog;
      } finally {
        await release();
      }
    },
  });

  const provider = readLiveModelCatalogRecord(body[params.providerId]);
  const models = readLiveModelCatalogRecord(provider?.models);
  if (
    !provider ||
    !models ||
    readLiveModelCatalogStringField(provider, "id") !== params.providerId
  ) {
    return undefined;
  }
  return {
    id: params.providerId,
    ...(readLiveModelCatalogStringField(provider, "api")
      ? { api: readLiveModelCatalogStringField(provider, "api") }
      : {}),
    ...(readLiveModelCatalogStringField(provider, "npm")
      ? { npm: readLiveModelCatalogStringField(provider, "npm") }
      : {}),
    models: Object.fromEntries(
      Object.entries(models).filter((entry): entry is [string, UpstreamProviderCatalogModel] =>
        isUpstreamProviderCatalogModel(entry[1]),
      ),
    ),
  };
}

function readLiveModelCatalogNextUrl(body: unknown): string | undefined {
  const record = readLiveModelCatalogRecord(body);
  if (!record) {
    return undefined;
  }
  const links = readLiveModelCatalogRecord(record.links);
  return readLiveModelCatalogString(record.next) ?? readLiveModelCatalogString(links?.next);
}

function readLiveModelCatalogCursor(
  body: unknown,
): { name: "after" | "after_id" | "pageToken" | "page_token"; value: string } | undefined {
  const record = readLiveModelCatalogRecord(body);
  if (!record || record.has_more === false) {
    return undefined;
  }
  const nextCursor = readLiveModelCatalogString(record.next_cursor);
  if (nextCursor) {
    return { name: "after", value: nextCursor };
  }
  const lastId =
    readLiveModelCatalogString(record.last_id) ?? readLiveModelCatalogString(record.lastId);
  if (lastId) {
    return { name: "after_id", value: lastId };
  }
  const nextPageToken = readLiveModelCatalogString(record.nextPageToken);
  if (nextPageToken) {
    return { name: "pageToken", value: nextPageToken };
  }
  const nextPageTokenSnakeCase = readLiveModelCatalogString(record.next_page_token);
  return nextPageTokenSnakeCase ? { name: "page_token", value: nextPageTokenSnakeCase } : undefined;
}

type LiveModelCatalogNextPageResolution =
  | { status: "complete" }
  | { status: "incomplete" }
  | { status: "next"; url: string };

function bodyAdvertisesMoreLiveModelCatalogPages(body: unknown): boolean {
  const record = readLiveModelCatalogRecord(body);
  if (!record || record.has_more === false) {
    return false;
  }
  return Boolean(
    record.has_more === true ||
    readLiveModelCatalogNextUrl(body) ||
    readLiveModelCatalogString(record.next_cursor) ||
    readLiveModelCatalogString(record.nextPageToken) ||
    readLiveModelCatalogString(record.next_page_token),
  );
}

function tryParseUrl(url: string, base?: string): URL | undefined {
  try {
    return new URL(url, base);
  } catch {
    return undefined;
  }
}

function resolveLiveModelCatalogNextPage(
  currentUrl: string,
  body: unknown,
): LiveModelCatalogNextPageResolution {
  const rawNextUrl = readLiveModelCatalogNextUrl(body);
  if (rawNextUrl) {
    const currentParsed = tryParseUrl(currentUrl);
    const nextUrl = tryParseUrl(rawNextUrl, currentUrl);
    if (nextUrl && currentParsed && nextUrl.origin === currentParsed.origin) {
      return { status: "next", url: nextUrl.toString() };
    }
    // The provider advertised a next URL but it is malformed or cross-origin.
    // Attempt cursor-based pagination as a fallback before giving up.
    const cursor = readLiveModelCatalogCursor(body);
    if (cursor) {
      const cursorUrl = tryParseUrl(currentUrl);
      if (cursorUrl) {
        cursorUrl.searchParams.set(cursor.name, cursor.value);
        return { status: "next", url: cursorUrl.toString() };
      }
    }
    // No usable fallback: the provider explicitly advertised a next page we
    // cannot follow. Return incomplete so the caller surfaces a controlled
    // error instead of silently returning a truncated catalog.
    return { status: "incomplete" };
  }
  const cursor = readLiveModelCatalogCursor(body);
  if (cursor) {
    const nextUrl = tryParseUrl(currentUrl);
    if (nextUrl) {
      nextUrl.searchParams.set(cursor.name, cursor.value);
      return { status: "next", url: nextUrl.toString() };
    }
  }
  return bodyAdvertisesMoreLiveModelCatalogPages(body)
    ? { status: "incomplete" }
    : { status: "complete" };
}

async function fetchLiveProviderModelCatalogPage(
  params: FetchLiveProviderModelRowsParams & {
    fetchGuard: LiveModelCatalogFetchGuard;
    url: string;
    timeoutMs: number;
    safeReplayHeaders?: Headers;
  },
): Promise<{ body: unknown; finalUrl: string; requestHeaders: Headers; rows: readonly unknown[] }> {
  const requestHeaders = buildHeaders(params, params.safeReplayHeaders);
  const { response, finalUrl, release } = await params.fetchGuard({
    url: params.url,
    init: {
      headers: requestHeaders,
    },
    signal: params.signal,
    timeoutMs: params.timeoutMs,
    policy: params.policy ?? ssrfPolicyFromHttpBaseUrlAllowedHostname(params.endpoint),
    ...(params.lookupFn ? { lookupFn: params.lookupFn } : {}),
    ...(params.requireHttps !== undefined ? { requireHttps: params.requireHttps } : {}),
    auditContext: params.auditContext ?? `${params.providerId}-model-discovery`,
  });
  try {
    if (!response.ok) {
      await cancelUnreadResponseBody(response);
      throw new LiveModelCatalogHttpError(params.providerId, response.status);
    }
    const body = await readLiveModelCatalogJson(response, {
      label: `${params.providerId} model discovery`,
      timeoutMs: params.timeoutMs,
      requestHeaders,
    });
    return {
      body,
      finalUrl,
      requestHeaders,
      rows: (params.readRows ?? readDefaultLiveModelCatalogRows)(body),
    };
  } finally {
    await release();
  }
}

export async function fetchLiveProviderModelRows(
  params: FetchLiveProviderModelRowsParams,
): Promise<readonly unknown[]> {
  const fetchGuard = params.fetchGuard ?? fetchWithSsrFGuard;
  const timeoutMs = params.timeoutMs ?? 5_000;
  const startedAt = Date.now();
  const rows: unknown[] = [];
  const seenPageUrls = new Set<string>();
  let pageUrl: string | undefined = params.endpoint;
  let safeReplayHeaders: Headers | undefined;
  for (let page = 0; page < LIVE_MODEL_CATALOG_MAX_PAGES && pageUrl; page += 1) {
    if (seenPageUrls.has(pageUrl)) {
      break;
    }
    const remainingTimeoutMs = timeoutMs - (Date.now() - startedAt);
    if (remainingTimeoutMs <= 0) {
      throw new Error(
        `${params.providerId} model discovery exceeded ${timeoutMs}ms before the catalog completed`,
      );
    }
    seenPageUrls.add(pageUrl);
    const requestedPageUrl = pageUrl;
    const result = await fetchLiveProviderModelCatalogPage({
      ...params,
      fetchGuard,
      url: requestedPageUrl,
      timeoutMs: remainingTimeoutMs,
      safeReplayHeaders,
    });
    rows.push(...result.rows);
    const finalParsed = tryParseUrl(result.finalUrl);
    const requestedParsed = tryParseUrl(requestedPageUrl);
    if (
      safeReplayHeaders ||
      !finalParsed ||
      !requestedParsed ||
      finalParsed.origin !== requestedParsed.origin
    ) {
      safeReplayHeaders = new Headers(
        retainSafeHeadersForCrossOriginRedirect(result.requestHeaders),
      );
    }
    const nextPage = resolveLiveModelCatalogNextPage(result.finalUrl, result.body);
    if (nextPage.status === "incomplete") {
      throw new Error(
        `${params.providerId} model discovery did not include a supported next page before the catalog completed`,
      );
    }
    pageUrl = nextPage.status === "next" ? nextPage.url : undefined;
  }
  if (pageUrl) {
    throw new Error(
      `${params.providerId} model discovery exceeded ${LIVE_MODEL_CATALOG_MAX_PAGES} pages before the catalog completed`,
    );
  }
  return rows;
}

export function liveModelCatalogAuthCacheKey(
  params: LiveModelCatalogHeaderContext,
): string | undefined {
  return selectLiveModelCatalogRequestApiKey(params);
}

export async function getCachedLiveProviderModelRows(
  params: CachedLiveProviderModelRowsParams,
): Promise<readonly unknown[]> {
  return await getCachedLiveCatalogValue({
    keyParts: params.cacheKeyParts ?? [
      params.providerId,
      "model-rows",
      params.endpoint,
      liveModelCatalogAuthCacheKey(params),
    ],
    ttlMs: params.ttlMs,
    load: async () => await fetchLiveProviderModelRows(params),
    shouldCache: params.shouldCacheRows,
  });
}

export async function fetchLiveProviderModelIds(
  params: FetchLiveProviderModelIdsParams,
): Promise<string[]> {
  const rows = await fetchLiveProviderModelRows(params);
  const readModelId = params.readModelId ?? readLiveModelCatalogId;
  const seen = new Set<string>();
  const modelIds: string[] = [];
  for (const row of rows) {
    const modelId = readModelId(row);
    if (!modelId || seen.has(modelId)) {
      continue;
    }
    seen.add(modelId);
    modelIds.push(modelId);
  }
  return modelIds;
}
