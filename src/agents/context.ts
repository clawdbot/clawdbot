// Lazy-load pi-coding-agent model metadata so we can infer context windows when
// the agent reports a model id. This includes custom models.json entries.

import path from "node:path";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { computeBackoff, type BackoffPolicy } from "../infra/backoff.js";
import { consumeRootOptionToken, FLAG_TERMINATOR } from "../infra/cli-root-options.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { resolveOpenClawAgentDir } from "./agent-paths.js";
import { lookupCachedContextTokens, MODEL_CONTEXT_TOKEN_CACHE } from "./context-cache.js";
import { CONTEXT_WINDOW_RUNTIME_STATE } from "./context-runtime-state.js";
import { normalizeProviderId } from "./model-selection.js";

export { resetContextWindowCacheForTest } from "./context-runtime-state.js";

type ModelEntry = { id: string; contextWindow?: number; contextTokens?: number };
type ModelRegistryLike = {
  getAvailable?: () => ModelEntry[];
  getAll: () => ModelEntry[];
};
type ConfigModelEntry = { id?: string; contextWindow?: number; contextTokens?: number };
type ProviderConfigEntry = { models?: ConfigModelEntry[] };
type ModelsConfig = { providers?: Record<string, ProviderConfigEntry | undefined> };
type AgentModelEntry = { params?: Record<string, unknown> };

const ANTHROPIC_1M_MODEL_PREFIXES = ["claude-opus-4", "claude-sonnet-4"] as const;
const CLAUDE_OPUS_47_MODEL_PREFIXES = ["claude-opus-4-7", "claude-opus-4.7"] as const;
export const ANTHROPIC_CONTEXT_1M_TOKENS = 1_048_576;
const CONFIG_LOAD_RETRY_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0,
};

export function applyDiscoveredContextWindows(params: {
  cache: Map<string, number>;
  models: ModelEntry[];
}) {
  for (const model of params.models) {
    if (!model?.id) {
      continue;
    }
    const discoveredContextTokens =
      typeof model.contextTokens === "number"
        ? Math.trunc(model.contextTokens)
        : typeof model.contextWindow === "number"
          ? Math.trunc(model.contextWindow)
          : undefined;
    const contextTokens = shouldUseDiscoveredAnthropicOpus47ContextWindow(model.id)
      ? ANTHROPIC_CONTEXT_1M_TOKENS
      : discoveredContextTokens;
    if (!contextTokens || contextTokens <= 0) {
      continue;
    }
    const existing = params.cache.get(model.id);
    // Cache the most conservative effective limit. Provider/runtime callers that
    // know the active provider should still prefer qualified lookups first.
    if (existing === undefined || contextTokens < existing) {
      params.cache.set(model.id, contextTokens);
    }
  }
}

export function applyConfiguredContextWindows(params: {
  cache: Map<string, number>;
  modelsConfig: ModelsConfig | undefined;
}) {
  const providers = params.modelsConfig?.providers;
  if (!providers || typeof providers !== "object") {
    return;
  }
  for (const provider of Object.values(providers)) {
    if (!Array.isArray(provider?.models)) {
      continue;
    }
    for (const model of provider.models) {
      const modelId = typeof model?.id === "string" ? model.id : undefined;
      const contextTokens =
        typeof model?.contextTokens === "number"
          ? model.contextTokens
          : typeof model?.contextWindow === "number"
            ? model.contextWindow
            : undefined;
      if (!modelId || !contextTokens || contextTokens <= 0) {
        continue;
      }
      params.cache.set(modelId, contextTokens);
    }
  }
}

function loadModelsConfigRuntime() {
  CONTEXT_WINDOW_RUNTIME_STATE.modelsConfigRuntimePromise ??= import("./models-config.runtime.js");
  return CONTEXT_WINDOW_RUNTIME_STATE.modelsConfigRuntimePromise;
}

function isLikelyOpenClawCliProcess(argv: string[] = process.argv): boolean {
  const entryBasename = normalizeLowercaseStringOrEmpty(path.basename(argv[1] ?? ""));
  return (
    entryBasename === "openclaw" ||
    entryBasename === "openclaw.mjs" ||
    entryBasename === "entry.js" ||
    entryBasename === "entry.mjs"
  );
}

