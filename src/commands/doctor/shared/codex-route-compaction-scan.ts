import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  agentUsesCodexRuntimeForCompaction,
  asAgentRuntimePolicyConfig,
  normalizeDefaultProviderModelRef,
  readAgentPrimaryModelRef,
  readLegacyDefaultsRuntime,
  resolveRuntime,
  toCanonicalOpenAIModelRef,
} from "./codex-route-model-ref.js";
import type {
  CompactionOverrideKey,
  LegacyLosslessCompactionConfig,
  MutableRecord,
  SharedDefaultCompactionOverrideConsumers,
  UnsupportedCodexCompactionOverride,
} from "./codex-route-types.js";

export const COMPACTION_OVERRIDE_KEYS: readonly CompactionOverrideKey[] = ["model", "provider"];
export const LOSSLESS_CONTEXT_ENGINE_ID = "lossless-claw";

function collectUnsupportedCodexCompactionOverridesForAgent(params: {
  cfg: OpenClawConfig;
  agent: unknown;
  path: string;
  agentId?: string;
  currentRuntime?: string;
  inheritedModelRef?: string;
  inheritedCompaction?: unknown;
  inheritedCompactionPath?: string;
  env?: NodeJS.ProcessEnv;
}): UnsupportedCodexCompactionOverride[] {
  const agent = asMutableRecord(params.agent);
  const compaction = asMutableRecord(agent?.compaction);
  const inheritedCompaction = asMutableRecord(params.inheritedCompaction);
  if (
    !agentUsesCodexRuntimeForCompaction({
      cfg: params.cfg,
      agent,
      agentId: params.agentId,
      currentRuntime: params.currentRuntime,
      inheritedModelRef: params.inheritedModelRef,
      env: params.env,
    })
  ) {
    return [];
  }
  const providerValue = compaction?.provider ?? inheritedCompaction?.provider;
  if (normalizeString(providerValue) === LOSSLESS_CONTEXT_ENGINE_ID) {
    return [];
  }
  const candidates = COMPACTION_OVERRIDE_KEYS.map((key) => {
    const localValue = compaction?.[key];
    const hasLocalValue = typeof localValue === "string" && localValue.trim();
    return {
      key,
      value: hasLocalValue ? localValue : inheritedCompaction?.[key],
      path: hasLocalValue
        ? `${params.path}.compaction.${key}`
        : params.inheritedCompactionPath
          ? `${params.inheritedCompactionPath}.${key}`
          : `${params.path}.compaction.${key}`,
    };
  });
  return candidates.flatMap(({ key, path, value }) =>
    typeof value === "string" && value.trim() ? [{ path, key, value: value.trim() }] : [],
  );
}

function collectLegacyLosslessCompactionForAgent(params: {
  cfg: OpenClawConfig;
  agent: unknown;
  path: string;
  agentId?: string;
  currentRuntime?: string;
  inheritedModelRef?: string;
  inheritedCompaction?: unknown;
  inheritedCompactionPath?: string;
  env?: NodeJS.ProcessEnv;
}): LegacyLosslessCompactionConfig[] {
  const agent = asMutableRecord(params.agent);
  const compaction = asMutableRecord(agent?.compaction);
  const inheritedCompaction = asMutableRecord(params.inheritedCompaction);
  if (
    !agentUsesCodexRuntimeForCompaction({
      cfg: params.cfg,
      agent,
      agentId: params.agentId,
      currentRuntime: params.currentRuntime,
      inheritedModelRef: params.inheritedModelRef,
      env: params.env,
    })
  ) {
    return [];
  }
  const localProvider = compaction?.provider;
  const hasLocalProvider = typeof localProvider === "string" && localProvider.trim();
  const providerValue = hasLocalProvider ? localProvider : inheritedCompaction?.provider;
  if (normalizeString(providerValue) !== LOSSLESS_CONTEXT_ENGINE_ID) {
    return [];
  }
  const compactionPath = hasLocalProvider
    ? `${params.path}.compaction`
    : (params.inheritedCompactionPath ?? `${params.path}.compaction`);
  const localModel = compaction?.model;
  const hasLocalModel = typeof localModel === "string" && localModel.trim();
  const inheritedModel = inheritedCompaction?.model;
  const modelValue = hasLocalModel ? localModel : inheritedModel;
  const modelCompactionPath = hasLocalModel
    ? `${params.path}.compaction`
    : (params.inheritedCompactionPath ?? compactionPath);
  return [
    {
      path: params.path,
      compactionPath,
      providerPath: `${compactionPath}.provider`,
      providerValue: String(providerValue).trim(),
      ...(typeof modelValue === "string" && modelValue.trim()
        ? {
            modelPath: `${modelCompactionPath}.model`,
            modelValue: modelValue.trim(),
          }
        : {}),
    },
  ];
}

