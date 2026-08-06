// Ollama provider module implements model/runtime integration.
import { createHash } from "node:crypto";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-onboard";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_DEFAULT_MAX_TOKENS,
  OLLAMA_GLM52_CLOUD_MODEL_ID,
  OLLAMA_GLM52_CONTEXT_WINDOW,
} from "./defaults.js";

export type OllamaTagModel = {
  name: string;
  modified_at?: string;
  size?: number;
  digest?: string;
  remote_host?: string;
  details?: {
    family?: string;
    parameter_size?: string;
  };
};

export type OllamaTagsResponse = {
  models?: OllamaTagModel[];
};

export type OllamaModelWithContext = OllamaTagModel & {
  contextWindow?: number;
  capabilities?: string[];
};

const OLLAMA_SHOW_CONCURRENCY = 8;
const OLLAMA_CONTEXT_ENRICH_LIMIT = 200;
const MAX_OLLAMA_SHOW_CACHE_ENTRIES = 256;
const ollamaModelShowInfoCache = new Map<string, Promise<OllamaModelShowInfo>>();
const OLLAMA_ALWAYS_BLOCKED_HOSTNAMES = new Set(["metadata.google.internal"]);

export function buildOllamaBaseUrlSsrFPolicy(baseUrl: string) {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    if (OLLAMA_ALWAYS_BLOCKED_HOSTNAMES.has(parsed.hostname)) {
      return undefined;
    }
    return {
      hostnameAllowlist: [parsed.hostname],
      allowPrivateNetwork: true,
    };
  } catch {
    return undefined;
  }
}

export function resolveOllamaApiBase(configuredBaseUrl?: string): string {
  if (!configuredBaseUrl) {
    return OLLAMA_DEFAULT_BASE_URL;
  }
  const trimmed = configuredBaseUrl.replace(/\/+$/, "");
  return trimmed.replace(/\/v1$/i, "");
}

export type OllamaModelShowInfo = {
  contextWindow?: number;
  capabilities?: string[];
};

function buildOllamaModelShowCacheKey(
  apiBase: string,
  model: Pick<OllamaTagModel, "name" | "digest" | "modified_at">,
  apiKey?: string,
): string | undefined {
  const version = model.digest?.trim() || model.modified_at?.trim();
  if (!version) {
    return undefined;
  }
  const authScope = apiKey ? createHash("sha256").update(apiKey).digest("hex") : "anonymous";
  return `${resolveOllamaApiBase(apiBase)}|${model.name}|${version}|${authScope}`;
}

function setOllamaModelShowCacheEntry(key: string, value: Promise<OllamaModelShowInfo>): void {
  if (ollamaModelShowInfoCache.size >= MAX_OLLAMA_SHOW_CACHE_ENTRIES) {
    const oldestKey = ollamaModelShowInfoCache.keys().next().value;
    if (typeof oldestKey === "string") {
      ollamaModelShowInfoCache.delete(oldestKey);
    }
  }
  ollamaModelShowInfoCache.set(key, value);
}

function hasCachedOllamaModelShowInfo(info: OllamaModelShowInfo): boolean {
  return typeof info.contextWindow === "number" || (info.capabilities?.length ?? 0) > 0;
}

export function parseOllamaNumCtxParameter(parameters: unknown): number | undefined {
  if (typeof parameters !== "string" || !parameters.trim()) {
    return undefined;
  }

  let lastValue: number | undefined;
  for (const rawLine of parameters.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^num_ctx\s+(-?\d+)\b/);
    if (!match) {
      continue;
    }
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      lastValue = parsed;
    }
  }
  return lastValue;
}

export async function queryOllamaModelShowInfo(
  apiBase: string,
  modelName: string,
  opts?: { apiKey?: string },
): Promise<OllamaModelShowInfo> {
  const normalizedApiBase = resolveOllamaApiBase(apiBase);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts?.apiKey) {
      headers.Authorization = `Bearer ${opts.apiKey}`;
    }
    const { response, release } = await fetchWithSsrFGuard({
      url: `${normalizedApiBase}/api/show`,
      init: {
        method: "POST",
        headers,
        body: JSON.stringify({ name: modelName }),
        signal: AbortSignal.timeout(3000),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(normalizedApiBase),
      auditContext: "ollama-provider-models.show",
    });
    try {
      if (!response.ok) {
        return {};
      }
      const data = await readProviderJsonResponse<{
        model_info?: Record<string, unknown>;
        capabilities?: unknown;
        parameters?: unknown;
      }>(response, "ollama-provider-models.show");

      let contextWindow: number | undefined;
      if (data.model_info) {
        for (const [key, value] of Object.entries(data.model_info)) {
          if (
            key.endsWith(".context_length") &&
            typeof value === "number" &&
            Number.isFinite(value)
          ) {
            const ctx = Math.floor(value);
            if (ctx > 0) {
              contextWindow = ctx;
              break;
            }
          }
        }
      }

      const paramCtx = parseOllamaNumCtxParameter(data.parameters);
      if (paramCtx !== undefined && (contextWindow === undefined || paramCtx > contextWindow)) {
        contextWindow = paramCtx;
      }

      const capabilities = Array.isArray(data.capabilities)
        ? (data.capabilities as unknown[]).filter((c): c is string => typeof c === "string")
        : undefined;

      return { contextWindow, capabilities };
    } finally {
      await release();
    }
  } catch {
    return {};
  }
}