function getCommandPathFromArgv(argv: string[]): string[] {
  const args = argv.slice(2);
  const tokens: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === FLAG_TERMINATOR) {
      break;
    }
    const consumed = consumeRootOptionToken(args, i);
    if (consumed > 0) {
      i += consumed - 1;
      continue;
    }
    if (arg.startsWith("-")) {
      continue;
    }
    tokens.push(arg);
    if (tokens.length >= 2) {
      break;
    }
  }
  return tokens;
}

const SKIP_EAGER_WARMUP_PRIMARY_COMMANDS = new Set([
  "agent",
  "backup",
  "completion",
  "config",
  "directory",
  "doctor",
  "gateway",
  "health",
  "hooks",
  "logs",
  "models",
  "plugins",
  "secrets",
  "status",
  "update",
  "webhooks",
]);

export function shouldEagerWarmContextWindowCache(argv: string[] = process.argv): boolean {
  // Keep this gate tied to the real OpenClaw CLI entrypoints.
  //
  // This module can also land inside shared dist chunks that are imported from
  // plugin-sdk/library surfaces during smoke tests and plugin loading. If we do
  // eager warmup for those generic Node script imports, merely importing the
  // built plugin-sdk can call ensureOpenClawModelsJson(), which cascades into
  // plugin discovery and breaks dist/source singleton assumptions.
  if (!isLikelyOpenClawCliProcess(argv)) {
    return false;
  }
  const [primary] = getCommandPathFromArgv(argv);
  return Boolean(primary) && !SKIP_EAGER_WARMUP_PRIMARY_COMMANDS.has(primary);
}

function primeConfiguredContextWindows(): OpenClawConfig | undefined {
  if (CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig) {
    applyConfiguredContextWindows({
      cache: MODEL_CONTEXT_TOKEN_CACHE,
      modelsConfig: CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig.models as
        | ModelsConfig
        | undefined,
    });
    return CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig;
  }
  if (Date.now() < CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs) {
    return undefined;
  }
  try {
    const cfg = loadConfig();
    applyConfiguredContextWindows({
      cache: MODEL_CONTEXT_TOKEN_CACHE,
      modelsConfig: cfg.models as ModelsConfig | undefined,
    });
    CONTEXT_WINDOW_RUNTIME_STATE.configuredConfig = cfg;
    CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures = 0;
    CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = 0;
    return cfg;
  } catch {
    CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures += 1;
    const backoffMs = computeBackoff(
      CONFIG_LOAD_RETRY_POLICY,
      CONTEXT_WINDOW_RUNTIME_STATE.configLoadFailures,
    );
    CONTEXT_WINDOW_RUNTIME_STATE.nextConfigLoadAttemptAtMs = Date.now() + backoffMs;
    // If config can't be loaded, leave cache empty and retry after backoff.
    return undefined;
  }
}

function ensureContextWindowCacheLoaded(): Promise<void> {
  if (CONTEXT_WINDOW_RUNTIME_STATE.loadPromise) {
    return CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
  }

  const cfg = primeConfiguredContextWindows();
  if (!cfg) {
    return Promise.resolve();
  }

  CONTEXT_WINDOW_RUNTIME_STATE.loadPromise = (async () => {
    try {
      await (await loadModelsConfigRuntime()).ensureOpenClawModelsJson(cfg);
    } catch {
      // Continue with best-effort discovery/overrides.
    }

    try {
      const { discoverAuthStorage, discoverModels } =
        await import("./pi-model-discovery-runtime.js");
      const agentDir = resolveOpenClawAgentDir();
      const authStorage = discoverAuthStorage(agentDir);
      const modelRegistry = discoverModels(authStorage, agentDir) as unknown as ModelRegistryLike;
      const models =
        typeof modelRegistry.getAvailable === "function"
          ? modelRegistry.getAvailable()
          : modelRegistry.getAll();
      applyDiscoveredContextWindows({
        cache: MODEL_CONTEXT_TOKEN_CACHE,
        models,
      });
    } catch {
      // If model discovery fails, continue with config overrides only.
    }

    applyConfiguredContextWindows({
      cache: MODEL_CONTEXT_TOKEN_CACHE,
      modelsConfig: cfg.models as ModelsConfig | undefined,
    });
  })().catch(() => {
    // Keep lookup best-effort.
  });
  return CONTEXT_WINDOW_RUNTIME_STATE.loadPromise;
}

