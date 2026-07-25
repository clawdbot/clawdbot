/**
 * Model runtime policy resolution.
 *
 * Agent execution uses this to choose a model/provider-specific runtime policy
 * from agent entries, model catalog config, provider config, or QA overrides.
 */
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { AgentRuntimePolicyConfig } from "../config/types.agents-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentEntries, resolveSessionAgentIds } from "./agent-scope.js";

/** Config surface that supplied a resolved model runtime policy. */
type ModelRuntimePolicySource = "model" | "provider";

/** Runtime policy plus the config surface that supplied it. */
type ResolvedModelRuntimePolicy = {
  policy?: AgentRuntimePolicyConfig;
  source?: ModelRuntimePolicySource;
  matchedProvider?: string;
};

type ModelEntryMatchKind = "none" | "exact" | "provider-wildcard";

type AgentModelRuntimePolicyMatch = {
  provider: string;
  policy: AgentRuntimePolicyConfig;
};

type AgentModelRuntimePolicyResolution = ResolvedModelRuntimePolicy & {
  ambiguous?: true;
};

function hasRuntimePolicy(value: AgentRuntimePolicyConfig | undefined): boolean {
  return Boolean(value?.id?.trim());
}

function resolveProviderConfig(
  config: OpenClawConfig | undefined,
  provider: string | undefined,
): ModelProviderConfig | undefined {
  if (!config?.models?.providers || !provider?.trim()) {
    return undefined;
  }
  const providers = config.models.providers;
  const direct = providers[provider];
  if (direct) {
    return direct;
  }
  const normalizedProvider = normalizeProviderId(provider);
  for (const [candidateProvider, providerConfig] of Object.entries(providers)) {
    if (normalizeProviderId(candidateProvider) === normalizedProvider) {
      return providerConfig;
    }
  }
  return undefined;
}

function normalizeModelIdForProvider(
  provider: string | undefined,
  modelId: string | undefined,
): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return trimmed;
  }
  const modelProvider = normalizeProviderId(trimmed.slice(0, slash));
  const expectedProvider = normalizeProviderId(provider ?? "");
  if (expectedProvider && modelProvider !== expectedProvider) {
    return undefined;
  }
  return trimmed.slice(slash + 1).trim() || undefined;
}

function parseProviderModelKey(key: string): { provider: string; modelId: string } | undefined {
  return parseModelCatalogRef(key) ?? undefined;
}

function resolveEffectiveProvider(
  provider: string | undefined,
  modelId: string | undefined,
): string | undefined {
  const normalizedProvider = normalizeProviderId(provider ?? "");
  if (normalizedProvider) {
    return normalizedProvider;
  }
  return parseProviderModelKey(modelId?.trim() ?? "")?.provider;
}

function providerMatchesCaller(provider: string, callerProvider: string): boolean {
  return !callerProvider || provider === callerProvider;
}

function resolvePolicyMatch(
  matches: AgentModelRuntimePolicyMatch[],
  callerProvider: string,
): AgentModelRuntimePolicyResolution {
  const providerMatches = callerProvider
    ? matches.filter((match) => match.provider === callerProvider)
    : [];
  const candidates = providerMatches.length > 0 ? providerMatches : matches;
  const [first] = candidates;
  if (!first) {
    return {};
  }
  if (!callerProvider && candidates.some((match) => match.provider !== first.provider)) {
    return { ambiguous: true };
  }
  return {
    policy: first.policy,
    source: "model",
    matchedProvider: first.provider || callerProvider,
  };
}

function modelEntryMatches(params: {
  entry: Pick<ModelDefinitionConfig, "id">;
  provider: string | undefined;
  modelId: string;
}): boolean {
  return modelEntryMatchKind(params) === "exact";
}

function modelEntryMatchKind(params: {
  entry: Pick<ModelDefinitionConfig, "id">;
  provider: string | undefined;
  modelId: string;
}): ModelEntryMatchKind {
  const entryId = params.entry.id.trim();
  if (entryId === params.modelId) {
    return "exact";
  }
  const parsed = parseProviderModelKey(entryId);
  if (!parsed) {
    return "none";
  }
  const callerProvider = normalizeProviderId(params.provider ?? "");
  if (!providerMatchesCaller(parsed.provider, callerProvider)) {
    return "none";
  }
  if (parsed.modelId === params.modelId) {
    return "exact";
  }
  if (parsed.modelId === "*") {
    return "provider-wildcard";
  }
  return "none";
}

function modelKeyMatchKind(params: {
  key: string;
  provider: string | undefined;
  modelId: string;
}): ModelEntryMatchKind {
  return modelEntryMatchKind({
    entry: { id: params.key },
    provider: params.provider,
    modelId: params.modelId,
  });
}

