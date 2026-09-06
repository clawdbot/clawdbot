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

// Every model gets its own explicit ref constant. Do NOT reuse
// TOKENHUB_DEFAULT_MODEL_REF as the carrier for a specific model's alias:
// that ref tracks the manifest's `defaultModel`, so pinning an alias to it
// silently mislabels whichever model becomes the default next.
const TOKENHUB_HY3_MODEL_REF = `${TOKENHUB_PROVIDER_ID}/hy3`;
const TOKENHUB_HY3_PREVIEW_MODEL_REF = `${TOKENHUB_PROVIDER_ID}/hy3-preview`;
const TOKENHUB_HY4_PREVIEW_MODEL_REF = `${TOKENHUB_PROVIDER_ID}/hy4-preview`;
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
      { modelRef: TOKENHUB_HY4_PREVIEW_MODEL_REF, alias: "Hy4 preview (TokenHub)" },
      { modelRef: TOKENHUB_HY3_MODEL_REF, alias: "Hy3 (TokenHub)" },
      { modelRef: TOKENHUB_HY3_PREVIEW_MODEL_REF, alias: "Hy3 preview (TokenHub)" },
    ],
  }),
});

const TOKENPLAN_HY3_MODEL_REF = `${TOKENPLAN_PROVIDER_ID}/hy3`;
const TOKENPLAN_HY4_PREVIEW_MODEL_REF = `${TOKENPLAN_PROVIDER_ID}/hy4-preview`;
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
    aliases: [
      { modelRef: TOKENPLAN_HY4_PREVIEW_MODEL_REF, alias: "Hy4 preview (TokenPlan)" },
      { modelRef: TOKENPLAN_HY3_MODEL_REF, alias: "Hy3 (TokenPlan)" },
    ],
  }),
});
