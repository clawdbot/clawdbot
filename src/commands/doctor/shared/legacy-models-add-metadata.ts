import { normalizeProviderId } from "../../../agents/provider-id.js";
import type { ModelDefinitionConfig } from "../../../config/types.models.js";

const LEGACY_MODELS_ADD_CODEX_MODEL_IDS = new Set(["gpt-5.5", "gpt-5.5-pro"]);

export function isLegacyModelsAddCodexMetadataModel(params: {
  provider: string;
  model: Partial<ModelDefinitionConfig> | undefined;
}): boolean {
  const model = params.model;
  if (normalizeProviderId(params.provider) !== "openai-codex" || !model) {
    return false;
  }
  const id = model.id?.trim().toLowerCase();
  if (!id || !LEGACY_MODELS_ADD_CODEX_MODEL_IDS.has(id)) {
    return false;
  }
  return (
    model.api === "openai-codex-responses" &&
    model.reasoning === true &&
    Array.isArray(model.input) &&
    model.input.length === 2 &&
    model.input[0] === "text" &&
    model.input[1] === "image" &&
    model.cost?.input === 5 &&
    model.cost.output === 30 &&
    model.cost.cacheRead === 0.5 &&
    model.cost.cacheWrite === 0 &&
    model.contextWindow === 400_000 &&
    model.contextTokens === 272_000 &&
    model.maxTokens === 128_000
  );
}
