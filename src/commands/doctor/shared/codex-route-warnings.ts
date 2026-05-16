import fs from "node:fs";
import { resolveConfiguredProviderFallback } from "../../../agents/configured-provider-fallback.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../../agents/defaults.js";
import { splitTrailingAuthProfile } from "../../../agents/model-ref-profile.js";
import { normalizeConfiguredProviderCatalogModelId } from "../../../agents/model-ref-shared.js";
import { resolveModelRuntimePolicy } from "../../../agents/model-runtime-policy.js";
import { openAIProviderUsesCodexRuntimeByDefault } from "../../../agents/openai-codex-routing.js";
import { normalizeEmbeddedAgentRuntime } from "../../../agents/pi-embedded-runner/runtime.js";
import { normalizeProviderId } from "../../../agents/provider-id.js";
import { AGENT_MODEL_CONFIG_KEYS } from "../../../config/model-refs.js";
import { loadSessionStore, updateSessionStore } from "../../../config/sessions/store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../../config/sessions/targets.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { AgentRuntimePolicyConfig } from "../../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";

type CodexRouteHit = {
  path: string;
  model: string;
  canonicalModel: string;
  runtime?: string;
};
type CompactionOverrideKey = "model" | "provider";
type UnsupportedCodexCompactionOverride = {
  path: string;
  key: CompactionOverrideKey;
  value: string;
};
type LegacyLosslessCompactionConfig = {
  path: string;
  compactionPath: string;
  providerPath: string;
  providerValue: string;
  modelPath?: string;
  modelValue?: string;
};
type DisabledCodexPluginRouteHit = {
  path: string;
  modelRef: string;
  canonicalModel: string;
};
type SharedDefaultCompactionOverrideConsumers = Record<CompactionOverrideKey, boolean>;

type MutableRecord = Record<string, unknown>;
const COMPACTION_OVERRIDE_KEYS: readonly CompactionOverrideKey[] = ["model", "provider"];
const LOSSLESS_CONTEXT_ENGINE_ID = "lossless-claw";
type SessionRouteRepairResult = {
  changed: boolean;
  sessionKeys: string[];
};
type ConfigRouteRepairResult = {
  cfg: OpenClawConfig;
  changes: CodexRouteHit[];
  runtimePinChanges: string[];
  runtimePolicyChanges: string[];
  unsupportedCompactionChanges: string[];
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

function normalizeRuntimeString(value: unknown): string | undefined {
  const normalized = normalizeString(value);
  return normalized ? normalizeEmbeddedAgentRuntime(normalized) : undefined;
}

function asMutableRecord(value: unknown): MutableRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as MutableRecord)
    : undefined;
}

