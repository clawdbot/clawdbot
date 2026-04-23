/**
 * Runtime OpenRouter model capability detection.
 *
 * When an OpenRouter model is not in the built-in static list, we look up its
 * actual capabilities from a cached copy of the OpenRouter model catalog.
 *
 * Cache layers (checked in order):
 * 1. In-memory Map (instant, cleared on process restart)
 * 2. On-disk JSON file (<stateDir>/cache/openrouter-models.json)
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

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveProxyFetchFromEnv } from "../../infra/net/proxy-fetch.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

const log = createSubsystemLogger("openrouter-model-capabilities");

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const FETCH_TIMEOUT_MS = 10_000;
const DISK_CACHE_FILENAME = "openrouter-models.json";

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
    max_completion_tokens?: number;
  };
  pricing?: {
    prompt?: string;
    completion?: string;
    input_cache_read?: string;
    input_cache_write?: string;
  };
}

export interface OpenRouterModelCapabilities {
  name: string;
  input: Array<"text" | "image">;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
}

interface DiskCachePayload {
  models: Record<string, OpenRouterModelCapabilities>;
}

// ---------------------------------------------------------------------------
// Disk cache
// ---------------------------------------------------------------------------

function resolveDiskCacheDir(): string {
  return join(resolveStateDir(), "cache");
}

function resolveDiskCachePath(): string {
  return join(resolveDiskCacheDir(), DISK_CACHE_FILENAME);
}

function writeDiskCache(map: Map<string, OpenRouterModelCapabilities>): void {
  try {
    const cacheDir = resolveDiskCacheDir();
    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true });
    }
    const payload: DiskCachePayload = {
      models: Object.fromEntries(map),
    };
    writeFileSync(resolveDiskCachePath(), JSON.stringify(payload), "utf-8");
  } catch (err: unknown) {
    const message = formatErrorMessage(err);
    log.debug(`Failed to write OpenRouter disk cache: ${message}`);
  }
}

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

function readDiskCache(): Map<string, OpenRouterModelCapabilities> | undefined {
  try {
    const cachePath = resolveDiskCachePath();
    if (!existsSync(cachePath)) {
      return undefined;
    }
    const raw = readFileSync(cachePath, "utf-8");
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== "object") {
      return undefined;
    }
    const models = (payload as DiskCachePayload).models;
    if (!models || typeof models !== "object") {
      return undefined;
    }
    const map = new Map<string, OpenRouterModelCapabilities>();
    for (const [id, caps] of Object.entries(models)) {
      if (isValidCapabilities(caps)) {
        map.set(id, caps);
      }
    }
    return map.size > 0 ? map : undefined;
  } catch {
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

  return {
    name: model.name || model.id,
    input,
    reasoning: model.supported_parameters?.includes("reasoning") ?? false,
    contextWindow: model.context_length || 128_000,
    maxTokens:
      model.top_provider?.max_completion_tokens ??
      model.max_completion_tokens ??
      model.max_output_tokens ??
      8192,
    cost: {
      input: Number.parseFloat(model.pricing?.prompt || "0") * 1_000_000,
      output: Number.parseFloat(model.pricing?.completion || "0") * 1_000_000,
      cacheRead: Number.parseFloat(model.pricing?.input_cache_read || "0") * 1_000_000,
      cacheWrite: Number.parseFloat(model.pricing?.input_cache_write || "0") * 1_000_000,
    },
  };
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

async function doFetch(): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const fetchFn = resolveProxyFetchFromEnv() ?? globalThis.fetch;

    const response = await fetchFn(OPENROUTER_MODELS_URL, {
      signal: controller.signal,
    });

    if (!response.ok) {
      log.warn(`OpenRouter models API returned ${response.status}`);
      return;
    }

    const data = (await response.json()) as { data?: OpenRouterApiModel[] };
    const models = data.data ?? [];
    const map = new Map<string, OpenRouterModelCapabilities>();

    for (const model of models) {
      if (!model.id) {
        continue;
      }
      map.set(model.id, parseModel(model));
    }

    cache = map;
    writeDiskCache(map);
    log.debug(`Cached ${map.size} OpenRouter models from API`);
  } catch (err: unknown) {
    const message = formatErrorMessage(err);
    log.warn(`Failed to fetch OpenRouter models: ${message}`);
  } finally {
    clearTimeout(timeout);
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
 * Ensure the cache is populated. Checks in-memory first, then disk, then
 * triggers a background API fetch as a last resort.
 * Does not block — returns immediately.
 */
export function ensureOpenRouterModelCache(): void {
  if (cache) {
    return;
  }

  // Try loading from disk before hitting the network.
  const disk = readDiskCache();
  if (disk) {
    cache = disk;
    log.debug(`Loaded ${disk.size} OpenRouter models from disk cache`);
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
 */
export function getOpenRouterModelCapabilities(
  modelId: string,
): OpenRouterModelCapabilities | undefined {
  ensureOpenRouterModelCache();
  const result = cache?.get(modelId);

  // Model not found but cache exists — may be a newly added model.
  // Trigger a refresh so the next call picks it up.
  if (!result && skipNextMissRefresh.delete(modelId)) {
    return undefined;
  }
  if (!result && cache && !fetchInFlight) {
    triggerFetch();
  }

  return result;
}
