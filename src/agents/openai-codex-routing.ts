import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { OPENCLAW_AGENT_RUNTIME_ID } from "./agent-runtime-id.js";
import { normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";
import { findNormalizedProviderValue, normalizeProviderId } from "./provider-id.js";

export const OPENAI_PROVIDER_ID = "openai";
export const OPENAI_CODEX_PROVIDER_ID = "openai-codex";

function isOfficialOpenAIBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return true;
  }
  try {
    const url = new URL(baseUrl.trim());
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "api.openai.com" &&
      (url.pathname === "" ||
        url.pathname === "/" ||
        url.pathname === "/v1" ||
        url.pathname === "/v1/")
    );
  } catch {
    return false;
  }
}

function openAIProviderUsesCustomBaseUrl(config: OpenClawConfig | undefined): boolean {
  return !isOfficialOpenAIBaseUrl(config?.models?.providers?.openai?.baseUrl);
}

export function isOpenAIProvider(provider: string | undefined): boolean {
  return normalizeProviderId(provider ?? "") === OPENAI_PROVIDER_ID;
}

export function isOpenAICodexProvider(provider: string | undefined): boolean {
  return normalizeProviderId(provider ?? "") === OPENAI_CODEX_PROVIDER_ID;
}

export function openAIProviderUsesCodexRuntimeByDefault(params: {
  provider?: string;
  config?: OpenClawConfig;
}): boolean {
  return isOpenAIProvider(params.provider) && !openAIProviderUsesCustomBaseUrl(params.config);
}

export function parseModelRefProvider(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const slashIndex = value.trim().indexOf("/");
  if (slashIndex <= 0) {
    return undefined;
  }
  return normalizeProviderId(value.trim().slice(0, slashIndex));
}

export function modelRefUsesOpenAIProvider(value: unknown): boolean {
  return parseModelRefProvider(value) === OPENAI_PROVIDER_ID;
}

export function modelSelectionShouldEnsureCodexPlugin(params: {
  model?: string;
  config?: OpenClawConfig;
}): boolean {
  const provider = parseModelRefProvider(params.model);
  if (provider === OPENAI_CODEX_PROVIDER_ID) {
    return true;
  }
  return provider === OPENAI_PROVIDER_ID && !openAIProviderUsesCustomBaseUrl(params.config);
}

export function hasOpenAICodexAuthProfileOverride(value: unknown): boolean {
  return (
    typeof value === "string" &&
    normalizeOptionalLowercaseString(value)?.startsWith(`${OPENAI_CODEX_PROVIDER_ID}:`) === true
  );
}

function configuredOpenAIAuthOrderStartsWithCodexProfile(config: OpenClawConfig | undefined) {
  if (!openAIProviderUsesCodexRuntimeByDefault({ provider: OPENAI_PROVIDER_ID, config })) {
    return false;
  }
  const configuredOpenAIOrder = findNormalizedProviderValue(
    config?.auth?.order,
    OPENAI_PROVIDER_ID,
  );
  const firstProfile = configuredOpenAIOrder?.find(
    (profileId) => typeof profileId === "string" && profileId.trim().length > 0,
  );
  return hasOpenAICodexAuthProfileOverride(firstProfile);
}

export function shouldRouteOpenAIThroughCodexAuthProvider(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  authProfileProvider?: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): boolean {
  if (!isOpenAIProvider(params.provider)) {
    return false;
  }
  const runtime =
    normalizeOptionalAgentRuntimeId(params.agentHarnessId ?? params.harnessRuntime) ??
    OPENCLAW_AGENT_RUNTIME_ID;
  if (runtime !== "openclaw") {
    return false;
  }
  if (!hasOpenAICodexAuthProfileOverride(params.authProfileId)) {
    return false;
  }
  const aliasLookupParams = {
    config: params.config,
    workspaceDir: params.workspaceDir,
  };
  const authProfileProvider = resolveProviderIdForAuth(
    params.authProfileProvider ?? params.authProfileId?.split(":", 1)[0] ?? "",
    aliasLookupParams,
  );
  return authProfileProvider === OPENAI_CODEX_PROVIDER_ID;
}

export function listOpenAIAuthProfileProvidersForAgentRuntime(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  config?: OpenClawConfig;
}): string[] {
  if (!isOpenAIProvider(params.provider)) {
    return [params.provider];
  }
  const runtime =
    normalizeOptionalAgentRuntimeId(
      normalizeExplicitRuntimePin(params.agentHarnessId) ?? params.harnessRuntime,
    ) ?? OPENCLAW_AGENT_RUNTIME_ID;
  if (runtime === "codex") {
    return [OPENAI_CODEX_PROVIDER_ID];
  }
  if (runtime === "openclaw") {
    if (configuredOpenAIAuthOrderStartsWithCodexProfile(params.config)) {
      return [OPENAI_CODEX_PROVIDER_ID, OPENAI_PROVIDER_ID];
    }
    return [OPENAI_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID];
  }
  return [params.provider];
}

function normalizeExplicitRuntimePin(value: unknown): string | undefined {
  const runtime = normalizeOptionalAgentRuntimeId(value);
  return runtime === "auto" || runtime === "default" ? undefined : runtime;
}

export function resolveOpenAIRuntimeProvider(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  authProfileProvider?: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string {
  return shouldRouteOpenAIThroughCodexAuthProvider(params)
    ? OPENAI_CODEX_PROVIDER_ID
    : params.provider;
}

export function resolveSelectedOpenAIRuntimeProvider(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  authProfileProvider?: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string {
  if (shouldRouteOpenAIThroughCodexAuthProvider(params)) {
    return OPENAI_CODEX_PROVIDER_ID;
  }
  const runtime =
    normalizeOptionalAgentRuntimeId(params.agentHarnessId ?? params.harnessRuntime) ??
    OPENCLAW_AGENT_RUNTIME_ID;
  if (!isOpenAIProvider(params.provider)) {
    return params.provider;
  }
  if (runtime === "codex") {
    return OPENAI_CODEX_PROVIDER_ID;
  }
  return runtime === "openclaw" &&
    !params.authProfileId?.trim() &&
    configuredOpenAIAuthOrderStartsWithCodexProfile(params.config)
    ? OPENAI_CODEX_PROVIDER_ID
    : params.provider;
}

export function resolveContextConfigProviderForRuntime(params: {
  provider: string;
  runtimeId?: string;
}): string {
  const provider = normalizeProviderId(params.provider);
  const runtimeId = normalizeOptionalAgentRuntimeId(params.runtimeId) ?? OPENCLAW_AGENT_RUNTIME_ID;
  if (provider === OPENAI_PROVIDER_ID && runtimeId === "codex") {
    return OPENAI_CODEX_PROVIDER_ID;
  }
  return params.provider;
}
