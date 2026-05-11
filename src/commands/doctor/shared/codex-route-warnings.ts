import fs from "node:fs";
import { resolveModelRuntimePolicy } from "../../../agents/model-runtime-policy.js";
import { openAIProviderUsesCodexRuntimeByDefault } from "../../../agents/openai-codex-routing.js";
import { AGENT_MODEL_CONFIG_KEYS } from "../../../config/model-refs.js";
import { loadSessionStore, updateSessionStore } from "../../../config/sessions/store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../../config/sessions/targets.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { AgentRuntimePolicyConfig } from "../../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

type CodexRouteHit = {
  path: string;
  model: string;
  canonicalModel: string;
  runtime?: string;
};

type MutableRecord = Record<string, unknown>;
type SessionRouteRepairResult = {
  changed: boolean;
  sessionKeys: string[];
};
type ConfigRouteRepairResult = {
  cfg: OpenClawConfig;
  changes: CodexRouteHit[];
  runtimePinChanges: string[];
  runtimePolicyChanges: string[];
};
type CodexSessionRouteRepairSummary = {
  scannedStores: number;
  repairedStores: number;
  repairedSessions: number;
  warnings: string[];
  changes: string[];
};

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

function asMutableRecord(value: unknown): MutableRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MutableRecord)
    : undefined;
}

function isOpenAICodexModelRef(model: string | undefined): model is string {
  return normalizeString(model)?.startsWith("openai-codex/") === true;
}

function toCanonicalOpenAIModelRef(model: string): string | undefined {
  if (!isOpenAICodexModelRef(model)) {
    return undefined;
  }
  const modelId = model.slice("openai-codex/".length).trim();
  return modelId ? `openai/${modelId}` : undefined;
}

function toOpenAIModelId(model: string): string | undefined {
  if (!isOpenAICodexModelRef(model)) {
    return undefined;
  }
  const modelId = model.slice("openai-codex/".length).trim();
  return modelId || undefined;
}

function resolveRuntime(params: {
  env?: NodeJS.ProcessEnv;
  agentRuntime?: AgentRuntimePolicyConfig;
  defaultsRuntime?: AgentRuntimePolicyConfig;
}): string | undefined {
  return (
    normalizeString(params.env?.OPENCLAW_AGENT_RUNTIME) ??
    normalizeString(params.agentRuntime?.id) ??
    normalizeString(params.defaultsRuntime?.id)
  );
}

function recordCodexModelHit(params: {
  hits: CodexRouteHit[];
  path: string;
  model: string;
  runtime?: string;
}): string | undefined {
  const canonicalModel = toCanonicalOpenAIModelRef(params.model);
  if (!canonicalModel) {
    return undefined;
  }
  params.hits.push({
    path: params.path,
    model: params.model,
    canonicalModel,
    ...(params.runtime ? { runtime: params.runtime } : {}),
  });
  return canonicalModel;
}

function collectStringModelSlot(params: {
  hits: CodexRouteHit[];
  path: string;
  value: unknown;
  runtime?: string;
}): boolean {
  if (typeof params.value !== "string") {
    return false;
  }
  const model = params.value.trim();
  if (!model || !isOpenAICodexModelRef(model)) {
    return false;
  }
  return !!recordCodexModelHit({
    hits: params.hits,
    path: params.path,
    model,
    runtime: params.runtime,
  });
}

function collectModelConfigSlot(params: {
  hits: CodexRouteHit[];
  path: string;
  value: unknown;
  runtime?: string;
}): boolean {
  if (typeof params.value === "string") {
    return collectStringModelSlot({
      hits: params.hits,
      path: params.path,
      value: params.value,
      runtime: params.runtime,
    });
  }
  const record = asMutableRecord(params.value);
  if (!record) {
    return false;
  }
  let rewrotePrimary = false;
  if (typeof record.primary === "string") {
    rewrotePrimary = collectStringModelSlot({
      hits: params.hits,
      path: `${params.path}.primary`,
      value: record.primary,
      runtime: params.runtime,
    });
  }
  if (Array.isArray(record.fallbacks)) {
    for (const [index, entry] of record.fallbacks.entries()) {
      collectStringModelSlot({
        hits: params.hits,
        path: `${params.path}.fallbacks.${index}`,
        value: entry,
      });
    }
  }
  return rewrotePrimary;
}

