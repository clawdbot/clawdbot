import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { isRecord } from "../utils.js";
import {
  mergeProviders,
  mergeWithExistingProviderSecrets,
  type ExistingProviderConfig,
} from "./models-config.merge.js";
import {
  applyNativeStreamingUsageCompat,
  enforceSourceManagedProviderSecrets,
  normalizeProviderCatalogModelsForConfig,
  normalizeProviders,
  resolveImplicitProviders,
  type ProviderConfig,
} from "./models-config.providers.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  resolvePluginModelCatalogOwnerPluginId,
} from "./plugin-model-catalog.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
export type ResolveImplicitProvidersForModelsJson = (params: {
  agentDir: string;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
  explicitProviders: Record<string, ProviderConfig>;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
}) => Promise<Record<string, ProviderConfig>>;

export type ModelsJsonPlan =
  | {
      action: "skip";
      pluginCatalogWrites?: Record<string, string>;
    }
  | {
      action: "noop";
      pluginCatalogWrites?: Record<string, string>;
    }
  | {
      action: "write";
      contents: string;
      pluginCatalogWrites?: Record<string, string>;
    };

function splitProvidersByPluginOwner(params: {
  providers: Record<string, ProviderConfig>;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "owners">;
}): {
  rootProviders: Record<string, ProviderConfig>;
  pluginProviders: Record<string, Record<string, ProviderConfig>>;
} {
  const rootProviders: Record<string, ProviderConfig> = {};
  const pluginProviders: Record<string, Record<string, ProviderConfig>> = {};
  for (const [providerId, provider] of Object.entries(params.providers)) {
    const pluginId = resolvePluginModelCatalogOwnerPluginId({
      providerId,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    });
    if (!pluginId) {
      rootProviders[providerId] = provider;
      continue;
    }
    const pluginCatalog = (pluginProviders[pluginId] ??= {});
    pluginCatalog[providerId] = provider;
  }
  return { rootProviders, pluginProviders };
}

function buildPluginCatalogWrites(
  pluginProviders: Record<string, Record<string, ProviderConfig>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(pluginProviders).map(([pluginId, providers]) => [
      encodePluginModelCatalogRelativePath(pluginId),
      `${JSON.stringify({ generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY, providers }, null, 2)}\n`,
    ]),
  );
}

export async function resolveProvidersForModelsJsonWithDeps(
  params: {
    cfg: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
    workspaceDir?: string;
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
    providerDiscoveryEntriesOnly?: boolean;
  },
  deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
  },
): Promise<Record<string, ProviderConfig>> {
  const { cfg, agentDir, env } = params;
  const explicitProviders = cfg.models?.providers ?? {};
  const resolveImplicitProvidersImpl = deps?.resolveImplicitProviders ?? resolveImplicitProviders;
  const implicitProviders = await resolveImplicitProvidersImpl({
    agentDir,
    config: cfg,
    env,
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    explicitProviders,
    ...(params.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
      : {}),
    ...(params.providerDiscoveryProviderIds
      ? { providerDiscoveryProviderIds: params.providerDiscoveryProviderIds }
      : {}),
    ...(params.providerDiscoveryTimeoutMs !== undefined
      ? { providerDiscoveryTimeoutMs: params.providerDiscoveryTimeoutMs }
      : {}),
    ...(params.providerDiscoveryEntriesOnly === true ? { providerDiscoveryEntriesOnly: true } : {}),
  });
  return mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
  });
}

function resolveProvidersForMode(params: {
  mode: NonNullable<ModelsConfig["mode"]>;
  existingParsed: unknown;
  providers: Record<string, ProviderConfig>;
  secretRefManagedProviders: ReadonlySet<string>;
}): Record<string, ProviderConfig> {
  if (params.mode !== "merge") {
    return params.providers;
  }
  const existing = params.existingParsed;
  if (!isRecord(existing) || !isRecord(existing.providers)) {
    return params.providers;
  }
  const existingProviders = existing.providers as Record<
    string,
    NonNullable<ModelsConfig["providers"]>[string]
  >;
  return mergeWithExistingProviderSecrets({
    nextProviders: params.providers,
    existingProviders: existingProviders as Record<string, ExistingProviderConfig>,
    secretRefManagedProviders: params.secretRefManagedProviders,
  });
}

