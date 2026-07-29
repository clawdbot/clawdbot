import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelRegistry as CoreModelRegistry } from "../../llm/model-registry.js";
import type { Model } from "../../llm/types.js";
import { ensureAuthProfileStore, resolveAuthProfileOrder } from "../auth-profiles.js";
import type { AuthProfileCredential } from "../auth-profiles/types.js";
import { resolveAgentHarnessPolicy } from "../harness/policy.js";
import { normalizeStaticProviderModelId } from "../model-ref-shared.js";
import { normalizeProviderId } from "../model-selection.js";
import { shouldSuppressBuiltInModel, shouldUnconditionallySuppress } from "../model-suppression.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../openai-routing.js";
import { resolveConfiguredFallbackModel } from "./model.configured-fallback.js";
import {
  applyConfiguredProviderOverrides,
  findInlineModelMatch,
  mergeStaticCatalogInlineModel,
  resolveConfiguredProviderConfig,
  shouldSuppressConfiguredModel,
  type StaticCatalogFallbackModel,
} from "./model.configured-overrides.js";
import type { InlineModelEntry } from "./model.inline-provider.js";
import {
  DEFAULT_PROVIDER_RUNTIME_HOOKS,
  normalizeResolvedModel,
  type ProviderRuntimeHooks,
  resolveProviderTransport,
} from "./model.provider-hooks.js";
import {
  resolveBundledStaticCatalogModel,
  resolveManifestModelCatalogProviderAliasMetadata,
  type ManifestModelCatalogProviderAliasMetadata,
} from "./model.static-catalog.js";

type ExplicitModelResolution =
  | { kind: "resolved"; model: Model; source: "configured" }
  | { kind: "resolved"; dropOnRuntimeMiss: boolean; model: Model; source: "registry" }
  | { kind: "suppressed" };

export function resolveExplicitModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: CoreModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  manifestAlias: ManifestModelCatalogProviderAliasMetadata;
  workspaceDir?: string;
  runtimeHooks?: ProviderRuntimeHooks;
  preparedInlineProviderModels?: readonly InlineModelEntry[];
  preparedStaticCatalogModel?: StaticCatalogFallbackModel;
}): ExplicitModelResolution | undefined {
  const { provider, modelId, modelRegistry, cfg, agentDir, workspaceDir, runtimeHooks } = params;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const inlineMatch = findInlineModelMatch({
    providers: cfg?.models?.providers ?? {},
    preparedModels: params.preparedInlineProviderModels,
    provider,
    modelId,
  });
  if (inlineMatch?.api) {
    const transport = resolveProviderTransport({
      provider,
      modelId,
      api: inlineMatch.api,
      baseUrl: inlineMatch.baseUrl ?? providerConfig?.baseUrl,
      cfg,
      workspaceDir,
      runtimeHooks,
    });
    if (
      shouldSuppressConfiguredModel({
        provider,
        modelId,
        cfg,
        workspaceDir,
        baseUrl: transport.baseUrl,
      })
    ) {
      return { kind: "suppressed" };
    }
    const staticCatalogModel =
      params.preparedStaticCatalogModel ??
      (resolveBundledStaticCatalogModel({
        provider,
        modelId,
        cfg,
        workspaceDir,
        includeRuntimeDiscovery: true,
      }) as StaticCatalogFallbackModel | undefined);
    return {
      kind: "resolved",
      source: "configured",
      model: normalizeResolvedModel({
        provider,
        cfg,
        agentDir,
        workspaceDir,
        model: applyConfiguredProviderOverrides({
          provider,
          discoveredModel: mergeStaticCatalogInlineModel(staticCatalogModel, inlineMatch as Model),
          providerConfig,
          modelId,
          cfg,
          manifestAlias: params.manifestAlias,
          runtimeHooks,
          workspaceDir,
          preferDiscoveredTransport: true,
          staticCatalogModel,
        }),
        runtimeHooks,
      }),
    };
  }
  if (
    shouldUnconditionallySuppress({
      provider,
      id: modelId,
      ...(cfg ? { config: cfg } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
    })
  ) {
    return { kind: "suppressed" };
  }
  const model = modelRegistry.find(provider, modelId) as Model | null;
  if (model) {
    const configuredBaseUrl =
      typeof providerConfig?.baseUrl === "string" ? providerConfig.baseUrl : undefined;
    const discoveredBaseUrl =
      typeof (model as { baseUrl?: unknown }).baseUrl === "string"
        ? (model as { baseUrl: string }).baseUrl
        : undefined;
    const effectiveBaseUrl = configuredBaseUrl ?? discoveredBaseUrl;
    if (
      shouldSuppressBuiltInModel({
        provider,
        id: modelId,
        ...(cfg ? { config: cfg } : {}),
        ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
        ...(workspaceDir ? { workspaceDir } : {}),
      })
    ) {
      return { kind: "suppressed" };
    }
    return {
      kind: "resolved",
      source: "registry",
      dropOnRuntimeMiss:
        normalizeProviderId(provider) === "openai" &&
        modelId.trim().toLowerCase() === "gpt-5.3-codex-spark" &&
        !effectiveBaseUrl,
      model: normalizeResolvedModel({
        provider,
        cfg,
        agentDir,
        workspaceDir,
        model: applyConfiguredProviderOverrides({
          provider,
          discoveredModel: model,
          providerConfig,
          modelId,
          cfg,
          manifestAlias: params.manifestAlias,
          runtimeHooks,
          workspaceDir,
        }),
        runtimeHooks,
      }),
    };
  }

  // An inline row without an API cannot resolve by itself. Keep it from falling
  // through to a synthetic provider fallback that would invent transport authority.
  if (inlineMatch) {
    return undefined;
  }
  if (
    shouldSuppressBuiltInModel({
      provider,
      id: modelId,
      ...(cfg ? { config: cfg } : {}),
      ...(providerConfig?.baseUrl ? { baseUrl: providerConfig.baseUrl } : {}),
      ...(workspaceDir ? { workspaceDir } : {}),
    })
  ) {
    return { kind: "suppressed" };
  }
  return undefined;
}

export function resolveDynamicModelAuthProfile(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  authProfileId?: string;
  authProfileMode?: AuthProfileCredential["type"] | "aws-sdk";
  preferredProfile?: string;
}): {
  authProfileId?: string;
  authProfileMode?: AuthProfileCredential["type"] | "aws-sdk";
} {
  const explicitProfileId = params.authProfileId?.trim() || undefined;
  const store = ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false });
  if (explicitProfileId) {
    const credential = store.profiles[explicitProfileId];
    const configuredMode = params.cfg?.auth?.profiles?.[explicitProfileId]?.mode;
    return {
      authProfileId: explicitProfileId,
      ...(params.authProfileMode || credential?.type || configuredMode
        ? { authProfileMode: params.authProfileMode ?? credential?.type ?? configuredMode }
        : {}),
    };
  }
  if (params.authProfileMode) {
    return { authProfileMode: params.authProfileMode };
  }
  const order = [
    ...new Set(
      listOpenAIAuthProfileProvidersForAgentRuntime({
        provider: params.provider,
        config: params.cfg,
      }).flatMap((provider) =>
        resolveAuthProfileOrder({
          cfg: params.cfg,
          store,
          provider,
          preferredProfile: params.preferredProfile,
          forModel: params.modelId,
        }),
      ),
    ),
  ];
  const profileId = order[0];
  if (!profileId) {
    return {};
  }
  const credential = store.profiles[profileId];
  const configuredMode = params.cfg?.auth?.profiles?.[profileId]?.mode;
  return {
    authProfileId: profileId,
    ...(credential?.type || configuredMode
      ? { authProfileMode: credential?.type ?? configuredMode }
      : {}),
  };
}