function collectModelsMapRefs(params: {
  hits: CodexRouteHit[];
  path: string;
  models: unknown;
}): void {
  const record = asMutableRecord(params.models);
  if (!record) {
    return;
  }
  for (const modelRef of Object.keys(record)) {
    if (!isOpenAICodexModelRef(modelRef)) {
      continue;
    }
    recordCodexModelHit({
      hits: params.hits,
      path: `${params.path}.${modelRef}`,
      model: modelRef,
    });
  }
}

function collectAgentModelRefs(params: {
  hits: CodexRouteHit[];
  agent: unknown;
  path: string;
  runtime?: string;
  collectModelsMap?: boolean;
}): void {
  const agent = asMutableRecord(params.agent);
  if (!agent) {
    return;
  }
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    collectModelConfigSlot({
      hits: params.hits,
      path: `${params.path}.${key}`,
      value: agent[key],
      runtime: key === "model" ? params.runtime : undefined,
    });
  }
  collectStringModelSlot({
    hits: params.hits,
    path: `${params.path}.heartbeat.model`,
    value: asMutableRecord(agent.heartbeat)?.model,
  });
  collectModelConfigSlot({
    hits: params.hits,
    path: `${params.path}.subagents.model`,
    value: asMutableRecord(agent.subagents)?.model,
  });
  const compaction = asMutableRecord(agent.compaction);
  collectStringModelSlot({
    hits: params.hits,
    path: `${params.path}.compaction.model`,
    value: compaction?.model,
  });
  collectStringModelSlot({
    hits: params.hits,
    path: `${params.path}.compaction.memoryFlush.model`,
    value: asMutableRecord(compaction?.memoryFlush)?.model,
  });
  if (params.collectModelsMap) {
    collectModelsMapRefs({
      hits: params.hits,
      path: `${params.path}.models`,
      models: agent.models,
    });
  }
}

function collectConfigModelRefs(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): CodexRouteHit[] {
  const hits: CodexRouteHit[] = [];
  const defaults = cfg.agents?.defaults;
  const defaultsRuntime = defaults?.agentRuntime;
  collectAgentModelRefs({
    hits,
    agent: defaults,
    path: "agents.defaults",
    runtime: resolveRuntime({ env, defaultsRuntime }),
    collectModelsMap: true,
  });

  for (const [index, agent] of (cfg.agents?.list ?? []).entries()) {
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
    collectAgentModelRefs({
      hits,
      agent,
      path: `agents.list.${id}`,
      runtime: resolveRuntime({
        env,
        agentRuntime: agent.agentRuntime,
        defaultsRuntime,
      }),
    });
  }

  const channelsModelByChannel = asMutableRecord(cfg.channels?.modelByChannel);
  if (channelsModelByChannel) {
    for (const [channelId, channelMap] of Object.entries(channelsModelByChannel)) {
      const targets = asMutableRecord(channelMap);
      if (!targets) {
        continue;
      }
      for (const [targetId, model] of Object.entries(targets)) {
        collectStringModelSlot({
          hits,
          path: `channels.modelByChannel.${channelId}.${targetId}`,
          value: model,
        });
      }
    }
  }

  for (const [index, mapping] of (cfg.hooks?.mappings ?? []).entries()) {
    collectStringModelSlot({
      hits,
      path: `hooks.mappings.${index}.model`,
      value: mapping.model,
    });
  }
  collectStringModelSlot({
    hits,
    path: "hooks.gmail.model",
    value: cfg.hooks?.gmail?.model,
  });
  collectModelConfigSlot({
    hits,
    path: "tools.subagents.model",
    value: cfg.tools?.subagents?.model,
  });
  collectStringModelSlot({
    hits,
    path: "messages.tts.summaryModel",
    value: cfg.messages?.tts?.summaryModel,
  });
  collectStringModelSlot({
    hits,
    path: "channels.discord.voice.model",
    value: asMutableRecord(asMutableRecord(cfg.channels?.discord)?.voice)?.model,
  });
  return hits;
}

