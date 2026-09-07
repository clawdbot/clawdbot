// Duckduckgo helper module supports config behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_DDG_SAFE_SEARCH = "moderate";

export type DdgSafeSearch = "strict" | "moderate" | "off";

type DdgPluginConfig = {
  webSearch?: {
    region?: string;
    safeSearch?: string;
  };
};

function resolveDdgWebSearchConfig(
  config?: OpenClawConfig,
): DdgPluginConfig["webSearch"] | undefined {
  const pluginConfig = config?.plugins?.entries?.duckduckgo?.config as DdgPluginConfig | undefined;
  const webSearch = pluginConfig?.webSearch;
  if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) {
    return webSearch;
  }
  return undefined;
}

export function resolveDdgRegion(config?: OpenClawConfig): string | undefined {
  return normalizeOptionalString(resolveDdgWebSearchConfig(config)?.region);
}

export function resolveDdgSafeSearch(config?: OpenClawConfig): DdgSafeSearch {
  const safeSearch = resolveDdgWebSearchConfig(config)?.safeSearch;
  const normalized = normalizeLowercaseStringOrEmpty(safeSearch);
  if (normalized === "strict" || normalized === "off") {
    return normalized;
  }
  return DEFAULT_DDG_SAFE_SEARCH;
}
