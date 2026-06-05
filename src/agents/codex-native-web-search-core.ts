/**
 * Activates and injects OpenAI/Codex native web-search tools when config,
 * model API, and auth state allow it.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isRecord } from "../utils.js";
import { externalCliDiscoveryForProviderAuth } from "./auth-profiles/external-cli-discovery.js";
import { listProfilesForProvider } from "./auth-profiles/profile-list.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import {
  type CodexNativeSearchMode,
  resolveCodexNativeWebSearchConfig,
} from "./codex-native-web-search.shared.js";

type CodexNativeSearchActivation = {
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

type CodexNativeSearchPayloadPatchResult = {
  status: "payload_not_object" | "native_tool_already_present" | "injected";
};

const OPENAI_AUTH_PROVIDER_IDS = ["openai"] as const;

function isOpenAIAuthProviderId(provider: string | undefined): boolean {
  return OPENAI_AUTH_PROVIDER_IDS.some((candidate) => candidate === provider);
}

/** Returns whether a model API can accept the native Codex web_search tool. */
export function isCodexNativeSearchEligibleModel(params: {
  modelProvider?: string;
  modelApi?: string;
}): boolean {
  return params.modelApi === "openai-chatgpt-responses";
}

function hasCodexNativeWebSearchTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  return tools.some(
    (tool) => isRecord(tool) && typeof tool.type === "string" && tool.type === "web_search",
  );
}

/** Checks whether OpenAI/Codex auth is available for native web search. */
export function hasAvailableCodexAuth(params: {
  config?: OpenClawConfig;
  agentDir?: string;
}): boolean {
  if (
    Object.values(params.config?.auth?.profiles ?? {}).some(
      (profile) =>
        isRecord(profile) &&
        isOpenAIAuthProviderId(profile.provider) &&
        (profile.mode === "oauth" || profile.mode === "token"),
    )
  ) {
    return true;
  }

  if (params.agentDir) {
    try {
      const store = ensureAuthProfileStore(params.agentDir, {
        externalCli: externalCliDiscoveryForProviderAuth({
          cfg: params.config,
          provider: "openai",
        }),
      });
      if (
        OPENAI_AUTH_PROVIDER_IDS.some(
          (provider) => listProfilesForProvider(store, provider).length > 0,
        )
      ) {
        return true;
      }
    } catch {
      // Fall back to config-based detection below.
    }
  }
  return false;
}

/** Resolves whether native search is active or why managed search should remain. */
export function resolveCodexNativeSearchActivation(params: {
  config?: OpenClawConfig;
  modelProvider?: string;
  modelApi?: string;
  agentDir?: string;
}): CodexNativeSearchActivation {
  const globalWebSearchEnabled = params.config?.tools?.web?.search?.enabled !== false;
  const codexConfig = resolveCodexNativeWebSearchConfig(params.config);
  const nativeEligible = isCodexNativeSearchEligibleModel(params);
  const hasRequiredAuth =
    params.modelApi !== "openai-chatgpt-responses" ||
    !isOpenAIAuthProviderId(params.modelProvider) ||
    hasAvailableCodexAuth(params);

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

/** Builds the OpenAI Responses `web_search` tool payload from config. */
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

/** Injects a native Codex web-search tool into a mutable provider payload. */
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

/** Returns whether the managed OpenClaw web-search tool should be hidden. */
export function shouldSuppressManagedWebSearchTool(params: {
  config?: OpenClawConfig;
  modelProvider?: string;
  modelApi?: string;
  agentDir?: string;
}): boolean {
  return resolveCodexNativeSearchActivation(params).state === "native_active";
}
