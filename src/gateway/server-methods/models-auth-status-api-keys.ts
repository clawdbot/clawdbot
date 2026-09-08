import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import {
  listProviderEnvAuthLookupKeys,
  resolveProviderEnvAuthLookupMaps,
} from "../../agents/model-auth-env-vars.js";
import { resolveProviderEnvAuthEvidence } from "../../agents/model-auth-env.js";
import {
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
} from "../../agents/model-auth-markers.js";
import { resolveProviderConfigSecretInput } from "../../agents/model-auth-provider-config.js";
import {
  resolveProviderEntryApiKeyProfileReference,
  resolveUsableCustomProviderApiKey,
} from "../../agents/model-auth.js";
import type { ProviderAuthAliasLookupParams } from "../../agents/provider-auth-aliases.js";
import type { OpenClawConfig } from "../../config/config.js";
import { hasConfiguredSecretInput } from "../../config/types.secrets.js";
import type { readPreparedCatalog } from "../server-model-catalog-auth.js";
import type { ModelAuthStatusProvider } from "./models-auth-status.types.js";

type PreparedAuthMetadataLookupParams = ProviderAuthAliasLookupParams & {
  metadataSnapshot: NonNullable<
    Awaited<ReturnType<typeof readPreparedCatalog>>
  >["metadataSnapshot"];
};

function resolveEnvVarName(source: string): string | undefined {
  const match = /^(?:shell env|env): ([A-Z][A-Z0-9_]*)$/u.exec(source);
  return match?.[1];
}

export function resolveProviderApiKeys(
  cfg: OpenClawConfig,
  store: AuthProfileStore,
  authAliasLookupParams: PreparedAuthMetadataLookupParams,
): Map<string, ModelAuthStatusProvider["apiKey"]> {
  const lookupMaps = resolveProviderEnvAuthLookupMaps({
    ...authAliasLookupParams,
    config: cfg,
    env: process.env,
  });
  const providerIds = new Set<string>([
    ...Object.keys(cfg.models?.providers ?? {}),
    ...Object.values(cfg.auth?.profiles ?? {})
      .map((profile) => profile?.provider)
      .filter((provider): provider is string => typeof provider === "string"),
    ...listProviderEnvAuthLookupKeys(lookupMaps),
  ]);
  const apiKeys = new Map<string, ModelAuthStatusProvider["apiKey"]>();
  for (const rawProvider of providerIds) {
    const provider = normalizeProviderId(rawProvider);
    if (!provider) {
      continue;
    }
    const { providerConfig, ref } = resolveProviderConfigSecretInput(cfg, provider);
    if (hasConfiguredSecretInput(providerConfig?.apiKey, cfg.secrets?.defaults)) {
      const profileReference = resolveProviderEntryApiKeyProfileReference({
        cfg,
        authAliasLookupParams,
        provider,
        store,
      });
      if (profileReference.kind !== "profile" && profileReference.kind !== "profile-incompatible") {
        if (ref && ref.source !== "env") {
          apiKeys.set(provider, { source: "config" });
          continue;
        }
        const available = resolveUsableCustomProviderApiKey({ cfg, provider, env: process.env });
        if (available) {
          const rawKey =
            typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey.trim() : "";
          if (rawKey && isNonSecretApiKeyMarker(rawKey, { includeEnvVarName: false })) {
            continue;
          }
          const envVar =
            ref?.source === "env"
              ? ref.id
              : profileReference.kind === "marker" && isKnownEnvApiKeyMarker(rawKey)
                ? rawKey
                : resolveEnvVarName(available.source);
          apiKeys.set(provider, envVar ? { source: "env", envVar } : { source: "config" });
          continue;
        }
      }
    }
    const envEvidence = resolveProviderEnvAuthEvidence(provider, process.env, {
      aliasMap: lookupMaps.aliasMap,
      candidateMap: lookupMaps.envCandidateMap,
      authEvidenceMap: lookupMaps.authEvidenceMap,
    });
    if (envEvidence?.mode === "api-key") {
      const envVar = resolveEnvVarName(envEvidence.source);
      apiKeys.set(provider, { source: "env", ...(envVar ? { envVar } : {}) });
    }
  }
  return apiKeys;
}
