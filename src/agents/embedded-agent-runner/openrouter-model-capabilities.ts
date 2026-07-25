/**
 * Runtime OpenRouter model capability detection.
 *
 * When an OpenRouter model is not in the built-in static list, we look up its
 * actual capabilities from a cached copy of the OpenRouter model catalog.
 *
 * Cache layers (checked in order):
 * 1. In-memory Map (instant, cleared on process restart)
 * 2. Shared SQLite state cache
 * 3. OpenRouter API fetch (populates both layers)
 *
 * Model capabilities are assumed stable — the cache has no TTL expiry.
 * A background refresh is triggered only when a model is not found in
 * the cache (i.e. a newly added model on OpenRouter).
 *
 * Sync callers can read whatever is already cached. Async callers can await a
 * one-time fetch so the first unknown-model lookup resolves with real
 * capabilities instead of the text-only fallback.
 */

import { formatErrorMessage } from "../../infra/errors.js";
import { readResponseWithLimit } from "../../infra/http-body.js";
import { resolveProxyFetchFromEnv } from "../../infra/net/proxy-fetch.js";
import { parseStrictFiniteNumber } from "../../infra/parse-finite-number.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createCorePluginStateSyncKeyedStore } from "../../plugin-state/plugin-state-store.js";

const log = createSubsystemLogger("openrouter-model-capabilities");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 10_000;
// Cap the catalog body so an untrusted/oversized OpenRouter response cannot force
// the runtime to buffer an unbounded payload before parsing. Mirrors the bound
// applied to the sibling pricing-cache endpoint (16 MiB).
const OPENROUTER_MODELS_RESPONSE_MAX_BYTES = 16 * 1024 * 1024;
const SQLITE_CACHE_OWNER_ID = "core:openrouter-model-capabilities";
const SQLITE_CACHE_NAMESPACE = "models.v3";
const SQLITE_CACHE_MAX_ENTRIES = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OpenRouterApiModel {
  id: string;
  name?: string;
  modality?: string;
  architecture?: {
    modality?: string;
  };
  supported_parameters?: string[];
  context_length?: number;
  max_completion_tokens?: number;
  max_output_tokens?: number;
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number;
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

interface OpenRouterModelCapabilities {
  name: string;
  input: Array<"text" | "image">;
  reasoning: boolean;
  supportsTools?: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

// ---------------------------------------------------------------------------
// SQLite cache
// ---------------------------------------------------------------------------

function isValidCapabilities(value: unknown): value is OpenRouterModelCapabilities {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    Array.isArray(record.input) &&
    typeof record.reasoning === "boolean" &&
    typeof record.contextWindow === "number" &&
    typeof record.maxTokens === "number"
  );
}

function openSqliteCacheStore() {
  return createCorePluginStateSyncKeyedStore<OpenRouterModelCapabilities>({
    ownerId: SQLITE_CACHE_OWNER_ID,
    namespace: SQLITE_CACHE_NAMESPACE,
    maxEntries: SQLITE_CACHE_MAX_ENTRIES,
  });
}

function writeSqliteCache(map: Map<string, OpenRouterModelCapabilities>): void {
  try {
    const store = openSqliteCacheStore();
    store.clear();
    for (const [id, capabilities] of map) {
      store.register(id, capabilities);
    }
  } catch (err: unknown) {
    const message = formatErrorMessage(err);
    log.debug(`Failed to write OpenRouter SQLite cache: ${message}`);
  }
}

function readSqliteCache(): Map<string, OpenRouterModelCapabilities> | undefined {
  try {
    const entries = openSqliteCacheStore().entries();
    if (entries.length === 0) {
      return undefined;
    }
    const map = new Map<string, OpenRouterModelCapabilities>();
    for (const { key, value } of entries) {
      if (isValidCapabilities(value)) {
        map.set(key, value);
      }
    }
    return map.size > 0 ? map : undefined;
  } catch (err: unknown) {
    const message = formatErrorMessage(err);
    log.debug(`Failed to read OpenRouter SQLite cache: ${message}`);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// In-memory cache state
// ---------------------------------------------------------------------------

let cache: Map<string, OpenRouterModelCapabilities> | undefined;
let fetchInFlight: Promise<void> | undefined;
const skipNextMissRefresh = new Set<string>();

function parseModel(model: OpenRouterApiModel): OpenRouterModelCapabilities {
  const input: Array<"text" | "image"> = ["text"];
  const modality = model.architecture?.modality ?? model.modality ?? "";
  const inputModalities = modality.split("->")[0] ?? "";
  if (inputModalities.includes("image")) {
    input.push("image");
  }
  const supportedParameters = Array.isArray(model.supported_parameters)
    ? model.supported_parameters
    : undefined;

  return {
    name: model.name || model.id,
    input,
    reasoning: supportedParameters?.includes("reasoning") ?? false,
    ...(supportedParameters ? { supportsTools: supportedParameters.includes("tools") } : {}),
    contextWindow: model.top_provider?.context_length ?? model.context_length ?? 128_000,
    maxTokens:
      model.top_provider?.max_completion_tokens ??
      model.max_completion_tokens ??
      model.max_output_tokens ??
      8192,
    cost: {
      input: (parseStrictFiniteNumber(model.pricing?.prompt) ?? 0) * 1_000_000,
      output: (parseStrictFiniteNumber(model.pricing?.completion) ?? 0) * 1_000_000,
      cacheRead: (parseStrictFiniteNumber(model.pricing?.input_cache_read) ?? 0) * 1_000_000,
      cacheWrite: (parseStrictFiniteNumber(model.pricing?.input_cache_write) ?? 0) * 1_000_000,
    },
  };
}

async function cancelUnreadResponseBody(response: Response | undefined): Promise<void> {
  if (response && !response.bodyUsed) {
    await response.body?.cancel().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

async function doFetch(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    const fetchFn = resolveProxyFetchFromEnv() ?? globalThis.fetch;

    response = await fetchFn(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
    });

    if (!response.ok) {
      log.warn(`OpenRouter models API returned ${response.status}`);
      return;
    }

    const bytes = await readResponseWithLimit(response, OPENROUTER_MODELS_RESPONSE_MAX_BYTES, {
      onOverflow: ({ size }) => new Error(`OpenRouter models response too large: ${size} bytes`),
    });
    const data = JSON.parse(bytes.toString("utf8")) as { data?: OpenRouterApiModel[] };
    const models = data.data ?? [];
    const map = new Map<string, OpenRouterModelCapabilities>();

    for (const model of models) {
      if (!model.id) {
        continue;
      }
      map.set(model.id, parseModel(model));
    }

    cache = map;
    writeSqliteCache(map);
    log.debug(`Cached ${map.size} OpenRouter models from API`);
  } catch (err: unknown) {
    const message = formatErrorMessage(err);
    log.warn(`Failed to fetch OpenRouter models: ${message}`);
  } finally {
    clearTimeout(timeout);
    await cancelUnreadResponseBody(response);
  }
}

function triggerFetch(): void {
  if (fetchInFlight) {
    return;
  }
  fetchInFlight = doFetch().finally(() => {
    fetchInFlight = undefined;
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the cache is populated. Checks in-memory first, then SQLite, then
 * triggers a background API fetch as a last resort.
 * Does not block — returns immediately.
 */
function ensureOpenRouterModelCache(): void {
  if (cache) {
    return;
  }

  const stored = readSqliteCache();
  if (stored) {
    cache = stored;
    log.debug(`Loaded ${stored.size} OpenRouter models from SQLite cache`);
    return;
  }

  triggerFetch();
}

/**
 * Ensure capabilities for a specific model are available before first use.
 *
 * Known cached entries return immediately. Unknown entries wait for at most
 * one catalog fetch, then leave sync resolution to read from the populated
 * cache on the same request.
 *
 * @deprecated OpenRouter provider-owned catalog helper; do not use from third-party plugins.
 */
export async function loadOpenRouterModelCapabilities(modelId: string): Promise<void> {
  ensureOpenRouterModelCache();
  if (cache?.has(modelId)) {
    return;
  }
  let fetchPromise = fetchInFlight;
  if (!fetchPromise) {
    triggerFetch();
    fetchPromise = fetchInFlight;
  }
  await fetchPromise;
  if (!cache?.has(modelId)) {
    skipNextMissRefresh.add(modelId);
  }
}

/**
 * Synchronously look up model capabilities from the cache.
 *
 * If a model is not found but the cache exists, a background refresh is
 * triggered in case it's a newly added model not yet in the cache.
 *
 * @deprecated OpenRouter provider-owned catalog helper; do not use from third-party plugins.
 */
export function getOpenRouterModelCapabilities(
  modelId: string,
): OpenRouterModelCapabilities | undefined {
  // A failed awaited load, such as an oversized catalog body, already attempted
  // a refresh. Do not let the follow-up sync lookup immediately retry it.
  const skipMissRefresh = skipNextMissRefresh.delete(modelId);
  if (!skipMissRefresh) {
    ensureOpenRouterModelCache();
  }
  const result = cache?.get(modelId);

  // Model not found but cache exists — may be a newly added model.
  // Trigger a refresh so the next call picks it up.
  if (!result && skipMissRefresh) {
    return undefined;
  }
  if (!result && cache && !fetchInFlight) {
    triggerFetch();
  }

  return result;
}