export function lookupContextTokens(
  modelId?: string,
  options?: { allowAsyncLoad?: boolean },
): number | undefined {
  if (!modelId) {
    return undefined;
  }
  if (options?.allowAsyncLoad === false) {
    // Read-only callers still need synchronous config-backed overrides, but they
    // should not start background model discovery or models.json writes.
    primeConfiguredContextWindows();
  } else {
    // Best-effort: kick off loading on demand, but don't block lookups.
    void ensureContextWindowCacheLoaded();
  }
  return lookupCachedContextTokens(modelId);
}

if (shouldEagerWarmContextWindowCache()) {
  // Keep startup warmth for the real CLI, but avoid import-time side effects
  // when this module is pulled in through library/plugin-sdk surfaces.
  void ensureContextWindowCacheLoaded();
}

function resolveConfiguredModelParams(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
): Record<string, unknown> | undefined {
  const models = cfg?.agents?.defaults?.models;
  if (!models) {
    return undefined;
  }
  const key = normalizeLowercaseStringOrEmpty(`${provider}/${model}`);
  for (const [rawKey, entry] of Object.entries(models)) {
    if (normalizeLowercaseStringOrEmpty(rawKey) === key) {
      const params = (entry as AgentModelEntry | undefined)?.params;
      return params && typeof params === "object" ? params : undefined;
    }
  }
  return undefined;
}

function resolveProviderModelRef(params: {
  provider?: string;
  model?: string;
}): { provider: string; model: string } | undefined {
  const modelRaw = params.model?.trim();
  if (!modelRaw) {
    return undefined;
  }
  const providerRaw = params.provider?.trim();
  if (providerRaw) {
    const provider = normalizeProviderId(providerRaw);
    if (!provider) {
      return undefined;
    }
    return { provider, model: modelRaw };
  }
  const slash = modelRaw.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = normalizeProviderId(modelRaw.slice(0, slash));
  const model = modelRaw.slice(slash + 1).trim();
  if (!provider || !model) {
    return undefined;
  }
  return { provider, model };
}

// Look up an explicit runtime context cap for a specific provider+model
// directly from config, without going through the shared discovery cache.
// This avoids the cache keyspace collision where "provider/model" synthetic
// keys overlap with raw slash-containing model IDs (e.g. OpenRouter's
// "google/gemini-2.5-pro" stored as a raw catalog entry).
function resolveConfiguredProviderContextTokens(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
): number | undefined {
  const providers = (cfg?.models as ModelsConfig | undefined)?.providers;
  if (!providers) {
    return undefined;
  }

  // Mirror the lookup order in pi-embedded-runner/model.ts: exact key first,
  // then normalized fallback. This prevents alias collisions from picking the
  // wrong configured cap based on Object.entries iteration order.
  function findContextTokens(matchProviderId: (id: string) => boolean): number | undefined {
    for (const [providerId, providerConfig] of Object.entries(providers!)) {
      if (!matchProviderId(providerId)) {
        continue;
      }
      if (!Array.isArray(providerConfig?.models)) {
        continue;
      }
      for (const m of providerConfig.models) {
        const contextTokens =
          typeof m?.contextTokens === "number"
            ? m.contextTokens
            : typeof m?.contextWindow === "number"
              ? m.contextWindow
              : undefined;
        if (
          typeof m?.id === "string" &&
          m.id === model &&
          typeof contextTokens === "number" &&
          contextTokens > 0
        ) {
          return contextTokens;
        }
      }
    }
    return undefined;
  }

  // 1. Exact match (case-insensitive, no alias expansion).
  const exactResult = findContextTokens(
    (id) => normalizeLowercaseStringOrEmpty(id) === normalizeLowercaseStringOrEmpty(provider),
  );
  if (exactResult !== undefined) {
    return exactResult;
  }

  // 2. Normalized fallback: covers alias keys such as "z.ai" → "zai".
  const normalizedProvider = normalizeProviderId(provider);
  return findContextTokens((id) => normalizeProviderId(id) === normalizedProvider);
}

