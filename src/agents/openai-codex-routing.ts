import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { normalizeEmbeddedAgentRuntime } from "./pi-embedded-runner/runtime.js";
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

export function shouldRouteOpenAIPiThroughCodexAuthProvider(params: {
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
  const runtime = normalizeEmbeddedAgentRuntime(params.agentHarnessId ?? params.harnessRuntime);
  if (runtime !== "pi") {
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
  const runtime = normalizeEmbeddedAgentRuntime(
    normalizeExplicitRuntimePin(params.agentHarnessId) ?? params.harnessRuntime,
  );
  if (runtime === "codex") {
    return [OPENAI_CODEX_PROVIDER_ID];
  }
  if (runtime === "pi") {
    if (configuredOpenAIAuthOrderStartsWithCodexProfile(params.config)) {
      return [OPENAI_CODEX_PROVIDER_ID, OPENAI_PROVIDER_ID];
    }
    return [OPENAI_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID];
  }
  return [params.provider];
}

function normalizeExplicitRuntimePin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  const runtime = normalizeEmbeddedAgentRuntime(value);
  return runtime === "auto" || runtime === "default" ? undefined : runtime;
}

export function resolveOpenAIRuntimeProviderForPi(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  authProfileProvider?: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string {
  return shouldRouteOpenAIPiThroughCodexAuthProvider(params)
    ? OPENAI_CODEX_PROVIDER_ID
    : params.provider;
}

export function resolveSelectedOpenAIPiRuntimeProvider(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  authProfileProvider?: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string {
  if (shouldRouteOpenAIPiThroughCodexAuthProvider(params)) {
    return OPENAI_CODEX_PROVIDER_ID;
  }
  const runtime = normalizeEmbeddedAgentRuntime(params.agentHarnessId ?? params.harnessRuntime);
  if (!isOpenAIProvider(params.provider)) {
    return params.provider;
  }
  if (runtime === "codex") {
    return OPENAI_CODEX_PROVIDER_ID;
  }
  return runtime === "pi" &&
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
  const runtimeId = normalizeEmbeddedAgentRuntime(params.runtimeId);
  if (provider === OPENAI_PROVIDER_ID && runtimeId === "codex") {
    return OPENAI_CODEX_PROVIDER_ID;
  }
  return params.provider;
}
