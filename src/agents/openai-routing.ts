/**
 * OpenAI provider routing decisions shared by model selection, auth profiles, and runtime setup.
 *
 * Custom OpenAI-compatible base URLs intentionally bypass Codex-runtime defaults.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";

/** Canonical provider id for OpenAI-hosted model routes. */
export const OPENAI_PROVIDER_ID = "openai";
export const OPENAI_CODEX_PROVIDER_ID = OPENAI_PROVIDER_ID;

// OpenAI defaults to Codex runtime only for the official API endpoint. Custom
// base URLs keep their configured provider behavior.
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

function resolveOpenAIProviderConfig(config: OpenClawConfig | undefined) {
  const providers = config?.models?.providers;
  if (!providers) {
    return undefined;
  }
  const direct = providers.openai;
  if (direct) {
    return direct;
  }
  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (normalizeProviderId(providerId) === OPENAI_PROVIDER_ID) {
      return providerConfig;
    }
  }
  return undefined;
}

function openAIProviderUsesCustomBaseUrl(config: OpenClawConfig | undefined): boolean {
  return !isOfficialOpenAIBaseUrl(resolveOpenAIProviderConfig(config)?.baseUrl);
}

/** Returns true for provider ids that normalize to OpenAI. */
export function isOpenAIProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderId(provider ?? "");
  return normalized === OPENAI_PROVIDER_ID;
}

/** Returns whether OpenAI should use the Codex runtime default for this config. */
export function openAIProviderUsesCodexRuntimeByDefault(params: {
  provider?: string;
  config?: OpenClawConfig;
}): boolean {
  return isOpenAIProvider(params.provider) && !openAIProviderUsesCustomBaseUrl(params.config);
}

/** Parses the provider portion from a provider/model ref. */
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

/** Returns true when selected model config should ensure the Codex plugin exists. */
export function modelSelectionShouldEnsureCodexPlugin(params: {
  model?: string;
  config?: OpenClawConfig;
  agentId?: string;
}): boolean {
  const provider = parseModelRefProvider(params.model);
  if (provider !== OPENAI_PROVIDER_ID) {
    return false;
  }
  const modelRef = params.model?.trim();
  const slashIndex = modelRef?.indexOf("/") ?? -1;
  const modelId = slashIndex >= 0 ? modelRef?.slice(slashIndex + 1) : undefined;
  const configuredRuntime = normalizeOptionalAgentRuntimeId(
    resolveModelRuntimePolicy({
      config: params.config,
      provider,
      modelId,
      agentId: params.agentId,
    }).policy?.id,
  );
  if (configuredRuntime && !isDefaultAgentRuntimeId(configuredRuntime)) {
    return configuredRuntime === "codex";
  }
  return !openAIProviderUsesCustomBaseUrl(params.config);
}

/** Lists auth-profile providers for an OpenAI runtime route. */
export function listOpenAIAuthProfileProvidersForAgentRuntime(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  config?: OpenClawConfig;
}): string[] {
  if (!isOpenAIProvider(params.provider)) {
    return [params.provider];
  }
  return [OPENAI_PROVIDER_ID];
}

/** Resolves the provider id passed to OpenAI runtime auth/execution paths. */
export function resolveOpenAIRuntimeProvider(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  authProfileProvider?: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string {
  return isOpenAIProvider(params.provider) ? OPENAI_PROVIDER_ID : params.provider;
}

/** Resolves the selected provider id displayed for OpenAI runtime routes. */
export function resolveSelectedOpenAIRuntimeProvider(params: {
  provider: string;
  harnessRuntime?: string;
  agentHarnessId?: string;
  authProfileProvider?: string;
  authProfileId?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
}): string {
  return isOpenAIProvider(params.provider) ? OPENAI_PROVIDER_ID : params.provider;
}

/** Resolves the config provider used for context-window lookup. */
export function resolveContextConfigProviderForRuntime(params: {
  provider: string;
  runtimeId?: string;
  config?: OpenClawConfig;
}): string {
  return isOpenAIProvider(params.provider) ? OPENAI_PROVIDER_ID : params.provider;
}
