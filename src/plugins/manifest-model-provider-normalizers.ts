import { normalizeModelCatalogProviderId } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeTrimmedStringList } from "../../packages/normalization-core/src/string-normalization.js";
import { ENV_SECRET_REF_ID_RE } from "../config/types.secrets.js";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";
import { isRecord } from "../utils.js";
import { normalizeStringRecord } from "./manifest-capability-normalizers.js";
import type {
  PluginManifestModelIdNormalization,
  PluginManifestModelIdNormalizationProvider,
  PluginManifestModelIdPrefixRule,
  PluginManifestModelPricing,
  PluginManifestModelPricingModelIdTransform,
  PluginManifestModelPricingProvider,
  PluginManifestModelPricingSource,
  PluginManifestModelSupport,
  PluginManifestProviderEndpoint,
  PluginManifestProviderRequest,
  PluginManifestProviderRequestProvider,
  PluginManifestSecretProviderIntegration,
} from "./manifest-types.js";

const MAX_SECRET_PROVIDER_EXEC_ARGS = 128;
const MAX_SECRET_PROVIDER_EXEC_ARG_BYTES = 1024;
const MAX_SECRET_PROVIDER_EXEC_TIMEOUT_MS = 120_000;
const MAX_SECRET_PROVIDER_EXEC_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_SECRET_PROVIDER_EXEC_PASS_ENV = 128;
const SECRET_PROVIDER_NODE_COMMAND_PLACEHOLDER = "${node}";

export function normalizeManifestModelSupport(
  value: unknown,
): PluginManifestModelSupport | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const modelPrefixes = normalizeTrimmedStringList(value.modelPrefixes);
  const modelPatterns = normalizeTrimmedStringList(value.modelPatterns);
  const modelSupport = {
    ...(modelPrefixes.length > 0 ? { modelPrefixes } : {}),
    ...(modelPatterns.length > 0 ? { modelPatterns } : {}),
  } satisfies PluginManifestModelSupport;

  return Object.keys(modelSupport).length > 0 ? modelSupport : undefined;
}

function normalizeManifestModelPricingSource(
  value: unknown,
): PluginManifestModelPricingSource | false | undefined {
  if (value === false) {
    return false;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const provider = normalizeModelCatalogProviderId(normalizeOptionalString(value.provider) ?? "");
  const modelIdTransforms = normalizeTrimmedStringList(value.modelIdTransforms).filter(
    (entry): entry is PluginManifestModelPricingModelIdTransform => entry === "version-dots",
  );
  const source = {
    ...(provider ? { provider } : {}),
    ...(value.passthroughProviderModel === true ? { passthroughProviderModel: true } : {}),
    ...(modelIdTransforms.length > 0 ? { modelIdTransforms } : {}),
  } satisfies PluginManifestModelPricingSource;
  return Object.keys(source).length > 0 ? source : undefined;
}

function normalizeManifestModelPricingProvider(
  value: unknown,
): PluginManifestModelPricingProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const openRouter = normalizeManifestModelPricingSource(value.openRouter);
  const liteLLM = normalizeManifestModelPricingSource(value.liteLLM);
  const policy = {
    ...(typeof value.external === "boolean" ? { external: value.external } : {}),
    ...(openRouter !== undefined ? { openRouter } : {}),
    ...(liteLLM !== undefined ? { liteLLM } : {}),
  } satisfies PluginManifestModelPricingProvider;
  return Object.keys(policy).length > 0 ? policy : undefined;
}

function normalizeOwnedProviderMap<T>(
  value: unknown,
  ownedProvidersRaw: ReadonlySet<string>,
  normalizePolicy: (value: unknown) => T | undefined,
): Record<string, T> | undefined {
  if (!isRecord(value) || !isRecord(value.providers)) {
    return undefined;
  }
  const ownedProviders = new Set(
    [...ownedProvidersRaw]
      .map((provider) => normalizeModelCatalogProviderId(provider))
      .filter(Boolean),
  );
  const providers: Record<string, T> = {};
  for (const [rawProviderId, rawPolicy] of Object.entries(value.providers)) {
    const providerId = normalizeModelCatalogProviderId(rawProviderId);
    const policy = providerId && ownedProviders.has(providerId) ? normalizePolicy(rawPolicy) : null;
    if (providerId && policy) {
      providers[providerId] = policy;
    }
  }
  return Object.keys(providers).length > 0 ? providers : undefined;
}

export function normalizeManifestModelPricing(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): PluginManifestModelPricing | undefined {
  const providers = normalizeOwnedProviderMap(
    value,
    params.ownedProviders,
    normalizeManifestModelPricingProvider,
  );
  return providers ? { providers } : undefined;
}

