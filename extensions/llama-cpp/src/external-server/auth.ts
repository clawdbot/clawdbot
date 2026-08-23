import {
  CUSTOM_LOCAL_AUTH_MARKER,
  hasConfiguredSecretInput,
  isNonSecretApiKeyMarker,
  normalizeOptionalSecretInput,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { LLAMA_CPP_PROVIDER_ID, resolveLlamaCppSyntheticApiKey } from "../defaults.js";

export function hasLlamaServerAuthorizationHeader(headers: unknown): boolean {
  const record = asOptionalRecord(headers);
  if (!record) {
    return false;
  }
  return Object.entries(record).some(
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
    apiKey !== resolveLlamaCppSyntheticApiKey() &&
    apiKey !== CUSTOM_LOCAL_AUTH_MARKER;
  return !hasRealApiKey;
}

export async function resolveLlamaServerProviderHeaders(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  headers?: unknown;
}): Promise<Record<string, string> | undefined> {
  const headers = asOptionalRecord(params.headers);
  if (!headers) {
    return undefined;
  }
  const resolved: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!params.config) {
      if (typeof value === "string" && value.trim()) {
        resolved[name] = value.trim();
      }
      continue;
    }
    const path = `models.providers.${LLAMA_CPP_PROVIDER_ID}.headers.${name}`;
    const header = await resolveConfiguredSecretInputString({
      config: params.config,
      env: params.env ?? process.env,
      value,
      path,
      unresolvedReasonStyle: "detailed",
    });
    if (header.unresolvedRefReason) {
      throw new Error(`${path}: ${header.unresolvedRefReason}`);
    }
    if (header.value) {
      resolved[name] = header.value;
    }
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

export async function resolveLlamaServerRuntimeApiKey(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  profileId?: string;
}): Promise<string | undefined> {
  const auth = await resolveApiKeyForProvider({
    provider: LLAMA_CPP_PROVIDER_ID,
    cfg: params.config,
    agentDir: params.agentDir,
    profileId: params.profileId,
    lockedProfile: params.profileId !== undefined,
  });
  const apiKey = auth.apiKey?.trim();
  return apiKey && !isNonSecretApiKeyMarker(apiKey) ? apiKey : undefined;
}
