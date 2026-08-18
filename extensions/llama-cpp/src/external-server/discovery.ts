import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  fetchWithSsrFGuard,
  ssrfPolicyFromHttpBaseUrlAllowedOrigin,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { buildLlamaServerAuthHeaders } from "./auth.js";
import {
  LLAMA_SERVER_DISCOVERY_CACHE_TTL_MS,
  LLAMA_SERVER_DISCOVERY_TIMEOUT_MS,
} from "./defaults.js";
import { resolveLlamaServerEndpoint } from "./endpoint.js";
import {
  mapLlamaServerModel,
  type LlamaServerDiscoveredModel,
  type LlamaServerModelWire,
  type LlamaServerPropsWire,
} from "./models.js";

type LlamaServerHealth = "ready" | "loading" | "unknown";

export type LlamaServerDiscoveryResult =
  | {
      kind: "success";
      endpoint: ReturnType<typeof resolveLlamaServerEndpoint>;
      health: LlamaServerHealth;
      models: LlamaServerDiscoveredModel[];
      fetchedAt: number;
    }
  | {
      kind: "unreachable";
      endpoint: ReturnType<typeof resolveLlamaServerEndpoint>;
      error: unknown;
    }
  | {
      kind: "http-error";
      endpoint: ReturnType<typeof resolveLlamaServerEndpoint>;
      status: number;
      path: string;
    }
  | {
      kind: "invalid-response";
      endpoint: ReturnType<typeof resolveLlamaServerEndpoint>;
      path: string;
      error: unknown;
    };

type LlamaServerFetchGuard = typeof fetchWithSsrFGuard;

type FetchJsonResult =
  | { kind: "response"; status: number; ok: boolean; body?: unknown }
  | { kind: "unreachable"; error: unknown }
  | { kind: "invalid-response"; error: unknown };

type CachedDiscovery = {
  expiresAt: number;
  result: Extract<LlamaServerDiscoveryResult, { kind: "success" }>;
};

const discoveryCache = new Map<string, CachedDiscovery>();
const LLAMA_SERVER_DISCOVERY_CACHE_MAX_ENTRIES = 100;
const LLAMA_SERVER_ROUTER_PROPS_MAX_MODELS = 200;
const LLAMA_SERVER_ROUTER_PROPS_CONCURRENCY = 8;

function cacheDiscovery(key: string, entry: CachedDiscovery, now: number): void {
  for (const [cachedKey, cached] of discoveryCache) {
    if (cached.expiresAt <= now) {
      discoveryCache.delete(cachedKey);
    }
  }
  discoveryCache.delete(key);
  discoveryCache.set(key, entry);
  while (discoveryCache.size > LLAMA_SERVER_DISCOVERY_CACHE_MAX_ENTRIES) {
    const oldest = discoveryCache.keys().next();
    if (oldest.done) {
      break;
    }
    discoveryCache.delete(oldest.value);
  }
}

async function fetchJson(params: {
  url: string;
  origin: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  readBody: boolean;
  fetchGuard: LlamaServerFetchGuard;
}): Promise<FetchJsonResult> {
  let guarded: Awaited<ReturnType<LlamaServerFetchGuard>>;
  try {
    guarded = await params.fetchGuard({
      url: params.url,
      init: { headers: buildLlamaServerAuthHeaders(params.apiKey, params.headers) },
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      policy: ssrfPolicyFromHttpBaseUrlAllowedOrigin(params.origin),
      auditContext: "llama-server-discovery",
    });
  } catch (error) {
    return { kind: "unreachable", error };
  }

  try {
    if (!params.readBody || !guarded.response.ok) {
      return {
        kind: "response",
        status: guarded.response.status,
        ok: guarded.response.ok,
      };
    }
    try {
      return {
        kind: "response",
        status: guarded.response.status,
        ok: true,
        body: await readProviderJsonResponse(guarded.response, "llama-server discovery"),
      };
    } catch (error) {
      return { kind: "invalid-response", error };
    }
  } finally {
    if (!guarded.response.bodyUsed) {
      await guarded.response.body?.cancel().catch(() => undefined);
    }
    await guarded.release();
  }
}