function rewriteStringModelSlot(params: {
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
  runtime?: string;
}): boolean {
  if (!params.container) {
    return false;
  }
  const value = params.container[params.key];
  const model = typeof value === "string" ? value.trim() : "";
  if (!model || !isOpenAICodexModelRef(model)) {
    return false;
  }
  const canonicalModel = recordCodexModelHit({
    hits: params.hits,
    path: params.path,
    model,
    runtime: params.runtime,
  });
  if (!canonicalModel) {
    return false;
  }
  params.container[params.key] = canonicalModel;
  return true;
}

function rewriteModelConfigSlot(params: {
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
  runtime?: string;
}): boolean {
  if (!params.container) {
    return false;
  }
  const value = params.container[params.key];
  if (typeof value === "string") {
    return rewriteStringModelSlot({
      hits: params.hits,
      container: params.container,
      key: params.key,
      path: params.path,
      runtime: params.runtime,
    });
  }
  const record = asMutableRecord(value);
  if (!record) {
    return false;
  }
  const rewrotePrimary = rewriteStringModelSlot({
    hits: params.hits,
    container: record,
    key: "primary",
    path: `${params.path}.primary`,
    runtime: params.runtime,
  });
  if (Array.isArray(record.fallbacks)) {
    record.fallbacks = record.fallbacks.map((entry, index) => {
      if (typeof entry !== "string") {
        return entry;
      }
      const model = entry.trim();
      const canonicalModel = recordCodexModelHit({
        hits: params.hits,
        path: `${params.path}.fallbacks.${index}`,
        model,
      });
      return canonicalModel ?? entry;
    });
  }
  return rewrotePrimary;
}

function rewriteModelsMap(params: {
  hits: CodexRouteHit[];
  models: MutableRecord | undefined;
  path: string;
}): void {
  if (!params.models) {
    return;
  }
  for (const legacyRef of Object.keys(params.models)) {
    const canonicalModel = toCanonicalOpenAIModelRef(legacyRef);
    if (!canonicalModel) {
      continue;
    }
    recordCodexModelHit({
      hits: params.hits,
      path: `${params.path}.${legacyRef}`,
      model: legacyRef,
    });
    const legacyEntry = params.models[legacyRef] ?? {};
    const canonicalEntry = params.models[canonicalModel];
    const legacyRecord = asMutableRecord(legacyEntry);
    const canonicalRecord = asMutableRecord(canonicalEntry);
    params.models[canonicalModel] =
      legacyRecord && canonicalRecord
        ? { ...legacyRecord, ...canonicalRecord }
        : (canonicalEntry ?? legacyEntry);
    delete params.models[legacyRef];
  }
}

function modelConfigContainsRef(value: unknown, modelRef: string): boolean {
  if (typeof value === "string") {
    return value.trim() === modelRef;
  }
  const record = asMutableRecord(value);
  if (!record) {
    return false;
  }
  if (typeof record.primary === "string" && record.primary.trim() === modelRef) {
    return true;
  }
  return (
    Array.isArray(record.fallbacks) &&
    record.fallbacks.some((entry) => typeof entry === "string" && entry.trim() === modelRef)
  );
}

function agentExplicitlyReferencesCanonicalModel(agent: unknown, modelRef: string): boolean {
  const record = asMutableRecord(agent);
  if (!record) {
    return false;
  }
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    if (modelConfigContainsRef(record[key], modelRef)) {
      return true;
    }
  }
  if (modelConfigContainsRef(asMutableRecord(record.heartbeat)?.model, modelRef)) {
    return true;
  }
  if (modelConfigContainsRef(asMutableRecord(record.subagents)?.model, modelRef)) {
    return true;
  }
  const compaction = asMutableRecord(record.compaction);
  return (
    modelConfigContainsRef(compaction?.model, modelRef) ||
    modelConfigContainsRef(asMutableRecord(compaction?.memoryFlush)?.model, modelRef) ||
    asMutableRecord(record.models)?.[modelRef] !== undefined
  );
}

function parseModelRef(modelRef: string): { provider: string; modelId: string } | undefined {
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash >= modelRef.length - 1) {
    return undefined;
  }
  return {
    provider: modelRef.slice(0, slash),
    modelId: modelRef.slice(slash + 1),
  };
}

