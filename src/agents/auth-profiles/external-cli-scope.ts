/**
 * External CLI auth discovery scope extraction from config.
 * Collects provider/profile ids from configured models, runtimes, auth order,
 * and agent defaults to limit CLI credential probing.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Provider/profile ids that may need external CLI auth discovery. */
export type ExternalCliAuthScope = {
  providerIds: string[];
  profileIds: string[];
};

// Include both raw and normalized provider ids so config aliases and canonical
// provider ids can both match external CLI auth providers.
function addProviderScopeId(out: Set<string>, value: string | undefined): void {
  const raw = value?.trim();
  if (!raw) {
    return;
  }
  out.add(raw);
  const normalized = normalizeProviderId(raw);
  if (normalized) {
    out.add(normalized);
  }
}

// Model refs are provider/model strings. Only the provider prefix matters for
// deciding which external CLI auth source may be queried.
function addProviderScopeFromModelRef(out: Set<string>, value: string | undefined): void {
  const raw = value?.trim();
  if (!raw) {
    return;
  }
  const slash = raw.indexOf("/");
  if (slash <= 0) {
    return;
  }
  addProviderScopeId(out, raw.slice(0, slash));
}

function addProviderScopeFromModelConfig(out: Set<string>, model: AgentModelConfig | undefined) {
  addProviderScopeFromModelRef(out, resolveAgentModelPrimaryValue(model));
  for (const fallback of resolveAgentModelFallbackValues(model)) {
    addProviderScopeFromModelRef(out, fallback);
  }
}

// Some runtime ids imply an external CLI auth source even when the model ref is
// not provider-qualified, so include known CLI runtimes in provider scope.
function addExternalCliRuntimeScope(out: Set<string>, value: string | undefined): void {
  const normalized = normalizeProviderId(value?.trim() ?? "");
  if (
    normalized === "claude-cli" ||
    normalized === "codex" ||
    normalized === "codex-cli" ||
    normalized === "codex-app-server" ||
    normalized === "openai" ||
    normalized === "minimax" ||
    normalized === "minimax-cli" ||
    normalized === "minimax-portal"
  ) {
    addProviderScopeId(out, normalized);
  }
}

function addExternalCliRuntimeScopeFromModelMap(
  out: Set<string>,
  models: Record<string, { agentRuntime?: { id?: string } }> | undefined,
): void {
  for (const entry of Object.values(models ?? {})) {
    addExternalCliRuntimeScope(out, entry?.agentRuntime?.id);
  }
}

/** Resolves external CLI auth discovery scope from configured auth/model surfaces. */
export function resolveExternalCliAuthScopeFromConfig(
  cfg: OpenClawConfig,
): ExternalCliAuthScope | undefined {
  const providerIds = new Set<string>();
  const profileIds = new Set<string>();

  for (const id of Object.keys(cfg.models?.providers ?? {})) {
    addProviderScopeId(providerIds, id);
  }
  for (const [profileId, profile] of Object.entries(cfg.auth?.profiles ?? {})) {
    const normalizedProfileId = profileId.trim();
    if (normalizedProfileId) {
      profileIds.add(normalizedProfileId);
    }
    addProviderScopeId(providerIds, profile?.provider);
  }
  for (const [provider, orderedProfileIds] of Object.entries(cfg.auth?.order ?? {})) {
    addProviderScopeId(providerIds, provider);
    for (const profileId of orderedProfileIds ?? []) {
      const normalizedProfileId = profileId.trim();
      if (normalizedProfileId) {
        profileIds.add(normalizedProfileId);
      }
    }
  }

  const defaults = cfg.agents?.defaults;
  addProviderScopeFromModelConfig(providerIds, defaults?.model);
  addProviderScopeFromModelConfig(providerIds, defaults?.imageModel);
  addProviderScopeFromModelConfig(providerIds, defaults?.imageGenerationModel);
  addProviderScopeFromModelConfig(providerIds, defaults?.videoGenerationModel);
  addProviderScopeFromModelConfig(providerIds, defaults?.musicGenerationModel);
  addProviderScopeFromModelConfig(providerIds, defaults?.voiceModel);
  addProviderScopeFromModelConfig(providerIds, defaults?.pdfModel);
  addExternalCliRuntimeScopeFromModelMap(providerIds, defaults?.models);
  for (const provider of Object.values(cfg.models?.providers ?? {})) {
    addExternalCliRuntimeScope(providerIds, provider?.agentRuntime?.id);
    for (const model of provider?.models ?? []) {
      addExternalCliRuntimeScope(providerIds, model?.agentRuntime?.id);
    }
  }

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const agent of agents) {
    addProviderScopeFromModelConfig(providerIds, agent.model);
    addProviderScopeFromModelConfig(providerIds, agent.subagents?.model);
    addExternalCliRuntimeScopeFromModelMap(providerIds, agent.models);
  }

  if (providerIds.size === 0 && profileIds.size === 0) {
    return undefined;
  }
  return {
    providerIds: [...providerIds].toSorted((left, right) => left.localeCompare(right)),
    profileIds: [...profileIds].toSorted((left, right) => left.localeCompare(right)),
  };
}
