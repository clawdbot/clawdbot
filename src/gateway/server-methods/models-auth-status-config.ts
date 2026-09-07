import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import {
  isNonSecretApiKeyMarker,
  NON_ENV_SECRETREF_MARKER,
} from "../../agents/model-auth-markers.js";
import { resolveProviderEntryApiKeyProfileReference } from "../../agents/model-auth.js";
import type { ProviderAuthAliasLookupParams } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import type { ModelAuthStatusProvider } from "./models-auth-status.types.js";

export function resolveConfigBoundProfileIds(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  authAliasLookupParams?: ProviderAuthAliasLookupParams,
): Set<string> {
  const profileIds = new Set<string>();
  for (const provider of Object.keys(cfg.models?.providers ?? {})) {
    const reference = resolveProviderEntryApiKeyProfileReference({
      cfg,
      authAliasLookupParams,
      provider,
      store,
    });
    if (reference.kind === "profile" || reference.kind === "profile-incompatible") {
      profileIds.add(reference.profileId);
    }
  }
  return profileIds;
}

export function resolveConfiguredProviders(
  config: OpenClawConfig,
  apiKeys: ReadonlyMap<string, ModelAuthStatusProvider["apiKey"]>,
): { providers: string[]; expectsOAuth: Set<string> } {
  const providers = new Set<string>();
  const expectsOAuth = new Set<string>();
  for (const [id, provider] of Object.entries(config.models?.providers ?? {})) {
    const normalized = normalizeProviderId(id);
    if (!normalized) {
      continue;
    }
    const rawKey = typeof provider?.apiKey === "string" ? provider.apiKey.trim() : "";
    const hasApiKey =
      hasConfiguredSecretInput(provider?.apiKey, config.secrets?.defaults) &&
      (rawKey === NON_ENV_SECRETREF_MARKER ||
        !isNonSecretApiKeyMarker(rawKey, { includeEnvVarName: false }));
    const mode = provider?.auth;
    if (mode !== "oauth" && mode !== "token" && !hasApiKey) {
      continue;
    }
    if (!apiKeys.has(normalized)) {
      providers.add(normalized);
      if (mode === "oauth") {
        expectsOAuth.add(normalized);
      }
    }
  }
  for (const profile of Object.values(config.auth?.profiles ?? {})) {
    if (
      typeof profile?.provider !== "string" ||
      profile.provider.length === 0 ||
      (profile.mode !== "oauth" && profile.mode !== "token")
    ) {
      continue;
    }
    const normalized = normalizeProviderId(profile.provider);
    if (!normalized || apiKeys.has(normalized)) {
      continue;
    }
    providers.add(normalized);
    if (profile.mode === "oauth") {
      expectsOAuth.add(normalized);
    }
  }
  return { providers: [...providers], expectsOAuth };
}
