// Model Catalog Core module implements provider model id normalization behavior.
import { normalizeLowercaseStringOrEmpty } from "./provider-id.js";
import {
  normalizeGooglePreviewModelId,
  normalizeTogetherModelId,
} from "./provider-model-id-normalize.js";

// Provider model-id normalization policies from manifests plus built-in provider rules.

/** Manifest-defined normalization rules for one provider. */
export type ManifestModelIdNormalizationProvider = {
  aliases?: Record<string, string>;
  stripPrefixes?: string[];
  prefixWhenBare?: string;
  prefixWhenBareAfterAliasStartsWith?: {
    modelPrefix: string;
    prefix: string;
  }[];
};

/** Manifest fragment that can define provider model-id normalization policies. */
export type ManifestModelIdNormalizationRecord = {
  modelIdNormalization?: {
    providers?: Record<string, ManifestModelIdNormalizationProvider>;
  };
};

let currentManifestModelIdNormalizationPolicies:
  | ReadonlyMap<string, ManifestModelIdNormalizationProvider>
  | undefined;

/** Collect provider model-id normalization policies from plugin manifests. */
export function collectManifestModelIdNormalizationPolicies(
  plugins: readonly ManifestModelIdNormalizationRecord[],
): Map<string, ManifestModelIdNormalizationProvider> {
  const policies = new Map<string, ManifestModelIdNormalizationProvider>();
  for (const plugin of plugins) {
    for (const [provider, policy] of Object.entries(plugin.modelIdNormalization?.providers ?? {})) {
      policies.set(normalizeLowercaseStringOrEmpty(provider), policy);
    }
  }
  return policies;
}

/** Replace the process-local manifest normalization policy snapshot. */
export function setCurrentManifestModelIdNormalizationRecords(
  plugins: readonly ManifestModelIdNormalizationRecord[] | undefined,
): void {
  currentManifestModelIdNormalizationPolicies = plugins
    ? collectManifestModelIdNormalizationPolicies(plugins)
    : undefined;
}

/** Return the current process-local manifest normalization policy snapshot. */
export function getCurrentManifestModelIdNormalizationPolicies():
  | ReadonlyMap<string, ManifestModelIdNormalizationProvider>
  | undefined {
  return currentManifestModelIdNormalizationPolicies;
}

/** Return true when a model id already includes a provider namespace. */
function hasProviderPrefix(modelId: string): boolean {
  return modelId.includes("/");
}

/** Join a provider prefix and model id with exactly one slash. */
function formatPrefixedModelId(prefix: string, modelId: string): string {
  return `${prefix.replace(/\/+$/u, "")}/${modelId.replace(/^\/+/u, "")}`;
}

/** Strip a duplicated self-provider prefix from a model id. */
export function stripSelfProviderModelPrefix(provider: string, model: string): string {
  const prefix = `${normalizeLowercaseStringOrEmpty(provider)}/`;
  const trimmed = model.trim();
  return normalizeLowercaseStringOrEmpty(trimmed).startsWith(prefix)
    ? trimmed.slice(prefix.length)
    : model;
}

/** Apply manifest normalization policies for one provider/model id. */
export function normalizeProviderModelIdWithPolicies(params: {
  provider: string;
  policies: ReadonlyMap<string, ManifestModelIdNormalizationProvider>;
  context: {
    modelId: string;
  };
}): string | undefined {
  const policy = params.policies.get(normalizeLowercaseStringOrEmpty(params.provider));
  if (!policy) {
    return undefined;
  }

  let modelId = params.context.modelId.trim();
  if (!modelId) {
    return modelId;
  }

  for (const prefix of policy.stripPrefixes ?? []) {
    const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
    if (normalizedPrefix && normalizeLowercaseStringOrEmpty(modelId).startsWith(normalizedPrefix)) {
      modelId = modelId.slice(prefix.length);
      break;
    }
  }

  modelId = policy.aliases?.[normalizeLowercaseStringOrEmpty(modelId)] ?? modelId;

  if (!hasProviderPrefix(modelId)) {
    for (const rule of policy.prefixWhenBareAfterAliasStartsWith ?? []) {
      if (normalizeLowercaseStringOrEmpty(modelId).startsWith(rule.modelPrefix.toLowerCase())) {
        return formatPrefixedModelId(rule.prefix, modelId);
      }
    }
    if (policy.prefixWhenBare) {
      return formatPrefixedModelId(policy.prefixWhenBare, modelId);
    }
  }

  return modelId;
}

