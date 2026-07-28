/**
 * Tool model config and auth helpers.
 *
 * Model-backed tools use this module to choose provider/model refs and check
 * whether candidate providers have usable auth before exposing defaults.
 */
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
  resolveAgentModelTimeoutMsValue,
} from "../../config/model-input.js";
import type { AgentToolModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  externalCliDiscoveryForProviderAuth,
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  hasAnyAuthProfileStoreSource,
  listProfilesForProvider,
  resolveAuthProfileOrder,
} from "../auth-profiles.js";
import { evaluateStoredCredentialEligibility } from "../auth-profiles/credential-state.js";
import { resolveExternalCliAuthProfiles } from "../auth-profiles/external-cli-sync.js";
import { overlayRuntimeExternalOAuthProfiles } from "../auth-profiles/oauth-shared.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import {
  hasRuntimeAvailableProviderAuth,
  resolveProviderEntryApiKeyProfileReference,
  resolveEnvApiKey,
} from "../model-auth.js";
import { resolveConfiguredModelRef } from "../model-selection.js";

export type ToolModelConfig = { primary?: string; fallbacks?: string[]; timeoutMs?: number };

const OPENAI_PROVIDER_ID = "openai";
const CODEX_MEDIA_PROVIDER_ID = "codex";
const OPENAI_RESPONSES_MODEL_API = "openai-responses";

type OpenAiImageMediaCandidateDecision =
  | { kind: "keep"; ref: string }
  | { kind: "substitute"; ref: string; provider: string }
  | { kind: "drop" };

/** Returns whether a tool model config contains a primary or fallback model ref. */
export function hasToolModelConfig(model: ToolModelConfig | undefined): boolean {
  return Boolean(
    model?.primary?.trim() || (model?.fallbacks ?? []).some((entry) => entry.trim().length > 0),
  );
}

/** Resolves the configured default model ref, falling back to OpenClaw defaults. */
export function resolveDefaultModelRef(cfg?: OpenClawConfig): { provider: string; model: string } {
  if (cfg) {
    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    return { provider: resolved.provider, model: resolved.model };
  }
  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}

/** Returns whether a provider has env, profile, or external CLI auth available. */
export function hasAuthForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): boolean {
  // Env-key resolution is config/workspace aware: plugin-provider env candidates
  // come from the metadata snapshot resolved for this config. Non-bundled or
  // config-scoped provider plugins are invisible without it, so a config-blind
  // lookup would wrongly report "no auth" for env-key providers.
  if (
    resolveEnvApiKey(params.provider, undefined, {
      config: params.cfg,
      workspaceDir: params.workspaceDir,
    })?.apiKey
  ) {
    return true;
  }
  return hasAuthProfileForProvider({
    provider: params.provider,
    agentDir: params.agentDir,
    authStore: params.authStore,
    includeExternalCli: true,
  });
}

/** Returns whether an auth profile exists for a provider, optionally filtered by type. */
export function hasAuthProfileForProvider(params: {
  provider: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  includeExternalCli?: boolean;
  type?: AuthProfileCredential["type"];
}): boolean {
  let store = params.authStore;
  if (!store) {
    const agentDir = params.agentDir?.trim();
    if (!agentDir) {
      return false;
    }
    if (!hasAnyAuthProfileStoreSource(agentDir)) {
      return false;
    }
    // Only include external CLI profiles when callers explicitly want live
    // provider availability, not when checking stored profile shape.
    store = params.includeExternalCli
      ? ensureAuthProfileStore(agentDir, {
          externalCli: externalCliDiscoveryForProviderAuth({ provider: params.provider }),
        })
      : ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
        });
  }
  const profileIds = listProfilesForProvider(store, params.provider);
  if (!params.type) {
    return profileIds.length > 0;
  }
  return profileIds.some((profileId) => store.profiles[profileId]?.type === params.type);
}

/** Returns whether a provider can be used by a model-backed tool. */
export function hasProviderAuthForTool(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): boolean {
  if (
    hasRuntimeAvailableProviderAuth({
      provider: params.provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      allowPluginSyntheticAuth: false,
    })
  ) {
    return true;
  }
  if (
    hasAuthForProvider({
      provider: params.provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      authStore: params.authStore,
    })
  ) {
    return true;
  }
  return false;
}

