// Nvidia setup module handles plugin onboarding behavior.
import { createDefaultModelsPresetAppliers } from "openclaw/plugin-sdk/provider-onboard";
import { buildSelectableNvidiaProvider, NVIDIA_DEFAULT_MODEL_ID } from "./provider-catalog.js";

export const NVIDIA_DEFAULT_MODEL_REF = NVIDIA_DEFAULT_MODEL_ID;

export const { applyConfig: applyNvidiaConfig, applyProviderConfig: applyNvidiaProviderConfig } =
  createDefaultModelsPresetAppliers<[]>({
    primaryModelRef: NVIDIA_DEFAULT_MODEL_REF,
    resolveParams: () => {
      const defaultProvider = buildSelectableNvidiaProvider();
      return {
        providerId: "nvidia",
        api: defaultProvider.api ?? "openai-completions",
        baseUrl: defaultProvider.baseUrl,
        defaultModels: defaultProvider.models ?? [],
        defaultModelId: NVIDIA_DEFAULT_MODEL_ID,
        aliases: [{ modelRef: NVIDIA_DEFAULT_MODEL_REF, alias: "NVIDIA" }],
      };
    },
  });
