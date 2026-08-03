import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  canAutoMigrateLegacyLosslessCompaction,
  collectLegacyLosslessCompactionConfigs,
  COMPACTION_OVERRIDE_KEYS,
  legacyLosslessSummaryModels,
  LOSSLESS_CONTEXT_ENGINE_ID,
  readLosslessSummaryModel,
  sharedDefaultLosslessCompactionHasNonCodexConsumer,
} from "./codex-route-compaction-scan.js";
import {
  agentUsesCodexRuntimeForCompaction,
  isOpenAICodexModelRef,
  toCanonicalOpenAIModelRef,
  type LegacyCodexModelIdentity,
} from "./codex-route-model-ref.js";
import { rewriteStringModelSlot } from "./codex-route-model-slots.js";
import {
  agentIdFromAgentPath,
  ensureCodexRuntimePolicy,
  rewriteStringModelSlotIfCanonicalCodexRuntime,
} from "./codex-route-runtime-policy.js";
import type {
  CodexRouteHit,
  CompactionOverrideKey,
  LegacyLosslessCompactionConfig,
  MutableRecord,
  SharedDefaultCompactionOverrideConsumers,
} from "./codex-route-types.js";

export function rewriteAgentCompactionRefs(params: {
  cfg: OpenClawConfig;
  preRepairCfg: OpenClawConfig;
  hits: CodexRouteHit[];
  agent: MutableRecord;
  path: string;
  agentId?: string;
  currentRuntime?: string;
  inheritedModelRef?: string;
  inheritedCompaction?: unknown;
  inheritedCompactionPath?: string;
  preserveUnsupportedCompactionOverrides?: SharedDefaultCompactionOverrideConsumers;
  preserveUnsupportedCompactionPaths?: ReadonlySet<string>;
  rewrittenInheritedCompactionModels?: Map<string, string>;
  runtimePolicyChanges: string[];
  unsupportedCompactionChanges: string[];
  blockedModelIdentities?: ReadonlySet<LegacyCodexModelIdentity>;
  env?: NodeJS.ProcessEnv;
}): void {
  const compaction = asMutableRecord(params.agent.compaction);
  const inheritedCompaction = asMutableRecord(params.inheritedCompaction);
  const usesCodexCompaction = agentUsesCodexRuntimeForCompaction({
    cfg: params.cfg,
    agent: params.agent,
    agentId: params.agentId,
    currentRuntime: params.currentRuntime,
    inheritedModelRef: params.inheritedModelRef,
    env: params.env,
  });
  if (!usesCodexCompaction) {
    rewriteStringModelSlotIfCanonicalCodexRuntime({
      cfg: params.cfg,
      agentId: params.agentId,
      hits: params.hits,
      container: compaction,
      key: "model",
      path: `${params.path}.compaction.model`,
      blockedModelIdentities: params.blockedModelIdentities,
      env: params.env,
    });
    rewriteCompactionMemoryFlushModel(params, compaction);
    return;
  }

  const effectiveProvider = compaction?.provider ?? inheritedCompaction?.provider;
  if (normalizeString(effectiveProvider) === LOSSLESS_CONTEXT_ENGINE_ID) {
    rewriteLosslessCompactionModel(params, compaction, inheritedCompaction);
  } else {
    removeUnsupportedCodexCompactionOverrides({
      agent: params.agent,
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
        blockedModelIdentities: params.blockedModelIdentities,
      });
    }
  }
  rewriteCompactionMemoryFlushModel(params, compaction);
}

function rewriteLosslessCompactionModel(
  params: Parameters<typeof rewriteAgentCompactionRefs>[0],
  compaction: MutableRecord | undefined,
  inheritedCompaction: MutableRecord | undefined,
): void {
  const start = params.hits.length;
  rewriteStringModelSlot({
    hits: params.hits,
    container: compaction,
    key: "model",
    path: `${params.path}.compaction.model`,
    blockedModelIdentities: params.blockedModelIdentities,
  });
  preserveCodexRuntimePolicyForHits(params, start);

  const localModel = typeof compaction?.model === "string" ? compaction.model.trim() : "";
  const inheritedModelPath = params.inheritedCompactionPath
    ? `${params.inheritedCompactionPath}.model`
    : undefined;
  if (
    localModel ||
    !inheritedModelPath ||
    !params.preserveUnsupportedCompactionPaths?.has(inheritedModelPath)
  ) {
    return;
  }
  const inheritedStart = params.hits.length;
  rewriteStringModelSlot({
    hits: params.hits,
    container: inheritedCompaction,
    key: "model",
    path: inheritedModelPath,
    blockedModelIdentities: params.blockedModelIdentities,
  });
  const inheritedHit = params.hits[inheritedStart];
  const inheritedCanonicalModel =
    inheritedHit?.canonicalModel ??
    params.rewrittenInheritedCompactionModels?.get(inheritedModelPath);
  if (inheritedHit) {
    params.rewrittenInheritedCompactionModels?.set(inheritedModelPath, inheritedHit.canonicalModel);
    preserveCodexRuntimePolicyForHits(params, inheritedStart);
  } else if (inheritedCanonicalModel) {
    ensureCodexRuntimePolicy({
      cfg: params.cfg,
      agent: params.agent,
      agentPath: params.path,
      agentId: params.agentId,
      modelRef: inheritedCanonicalModel,
      isDefaults: params.path === "agents.defaults",
      preRepairCfg: params.preRepairCfg,
      changes: params.runtimePolicyChanges,
      env: params.env,
    });
  }
}

