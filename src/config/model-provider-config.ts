import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { stripSelfProviderModelPrefix } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { asOptionalRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import type { ProviderRouteOverridePresence } from "../plugin-sdk/provider-model-types.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "./types.models.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type MergedModelProviderEntry = {
  providerKey: string;
  providerConfig: ModelProviderConfig;
};

export function matchesProviderScopedModelId(params: {
  candidateId?: string;
  provider: string;
  modelId: string;
  normalizeModelId?: (modelId: string) => string;
}): boolean {
  const { candidateId, provider, modelId } = params;
  if (candidateId === modelId) {
    return true;
  }
  const slashIndex = candidateId?.indexOf("/") ?? -1;
  if (!candidateId) {
    return false;
  }
  if (
    slashIndex > 0 &&
    candidateId.slice(slashIndex + 1) === modelId &&
    normalizeProviderId(candidateId.slice(0, slashIndex)) === normalizeProviderId(provider)
  ) {
    return true;
  }
  return params.normalizeModelId
    ? params.normalizeModelId(stripSelfProviderModelPrefix(provider, candidateId)) ===
        params.normalizeModelId(stripSelfProviderModelPrefix(provider, modelId))
    : false;
}

/** Uses the same authored row for transport materialization and early auth selection. */
export function findConfiguredProviderModel(
  providerConfig: { models?: ModelDefinitionConfig[] } | undefined,
  provider: string,
  modelId: string,
  canonicalizeModelId?: (modelId: string) => string,
) {
  const exact = providerConfig?.models?.find((candidate) =>
    matchesProviderScopedModelId({ candidateId: candidate.id, provider, modelId }),
  );
  return (
    exact ??
    (canonicalizeModelId
      ? providerConfig?.models?.find((candidate) =>
          matchesProviderScopedModelId({
            candidateId: candidate.id,
            provider,
            modelId,
            normalizeModelId: canonicalizeModelId,
          }),
        )
      : undefined)
  );
}

const BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS = new Set([
  "amazon-bedrock",
  "amazon-bedrock-mantle",
  "anthropic",
  "anthropic-vertex",
  "arcee",
  "azure-openai-responses",
  "byteplus",
  "byteplus-plan",
  "cerebras",
  "chutes",
  "claude-cli",
  "clawrouter",
  "cloudflare-ai-gateway",
  "codex",
  "comfy",
  "copilot-proxy",
  "dashscope",
  "deepinfra",
  "deepseek",
  "fal",
  "fireworks",
  "github-copilot",
  "gmi",
  "gmi-cloud",
  "gmicloud",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "huggingface",
  "kilocode",
  "kimi",
  "kimi-coding",
  "litellm",
  "lmstudio",
  "meta",
  "microsoft-foundry",
  "minimax",
  "minimax-portal",
  "mistral",
  "modelstudio",
  "moonshot",
  "moonshot-ai",
  "moonshotai",
  "nvidia",
  "novita",
  "novita-ai",
  "novitaai",
  "ollama",
  "ollama-cloud",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "qianfan",
  "qwen",
  "qwen-token-plan",
  "qwencloud",
  "sglang",
  "stepfun",
  "stepfun-plan",
  "synthetic",
  "tencent-tokenhub",
  "tencent-tokenplan",
  "together",
  "venice",
  "vercel-ai-gateway",
  "vllm",
  "volcengine",
  "volcengine-plan",
  "vydra",
  "x-ai",
  "xai",
  "xiaomi",
  "xiaomi-token-plan",
  "z.ai",
  "z-ai",
  "zai",
]);

/** Identifies provider overlays already known to the bundled config contract. */
export function isBuiltInModelProviderOverlayId(providerId: string): boolean {
  return BUILT_IN_MODEL_PROVIDER_OVERLAY_IDS.has(normalizeProviderId(providerId));
}

/** Indexes configured model rows after caller-owned model-id normalization. */
export function resolveMergedModelProviderModels(params: {
  models: readonly ModelDefinitionConfig[] | undefined;
  normalizeModelId: (modelId: string) => string | undefined;
}): ReadonlyMap<string, ModelDefinitionConfig> {
  const models = new Map<string, ModelDefinitionConfig>();
  for (const model of params.models ?? []) {
    const modelId = params.normalizeModelId(model.id);
    if (!modelId) {
      continue;
    }
    const existing = models.get(modelId);
    // Earlier rows stay authoritative, including explicit empty objects;
    // later duplicates only supply top-level fields the first row omitted.
    models.set(modelId, existing ? { ...model, ...existing } : model);
  }
  return models;
}

function normalizeModelId(provider: string, modelId: string): string {
  const trimmed = modelId.trim();
  const slashIndex = trimmed.indexOf("/");
  return slashIndex > 0 &&
    normalizeProviderId(trimmed.slice(0, slashIndex)) === normalizeProviderId(provider)
    ? trimmed.slice(slashIndex + 1).trim()
    : trimmed;
}

function hasNonEmptyRecord(value: unknown): boolean {
  const record = readRecord(value);
  return record !== undefined && Object.keys(record).length > 0;
}

function hasRequestCompatOverrides(compat: ModelDefinitionConfig["compat"]): boolean {
  return Object.entries(compat ?? {}).some(([key, value]) => {
    // Native runtimes consume affirmative reasoning capabilities as turn controls.
    // Disabling reasoning, custom labels, and payload shaping still require the authored adapter.
    if (key === "supportsReasoningEffort") {
      return value !== true;
    }
    if (key === "supportedReasoningEfforts") {
      return !(
        Array.isArray(value) &&
        value.length > 0 &&
        value.every(
          (effort) =>
            typeof effort === "string" &&
            /^(minimal|low|medium|high|xhigh|max|ultra)$/u.test(effort),
        )
      );
    }
    return true;
  });
}

/** Prepares row lookups within one stable authored config view. */
export function createModelProviderRouteOverrideResolver(params: {
  provider: string;
  authoredConfig?: OpenClawConfig;
  canonicalizeModelId?: (modelId: string) => string;
}): (modelId?: string) => ProviderRouteOverridePresence {
  const providerConfig = resolveMergedModelProviderConfig(params.authoredConfig, params.provider);
  if (!providerConfig) {
    return () => "none";
  }
  if (
    readRecord(providerConfig.localService) !== undefined ||
    hasNonEmptyRecord(providerConfig.headers) ||
    hasNonEmptyRecord(providerConfig.request) ||
    hasNonEmptyRecord(providerConfig.params) ||
    typeof providerConfig.authHeader === "boolean" ||
    typeof providerConfig.timeoutSeconds === "number"
  ) {
    return () => "present";
  }
  const canonicalize = (modelId: string) => {
    const normalized = normalizeModelId(params.provider, modelId);
    const canonical = params.canonicalizeModelId?.(normalized).trim();
    return canonical || normalized;
  };
  let configuredModels: ReadonlyMap<string, ModelDefinitionConfig> | undefined;
  return (modelId) => {
    if (!modelId) {
      return "none";
    }
    // Keep provider-only queries lazy and normalize the query before the first row pass.
    const canonicalModelId = canonicalize(modelId);
    const configuredModel = (configuredModels ??= resolveMergedModelProviderModels({
      models: providerConfig.models,
      normalizeModelId: canonicalize,
    })).get(canonicalModelId);
    return configuredModel &&
      (hasNonEmptyRecord(configuredModel.headers) ||
        hasNonEmptyRecord(configuredModel.params) ||
        hasRequestCompatOverrides(configuredModel.compat))
      ? "present"
      : "none";
  };
}

/** Resolves the provider entry produced by models-config key normalization. */
export function resolveMergedModelProviderEntry(
  config: OpenClawConfig | undefined,
  provider: string,
): MergedModelProviderEntry | undefined {
  const requestedProvider = provider.trim();
  const normalizedProvider = normalizeProviderId(requestedProvider);
  if (!normalizedProvider) {
    return undefined;
  }
  const providers = Object.entries(config?.models?.providers ?? {});
  // normalizeProviders trims keys but does not lowercase them. Preserve its
  // exact-key precedence, then use the existing case-insensitive fallback.
  const exactKey = providers.find(([providerId]) => providerId.trim() === requestedProvider)?.[0];
  const fallbackKey = providers.find(
    ([providerId]) => normalizeProviderId(providerId) === normalizedProvider,
  )?.[0];
  const providerKey = (exactKey ?? fallbackKey)?.trim();
  if (!providerKey) {
    return undefined;
  }
  let matched: ModelProviderConfig | undefined;
  for (const [providerId, providerConfig] of providers) {
    if (providerId.trim() !== providerKey) {
      continue;
    }
    // Match normalizeProviders: later fields win, while omitted model rows keep
    // the earlier catalog instead of erasing it from route/auth decisions.
    matched = matched
      ? {
          ...matched,
          ...providerConfig,
          models: providerConfig.models ?? matched.models,
        }
      : providerConfig;
  }
  return matched ? { providerKey, providerConfig: matched } : undefined;
}

/** Resolves only the merged provider config when its canonical key is not needed. */
export function resolveMergedModelProviderConfig(
  config: OpenClawConfig | undefined,
  provider: string,
): ModelProviderConfig | undefined {
  return resolveMergedModelProviderEntry(config, provider)?.providerConfig;
}

/** Projects a resolved request onto one transient canonical provider entry. */
export function projectModelProviderConfig(
  config: OpenClawConfig | undefined,
  providerId: string,
  overrides: Pick<ModelProviderConfig, "baseUrl"> &
    Partial<Pick<ModelProviderConfig, "api" | "auth">>,
): OpenClawConfig {
  const provider = normalizeProviderId(providerId);
  const entry = resolveMergedModelProviderEntry(config, provider);
  const providerKey = entry?.providerKey ?? provider;
  const providers = Object.fromEntries(
    Object.entries(config?.models?.providers ?? {}).filter(
      ([candidate]) => normalizeProviderId(candidate) !== provider || candidate === providerKey,
    ),
  );
  return {
    ...config,
    models: {
      ...config?.models,
      providers: {
        ...providers,
        [providerKey]: { ...(entry?.providerConfig ?? { models: [] }), ...overrides },
      },
    },
  };
}
