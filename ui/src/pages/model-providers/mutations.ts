import type { FastMode } from "../../api/types.ts";

export function buildProviderApiKeyPatch(provider: string, apiKey: string | null) {
  return {
    models: {
      providers: {
        [provider]: { apiKey },
      },
    },
  };
}

/**
 * Removing or reordering fallbacks shrinks a config array; the gateway's
 * destructive-array guard rejects such merge patches unless the exact path is
 * confirmed via replacePaths.
 */
export const DEFAULT_MODELS_REPLACE_PATHS = ["agents.defaults.model.fallbacks"];

export function buildDefaultsPatch(params: {
  primary: string;
  fallbacks: readonly string[];
  utilityModel: string | null;
  thinkingLevel: string | undefined;
  thinkingOverridden: boolean;
  fastMode: FastMode | undefined;
  fastModeOverridden: boolean;
}) {
  return {
    agents: {
      defaults: {
        ...(params.primary
          ? {
              model:
                params.fallbacks.length > 0
                  ? { primary: params.primary, fallbacks: [...params.fallbacks] }
                  : params.primary,
              utilityModel: params.utilityModel,
            }
          : {}),
        thinkingDefault:
          params.thinkingOverridden && params.thinkingLevel ? params.thinkingLevel : null,
        fastModeDefault:
          params.fastModeOverridden && params.fastMode !== undefined ? params.fastMode : null,
      },
    },
  };
}
