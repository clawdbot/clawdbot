/**
 * Plans root and plugin-owned model catalog writes. Setup and doctor flows use
 * this module to merge implicit provider discovery, explicit config, and
 * preserved secrets before touching models.json.
 */
import { mergeModelCost } from "../config/model-cost.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { PreparedProviderStaticCatalog } from "../plugins/provider-discovery.js";
import { isRecord } from "../utils.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import {
  modelKey,
  createConfiguredProviderCatalogModelIdNormalizer,
  type ModelManifestNormalizationContext,
} from "./model-ref-shared.js";
import {
  mergeProviders,
  mergeWithExistingProviderSecrets,
  normalizeProviderMapKeys,
  type ExistingProviderConfig,
  type SourceModelFields,
} from "./models-config.merge.js";
import {
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

export type PreparedModelsConfigContext = Readonly<{
  cfg: OpenClawConfig;
  discoveryAuthConfig: OpenClawConfig;
  discoveryAuthEnv?: NodeJS.ProcessEnv;
  sourceConfigForSecrets: OpenClawConfig;
  agentDir: string;
  env: NodeJS.ProcessEnv;
  envFingerprint: NodeJS.ProcessEnv | string;
  workspaceDir?: string;
  pluginMetadataSnapshot?: Pick<
    PluginMetadataSnapshot,
    "index" | "manifestRegistry" | "owners" | "pluginIds"
  >;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
  onProviderCatalogOutcome?: (outcome: ProviderCatalogOutcome) => void;
}>;

/** Dependency hook for resolving implicit model providers while planning models.json. */
type ResolveImplicitProvidersForModelsJson = (params: {
  agentDir: string;
  authStore?: AuthProfileStore;
  config: OpenClawConfig;
  discoveryAuthConfig?: OpenClawConfig;
  discoveryAuthEnv?: NodeJS.ProcessEnv;
  sourceConfigForSecrets?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
  explicitProviders: Record<string, ProviderConfig>;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
  preparedStaticProviderCatalog?: PreparedProviderStaticCatalog;
  providerDiscoveryProviderIds?: readonly string[];
  providerDiscoveryTimeoutMs?: number;
  providerDiscoveryEntriesOnly?: boolean;
  sourceModelFields?: SourceModelFields;
}) => Promise<Record<string, ProviderConfig>>;

/**
 * Planned models.json result. When present, pluginCatalogWrites is the complete
 * replacement set; omission means the plan is non-authoritative for plugin catalogs.
 */
type ModelsJsonPlan =
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

function buildSourceModelFields(
  sourceProviders: Record<string, ProviderConfig> | undefined,
  manifestPlugins: ModelManifestNormalizationContext["manifestPlugins"],
): SourceModelFields {
  const normalizeModelId = createConfiguredProviderCatalogModelIdNormalizer({ manifestPlugins });
  const fields = new Map<
    string,
    { inputOmitted: boolean; cost: ReturnType<typeof mergeModelCost> }
  >();
  for (const [providerId, provider] of Object.entries(normalizeProviderMapKeys(sourceProviders))) {
    for (const model of provider.models ?? []) {
      const key = modelKey(providerId, normalizeModelId(providerId, model.id));
      const existing = fields.get(key);
      fields.set(key, {
        inputOmitted: existing?.inputOmitted || !Object.hasOwn(model, "input"),
        // Duplicate source rows keep the same first-authored priority as publication.
        cost: mergeModelCost(model.cost, existing?.cost),
      });
    }
  }
  return fields;
}

/** Resolves providers for models.json with injectable implicit-provider discovery. */
async function resolveProvidersForModelsJsonWithDeps(
  params: {
    context: PreparedModelsConfigContext;
    authStore?: AuthProfileStore;
  },
  deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
  },
): Promise<Record<string, ProviderConfig>> {
  const { context } = params;
  const { agentDir, env } = context;
  const explicitProviders = stripBlankProviderBaseUrls(context.cfg.models?.providers ?? {});
  const cfg = context.cfg.models?.providers
    ? { ...context.cfg, models: { ...context.cfg.models, providers: explicitProviders } }
    : context.cfg;
  const manifestPlugins = context.pluginMetadataSnapshot;
  const sourceModelFields = buildSourceModelFields(context.cfg.models?.providers, manifestPlugins);
  // When models.mode is "replace" the user opts out of provider discovery, so
  // skip the (potentially slow) implicit-provider resolver entirely and return
  // only the explicit providers. See openclaw#66957.
  if (cfg.models?.mode === "replace") {
    return mergeProviders({ implicit: {}, explicit: explicitProviders });
  }
  const resolveImplicitProvidersImpl = deps?.resolveImplicitProviders ?? resolveImplicitProviders;
  const implicitProviders = await resolveImplicitProvidersImpl({
    agentDir,
    ...(params.authStore ? { authStore: params.authStore } : {}),
    config: cfg,
    discoveryAuthConfig: context.discoveryAuthConfig,
    discoveryAuthEnv: context.discoveryAuthEnv,
    sourceConfigForSecrets: context.sourceConfigForSecrets,
    env,
    ...(context.workspaceDir ? { workspaceDir: context.workspaceDir } : {}),
    explicitProviders,
    sourceModelFields,
    ...(context.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: context.pluginMetadataSnapshot }
      : {}),
    ...(context.preparedStaticProviderCatalog
      ? { preparedStaticProviderCatalog: context.preparedStaticProviderCatalog }
      : {}),
    ...(context.providerDiscoveryProviderIds
      ? { providerDiscoveryProviderIds: context.providerDiscoveryProviderIds }
      : {}),
    ...(context.providerDiscoveryTimeoutMs !== undefined
      ? { providerDiscoveryTimeoutMs: context.providerDiscoveryTimeoutMs }
      : {}),
    ...(context.providerDiscoveryEntriesOnly === true
      ? { providerDiscoveryEntriesOnly: true }
      : {}),
    ...(context.onProviderCatalogOutcome
      ? { onProviderCatalogOutcome: context.onProviderCatalogOutcome }
      : {}),
  });
  return mergeProviders({
    implicit: implicitProviders,
    explicit: explicitProviders,
    sourceModelFields,
    manifestPlugins,
  });
}