async function queryOllamaModelShowInfoCached(
  apiBase: string,
  model: Pick<OllamaTagModel, "name" | "digest" | "modified_at">,
  opts?: { apiKey?: string },
): Promise<OllamaModelShowInfo> {
  const normalizedApiBase = resolveOllamaApiBase(apiBase);
  const cacheKey = buildOllamaModelShowCacheKey(normalizedApiBase, model, opts?.apiKey);
  if (!cacheKey) {
    return await queryOllamaModelShowInfo(normalizedApiBase, model.name, opts);
  }

  const cached = ollamaModelShowInfoCache.get(cacheKey);
  if (cached) {
    return await cached;
  }

  const pending = queryOllamaModelShowInfo(normalizedApiBase, model.name, opts).then((result) => {
    if (!hasCachedOllamaModelShowInfo(result)) {
      ollamaModelShowInfoCache.delete(cacheKey);
    }
    return result;
  });
  setOllamaModelShowCacheEntry(cacheKey, pending);
  return await pending;
}

/** @deprecated Use queryOllamaModelShowInfo instead. */
export async function queryOllamaContextWindow(
  apiBase: string,
  modelName: string,
): Promise<number | undefined> {
  return (await queryOllamaModelShowInfo(apiBase, modelName)).contextWindow;
}

export async function enrichOllamaModelsWithContext(
  apiBase: string,
  models: OllamaTagModel[],
  opts?: { apiKey?: string; concurrency?: number },
): Promise<OllamaModelWithContext[]> {
  const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? OLLAMA_SHOW_CONCURRENCY));
  const enriched: OllamaModelWithContext[] = [];
  for (let index = 0; index < models.length; index += concurrency) {
    const batch = models.slice(index, index + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const showInfo = await queryOllamaModelShowInfoCached(
          apiBase,
          model,
          opts?.apiKey ? { apiKey: opts.apiKey } : undefined,
        );
        return Object.assign({}, model, {
          contextWindow: showInfo.contextWindow,
          capabilities: showInfo.capabilities,
        });
      }),
    );
    enriched.push(...batchResults);
  }
  return enriched;
}

export function isReasoningModelHeuristic(modelId: string): boolean {
  return /r1|reasoning|think|reason/i.test(modelId);
}

function isKnownOllamaCloudReasoningModel(modelId: string): boolean {
  const normalized = modelId.trim().toLowerCase();
  return (
    normalized === OLLAMA_GLM52_CLOUD_MODEL_ID ||
    /^deepseek-v4-(?:flash|pro):cloud$/.test(normalized)
  );
}

export function buildOllamaModelDefinition(
  modelId: string,
  contextWindow?: number,
  capabilities?: string[],
): ModelDefinitionConfig {
  const hasVision = capabilities?.includes("vision") ?? false;
  const input: ("text" | "image")[] = hasVision ? ["text", "image"] : ["text"];
  const reasoning =
    isKnownOllamaCloudReasoningModel(modelId) ||
    (capabilities === undefined
      ? isReasoningModelHeuristic(modelId)
      : capabilities.includes("thinking"));
  const compat =
    capabilities === undefined
      ? { supportsTools: true, supportsUsageInStreaming: true }
      : {
          supportsTools: capabilities.includes("tools"),
          supportsUsageInStreaming: true,
        };
  return {
    id: modelId,
    name: modelId,
    reasoning,
    input,
    cost: OLLAMA_DEFAULT_COST,
    contextWindow:
      contextWindow ??
      (modelId.trim().toLowerCase() === OLLAMA_GLM52_CLOUD_MODEL_ID
        ? OLLAMA_GLM52_CONTEXT_WINDOW
        : OLLAMA_DEFAULT_CONTEXT_WINDOW),
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
    compat,
  };
}

export async function fetchOllamaModels(
  baseUrl: string,
  opts?: { apiKey?: string },
): Promise<{ reachable: boolean; models: OllamaTagModel[] }> {
  try {
    const apiBase = resolveOllamaApiBase(baseUrl);
    const { response, release } = await fetchWithSsrFGuard({
      url: `${apiBase}/api/tags`,
      init: {
        headers: opts?.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : undefined,
        signal: AbortSignal.timeout(5000),
      },
      policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
      auditContext: "ollama-provider-models.tags",
    });
    try {
      if (!response.ok) {
        return { reachable: true, models: [] };
      }
      const data = await readProviderJsonResponse<OllamaTagsResponse>(
        response,
        "ollama-provider-models.tags",
      );
      const models = (data.models ?? []).filter((m) => m.name);
      return { reachable: true, models };
    } finally {
      await release();
    }
  } catch {
    return { reachable: false, models: [] };
  }
}

export async function buildOllamaProvider(
  configuredBaseUrl?: string,
  opts?: { apiKey?: string; quiet?: boolean },
): Promise<ModelProviderConfig> {
  const apiBase = resolveOllamaApiBase(configuredBaseUrl);
  const auth = opts?.apiKey ? { apiKey: opts.apiKey } : undefined;
  const { reachable, models } = await fetchOllamaModels(apiBase, auth);
  if (!reachable && !opts?.quiet) {
    console.warn(`Ollama could not be reached at ${apiBase}.`);
  }
  const discovered = await enrichOllamaModelsWithContext(
    apiBase,
    models.slice(0, OLLAMA_CONTEXT_ENRICH_LIMIT),
    auth,
  );
  return {
    baseUrl: apiBase,
    api: "ollama",
    models: discovered.map((model) =>
      buildOllamaModelDefinition(model.name, model.contextWindow, model.capabilities),
    ),
  };
}

export function resetOllamaModelShowInfoCacheForTest(): void {
  ollamaModelShowInfoCache.clear();
}