function readModelRows(body: unknown): LlamaServerModelWire[] {
  if (!isRecord(body)) {
    throw new Error("llama-server model list must be an object");
  }
  const data = body.data;
  if (!Array.isArray(data)) {
    throw new Error("llama-server model list must contain data[]");
  }
  return data.filter(
    (entry): entry is LlamaServerModelWire =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

function shouldReadProps(row: LlamaServerModelWire): boolean {
  const status = row.status?.value;
  return status === undefined || status === "loaded" || status === "sleeping";
}

async function readModelProps(params: {
  row: LlamaServerModelWire;
  routerMode: boolean;
  origin: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  fetchGuard: LlamaServerFetchGuard;
}): Promise<LlamaServerPropsWire | undefined> {
  if (!shouldReadProps(params.row) || typeof params.row.id !== "string") {
    return undefined;
  }
  const query = params.routerMode
    ? `?model=${encodeURIComponent(params.row.id)}&autoload=false`
    : "";
  const result = await fetchJson({
    url: `${params.origin}/props${query}`,
    origin: params.origin,
    apiKey: params.apiKey,
    headers: params.headers,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    readBody: true,
    fetchGuard: params.fetchGuard,
  });
  return result.kind === "response" && result.ok && isRecord(result.body) ? result.body : undefined;
}

/** Discovers llama-server models without loading, waking, or unloading them. */
export async function discoverLlamaServer(params: {
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  cacheTtlMs?: number;
  signal?: AbortSignal;
  fetchGuard?: LlamaServerFetchGuard;
}): Promise<LlamaServerDiscoveryResult> {
  const endpoint = resolveLlamaServerEndpoint(params.baseUrl);
  const normalizedApiKey = params.apiKey?.trim();
  const hasCredentialScope =
    Boolean(normalizedApiKey && !isNonSecretApiKeyMarker(normalizedApiKey)) ||
    Boolean(params.headers && Object.keys(params.headers).length > 0);
  const cacheTtlMs = hasCredentialScope
    ? 0
    : Math.max(0, params.cacheTtlMs ?? LLAMA_SERVER_DISCOVERY_CACHE_TTL_MS);
  const cached = discoveryCache.get(endpoint.origin);
  if (cacheTtlMs > 0 && cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.result;
    }
    discoveryCache.delete(endpoint.origin);
  }

  const timeoutMs = params.timeoutMs ?? LLAMA_SERVER_DISCOVERY_TIMEOUT_MS;
  const fetchGuard = params.fetchGuard ?? fetchWithSsrFGuard;
  const healthResult = await fetchJson({
    url: `${endpoint.origin}/health`,
    origin: endpoint.origin,
    apiKey: params.apiKey,
    headers: params.headers,
    timeoutMs,
    signal: params.signal,
    readBody: false,
    fetchGuard,
  });
  if (healthResult.kind === "unreachable") {
    return { kind: "unreachable", endpoint, error: healthResult.error };
  }
  const health: LlamaServerHealth =
    healthResult.kind === "response" && healthResult.status === 200
      ? "ready"
      : healthResult.kind === "response" && healthResult.status === 503
        ? "loading"
        : "unknown";
  if (
    healthResult.kind === "response" &&
    healthResult.status !== 200 &&
    healthResult.status !== 404 &&
    healthResult.status !== 503
  ) {
    return {
      kind: "http-error",
      endpoint,
      status: healthResult.status,
      path: "/health",
    };
  }

  let modelsPath = "/models";
  let modelsResult = await fetchJson({
    url: `${endpoint.origin}${modelsPath}`,
    origin: endpoint.origin,
    apiKey: params.apiKey,
    headers: params.headers,
    timeoutMs,
    signal: params.signal,
    readBody: true,
    fetchGuard,
  });
  if (modelsResult.kind === "response" && modelsResult.status === 404) {
    modelsPath = "/v1/models";
    modelsResult = await fetchJson({
      url: `${endpoint.origin}${modelsPath}`,
      origin: endpoint.origin,
      apiKey: params.apiKey,
      headers: params.headers,
      timeoutMs,
      signal: params.signal,
      readBody: true,
      fetchGuard,
    });
  }
  if (modelsResult.kind === "unreachable") {
    return { kind: "unreachable", endpoint, error: modelsResult.error };
  }
  if (modelsResult.kind === "invalid-response") {
    return {
      kind: "invalid-response",
      endpoint,
      path: modelsPath,
      error: modelsResult.error,
    };
  }
  if (!modelsResult.ok) {
    return {
      kind: "http-error",
      endpoint,
      status: modelsResult.status,
      path: modelsPath,
    };
  }

  let rows: LlamaServerModelWire[];
  try {
    rows = readModelRows(modelsResult.body);
  } catch (error) {
    return { kind: "invalid-response", endpoint, path: modelsPath, error };
  }
  const routerMode = rows.some((row) => row.status !== undefined);
  const propsByRowIndex = new Map<number, LlamaServerPropsWire>();
  const propsDeadline = Date.now() + Math.max(0, timeoutMs);
  const propsRowIndexes = rows
    .map((row, index) => (shouldReadProps(row) ? index : -1))
    .filter((index) => index >= 0)
    .slice(0, LLAMA_SERVER_ROUTER_PROPS_MAX_MODELS);
  for (
    let offset = 0;
    offset < propsRowIndexes.length;
    offset += LLAMA_SERVER_ROUTER_PROPS_CONCURRENCY
  ) {
    const remainingMs = propsDeadline - Date.now();
    if (remainingMs <= 0) {
      break;
    }
    const results = await Promise.all(
      propsRowIndexes
        .slice(offset, offset + LLAMA_SERVER_ROUTER_PROPS_CONCURRENCY)
        .map(async (index) => {
          const row = rows[index];
          if (!row) {
            return undefined;
          }
          const props = await readModelProps({
            row,
            routerMode,
            origin: endpoint.origin,
            apiKey: params.apiKey,
            headers: params.headers,
            timeoutMs: Math.min(timeoutMs, remainingMs),
            signal: params.signal,
            fetchGuard,
          });
          return props ? ([index, props] as const) : undefined;
        }),
    );
    for (const result of results) {
      if (result) {
        propsByRowIndex.set(...result);
      }
    }
  }
  const models = rows.flatMap((row, index) => {
    const model = mapLlamaServerModel(row, propsByRowIndex.get(index));
    return model ? [model] : [];
  });

  const fetchedAt = Date.now();
  const result = { kind: "success", endpoint, health, models, fetchedAt } as const;
  if (cacheTtlMs > 0) {
    cacheDiscovery(endpoint.origin, { result, expiresAt: fetchedAt + cacheTtlMs }, fetchedAt);
  }
  return result;
}