function preserveCodexRuntimePolicyForHits(
  params: Parameters<typeof rewriteAgentCompactionRefs>[0],
  fromIndex: number,
): void {
  for (const hit of params.hits.slice(fromIndex)) {
    ensureCodexRuntimePolicy({
      cfg: params.cfg,
      agent: params.agent,
      agentPath: params.path,
      agentId: params.agentId,
      modelRef: hit.canonicalModel,
      legacyModelRef: hit.model,
      isDefaults: params.path === "agents.defaults",
      preRepairCfg: params.preRepairCfg,
      changes: params.runtimePolicyChanges,
      env: params.env,
    });
  }
}

function rewriteCompactionMemoryFlushModel(
  params: Parameters<typeof rewriteAgentCompactionRefs>[0],
  compaction: MutableRecord | undefined,
): void {
  rewriteStringModelSlotIfCanonicalCodexRuntime({
    cfg: params.cfg,
    agentId: params.agentId,
    hits: params.hits,
    container: asMutableRecord(compaction?.memoryFlush),
    key: "model",
    path: `${params.path}.compaction.memoryFlush.model`,
    blockedModelIdentities: params.blockedModelIdentities,
    env: params.env,
  });
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
    if (params.preservePaths?.has(path) || params.preserve?.[key]) {
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

export function maybeMigrateLegacyLosslessCompactionConfig(params: {
  cfg: OpenClawConfig;
  ignoreLegacyAgentRuntimePins?: boolean;
  env?: NodeJS.ProcessEnv;
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
  const entries = ensureMutablePath(plugins, ["entries"]);
  const entry = asMutableRecord(entries[LOSSLESS_CONTEXT_ENGINE_ID]) ?? {};
  if (entries[LOSSLESS_CONTEXT_ENGINE_ID] !== entry) {
    entries[LOSSLESS_CONTEXT_ENGINE_ID] = entry;
  }
  const config = ensureMutablePath(entry, ["config"]);
  const changes: string[] = [];
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
    env: params.env,
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

function preserveMigratedLosslessCodexRuntimePolicy(params: {
  cfg: OpenClawConfig;
  hits: readonly LegacyLosslessCompactionConfig[];
  summaryModel: string | undefined;
  changes: string[];
  env?: NodeJS.ProcessEnv;
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
      agentId: agentIdFromAgentPath(ownerPath),
      modelRef: params.summaryModel,
      isDefaults: ownerPath === "agents.defaults",
      changes: params.changes,
      env: params.env,
    });
  }
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

function removeMigratedLosslessCompactionKey(params: {
  cfg: OpenClawConfig;
  path: string;
  key: CompactionOverrideKey;
  changes: string[];
  changeMessage: string;
}): void {
  const owner = readCompactionOwnerForPath(
    params.cfg,
    readCompactionOwnerPathForKeyPath(params.path),
  );
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
  return (
    asMutableRecord(agents.find((agent) => agent.id === label)) ??
    asMutableRecord(Number.isInteger(Number(label)) ? agents[Number(label)] : undefined)
  );
}

function readMutablePath(root: MutableRecord, pathLabel: string): MutableRecord | undefined {
  let cursor: unknown = root;
  for (const part of pathLabel.split(".")) {
    const record = asMutableRecord(cursor);
    if (!record) {
      return undefined;
    }
    cursor = record[part];
  }
  return asMutableRecord(cursor);
}

function readCompactionOwnerPathForKeyPath(path: string): string {
  return path.replace(/\.(model|provider)$/, "").replace(/\.compaction$/, "");
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