function resolveCurrentRuntimeIdForCanonicalModel(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  agentId: string;
}): string {
  const parsed = parseModelRef(params.modelRef);
  if (!parsed) {
    return "auto";
  }
  const configured = normalizeString(
    resolveModelRuntimePolicy({
      config: params.cfg,
      provider: parsed.provider,
      modelId: parsed.modelId,
      agentId: params.agentId,
    }).policy?.id,
  );
  if (configured) {
    return configured;
  }
  return openAIProviderUsesCodexRuntimeByDefault({
    provider: parsed.provider,
    config: params.cfg,
  })
    ? "codex"
    : "auto";
}

function setModelRuntimePolicy(params: {
  agent: MutableRecord;
  agentPath: string;
  modelRef: string;
  runtimeId: string;
  changes: string[];
  reason: string;
}): void {
  const models = asMutableRecord(params.agent.models) ?? {};
  if (params.agent.models !== models) {
    params.agent.models = models;
  }
  const entry = asMutableRecord(models[params.modelRef]) ?? {};
  if (models[params.modelRef] !== entry) {
    models[params.modelRef] = entry;
  }
  const priorRuntime = asMutableRecord(entry.agentRuntime);
  if (normalizeString(priorRuntime?.id) === params.runtimeId) {
    return;
  }
  entry.agentRuntime = {
    ...priorRuntime,
    id: params.runtimeId,
  };
  params.changes.push(
    `Set ${params.agentPath}.models.${params.modelRef}.agentRuntime.id to "${params.runtimeId}" ${params.reason}.`,
  );
}

function shieldExplicitListedAgentRefsFromDefaultPolicy(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  changes: string[];
}): void {
  for (const [index, agent] of (params.cfg.agents?.list ?? []).entries()) {
    if (!agentExplicitlyReferencesCanonicalModel(agent, params.modelRef)) {
      continue;
    }
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
    const runtimeId = resolveCurrentRuntimeIdForCanonicalModel({
      cfg: params.cfg,
      modelRef: params.modelRef,
      agentId: id,
    });
    if (runtimeId === "codex") {
      continue;
    }
    setModelRuntimePolicy({
      agent: agent as MutableRecord,
      agentPath: `agents.list.${id}`,
      modelRef: params.modelRef,
      runtimeId,
      changes: params.changes,
      reason: "so default Codex route repair does not change explicit agent routing",
    });
  }
}

function rewriteAgentModelRefs(params: {
  cfg: OpenClawConfig;
  hits: CodexRouteHit[];
  agent: MutableRecord | undefined;
  path: string;
  agentId?: string;
  currentRuntime?: string;
  rewriteModelsMap?: boolean;
  runtimePolicyChanges: string[];
}): void {
  if (!params.agent) {
    return;
  }
  const agent = params.agent;
  const preserveCodexRuntimePolicyForNewHits = (fromIndex: number) => {
    for (const hit of params.hits.slice(fromIndex)) {
      ensureCodexRuntimePolicy({
        cfg: params.cfg,
        agent,
        agentPath: params.path,
        modelRef: hit.canonicalModel,
        isDefaults: params.path === "agents.defaults",
        changes: params.runtimePolicyChanges,
      });
    }
  };
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    const start = params.hits.length;
    if (key === "model") {
      rewriteModelConfigSlot({
        hits: params.hits,
        container: agent,
        key,
        path: `${params.path}.${key}`,
        runtime: params.currentRuntime,
      });
      preserveCodexRuntimePolicyForNewHits(start);
    } else {
      rewriteModelConfigSlotIfCanonicalCodexRuntime({
        cfg: params.cfg,
        agentId: params.agentId,
        hits: params.hits,
        container: agent,
        key,
        path: `${params.path}.${key}`,
      });
    }
  }
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    cfg: params.cfg,
    agentId: params.agentId,
    hits: params.hits,
    container: asMutableRecord(agent.heartbeat),
    key: "model",
    path: `${params.path}.heartbeat.model`,
  });
  rewriteModelConfigSlotIfCanonicalCodexRuntime({
    cfg: params.cfg,
    agentId: params.agentId,
    hits: params.hits,
    container: asMutableRecord(agent.subagents),
    key: "model",
    path: `${params.path}.subagents.model`,
  });
  const compaction = asMutableRecord(agent.compaction);
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    cfg: params.cfg,
    agentId: params.agentId,
    hits: params.hits,
    container: compaction,
    key: "model",
    path: `${params.path}.compaction.model`,
  });
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    cfg: params.cfg,
    agentId: params.agentId,
    hits: params.hits,
    container: asMutableRecord(compaction?.memoryFlush),
    key: "model",
    path: `${params.path}.compaction.memoryFlush.model`,
  });
  if (params.rewriteModelsMap) {
    const start = params.hits.length;
    rewriteModelsMap({
      hits: params.hits,
      models: asMutableRecord(agent.models),
      path: `${params.path}.models`,
    });
    preserveCodexRuntimePolicyForNewHits(start);
  }
}

