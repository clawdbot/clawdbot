import {
  createDefaultModelPresetAppliers,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import {
  buildKimiCodingProvider,
  KIMI_CODING_BASE_URL,
  KIMI_CODING_DEFAULT_MODEL_ID,
} from "./provider-catalog.js";

export const KIMI_MODEL_REF = `kimi/${KIMI_CODING_DEFAULT_MODEL_ID}`;
export const KIMI_CODING_MODEL_REF = KIMI_MODEL_REF;

function resolveKimiCodingDefaultModel() {
  return buildKimiCodingProvider().models[0];
}

const kimiCodingPresetAppliers = createDefaultModelPresetAppliers({
  primaryModelRef: KIMI_MODEL_REF,
  resolveParams: (_cfg: OpenClawConfig) => {
    const defaultModel = resolveKimiCodingDefaultModel();
    if (!defaultModel) {
      return null;
    }
    return {
      providerId: "kimi",
      api: "anthropic-messages",
      baseUrl: KIMI_CODING_BASE_URL,
      defaultModel,
      defaultModelId: KIMI_CODING_DEFAULT_MODEL_ID,
      aliases: [{ modelRef: KIMI_MODEL_REF, alias: "Kimi" }],
    };
  },
});

export function applyKimiCodeProviderConfig(cfg: OpenClawConfig): OpenClawConfig {
  return kimiCodingPresetAppliers.applyProviderConfig(cfg);
}

export function applyKimiCodeConfig(cfg: OpenClawConfig): OpenClawConfig {
  return kimiCodingPresetAppliers.applyConfig(cfg);
}
