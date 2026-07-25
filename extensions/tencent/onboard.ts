// Tencent setup module handles plugin onboarding behavior.
import {
  applyAgentDefaultModelPrimary,
  applyProviderConfigWithModelCatalog,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildTokenHubModelDefinition,
  buildTokenPlanModelDefinition,
  TOKENHUB_BASE_URL,
  TOKENHUB_MODEL_CATALOG,
  TOKENHUB_PROVIDER_ID,
  TOKENPLAN_BASE_URL,
  TOKENPLAN_MODEL_CATALOG,
  TOKENPLAN_PROVIDER_ID,
} from "./api.js";

// ---------- TokenHub ----------

export const TOKENHUB_DEFAULT_MODEL_REF = `${TOKENHUB_PROVIDER_ID}/hy3`;
const TOKENHUB_PREVIEW_MODEL_REF = `${TOKENHUB_PROVIDER_ID}/hy3-preview`;

function applyTokenHubProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[TOKENHUB_DEFAULT_MODEL_REF] = {
    ...models[TOKENHUB_DEFAULT_MODEL_REF],
    alias: models[TOKENHUB_DEFAULT_MODEL_REF]?.alias ?? "Hy3 (TokenHub)",
  };
  models[TOKENHUB_PREVIEW_MODEL_REF] = {
    ...models[TOKENHUB_PREVIEW_MODEL_REF],
    alias: models[TOKENHUB_PREVIEW_MODEL_REF]?.alias ?? "Hy3 preview (TokenHub)",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: TOKENHUB_PROVIDER_ID,
    api: "openai-completions",
    baseUrl: TOKENHUB_BASE_URL,
    catalogModels: TOKENHUB_MODEL_CATALOG.map(buildTokenHubModelDefinition),
  });
}

export function applyTokenHubConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyTokenHubProviderConfig(cfg),
    TOKENHUB_DEFAULT_MODEL_REF,
  );
}

// ---------- TokenPlan ----------

export const TOKENPLAN_DEFAULT_MODEL_REF = `${TOKENPLAN_PROVIDER_ID}/hy3`;

function applyTokenPlanProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  const models = { ...cfg.agents?.defaults?.models };
  models[TOKENPLAN_DEFAULT_MODEL_REF] = {
    ...models[TOKENPLAN_DEFAULT_MODEL_REF],
    alias: models[TOKENPLAN_DEFAULT_MODEL_REF]?.alias ?? "Hy3 (TokenPlan)",
  };

  return applyProviderConfigWithModelCatalog(cfg, {
    agentModels: models,
    providerId: TOKENPLAN_PROVIDER_ID,
    api: "openai-completions",
    baseUrl: TOKENPLAN_BASE_URL,
    catalogModels: TOKENPLAN_MODEL_CATALOG.map(buildTokenPlanModelDefinition),
  });
}

export function applyTokenPlanConfig(cfg: OpenClawConfig): OpenClawConfig {
  return applyAgentDefaultModelPrimary(
    applyTokenPlanProviderConfig(cfg),
    TOKENPLAN_DEFAULT_MODEL_REF,
  );
}
