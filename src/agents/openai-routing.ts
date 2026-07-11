/**
 * OpenAI provider routing decisions shared by model selection, auth profiles, and runtime setup.
 *
 * Custom OpenAI-compatible base URLs intentionally bypass Codex-runtime defaults.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderRouteOverridePresence } from "../plugin-sdk/provider-model-types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { hasModelExtraParams } from "./model-extra-params.js";
import { resolveModelRuntimePolicy } from "./model-runtime-policy.js";
import { resolveOpenAIModelRoutes } from "./openai-model-routes.js";
import { canonicalizeProviderModelId } from "./provider-model-route.js";

/** Canonical provider id for OpenAI-hosted model routes. */
export const OPENAI_PROVIDER_ID = "openai";
export const OPENAI_CODEX_PROVIDER_ID = OPENAI_PROVIDER_ID;

/** Returns true for provider ids that normalize to OpenAI. */
export function isOpenAIProvider(provider: string | undefined): boolean {
  const normalized = normalizeProviderId(provider ?? "");
  return normalized === OPENAI_PROVIDER_ID;
}

/** Canonicalizes shipped OpenAI model aliases at runtime boundaries. */
export function canonicalizeOpenAIModelId(provider: string | undefined, modelId: string): string {
  return isOpenAIProvider(provider)
    ? canonicalizeProviderModelId(OPENAI_PROVIDER_ID, modelId)
    : modelId;
}

/** Resolves the provider-owned implicit runtime for one concrete OpenAI route. */
export function resolveOpenAIImplicitAgentRuntime(params: {
  provider?: string;
  modelId?: string;
  api?: string | null;
  baseUrl?: unknown;
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  env?: Readonly<Record<string, string | undefined>>;
  requestTransportOverrides?: ProviderRouteOverridePresence;
}): "codex" | "openclaw" | null {
  if (!isOpenAIProvider(params.provider)) {
    return null;
  }
  const modelId = params.modelId;
  const agentId =
    params.agentId ??
    (params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined);
  const hasConfiguredParams = hasModelExtraParams({
    config: params.config,
    provider: params.provider ?? OPENAI_PROVIDER_ID,
    modelId,
    agentId,
  });
  const requestTransportOverrides =
    params.requestTransportOverrides === "present" || hasConfiguredParams ? "present" : "none";
  const resolution = resolveOpenAIModelRoutes({
    provider: params.provider,
    modelId,
    api: params.api,
    baseUrl: params.baseUrl,
    config: params.config,
    env: params.env,
    requestTransportOverrides,
  });
  if (!resolution) {
    // Endpoint and adapter ownership stays in the provider artifact. Without
    // that policy, keep credentials and traffic on the core OpenClaw runtime.
    return "openclaw";
  }
  return resolution.kind !== "incompatible" && resolution.defaultRuntimeId === "codex"
    ? "codex"
    : "openclaw";
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
  return (
    resolveOpenAIImplicitAgentRuntime({
      provider,
      modelId,
      config: params.config,
      agentId: params.agentId,
    }) === "codex"
  );
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