export function collectLegacyLosslessCompactionConfigs(params: {
  cfg: OpenClawConfig;
  ignoreLegacyAgentRuntimePins?: boolean;
  env?: NodeJS.ProcessEnv;
}): LegacyLosslessCompactionConfig[] {
  const defaults = params.cfg.agents?.defaults;
  const defaultsRuntime = params.ignoreLegacyAgentRuntimePins
    ? undefined
    : readLegacyDefaultsRuntime(defaults);
  const defaultModelRef = readAgentPrimaryModelRef(defaults);
  const defaultCompaction = asMutableRecord(defaults?.compaction);
  const hits = collectLegacyLosslessCompactionForAgent({
    cfg: params.cfg,
    agent: defaults,
    path: "agents.defaults",
    currentRuntime: resolveRuntime({ defaultsRuntime }),
    env: params.env,
  });
  const agents = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asMutableRecord(agent);
    if (!agentRecord) {
      continue;
    }
    const id = readAgentPathId(agentRecord, index);
    hits.push(
      ...collectLegacyLosslessCompactionForAgent({
        cfg: params.cfg,
        agent: agentRecord,
        path: `agents.list.${id}`,
        agentId: id,
        currentRuntime: resolveRuntime({
          agentRuntime: params.ignoreLegacyAgentRuntimePins
            ? undefined
            : asAgentRuntimePolicyConfig(agentRecord.agentRuntime),
          defaultsRuntime,
        }),
        inheritedModelRef: defaultModelRef,
        inheritedCompaction: defaultCompaction,
        inheritedCompactionPath: "agents.defaults.compaction",
        env: params.env,
      }),
    );
  }
  return dedupeLegacyLosslessCompactionConfigs(hits);
}

export function collectUnsupportedCodexCompactionOverrides(params: {
  cfg: OpenClawConfig;
  ignoreLegacyAgentRuntimePins?: boolean;
  env?: NodeJS.ProcessEnv;
}): UnsupportedCodexCompactionOverride[] {
  const defaults = params.cfg.agents?.defaults;
  const defaultsRuntime = params.ignoreLegacyAgentRuntimePins
    ? undefined
    : readLegacyDefaultsRuntime(defaults);
  const defaultModelRef = readAgentPrimaryModelRef(defaults);
  const defaultCompaction = asMutableRecord(defaults?.compaction);
  const hits = collectUnsupportedCodexCompactionOverridesForAgent({
    cfg: params.cfg,
    agent: defaults,
    path: "agents.defaults",
    currentRuntime: resolveRuntime({ defaultsRuntime }),
    env: params.env,
  });
  const agents = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asMutableRecord(agent);
    if (!agentRecord) {
      continue;
    }
    const id = readAgentPathId(agentRecord, index);
    hits.push(
      ...collectUnsupportedCodexCompactionOverridesForAgent({
        cfg: params.cfg,
        agent: agentRecord,
        path: `agents.list.${id}`,
        agentId: id,
        currentRuntime: resolveRuntime({
          agentRuntime: params.ignoreLegacyAgentRuntimePins
            ? undefined
            : asAgentRuntimePolicyConfig(agentRecord.agentRuntime),
          defaultsRuntime,
        }),
        inheritedModelRef: defaultModelRef,
        inheritedCompaction: defaultCompaction,
        inheritedCompactionPath: "agents.defaults.compaction",
        env: params.env,
      }),
    );
  }
  return dedupeUnsupportedCompactionOverrides(hits);
}

