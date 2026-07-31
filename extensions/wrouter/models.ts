// WRouter plugin module builds model definitions from the manifest catalog.
import { buildManifestModelDefinition } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const WROUTER_MANIFEST_CATALOG = manifest.modelCatalog.providers.wrouter;
export const WROUTER_BASE_URL = WROUTER_MANIFEST_CATALOG.baseUrl;

export const WROUTER_MODEL_CATALOG: ModelDefinitionConfig[] = WROUTER_MANIFEST_CATALOG.models.map(
  buildManifestModelDefinition({
    providerId: "wrouter",
    catalog: WROUTER_MANIFEST_CATALOG,
    decorate: (model) => ({ ...model, api: "openai-completions" }),
  }),
);