function isWritableProviderConfig(provider: ProviderConfig): boolean {
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return true;
  }
  return Boolean(provider.baseUrl?.trim() && provider.apiKey);
}

function filterWritableProviders(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const next = Object.fromEntries(
    Object.entries(providers).filter(([, provider]) => isWritableProviderConfig(provider)),
  );
  return Object.keys(next).length === Object.keys(providers).length ? providers : next;
}

export async function planOpenClawModelsJsonWithDeps(
  params: {
    cfg: OpenClawConfig;
    sourceConfigForSecrets?: OpenClawConfig;
    agentDir: string;
    env: NodeJS.ProcessEnv;
    workspaceDir?: string;
    existingRaw: string;
    existingParsed: unknown;
    pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    providerDiscoveryProviderIds?: readonly string[];
    providerDiscoveryTimeoutMs?: number;
    providerDiscoveryEntriesOnly?: boolean;
  },
  deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
  },
): Promise<ModelsJsonPlan> {
  const { cfg, agentDir, env } = params;
  const providers = await resolveProvidersForModelsJsonWithDeps(
    {
      cfg,
      agentDir,
      env,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
      ...(params.pluginMetadataSnapshot
        ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
        : {}),
      ...(params.providerDiscoveryProviderIds
        ? { providerDiscoveryProviderIds: params.providerDiscoveryProviderIds }
        : {}),
      ...(params.providerDiscoveryTimeoutMs !== undefined
        ? { providerDiscoveryTimeoutMs: params.providerDiscoveryTimeoutMs }
        : {}),
      ...(params.providerDiscoveryEntriesOnly === true
        ? { providerDiscoveryEntriesOnly: true }
        : {}),
    },
    deps,
  );

  if (Object.keys(providers).length === 0) {
    if (params.cfg.models?.mode === "replace") {
      return {
        action: "write",
        contents: `${JSON.stringify({ providers: {} }, null, 2)}\n`,
        pluginCatalogWrites: {},
      };
    }
    return { action: "skip" };
  }

  const mode = cfg.models?.mode ?? "merge";
  const secretRefManagedProviders = new Set<string>();
  const manifestPlugins = params.pluginMetadataSnapshot?.manifestRegistry.plugins;
  const normalizedProviders =
    normalizeProviders({
      providers,
      agentDir,
      env,
      secretDefaults: cfg.secrets?.defaults,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
      manifestPlugins,
    }) ?? providers;
  const mergedProviders = resolveProvidersForMode({
    mode,
    existingParsed: params.existingParsed,
    providers: normalizedProviders,
    secretRefManagedProviders,
  });
  const normalizedMergedProviders =
    normalizeProviderCatalogModelsForConfig(mergedProviders, {
      manifestPlugins,
    }) ?? mergedProviders;
  const secretEnforcedProviders =
    enforceSourceManagedProviderSecrets({
      providers: normalizedMergedProviders,
      sourceProviders: params.sourceConfigForSecrets?.models?.providers,
      sourceSecretDefaults: params.sourceConfigForSecrets?.secrets?.defaults,
      secretRefManagedProviders,
    }) ?? normalizedMergedProviders;
  const finalProviders = applyNativeStreamingUsageCompat(
    filterWritableProviders(secretEnforcedProviders),
  );
  const splitProviders = splitProvidersByPluginOwner({
    providers: finalProviders,
    pluginMetadataSnapshot: params.pluginMetadataSnapshot,
  });
  const pluginCatalogWrites = buildPluginCatalogWrites(splitProviders.pluginProviders);
  const nextContents = `${JSON.stringify(
    {
      providers: splitProviders.rootProviders,
    },
    null,
    2,
  )}\n`;

  if (params.existingRaw === nextContents && Object.keys(pluginCatalogWrites).length === 0) {
    return { action: "noop", pluginCatalogWrites };
  }

  return {
    action: "write",
    contents: nextContents,
    pluginCatalogWrites,
  };
}

export async function planOpenClawModelsJson(
  params: Parameters<typeof planOpenClawModelsJsonWithDeps>[0],
): Promise<ModelsJsonPlan> {
  return planOpenClawModelsJsonWithDeps(params);
}
