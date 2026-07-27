// Novita plugin module implements models behavior.
import { buildManifestModelDefinition } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const NOVITA_MANIFEST_CATALOG = manifest.modelCatalog.providers.novita;

export const NOVITA_BASE_URL = NOVITA_MANIFEST_CATALOG.baseUrl;
export const NOVITA_MODEL_CATALOG: ModelDefinitionConfig[] = NOVITA_MANIFEST_CATALOG.models.map(
  buildManifestModelDefinition({
    providerId: "novita",
    catalog: NOVITA_MANIFEST_CATALOG,
    decorate: (model) => ({ ...model, api: "openai-completions" }),
  }),
);
