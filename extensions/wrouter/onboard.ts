import { readManifestProviderDefaultModelRef } from "openclaw/plugin-sdk/provider-catalog-shared";
import { createModelCatalogPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { WROUTER_BASE_URL, WROUTER_MODEL_CATALOG } from "./models.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

const WROUTER_DEFAULT_MODEL_REF = readManifestProviderDefaultModelRef(manifest, "wrouter")!;

export const { applyConfig: applyWRouterConfig } = createModelCatalogPresetAppliers<[]>({
  primaryModelRef: WROUTER_DEFAULT_MODEL_REF,
  resolveParams: () => ({
    providerId: "wrouter",
    api: "openai-completions",
    baseUrl: WROUTER_BASE_URL,
    catalogModels: structuredClone(WROUTER_MODEL_CATALOG),
    aliases: [{ modelRef: WROUTER_DEFAULT_MODEL_REF, alias: "WRouter" }],
  }),
});