function formatProviderModelRef(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function loadAuthStoreForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  includeExternalCli?: boolean;
}): AuthProfileStore | undefined {
  if (params.authStore) {
    return params.authStore;
  }
  const agentDir = params.agentDir?.trim();
  if (!agentDir) {
    return undefined;
  }
  return params.includeExternalCli
    ? ensureAuthProfileStore(agentDir, {
        externalCli: externalCliDiscoveryForProviderAuth({
          provider: params.provider,
          cfg: params.cfg,
        }),
      })
    : ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
        allowKeychainPrompt: false,
      });
}

function overlayExternalCliAuthStoreForProvider(params: {
  provider: string;
  authStore: AuthProfileStore;
}): AuthProfileStore {
  const profiles = resolveExternalCliAuthProfiles(params.authStore, {
    allowKeychainPrompt: false,
    providerIds: [params.provider],
  });
  if (profiles.length === 0) {
    return params.authStore;
  }
  return overlayRuntimeExternalOAuthProfiles(params.authStore, profiles);
}

function hasAuthProfileTypeInStore(params: {
  provider: string;
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  type: AuthProfileCredential["type"] | readonly AuthProfileCredential["type"][];
}): boolean {
  const types = Array.isArray(params.type) ? params.type : [params.type];
  return resolveAuthProfileOrder({
    cfg: params.cfg,
    store: params.store,
    provider: params.provider,
  }).some((profileId) => types.includes(params.store.profiles[profileId]?.type));
}

function hasAuthProfileTypeForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
  includeExternalCli?: boolean;
  type: AuthProfileCredential["type"] | readonly AuthProfileCredential["type"][];
}): boolean {
  const store = loadAuthStoreForProvider(params);
  if (store && hasAuthProfileTypeInStore({ ...params, store })) {
    return true;
  }
  // Codex-harness tool construction can pass a scoped store with external CLI
  // profiles stripped. Keep that store authoritative, but still honor explicit
  // includeExternalCli lookups so Codex OAuth-only image routing remains visible.
  if (params.includeExternalCli && params.authStore) {
    const externalStore = overlayExternalCliAuthStoreForProvider({
      provider: params.provider,
      authStore: params.authStore,
    });
    return hasAuthProfileTypeInStore({ ...params, store: externalStore });
  }
  return false;
}

/** Returns whether a provider has direct API-key-capable auth for model-backed tools. */
function hasDirectProviderApiKeyAuthForTool(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  modelApi?: string;
}): boolean {
  const providerEntryProfileAuth = resolveDirectProviderEntryAuthFromProfileReference(params);
  if (providerEntryProfileAuth !== undefined) {
    return providerEntryProfileAuth;
  }
  if (
    hasRuntimeAvailableProviderAuth({
      provider: params.provider,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      modelApi: params.modelApi,
      allowPluginSyntheticAuth: false,
    })
  ) {
    return true;
  }
  return hasAuthProfileTypeForProvider({
    provider: params.provider,
    cfg: params.cfg,
    agentDir: params.agentDir,
    authStore: params.authStore,
    type: "api_key",
  });
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.modelConfigHelpersTestApi")] = {
    hasDirectProviderApiKeyAuthForTool,
  };
}

function hasCanonicalOpenAiCodexAuthSignal(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): boolean {
  return hasAuthProfileTypeForProvider({
    provider: OPENAI_PROVIDER_ID,
    cfg: params.cfg,
    agentDir: params.agentDir,
    authStore: params.authStore,
    includeExternalCli: true,
    type: ["oauth", "token"],
  });
}