function ensureCodexRuntimePolicy(params: {
  cfg: OpenClawConfig;
  agent: MutableRecord;
  agentPath: string;
  modelRef: string;
  isDefaults?: boolean;
  changes: string[];
}): void {
  if (params.isDefaults) {
    shieldExplicitListedAgentRefsFromDefaultPolicy({
      cfg: params.cfg,
      modelRef: params.modelRef,
      changes: params.changes,
    });
  }
  const models = asMutableRecord(params.agent.models) ?? {};
  if (params.agent.models !== models) {
    params.agent.models = models;
  }
  const entry = asMutableRecord(models[params.modelRef]) ?? {};
  if (models[params.modelRef] !== entry) {
    models[params.modelRef] = entry;
  }
  const priorRuntime = asMutableRecord(entry.agentRuntime);
  const runtimeId = normalizeString(priorRuntime?.id);
  if (runtimeId && runtimeId !== "auto" && runtimeId !== "default") {
    return;
  }
  setModelRuntimePolicy({
    agent: params.agent,
    agentPath: params.agentPath,
    modelRef: params.modelRef,
    runtimeId: "codex",
    changes: params.changes,
    reason: "so repaired OpenAI refs keep Codex auth routing",
  });
}

function canonicalOpenAIModelUsesCodexRuntime(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  agentId?: string;
}): boolean {
  const slash = params.modelRef.indexOf("/");
  if (slash <= 0 || slash >= params.modelRef.length - 1) {
    return false;
  }
  const parsed = parseModelRef(params.modelRef);
  if (!parsed) {
    return false;
  }
  const configured = normalizeString(
    resolveModelRuntimePolicy({
      config: params.cfg,
      provider: parsed.provider,
      modelId: parsed.modelId,
      agentId: params.agentId,
    }).policy?.id,
  );
  if (configured && configured !== "auto" && configured !== "default") {
    return configured === "codex";
  }
  return openAIProviderUsesCodexRuntimeByDefault({ provider: parsed.provider, config: params.cfg });
}

function rewriteStringModelSlotIfCanonicalCodexRuntime(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
}): void {
  const value = params.container?.[params.key];
  if (typeof value !== "string") {
    return;
  }
  const canonicalModel = toCanonicalOpenAIModelRef(value.trim());
  if (
    !canonicalModel ||
    !canonicalOpenAIModelUsesCodexRuntime({
      cfg: params.cfg,
      modelRef: canonicalModel,
      agentId: params.agentId,
    })
  ) {
    return;
  }
  rewriteStringModelSlot({
    hits: params.hits,
    container: params.container,
    key: params.key,
    path: params.path,
  });
}

function rewriteModelConfigSlotIfCanonicalCodexRuntime(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
}): void {
  const value = params.container?.[params.key];
  if (typeof value === "string") {
    rewriteStringModelSlotIfCanonicalCodexRuntime(params);
    return;
  }
  const record = asMutableRecord(value);
  if (!record) {
    return;
  }
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    cfg: params.cfg,
    agentId: params.agentId,
    hits: params.hits,
    container: record,
    key: "primary",
    path: `${params.path}.primary`,
  });
  const fallbacks = Array.isArray(record.fallbacks) ? record.fallbacks : undefined;
  if (!fallbacks) {
    return;
  }
  for (const [index, entry] of fallbacks.entries()) {
    if (typeof entry !== "string") {
      continue;
    }
    const canonicalModel = toCanonicalOpenAIModelRef(entry.trim());
    if (
      !canonicalModel ||
      !canonicalOpenAIModelUsesCodexRuntime({
        cfg: params.cfg,
        modelRef: canonicalModel,
        agentId: params.agentId,
      })
    ) {
      continue;
    }
    fallbacks[index] = canonicalModel;
    params.hits.push({
      path: `${params.path}.fallbacks.${index}`,
      model: entry.trim(),
      canonicalModel,
    });
  }
}

