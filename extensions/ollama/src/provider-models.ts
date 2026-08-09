// Ollama provider module implements model/runtime integration.
import { createHash } from "node:crypto";
import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  isCloudModelRef,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-onboard";
import { fetchWithSsrFGuard, type LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  OLLAMA_CLOUD_DEFAULT_MODELS,
  OLLAMA_DEFAULT_BASE_URL,
  OLLAMA_DEFAULT_CONTEXT_WINDOW,
  OLLAMA_DEFAULT_COST,
  OLLAMA_DEFAULT_MAX_TOKENS,
  OLLAMA_LOCAL_CONTEXT_TOKENS,
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
    quantization_level?: string;
  };
};

export type OllamaTagsResponse = {
  models?: OllamaTagModel[];
};

type OllamaRunningModel = {
  name?: unknown;
  model?: unknown;
};

type OllamaModelRow = OllamaTagModel | OllamaRunningModel;

export type OllamaModelWithContext = OllamaTagModel & {
  contextWindow?: number;
  capabilities?: string[];
  showInspectionFailed?: boolean;
};

const OLLAMA_SHOW_CONCURRENCY = 8;
const OLLAMA_CONTEXT_ENRICH_LIMIT = 200;
const OLLAMA_SHOW_TIMEOUT_MS = 3000;
const OLLAMA_TAGS_TIMEOUT_MS = 5000;
const MAX_OLLAMA_DISCOVERY_PROBES = OLLAMA_CONTEXT_ENRICH_LIMIT * 4;
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
  /** Distinguishes a failed request from a successful response that omitted capabilities. */
  showInspectionFailed?: boolean;
};

const OLLAMA_FAILED_SHOW_INFO: OllamaModelShowInfo = Object.freeze({
  showInspectionFailed: true,
});

type OllamaModelRequestOptions = {
  apiKey?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

type OllamaModelShowRequestOptions = OllamaModelRequestOptions & {
  auditContext?: string;
};

export function throwIfOllamaRequestAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw toErrorObject(signal.reason, "Ollama request aborted");
  }
}

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

function parseOllamaNumCtxParameter(parameters: unknown): number | undefined {
  if (typeof parameters !== "string" || !parameters.trim()) {
    return undefined;
  }

  let lastValue: number | undefined;
  for (const rawLine of parameters.split(/\r?\n/)) {
    const match = rawLine.trim().match(/^num_ctx\s+(-?\d+)\b/);
    if (!match) {
      continue;
    }
    const rawValue = match[1];
    if (!rawValue) {
      continue;
    }
    const parsed = Number.parseInt(rawValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      lastValue = parsed;
    }
  }
  return lastValue;
}

export async function readOllamaModelShowInfo(
  apiBase: string,
  modelName: string,
  opts?: OllamaModelShowRequestOptions,
): Promise<OllamaModelShowInfo> {
  const normalizedApiBase = resolveOllamaApiBase(apiBase);
  const auditContext = opts?.auditContext ?? "ollama-provider-models.show";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts?.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }
  const { response, release } = await fetchWithSsrFGuard({
    url: `${normalizedApiBase}/api/show`,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify({ model: modelName }),
    },
    // Guard-owned timeoutMs also bounds DNS/proxy preflight; init.signal does not.
    timeoutMs: Math.min(opts?.timeoutMs ?? OLLAMA_SHOW_TIMEOUT_MS, OLLAMA_SHOW_TIMEOUT_MS),
    ...(opts?.signal ? { signal: opts.signal } : {}),
    policy: buildOllamaBaseUrlSsrFPolicy(normalizedApiBase),
    auditContext,
  });
  try {
    if (!response.ok) {
      // Capture can retain a cloned tee branch, so cancellation must not delay
      // the guard's bounded dispatcher release.
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`Ollama model inspection failed with HTTP ${response.status}`);
    }
    const data = await readProviderJsonResponse<{
      model_info?: Record<string, unknown>;
      capabilities?: unknown;
      parameters?: unknown;
    }>(response, auditContext);

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
      ? (data.capabilities as unknown[]).filter(
          (capability): capability is string => typeof capability === "string",
        )
      : undefined;

    return { contextWindow, capabilities };
  } finally {
    await release();
  }
}

export async function queryOllamaModelShowInfo(
  apiBase: string,
  modelName: string,
  opts?: OllamaModelRequestOptions,
): Promise<OllamaModelShowInfo> {
  try {
    return await readOllamaModelShowInfo(apiBase, modelName, opts);
  } catch {
    throwIfOllamaRequestAborted(opts?.signal);
    return OLLAMA_FAILED_SHOW_INFO;
  }
}

