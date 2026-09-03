import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { stripSelfProviderModelPrefix } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import {
  resolveMergedModelProviderConfig,
  resolveModelProviderRouteOverridePresence,
} from "../../config/model-provider-config.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type { ModelAuthAvailabilityEvaluation } from "../model-auth-availability.js";
import type { ModelCatalogEntry } from "../model-catalog.types.js";
import { hasAuthoredProviderRequestParams } from "../model-extra-params.js";
import { splitTrailingAuthProfile } from "../model-ref-profile.js";
import { resolveAgentHarnessPolicy } from "./policy.js";
import type { AgentHarnessModelCatalogParams } from "./types.js";

/** Applies native account observations to catalog metadata, never to execution auth. */
export function createAgentHarnessCatalogEvaluator(
  params: AgentHarnessModelCatalogParams & {
    preferredProfileId?: string;
    lockedProfileId?: string;
    pluginRegistry?: PluginRegistry;
    isCurrent?: () => boolean;
    observationConfig?: AgentHarnessModelCatalogParams["config"];
  },
) {
  const isCurrent = () => params.isCurrent?.() ?? params.observationConfig === undefined;
  return (
    entry: ModelCatalogEntry,
    host: ModelAuthAvailabilityEvaluation,
  ): ModelAuthAvailabilityEvaluation => {
    const runtime = resolveAgentHarnessPolicy({
      provider: entry.provider,
      modelId: entry.id,
      modelApi: entry.api,
      modelBaseUrl: entry.baseUrl,
      config: params.config,
      agentId: params.agentId,
    }).runtime;
    if (runtime === "auto" || runtime === "openclaw") {
      return host;
    }
    const provider = normalizeProviderId(entry.provider);
    const configured = resolveMergedModelProviderConfig(params.config, provider);
    const modelKey = (id: string) =>
      stripSelfProviderModelPrefix(provider, splitTrailingAuthProfile(id).model.trim()).trim();
    // Native account evidence cannot satisfy an authored host route, key, profile,
    // or request override. Those keep the existing prepared-route evaluator.
    if (
      params.preferredProfileId ||
      params.lockedProfileId ||
      (host.selectedAuthMode && (host.evidence !== "runtime" || entry.nativeRuntime !== runtime)) ||
      configured?.api ||
      configured?.baseUrl ||
      configured?.apiKey ||
      configured?.auth ||
      configured?.models?.some(
        (model) => modelKey(model.id) === modelKey(entry.id) && (model.api || model.baseUrl),
      ) ||
      Object.keys(params.config.auth?.order ?? {}).some(
        (id) => normalizeProviderId(id) === provider,
      ) ||
      Object.values(params.config.auth?.profiles ?? {}).some(
        (profile) => normalizeProviderId(profile.provider) === provider,
      ) ||
      resolveModelProviderRouteOverridePresence({
        authoredConfig: params.config,
        provider,
        modelId: entry.id,
      }) === "present" ||
      hasAuthoredProviderRequestParams({
        config: params.config,
        provider,
        modelId: entry.id,
        agentId: params.agentId,
      })
    ) {
      return host;
    }
    const resolveRegistry = () =>
      params.observationConfig
        ? params.pluginRegistry
        : (params.pluginRegistry ?? getActivePluginRegistry());
    const registry = resolveRegistry();
    const harness = registry?.agentHarnesses.find(
      (registration) => registration.harness.id === runtime,
    )?.harness;
    if (!harness?.readModelCatalogReadiness && entry.nativeRuntime !== runtime) {
      return host;
    }
    let ready = false;
    try {
      ready =
        isCurrent() &&
        harness?.authBootstrap === "harness" &&
        harness.supports({
          provider,
          modelId: entry.id,
          requestedRuntime: runtime,
          modelProvider: { preparedAuth: { source: "harness" } },
        }).supported &&
        harness.readModelCatalogReadiness?.({
          config: params.observationConfig ?? params.config,
          agentId: params.agentId,
          agentDir: params.agentDir,
          workspaceDir: params.workspaceDir,
          provider,
          modelId: entry.id,
        }) !== undefined &&
        isCurrent() &&
        resolveRegistry() === registry;
    } catch {
      // A failed/disposed owner supplies no account observation; do not infer host readiness.
    }
    return { availability: ready, routeResolution: null };
  };
}
