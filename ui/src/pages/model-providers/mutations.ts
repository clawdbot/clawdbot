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

export function buildDefaultModelsPatch(
  primary: string,
  fallbacks: readonly string[],
  utilityModel: string | null,
) {
  return {
    agents: {
      defaults: {
        model: fallbacks.length > 0 ? { primary, fallbacks: [...fallbacks] } : primary,
        utilityModel,
      },
    },
  };
}
