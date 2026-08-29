import { toAgentEntriesRecord } from "../agents/agent-scope-config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, normalizeAgentIdStrict } from "../routing/session-key.js";

type SystemAgentModelSelectionParams = {
  config: OpenClawConfig;
  model: string;
  /** Write the model onto this configured agent instead of the default route. */
  targetAgentId?: string;
  agentRuntimeId?: string;
  /** Pin the selected model to the exact credential that passed inference. */
  authProfileId?: string;
};

type SystemAgentModelSelectionModules = {
  agentScope: typeof import("../agents/agent-scope.js");
  modelConfig: typeof import("../commands/models/shared.js");
  runtimePolicy: typeof import("../agents/model-runtime-policy.js");
};

function applySystemAgentModelSelectionWithModules(
  params: SystemAgentModelSelectionParams,
  modules: SystemAgentModelSelectionModules,
): OpenClawConfig {
  const { agentScope, modelConfig, runtimePolicy } = modules;
  const nextConfig = structuredClone(params.config);
  const normalizedTarget =
    params.targetAgentId === undefined ? null : normalizeAgentIdStrict(params.targetAgentId);
  if (normalizedTarget && !normalizedTarget.ok) {
    throw new Error(`Could not resolve configured agent "${params.targetAgentId}".`);
  }
  const targetAgentId = normalizedTarget?.value;
  const agentId = agentScope.resolveAmbientOwnerAgentId(nextConfig, targetAgentId);
  const roster = agentScope.listAgentEntries(nextConfig);
  if (targetAgentId && !roster.some((entry) => normalizeAgentId(entry.id) === targetAgentId)) {
    throw new Error(`Could not resolve configured agent "${targetAgentId}".`);
  }
  // A targeted selection always lands on the agent entry; the default-route
  // selection only writes the agent when it already carries an explicit model.
  const writesAgent = Boolean(
    targetAgentId || agentScope.resolveAgentExplicitModelPrimary(nextConfig, agentId),
  );
  nextConfig.agents ??= {};
  nextConfig.agents.defaults ??= {};
  const agentDefaults = nextConfig.agents.defaults;
  const target = modelConfig.resolveModelTarget({ raw: params.model, cfg: nextConfig });
  const key = modelConfig.upsertCanonicalModelConfigEntry({}, target);

  const configuredVisibleModels = agentDefaults.models;
  if (configuredVisibleModels && Object.keys(configuredVisibleModels).length > 0) {
    // An authored global visibility map is restrictive. Extend it for the
    // approved selection; never create one merely to carry runtime metadata.
    const defaultModels = { ...configuredVisibleModels };
    modelConfig.upsertCanonicalModelConfigEntry(defaultModels, target);
    agentDefaults.models = defaultModels;
  }

  const agentEntries = toAgentEntriesRecord(roster);
  if (writesAgent || params.agentRuntimeId) {
    const { list: _legacyList, ...agentConfig } = nextConfig.agents;
    nextConfig.agents = { ...agentConfig, entries: agentEntries };
  }
  const agentEntryKey =
    roster.find((entry) => normalizeAgentId(entry.id) === agentId)?.id ?? agentId;
  let agent = agentEntries[agentEntryKey];
  if (writesAgent) {
    if (!agent) {
      throw new Error(`Could not resolve configured default agent "${agentId}".`);
    }
    const agentModels = { ...agent.models };
    agent.models = agentModels;
    modelConfig.upsertCanonicalModelConfigEntry(agentModels, target);
  }

  if (params.agentRuntimeId) {
    if (!agent) {
      agent = { default: true };
      agentEntries[agentEntryKey] = agent;
    }
    const agentModels = { ...agent.models };
    const agentKey = modelConfig.upsertCanonicalModelConfigEntry(agentModels, target);
    agentModels[agentKey] = {
      ...agentModels[agentKey],
      agentRuntime: { id: params.agentRuntimeId },
    };
    agent.models = agentModels;
  } else {
    const clearRuntimePin = (
      models: Record<string, AgentModelEntryConfig>,
    ): Record<string, AgentModelEntryConfig> => {
      const nextModels = { ...models };
      const modelKey = modelConfig.upsertCanonicalModelConfigEntry(nextModels, target);
      const entry = { ...nextModels[modelKey] };
      delete entry.agentRuntime;
      nextModels[modelKey] = entry;
      return nextModels;
    };
    const defaultModels = agentDefaults.models;
    if (defaultModels && Object.keys(defaultModels).length > 0) {
      agentDefaults.models = clearRuntimePin(defaultModels);
    }
    if (agent?.models && Object.keys(agent.models).length > 0) {
      agent.models = clearRuntimePin(agent.models);
    }
  }
  const selectedModel = params.authProfileId ? `${key}@${params.authProfileId}` : key;
  agentScope.setAgentEffectiveModelPrimary(nextConfig, agentId, selectedModel, {
    forceAgent: Boolean(targetAgentId),
  });
  if (params.agentRuntimeId) {
    const effectiveRuntime = runtimePolicy.resolveModelRuntimePolicy({
      config: nextConfig,
      provider: target.provider,
      modelId: target.model,
      agentId,
    }).policy?.id;
    if (effectiveRuntime !== params.agentRuntimeId) {
      throw new Error(`Could not pin ${key} to the ${params.agentRuntimeId} runtime.`);
    }
  }
  return nextConfig;
}

export async function createSystemAgentModelSelectionUpdater(
  params: Omit<SystemAgentModelSelectionParams, "config">,
): Promise<(config: OpenClawConfig) => OpenClawConfig> {
  const [agentScope, modelConfig, runtimePolicy] = await Promise.all([
    import("../agents/agent-scope.js"),
    import("../commands/models/shared.js"),
    import("../agents/model-runtime-policy.js"),
  ]);
  const modules = { agentScope, modelConfig, runtimePolicy };
  return (config) => applySystemAgentModelSelectionWithModules({ ...params, config }, modules);
}

export async function applySystemAgentModelSelection(
  params: SystemAgentModelSelectionParams,
): Promise<OpenClawConfig> {
  const update = await createSystemAgentModelSelectionUpdater(params);
  return update(params.config);
}