function resolvePluginDynamicModelWithRegistry(params: {
  provider: string;
  modelId: string;
  modelRegistry: CoreModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  agentRuntimeId?: string;
  manifestAlias: ManifestModelCatalogProviderAliasMetadata;
  workspaceDir?: string;
  authProfileId?: string;
  authProfileMode?: AuthProfileCredential["type"] | "aws-sdk";
  preferredProfile?: string;
  runtimeHooks?: ProviderRuntimeHooks;
}): Model | undefined {
  const { provider, modelId, modelRegistry, cfg, agentDir, workspaceDir } = params;
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const providerConfig = resolveConfiguredProviderConfig(cfg, provider);
  const agentHarnessPolicy = resolveAgentHarnessPolicy({ provider, modelId, config: cfg });
  const inferredAgentRuntimeId =
    agentHarnessPolicy.runtimeSource !== "implicit" ||
    cfg?.plugins?.entries?.codex?.enabled === true
      ? agentHarnessPolicy.runtime
      : undefined;
  const agentRuntimeId = params.agentRuntimeId ?? inferredAgentRuntimeId;
  const authProfile = resolveDynamicModelAuthProfile({
    provider,
    modelId,
    cfg,
    agentDir,
    authProfileId: params.authProfileId,
    authProfileMode: params.authProfileMode,
    preferredProfile: params.preferredProfile,
  });
  const preferDiscoveredModelMetadata = shouldCompareProviderRuntimeResolvedModel({
    provider,
    modelId,
    cfg,
    agentDir,
    workspaceDir,
    runtimeHooks,
  });
  const pluginDynamicModel = runtimeHooks.runProviderDynamicModel({
    provider,
    config: cfg,
    workspaceDir,
    context: {
      config: cfg,
      agentDir,
      workspaceDir,
      ...(agentRuntimeId ? { agentRuntimeId } : {}),
      provider,
      modelId,
      modelRegistry,
      providerConfig,
      ...authProfile,
    },
  }) as Model | undefined;
  if (!pluginDynamicModel) {
    return undefined;
  }
  const overriddenDynamicModel = applyConfiguredProviderOverrides({
    provider,
    discoveredModel: pluginDynamicModel,
    providerConfig,
    modelId,
    cfg,
    manifestAlias: params.manifestAlias,
    runtimeHooks,
    workspaceDir,
    preferDiscoveredModelMetadata,
  });
  return normalizeResolvedModel({
    provider,
    cfg,
    agentDir,
    workspaceDir,
    model: overriddenDynamicModel,
    runtimeHooks,
  });
}

