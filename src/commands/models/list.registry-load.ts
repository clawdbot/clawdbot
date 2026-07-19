/** Registry-loading adapters for model-list row construction. */
import { loadAgentModelRegistry } from "../../agents/model-registry-loader.js";
import { shouldSuppressBuiltInModel } from "../../agents/model-suppression.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ModelRegistry } from "../../llm/model-registry.js";
import type { Model } from "../../llm/types.js";
import { loadModelRegistry } from "./list.registry.js";
import type { ConfiguredEntry } from "./list.types.js";
import { modelKey } from "./shared.js";

/** Loads the full model registry and tracks discovered provider/model keys. */
export async function loadListModelRegistry(
  cfg: OpenClawConfig,
  opts?: {
    agentId?: string;
    agentDir?: string;
    providerFilter?: string;
    normalizeModels?: boolean;
    loadAvailability?: boolean;
    workspaceDir?: string;
  },
) {
  const loaded = await loadModelRegistry(cfg, opts);
  return {
    ...loaded,
    discoveredKeys: new Set(loaded.models.map((model) => modelKey(model.provider, model.id))),
  };
}

function findConfiguredRegistryModel(params: {
  registry: ModelRegistry;
  entry: ConfiguredEntry;
  cfg: OpenClawConfig;
}): Model | undefined {
  const model = params.registry.find(params.entry.ref.provider, params.entry.ref.model);
  if (!model) {
    return undefined;
  }
  if (
    shouldSuppressBuiltInModel({
      provider: model.provider,
      id: model.id,
      baseUrl: model.baseUrl,
      config: params.cfg,
    })
  ) {
    return undefined;
  }
  return model;
}

/** Loads only configured registry entries and their auth availability. */
export async function loadConfiguredListModelRegistry(
  cfg: OpenClawConfig,
  entries: ConfiguredEntry[],
  opts?: {
    agentId?: string;
    agentDir?: string;
    providerFilter?: string;
    workspaceDir?: string;
  },
) {
  const registryOptions = {
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
    ...(opts?.agentDir ? { agentDir: opts.agentDir } : {}),
    ...(opts?.workspaceDir ? { workspaceDir: opts.workspaceDir } : {}),
    ...(opts?.providerFilter ? { providerFilter: opts.providerFilter } : {}),
  };
  // Preparation and the synchronous fork must address the same credential-aware owner.
  // Configured-only rows use registry auth state to report local availability.
  const { config: runtimeConfig, registry } = await loadAgentModelRegistry(cfg, registryOptions);
  const discoveredKeys = new Set<string>();
  const availableKeys = new Set<string>();

  for (const entry of entries) {
    const model = findConfiguredRegistryModel({ registry, entry, cfg: runtimeConfig });
    if (!model) {
      continue;
    }
    const key = modelKey(model.provider, model.id);
    discoveredKeys.add(key);
    if (registry.hasConfiguredAuth(model)) {
      availableKeys.add(key);
    }
  }

  return {
    registry,
    discoveredKeys,
    availableKeys,
  };
}