function clearLegacyAgentRuntimePolicy(
  container: MutableRecord | undefined,
  pathLabel: string,
  changes: string[],
): void {
  if (!container) {
    return;
  }
  if (asMutableRecord(container.embeddedHarness)) {
    delete container.embeddedHarness;
    changes.push(`Removed ${pathLabel}.embeddedHarness; runtime is now provider/model scoped.`);
  }
  if (asMutableRecord(container.agentRuntime)) {
    delete container.agentRuntime;
    changes.push(`Removed ${pathLabel}.agentRuntime; runtime is now provider/model scoped.`);
  }
}

function clearConfigLegacyAgentRuntimePolicies(cfg: OpenClawConfig): string[] {
  const changes: string[] = [];
  clearLegacyAgentRuntimePolicy(asMutableRecord(cfg.agents?.defaults), "agents.defaults", changes);
  for (const [index, agent] of (cfg.agents?.list ?? []).entries()) {
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
    clearLegacyAgentRuntimePolicy(agent as MutableRecord, `agents.list.${id}`, changes);
  }
  return changes;
}

function rewriteConfigModelRefs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): ConfigRouteRepairResult {
  const nextConfig = structuredClone(params.cfg);
  const hits: CodexRouteHit[] = [];
  const runtimePolicyChanges: string[] = [];
  const defaultsRuntime = nextConfig.agents?.defaults?.agentRuntime;
  rewriteAgentModelRefs({
    cfg: nextConfig,
    hits,
    agent: asMutableRecord(nextConfig.agents?.defaults),
    path: "agents.defaults",
    currentRuntime: resolveRuntime({ env: params.env, defaultsRuntime }),
    rewriteModelsMap: true,
    runtimePolicyChanges,
  });
  for (const [index, agent] of (nextConfig.agents?.list ?? []).entries()) {
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
    rewriteAgentModelRefs({
      cfg: nextConfig,
      hits,
      agent: agent as MutableRecord,
      path: `agents.list.${id}`,
      agentId: id,
      currentRuntime: resolveRuntime({
        env: params.env,
        agentRuntime: agent.agentRuntime,
        defaultsRuntime,
      }),
      runtimePolicyChanges,
    });
  }
  const channelsModelByChannel = asMutableRecord(nextConfig.channels?.modelByChannel);
  if (channelsModelByChannel) {
    for (const [channelId, channelMap] of Object.entries(channelsModelByChannel)) {
      const targets = asMutableRecord(channelMap);
      if (!targets) {
        continue;
      }
      for (const targetId of Object.keys(targets)) {
        rewriteStringModelSlotIfCanonicalCodexRuntime({
          cfg: nextConfig,
          hits,
          container: targets,
          key: targetId,
          path: `channels.modelByChannel.${channelId}.${targetId}`,
        });
      }
    }
  }
  for (const [index, mapping] of (nextConfig.hooks?.mappings ?? []).entries()) {
    rewriteStringModelSlotIfCanonicalCodexRuntime({
      cfg: nextConfig,
      hits,
      container: mapping as MutableRecord,
      key: "model",
      path: `hooks.mappings.${index}.model`,
    });
  }
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    cfg: nextConfig,
    hits,
    container: asMutableRecord(nextConfig.hooks?.gmail),
    key: "model",
    path: "hooks.gmail.model",
  });
  rewriteModelConfigSlotIfCanonicalCodexRuntime({
    cfg: nextConfig,
    hits,
    container: asMutableRecord(nextConfig.tools?.subagents),
    key: "model",
    path: "tools.subagents.model",
  });
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    cfg: nextConfig,
    hits,
    container: asMutableRecord(nextConfig.messages?.tts),
    key: "summaryModel",
    path: "messages.tts.summaryModel",
  });
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    cfg: nextConfig,
    hits,
    container: asMutableRecord(asMutableRecord(nextConfig.channels?.discord)?.voice),
    key: "model",
    path: "channels.discord.voice.model",
  });
  const runtimePinChanges =
    hits.length > 0 ? clearConfigLegacyAgentRuntimePolicies(nextConfig) : [];
  return {
    cfg:
      hits.length > 0 || runtimePolicyChanges.length > 0 || runtimePinChanges.length > 0
        ? nextConfig
        : params.cfg,
    changes: hits,
    runtimePinChanges,
    runtimePolicyChanges,
  };
}

