import { loadQaRuntimeModule } from "openclaw/plugin-sdk/qa-runner-runtime";
import { normalizeQaProviderMode, type QaProviderModeInput } from "../../run-config.js";

export type ResolvedMatrixQaModels = {
  providerMode: ReturnType<typeof normalizeQaProviderMode>;
  primaryModel: string;
  alternateModel: string;
};

export function resolveMatrixQaModels(params: {
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
}): ResolvedMatrixQaModels {
  const providerMode = normalizeQaProviderMode(params.providerMode ?? "live-frontier");
  const primaryModel = params.primaryModel?.trim();
  const alternateModel = params.alternateModel?.trim();
  if (primaryModel && alternateModel) {
    return {
      providerMode,
      primaryModel,
      alternateModel,
    };
  }

  const qaRuntime = loadQaRuntimeModule();
  return {
    providerMode,
    primaryModel: primaryModel || qaRuntime.defaultQaRuntimeModelForMode(providerMode),
    alternateModel:
      alternateModel || qaRuntime.defaultQaRuntimeModelForMode(providerMode, { alternate: true }),
  };
}
