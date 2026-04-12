import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { isRecord } from "../utils.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "./auth-profiles.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";

export type CodexNativeSearchMode = "cached" | "live";
export type CodexNativeSearchContextSize = "low" | "medium" | "high";

export type CodexNativeSearchUserLocation = {
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
};

export type ResolvedCodexNativeWebSearchConfig = {
  enabled: boolean;
  mode: CodexNativeSearchMode;
  allowedDomains?: string[];
  contextSize?: CodexNativeSearchContextSize;
  userLocation?: CodexNativeSearchUserLocation;
};

export type CodexNativeSearchActivation = {
  globalWebSearchEnabled: boolean;
  codexNativeEnabled: boolean;
  codexMode: CodexNativeSearchMode;
  nativeEligible: boolean;
  hasRequiredAuth: boolean;
  state: "managed_only" | "native_active";
  inactiveReason?:
    | "globally_disabled"
    | "codex_not_enabled"
    | "model_not_eligible"
    | "codex_auth_missing";
};

export type CodexNativeSearchPayloadPatchResult = {
  status: "payload_not_object" | "native_tool_already_present" | "injected";
};

function normalizeAllowedDomains(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const deduped = [
    ...new Set(
      value
        .map((entry) => normalizeOptionalString(entry))
        .filter((entry): entry is string => typeof entry === "string"),
    ),
  ];
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
    country: normalizeOptionalString(value.country),
    region: normalizeOptionalString(value.region),
    city: normalizeOptionalString(value.city),
    timezone: normalizeOptionalString(value.timezone),
  };
  return location.country || location.region || location.city || location.timezone
    ? location
    : undefined;
}

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

export function isCodexNativeSearchEligibleModel(params: {
  modelProvider?: string;
  modelApi?: string;
}): boolean {
  return params.modelProvider === "openai-codex" || params.modelApi === "openai-codex-responses";
}

export function hasCodexNativeWebSearchTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some(
    (tool) => isRecord(tool) && typeof tool.type === "string" && tool.type === "web_search",
  );
}

export function hasAvailableCodexAuth(params: {
  config?: OpenClawConfig;
  agentDir?: string;
}): boolean {
  if (
    Object.values(params.config?.auth?.profiles ?? {}).some(
      (profile) => isRecord(profile) && profile.provider === "openai-codex",
    )
  ) {
    return true;
  }

  if (params.agentDir) {
    try {
      if (
        listProfilesForProvider(ensureAuthProfileStore(params.agentDir), "openai-codex").length > 0
      ) {
        return true;
      }
    } catch {
      // Fall back to config-based detection below.
    }
  }
  return false;
}

export function resolveCodexNativeSearchActivation(params: {
  config?: OpenClawConfig;
  modelProvider?: string;
  modelApi?: string;
  agentDir?: string;
}): CodexNativeSearchActivation {
  const globalWebSearchEnabled = params.config?.tools?.web?.search?.enabled !== false;
  const codexConfig = resolveCodexNativeWebSearchConfig(params.config);
  const nativeEligible = isCodexNativeSearchEligibleModel(params);
  const hasRequiredAuth = params.modelProvider !== "openai-codex" || hasAvailableCodexAuth(params);

  if (!globalWebSearchEnabled) {
    return {
      globalWebSearchEnabled,
      codexNativeEnabled: codexConfig.enabled,
      codexMode: codexConfig.mode,
      nativeEligible,
      hasRequiredAuth,
      state: "managed_only",
      inactiveReason: "globally_disabled",
    };
  }

  if (!codexConfig.enabled) {
    return {
      globalWebSearchEnabled,
      codexNativeEnabled: false,
      codexMode: codexConfig.mode,
      nativeEligible,
      hasRequiredAuth,
      state: "managed_only",
      inactiveReason: "codex_not_enabled",
    };
  }

  if (!nativeEligible) {
    return {
      globalWebSearchEnabled,
      codexNativeEnabled: true,
      codexMode: codexConfig.mode,
      nativeEligible: false,
      hasRequiredAuth,
      state: "managed_only",
      inactiveReason: "model_not_eligible",
    };
  }

  if (!hasRequiredAuth) {
    return {
      globalWebSearchEnabled,
      codexNativeEnabled: true,
      codexMode: codexConfig.mode,
      nativeEligible: true,
      hasRequiredAuth: false,
      state: "managed_only",
      inactiveReason: "codex_auth_missing",
    };
  }

  return {
    globalWebSearchEnabled,
    codexNativeEnabled: true,
    codexMode: codexConfig.mode,
    nativeEligible: true,
    hasRequiredAuth: true,
    state: "native_active",
  };
}

export function buildCodexNativeWebSearchTool(
  config: OpenClawConfig | undefined,
): Record<string, unknown> {
  const nativeConfig = resolveCodexNativeWebSearchConfig(config);
  const tool: Record<string, unknown> = {
    type: "web_search",
    external_web_access: nativeConfig.mode === "live",
  };

  if (nativeConfig.allowedDomains) {
    tool.filters = {
      allowed_domains: nativeConfig.allowedDomains,
    };
  }

  if (nativeConfig.contextSize) {
    tool.search_context_size = nativeConfig.contextSize;
  }

  if (nativeConfig.userLocation) {
    tool.user_location = {
      type: "approximate",
      ...nativeConfig.userLocation,
    };
  }

  return tool;
}

export function patchCodexNativeWebSearchPayload(params: {
  payload: unknown;
  config?: OpenClawConfig;
}): CodexNativeSearchPayloadPatchResult {
  if (!isRecord(params.payload)) {
    return { status: "payload_not_object" };
  }

  const payload = params.payload;
  if (hasCodexNativeWebSearchTool(payload.tools)) {
    return { status: "native_tool_already_present" };
  }

  const tools = Array.isArray(payload.tools) ? [...payload.tools] : [];
  tools.push(buildCodexNativeWebSearchTool(params.config));
  payload.tools = tools;
  return { status: "injected" };
}

export function shouldSuppressManagedWebSearchTool(params: {
  config?: OpenClawConfig;
  modelProvider?: string;
  modelApi?: string;
  agentDir?: string;
}): boolean {
  return resolveCodexNativeSearchActivation(params).state === "native_active";
}

export function isCodexNativeWebSearchRelevant(params: {
  config: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
}): boolean {
  if (resolveCodexNativeWebSearchConfig(params.config).enabled) {
    return true;
  }
  if (hasAvailableCodexAuth(params)) {
    return true;
  }

  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.config,
    agentId: params.agentId,
  });
  const configuredProvider = params.config.models?.providers?.[defaultModel.provider];
  const configuredModelApi = configuredProvider?.models?.find(
    (candidate) => candidate.id === defaultModel.model,
  )?.api;
  return isCodexNativeSearchEligibleModel({
    modelProvider: defaultModel.provider,
    modelApi: configuredModelApi ?? configuredProvider?.api,
  });
}

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