function formatCodexRouteChange(hit: CodexRouteHit): string {
  return `${hit.path}: ${hit.model} -> ${hit.canonicalModel}.`;
}

export function collectCodexRouteWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const hits = collectConfigModelRefs(params.cfg, params.env);
  if (hits.length === 0) {
    return [];
  }
  return [
    [
      "- Legacy `openai-codex/*` model refs should be rewritten to `openai/*`.",
      ...hits.map(
        (hit) =>
          `- ${hit.path}: ${hit.model} should become ${hit.canonicalModel}${
            hit.runtime ? `; current runtime is "${hit.runtime}"` : ""
          }.`,
      ),
      "- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions to `openai/*`, moves Codex intent to provider/model runtime policy, and clears old whole-agent runtime pins.",
    ].join("\n"),
  ];
}

export function maybeRepairCodexRoutes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  codexRuntimeReady?: boolean;
}): { cfg: OpenClawConfig; warnings: string[]; changes: string[] } {
  const hits = collectConfigModelRefs(params.cfg, params.env);
  if (hits.length === 0) {
    return { cfg: params.cfg, warnings: [], changes: [] };
  }
  if (!params.shouldRepair) {
    return {
      cfg: params.cfg,
      warnings: collectCodexRouteWarnings({ cfg: params.cfg, env: params.env }),
      changes: [],
    };
  }
  const repaired = rewriteConfigModelRefs({
    cfg: params.cfg,
    env: params.env,
  });
  const warnings = collectCodexRouteWarnings({ cfg: repaired.cfg, env: params.env });
  const changes =
    repaired.changes.length > 0
      ? [
          `Repaired Codex model routes:\n${repaired.changes
            .map((hit) => `- ${formatCodexRouteChange(hit)}`)
            .join("\n")}`,
        ]
      : [];
  return {
    cfg: repaired.cfg,
    warnings,
    changes: [...changes, ...repaired.runtimePolicyChanges, ...repaired.runtimePinChanges],
  };
}

function rewriteSessionModelPair(params: {
  entry: SessionEntry;
  providerKey: "modelProvider" | "providerOverride";
  modelKey: "model" | "modelOverride";
}): boolean {
  let changed = false;
  const provider = normalizeString(params.entry[params.providerKey]);
  const model =
    typeof params.entry[params.modelKey] === "string" ? params.entry[params.modelKey] : undefined;
  if (provider === "openai-codex") {
    params.entry[params.providerKey] = "openai";
    changed = true;
    if (model) {
      const modelId = toOpenAIModelId(model);
      if (modelId) {
        params.entry[params.modelKey] = modelId;
      }
    }
    return true;
  }
  if (model && isOpenAICodexModelRef(model)) {
    const canonicalModel = toCanonicalOpenAIModelRef(model);
    if (canonicalModel) {
      params.entry[params.modelKey] = canonicalModel;
      changed = true;
    }
  }
  return changed;
}

function clearStaleCodexFallbackNotice(entry: SessionEntry): boolean {
  if (
    !isOpenAICodexModelRef(entry.fallbackNoticeSelectedModel) &&
    !isOpenAICodexModelRef(entry.fallbackNoticeActiveModel)
  ) {
    return false;
  }
  delete entry.fallbackNoticeSelectedModel;
  delete entry.fallbackNoticeActiveModel;
  delete entry.fallbackNoticeReason;
  return true;
}

function clearStaleSessionRuntimePins(entry: SessionEntry): boolean {
  let changed = false;
  if (entry.agentHarnessId !== undefined) {
    delete entry.agentHarnessId;
    changed = true;
  }
  if (entry.agentRuntimeOverride !== undefined) {
    delete entry.agentRuntimeOverride;
    changed = true;
  }
  return changed;
}

