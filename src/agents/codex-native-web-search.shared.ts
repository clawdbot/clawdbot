/**
 * Shared config normalization for Codex native web search.
 */
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";

/** Whether native Codex search may use cached or live external web access. */
export type CodexNativeSearchMode = "cached" | "live";
/** OpenAI search context-size hint for Codex native web search. */
type CodexNativeSearchContextSize = "low" | "medium" | "high";

/** Optional approximate user location for Codex native web search. */
type CodexNativeSearchUserLocation = {
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
};

/** Normalized Codex native web-search settings. */
type ResolvedCodexNativeWebSearchConfig = {
  enabled: boolean;
  mode: CodexNativeSearchMode;
  allowedDomains?: string[];
  contextSize?: CodexNativeSearchContextSize;
  userLocation?: CodexNativeSearchUserLocation;
};

function normalizeAllowedDomains(value: unknown): string[] | undefined {
  const deduped = normalizeUniqueTrimmedStringList(value);
  return deduped.length > 0 ? deduped : undefined;
}

function normalizeContextSize(value: unknown): CodexNativeSearchContextSize | undefined {
  if (value === "low" || value === "medium" || value === "high") {
    return value;
  }
  return undefined;
}

function normalizeMode(value: unknown): CodexNativeSearchMode {
  return value === "live" ? "live" : "cached";
}

function normalizeUserLocation(value: unknown): CodexNativeSearchUserLocation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const location = {
    country: typeof value.country === "string" ? value.country.trim() || undefined : undefined,
    region: typeof value.region === "string" ? value.region.trim() || undefined : undefined,
    city: typeof value.city === "string" ? value.city.trim() || undefined : undefined,
    timezone: typeof value.timezone === "string" ? value.timezone.trim() || undefined : undefined,
  };
  return location.country || location.region || location.city || location.timezone
    ? location
    : undefined;
}

/** Resolve Codex native web-search config from OpenClaw tool settings. */
export function resolveCodexNativeWebSearchConfig(
  config: OpenClawConfig | undefined,
): ResolvedCodexNativeWebSearchConfig {
  const nativeConfig = config?.tools?.web?.search?.openaiCodex;
  return {
    enabled: nativeConfig?.enabled === true,
    mode: normalizeMode(nativeConfig?.mode),
    allowedDomains: normalizeAllowedDomains(nativeConfig?.allowedDomains),
    contextSize: normalizeContextSize(nativeConfig?.contextSize),
    userLocation: normalizeUserLocation(nativeConfig?.userLocation),
  };
}

/** Return concise prompt/status text for enabled Codex native search. */
export function describeCodexNativeWebSearch(
  config: OpenClawConfig | undefined,
): string | undefined {
  if (config?.tools?.web?.search?.enabled === false) {
    return undefined;
  }

  const nativeConfig = resolveCodexNativeWebSearchConfig(config);
  if (!nativeConfig.enabled) {
    return undefined;
  }
  return `Codex native search: ${nativeConfig.mode} for Codex-capable models`;
}
