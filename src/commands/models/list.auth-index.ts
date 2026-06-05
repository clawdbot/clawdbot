/** Auth availability index for `openclaw models list` rows. */
import { normalizeProviderIdForAuth } from "@openclaw/model-catalog-core/provider-id";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import {
  listProviderEnvAuthLookupKeys,
  resolveProviderEnvAuthLookupMaps,
} from "../../agents/model-auth-env-vars.js";
import { resolveEnvApiKey } from "../../agents/model-auth-env.js";
import { resolveAwsSdkEnvVarName } from "../../agents/model-auth-runtime-shared.js";
import {
  hasSyntheticLocalProviderAuthConfig,
  hasUsableCustomProviderApiKey,
} from "../../agents/model-auth.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  OPENAI_PROVIDER_ID,
  openAIProviderUsesCodexRuntimeByDefault,
} from "../../agents/openai-routing.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { loadPluginRegistrySnapshotWithMetadata } from "../../plugins/plugin-registry.js";

export type ModelListAuthIndex = {
  hasProviderAuth(provider: string): boolean;
  allowsProviderAuthAvailabilityFallback(provider: string): boolean;
};

/** Inputs used to build the auth index without re-reading process-wide state. */
export type CreateModelListAuthIndexParams = {
  cfg: OpenClawConfig;
  authStore: AuthProfileStore;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  syntheticAuthProviderRefs?: readonly string[];
  metadataSnapshot?: PluginMetadataSnapshot;
};

function normalizeAuthProvider(
  provider: string,
  aliasMap: Readonly<Record<string, string>>,
): string {
  const normalized = normalizeProviderIdForAuth(provider);
  return aliasMap[normalized] ?? normalized;
}

function normalizeStoredAuthProvider(
  provider: string,
  aliasMap: Readonly<Record<string, string>>,
): string {
  const normalized = normalizeProviderIdForAuth(provider);
  if (normalized === OPENAI_CODEX_PROVIDER_ID) {
    return normalized;
  }
  return aliasMap[normalized] ?? normalized;
}

function listValidatedSyntheticAuthProviderRefs(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
}): readonly string[] {
  if (params.metadataSnapshot && (params.metadataSnapshot.registryDiagnostics?.length ?? 0) > 0) {
    return [];
  }
  const result = loadPluginRegistrySnapshotWithMetadata({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
    index: params.metadataSnapshot?.index,
  });
  if (result.source !== "persisted" && result.source !== "provided") {
    return [];
  }
  return result.snapshot.plugins
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.syntheticAuthRefs ?? []);
}

