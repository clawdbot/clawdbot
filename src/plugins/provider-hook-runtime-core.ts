import { findNormalizedProviderValue } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { attachModelProviderLocalServiceReconciler } from "../agents/provider-local-service-reconcile.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import {
  resolveModelCatalogScope,
  resolveProviderConfigApiOwnerHint,
} from "./provider-config-owner.js";
import { findProviderRuntimePluginInRegistry } from "./provider-registry-selection.js";
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import type { createProviderRegistryResolver } from "./providers.runtime-core.js";
import type {
  ProviderPlugin,
  ProviderResolveAuthProfileIdContext,
  ProviderFollowupFallbackRouteContext,
  ProviderFollowupFallbackRouteResult,
  ProviderWrapStreamFnContext,
} from "./types.js";

type ProviderRuntimePluginLookupParams = {
  provider: string;
  providerOwner?: string;
  modelId?: string | null;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  applyAutoEnable?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
};

export type ProviderRuntimePluginHandle = ProviderRuntimePluginLookupParams & {
  plugin?: ProviderPlugin;
};

const MODEL_PROVIDER_RUNTIME_PLUGIN_HANDLE_SYMBOL = Symbol.for(
  "openclaw.modelProviderRuntimePluginHandle",
);

type ModelWithProviderRuntimePluginHandle = {
  [MODEL_PROVIDER_RUNTIME_PLUGIN_HANDLE_SYMBOL]?: ProviderRuntimePluginHandle;
};

type ProviderRuntimePluginHandleParams = ProviderRuntimePluginLookupParams & {
  runtimeHandle?: ProviderRuntimePluginHandle;
};

type ProviderHookParams<TContext> = {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  runtimeHandle?: ProviderRuntimePluginHandle;
  context: TContext;
};