function resolveDirectProviderEntryAuthFromProfileReference(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
  authStore?: AuthProfileStore;
}): boolean | undefined {
  const resolveFromStore = (store: AuthProfileStore): boolean | undefined => {
    const reference = resolveProviderEntryApiKeyProfileReference({
      cfg: params.cfg,
      provider: params.provider,
      store,
    });
    if (reference.kind === "profile") {
      return (
        reference.credential.type === "api_key" &&
        evaluateStoredCredentialEligibility({ credential: reference.credential }).eligible
      );
    }
    if (reference.kind === "profile-incompatible") {
      return false;
    }
    return undefined;
  };

  const store = loadAuthStoreForProvider({
    provider: params.provider,
    cfg: params.cfg,
    agentDir: params.agentDir,
    authStore: params.authStore,
    includeExternalCli: true,
  });
  const storeResult = store ? resolveFromStore(store) : undefined;
  if (storeResult !== undefined) {
    return storeResult;
  }
  if (params.authStore) {
    const externalStore = overlayExternalCliAuthStoreForProvider({
      provider: params.provider,
      authStore: params.authStore,
    });
    return resolveFromStore(externalStore);
  }
  return undefined;
}

/** Resolves the implicit OpenAI image slot without letting OAuth-only auth pick direct OpenAI. */
export function resolveOpenAiImageMediaCandidate(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir: string;
  authStore?: AuthProfileStore;
  openAiModel: string;
  resolveCodexMediaRoute?: () => { model: string } | undefined;
}): OpenAiImageMediaCandidateDecision {
  const openAiModel = params.openAiModel.trim();
  if (!openAiModel) {
    return { kind: "drop" };
  }
  if (
    hasDirectProviderApiKeyAuthForTool({
      provider: OPENAI_PROVIDER_ID,
      cfg: params.cfg,
      workspaceDir: params.workspaceDir,
      agentDir: params.agentDir,
      authStore: params.authStore,
      modelApi: OPENAI_RESPONSES_MODEL_API,
    })
  ) {
    return {
      kind: "keep",
      ref: formatProviderModelRef(OPENAI_PROVIDER_ID, openAiModel),
    };
  }

  // Check canonical subscription auth before resolving plugin capability so a
  // fresh install cannot route there from bundled-plugin presence alone.
  if (!hasCanonicalOpenAiCodexAuthSignal(params)) {
    return { kind: "drop" };
  }
  const codexModel = params.resolveCodexMediaRoute?.()?.model.trim();
  if (codexModel) {
    return {
      kind: "substitute",
      provider: CODEX_MEDIA_PROVIDER_ID,
      ref: formatProviderModelRef(CODEX_MEDIA_PROVIDER_ID, codexModel),
    };
  }

  return { kind: "drop" };
}

/** Normalizes agent tool model config into a compact runtime shape. */
export function coerceToolModelConfig(model?: AgentToolModelConfig): ToolModelConfig {
  const primary = resolveAgentModelPrimaryValue(model);
  const fallbacks = resolveAgentModelFallbackValues(model);
  const timeoutMs = resolveAgentModelTimeoutMsValue(model);
  return {
    ...(primary?.trim() ? { primary: primary.trim() } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
}

/** Builds a tool model config from configured auth-aware candidate model refs. */
export function buildToolModelConfigFromCandidates(params: {
  explicit: ToolModelConfig;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  agentDir?: string;
  authStore?: AuthProfileStore;
  candidates: Array<string | null | undefined>;
  isProviderConfigured?: (provider: string) => boolean | undefined;
}): ToolModelConfig | null {
  if (hasToolModelConfig(params.explicit)) {
    return params.explicit;
  }

  const deduped: string[] = [];
  for (const candidate of params.candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed || !trimmed.includes("/")) {
      continue;
    }
    const provider = trimmed.slice(0, trimmed.indexOf("/")).trim();
    // Candidate defaults are only surfaced when the provider is configured or
    // has auth, so tools do not advertise unusable model refs.
    const providerConfigured =
      params.isProviderConfigured?.(provider) ??
      hasProviderAuthForTool({
        provider,
        cfg: params.cfg,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        authStore: params.authStore,
      });
    if (!provider || !providerConfigured) {
      continue;
    }
    if (!deduped.includes(trimmed)) {
      deduped.push(trimmed);
    }
  }

  if (deduped.length === 0) {
    return null;
  }

  return {
    primary: deduped[0],
    ...(deduped.length > 1 ? { fallbacks: deduped.slice(1) } : {}),
    ...(params.explicit.timeoutMs !== undefined ? { timeoutMs: params.explicit.timeoutMs } : {}),
  };
}
