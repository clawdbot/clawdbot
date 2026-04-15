import {
  createDefaultModelsPresetAppliers,
  type ModelApi,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildQianfanProvider,
  QIANFAN_BASE_URL,
  QIANFAN_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

export const QIANFAN_DEFAULT_MODEL_REF = `qianfan/${QIANFAN_DEFAULT_MODEL_ID}`;

function resolveQianfanPreset(cfg: OpenClawConfig): {
  api: ModelApi;
  baseUrl: string;
  defaultModels: NonNullable<ReturnType<typeof buildQianfanProvider>["models"]>;
} {
  const defaultProvider = buildQianfanProvider();
  const existingProvider = cfg.models?.providers?.qianfan as
    | {
        baseUrl?: unknown;
        api?: unknown;
      }
    | undefined;
  const existingBaseUrl =
    typeof existingProvider?.baseUrl === "string" ? existingProvider.baseUrl.trim() : "";
  const api =
    typeof existingProvider?.api === "string"
      ? (existingProvider.api as ModelApi)
      : "openai-completions";

  return {
    api,
    baseUrl: existingBaseUrl || QIANFAN_BASE_URL,
    defaultModels: defaultProvider.models ?? [],
  };
}

const qianfanPresetAppliers = createDefaultModelsPresetAppliers({
  primaryModelRef: QIANFAN_DEFAULT_MODEL_REF,
  resolveParams: (cfg: OpenClawConfig) => {
    const preset = resolveQianfanPreset(cfg);
    return {
      providerId: "qianfan",
      api: preset.api,
      baseUrl: preset.baseUrl,
      defaultModels: preset.defaultModels,
      defaultModelId: QIANFAN_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: QIANFAN_DEFAULT_MODEL_REF, alias: "QIANFAN" }],
    };
  },
});

export function applyQianfanProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return qianfanPresetAppliers.applyProviderConfig(cfg);
}

export function applyQianfanConfig(cfg: OpenClawConfig): OpenClawConfig {
  return qianfanPresetAppliers.applyConfig(cfg);
}