export function createProviderHookRuntime(
  providers: ReturnType<typeof createProviderRegistryResolver>,
) {
  const { resolvePluginProviderRegistryCore, resolvePluginProvidersCore } = providers;
  /** Carries one attempt's prepared provider plugin through the model transport boundary. */
  function attachModelProviderRuntimePluginHandle<TModel extends object>(
    model: TModel,
    runtimeHandle: ProviderRuntimePluginHandle,
  ): TModel {
    // Replacement must clear the previous owner's reconciler when the new provider has none.
    const preparedModel = attachModelProviderLocalServiceReconciler(
      model,
      runtimeHandle.plugin?.reconcileLocalService,
    );
    return { ...preparedModel, [MODEL_PROVIDER_RUNTIME_PLUGIN_HANDLE_SYMBOL]: runtimeHandle };
  }

  /** Reads the provider plugin handle attached to a prepared attempt model. */
  function getModelProviderRuntimePluginHandle(
    model: object | undefined,
  ): ProviderRuntimePluginHandle | undefined {
    return model
      ? // Generic AI model types omit the attempt-local handle.
        // SAFETY: Only attachModelProviderRuntimePluginHandle writes this optional in-process symbol.
        (model as ModelWithProviderRuntimePluginHandle)[MODEL_PROVIDER_RUNTIME_PLUGIN_HANDLE_SYMBOL]
      : undefined;
  }

  function resolveProviderRuntimeLookupModelId(
    params: ProviderRuntimePluginLookupParams & { context?: { modelId?: unknown } },
  ): string | undefined {
    return normalizeOptionalString(
      params.modelId ??
        (typeof params.context?.modelId === "string" ? params.context.modelId : undefined),
    );
  }

  function hasConfiguredModelProvider(params: {
    provider: string;
    config?: OpenClawConfig;
  }): boolean {
    return (
      findNormalizedProviderValue(params.config?.models?.providers, params.provider) !== undefined
    );
  }

  function resolveLoadedProviderPluginsForHooks(params: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    onlyPluginIds?: string[];
    providerRefs?: readonly string[];
    modelRefs?: readonly string[];
    applyAutoEnable?: boolean;
    pluginMetadataSnapshot?: PluginMetadataRegistryView;
  }): ProviderPlugin[] | undefined {
    const resolved = resolvePluginProviderRegistryCore({ ...params, registryScope: "loaded" });
    if (!resolved) {
      return undefined;
    }
    return resolved.registry.providers
      .filter(
        ({ pluginId, provider }) =>
          (!resolved.onlyPluginIds || resolved.onlyPluginIds.includes(pluginId)) &&
          (!params.providerRefs?.length ||
            params.providerRefs.some((ref) => matchesProviderPluginRef(provider, ref))),
      )
      .map(({ pluginId, provider }) => Object.assign({}, provider, { pluginId }));
  }

  function resolveProviderPluginsForHooks(
    params: Parameters<typeof resolveLoadedProviderPluginsForHooks>[0],
  ): ProviderPlugin[] {
    return resolvePluginProvidersCore({
      ...params,
      activate: false,
      applyAutoEnable: params.applyAutoEnable,
      skipIfLoadInFlight: true,
    });
  }

  function resolveProviderRuntimePluginLookup(
    params: ProviderRuntimePluginLookupParams,
    registryScope?: "loaded",
  ): ProviderRuntimePluginHandle {
    const apiOwnerHint = resolveProviderConfigApiOwnerHint(params);
    const ownerRefs = [
      ...new Set(
        [params.providerOwner, apiOwnerHint].filter((owner): owner is string => Boolean(owner)),
      ),
    ];
    const modelId = resolveProviderRuntimeLookupModelId(params);
    const selection = resolvePluginProviderRegistryCore({
      ...params,
      providerRefs: [params.provider, ...ownerRefs],
      modelRefs: modelId
        ? resolveModelCatalogScope({
            cfg: params.config,
            provider: params.provider,
            model: modelId,
          }).modelRefs
        : undefined,
      registryScope,
      activate: false,
      skipIfLoadInFlight: true,
    });
    return {
      ...params,
      ...(selection ? { workspaceDir: selection.workspaceDir } : {}),
      plugin: selection
        ? findProviderRuntimePluginInRegistry({
            registry: selection.registry,
            provider: params.provider,
            ownerRefs,
            isOwnerEligible: (id) => selection.isProviderOwnerEligible(id, params.provider),
          })
        : undefined,
    };
  }

  function resolveProviderRuntimePlugin(
    params: ProviderRuntimePluginLookupParams,
  ): ProviderPlugin | undefined {
    return resolveProviderRuntimePluginLookup(params).plugin;
  }

  function resolveLoadedProviderRuntimePlugin(
    params: ProviderRuntimePluginLookupParams,
  ): ProviderPlugin | undefined {
    return resolveProviderRuntimePluginLookup(params, "loaded").plugin;
  }

  function resolveProviderHookPlugin(params: {
    provider: string;
    modelId?: string | null;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
  }): ProviderPlugin | undefined {
    const runtimePlugin = resolveProviderRuntimePlugin(params);
    if (runtimePlugin) {
      return runtimePlugin;
    }
    if (hasConfiguredModelProvider(params)) {
      return undefined;
    }
    const selection = resolvePluginProviderRegistryCore({
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      activate: false,
      skipIfLoadInFlight: true,
    });
    return selection
      ? findProviderRuntimePluginInRegistry({
          registry: selection.registry,
          provider: params.provider,
          ownerRefs: [],
          isOwnerEligible: (id) => selection.isProviderOwnerEligible(id, params.provider),
        })
      : undefined;
  }

  function resolveProviderRuntimePluginHandle(
    params: ProviderRuntimePluginLookupParams,
  ): ProviderRuntimePluginHandle {
    return resolveProviderRuntimePluginLookup(params);
  }

  function ensureProviderRuntimePluginHandle(
    params: ProviderRuntimePluginHandleParams,
  ): ProviderRuntimePluginHandle {
    const modelId = resolveProviderRuntimeLookupModelId(params);
    if (
      !params.runtimeHandle ||
      (modelId && !params.runtimeHandle.plugin && params.runtimeHandle.modelId !== modelId)
    ) {
      return resolveProviderRuntimePluginHandle({
        provider: params.provider,
        modelId,
        config: params.config ?? params.runtimeHandle?.config,
        workspaceDir: params.workspaceDir ?? params.runtimeHandle?.workspaceDir,
        env: params.env ?? params.runtimeHandle?.env,
        applyAutoEnable: params.runtimeHandle?.applyAutoEnable,
        pluginMetadataSnapshot:
          params.pluginMetadataSnapshot ?? params.runtimeHandle?.pluginMetadataSnapshot,
      });
    }
    return params.runtimeHandle;
  }

  function resolveProviderAuthProfileId(
    params: ProviderHookParams<ProviderResolveAuthProfileIdContext>,
  ): string | undefined {
    const resolved = ensureProviderRuntimePluginHandle(params).plugin?.resolveAuthProfileId?.(
      params.context,
    );
    return typeof resolved === "string" && resolved.trim() ? resolved.trim() : undefined;
  }

  function resolveProviderFollowupFallbackRoute(
    params: ProviderHookParams<ProviderFollowupFallbackRouteContext>,
  ): ProviderFollowupFallbackRouteResult | undefined {
    return (
      ensureProviderRuntimePluginHandle(params).plugin?.followupFallbackRoute?.(params.context) ??
      undefined
    );
  }

  function wrapProviderSimpleCompletionStreamFn(
    params: ProviderHookParams<ProviderWrapStreamFnContext>,
  ) {
    return (
      ensureProviderRuntimePluginHandle(params).plugin?.wrapSimpleCompletionStreamFn?.(
        params.context,
      ) ?? undefined
    );
  }

  return {
    attachModelProviderRuntimePluginHandle,
    getModelProviderRuntimePluginHandle,
    resolveLoadedProviderPluginsForHooks,
    resolveProviderPluginsForHooks,
    resolveProviderRuntimePlugin,
    resolveLoadedProviderRuntimePlugin,
    resolveProviderHookPlugin,
    resolveProviderRuntimePluginHandle,
    ensureProviderRuntimePluginHandle,
    resolveProviderAuthProfileId,
    resolveProviderFollowupFallbackRoute,
    wrapProviderSimpleCompletionStreamFn,
  };
}
