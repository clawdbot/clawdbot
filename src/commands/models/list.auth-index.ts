import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import {
  listProviderEnvAuthLookupKeys,
  resolveProviderEnvAuthEvidence,
  resolveProviderEnvApiKeyCandidates,
} from "../../agents/model-auth-env-vars.js";
import { resolveEnvApiKey } from "../../agents/model-auth-env.js";
import { resolveAwsSdkEnvVarName } from "../../agents/model-auth-runtime-shared.js";
import {
  hasSyntheticLocalProviderAuthConfig,
  hasUsableCustomProviderApiKey,
} from "../../agents/model-auth.js";
import {
  OPENAI_CODEX_PROVIDER_ID,
  openAIProviderUsesCodexRuntimeByDefault,
} from "../../agents/openai-codex-routing.js";
import { resolveProviderAuthAliasMap } from "../../agents/provider-auth-aliases.js";
import { normalizeProviderIdForAuth } from "../../agents/provider-id.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadPluginRegistrySnapshotWithMetadata } from "../../plugins/plugin-registry.js";

export type ModelListAuthIndex = {
  hasProviderAuth(provider: string): boolean;
  allowsProviderAuthAvailabilityFallback(provider: string): boolean;
};

export type CreateModelListAuthIndexParams = {
  cfg: OpenClawConfig;
  authStore: AuthProfileStore;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  syntheticAuthProviderRefs?: readonly string[];
};

function normalizeAuthProvider(
  provider: string,
  aliasMap: Readonly<Record<string, string>>,
): string {
  const normalized = normalizeProviderIdForAuth(provider);
  return aliasMap[normalized] ?? normalized;
}

function listValidatedSyntheticAuthProviderRefs(params: {
  cfg: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}): readonly string[] {
  const result = loadPluginRegistrySnapshotWithMetadata({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  if (result.source !== "persisted" && result.source !== "provided") {
    return [];
  }
  return result.snapshot.plugins
    .filter((plugin) => plugin.enabled)
    .flatMap((plugin) => plugin.syntheticAuthRefs ?? []);
}

export function createModelListAuthIndex(
  params: CreateModelListAuthIndexParams,
): ModelListAuthIndex {
  const env = params.env ?? process.env;
  const lookupParams = {
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    env,
  };
  const aliasMap = resolveProviderAuthAliasMap(lookupParams);
  const envCandidateMap = resolveProviderEnvApiKeyCandidates(lookupParams);
  const authEvidenceMap = resolveProviderEnvAuthEvidence(lookupParams);
  const authenticatedProviders = new Set<string>();
  const syntheticAuthProviders = new Set<string>();
  const envProviderAuthCache = new Map<string, boolean>();
  const addProvider = (provider: string | undefined) => {
    if (!provider?.trim()) {
      return;
    }
    authenticatedProviders.add(normalizeAuthProvider(provider, aliasMap));
  };
  const addSyntheticProvider = (provider: string | undefined) => {
    const normalized = provider?.trim() ? normalizeProviderIdForAuth(provider) : "";
    if (!normalized) {
      return;
    }
    syntheticAuthProviders.add(normalized);
  };

  for (const credential of Object.values(params.authStore.profiles ?? {})) {
    addProvider(credential.provider);
  }

  for (const provider of listProviderEnvAuthLookupKeys({ envCandidateMap, authEvidenceMap })) {
    if (
      resolveEnvApiKey(provider, env, {
        aliasMap,
        candidateMap: envCandidateMap,
        authEvidenceMap,
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
  if (primaryModelProvider === "openai-codex" || primaryModelProvider === "codex") {
    addSyntheticProvider("codex");
  }

  for (const provider of params.syntheticAuthProviderRefs ??
    listValidatedSyntheticAuthProviderRefs({
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      env,
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
        candidateMap: hasPrecomputedCandidates ? envCandidateMap : undefined,
        authEvidenceMap: hasPrecomputedEvidence ? authEvidenceMap : undefined,
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
      }) && authenticatedProviders.has(OPENAI_CODEX_PROVIDER_ID)
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
