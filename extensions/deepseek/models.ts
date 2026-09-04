// Deepseek plugin module implements models behavior.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const DEEPSEEK_MANIFEST_CATALOG = manifest.modelCatalog.providers.deepseek;
export const DEEPSEEK_BASE_URL = DEEPSEEK_MANIFEST_CATALOG.baseUrl;

export const DEEPSEEK_MODEL_CATALOG: ModelDefinitionConfig[] = buildManifestModelProviderConfig({
  providerId: "deepseek",
  catalog: DEEPSEEK_MANIFEST_CATALOG,
}).models.map((model) => Object.assign(model, { api: "openai-completions" }));

const DEEPSEEK_V4_MODEL_IDS = new Set(
  DEEPSEEK_MODEL_CATALOG.map((model) => model.id).filter((id) => id.startsWith("deepseek-v4-")),
);

export function isDeepSeekV4ModelId(modelId: string): boolean {
  return DEEPSEEK_V4_MODEL_IDS.has(modelId.toLowerCase());
}

export function isDeepSeekV4ModelRef(model: { provider?: string; id?: unknown }): boolean {
  return (
    model.provider === "deepseek" && typeof model.id === "string" && isDeepSeekV4ModelId(model.id)
  );
}
