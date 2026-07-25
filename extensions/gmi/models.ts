// Gmi plugin module implements models behavior.
import {
  buildManifestModelDefinition,
  readManifestProviderDefaultModelRef,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const GMI_MANIFEST_CATALOG = manifest.modelCatalog.providers.gmi;
export const GMI_BASE_URL = GMI_MANIFEST_CATALOG.baseUrl;
export const GMI_MODEL_CATALOG: ModelDefinitionConfig[] = GMI_MANIFEST_CATALOG.models.map(
  buildManifestModelDefinition({
    providerId: "gmi",
    catalog: GMI_MANIFEST_CATALOG,
    decorate: (model) => ({ ...model, api: "openai-completions" }),
  }),
);
export const GMI_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "gmi")!;
