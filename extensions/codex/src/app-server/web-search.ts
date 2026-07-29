import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { JsonObject } from "./protocol.js";

export type CodexWebSearchPlan = {
  kind: "native-hosted" | "managed" | "disabled";
  suppressManagedWebSearch: boolean;
  threadConfig: JsonObject;
};

export type CodexNativeWebSearchSupport = "supported" | "unsupported" | "unknown";

const CODEX_NATIVE_WEB_SEARCH_DISABLED_CONFIG: JsonObject = {
  "features.standalone_web_search": false,
  web_search: "disabled",
};

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function normalizeUniqueStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = [
    ...new Set(
      value.map(normalizeOptionalString).filter((entry): entry is string => Boolean(entry)),
    ),
  ];
  return normalized.length > 0 ? normalized : undefined;
}

function hasManagedSearchProvider(config: OpenClawConfig | undefined): boolean {
  return normalizeOptionalString(config?.tools?.web?.search?.provider) !== undefined;
}

function hasNativeDomainRestrictions(config: OpenClawConfig | undefined): boolean {
  return (
    normalizeUniqueStrings(config?.tools?.web?.search?.openaiCodex?.allowedDomains) !== undefined
  );
}

export function buildCodexNativeWebSearchThreadConfig(
  config: OpenClawConfig | undefined,
): JsonObject {
  const nativeConfig = config?.tools?.web?.search?.openaiCodex;
  const threadConfig: JsonObject = {
    // Production app-server traffic rejects standalone web.run's user-defined
    // `web` namespace. Hosted web_search emits the same native search items.
    "features.standalone_web_search": false,
    // Codex treats cached as a preference and resolves it to live for
    // unrestricted permission profiles.
    web_search: nativeConfig?.mode === "live" ? "live" : "cached",
  };
  const allowedDomains = normalizeUniqueStrings(nativeConfig?.allowedDomains);
  if (allowedDomains) {
    threadConfig["tools.web_search.allowed_domains"] = allowedDomains;
  }
  if (nativeConfig?.contextSize) {
    threadConfig["tools.web_search.context_size"] = nativeConfig.contextSize;
  }
  const location = nativeConfig?.userLocation;
  const country = normalizeOptionalString(location?.country);
  const region = normalizeOptionalString(location?.region);
  const city = normalizeOptionalString(location?.city);
  const timezone = normalizeOptionalString(location?.timezone);
  if (country) {
    threadConfig["tools.web_search.location.country"] = country;
  }
  if (region) {
    threadConfig["tools.web_search.location.region"] = region;
  }
  if (city) {
    threadConfig["tools.web_search.location.city"] = city;
  }
  if (timezone) {
    threadConfig["tools.web_search.location.timezone"] = timezone;
  }
  return threadConfig;
}

export function resolveCodexWebSearchPlan(params: {
  config?: OpenClawConfig;
  disableTools?: boolean;
  nativeToolSurfaceEnabled?: boolean;
  nativeProviderWebSearchSupport?: CodexNativeWebSearchSupport;
  webSearchAllowed?: boolean;
}): CodexWebSearchPlan {
  if (
    params.disableTools === true ||
    params.webSearchAllowed === false ||
    params.config?.tools?.web?.search?.enabled === false
  ) {
    return {
      kind: "disabled",
      suppressManagedWebSearch: true,
      threadConfig: CODEX_NATIVE_WEB_SEARCH_DISABLED_CONFIG,
    };
  }
  const nativeConfig = params.config?.tools?.web?.search?.openaiCodex;
  const managedSearchExplicit =
    hasManagedSearchProvider(params.config) || nativeConfig?.enabled === false;
  const nativeProviderSupportsSearch =
    params.nativeProviderWebSearchSupport === undefined ||
    params.nativeProviderWebSearchSupport === "supported";
  const nativeSearchEnabled =
    params.nativeToolSurfaceEnabled !== false &&
    nativeProviderSupportsSearch &&
    nativeConfig?.enabled !== false &&
    !hasManagedSearchProvider(params.config);
  if (!nativeSearchEnabled) {
    if (!managedSearchExplicit && hasNativeDomainRestrictions(params.config)) {
      return {
        kind: "disabled",
        suppressManagedWebSearch: true,
        threadConfig: CODEX_NATIVE_WEB_SEARCH_DISABLED_CONFIG,
      };
    }
    return {
      kind: "managed",
      suppressManagedWebSearch: false,
      threadConfig: CODEX_NATIVE_WEB_SEARCH_DISABLED_CONFIG,
    };
  }
  return {
    kind: "native-hosted",
    // Native and managed search must stay mutually exclusive. In particular,
    // exposing managed web_search here could bypass native allowed_domains.
    suppressManagedWebSearch: true,
    threadConfig: buildCodexNativeWebSearchThreadConfig(params.config),
  };
}
