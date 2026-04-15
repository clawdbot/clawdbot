import {
  createModelCatalogPresetAppliers,
  type ModelProviderConfig,
  type OpenClawConfig,
  type ProviderOnboardPresetAppliers,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildStepFunPlanProvider,
  buildStepFunProvider,
  STEPFUN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_CN_BASE_URL,
  STEPFUN_PLAN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_INTL_BASE_URL,
  STEPFUN_PLAN_PROVIDER_ID,
  STEPFUN_PROVIDER_ID,
  STEPFUN_STANDARD_CN_BASE_URL,
  STEPFUN_STANDARD_INTL_BASE_URL,
} from "./provider-catalog.js";

export {
  STEPFUN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_CN_BASE_URL,
  STEPFUN_PLAN_DEFAULT_MODEL_REF,
  STEPFUN_PLAN_INTL_BASE_URL,
  STEPFUN_STANDARD_CN_BASE_URL,
  STEPFUN_STANDARD_INTL_BASE_URL,
};

function createStepFunPresetAppliers(params: {
  providerId: string;
  primaryModelRef: string;
  alias: string;
  buildProvider: (baseUrl: string) => ModelProviderConfig;
}): ProviderOnboardPresetAppliers<[string]> {
  return createModelCatalogPresetAppliers<[string]>({
    primaryModelRef: params.primaryModelRef,
    resolveParams: (_cfg: OpenClawConfig, baseUrl: string) => {
      const provider = params.buildProvider(baseUrl);
      const models = provider.models ?? [];
      return {
        providerId: params.providerId,
        api: provider.api ?? "openai-completions",
        baseUrl,
        catalogModels: models,
        aliases: [
          ...models.map((model) => `${params.providerId}/${model.id}`),
          { modelRef: params.primaryModelRef, alias: params.alias },
        ],
      };
    },
  });
}

const stepFunPresetAppliers = createStepFunPresetAppliers({
  providerId: STEPFUN_PROVIDER_ID,
  primaryModelRef: STEPFUN_DEFAULT_MODEL_REF,
  alias: "StepFun",
  buildProvider: buildStepFunProvider,
});

const stepFunPlanPresetAppliers = createStepFunPresetAppliers({
  providerId: STEPFUN_PLAN_PROVIDER_ID,
  primaryModelRef: STEPFUN_PLAN_DEFAULT_MODEL_REF,
  alias: "StepFun Plan",
  buildProvider: buildStepFunPlanProvider,
});

export function applyStepFunStandardConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return stepFunPresetAppliers.applyConfig(cfg, STEPFUN_STANDARD_CN_BASE_URL);
}

export function applyStepFunStandardConfig(cfg: OpenClawConfig): OpenClawConfig {
  return stepFunPresetAppliers.applyConfig(cfg, STEPFUN_STANDARD_INTL_BASE_URL);
}

export function applyStepFunPlanConfigCn(cfg: OpenClawConfig): OpenClawConfig {
  return stepFunPlanPresetAppliers.applyConfig(cfg, STEPFUN_PLAN_CN_BASE_URL);
}

export function applyStepFunPlanConfig(cfg: OpenClawConfig): OpenClawConfig {
  return stepFunPlanPresetAppliers.applyConfig(cfg, STEPFUN_PLAN_INTL_BASE_URL);
}