function stripBlankProviderBaseUrls(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  let mutated = false;
  const next: Record<string, ProviderConfig> = {};
  for (const [key, provider] of Object.entries(providers)) {
    if (typeof provider?.baseUrl === "string" && provider.baseUrl.trim() === "") {
      const { baseUrl: _blank, ...rest } = provider;
      next[key] = rest as ProviderConfig;
      mutated = true;
      continue;
    }
    next[key] = provider;
  }
  return mutated ? next : providers;
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
  // AuthStorage can supply omitted keys; an explicitly empty key still violates the schema.
  return Boolean(provider.baseUrl?.trim() && (provider.apiKey === undefined || provider.apiKey));
}

function filterWritableProviders(
  providers: Record<string, ProviderConfig>,
): Record<string, ProviderConfig> {
  const next = Object.fromEntries(
    Object.entries(providers).filter(([, provider]) => isWritableProviderConfig(provider)),
  );
  return Object.keys(next).length === Object.keys(providers).length ? providers : next;
}

/** Plans root and plugin-owned model catalog writes with injectable provider discovery. */
async function planOpenClawModelsJsonWithDeps(
  params: {
    context: PreparedModelsConfigContext;
    authStore?: AuthProfileStore;
    existingRaw: string;
    existingParsed: unknown;
  },
  deps?: {
    resolveImplicitProviders?: ResolveImplicitProvidersForModelsJson;
  },
): Promise<ModelsJsonPlan> {
  const { context } = params;
  const { cfg, agentDir, env } = context;
  const providers = await resolveProvidersForModelsJsonWithDeps(
    {
      context,
      ...(params.authStore ? { authStore: params.authStore } : {}),
    },
    deps,
  );

  if (Object.keys(providers).length === 0) {
    if (cfg.models?.mode === "replace") {
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
  const manifestPlugins = context.pluginMetadataSnapshot;
  const providerPolicyManifestRegistry =
    context.pluginMetadataSnapshot?.pluginIds === undefined
      ? context.pluginMetadataSnapshot?.manifestRegistry
      : undefined;
  const normalizedProviders =
    normalizeProviders({
      providers,
      agentDir,
      env,
      secretDefaults: cfg.secrets?.defaults,
      sourceConfigForSecrets: context.sourceConfigForSecrets,
      secretRefManagedProviders,
      manifestPlugins,
      ...(providerPolicyManifestRegistry
        ? { manifestRegistry: providerPolicyManifestRegistry }
        : {}),
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
      sourceConfigForSecrets: context.sourceConfigForSecrets,
      secretRefManagedProviders,
    }) ?? normalizedMergedProviders;
  const finalProviders = filterWritableProviders(secretEnforcedProviders);
  const splitProviders = splitProvidersByPluginOwner({
    providers: finalProviders,
    pluginMetadataSnapshot: context.pluginMetadataSnapshot,
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

/** Plans root and plugin-owned model catalog writes for the current runtime. */
export async function planOpenClawModelsJson(
  params: Parameters<typeof planOpenClawModelsJsonWithDeps>[0],
): Promise<ModelsJsonPlan> {
  return planOpenClawModelsJsonWithDeps(params);
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.modelsConfigPlanTestApi")] = {
    planOpenClawModelsJsonWithDeps,
    resolveProvidersForModelsJsonWithDeps,
  };
}