export function resolveRuntimePreferredSuppressedModel(
  params: ResolveModelWithRegistryParams & {
    manifestAlias: ManifestModelCatalogProviderAliasMetadata;
  },
): Model | undefined {
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  if (!shouldCompareProviderRuntimeResolvedModel({ ...params, runtimeHooks })) {
    return undefined;
  }
  return resolvePluginDynamicModelWithRegistry({ ...params, runtimeHooks });
}

function shouldDropRuntimePreferredExplicitMiss(params: {
  provider: string;
  modelId: string;
  explicitModel: ExplicitModelResolution;
}): boolean {
  return (
    params.explicitModel.kind === "resolved" &&
    params.explicitModel.source === "registry" &&
    params.explicitModel.dropOnRuntimeMiss
  );
}

export function shouldCompareProviderRuntimeResolvedModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  runtimeHooks: ProviderRuntimeHooks;
}): boolean {
  return (
    params.runtimeHooks.shouldPreferProviderRuntimeResolvedModel?.({
      provider: params.provider,
      config: params.cfg,
      workspaceDir: params.workspaceDir,
      context: {
        provider: params.provider,
        modelId: params.modelId,
        config: params.cfg,
        agentDir: params.agentDir,
        workspaceDir: params.workspaceDir,
      },
    }) ?? false
  );
}

export function normalizeProviderModelRef(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
}): {
  provider: string;
  model: string;
  manifestAlias: ManifestModelCatalogProviderAliasMetadata;
} {
  const manifestAlias = resolveManifestModelCatalogProviderAliasMetadata({
    provider: params.provider,
    modelId: params.modelId,
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
  });
  return {
    provider: manifestAlias.provider,
    model: normalizeStaticProviderModelId(
      normalizeProviderId(manifestAlias.provider),
      params.modelId,
    ),
    manifestAlias,
  };
}

type ResolveModelWithRegistryParams = {
  provider: string;
  modelId: string;
  modelRegistry: CoreModelRegistry;
  cfg?: OpenClawConfig;
  agentDir?: string;
  agentRuntimeId?: string;
  workspaceDir?: string;
  authProfileId?: string;
  authProfileMode?: AuthProfileCredential["type"] | "aws-sdk";
  preferredProfile?: string;
  runtimeHooks?: ProviderRuntimeHooks;
  skipConfiguredFallback?: boolean;
};

export function resolveModelWithPreparedRegistry(
  params: ResolveModelWithRegistryParams & {
    manifestAlias: ManifestModelCatalogProviderAliasMetadata;
  },
): Model | undefined {
  // Competing activated owners leave credentials and transport authority unresolved.
  // Refuse the route before configured fallbacks can accidentally select either owner.
  if (params.manifestAlias.ambiguous) {
    return undefined;
  }
  const runtimeHooks = params.runtimeHooks ?? DEFAULT_PROVIDER_RUNTIME_HOOKS;
  const explicitModel = resolveExplicitModelWithRegistry(params);
  if (explicitModel?.kind === "suppressed") {
    return resolveRuntimePreferredSuppressedModel(params);
  }
  if (explicitModel?.kind === "resolved") {
    if (!shouldCompareProviderRuntimeResolvedModel({ ...params, runtimeHooks })) {
      return explicitModel.model;
    }
    return (
      resolvePluginDynamicModelWithRegistry(params) ??
      (shouldDropRuntimePreferredExplicitMiss({
        provider: params.provider,
        modelId: params.modelId,
        explicitModel,
      })
        ? undefined
        : explicitModel.model)
    );
  }
  const pluginDynamicModel = resolvePluginDynamicModelWithRegistry(params);
  if (pluginDynamicModel) {
    return pluginDynamicModel;
  }
  return params.skipConfiguredFallback ? undefined : resolveConfiguredFallbackModel(params);
}

export function resolveModelWithRegistry(
  params: ResolveModelWithRegistryParams,
): Model | undefined {
  const workspaceDir = params.workspaceDir ?? params.cfg?.agents?.defaults?.workspace;
  const normalizedRef = normalizeProviderModelRef({ ...params, workspaceDir });
  return resolveModelWithPreparedRegistry({
    ...params,
    provider: normalizedRef.provider,
    modelId: normalizedRef.model,
    manifestAlias: normalizedRef.manifestAlias,
    ...(workspaceDir !== undefined ? { workspaceDir } : {}),
  });
}