export function getSharedDefaultCompactionOverrideConsumers(params: {
  cfg: OpenClawConfig;
  ignoreLegacyAgentRuntimePins?: boolean;
  env?: NodeJS.ProcessEnv;
}): SharedDefaultCompactionOverrideConsumers {
  const consumers: SharedDefaultCompactionOverrideConsumers = { model: false, provider: false };
  const defaults = params.cfg.agents?.defaults;
  const defaultCompaction = asMutableRecord(defaults?.compaction);
  if (!defaultCompaction) {
    return consumers;
  }
  const hasDefaultModel =
    typeof defaultCompaction.model === "string" && defaultCompaction.model.trim();
  const hasDefaultProvider =
    typeof defaultCompaction.provider === "string" && defaultCompaction.provider.trim();
  if (!hasDefaultModel && !hasDefaultProvider) {
    return consumers;
  }
  const defaultsRuntime = readLegacyDefaultsRuntime(defaults);
  const inheritedModelRef = readAgentPrimaryModelRef(defaults);
  const defaultUsesCodexCompaction = agentUsesCodexRuntimeForCompaction({
    cfg: params.cfg,
    agent: defaults,
    currentRuntime: resolveRuntime({
      defaultsRuntime: params.ignoreLegacyAgentRuntimePins ? undefined : defaultsRuntime,
    }),
    env: params.env,
  });
  if (!defaultUsesCodexCompaction) {
    consumers.model ||= Boolean(hasDefaultModel);
    consumers.provider ||= Boolean(hasDefaultProvider);
    if ((!hasDefaultModel || consumers.model) && (!hasDefaultProvider || consumers.provider)) {
      return consumers;
    }
  }
  const agents = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asMutableRecord(agent);
    if (!agentRecord) {
      continue;
    }
    const compaction = asMutableRecord(agentRecord.compaction);
    const inheritsDefaultModel =
      Boolean(hasDefaultModel) &&
      !(typeof compaction?.model === "string" && compaction.model.trim());
    const inheritsDefaultProvider =
      Boolean(hasDefaultProvider) &&
      !(typeof compaction?.provider === "string" && compaction.provider.trim());
    if (!inheritsDefaultModel && !inheritsDefaultProvider) {
      continue;
    }
    const id = readAgentPathId(agentRecord, index);
    const usesCodexCompaction = agentUsesCodexRuntimeForCompaction({
      cfg: params.cfg,
      agent: agentRecord,
      agentId: id,
      currentRuntime: resolveRuntime({
        agentRuntime: params.ignoreLegacyAgentRuntimePins
          ? undefined
          : asAgentRuntimePolicyConfig(agentRecord.agentRuntime),
        defaultsRuntime: params.ignoreLegacyAgentRuntimePins ? undefined : defaultsRuntime,
      }),
      inheritedModelRef,
      env: params.env,
    });
    if (!usesCodexCompaction) {
      consumers.model ||= inheritsDefaultModel;
      consumers.provider ||= inheritsDefaultProvider;
      if ((!hasDefaultModel || consumers.model) && (!hasDefaultProvider || consumers.provider)) {
        break;
      }
    }
  }
  return consumers;
}

