import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "./types.openclaw.js";

const AUTO_LOCAL_MODEL_LEAN_PROVIDER_IDS = new Set(["lmstudio", "ollama"]);

function parseOllamaModelSourceSuffix(
  modelRef: string,
): { base: string; source: "cloud" | "local" } | undefined {
  const sourceSeparator = modelRef.lastIndexOf(":");
  if (sourceSeparator < 0) {
    return undefined;
  }
  const source = modelRef.slice(sourceSeparator + 1);
  if (source === "cloud" || source === "local") {
    return { base: modelRef.slice(0, sourceSeparator), source };
  }
  if (!source.includes("/") && source.endsWith("-cloud")) {
    return { base: modelRef.slice(0, -"-cloud".length), source: "cloud" };
  }
  return undefined;
}

/** Returns true only for local runtimes that onboarding can identify without model-name guesses. */
function shouldAutoEnableLocalModelLean(providerId: string, modelRef: string): boolean {
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!AUTO_LOCAL_MODEL_LEAN_PROVIDER_IDS.has(normalizedProviderId)) {
    return false;
  }
  if (normalizedProviderId !== "ollama") {
    return true;
  }
  // Ollama can route hosted source-tagged models through the same local daemon.
  // Nested source suffixes are ambiguous and must retain the owner's local classification.
  const modelSource = parseOllamaModelSourceSuffix(modelRef.trim().toLowerCase());
  return (
    modelSource?.source !== "cloud" || parseOllamaModelSourceSuffix(modelSource.base) !== undefined
  );
}

function resolveDefaultModelRef(config: OpenClawConfig): string | undefined {
  const model = config.agents?.defaults?.model;
  return typeof model === "string" ? model : model?.primary;
}

function clearAutoModel(config: OpenClawConfig): OpenClawConfig {
  const wizard = { ...config.wizard };
  delete wizard.localModelLeanAutoModel;
  return { ...config, wizard };
}

/** Maintains the onboarding-owned lean default while preserving explicit user configuration. */
export function applyAutoLocalModelLean(params: {
  config: OpenClawConfig;
  providerId: string;
  modelRef: string;
}): {
  config: OpenClawConfig;
  changed: boolean;
  enabled: boolean;
} {
  const localModelLean = params.config.agents?.defaults?.experimental?.localModelLean;
  const autoModel = params.config.wizard?.localModelLeanAutoModel;
  const onboardingOwnsSetting =
    autoModel !== undefined && resolveDefaultModelRef(params.config) === autoModel;
  if (!shouldAutoEnableLocalModelLean(params.providerId, params.modelRef)) {
    if (!autoModel) {
      return { config: params.config, changed: false, enabled: false };
    }
    const config = clearAutoModel(params.config);
    if (!onboardingOwnsSetting || localModelLean !== true) {
      return { config, changed: true, enabled: false };
    }
    const experimental = { ...params.config.agents?.defaults?.experimental };
    delete experimental.localModelLean;
    return {
      config: {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            experimental,
          },
        },
      },
      changed: true,
      enabled: false,
    };
  }
  if (localModelLean !== undefined) {
    if (!autoModel) {
      return { config: params.config, changed: false, enabled: false };
    }
    if (!onboardingOwnsSetting || !localModelLean) {
      return { config: clearAutoModel(params.config), changed: true, enabled: false };
    }
    if (autoModel === params.modelRef) {
      return { config: params.config, changed: false, enabled: false };
    }
    return {
      config: {
        ...params.config,
        wizard: { ...params.config.wizard, localModelLeanAutoModel: params.modelRef },
      },
      changed: true,
      enabled: false,
    };
  }
  return {
    config: {
      ...params.config,
      wizard: {
        ...params.config.wizard,
        localModelLeanAutoModel: params.modelRef,
      },
      agents: {
        ...params.config.agents,
        defaults: {
          ...params.config.agents?.defaults,
          experimental: {
            ...params.config.agents?.defaults?.experimental,
            localModelLean: true,
          },
        },
      },
    },
    changed: true,
    enabled: true,
  };
}
