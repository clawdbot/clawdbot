import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { AgentRuntimePolicyConfig } from "../config/types.agents-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentEntries, resolveSessionAgentIds } from "./agent-scope.js";
import { normalizeProviderId } from "./provider-id.js";

export type ModelRuntimePolicySource = "model" | "provider";

export type ResolvedModelRuntimePolicy = {
  policy?: AgentRuntimePolicyConfig;
  source?: ModelRuntimePolicySource;
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

function modelEntryMatches(params: {
  entry: Pick<ModelDefinitionConfig, "id">;
  provider: string | undefined;
  modelId: string;
}): boolean {
  const entryId = params.entry.id.trim();
  if (entryId === params.modelId) {
    return true;
  }
  const slash = entryId.indexOf("/");
  if (slash <= 0) {
    return false;
  }
  return (
    normalizeProviderId(entryId.slice(0, slash)) === normalizeProviderId(params.provider ?? "") &&
    entryId.slice(slash + 1).trim() === params.modelId
  );
}

function modelKeyMatches(params: {
  key: string;
  provider: string | undefined;
  modelId: string;
}): boolean {
  return modelEntryMatches({
    entry: { id: params.key },
    provider: params.provider,
    modelId: params.modelId,
  });
}

function resolveAgentModelEntryRuntimePolicy(params: {
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
}): ResolvedModelRuntimePolicy {
  const modelId = normalizeModelIdForProvider(params.provider, params.modelId);
  if (!params.config || !modelId) {
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
  for (const models of modelMaps) {
    for (const [key, entry] of Object.entries(models ?? {})) {
      if (
        modelKeyMatches({ key, provider: params.provider, modelId }) &&
        hasRuntimePolicy(entry?.agentRuntime)
      ) {
        return { policy: entry.agentRuntime, source: "model" };
      }
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

export function resolveModelRuntimePolicy(params: {
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
}): ResolvedModelRuntimePolicy {
  const agentModelPolicy = resolveAgentModelEntryRuntimePolicy(params);
  if (agentModelPolicy.policy) {
    return agentModelPolicy;
  }
  const providerConfig = resolveProviderConfig(params.config, params.provider);
  const modelConfig = resolveModelConfig({
    providerConfig,
    provider: params.provider,
    modelId: params.modelId,
  });
  if (hasRuntimePolicy(modelConfig?.agentRuntime)) {
    return { policy: modelConfig?.agentRuntime, source: "model" };
  }
  if (hasRuntimePolicy(providerConfig?.agentRuntime)) {
    return { policy: providerConfig?.agentRuntime, source: "provider" };
  }
  return {};
}