function isAnthropic1MModel(provider: string, model: string): boolean {
  if (provider !== "anthropic") {
    return false;
  }
  const modelId = resolveModelFamilyId(model);
  return ANTHROPIC_1M_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

function shouldUseAnthropicOpus47ContextWindow(params: {
  provider?: string;
  model: string;
}): boolean {
  const provider = params.provider ? normalizeProviderId(params.provider) : "";
  return (
    (provider === "anthropic" || provider === "claude-cli") && isClaudeOpus47Model(params.model)
  );
}

function shouldUseDiscoveredAnthropicOpus47ContextWindow(modelId: string): boolean {
  if (!isClaudeOpus47Model(modelId)) {
    return false;
  }
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  const slash = normalized.indexOf("/");
  if (slash < 0) {
    return false;
  }
  const provider = normalizeProviderId(normalized.slice(0, slash));
  return provider === "claude-cli";
}

function resolveModelFamilyId(modelId: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return normalized.includes("/") ? (normalized.split("/").at(-1) ?? normalized) : normalized;
}

function isClaudeOpus47Model(model: string): boolean {
  const modelId = resolveModelFamilyId(model);
  return CLAUDE_OPUS_47_MODEL_PREFIXES.some((prefix) => modelId.startsWith(prefix));
}

export function resolveContextTokensForModel(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  contextTokensOverride?: number;
  fallbackContextTokens?: number;
  allowAsyncLoad?: boolean;
}): number | undefined {
  if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) {
    return params.contextTokensOverride;
  }

  const ref = resolveProviderModelRef({
    provider: params.provider,
    model: params.model,
  });
  const explicitProvider = params.provider?.trim();
  if (ref) {
    const modelParams = resolveConfiguredModelParams(params.cfg, ref.provider, ref.model);
    if (modelParams?.context1m === true && isAnthropic1MModel(ref.provider, ref.model)) {
      return ANTHROPIC_CONTEXT_1M_TOKENS;
    }
    // Only do the config direct scan when the caller explicitly passed a
    // provider. When provider is inferred from a slash in the model string
    // (e.g. "google/gemini-2.5-pro" → ref.provider = "google"), the model ID
    // may belong to a DIFFERENT provider (e.g. an OpenRouter session). Scanning
    // cfg.models.providers.google in that case would return Google's configured
    // window and misreport context limits for the OpenRouter session.
    // See status.ts log-usage fallback which calls with only { model } set.
    if (explicitProvider) {
      const configuredWindow = resolveConfiguredProviderContextTokens(
        params.cfg,
        explicitProvider,
        ref.model,
      );
      if (configuredWindow !== undefined) {
        return configuredWindow;
      }
    }
  }

  if (explicitProvider && ref && shouldUseAnthropicOpus47ContextWindow(ref)) {
    return ANTHROPIC_CONTEXT_1M_TOKENS;
  }

  // When provider is explicitly given and the model ID is bare (no slash),
  // try the provider-qualified cache key BEFORE the bare key.  Discovery
  // entries are stored under qualified IDs (e.g. "google-gemini-cli/
  // gemini-3.1-pro-preview → 1M"), while the bare key may hold a cross-
  // provider minimum (128k).  Returning the qualified entry gives the correct
  // provider-specific window for /status and session context-token persistence.
  //
  // Guard: only when params.provider is explicit (not inferred from a slash in
  // the model string). For model-only callers (e.g. status.ts log-usage
  // fallback with model="google/gemini-2.5-pro"), the inferred provider would
  // construct "google/gemini-2.5-pro" as the qualified key which accidentally
  // matches OpenRouter's raw discovery entry — the bare lookup is correct there.
  if (params.provider && ref && !ref.model.includes("/")) {
    const qualifiedResult = lookupContextTokens(
      `${normalizeProviderId(ref.provider)}/${ref.model}`,
      { allowAsyncLoad: params.allowAsyncLoad },
    );
    if (qualifiedResult !== undefined) {
      return qualifiedResult;
    }
  }

  // Bare key fallback.  For model-only calls with slash-containing IDs
  // (e.g. "google/gemini-2.5-pro") this IS the raw discovery cache key.
  const bareResult = lookupContextTokens(params.model, {
    allowAsyncLoad: params.allowAsyncLoad,
  });
  if (bareResult !== undefined) {
    return bareResult;
  }

  // When provider is implicit, try qualified as a last resort so inferred
  // provider/model pairs (e.g. model="google-gemini-cli/gemini-3.1-pro")
  // still find discovery entries stored under that qualified ID.
  if (!params.provider && ref && !ref.model.includes("/")) {
    const qualifiedResult = lookupContextTokens(
      `${normalizeProviderId(ref.provider)}/${ref.model}`,
      { allowAsyncLoad: params.allowAsyncLoad },
    );
    if (qualifiedResult !== undefined) {
      return qualifiedResult;
    }
  }

  return params.fallbackContextTokens;
}
