import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import type { AgentModelConfig } from "../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeProviderId } from "../provider-id.js";

export type ExternalCliAuthScope = {
  providerIds: string[];
  profileIds: string[];
};

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

function addExternalCliRuntimeScope(out: Set<string>, value: string | undefined): void {
  const normalized = normalizeProviderId(value?.trim() ?? "");
  if (
    normalized === "claude-cli" ||
    normalized === "codex" ||
    normalized === "codex-cli" ||
    normalized === "openai-codex" ||
    normalized === "minimax" ||
    normalized === "minimax-cli" ||
    normalized === "minimax-portal"
  ) {
    addProviderScopeId(out, normalized);
  }
}

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
  for (const provider of Object.keys(cfg.auth?.order ?? {})) {
    addProviderScopeId(providerIds, provider);
  }

  const defaults = cfg.agents?.defaults;
  addProviderScopeFromModelConfig(providerIds, defaults?.model);
  addProviderScopeFromModelConfig(providerIds, defaults?.imageModel);
  addProviderScopeFromModelConfig(providerIds, defaults?.imageGenerationModel);
  addProviderScopeFromModelConfig(providerIds, defaults?.videoGenerationModel);
  addProviderScopeFromModelConfig(providerIds, defaults?.musicGenerationModel);
  addProviderScopeFromModelConfig(providerIds, defaults?.pdfModel);
  for (const modelRef of Object.keys(defaults?.models ?? {})) {
    addProviderScopeFromModelRef(providerIds, modelRef);
  }
  addExternalCliRuntimeScope(providerIds, defaults?.agentRuntime?.id);
  addExternalCliRuntimeScope(providerIds, defaults?.embeddedHarness?.runtime);
  for (const backendId of Object.keys(defaults?.cliBackends ?? {})) {
    addExternalCliRuntimeScope(providerIds, backendId);
  }

  for (const agent of cfg.agents?.list ?? []) {
    addProviderScopeFromModelConfig(providerIds, agent.model);
    addProviderScopeFromModelConfig(providerIds, agent.subagents?.model);
    addExternalCliRuntimeScope(providerIds, agent.agentRuntime?.id);
    addExternalCliRuntimeScope(providerIds, agent.embeddedHarness?.runtime);
  }

  if (providerIds.size === 0 && profileIds.size === 0) {
    return undefined;
  }
  return {
    providerIds: [...providerIds].toSorted((left, right) => left.localeCompare(right)),
    profileIds: [...profileIds].toSorted((left, right) => left.localeCompare(right)),
  };
}