function asAgentRuntimePolicyConfig(value: unknown): AgentRuntimePolicyConfig | undefined {
  const record = asMutableRecord(value);
  return record ? { id: typeof record.id === "string" ? record.id : undefined } : undefined;
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
    normalizeRuntimeString(params.env?.OPENCLAW_AGENT_RUNTIME) ??
    normalizeRuntimeString(params.agentRuntime?.id) ??
    normalizeRuntimeString(params.defaultsRuntime?.id)
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

function readModelConfigPrimaryRef(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  const record = asMutableRecord(value);
  if (typeof record?.primary === "string") {
    return record.primary.trim() || undefined;
  }
  return undefined;
}

function readAgentPrimaryModelRef(agent: unknown, fallback?: string): string | undefined {
  const record = asMutableRecord(agent);
  if (!record) {
    return fallback;
  }
  return readModelConfigPrimaryRef(record.model) ?? fallback;
}

function concreteRuntimeId(runtime: string | undefined): string | undefined {
  return runtime && runtime !== "auto" && runtime !== "default" ? runtime : undefined;
}

function modelRefUsesCodexRuntime(params: {
  cfg: OpenClawConfig;
  modelRef: string | undefined;
  agentId?: string;
}): boolean {
  const effectiveModelRef = params.modelRef?.trim() || `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
  if (isOpenAICodexModelRef(effectiveModelRef)) {
    return true;
  }
  return canonicalOpenAIModelUsesCodexRuntime({
    cfg: params.cfg,
    modelRef: resolveRuntimeModelRef({
      cfg: params.cfg,
      modelRef: effectiveModelRef,
      agentId: params.agentId,
    }),
    agentId: params.agentId,
  });
}

function resolveRuntimeModelRef(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  agentId?: string;
}): string {
  const effectiveModelRef =
    normalizeProviderModelRefAuthProfile(params.modelRef) ?? `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
  const legacyCodexModel = toCanonicalOpenAIModelRef(effectiveModelRef);
  if (legacyCodexModel) {
    return legacyCodexModel;
  }
  return (
    resolveKnownCompatModelAliasRef(effectiveModelRef) ??
    resolveConfiguredModelAliasRef({
      cfg: params.cfg,
      modelRef: effectiveModelRef,
      agentId: params.agentId,
    }) ??
    resolveConfiguredBareModelRef({
      cfg: params.cfg,
      modelRef: effectiveModelRef,
      agentId: params.agentId,
    }) ??
    normalizeDefaultProviderModelRef(effectiveModelRef)
  );
}

function normalizeProviderModelRefAuthProfile(modelRef: string): string | undefined {
  const trimmed = modelRef.trim();
  if (!trimmed) {
    return undefined;
  }
  return splitTrailingAuthProfile(trimmed).model || trimmed;
}

function resolveKnownCompatModelAliasRef(modelRef: string): string | undefined {
  const normalized = normalizeString(modelRef);
  if (!normalized?.startsWith("openrouter:")) {
    return undefined;
  }
  const modelId = normalized.slice("openrouter:".length).trim();
  return modelId ? `openrouter/openrouter/${modelId}` : undefined;
}

function resolveConfiguredModelAliasRef(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  agentId?: string;
}): string | undefined {
  const aliasKey = normalizeString(params.modelRef);
  if (!aliasKey) {
    return undefined;
  }
  const defaultProvider = resolveDefaultProviderForAliasContext({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  return resolveAliasFromModelsMap(
    asMutableRecord(params.cfg.agents?.defaults?.models),
    aliasKey,
    defaultProvider,
  );
}

function resolveDefaultProviderForAliasContext(params: {
  cfg: OpenClawConfig;
  agentId?: string;
}): string {
  const primaryModelRef =
    readModelConfigPrimaryRef(findAgentById(params.cfg, params.agentId)?.model) ??
    readModelConfigPrimaryRef(params.cfg.agents?.defaults?.model);
  if (primaryModelRef) {
    const effectivePrimaryModelRef =
      normalizeProviderModelRefAuthProfile(primaryModelRef) ?? primaryModelRef;
    const legacyCodexModel = toCanonicalOpenAIModelRef(effectivePrimaryModelRef);
    const compatModelRef = resolveKnownCompatModelAliasRef(effectivePrimaryModelRef);
    const primaryAliasRef = resolveAliasFromModelsMap(
      asMutableRecord(params.cfg.agents?.defaults?.models),
      normalizeString(effectivePrimaryModelRef) ?? "",
      DEFAULT_PROVIDER,
    );
    const parsed =
      parseModelRef(
        primaryAliasRef ?? compatModelRef ?? legacyCodexModel ?? effectivePrimaryModelRef,
      ) ??
      parseModelRef(
        resolveConfiguredBareModelRef({
          cfg: params.cfg,
          modelRef: effectivePrimaryModelRef,
          agentId: params.agentId,
        }) ?? "",
      );
    return normalizeProviderId(parsed?.provider ?? DEFAULT_PROVIDER) || DEFAULT_PROVIDER;
  }
  const implicit = parseModelRef(resolveImplicitDefaultAgentModelRef(params.cfg));
  return normalizeProviderId(implicit?.provider ?? DEFAULT_PROVIDER) || DEFAULT_PROVIDER;
}

function findAgentById(
  cfg: OpenClawConfig,
  agentId: string | undefined,
): MutableRecord | undefined {
  if (!agentId) {
    return undefined;
  }
  const normalizedAgentId = normalizeAgentId(agentId);
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  return agents
    .map((agent) => asMutableRecord(agent))
    .find(
      (agent) =>
        normalizeAgentId(typeof agent?.id === "string" ? agent.id : undefined) ===
        normalizedAgentId,
    );
}

function resolveAliasFromModelsMap(
  models: MutableRecord | undefined,
  aliasKey: string,
  defaultProvider: string,
): string | undefined {
  for (const [modelRef, entry] of Object.entries(models ?? {})) {
    if (normalizeString(asMutableRecord(entry)?.alias) !== aliasKey) {
      continue;
    }
    const compatRef = resolveKnownCompatModelAliasRef(modelRef);
    if (compatRef) {
      return compatRef;
    }
    return modelRef.includes("/")
      ? normalizeDefaultProviderModelRef(modelRef)
      : `${defaultProvider}/${modelRef}`;
  }
  return undefined;
}

function resolveConfiguredBareModelRef(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  agentId?: string;
}): string | undefined {
  const modelId = params.modelRef.trim();
  if (!modelId || modelId.includes("/")) {
    return undefined;
  }
  const matches = new Set<string>();
  const pushModelMapMatches = (models: MutableRecord | undefined) => {
    for (const key of Object.keys(models ?? {})) {
      const parsed = parseModelRef(key);
      if (parsed?.modelId === modelId) {
        matches.add(`${parsed.provider}/${parsed.modelId}`);
      }
    }
  };
  pushModelMapMatches(asMutableRecord(params.cfg.agents?.defaults?.models));
  for (const [provider, providerConfig] of Object.entries(params.cfg.models?.providers ?? {})) {
    for (const model of providerConfig?.models ?? []) {
      if (providerCatalogModelMatches(provider, model?.id, modelId)) {
        matches.add(`${normalizeProviderId(provider)}/${modelId}`);
      }
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

function providerCatalogModelMatches(
  provider: string,
  catalogModelId: string | undefined,
  modelId: string,
): boolean {
  const rawId = catalogModelId?.trim();
  if (!rawId) {
    return false;
  }
  const normalizedId = normalizeConfiguredProviderCatalogModelId(provider, rawId);
  if (normalizedId === modelId) {
    return true;
  }
  return normalizeString(normalizedId) === normalizeString(modelId);
}

function normalizeDefaultProviderModelRef(modelRef: string): string {
  return modelRef.includes("/") ? modelRef : `${DEFAULT_PROVIDER}/${modelRef}`;
}

function normalizeProviderModelRef(provider: string, modelId: string): string {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModelId = normalizeConfiguredProviderCatalogModelId(normalizedProvider, modelId);
  const slash = normalizedModelId.indexOf("/");
  if (
    slash > 0 &&
    normalizeProviderId(normalizedModelId.slice(0, slash)) === normalizedProvider &&
    slash < normalizedModelId.length - 1
  ) {
    return `${normalizedProvider}/${normalizedModelId.slice(slash + 1)}`;
  }
  return `${normalizedProvider}/${normalizedModelId}`;
}

function resolveImplicitDefaultAgentModelRef(cfg: OpenClawConfig): string {
  const fallbackProvider = resolveConfiguredProviderFallback({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  return fallbackProvider
    ? normalizeProviderModelRef(fallbackProvider.provider, fallbackProvider.model)
    : `${DEFAULT_PROVIDER}/${DEFAULT_MODEL}`;
}

function agentUsesCodexRuntimeForCompaction(params: {
  cfg: OpenClawConfig;
  agent: unknown;
  agentId?: string;
  currentRuntime?: string;
  inheritedModelRef?: string;
}): boolean {
  const runtime = concreteRuntimeId(normalizeString(params.currentRuntime));
  if (runtime) {
    return runtime === "codex";
  }
  return modelRefUsesCodexRuntime({
    cfg: params.cfg,
    modelRef: readAgentPrimaryModelRef(params.agent, params.inheritedModelRef),
    agentId: params.agentId,
  });
}

function collectUnsupportedCodexCompactionOverridesForAgent(params: {
  cfg: OpenClawConfig;
  agent: unknown;
  path: string;
  agentId?: string;
  currentRuntime?: string;
  inheritedModelRef?: string;
  inheritedCompaction?: unknown;
  inheritedCompactionPath?: string;
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

function collectLegacyLosslessCompactionConfigs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  ignoreLegacyAgentRuntimePins?: boolean;
}): LegacyLosslessCompactionConfig[] {
  const defaults = params.cfg.agents?.defaults;
  const defaultsRuntime = params.ignoreLegacyAgentRuntimePins ? undefined : defaults?.agentRuntime;
  const defaultModelRef = readAgentPrimaryModelRef(defaults);
  const defaultCompaction = asMutableRecord(defaults?.compaction);
  const hits = collectLegacyLosslessCompactionForAgent({
    cfg: params.cfg,
    agent: defaults,
    path: "agents.defaults",
    currentRuntime: resolveRuntime({ env: params.env, defaultsRuntime }),
  });
  const agents = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asMutableRecord(agent);
    if (!agentRecord) {
      continue;
    }
    const id =
      typeof agentRecord.id === "string" && agentRecord.id.trim()
        ? agentRecord.id.trim()
        : String(index);
    hits.push(
      ...collectLegacyLosslessCompactionForAgent({
        cfg: params.cfg,
        agent: agentRecord,
        path: `agents.list.${id}`,
        agentId: id,
        currentRuntime: resolveRuntime({
          env: params.env,
          agentRuntime: params.ignoreLegacyAgentRuntimePins
            ? undefined
            : asAgentRuntimePolicyConfig(agentRecord.agentRuntime),
          defaultsRuntime,
        }),
        inheritedModelRef: defaultModelRef,
        inheritedCompaction: defaultCompaction,
        inheritedCompactionPath: "agents.defaults.compaction",
      }),
    );
  }
  return dedupeLegacyLosslessCompactionConfigs(hits);
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

function collectUnsupportedCodexCompactionOverrides(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  ignoreLegacyAgentRuntimePins?: boolean;
}): UnsupportedCodexCompactionOverride[] {
  const defaults = params.cfg.agents?.defaults;
  const defaultsRuntime = params.ignoreLegacyAgentRuntimePins ? undefined : defaults?.agentRuntime;
  const defaultModelRef = readAgentPrimaryModelRef(defaults);
  const defaultCompaction = asMutableRecord(defaults?.compaction);
  const hits = collectUnsupportedCodexCompactionOverridesForAgent({
    cfg: params.cfg,
    agent: defaults,
    path: "agents.defaults",
    currentRuntime: resolveRuntime({ env: params.env, defaultsRuntime }),
  });
  const agents = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asMutableRecord(agent);
    if (!agentRecord) {
      continue;
    }
    const id =
      typeof agentRecord.id === "string" && agentRecord.id.trim()
        ? agentRecord.id.trim()
        : String(index);
    hits.push(
      ...collectUnsupportedCodexCompactionOverridesForAgent({
        cfg: params.cfg,
        agent: agentRecord,
        path: `agents.list.${id}`,
        agentId: id,
        currentRuntime: resolveRuntime({
          env: params.env,
          agentRuntime: params.ignoreLegacyAgentRuntimePins
            ? undefined
            : asAgentRuntimePolicyConfig(agentRecord.agentRuntime),
          defaultsRuntime,
        }),
        inheritedModelRef: defaultModelRef,
        inheritedCompaction: defaultCompaction,
        inheritedCompactionPath: "agents.defaults.compaction",
      }),
    );
  }
  return dedupeUnsupportedCompactionOverrides(hits);
}

function getSharedDefaultCompactionOverrideConsumers(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  ignoreLegacyAgentRuntimePins?: boolean;
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
  const defaultsRuntime = defaults?.agentRuntime;
  const inheritedModelRef = readAgentPrimaryModelRef(defaults);
  const defaultUsesCodexCompaction = agentUsesCodexRuntimeForCompaction({
    cfg: params.cfg,
    agent: defaults,
    currentRuntime: resolveRuntime({
      env: params.env,
      defaultsRuntime: params.ignoreLegacyAgentRuntimePins ? undefined : defaultsRuntime,
    }),
  });
  if (!defaultUsesCodexCompaction) {
    consumers.model ||= Boolean(hasDefaultModel);
    consumers.provider ||= Boolean(hasDefaultProvider);
    if ((!hasDefaultModel || consumers.model) && (!hasDefaultProvider || consumers.provider)) {
      return consumers;
    }
  }
  const agents = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
  if (agents.length === 0) {
    return consumers;
  }
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
    const id =
      typeof agentRecord.id === "string" && agentRecord.id.trim()
        ? agentRecord.id.trim()
        : String(index);
    const usesCodexCompaction = agentUsesCodexRuntimeForCompaction({
      cfg: params.cfg,
      agent: agentRecord,
      agentId: id,
      currentRuntime: resolveRuntime({
        env: params.env,
        agentRuntime: params.ignoreLegacyAgentRuntimePins
          ? undefined
          : asAgentRuntimePolicyConfig(agentRecord.agentRuntime),
        defaultsRuntime: params.ignoreLegacyAgentRuntimePins ? undefined : defaultsRuntime,
      }),
      inheritedModelRef,
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

function sharedDefaultLosslessCompactionHasNonCodexConsumer(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  ignoreLegacyAgentRuntimePins?: boolean;
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
  const defaultsRuntime = params.ignoreLegacyAgentRuntimePins ? undefined : defaults?.agentRuntime;
  const defaultUsesCodexCompaction = agentUsesCodexRuntimeForCompaction({
    cfg: params.cfg,
    agent: defaults,
    currentRuntime: resolveRuntime({ env: params.env, defaultsRuntime }),
  });
  if (!defaultUsesCodexCompaction) {
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
    const id =
      typeof agentRecord.id === "string" && agentRecord.id.trim()
        ? agentRecord.id.trim()
        : String(index);
    const usesCodexCompaction = agentUsesCodexRuntimeForCompaction({
      cfg: params.cfg,
      agent: agentRecord,
      agentId: id,
      currentRuntime: resolveRuntime({
        env: params.env,
        agentRuntime: params.ignoreLegacyAgentRuntimePins
          ? undefined
          : asAgentRuntimePolicyConfig(agentRecord.agentRuntime),
        defaultsRuntime,
      }),
      inheritedModelRef,
    });
    if (!usesCodexCompaction) {
      return true;
    }
  }
  return false;
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

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asMutableRecord(agent);
    if (!agentRecord) {
      continue;
    }
    const id =
      typeof agentRecord.id === "string" && agentRecord.id.trim()
        ? agentRecord.id.trim()
        : String(index);
    collectAgentModelRefs({
      hits,
      agent: agentRecord,
      path: `agents.list.${id}`,
      runtime: resolveRuntime({
        env,
        agentRuntime: asAgentRuntimePolicyConfig(agentRecord.agentRuntime),
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

function pluginIdListIncludes(value: unknown, pluginId: string): boolean {
  return Array.isArray(value) && value.some((entry) => normalizeString(entry) === pluginId);
}

function codexPluginAllowlistIsRestrictive(cfg: OpenClawConfig): boolean {
  const allow = cfg.plugins?.allow;
  return Array.isArray(allow) && allow.length > 0 && !pluginIdListIncludes(allow, "codex");
}

function isCodexPluginUnavailableByConfig(cfg: OpenClawConfig): boolean {
  if (codexPluginIsBlockedOutsideEntry(cfg)) {
    return true;
  }
  if (asMutableRecord(asMutableRecord(cfg.plugins?.entries)?.codex)?.enabled === false) {
    return true;
  }
  return codexPluginAllowlistIsRestrictive(cfg);
}

function codexPluginIsBlockedOutsideEntry(cfg: OpenClawConfig): boolean {
  if (cfg.plugins?.enabled === false) {
    return true;
  }
  return pluginIdListIncludes(cfg.plugins?.deny, "codex");
}

function collectAgentRuntimeModelRefs(params: {
  agent: unknown;
  path: string;
  fallbackModelRefs?: ReadonlyArray<{ path: string; modelRef: string }>;
  inheritedModelRefs?: ReadonlyArray<{ path: string; modelRef: string }>;
}): Array<{ path: string; modelRef: string }> {
  const refs: Array<{ path: string; modelRef: string }> = [];
  const agent = asMutableRecord(params.agent);
  if (agent && Object.prototype.hasOwnProperty.call(agent, "model")) {
    collectModelConfigRefs({
      refs,
      path: `${params.path}.model`,
      value: agent.model,
    });
  }
  if (!hasAgentPrimaryModelConfig(agent) && params.fallbackModelRefs) {
    refs.push(...params.fallbackModelRefs);
  }
  collectStringModelConfigRef({
    refs,
    path: `${params.path}.heartbeat.model`,
    value: asMutableRecord(agent?.heartbeat)?.model,
  });
  collectModelConfigRefs({
    refs,
    path: `${params.path}.subagents.model`,
    value: asMutableRecord(agent?.subagents)?.model,
  });
  if (params.inheritedModelRefs) {
    refs.push(...params.inheritedModelRefs);
  }
  collectCodexRuntimeModelPolicyRefs({
    refs,
    path: `${params.path}.models`,
    models: agent?.models,
  });
  return refs;
}

function hasAgentPrimaryModelConfig(agent: unknown): boolean {
  const record = asMutableRecord(agent);
  return Boolean(record && readModelConfigPrimaryRef(record.model));
}

function collectChannelAgentRuntimeModelRefs(
  cfg: OpenClawConfig,
): Array<{ path: string; modelRef: string }> {
  const refs: Array<{ path: string; modelRef: string }> = [];
  const channelsModelByChannel = asMutableRecord(cfg.channels?.modelByChannel);
  for (const [channelId, channelMapValue] of Object.entries(channelsModelByChannel ?? {})) {
    const channelMap = asMutableRecord(channelMapValue);
    if (!channelMap) {
      continue;
    }
    for (const [targetId, modelRef] of Object.entries(channelMap)) {
      collectStringModelConfigRef({
        refs,
        path: `channels.modelByChannel.${channelId}.${targetId}`,
        value: modelRef,
      });
    }
  }
  return refs;
}

function collectDisabledCodexPluginRouteHits(cfg: OpenClawConfig): DisabledCodexPluginRouteHit[] {
  if (!isCodexPluginUnavailableByConfig(cfg)) {
    return [];
  }
  const defaults = cfg.agents?.defaults;
  const defaultRefs = collectAgentRuntimeModelRefs({
    agent: defaults,
    path: "agents.defaults",
  });
  if (
    cfg.agents &&
    !hasAgentPrimaryModelConfig(defaults) &&
    !defaultRefs.some(
      (ref) =>
        resolveRuntimeModelRef({ cfg, modelRef: ref.modelRef }) ===
        resolveImplicitDefaultAgentModelRef(cfg),
    )
  ) {
    defaultRefs.push({
      path: "agents.defaults.model",
      modelRef: resolveImplicitDefaultAgentModelRef(cfg),
    });
  }

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const inheritedDefaultAuxRefs = defaultRefs.filter(
    (ref) =>
      ref.path === "agents.defaults.heartbeat.model" ||
      ref.path.startsWith("agents.defaults.subagents.model"),
  );
  const inheritedDefaultModelPolicyRefs = defaultRefs.filter((ref) =>
    ref.path.startsWith("agents.defaults.models."),
  );
  const inheritedDefaultModelRefs = defaultRefs.filter(
    (ref) =>
      !inheritedDefaultAuxRefs.includes(ref) && !inheritedDefaultModelPolicyRefs.includes(ref),
  );
  const candidateRefs: Array<{ path: string; modelRef: string; agentId?: string }> =
    agents.length === 0 ? [...defaultRefs] : [];
  candidateRefs.push(...collectChannelAgentRuntimeModelRefs(cfg));
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asMutableRecord(agent);
    if (!agentRecord) {
      continue;
    }
    const pathId =
      typeof agentRecord.id === "string" && agentRecord.id.trim()
        ? agentRecord.id.trim()
        : String(index);
    const agentId = normalizeAgentId(
      typeof agentRecord.id === "string" ? agentRecord.id : undefined,
    );
    const inheritedModelRefs = inheritedDefaultAuxRefs.filter((ref) => {
      if (ref.path === "agents.defaults.heartbeat.model") {
        return !normalizeString(asMutableRecord(agentRecord.heartbeat)?.model);
      }
      if (ref.path.startsWith("agents.defaults.subagents.model")) {
        return !readModelConfigPrimaryRef(asMutableRecord(agentRecord.subagents)?.model);
      }
      return true;
    });
    inheritedModelRefs.push(...inheritedDefaultModelPolicyRefs);
    for (const ref of collectAgentRuntimeModelRefs({
      agent: agentRecord,
      path: `agents.list.${pathId}`,
      fallbackModelRefs: inheritedDefaultModelRefs,
      inheritedModelRefs,
    })) {
      candidateRefs.push({ ...ref, agentId });
    }
  }

  const hits: DisabledCodexPluginRouteHit[] = [];
  const seen = new Set<string>();
  for (const ref of candidateRefs) {
    const canonicalModel = resolveRuntimeModelRef({
      cfg,
      modelRef: ref.modelRef,
      agentId: ref.agentId,
    });
    if (
      !modelRefUsesCodexRuntime({
        cfg,
        modelRef: ref.modelRef,
        agentId: ref.agentId,
      })
    ) {
      continue;
    }
    const key = `${ref.agentId ?? ""}\0${ref.path}\0${canonicalModel}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    hits.push({ path: ref.path, modelRef: ref.modelRef, canonicalModel });
  }
  return hits;
}

function enableCodexPluginForRequiredRoutes(params: {
  cfg: OpenClawConfig;
  routeHits: DisabledCodexPluginRouteHit[];
}): { cfg: OpenClawConfig; changes: string[] } {
  if (params.routeHits.length === 0 || codexPluginIsBlockedOutsideEntry(params.cfg)) {
    return { cfg: params.cfg, changes: [] };
  }
  const cfg = structuredClone(params.cfg);
  const plugins = asMutableRecord(cfg.plugins) ?? {};
  if (cfg.plugins !== plugins) {
    cfg.plugins = plugins;
  }
  const entries = asMutableRecord(plugins.entries) ?? {};
  if (plugins.entries !== entries) {
    plugins.entries = entries;
  }
  const codexEntry = asMutableRecord(entries.codex) ?? {};
  const changes: string[] = [];
  if (codexEntry.enabled !== true) {
    entries.codex = {
      ...codexEntry,
      enabled: true,
    };
    changes.push(
      "Enabled plugins.entries.codex because configured agent routes use Codex runtime.",
    );
  } else if (entries.codex !== codexEntry) {
    entries.codex = codexEntry;
  }
  if (
    Array.isArray(plugins.allow) &&
    plugins.allow.length > 0 &&
    !plugins.allow.some((id) => normalizeString(id) === "codex")
  ) {
    plugins.allow = [...plugins.allow, "codex"];
    changes.push("Added codex to plugins.allow because configured agent routes use Codex runtime.");
  }
  return { cfg, changes };
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

function collectModelConfigRefs(params: {
  refs: Array<{ path: string; modelRef: string }>;
  path: string;
  value: unknown;
}): void {
  if (typeof params.value === "string") {
    collectStringModelConfigRef(params);
    return;
  }
  const record = asMutableRecord(params.value);
  if (!record) {
    return;
  }
  if (typeof record.primary === "string" && record.primary.trim()) {
    params.refs.push({ path: `${params.path}.primary`, modelRef: record.primary.trim() });
  }
  if (Array.isArray(record.fallbacks)) {
    for (const [index, entry] of record.fallbacks.entries()) {
      if (typeof entry === "string" && entry.trim()) {
        params.refs.push({ path: `${params.path}.fallbacks.${index}`, modelRef: entry.trim() });
      }
    }
  }
}

function collectStringModelConfigRef(params: {
  refs: Array<{ path: string; modelRef: string }>;
  path: string;
  value: unknown;
}): void {
  if (typeof params.value !== "string") {
    return;
  }
  const modelRef = params.value.trim();
  if (modelRef) {
    params.refs.push({ path: params.path, modelRef });
  }
}

function collectCodexRuntimeModelPolicyRefs(params: {
  refs: Array<{ path: string; modelRef: string }>;
  path: string;
  models: unknown;
}): void {
  const record = asMutableRecord(params.models);
  if (!record) {
    return;
  }
  for (const [modelRef, entry] of Object.entries(record)) {
    const trimmed = modelRef.trim();
    if (!trimmed) {
      continue;
    }
    const runtime = normalizeEmbeddedAgentRuntime(
      normalizeString(asMutableRecord(asMutableRecord(entry)?.agentRuntime)?.id),
    );
    if (runtime === "codex") {
      params.refs.push({ path: `${params.path}.${trimmed}`, modelRef: trimmed });
    }
  }
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
  const configured = normalizeRuntimeString(
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
  inheritedModelRef?: string;
  inheritedCompaction?: unknown;
  inheritedCompactionPath?: string;
  rewriteModelsMap?: boolean;
  preserveUnsupportedCompactionOverrides?: SharedDefaultCompactionOverrideConsumers;
  preserveUnsupportedCompactionPaths?: ReadonlySet<string>;
  rewrittenInheritedCompactionModels?: Map<string, string>;
  runtimePolicyChanges: string[];
  unsupportedCompactionChanges: string[];
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
  const inheritedCompaction = asMutableRecord(params.inheritedCompaction);
  const usesCodexCompaction = agentUsesCodexRuntimeForCompaction({
    cfg: params.cfg,
    agent,
    agentId: params.agentId,
    currentRuntime: params.currentRuntime,
    inheritedModelRef: params.inheritedModelRef,
  });
  if (usesCodexCompaction) {
    const effectiveCompactionProvider = compaction?.provider ?? inheritedCompaction?.provider;
    if (normalizeString(effectiveCompactionProvider) === LOSSLESS_CONTEXT_ENGINE_ID) {
      const start = params.hits.length;
      rewriteStringModelSlot({
        hits: params.hits,
        container: compaction,
        key: "model",
        path: `${params.path}.compaction.model`,
      });
      preserveCodexRuntimePolicyForNewHits(start);
      const localModel = typeof compaction?.model === "string" ? compaction.model.trim() : "";
      const inheritedModelPath = params.inheritedCompactionPath
        ? `${params.inheritedCompactionPath}.model`
        : undefined;
      if (
        !localModel &&
        inheritedModelPath &&
        params.preserveUnsupportedCompactionPaths?.has(inheritedModelPath)
      ) {
        const inheritedStart = params.hits.length;
        rewriteStringModelSlot({
          hits: params.hits,
          container: inheritedCompaction,
          key: "model",
          path: inheritedModelPath,
        });
        const inheritedHit = params.hits[inheritedStart];
        const inheritedCanonicalModel =
          inheritedHit?.canonicalModel ??
          params.rewrittenInheritedCompactionModels?.get(inheritedModelPath);
        if (inheritedHit) {
          params.rewrittenInheritedCompactionModels?.set(
            inheritedModelPath,
            inheritedHit.canonicalModel,
          );
          preserveCodexRuntimePolicyForNewHits(inheritedStart);
        } else if (inheritedCanonicalModel) {
          ensureCodexRuntimePolicy({
            cfg: params.cfg,
            agent,
            agentPath: params.path,
            modelRef: inheritedCanonicalModel,
            isDefaults: params.path === "agents.defaults",
            changes: params.runtimePolicyChanges,
          });
        }
      }
    } else {
      removeUnsupportedCodexCompactionOverrides({
        agent,
        compaction,
        path: params.path,
        preserve: params.preserveUnsupportedCompactionOverrides,
        preservePaths: params.preserveUnsupportedCompactionPaths,
        changes: params.unsupportedCompactionChanges,
      });
      if (params.preserveUnsupportedCompactionOverrides?.model) {
        rewriteStringModelSlot({
          hits: params.hits,
          container: compaction,
          key: "model",
          path: `${params.path}.compaction.model`,
        });
      }
    }
  } else {
    rewriteStringModelSlotIfCanonicalCodexRuntime({
      cfg: params.cfg,
      agentId: params.agentId,
      hits: params.hits,
      container: compaction,
      key: "model",
      path: `${params.path}.compaction.model`,
    });
  }
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

function removeUnsupportedCodexCompactionOverrides(params: {
  agent: MutableRecord;
  compaction: MutableRecord | undefined;
  path: string;
  preserve?: Partial<Record<CompactionOverrideKey, boolean>>;
  preservePaths?: ReadonlySet<string>;
  changes: string[];
}): void {
  if (!params.compaction) {
    return;
  }
  if (normalizeString(params.compaction.provider) === LOSSLESS_CONTEXT_ENGINE_ID) {
    return;
  }
  for (const key of COMPACTION_OVERRIDE_KEYS) {
    const path = `${params.path}.compaction.${key}`;
    if (params.preservePaths?.has(path)) {
      continue;
    }
    if (params.preserve?.[key]) {
      continue;
    }
    const value = params.compaction[key];
    if (typeof value !== "string" || !value.trim()) {
      continue;
    }
    delete params.compaction[key];
    params.changes.push(`Removed ${path}; Codex runtime uses native server-side compaction.`);
  }
  if (Object.keys(params.compaction).length === 0) {
    delete params.agent.compaction;
  }
}

function readMutablePath(root: MutableRecord, pathLabel: string): MutableRecord | undefined {
  const parts = pathLabel.split(".");
  let cursor: unknown = root;
  for (const part of parts) {
    const record = asMutableRecord(cursor);
    if (!record) {
      return undefined;
    }
    cursor = record[part];
  }
  return asMutableRecord(cursor);
}

function readCompactionOwnerForPath(
  cfg: OpenClawConfig,
  ownerPath: string,
): MutableRecord | undefined {
  if (ownerPath === "agents.defaults") {
    return asMutableRecord(cfg.agents?.defaults);
  }
  const prefix = "agents.list.";
  if (!ownerPath.startsWith(prefix)) {
    return readMutablePath(cfg as MutableRecord, ownerPath);
  }
  const label = ownerPath.slice(prefix.length);
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  const agentWithId = agents.find((agent) => agent.id === label);
  if (agentWithId) {
    return asMutableRecord(agentWithId);
  }
  const index = Number(label);
  const candidate = Number.isInteger(index) ? agents[index] : undefined;
  if (candidate) {
    return asMutableRecord(candidate);
  }
  return undefined;
}

function removeMigratedLosslessCompactionKey(params: {
  cfg: OpenClawConfig;
  path: string;
  key: CompactionOverrideKey;
  changes: string[];
  changeMessage: string;
}): void {
  const ownerPath = readCompactionOwnerPathForKeyPath(params.path);
  const owner = readCompactionOwnerForPath(params.cfg, ownerPath);
  const compaction = asMutableRecord(owner?.compaction);
  if (!owner || !compaction) {
    return;
  }
  const value = compaction[params.key];
  if (typeof value !== "string" || !value.trim()) {
    return;
  }
  delete compaction[params.key];
  params.changes.push(params.changeMessage);
  if (Object.keys(compaction).length === 0) {
    delete owner.compaction;
  }
}

function readCompactionOwnerPathForKeyPath(path: string): string {
  return path.replace(/\.(model|provider)$/, "").replace(/\.compaction$/, "");
}

function legacyLosslessSummaryModels(hits: readonly LegacyLosslessCompactionConfig[]): string[] {
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

function preserveMigratedLosslessCodexRuntimePolicy(params: {
  cfg: OpenClawConfig;
  hits: readonly LegacyLosslessCompactionConfig[];
  summaryModel: string | undefined;
  changes: string[];
}): void {
  if (!params.summaryModel) {
    return;
  }
  const preservedOwners = new Set<string>();
  for (const hit of params.hits) {
    if (!hit.modelValue || !isOpenAICodexModelRef(hit.modelValue)) {
      continue;
    }
    const canonicalModel = toCanonicalOpenAIModelRef(hit.modelValue);
    if (canonicalModel !== params.summaryModel) {
      continue;
    }
    const ownerPath = readCompactionOwnerPathForKeyPath(hit.modelPath ?? hit.providerPath);
    if (preservedOwners.has(ownerPath)) {
      continue;
    }
    const owner = readCompactionOwnerForPath(params.cfg, ownerPath);
    if (!owner) {
      continue;
    }
    preservedOwners.add(ownerPath);
    ensureCodexRuntimePolicy({
      cfg: params.cfg,
      agent: owner,
      agentPath: ownerPath,
      modelRef: params.summaryModel,
      isDefaults: ownerPath === "agents.defaults",
      changes: params.changes,
    });
  }
}

function canAutoMigrateLegacyLosslessCompaction(params: {
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

function readLosslessSummaryModel(plugins: MutableRecord | undefined): string | undefined {
  const entries = asMutableRecord(plugins?.entries);
  const entry = asMutableRecord(entries?.[LOSSLESS_CONTEXT_ENGINE_ID]);
  const config = asMutableRecord(entry?.config);
  return typeof config?.summaryModel === "string" && config.summaryModel.trim()
    ? config.summaryModel.trim()
    : undefined;
}

function ensureMutablePath(root: MutableRecord, path: readonly string[]): MutableRecord {
  let cursor = root;
  for (const part of path) {
    const next = asMutableRecord(cursor[part]) ?? {};
    if (cursor[part] !== next) {
      cursor[part] = next;
    }
    cursor = next;
  }
  return cursor;
}

function ensureLosslessLlmPolicy(params: {
  entry: MutableRecord;
  summaryModel: string | undefined;
  changes: string[];
}): void {
  if (!params.summaryModel) {
    return;
  }
  const llm = ensureMutablePath(params.entry, ["llm"]);
  if (llm.allowModelOverride !== true) {
    llm.allowModelOverride = true;
    params.changes.push(
      `Set plugins.entries.${LOSSLESS_CONTEXT_ENGINE_ID}.llm.allowModelOverride to true for Lossless summary model overrides.`,
    );
  }
  const allowedModels = Array.isArray(llm.allowedModels) ? [...llm.allowedModels] : [];
  if (!allowedModels.includes(params.summaryModel)) {
    allowedModels.push(params.summaryModel);
    llm.allowedModels = allowedModels;
    params.changes.push(
      `Added ${params.summaryModel} to plugins.entries.${LOSSLESS_CONTEXT_ENGINE_ID}.llm.allowedModels.`,
    );
  }
}

function maybeMigrateLegacyLosslessCompactionConfig(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  ignoreLegacyAgentRuntimePins?: boolean;
}): string[] {
  const root = params.cfg as MutableRecord;
  const hits = collectLegacyLosslessCompactionConfigs(params);
  if (hits.length === 0) {
    return [];
  }
  const existingPlugins = asMutableRecord(root.plugins);
  const existingSlots = asMutableRecord(existingPlugins?.slots);
  const configuredContextEngine =
    typeof existingSlots?.contextEngine === "string" && existingSlots.contextEngine.trim()
      ? existingSlots.contextEngine.trim()
      : undefined;
  const existingSummaryModel = readLosslessSummaryModel(existingPlugins);
  const contextEngine = normalizeString(configuredContextEngine);
  if (
    sharedDefaultLosslessCompactionHasNonCodexConsumer(params) ||
    !canAutoMigrateLegacyLosslessCompaction({
      hits,
      contextEngine,
      summaryModel: existingSummaryModel,
    })
  ) {
    return [];
  }
  const plugins = ensureMutablePath(root, ["plugins"]);
  const slots = ensureMutablePath(plugins, ["slots"]);
  const changes: string[] = [];
  const entries = ensureMutablePath(plugins, ["entries"]);
  const entry = asMutableRecord(entries[LOSSLESS_CONTEXT_ENGINE_ID]) ?? {};
  if (entries[LOSSLESS_CONTEXT_ENGINE_ID] !== entry) {
    entries[LOSSLESS_CONTEXT_ENGINE_ID] = entry;
  }
  const config = ensureMutablePath(entry, ["config"]);
  if (slots.contextEngine !== LOSSLESS_CONTEXT_ENGINE_ID) {
    slots.contextEngine = LOSSLESS_CONTEXT_ENGINE_ID;
    changes.push(
      `Set plugins.slots.contextEngine to "${LOSSLESS_CONTEXT_ENGINE_ID}" for legacy Lossless compaction config.`,
    );
  }
  if (entry.enabled !== true) {
    entry.enabled = true;
    changes.push(`Enabled plugins.entries.${LOSSLESS_CONTEXT_ENGINE_ID}.`);
  }
  let summaryModel = existingSummaryModel;
  const firstModel = legacyLosslessSummaryModels(hits)[0];
  if (!summaryModel && firstModel) {
    summaryModel = firstModel;
    config.summaryModel = summaryModel;
    changes.push(
      `Moved ${hits.find((hit) => hit.modelValue)?.modelPath ?? "legacy compaction model"} to plugins.entries.${LOSSLESS_CONTEXT_ENGINE_ID}.config.summaryModel.`,
    );
  }
  ensureLosslessLlmPolicy({ entry, summaryModel, changes });
  preserveMigratedLosslessCodexRuntimePolicy({
    cfg: params.cfg,
    hits,
    summaryModel,
    changes,
  });
  for (const hit of hits) {
    removeMigratedLosslessCompactionKey({
      cfg: params.cfg,
      path: hit.providerPath,
      key: "provider",
      changes,
      changeMessage: `Removed ${hit.providerPath}; Lossless now runs through plugins.slots.contextEngine.`,
    });
    if (hit.modelPath) {
      removeMigratedLosslessCompactionKey({
        cfg: params.cfg,
        path: hit.modelPath,
        key: "model",
        changes,
        changeMessage: `Removed ${hit.modelPath} after migrating the Lossless summary model.`,
      });
    }
  }
  return changes;
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
  const configured = normalizeRuntimeString(
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
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asMutableRecord(agent);
    if (!agentRecord) {
      continue;
    }
    const id =
      typeof agentRecord.id === "string" && agentRecord.id.trim()
        ? agentRecord.id.trim()
        : String(index);
    clearLegacyAgentRuntimePolicy(agentRecord, `agents.list.${id}`, changes);
  }
  return changes;
}

function isCompactionOnlyRouteHit(hit: CodexRouteHit): boolean {
  return (
    hit.path.startsWith("agents.") &&
    (hit.path.endsWith(".compaction.model") || hit.path.endsWith(".compaction.memoryFlush.model"))
  );
}

function rewriteConfigModelRefsWithCompactionPolicy(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  preserveSharedDefaultCompactionOverrides: SharedDefaultCompactionOverrideConsumers;
  ignoreLegacyAgentRuntimePins?: boolean;
}): ConfigRouteRepairResult {
  const nextConfig = structuredClone(params.cfg);
  const hits: CodexRouteHit[] = [];
  const runtimePolicyChanges: string[] = [];
  const unsupportedCompactionChanges: string[] = [];
  const ignoreLegacyAgentRuntimePins =
    params.ignoreLegacyAgentRuntimePins ??
    configRepairWouldClearLegacyRuntimePins({
      cfg: nextConfig,
      env: params.env,
    });
  unsupportedCompactionChanges.push(
    ...maybeMigrateLegacyLosslessCompactionConfig({
      cfg: nextConfig,
      env: params.env,
      ignoreLegacyAgentRuntimePins,
    }),
  );
  const preservedLegacyLosslessCompactionPaths = new Set(
    collectLegacyLosslessCompactionConfigs({
      cfg: nextConfig,
      env: params.env,
      ignoreLegacyAgentRuntimePins,
    }).flatMap((hit) => (hit.modelPath ? [hit.providerPath, hit.modelPath] : [hit.providerPath])),
  );
  const defaultsRuntime = ignoreLegacyAgentRuntimePins
    ? undefined
    : nextConfig.agents?.defaults?.agentRuntime;
  const rewrittenInheritedCompactionModels = new Map<string, string>();
  rewriteAgentModelRefs({
    cfg: nextConfig,
    hits,
    agent: asMutableRecord(nextConfig.agents?.defaults),
    path: "agents.defaults",
    currentRuntime: resolveRuntime({ env: params.env, defaultsRuntime }),
    rewriteModelsMap: true,
    preserveUnsupportedCompactionOverrides: params.preserveSharedDefaultCompactionOverrides,
    preserveUnsupportedCompactionPaths: preservedLegacyLosslessCompactionPaths,
    rewrittenInheritedCompactionModels,
    runtimePolicyChanges,
    unsupportedCompactionChanges,
  });
  const inheritedModelRef = readAgentPrimaryModelRef(nextConfig.agents?.defaults);
  const agents = Array.isArray(nextConfig.agents?.list) ? nextConfig.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asMutableRecord(agent);
    if (!agentRecord) {
      continue;
    }
    const id =
      typeof agentRecord.id === "string" && agentRecord.id.trim()
        ? agentRecord.id.trim()
        : String(index);
    rewriteAgentModelRefs({
      cfg: nextConfig,
      hits,
      agent: agentRecord,
      path: `agents.list.${id}`,
      agentId: id,
      currentRuntime: resolveRuntime({
        env: params.env,
        agentRuntime: ignoreLegacyAgentRuntimePins
          ? undefined
          : asAgentRuntimePolicyConfig(agentRecord.agentRuntime),
        defaultsRuntime,
      }),
      inheritedModelRef,
      inheritedCompaction: nextConfig.agents?.defaults?.compaction,
      inheritedCompactionPath: "agents.defaults.compaction",
      preserveUnsupportedCompactionPaths: preservedLegacyLosslessCompactionPaths,
      rewrittenInheritedCompactionModels,
      runtimePolicyChanges,
      unsupportedCompactionChanges,
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
  const shouldClearRuntimePins = hits.some((hit) => !isCompactionOnlyRouteHit(hit));
  const runtimePinChanges = shouldClearRuntimePins
    ? clearConfigLegacyAgentRuntimePolicies(nextConfig)
    : [];
  return {
    cfg:
      hits.length > 0 ||
      runtimePolicyChanges.length > 0 ||
      runtimePinChanges.length > 0 ||
      unsupportedCompactionChanges.length > 0
        ? nextConfig
        : params.cfg,
    changes: hits,
    runtimePinChanges,
    runtimePolicyChanges,
    unsupportedCompactionChanges,
  };
}

function configRepairWouldClearLegacyRuntimePins(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const dryRun = rewriteConfigModelRefsWithCompactionPolicy({
    cfg: params.cfg,
    env: params.env,
    preserveSharedDefaultCompactionOverrides: { model: true, provider: true },
    ignoreLegacyAgentRuntimePins: false,
  });
  return dryRun.changes.some((hit) => !isCompactionOnlyRouteHit(hit));
}

function rewriteConfigModelRefs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): ConfigRouteRepairResult {
  const preserveSharedDefaultCompactionOverrides = getSharedDefaultCompactionOverrideConsumers({
    cfg: params.cfg,
    env: params.env,
    ignoreLegacyAgentRuntimePins: configRepairWouldClearLegacyRuntimePins(params),
  });
  return rewriteConfigModelRefsWithCompactionPolicy({
    cfg: params.cfg,
    env: params.env,
    preserveSharedDefaultCompactionOverrides,
  });
}

function formatCodexRouteChange(hit: CodexRouteHit): string {
  return `${hit.path}: ${hit.model} -> ${hit.canonicalModel}.`;
}

function formatUnsupportedCompactionWarning(params: {
  hits: UnsupportedCodexCompactionOverride[];
  fixHint: string;
}): string {
  return [
    "- Codex runtime uses native server-side compaction and ignores OpenClaw compaction summarizer overrides.",
    ...params.hits.map(
      (hit) => `- ${hit.path}: ${hit.value} is ignored while this agent uses Codex runtime.`,
    ),
    params.fixHint,
  ].join("\n");
}

function formatLegacyLosslessCompactionWarning(params: {
  hits: LegacyLosslessCompactionConfig[];
  canAutoFix: boolean;
}): string {
  const configLines: string[] = [];
  const providerPaths = new Set<string>();
  for (const hit of params.hits) {
    if (!providerPaths.has(hit.providerPath)) {
      providerPaths.add(hit.providerPath);
      configLines.push(
        `- ${hit.providerPath}: ${hit.providerValue} should become plugins.slots.contextEngine: ${LOSSLESS_CONTEXT_ENGINE_ID}.`,
      );
    }
    if (hit.modelPath && hit.modelValue) {
      configLines.push(
        `- ${hit.modelPath}: ${hit.modelValue} should become plugins.entries.${LOSSLESS_CONTEXT_ENGINE_ID}.config.summaryModel.`,
      );
    }
  }
  return [
    "- Legacy Lossless compaction config should use the Lossless context-engine slot for Codex.",
    ...configLines,
    params.canAutoFix
      ? "- Run `openclaw doctor --fix`: it migrates legacy Lossless compaction config to the Lossless context-engine slot."
      : "- Move the Lossless config manually; doctor will not overwrite an existing non-Lossless context-engine slot or collapse conflicting per-agent summary models.",
  ].join("\n");
}

function formatDisabledCodexPluginWarning(params: {
  hits: DisabledCodexPluginRouteHit[];
  blockedOutsideEntry: boolean;
}): string {
  const fixHint = params.blockedOutsideEntry
    ? "- Enable plugin loading and remove `codex` from plugins.deny, or set the affected OpenAI models to a PI runtime policy."
    : "- Run `openclaw doctor --fix`: it enables plugins.entries.codex, or set the affected OpenAI models to a PI runtime policy.";
  return [
    "- Codex runtime is selected, but the Codex plugin is disabled.",
    ...params.hits.map(
      (hit) =>
        `- ${hit.path}: ${hit.modelRef} resolves to ${hit.canonicalModel} with Codex runtime while the Codex plugin is disabled by config.`,
    ),
    fixHint,
  ].join("\n");
}

export function collectCodexRouteWarnings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const hits = collectConfigModelRefs(params.cfg, params.env);
  const disabledCodexPluginHits = collectDisabledCodexPluginRouteHits(params.cfg);
  const ignoreLegacyAgentRuntimePins = configRepairWouldClearLegacyRuntimePins(params);
  const legacyLosslessCompactionConfigs = collectLegacyLosslessCompactionConfigs({
    ...params,
    ignoreLegacyAgentRuntimePins,
  });
  const legacyLosslessCompactionPaths = new Set(
    legacyLosslessCompactionConfigs.flatMap((hit) =>
      hit.modelPath ? [hit.providerPath, hit.modelPath] : [hit.providerPath],
    ),
  );
  const unsupportedCompactionOverrides = collectUnsupportedCodexCompactionOverrides({
    ...params,
    ignoreLegacyAgentRuntimePins,
  }).filter((hit) => !legacyLosslessCompactionPaths.has(hit.path));
  const sharedDefaultCompactionConsumers = getSharedDefaultCompactionOverrideConsumers({
    cfg: params.cfg,
    env: params.env,
    ignoreLegacyAgentRuntimePins: configRepairWouldClearLegacyRuntimePins(params),
  });
  const sharedLosslessDefaultHasNonCodexConsumer =
    sharedDefaultLosslessCompactionHasNonCodexConsumer({
      ...params,
      ignoreLegacyAgentRuntimePins,
    });
  const warnings: string[] = [];
  if (hits.length > 0) {
    warnings.push(
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
    );
  }
  if (legacyLosslessCompactionConfigs.length > 0) {
    const plugins = asMutableRecord(params.cfg.plugins);
    const contextEngine = normalizeString(asMutableRecord(plugins?.slots)?.contextEngine);
    warnings.push(
      formatLegacyLosslessCompactionWarning({
        hits: legacyLosslessCompactionConfigs,
        canAutoFix:
          !sharedLosslessDefaultHasNonCodexConsumer &&
          canAutoMigrateLegacyLosslessCompaction({
            hits: legacyLosslessCompactionConfigs,
            contextEngine,
            summaryModel: readLosslessSummaryModel(plugins),
          }),
      }),
    );
  }
  if (disabledCodexPluginHits.length > 0) {
    warnings.push(
      formatDisabledCodexPluginWarning({
        hits: disabledCodexPluginHits,
        blockedOutsideEntry: codexPluginIsBlockedOutsideEntry(params.cfg),
      }),
    );
  }
  const preservedSharedDefaultHits = unsupportedCompactionOverrides.filter(
    (hit) =>
      hit.path.startsWith("agents.defaults.compaction.") &&
      sharedDefaultCompactionConsumers[hit.key],
  );
  const fixableHits = unsupportedCompactionOverrides.filter(
    (hit) =>
      !hit.path.startsWith("agents.defaults.compaction.") ||
      !sharedDefaultCompactionConsumers[hit.key],
  );
  if (preservedSharedDefaultHits.length > 0) {
    warnings.push(
      formatUnsupportedCompactionWarning({
        hits: preservedSharedDefaultHits,
        fixHint:
          "- Move or remove shared `agents.defaults.compaction.model/provider` settings manually; doctor keeps shared defaults while non-Codex agents can inherit them.",
      }),
    );
  }
  if (fixableHits.length > 0) {
    warnings.push(
      formatUnsupportedCompactionWarning({
        hits: fixableHits,
        fixHint:
          "- Run `openclaw doctor --fix`: it removes unsupported Codex compaction overrides.",
      }),
    );
  }
  return warnings;
}

export function maybeRepairCodexRoutes(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  shouldRepair: boolean;
  codexRuntimeReady?: boolean;
}): { cfg: OpenClawConfig; warnings: string[]; changes: string[] } {
  const hits = collectConfigModelRefs(params.cfg, params.env);
  const disabledCodexPluginHits = collectDisabledCodexPluginRouteHits(params.cfg);
  const ignoreLegacyAgentRuntimePins = configRepairWouldClearLegacyRuntimePins(params);
  const unsupportedCompactionOverrides = collectUnsupportedCodexCompactionOverrides({
    cfg: params.cfg,
    env: params.env,
    ignoreLegacyAgentRuntimePins,
  });
  const legacyLosslessCompactionConfigs = collectLegacyLosslessCompactionConfigs({
    cfg: params.cfg,
    env: params.env,
    ignoreLegacyAgentRuntimePins,
  });
  if (
    hits.length === 0 &&
    disabledCodexPluginHits.length === 0 &&
    unsupportedCompactionOverrides.length === 0 &&
    legacyLosslessCompactionConfigs.length === 0
  ) {
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
  const codexPluginRepair = enableCodexPluginForRequiredRoutes({
    cfg: repaired.cfg,
    routeHits: collectDisabledCodexPluginRouteHits(repaired.cfg),
  });
  const warnings = collectCodexRouteWarnings({ cfg: codexPluginRepair.cfg, env: params.env });
  const changes =
    repaired.changes.length > 0
      ? [
          `Repaired Codex model routes:\n${repaired.changes
            .map((hit) => `- ${formatCodexRouteChange(hit)}`)
            .join("\n")}`,
        ]
      : [];
  return {
    cfg: codexPluginRepair.cfg,
    warnings,
    changes: [
      ...changes,
      ...repaired.runtimePolicyChanges,
      ...repaired.runtimePinChanges,
      ...repaired.unsupportedCompactionChanges,
      ...codexPluginRepair.changes,
    ],
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
