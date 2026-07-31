import {
  CUSTOM_LOCAL_AUTH_MARKER,
  hasConfiguredSecretInput,
  isNonSecretApiKeyMarker,
  normalizeOptionalSecretInput,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { LLAMA_SERVER_LOCAL_AUTH_MARKER, LLAMA_SERVER_PROVIDER_ID } from "./defaults.js";

export function hasLlamaServerAuthorizationHeader(headers: unknown): boolean {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return false;
  }
  return Object.entries(headers).some(
    ([name, value]) =>
      name.trim().toLowerCase() === "authorization" && hasConfiguredSecretInput(value),
  );
}

export function shouldUseLlamaServerSyntheticAuth(
  providerConfig: ModelProviderConfig | undefined,
): boolean {
  const apiKey = normalizeOptionalSecretInput(providerConfig?.apiKey)?.trim();
  const hasRealApiKey =
    hasConfiguredSecretInput(providerConfig?.apiKey) &&
    apiKey !== LLAMA_SERVER_LOCAL_AUTH_MARKER &&
    apiKey !== CUSTOM_LOCAL_AUTH_MARKER;
  return !hasRealApiKey && !hasLlamaServerAuthorizationHeader(providerConfig?.headers);
}

export function buildLlamaServerAuthHeaders(apiKey?: string): Record<string, string> {
  const normalized = apiKey?.trim();
  return {
    Accept: "application/json",
    ...(normalized && !isNonSecretApiKeyMarker(normalized)
      ? { Authorization: `Bearer ${normalized}` }
      : {}),
  };
}

export async function resolveLlamaServerRuntimeApiKey(params: {
  config?: OpenClawConfig;
  agentDir?: string;
}): Promise<string | undefined> {
  const auth = await resolveApiKeyForProvider({
    provider: LLAMA_SERVER_PROVIDER_ID,
    cfg: params.config,
    agentDir: params.agentDir,
  });
  const apiKey = auth.apiKey?.trim();
  return apiKey && !isNonSecretApiKeyMarker(apiKey) ? apiKey : undefined;
}
