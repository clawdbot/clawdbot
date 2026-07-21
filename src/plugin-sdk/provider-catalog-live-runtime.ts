import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import { readResponseWithLimit } from "../infra/http-body.js";
import { retainSafeHeadersForCrossOriginRedirect } from "../infra/net/redirect-headers.js";
import {
  clearLiveCatalogCacheForTests,
  getCachedLiveCatalogValue,
} from "./provider-catalog-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./provider-model-shared.js";
import {
  fetchWithSsrFGuard,
  type LookupFn,
  ssrfPolicyFromHttpBaseUrlAllowedHostname,
  type SsrFPolicy,
} from "./ssrf-runtime.js";

type LiveModelCatalogFetchGuardResult = Awaited<ReturnType<typeof fetchWithSsrFGuard>>;
type LiveModelCatalogCompatibleFetchGuardResult = Omit<
  LiveModelCatalogFetchGuardResult,
  "finalUrl" | "requestHeaders"
> & {
  finalUrl?: string;
  requestHeaders?: HeadersInit;
};

export type LiveModelCatalogFetchGuard = typeof fetchWithSsrFGuard;
type LiveModelCatalogCompatibleFetchGuard = (
  params: Parameters<typeof fetchWithSsrFGuard>[0],
) => Promise<LiveModelCatalogCompatibleFetchGuardResult>;

export type LiveModelCatalogHeaderContext = {
  apiKey?: string;
  discoveryApiKey?: string;
};

export { clearLiveCatalogCacheForTests };

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

// Live model catalogs are fetched at runtime from provider-controlled endpoints,
// so the success body is untrusted just like the error body. A faulty or hostile
// provider can stream an unbounded JSON document; reading it without a ceiling
// lets a single discovery call exhaust process memory. The cap is sized well
// above the largest known catalog (OpenRouter's live catalog is already >100KB
// and grows) while still bounding memory, matching the existing bounded reads
// for provider error bodies.
const LIVE_MODEL_CATALOG_BODY_MAX_BYTES = 4 * 1024 * 1024;
const LIVE_MODEL_CATALOG_MAX_PAGES = 50;

export class LiveModelCatalogHttpError extends Error {
  readonly status: number;

  constructor(providerId: string, status: number) {
    super(`${providerId} model discovery failed: HTTP ${status}`);
    this.name = "LiveModelCatalogHttpError";
    this.status = status;
  }
}

export type BuildLiveModelProviderConfigParams<T extends ModelDefinitionConfig> =
  FetchLiveProviderModelIdsParams & {
    providerConfig: Omit<ModelProviderConfig, "models">;
    models: readonly T[];
    ttlMs?: number;
    cacheKeyParts?: readonly unknown[];
  };

function readDefaultLiveModelCatalogRows(body: unknown): readonly unknown[] {
  if (Array.isArray(body)) {
    return body;
  }
  if (body && typeof body === "object" && Array.isArray((body as { data?: unknown }).data)) {
    return (body as { data: unknown[] }).data;
  }
  throw new Error("Live model catalog response must be an array or { data: [] }");
}

function readDefaultLiveModelId(row: unknown): string | undefined {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return undefined;
  }
  const candidate = row as { id?: unknown; object?: unknown };
  if (candidate.object !== undefined && candidate.object !== "model") {
    return undefined;
  }
  if (typeof candidate.id !== "string") {
    return undefined;
  }
  const modelId = candidate.id.trim();
  return modelId || undefined;
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
    normalizeLiveModelCatalogRequestApiKey(ctx.discoveryApiKey) ??
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
  params: Omit<FetchLiveProviderModelIdsParams, "fetchGuard">,
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

async function cancelUnreadResponseBody(response: Response): Promise<void> {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => undefined);
  }
}

