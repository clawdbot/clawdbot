/** Registry access for full and configured-only model lists. */
import { modelKey } from "../../agents/model-ref-shared.js";
import { shouldSuppressBuiltInModelCore } from "../../agents/model-suppression.js";
import { loadPreparedAgentModelRegistry as loadAgentModelRegistry } from "../../agents/prepared-model-registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { formatErrorWithStack } from "./list.errors.js";
import type { ConfiguredEntry } from "./list.types.js";

type ModelListRegistryOptions = {
  agentId?: string;
  agentDir?: string;
  providerFilter?: string;
  normalizeModels?: boolean;
  workspaceDir?: string;
};

function validateAvailableModels(availableModels: unknown): Model[] {
  if (!Array.isArray(availableModels)) {
    throw new Error("Model availability unavailable: getAvailable() returned a non-array value.");
  }

  for (const model of availableModels) {
    if (
      !model ||
      typeof model !== "object" ||
      typeof (model as { provider?: unknown }).provider !== "string" ||
      typeof (model as { id?: unknown }).id !== "string"
    ) {
      throw new Error(
        "Model availability unavailable: getAvailable() returned invalid model entries.",
      );
    }
  }

  return availableModels as Model[];
}

/** Loads the full registry, discovered keys, and model-level availability. */
export async function loadModelRegistry(cfg: OpenClawConfig, opts?: ModelListRegistryOptions) {
  const { config: runtimeConfig, registry } = await loadAgentModelRegistry(cfg, opts);
  const isVisible = (model: Model) =>
    !shouldSuppressBuiltInModelCore({
      provider: model.provider,
      id: model.id,
      baseUrl: model.baseUrl,
      config: runtimeConfig,
    });
  const models = registry.getAll().filter(isVisible);
  const discoveredKeys = new Set(models.map((model) => modelKey(model.provider, model.id)));
  let availableKeys: Set<string> | undefined;
  let availabilityErrorMessage: string | undefined;
  try {
    const availableModels = validateAvailableModels(registry.getAvailable()).filter(isVisible);
    availableKeys = new Set(availableModels.map((model) => modelKey(model.provider, model.id)));
  } catch (err) {
    // Availability failures use provider auth hints; an empty result remains authoritative.
    // Registry discovery failures above still abort the command.
    availabilityErrorMessage = `Model availability unavailable: getAvailable() failed.\n${formatErrorWithStack(err)}`;
  }
  return { registry, models, discoveredKeys, availableKeys, availabilityErrorMessage };
}

/** Loads only configured registry entries and their auth availability. */
export async function loadConfiguredListModelRegistry(
  cfg: OpenClawConfig,
  entries: ConfiguredEntry[],
  opts?: Omit<ModelListRegistryOptions, "normalizeModels">,
) {
  // Configured-only rows use the credential-aware owner's targeted lookups.
  const { config: runtimeConfig, registry } = await loadAgentModelRegistry(cfg, opts);
  const discoveredKeys = new Set<string>();
  const availableKeys = new Set<string>();
  for (const entry of entries) {
    const model = registry.find(entry.ref.provider, entry.ref.model);
    if (
      !model ||
      shouldSuppressBuiltInModelCore({
        provider: model.provider,
        id: model.id,
        baseUrl: model.baseUrl,
        config: runtimeConfig,
      })
    ) {
      continue;
    }
    const key = modelKey(model.provider, model.id);
    discoveredKeys.add(key);
    if (registry.hasConfiguredAuth(model)) {
      availableKeys.add(key);
    }
  }
  return { registry, discoveredKeys, availableKeys };
}