/** Apply built-in provider-specific model id normalization rules. */
export function normalizeBuiltInProviderModelId(provider: string, model: string): string {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  if (
    normalizedProvider === "google" ||
    normalizedProvider === "google-gemini-cli" ||
    normalizedProvider === "google-vertex"
  ) {
    return normalizeGooglePreviewModelId(model);
  }
  if (normalizedProvider === "openrouter") {
    const trimmed = model.trim();
    return trimmed && !trimmed.includes("/") ? `openrouter/${trimmed}` : model;
  }
  if (normalizedProvider === "anthropic") {
    const anthropicAliases: Record<string, string> = {
      "opus-4.8": "claude-opus-4-8",
      opus: "claude-opus-4-8",
      "opus-4.6": "claude-opus-4-6",
      "sonnet-4.6": "claude-sonnet-4-6",
    };
    const anthropicPrefix = "anthropic/";
    const normalizedModel = normalizeLowercaseStringOrEmpty(model);
    const providerModel = normalizedModel.startsWith(anthropicPrefix)
      ? model.trim().slice(anthropicPrefix.length)
      : model;
    return anthropicAliases[normalizeLowercaseStringOrEmpty(providerModel)] ?? providerModel;
  }
  if (normalizedProvider === "vercel-ai-gateway") {
    const vercelAliases: Record<string, string> = {
      "opus-4.6": "claude-opus-4-6",
      "sonnet-4.6": "claude-sonnet-4-6",
    };
    const aliased = vercelAliases[normalizeLowercaseStringOrEmpty(model)] ?? model;
    return normalizeLowercaseStringOrEmpty(aliased).startsWith("claude-")
      ? `anthropic/${aliased}`
      : aliased;
  }
  if (normalizedProvider === "huggingface") {
    const prefix = "huggingface/";
    return normalizeLowercaseStringOrEmpty(model).startsWith(prefix)
      ? model.slice(prefix.length)
      : model;
  }
  if (normalizedProvider === "nvidia") {
    const trimmed = model.trim();
    return trimmed && !trimmed.includes("/") ? `nvidia/${trimmed}` : model;
  }
  if (normalizedProvider === "xai") {
    const xaiAliases: Record<string, string> = {
      "grok-4-fast-reasoning": "grok-4-fast",
      "grok-4-1-fast-reasoning": "grok-4-1-fast",
      "grok-4.20-experimental-beta-0304-reasoning": "grok-4.20-beta-latest-reasoning",
      "grok-4.20-experimental-beta-0304-non-reasoning": "grok-4.20-beta-latest-non-reasoning",
      "grok-4.20-reasoning": "grok-4.20-beta-latest-reasoning",
      "grok-4.20-non-reasoning": "grok-4.20-beta-latest-non-reasoning",
    };
    return xaiAliases[normalizeLowercaseStringOrEmpty(model)] ?? model;
  }
  if (normalizedProvider === "openai") {
    return model;
  }
  if (normalizedProvider === "together") {
    return normalizeTogetherModelId(model);
  }
  return model;
}

/** Apply manifest policies and built-in normalization to a static provider/model id. */
export function normalizeStaticProviderModelIdWithPolicies(
  provider: string,
  model: string,
  policies?: ReadonlyMap<string, ManifestModelIdNormalizationProvider>,
): string {
  const normalizedProvider = normalizeLowercaseStringOrEmpty(provider);
  const manifestModelId = policies
    ? (normalizeProviderModelIdWithPolicies({
        provider: normalizedProvider,
        policies,
        context: {
          modelId: model,
        },
      }) ?? model)
    : model;
  return normalizeBuiltInProviderModelId(normalizedProvider, manifestModelId);
}

/** Normalize a configured provider/model catalog reference using current policies. */
export function normalizeConfiguredProviderCatalogModelId(
  provider: string,
  model: string,
  policies = getCurrentManifestModelIdNormalizationPolicies(),
): string {
  const providerModel = normalizeStaticProviderModelIdWithPolicies(provider, model, policies);
  return normalizeConfiguredProviderCatalogModelRef(providerModel);
}

/** Normalize embedded Google model aliases inside provider/model catalog refs. */
export function normalizeConfiguredProviderCatalogModelRef(providerModel: string): string {
  const googlePrefix = "google/";
  if (!providerModel.startsWith(googlePrefix)) {
    const slash = providerModel.indexOf("/");
    if (slash <= 0 || slash >= providerModel.length - 1) {
      return providerModel;
    }
    const prefix = providerModel.slice(0, slash + 1);
    const suffix = providerModel.slice(slash + 1);
    if (!suffix.startsWith(googlePrefix)) {
      return providerModel;
    }
    const normalizedSuffix = normalizeGooglePreviewModelId(suffix);
    return normalizedSuffix === suffix ? providerModel : `${prefix}${normalizedSuffix}`;
  }
  const modelId = providerModel.slice(googlePrefix.length);
  const normalizedModelId = normalizeGooglePreviewModelId(modelId);
  return normalizedModelId === modelId ? providerModel : `${googlePrefix}${normalizedModelId}`;
}