/** Builds a provider-auth lookup from profiles, env, config, and synthetic plugin refs. */
export function createModelListAuthIndex(
  params: CreateModelListAuthIndexParams,
): ModelListAuthIndex {
  const env = params.env ?? process.env;
  const lookupParams = {
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env,
    metadataSnapshot: params.metadataSnapshot,
  };
  const { aliasMap, envCandidateMap, authEvidenceMap } =
    resolveProviderEnvAuthLookupMaps(lookupParams);
  const skipSetupProviderFallback = params.metadataSnapshot !== undefined;
  const authenticatedProviders = new Set<string>();
  const syntheticAuthProviders = new Set<string>();
  const envProviderAuthCache = new Map<string, boolean>();
  const credentialAuthsProvider = (credential: AuthProfileCredential): boolean => {
    const normalizedProvider = normalizeStoredAuthProvider(credential.provider, aliasMap);
    if (normalizedProvider !== OPENAI_PROVIDER_ID) {
      return true;
    }
    if (credential.type === "api_key") {
      return true;
    }
    if (credential.type !== "oauth" && credential.type !== "token") {
      return false;
    }
    // OpenAI OAuth/token profiles only authenticate provider rows when config
    // routes OpenAI through Codex runtime semantics.
    return openAIProviderUsesCodexRuntimeByDefault({
      provider: normalizedProvider,
      config: params.cfg,
    });
  };
  const addProvider = (provider: string | undefined) => {
    if (!provider?.trim()) {
      return;
    }
    authenticatedProviders.add(normalizeStoredAuthProvider(provider, aliasMap));
  };
  const addSyntheticProvider = (provider: string | undefined) => {
    const normalized = provider?.trim() ? normalizeProviderIdForAuth(provider) : "";
    if (!normalized) {
      return;
    }
    syntheticAuthProviders.add(normalized);
  };

  for (const credential of Object.values(params.authStore.profiles ?? {})) {
    if (credentialAuthsProvider(credential)) {
      addProvider(credential.provider);
    }
  }

  for (const provider of listProviderEnvAuthLookupKeys({ envCandidateMap, authEvidenceMap })) {
    if (
      resolveEnvApiKey(provider, env, {
        aliasMap,
        candidateMap: envCandidateMap,
        authEvidenceMap,
        skipSetupProviderFallback,
        config: params.cfg,
        workspaceDir: params.workspaceDir,
      })
    ) {
      addProvider(provider);
    }
  }

  if (resolveAwsSdkEnvVarName(env)) {
    addProvider("amazon-bedrock");
  }

  for (const provider of Object.keys(params.cfg.models?.providers ?? {})) {
    if (
      hasUsableCustomProviderApiKey(params.cfg, provider, env) ||
      hasSyntheticLocalProviderAuthConfig({ cfg: params.cfg, provider })
    ) {
      addProvider(provider);
    }
  }
  const primaryModelProvider = resolveAgentModelPrimaryValue(
    params.cfg.agents?.defaults?.model,
  )?.split("/", 1)[0];
  if (primaryModelProvider === "codex") {
    // A Codex primary model is a synthetic provider auth signal even when no
    // normal provider key exists in the profile store.
    addSyntheticProvider("codex");
  }

  for (const provider of params.syntheticAuthProviderRefs ??
    listValidatedSyntheticAuthProviderRefs({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      env,
      metadataSnapshot: params.metadataSnapshot,
    })) {
    addSyntheticProvider(provider);
  }

  const hasEnvProviderAuth = (provider: string): boolean => {
    const normalized = normalizeAuthProvider(provider, aliasMap);
    const cached = envProviderAuthCache.get(normalized);
    if (cached !== undefined) {
      return cached;
    }
    const hasPrecomputedCandidates = Object.hasOwn(envCandidateMap, normalized);
    const hasPrecomputedEvidence = Object.hasOwn(authEvidenceMap, normalized);
    const hasAuth = Boolean(
      resolveEnvApiKey(provider, env, {
        aliasMap,
        candidateMap:
          skipSetupProviderFallback || hasPrecomputedCandidates ? envCandidateMap : undefined,
        authEvidenceMap:
          skipSetupProviderFallback || hasPrecomputedEvidence ? authEvidenceMap : undefined,
        skipSetupProviderFallback,
        config: params.cfg,
        workspaceDir: params.workspaceDir,
      }),
    );
    envProviderAuthCache.set(normalized, hasAuth);
    if (hasAuth) {
      authenticatedProviders.add(normalized);
    }
    return hasAuth;
  };

  const hasOpenAICodexRuntimeAuth = (provider: string): boolean => {
    const normalizedProvider = normalizeAuthProvider(provider, aliasMap);
    return (
      openAIProviderUsesCodexRuntimeByDefault({
        provider: normalizedProvider,
        config: params.cfg,
      }) &&
      (authenticatedProviders.has(OPENAI_PROVIDER_ID) ||
        authenticatedProviders.has(OPENAI_CODEX_PROVIDER_ID))
    );
  };

  return {
    hasProviderAuth(provider: string): boolean {
      const normalizedProvider = normalizeAuthProvider(provider, aliasMap);
      const hasDirectAuth =
        authenticatedProviders.has(normalizedProvider) ||
        syntheticAuthProviders.has(normalizeProviderIdForAuth(provider)) ||
        hasEnvProviderAuth(provider);
      if (hasDirectAuth) {
        return true;
      }
      return hasOpenAICodexRuntimeAuth(normalizedProvider);
    },
    allowsProviderAuthAvailabilityFallback(provider: string): boolean {
      return hasOpenAICodexRuntimeAuth(provider);
    },
  };
}
