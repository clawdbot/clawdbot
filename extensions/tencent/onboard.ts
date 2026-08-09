import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { createModelCatalogPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import {
  TOKENHUB_BASE_URL,
  TOKENHUB_MODEL_CATALOG,
  TOKENHUB_PROVIDER_ID,
  TOKENPLAN_BASE_URL,
  TOKENPLAN_MODEL_CATALOG,
  TOKENPLAN_PROVIDER_ID,
} from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const TOKENHUB_PREVIEW_MODEL_REF = `${TOKENHUB_PROVIDER_ID}/hy3-preview`;
export const TOKENHUB_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(
  manifest,
  TOKENHUB_PROVIDER_ID,
)!;

export const { applyConfig: applyTokenHubConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: TOKENHUB_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: TOKENHUB_PROVIDER_ID,
    api: "openai-completions",
    baseUrl: TOKENHUB_BASE_URL,
    catalogModels: structuredClone(TOKENHUB_MODEL_CATALOG),
    aliases: [
      { modelRef: TOKENHUB_DEFAULT_MODEL_REF, alias: "Hy3 (TokenHub)" },
      { modelRef: TOKENHUB_PREVIEW_MODEL_REF, alias: "Hy3 preview (TokenHub)" },
    ],
  }),
});

export const TOKENPLAN_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(
  manifest,
  TOKENPLAN_PROVIDER_ID,
)!;

export const { applyConfig: applyTokenPlanConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: TOKENPLAN_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: TOKENPLAN_PROVIDER_ID,
    api: "openai-completions",
    baseUrl: TOKENPLAN_BASE_URL,
    catalogModels: structuredClone(TOKENPLAN_MODEL_CATALOG),
    aliases: [{ modelRef: TOKENPLAN_DEFAULT_MODEL_REF, alias: "Hy3 (TokenPlan)" }],
  }),
});
