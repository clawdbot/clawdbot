import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan.js";
import type { PluginManifestModelIdNormalizationProvider } from "./manifest.js";

let manifestModelIdNormalizationCache:
  | Map<string, PluginManifestModelIdNormalizationProvider>
  | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((entry) => normalizeTrimmedString(entry))
    .filter((entry): entry is string => entry !== undefined);
}

function normalizePrefixRules(
  value: unknown,
): PluginManifestModelIdNormalizationProvider["prefixWhenBareAfterAliasStartsWith"] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const rules: NonNullable<
    PluginManifestModelIdNormalizationProvider["prefixWhenBareAfterAliasStartsWith"]
  > = [];
  for (const rawRule of value) {
    if (!isRecord(rawRule)) {
      continue;
    }
    const modelPrefix = normalizeTrimmedString(rawRule.modelPrefix);
    const prefix = normalizeTrimmedString(rawRule.prefix);
    if (modelPrefix && prefix) {
      rules.push({ modelPrefix, prefix });
    }
  }
  return rules.length > 0 ? rules : undefined;
}

function normalizeModelIdNormalizationPolicy(
  value: unknown,
): PluginManifestModelIdNormalizationProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const aliases: Record<string, string> = {};
  if (isRecord(value.aliases)) {
    for (const [aliasRaw, canonicalRaw] of Object.entries(value.aliases)) {
      const alias = normalizeLowercaseStringOrEmpty(aliasRaw);
      const canonical = normalizeTrimmedString(canonicalRaw);
      if (alias && canonical) {
        aliases[alias] = canonical;
      }
    }
  }

  const stripPrefixes = normalizeStringList(value.stripPrefixes);
  const prefixWhenBare = normalizeTrimmedString(value.prefixWhenBare);
  const prefixWhenBareAfterAliasStartsWith = normalizePrefixRules(
    value.prefixWhenBareAfterAliasStartsWith,
  );
  const policy = {
    ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
    ...(stripPrefixes.length > 0 ? { stripPrefixes } : {}),
    ...(prefixWhenBare ? { prefixWhenBare } : {}),
    ...(prefixWhenBareAfterAliasStartsWith ? { prefixWhenBareAfterAliasStartsWith } : {}),
  } satisfies PluginManifestModelIdNormalizationProvider;

  return Object.keys(policy).length > 0 ? policy : undefined;
}

function readManifestModelIdNormalizationPolicies(
  manifest: Record<string, unknown>,
): Array<[string, PluginManifestModelIdNormalizationProvider]> {
  const modelIdNormalization = manifest.modelIdNormalization;
  if (!isRecord(modelIdNormalization) || !isRecord(modelIdNormalization.providers)) {
    return [];
  }

  const entries: Array<[string, PluginManifestModelIdNormalizationProvider]> = [];
  for (const [providerRaw, rawPolicy] of Object.entries(modelIdNormalization.providers)) {
    const provider = normalizeLowercaseStringOrEmpty(providerRaw);
    const policy = normalizeModelIdNormalizationPolicy(rawPolicy);
    if (provider && policy) {
      entries.push([provider, policy]);
    }
  }
  return entries;
}

function collectManifestModelIdNormalizationPolicies(): Map<
  string,
  PluginManifestModelIdNormalizationProvider
> {
  const policies = new Map<string, PluginManifestModelIdNormalizationProvider>();
  for (const { manifest } of listOpenClawPluginManifestMetadata()) {
    for (const [provider, policy] of readManifestModelIdNormalizationPolicies(manifest)) {
      policies.set(provider, policy);
    }
  }
  return policies;
}

function loadManifestModelIdNormalizationPolicies(): Map<
  string,
  PluginManifestModelIdNormalizationProvider
> {
  if (manifestModelIdNormalizationCache) {
    return manifestModelIdNormalizationCache;
  }

  const policies = collectManifestModelIdNormalizationPolicies();
  manifestModelIdNormalizationCache = policies;
  return policies;
}

function resolveManifestModelIdNormalizationPolicy(
  provider: string,
): PluginManifestModelIdNormalizationProvider | undefined {
  const providerId = normalizeLowercaseStringOrEmpty(provider);
  return loadManifestModelIdNormalizationPolicies().get(providerId);
}

function hasProviderPrefix(modelId: string): boolean {
  return modelId.includes("/");
}

function formatPrefixedModelId(prefix: string, modelId: string): string {
  return `${prefix.replace(/\/+$/u, "")}/${modelId.replace(/^\/+/u, "")}`;
}

export function normalizeProviderModelIdWithManifest(params: {
  provider: string;
  context: {
    provider: string;
    modelId: string;
  };
}): string | undefined {
  const policy = resolveManifestModelIdNormalizationPolicy(params.provider);
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

export function clearManifestModelIdNormalizationCacheForTest(): void {
  manifestModelIdNormalizationCache = undefined;
}
