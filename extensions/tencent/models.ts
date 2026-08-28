// Tencent plugin module implements models behavior.
import { buildManifestModelProviderConfig } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-model-shared";
import manifest from "./openclaw.plugin.json" with { type: "json" };

// ---------- TokenHub provider ----------

export const TOKENHUB_PROVIDER_ID = "tencent-tokenhub";

export const TOKENHUB_BASE_URL = manifest.modelCatalog.providers[TOKENHUB_PROVIDER_ID].baseUrl;

const TOKENHUB_MANIFEST_CATALOG = manifest.modelCatalog.providers[TOKENHUB_PROVIDER_ID];
export const TOKENHUB_MODEL_CATALOG: ModelDefinitionConfig[] = buildManifestModelProviderConfig({
  providerId: TOKENHUB_PROVIDER_ID,
  catalog: TOKENHUB_MANIFEST_CATALOG,
}).models.map((model) => Object.assign(model, { api: "openai-completions" }));

// ---------- TokenPlan provider ----------

export const TOKENPLAN_PROVIDER_ID = "tencent-tokenplan";

export const TOKENPLAN_BASE_URL = manifest.modelCatalog.providers[TOKENPLAN_PROVIDER_ID].baseUrl;

const TOKENPLAN_MANIFEST_CATALOG = manifest.modelCatalog.providers[TOKENPLAN_PROVIDER_ID];
export const TOKENPLAN_MODEL_CATALOG: ModelDefinitionConfig[] = buildManifestModelProviderConfig({
  providerId: TOKENPLAN_PROVIDER_ID,
  catalog: TOKENPLAN_MANIFEST_CATALOG,
}).models.map((model) => Object.assign(model, { api: "openai-completions" }));
