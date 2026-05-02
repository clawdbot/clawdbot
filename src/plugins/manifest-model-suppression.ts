import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildModelCatalogMergeKey,
  planManifestModelCatalogSuppressions,
  type ManifestModelCatalogSuppressionEntry,
} from "../model-catalog/index.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "./manifest-contract-eligibility.js";

function listManifestModelCatalogSuppressions(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): readonly ManifestModelCatalogSuppressionEntry[] {
  const snapshot = loadManifestMetadataSnapshot({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const registry = {
    diagnostics: snapshot.diagnostics,
    plugins: snapshot.plugins.filter((plugin) =>
      isManifestPluginAvailableForControlPlane({
        snapshot,
        plugin,
        config: params.config,
      }),
    ),
  };
  const planned = planManifestModelCatalogSuppressions({ registry });
  return planned.suppressions;
}

function buildManifestSuppressionError(params: {
  provider: string;
  modelId: string;
  reason?: string;
}): string {
  const ref = `${params.provider}/${params.modelId}`;
  return params.reason ? `Unknown model: ${ref}. ${params.reason}` : `Unknown model: ${ref}.`;
}

function normalizeBaseUrlHost(baseUrl: string | null | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return normalizeSuppressionHost(new URL(trimmed).hostname);
  } catch {
    return "";
  }
}

function normalizeSuppressionHost(host: string): string {
  return normalizeLowercaseStringOrEmpty(host).replace(/\.+$/, "");
}

function resolveConfiguredProviderValue(params: {
  provider: string;
  config?: OpenClawConfig;
}): { api?: string; baseUrl?: string } | undefined {
  const providers = params.config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  for (const [providerId, entry] of Object.entries(providers)) {
    if (normalizeLowercaseStringOrEmpty(providerId) !== params.provider) {
      continue;
    }
    return {
      api: normalizeLowercaseStringOrEmpty(entry?.api),
      baseUrl: typeof entry?.baseUrl === "string" ? entry.baseUrl : undefined,
    };
  }
  return undefined;
}

function manifestSuppressionMatchesConditions(params: {
  suppression: ManifestModelCatalogSuppressionEntry;
  provider: string;
  baseUrl?: string | null;
  config?: OpenClawConfig;
}): boolean {
  const when = params.suppression.when;
  if (!when) {
    return true;
  }
  const configuredProvider = resolveConfiguredProviderValue({
    provider: params.provider,
    config: params.config,
  });
  if (when.providerConfigApiIn?.length && configuredProvider?.api) {
    const allowedApis = new Set(when.providerConfigApiIn.map(normalizeLowercaseStringOrEmpty));
    if (!allowedApis.has(configuredProvider.api)) {
      return false;
    }
  }
  if (when.baseUrlHosts?.length) {
    const baseUrlHost = normalizeBaseUrlHost(params.baseUrl ?? configuredProvider?.baseUrl);
    if (!baseUrlHost) {
      return false;
    }
    const allowedHosts = new Set(when.baseUrlHosts.map(normalizeSuppressionHost));
    if (!allowedHosts.has(baseUrlHost)) {
      return false;
    }
  }
  return true;
}

export function buildManifestBuiltInModelSuppressionResolver(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const suppressions = listManifestModelCatalogSuppressions({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env ?? process.env,
  });

  return (input: {
    provider?: string | null;
    id?: string | null;
    baseUrl?: string | null;
    unconditionalOnly?: boolean;
  }) => {
    const provider = normalizeLowercaseStringOrEmpty(input.provider);
    const modelId = normalizeLowercaseStringOrEmpty(input.id);
    if (!provider || !modelId) {
      return undefined;
    }
    const mergeKey = buildModelCatalogMergeKey(provider, modelId);
    const suppression = suppressions.find(
      (entry) =>
        entry.mergeKey === mergeKey &&
        (!input.unconditionalOnly || !entry.when) &&
        manifestSuppressionMatchesConditions({
          suppression: entry,
          provider,
          baseUrl: input.baseUrl,
          config: params.config,
        }),
    );
    if (!suppression) {
      return undefined;
    }
    return {
      suppress: true,
      errorMessage: buildManifestSuppressionError({
        provider,
        modelId,
        reason: suppression.reason,
      }),
    };
  };
}

/**
 * Resolves whether a built-in model should be suppressed based on manifest declarations.
 *
 * Note: This function instantiates a fresh resolver on every call, which incurs a full
 * filesystem scan of the manifest registry. For hot paths (like building the model catalog),
 * instantiate and reuse `buildManifestBuiltInModelSuppressionResolver` instead.
 */
export function resolveManifestBuiltInModelSuppression(params: {
  provider?: string | null;
  id?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  baseUrl?: string | null;
  unconditionalOnly?: boolean;
}) {
  const resolver = buildManifestBuiltInModelSuppressionResolver({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return resolver({
    provider: params.provider,
    id: params.id,
    baseUrl: params.baseUrl,
    unconditionalOnly: params.unconditionalOnly,
  });
}
