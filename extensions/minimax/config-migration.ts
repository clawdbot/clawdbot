import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { MINIMAX_API_BASE_URL, MINIMAX_CN_API_BASE_URL } from "./model-definitions.js";
import { buildMinimaxPortalProvider } from "./provider-catalog.js";

const LEGACY_MINIMAX_PORTAL_BASE_URLS = new Set([MINIMAX_API_BASE_URL, MINIMAX_CN_API_BASE_URL]);
// The old OAuth flow wrote these aliases with the empty provider catalog in one patch.
// Requiring both shapes avoids rewriting user-created empty provider catalogs.
const LEGACY_MINIMAX_PORTAL_MODEL_ALIASES = {
  "minimax-portal/MiniMax-M3": "minimax-m3",
  "minimax-portal/MiniMax-M2.7": "minimax-m2.7",
  "minimax-portal/MiniMax-M2.7-highspeed": "minimax-m2.7-highspeed",
} as const;

export function migrateLegacyMinimaxPortalModels(config: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} | null {
  const provider = config.models?.providers?.["minimax-portal"];
  const configuredModels = config.agents?.defaults?.models;
  if (
    !provider ||
    !Array.isArray(provider.models) ||
    provider.models.length !== 0 ||
    provider.api !== "anthropic-messages" ||
    provider.authHeader !== true ||
    typeof provider.baseUrl !== "string" ||
    !LEGACY_MINIMAX_PORTAL_BASE_URLS.has(provider.baseUrl) ||
    Object.entries(LEGACY_MINIMAX_PORTAL_MODEL_ALIASES).some(
      ([modelRef, alias]) => configuredModels?.[modelRef]?.alias !== alias,
    )
  ) {
    return null;
  }

  return {
    config: {
      ...config,
      models: {
        ...config.models,
        providers: {
          ...config.models?.providers,
          "minimax-portal": {
            ...provider,
            models: buildMinimaxPortalProvider().models,
          },
        },
      },
    },
    changes: ["restored the MiniMax OAuth model catalog for a legacy empty provider entry"],
  };
}