async function queryOllamaModelShowInfoCached(
  apiBase: string,
  model: Pick<OllamaTagModel, "name" | "digest" | "modified_at">,
  opts?: OllamaModelRequestOptions,
): Promise<OllamaModelShowInfo> {
  const normalizedApiBase = resolveOllamaApiBase(apiBase);
  const cacheKey = buildOllamaModelShowCacheKey(normalizedApiBase, model, opts?.apiKey);
  // Caller-owned deadlines and cancellation must not affect a shared catalog probe.
  if (!cacheKey || opts?.timeoutMs !== undefined || opts?.signal) {
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
  opts?: OllamaModelRequestOptions & { concurrency?: number },
): Promise<OllamaModelWithContext[]> {
  const concurrency = Math.max(1, Math.floor(opts?.concurrency ?? OLLAMA_SHOW_CONCURRENCY));
  const enriched: OllamaModelWithContext[] = [];
  for (let index = 0; index < models.length; index += concurrency) {
    throwIfOllamaRequestAborted(opts?.signal);
    const batch = models.slice(index, index + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (model) => {
        const showInfo = await queryOllamaModelShowInfoCached(apiBase, model, opts);
        return Object.assign({}, model, showInfo);
      }),
    );
    enriched.push(...batchResults);
  }
  return enriched;
}

export async function enrichOllamaCompletionModels(
  apiBase: string,
  models: OllamaTagModel[],
  opts?: OllamaModelRequestOptions & { requireCompletionCapability?: boolean },
): Promise<OllamaModelWithContext[]> {
  const completionModels: OllamaModelWithContext[] = [];
  const probeLimit = Math.min(models.length, MAX_OLLAMA_DISCOVERY_PROBES);
  for (
    let index = 0;
    index < probeLimit && completionModels.length < OLLAMA_CONTEXT_ENRICH_LIMIT;
    index += OLLAMA_SHOW_CONCURRENCY
  ) {
    throwIfOllamaRequestAborted(opts?.signal);
    const batch = await enrichOllamaModelsWithContext(
      apiBase,
      models.slice(index, Math.min(index + OLLAMA_SHOW_CONCURRENCY, probeLimit)),
      opts,
    );
    for (const model of batch) {
      const canComplete = model.capabilities?.includes("completion");
      if (!canComplete && (opts?.requireCompletionCapability || model.capabilities)) {
        continue;
      }
      completionModels.push(model);
      if (completionModels.length === OLLAMA_CONTEXT_ENRICH_LIMIT) {
        break;
      }
    }
  }
  return completionModels;
}

export function isOllamaCloudModel(modelName: string | undefined): boolean {
  return isCloudModelRef(modelName);
}

export function isReasoningModelHeuristic(modelId: string): boolean {
  return /r1|reasoning|think|reason/i.test(modelId);
}

function isKnownOllamaCloudReasoningModel(modelId: string): boolean {
  // Match both the canonical direct-host id and the local `:cloud` routing alias.
  const normalized = modelId
    .trim()
    .toLowerCase()
    .replace(/:cloud$/, "");
  return normalized === "glm-5.2" || /^deepseek-v4-(?:flash|pro)$/.test(normalized);
}

export function buildOllamaModelDefinition(
  modelId: string,
  contextWindow?: number,
  capabilities?: string[],
  opts?: { showInspectionFailed?: boolean },
): ModelDefinitionConfig {
  const hasVision = capabilities?.includes("vision") ?? false;
  const input: ("text" | "image")[] = hasVision ? ["text", "image"] : ["text"];
  const reasoning =
    isKnownOllamaCloudReasoningModel(modelId) ||
    (capabilities === undefined
      ? isReasoningModelHeuristic(modelId)
      : capabilities.includes("thinking"));
  const compat = {
    supportsTools:
      opts?.showInspectionFailed === true ? false : (capabilities?.includes("tools") ?? true),
    supportsUsageInStreaming: true,
    supportsJsonSchemaResponseFormat: !isOllamaCloudModel(modelId),
  };
  return {
    id: modelId,
    name: modelId,
    reasoning,
    input,
    cost: OLLAMA_DEFAULT_COST,
    contextWindow:
      contextWindow ??
      (modelId
        .trim()
        .toLowerCase()
        .replace(/:cloud$/, "") === "glm-5.2"
        ? 1_000_000
        : OLLAMA_DEFAULT_CONTEXT_WINDOW),
    maxTokens: OLLAMA_DEFAULT_MAX_TOKENS,
    compat,
  };
}

export function buildDefaultOllamaCloudModelDefinition(
  model: (typeof OLLAMA_CLOUD_DEFAULT_MODELS)[number],
): ModelDefinitionConfig {
  return {
    ...buildOllamaModelDefinition(model.id, model.contextWindow, [...model.capabilities]),
    compat: {
      supportsTools: true,
      supportsUsageInStreaming: true,
    },
  };
}