function modelKeyIsProviderWildcard(params: {
  key: string;
  provider: string | undefined;
}): boolean {
  const parsed = parseProviderModelKey(params.key);
  if (!parsed) {
    return false;
  }
  const callerProvider = normalizeProviderId(params.provider ?? "");
  return parsed.modelId === "*" && providerMatchesCaller(parsed.provider, callerProvider);
}

function resolveAgentModelEntryRuntimePolicy(params: {
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
  matchKind: Exclude<ModelEntryMatchKind, "none">;
}): AgentModelRuntimePolicyResolution {
  const modelId = normalizeModelIdForProvider(params.provider, params.modelId);
  if (!params.config || (!modelId && params.matchKind !== "provider-wildcard")) {
    return {};
  }
  const { sessionAgentId } = resolveSessionAgentIds({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const agentEntry = listAgentEntries(params.config).find(
    (entry) => normalizeAgentId(entry.id) === sessionAgentId,
  );
  const modelMaps: Array<Record<string, AgentModelEntryConfig> | undefined> = [
    agentEntry?.models,
    params.config.agents?.defaults?.models,
  ];
  const callerProvider = normalizeProviderId(params.provider ?? "");
  for (const models of modelMaps) {
    const scopeMatches: AgentModelRuntimePolicyMatch[] = [];
    for (const [key, entry] of Object.entries(models ?? {})) {
      const matches = modelId
        ? modelKeyMatchKind({ key, provider: params.provider, modelId }) === params.matchKind
        : modelKeyIsProviderWildcard({ key, provider: params.provider });
      const policy = entry?.agentRuntime;
      if (!matches || !policy || !hasRuntimePolicy(policy)) {
        continue;
      }
      scopeMatches.push({ provider: parseProviderModelKey(key)?.provider ?? "", policy });
    }
    // Unqualified model ids can match multiple provider-qualified entries; avoid
    // choosing an arbitrary runtime when the provider is unknown.
    const resolved = resolvePolicyMatch(scopeMatches, callerProvider);
    if (resolved.policy || resolved.ambiguous) {
      return resolved;
    }
  }
  return {};
}

function resolveModelConfig(params: {
  providerConfig?: ModelProviderConfig;
  provider?: string;
  modelId?: string;
}): ModelDefinitionConfig | undefined {
  const modelId = normalizeModelIdForProvider(params.provider, params.modelId);
  if (!modelId || !Array.isArray(params.providerConfig?.models)) {
    return undefined;
  }
  return params.providerConfig.models.find((entry) =>
    modelEntryMatches({ entry, provider: params.provider, modelId }),
  );
}

/** Resolves the effective runtime policy for an agent/model/provider selection. */
export function resolveModelRuntimePolicy(params: {
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
}): ResolvedModelRuntimePolicy {
  const callerProvider = normalizeProviderId(params.provider ?? "");
  const effectiveProvider = resolveEffectiveProvider(params.provider, params.modelId);
  const inferredMatchedProvider = callerProvider ? undefined : effectiveProvider;
  if (process.env.OPENCLAW_BUILD_PRIVATE_QA === "1") {
    const forcedRuntime = process.env.OPENCLAW_QA_FORCE_RUNTIME?.trim().toLowerCase();
    if (forcedRuntime === "openclaw" || forcedRuntime === "codex") {
      return { policy: { id: forcedRuntime }, source: "model" };
    }
  }

  const agentModelPolicy = resolveAgentModelEntryRuntimePolicy({
    ...params,
    provider: effectiveProvider,
    matchKind: "exact",
  });
  if (agentModelPolicy.ambiguous) {
    return {};
  }
  if (agentModelPolicy.policy) {
    return agentModelPolicy;
  }
  const providerConfig = resolveProviderConfig(params.config, effectiveProvider);
  const modelConfig = resolveModelConfig({
    providerConfig,
    provider: effectiveProvider,
    modelId: params.modelId,
  });
  if (hasRuntimePolicy(modelConfig?.agentRuntime)) {
    return {
      policy: modelConfig?.agentRuntime,
      source: "model",
      ...(inferredMatchedProvider ? { matchedProvider: inferredMatchedProvider } : {}),
    };
  }
  const agentWildcardModelPolicy = resolveAgentModelEntryRuntimePolicy({
    ...params,
    provider: effectiveProvider,
    matchKind: "provider-wildcard",
  });
  if (agentWildcardModelPolicy.policy) {
    return agentWildcardModelPolicy;
  }
  if (hasRuntimePolicy(providerConfig?.agentRuntime)) {
    return {
      policy: providerConfig?.agentRuntime,
      source: "provider",
      ...(inferredMatchedProvider ? { matchedProvider: inferredMatchedProvider } : {}),
    };
  }
  return {};
}
