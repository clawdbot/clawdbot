import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

// ---------- TokenHub provider ----------

export const TOKENHUB_PROVIDER_ID = "tencent-tokenhub";

const TOKENHUB_MANIFEST_PROVIDER = buildManifestModelProviderConfig({
  providerId: TOKENHUB_PROVIDER_ID,
  catalog: manifest.modelCatalog.providers[TOKENHUB_PROVIDER_ID],
});

export const TOKENHUB_BASE_URL = TOKENHUB_MANIFEST_PROVIDER.baseUrl;

export const TOKENHUB_MODEL_CATALOG: ModelDefinitionConfig[] = TOKENHUB_MANIFEST_PROVIDER.models;

export function buildTokenHubModelDefinition(
  model: (typeof TOKENHUB_MODEL_CATALOG)[number],
): ModelDefinitionConfig {
  return {
    ...model,
    api: "openai-completions",
  };
}
