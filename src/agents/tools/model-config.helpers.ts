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
} from "../auth-profiles.js";
import type { AuthProfileCredential, AuthProfileStore } from "../auth-profiles/types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { hasUsableCustomProviderApiKey, resolveEnvApiKey } from "../model-auth.js";
import { resolveConfiguredModelRef } from "../model-selection.js";

export type ToolModelConfig = { primary?: string; fallbacks?: string[]; timeoutMs?: number };

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
  agentDir?: string;
  authStore?: AuthProfileStore;
}): boolean {
  if (resolveEnvApiKey(params.provider)?.apiKey) {
    return true;
  }
  return hasAuthProfileForProvider({ ...params, includeExternalCli: true });
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
    hasAuthForProvider({
      provider: params.provider,
      agentDir: params.agentDir,
      authStore: params.authStore,
    })
  ) {
    return true;
  }
  return hasUsableCustomProviderApiKey(params.cfg, params.provider);
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
  isProviderConfigured?: (provider: string) => boolean;
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