export function sharedDefaultLosslessCompactionHasNonCodexConsumer(params: {
  cfg: OpenClawConfig;
  ignoreLegacyAgentRuntimePins?: boolean;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const defaults = params.cfg.agents?.defaults;
  const defaultCompaction = asMutableRecord(defaults?.compaction);
  const hasDefaultLosslessProvider =
    normalizeString(defaultCompaction?.provider) === LOSSLESS_CONTEXT_ENGINE_ID;
  const hasDefaultModel =
    typeof defaultCompaction?.model === "string" && defaultCompaction.model.trim();
  if (!hasDefaultLosslessProvider && !hasDefaultModel) {
    return false;
  }
  const defaultsRuntime = params.ignoreLegacyAgentRuntimePins
    ? undefined
    : readLegacyDefaultsRuntime(defaults);
  if (
    !agentUsesCodexRuntimeForCompaction({
      cfg: params.cfg,
      agent: defaults,
      currentRuntime: resolveRuntime({ defaultsRuntime }),
      env: params.env,
    })
  ) {
    return true;
  }
  const inheritedModelRef = readAgentPrimaryModelRef(defaults);
  const agents = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asMutableRecord(agent);
    if (!agentRecord) {
      continue;
    }
    const compaction = asMutableRecord(agentRecord.compaction);
    const inheritsDefaultProvider =
      hasDefaultLosslessProvider &&
      !(typeof compaction?.provider === "string" && compaction.provider.trim());
    const inheritsDefaultModel =
      Boolean(hasDefaultModel) &&
      !(typeof compaction?.model === "string" && compaction.model.trim());
    if (!inheritsDefaultProvider && !inheritsDefaultModel) {
      continue;
    }
    const id = readAgentPathId(agentRecord, index);
    if (
      !agentUsesCodexRuntimeForCompaction({
        cfg: params.cfg,
        agent: agentRecord,
        agentId: id,
        env: params.env,
        currentRuntime: resolveRuntime({
          agentRuntime: params.ignoreLegacyAgentRuntimePins
            ? undefined
            : asAgentRuntimePolicyConfig(agentRecord.agentRuntime),
          defaultsRuntime,
        }),
        inheritedModelRef,
      })
    ) {
      return true;
    }
  }
  return false;
}

export function legacyLosslessSummaryModels(
  hits: readonly LegacyLosslessCompactionConfig[],
): string[] {
  const models = new Set<string>();
  for (const hit of hits) {
    if (!hit.modelValue) {
      continue;
    }
    models.add(
      toCanonicalOpenAIModelRef(hit.modelValue) ?? normalizeDefaultProviderModelRef(hit.modelValue),
    );
  }
  return [...models];
}

export function canAutoMigrateLegacyLosslessCompaction(params: {
  hits: readonly LegacyLosslessCompactionConfig[];
  contextEngine?: string;
  summaryModel?: string;
}): boolean {
  if (params.contextEngine && params.contextEngine !== LOSSLESS_CONTEXT_ENGINE_ID) {
    return false;
  }
  const models = legacyLosslessSummaryModels(params.hits);
  const hasProviderOnlyConsumer = params.hits.some((hit) => !hit.modelValue);
  if (hasProviderOnlyConsumer && (models.length > 0 || params.summaryModel)) {
    return false;
  }
  if (models.length === 0) {
    return true;
  }
  if (params.summaryModel) {
    return models.every((model) => model === params.summaryModel);
  }
  return models.length === 1;
}

export function readLosslessSummaryModel(plugins: MutableRecord | undefined): string | undefined {
  const entries = asMutableRecord(plugins?.entries);
  const entry = asMutableRecord(entries?.[LOSSLESS_CONTEXT_ENGINE_ID]);
  const config = asMutableRecord(entry?.config);
  return typeof config?.summaryModel === "string" && config.summaryModel.trim()
    ? config.summaryModel.trim()
    : undefined;
}

function dedupeLegacyLosslessCompactionConfigs(
  hits: LegacyLosslessCompactionConfig[],
): LegacyLosslessCompactionConfig[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.compactionPath}\0${hit.providerValue}\0${hit.modelPath ?? ""}\0${
      hit.modelValue ?? ""
    }`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function dedupeUnsupportedCompactionOverrides(
  hits: UnsupportedCodexCompactionOverride[],
): UnsupportedCodexCompactionOverride[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.path}\0${hit.key}\0${hit.value}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function readAgentPathId(agent: MutableRecord, index: number): string {
  return typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
}