export function repairCodexSessionStoreRoutes(params: {
  store: Record<string, SessionEntry>;
  now?: number;
}): SessionRouteRepairResult {
  const now = params.now ?? Date.now();
  const sessionKeys: string[] = [];
  for (const [sessionKey, entry] of Object.entries(params.store)) {
    if (!entry) {
      continue;
    }
    const changedRuntimeModelRoute = rewriteSessionModelPair({
      entry,
      providerKey: "modelProvider",
      modelKey: "model",
    });
    const changedOverrideModelRoute = rewriteSessionModelPair({
      entry,
      providerKey: "providerOverride",
      modelKey: "modelOverride",
    });
    const changedModelRoute = changedRuntimeModelRoute || changedOverrideModelRoute;
    const changedFallbackNotice = clearStaleCodexFallbackNotice(entry);
    const changedRuntimePins =
      changedModelRoute || changedFallbackNotice ? clearStaleSessionRuntimePins(entry) : false;
    if (!changedModelRoute && !changedFallbackNotice && !changedRuntimePins) {
      continue;
    }
    entry.updatedAt = now;
    sessionKeys.push(sessionKey);
  }
  return {
    changed: sessionKeys.length > 0,
    sessionKeys,
  };
}

function scanCodexSessionStoreRoutes(store: Record<string, SessionEntry>): string[] {
  return Object.entries(store).flatMap(([sessionKey, entry]) => {
    if (!entry) {
      return [];
    }
    const hasLegacyRoute =
      normalizeString(entry.modelProvider) === "openai-codex" ||
      normalizeString(entry.providerOverride) === "openai-codex" ||
      isOpenAICodexModelRef(entry.model) ||
      isOpenAICodexModelRef(entry.modelOverride) ||
      isOpenAICodexModelRef(entry.fallbackNoticeSelectedModel) ||
      isOpenAICodexModelRef(entry.fallbackNoticeActiveModel);
    return hasLegacyRoute ? [sessionKey] : [];
  });
}

export async function maybeRepairCodexSessionRoutes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  codexRuntimeReady?: boolean;
}): Promise<CodexSessionRouteRepairSummary> {
  const targets = resolveAllAgentSessionStoreTargetsSync(params.cfg, {
    env: params.env ?? process.env,
  }).filter((target) => fs.existsSync(target.storePath));
  if (targets.length === 0) {
    return {
      scannedStores: 0,
      repairedStores: 0,
      repairedSessions: 0,
      warnings: [],
      changes: [],
    };
  }
  if (!params.shouldRepair) {
    const stale = targets.flatMap((target) => {
      const sessionKeys = scanCodexSessionStoreRoutes(loadSessionStore(target.storePath));
      return sessionKeys.map((sessionKey) => `${target.agentId}:${sessionKey}`);
    });
    return {
      scannedStores: targets.length,
      repairedStores: 0,
      repairedSessions: 0,
      warnings:
        stale.length > 0
          ? [
              [
                "- Legacy `openai-codex/*` session route state detected.",
                `- Affected sessions: ${stale.length}.`,
                "- Run `openclaw doctor --fix` to rewrite stale session model/provider pins across all agent session stores.",
              ].join("\n"),
            ]
          : [],
      changes: [],
    };
  }
  let repairedStores = 0;
  let repairedSessions = 0;
  for (const target of targets) {
    const staleSessionKeys = scanCodexSessionStoreRoutes(loadSessionStore(target.storePath));
    if (staleSessionKeys.length === 0) {
      continue;
    }
    const result = await updateSessionStore(
      target.storePath,
      (store) => repairCodexSessionStoreRoutes({ store }),
      { skipMaintenance: true },
    );
    if (!result.changed) {
      continue;
    }
    repairedStores += 1;
    repairedSessions += result.sessionKeys.length;
  }
  return {
    scannedStores: targets.length,
    repairedStores,
    repairedSessions,
    warnings: [],
    changes:
      repairedSessions > 0
        ? [
            `Repaired Codex session routes: moved ${repairedSessions} session${
              repairedSessions === 1 ? "" : "s"
            } across ${repairedStores} store${repairedStores === 1 ? "" : "s"} to openai/* while preserving auth-profile pins.`,
          ]
        : [],
  };
}