export function capLocalOllamaModelContext(model: ModelDefinitionConfig): ModelDefinitionConfig {
  if (isOllamaCloudModel(model.id) || typeof model.contextWindow !== "number") {
    return model;
  }
  return {
    ...model,
    // Local Ollama allocates KV cache from num_ctx. Keep native metadata, but cap
    // setup-assistant and typical agent turns at 32k; config overlays remain authoritative.
    contextTokens: Math.min(OLLAMA_LOCAL_CONTEXT_TOKENS, model.contextWindow),
  };
}

export function capLocalOllamaProviderContext(provider: ModelProviderConfig): ModelProviderConfig {
  return {
    ...provider,
    models: provider.models?.map(capLocalOllamaModelContext),
  };
}

/** Optional test hooks so discovery can exercise the real guarded-fetch owner. */
type OllamaModelsFetchDeps = {
  fetchImpl?: typeof fetch;
  lookupFn?: LookupFn;
};

async function fetchOllamaModelRows(params: {
  baseUrl: string;
  endpoint: "ps" | "tags";
  opts?: OllamaModelRequestOptions;
  deps?: OllamaModelsFetchDeps;
}): Promise<{ reachable: boolean; models: OllamaModelRow[] }> {
  try {
    const apiBase = resolveOllamaApiBase(params.baseUrl);
    const auditContext = `ollama-provider-models.${params.endpoint}`;
    const { response, release } = await fetchWithSsrFGuard({
      url: `${apiBase}/api/${params.endpoint}`,
      init: {
        headers: params.opts?.apiKey
          ? { Authorization: `Bearer ${params.opts.apiKey}` }
          : undefined,
      },
      // Guard-owned timeoutMs also bounds DNS/proxy preflight; init.signal does not.
      timeoutMs: Math.min(params.opts?.timeoutMs ?? OLLAMA_TAGS_TIMEOUT_MS, OLLAMA_TAGS_TIMEOUT_MS),
      ...(params.opts?.signal ? { signal: params.opts.signal } : {}),
      policy: buildOllamaBaseUrlSsrFPolicy(apiBase),
      auditContext,
      ...(params.deps?.fetchImpl ? { fetchImpl: params.deps.fetchImpl } : {}),
      ...(params.deps?.lookupFn ? { lookupFn: params.deps.lookupFn } : {}),
    });
    try {
      if (!response.ok) {
        // Capture can retain a cloned tee branch, so cancellation must not delay
        // the guard's bounded dispatcher release.
        void response.body?.cancel().catch(() => undefined);
        return { reachable: true, models: [] };
      }
      const data = await readProviderJsonResponse<{ models?: OllamaModelRow[] }>(
        response,
        auditContext,
      );
      const models = Array.isArray(data.models) ? data.models : [];
      return { reachable: true, models };
    } finally {
      await release();
    }
  } catch {
    throwIfOllamaRequestAborted(params.opts?.signal);
    return { reachable: false, models: [] };
  }
}

export async function fetchOllamaModels(
  baseUrl: string,
  opts?: OllamaModelRequestOptions,
  deps?: OllamaModelsFetchDeps,
): Promise<{ reachable: boolean; models: OllamaTagModel[] }> {
  const result = await fetchOllamaModelRows({
    baseUrl,
    endpoint: "tags",
    opts,
    deps,
  });
  return {
    reachable: result.reachable,
    models: result.models.filter(
      (model): model is OllamaTagModel => typeof model.name === "string" && Boolean(model.name),
    ),
  };
}

export async function fetchLoadedOllamaModelNames(
  baseUrl: string,
  opts?: OllamaModelRequestOptions,
  deps?: OllamaModelsFetchDeps,
): Promise<{ reachable: boolean; models: string[] }> {
  const result = await fetchOllamaModelRows({
    baseUrl,
    endpoint: "ps",
    opts,
    deps,
  });
  return {
    reachable: result.reachable,
    models: result.models
      .map((model) =>
        typeof model.name === "string"
          ? model.name.trim()
          : "model" in model && typeof model.model === "string"
            ? model.model.trim()
            : "",
      )
      .filter(Boolean),
  };
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
  const discovered = await enrichOllamaCompletionModels(apiBase, models, auth);
  return {
    baseUrl: apiBase,
    api: "ollama",
    models: discovered.map((model) =>
      buildOllamaModelDefinition(model.name, model.contextWindow, model.capabilities, {
        showInspectionFailed: model.showInspectionFailed,
      }),
    ),
  };
}