function normalizeManifestModelIdPrefixRules(
  value: unknown,
): PluginManifestModelIdPrefixRule[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const rules: PluginManifestModelIdPrefixRule[] = [];
  for (const rawRule of value) {
    if (!isRecord(rawRule)) {
      continue;
    }
    const modelPrefix = normalizeOptionalString(rawRule.modelPrefix);
    const prefix = normalizeOptionalString(rawRule.prefix);
    if (!modelPrefix || !prefix) {
      continue;
    }
    rules.push({ modelPrefix, prefix });
  }
  return rules.length > 0 ? rules : undefined;
}

function normalizeManifestModelIdNormalizationProvider(
  value: unknown,
): PluginManifestModelIdNormalizationProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const aliases: Record<string, string> = {};
  if (isRecord(value.aliases)) {
    for (const [rawAlias, rawCanonical] of Object.entries(value.aliases)) {
      const alias = normalizeModelCatalogProviderId(rawAlias);
      const canonical = normalizeOptionalString(rawCanonical);
      if (alias && canonical) {
        aliases[alias] = canonical;
      }
    }
  }
  const stripPrefixes = normalizeTrimmedStringList(value.stripPrefixes);
  const prefixWhenBare = normalizeOptionalString(value.prefixWhenBare);
  const prefixWhenBareAfterAliasStartsWith = normalizeManifestModelIdPrefixRules(
    value.prefixWhenBareAfterAliasStartsWith,
  );
  const normalization = {
    ...(Object.keys(aliases).length > 0 ? { aliases } : {}),
    ...(stripPrefixes.length > 0 ? { stripPrefixes } : {}),
    ...(prefixWhenBare ? { prefixWhenBare } : {}),
    ...(prefixWhenBareAfterAliasStartsWith ? { prefixWhenBareAfterAliasStartsWith } : {}),
  } satisfies PluginManifestModelIdNormalizationProvider;

  return Object.keys(normalization).length > 0 ? normalization : undefined;
}

export function normalizeManifestModelIdNormalization(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): PluginManifestModelIdNormalization | undefined {
  const providers = normalizeOwnedProviderMap(
    value,
    params.ownedProviders,
    normalizeManifestModelIdNormalizationProvider,
  );
  return providers ? { providers } : undefined;
}

export function normalizeManifestProviderEndpoints(
  value: unknown,
): PluginManifestProviderEndpoint[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const endpoints: PluginManifestProviderEndpoint[] = [];
  for (const rawEndpoint of value) {
    if (!isRecord(rawEndpoint)) {
      continue;
    }
    const endpointClass = normalizeOptionalString(rawEndpoint.endpointClass);
    if (!endpointClass) {
      continue;
    }
    const hosts = normalizeTrimmedStringList(rawEndpoint.hosts).map((host) => host.toLowerCase());
    const hostSuffixes = normalizeTrimmedStringList(rawEndpoint.hostSuffixes).map((host) =>
      host.toLowerCase(),
    );
    const baseUrls = normalizeTrimmedStringList(rawEndpoint.baseUrls);
    const googleVertexRegion = normalizeOptionalString(rawEndpoint.googleVertexRegion);
    const googleVertexRegionHostSuffix = normalizeOptionalString(
      rawEndpoint.googleVertexRegionHostSuffix,
    )?.toLowerCase();
    if (hosts.length === 0 && hostSuffixes.length === 0 && baseUrls.length === 0) {
      continue;
    }
    endpoints.push({
      endpointClass,
      ...(hosts.length > 0 ? { hosts } : {}),
      ...(hostSuffixes.length > 0 ? { hostSuffixes } : {}),
      ...(baseUrls.length > 0 ? { baseUrls } : {}),
      ...(googleVertexRegion ? { googleVertexRegion } : {}),
      ...(googleVertexRegionHostSuffix ? { googleVertexRegionHostSuffix } : {}),
    });
  }

  return endpoints.length > 0 ? endpoints : undefined;
}

function normalizeManifestProviderRequestProvider(
  value: unknown,
): PluginManifestProviderRequestProvider | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const family = normalizeOptionalString(value.family);
  const compatibilityFamily =
    normalizeOptionalString(value.compatibilityFamily) === "moonshot" ? "moonshot" : undefined;
  const supportsStreamingUsage = isRecord(value.openAICompletions)
    ? value.openAICompletions.supportsStreamingUsage
    : undefined;
  const openAICompletions =
    typeof supportsStreamingUsage === "boolean" ? { supportsStreamingUsage } : undefined;
  const providerRequest = {
    ...(family ? { family } : {}),
    ...(compatibilityFamily ? { compatibilityFamily } : {}),
    ...(openAICompletions && Object.keys(openAICompletions).length > 0
      ? { openAICompletions }
      : {}),
  } satisfies PluginManifestProviderRequestProvider;
  return Object.keys(providerRequest).length > 0 ? providerRequest : undefined;
}