async function readLiveModelCatalogJson(response: Response, timeoutMs: number): Promise<unknown> {
  const buffer = await readResponseWithLimit(response, LIVE_MODEL_CATALOG_BODY_MAX_BYTES, {
    chunkTimeoutMs: timeoutMs,
    onOverflow: ({ size, maxBytes }) =>
      new Error(`Live model catalog response exceeded ${maxBytes} bytes (${size} bytes received)`),
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`Live model catalog response stalled: no data received for ${chunkTimeoutMs}ms`),
  });
  return JSON.parse(new TextDecoder().decode(buffer));
}

function readLiveModelCatalogString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readLiveModelCatalogRecord(body: unknown): Record<string, unknown> | undefined {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : undefined;
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
): { name: "after" | "pageToken"; value: string } | undefined {
  const record = readLiveModelCatalogRecord(body);
  if (!record || record.has_more === false) {
    return undefined;
  }
  const nextCursor = readLiveModelCatalogString(record.next_cursor);
  if (nextCursor) {
    return { name: "after", value: nextCursor };
  }
  const nextPageToken = readLiveModelCatalogString(record.nextPageToken);
  return nextPageToken ? { name: "pageToken", value: nextPageToken } : undefined;
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
    readLiveModelCatalogString(record.nextPageToken),
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
  params: Omit<FetchLiveProviderModelRowsParams, "fetchGuard"> & {
    fetchGuard: LiveModelCatalogCompatibleFetchGuard;
    url: string;
    timeoutMs: number;
    safeReplayHeaders?: Headers;
  },
): Promise<{ body: unknown; finalUrl: string; requestHeaders: Headers; rows: readonly unknown[] }> {
  const requestHeaders = buildHeaders(params, params.safeReplayHeaders);
  const {
    response,
    release,
    finalUrl: guardFinalUrl,
    requestHeaders: guardRequestHeaders,
  } = await params.fetchGuard({
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
  const finalUrl = guardFinalUrl ?? (response.url || params.url);
  const resolvedRequestHeaders = new Headers(guardRequestHeaders ?? requestHeaders);
  try {
    if (!response.ok) {
      await cancelUnreadResponseBody(response);
      throw new LiveModelCatalogHttpError(params.providerId, response.status);
    }
    const body = await readLiveModelCatalogJson(response, params.timeoutMs);
    return {
      body,
      finalUrl,
      requestHeaders: resolvedRequestHeaders,
      rows: (params.readRows ?? readDefaultLiveModelCatalogRows)(body),
    };
  } finally {
    await release();
  }
}

export async function fetchLiveProviderModelRows(
  params: FetchLiveProviderModelRowsParams,
): Promise<readonly unknown[]> {
  const fetchGuard: LiveModelCatalogCompatibleFetchGuard = params.fetchGuard ?? fetchWithSsrFGuard;
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

function liveModelCatalogAuthCacheKey(params: LiveModelCatalogHeaderContext): string | undefined {
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
  const readModelId = params.readModelId ?? readDefaultLiveModelId;
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

function buildProviderConfig<T extends ModelDefinitionConfig>(
  params: BuildLiveModelProviderConfigParams<T>,
  models: readonly T[],
): ModelProviderConfig {
  return {
    ...params.providerConfig,
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
    models: [...models],
  };
}

export async function buildLiveModelProviderConfig<T extends ModelDefinitionConfig>(
  params: BuildLiveModelProviderConfigParams<T>,
): Promise<ModelProviderConfig> {
  try {
    const liveModelIds = await getCachedLiveCatalogValue({
      keyParts: params.cacheKeyParts ?? [
        params.providerId,
        "models",
        params.endpoint,
        liveModelCatalogAuthCacheKey(params),
      ],
      ttlMs: params.ttlMs,
      load: async () => await fetchLiveProviderModelIds(params),
      shouldCache: (modelIds) => modelIds.length > 0,
    });
    const liveModelIdSet = new Set(liveModelIds);
    const models = params.models.filter((model) => liveModelIdSet.has(model.id));
    if (models.length > 0) {
      return buildProviderConfig(params, models);
    }
  } catch {
    // Live model catalogs are advisory. Keep provider-owned static rows visible
    // when discovery is unavailable or the provider returns an unexpected body.
  }
  return buildProviderConfig(params, params.models);
}