export function normalizeManifestProviderRequest(
  value: unknown,
  params: { ownedProviders: ReadonlySet<string> },
): PluginManifestProviderRequest | undefined {
  const providers = normalizeOwnedProviderMap(
    value,
    params.ownedProviders,
    normalizeManifestProviderRequestProvider,
  );
  return providers ? { providers } : undefined;
}

function normalizeManifestStringArray(
  value: unknown,
  options?: { maxItems?: number; maxLength?: number; pattern?: RegExp },
): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      continue;
    }
    if (options?.maxLength !== undefined && entry.length > options.maxLength) {
      continue;
    }
    if (options?.pattern && !options.pattern.test(entry)) {
      continue;
    }
    normalized.push(entry);
    if (options?.maxItems !== undefined && normalized.length >= options.maxItems) {
      break;
    }
  }
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeManifestTrimmedStringArray(
  value: unknown,
  options?: { maxItems?: number; pattern?: RegExp },
): string[] | undefined {
  const normalized = normalizeTrimmedStringList(value).filter(
    (entry) => !options?.pattern || options.pattern.test(entry),
  );
  const limited =
    options?.maxItems !== undefined ? normalized.slice(0, options.maxItems) : normalized;
  return limited.length > 0 ? limited : undefined;
}

function normalizeManifestPositiveInteger(value: unknown, max: number): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 && value <= max
    ? value
    : undefined;
}

export function normalizeManifestSecretProviderIntegrations(
  value: unknown,
): Record<string, PluginManifestSecretProviderIntegration> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const normalized: Record<string, PluginManifestSecretProviderIntegration> = Object.create(null);
  for (const [rawId, rawIntegration] of Object.entries(value)) {
    const id = normalizeOptionalString(rawId) ?? "";
    if (!id || isBlockedObjectKey(id) || !isRecord(rawIntegration)) {
      continue;
    }
    const command = normalizeOptionalString(rawIntegration.command);
    if (rawIntegration.source !== "exec" || command !== SECRET_PROVIDER_NODE_COMMAND_PLACEHOLDER) {
      continue;
    }
    const providerAlias = normalizeOptionalString(rawIntegration.providerAlias);
    const displayName = normalizeOptionalString(rawIntegration.displayName);
    const description = normalizeOptionalString(rawIntegration.description);
    const args = normalizeManifestStringArray(rawIntegration.args, {
      maxItems: MAX_SECRET_PROVIDER_EXEC_ARGS,
      maxLength: MAX_SECRET_PROVIDER_EXEC_ARG_BYTES,
    });
    const timeoutMs = normalizeManifestPositiveInteger(
      rawIntegration.timeoutMs,
      MAX_SECRET_PROVIDER_EXEC_TIMEOUT_MS,
    );
    const noOutputTimeoutMs = normalizeManifestPositiveInteger(
      rawIntegration.noOutputTimeoutMs,
      MAX_SECRET_PROVIDER_EXEC_TIMEOUT_MS,
    );
    const maxOutputBytes = normalizeManifestPositiveInteger(
      rawIntegration.maxOutputBytes,
      MAX_SECRET_PROVIDER_EXEC_OUTPUT_BYTES,
    );
    const env = normalizeStringRecord(rawIntegration.env);
    const passEnv = normalizeManifestTrimmedStringArray(rawIntegration.passEnv, {
      maxItems: MAX_SECRET_PROVIDER_EXEC_PASS_ENV,
      pattern: ENV_SECRET_REF_ID_RE,
    });
    normalized[id] = {
      ...(providerAlias ? { providerAlias } : {}),
      ...(displayName ? { displayName } : {}),
      ...(description ? { description } : {}),
      source: "exec",
      command,
      ...(args ? { args } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(noOutputTimeoutMs !== undefined ? { noOutputTimeoutMs } : {}),
      ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}),
      ...(typeof rawIntegration.jsonOnly === "boolean"
        ? { jsonOnly: rawIntegration.jsonOnly }
        : {}),
      ...(env ? { env } : {}),
      ...(passEnv ? { passEnv } : {}),
      ...(rawIntegration.allowInsecurePath === true ? { allowInsecurePath: true } : {}),
    };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
