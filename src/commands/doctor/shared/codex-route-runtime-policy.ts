import { AGENT_MODEL_CONFIG_KEYS } from "@openclaw/model-catalog-core/configured-model-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import { resolveModelRuntimePolicy } from "../../../agents/model-runtime-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import {
  canonicalOpenAIModelUsesCodexRuntime,
  isOpenAICodexModelRef,
  normalizeRuntimeString,
  parseModelRef,
  toCanonicalOpenAIModelRef,
} from "./codex-route-model-ref.js";
import { modelConfigContainsRef, rewriteStringModelSlot } from "./codex-route-model-slots.js";
import type { CodexRouteHit, MutableRecord } from "./codex-route-types.js";

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

function resolveCurrentRuntimeIdForCanonicalModel(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  agentId: string;
  env?: NodeJS.ProcessEnv;
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
  return canonicalOpenAIModelUsesCodexRuntime({
    cfg: params.cfg,
    modelRef: params.modelRef,
    agentId: params.agentId,
    env: params.env,
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
  targetRuntimeId: string;
  changes: string[];
  env?: NodeJS.ProcessEnv;
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
      env: params.env,
    });
    if (runtimeId === params.targetRuntimeId) {
      continue;
    }
    setModelRuntimePolicy({
      agent: agent as MutableRecord,
      agentPath: `agents.list.${id}`,
      modelRef: params.modelRef,
      runtimeId,
      changes: params.changes,
      reason: "so default runtime repair does not change explicit agent routing",
    });
  }
}

function legacyEntryExplicitNonDefaultRuntimeId(
  models: MutableRecord,
  canonicalModelRef: string,
): string | undefined {
  for (const ref of Object.keys(models)) {
    if (ref === canonicalModelRef || toCanonicalOpenAIModelRef(ref) !== canonicalModelRef) {
      continue;
    }
    const legacyEntry = asMutableRecord(models[ref]);
    const id = normalizeString(asMutableRecord(legacyEntry?.agentRuntime)?.id);
    if (id && id !== "auto" && id !== "default") {
      return id;
    }
  }
  return undefined;
}

export function agentIdFromAgentPath(agentPath: string): string | undefined {
  const prefix = "agents.list.";
  return agentPath.startsWith(prefix) ? agentPath.slice(prefix.length) : undefined;
}

type PreRepairRuntimePin = {
  runtimeId: string;
  // Resolver source "model" covers agent model maps and provider catalog entries;
  // only provider-owned policy needs an eager canonical policy write.
  source: "model" | "provider" | "provider-model";
};

function modelIdMatchesProviderModelEntry(params: {
  entryId: unknown;
  provider: string;
  modelId: string;
}): boolean {
  if (typeof params.entryId !== "string") {
    return false;
  }
  const entryId = params.entryId.trim();
  if (entryId === params.modelId) {
    return true;
  }
  const slash = entryId.indexOf("/");
  if (slash <= 0) {
    return false;
  }
  return (
    normalizeProviderId(entryId.slice(0, slash)) === normalizeProviderId(params.provider) &&
    entryId.slice(slash + 1).trim() === params.modelId
  );
}

function providerModelExplicitNonDefaultRuntimeId(params: {
  cfg: OpenClawConfig;
  provider: string;
  modelId: string;
}): string | undefined {
  const providers = asMutableRecord(asMutableRecord(params.cfg.models)?.providers);
  for (const [providerId, providerConfig] of Object.entries(providers ?? {})) {
    if (normalizeProviderId(providerId) !== normalizeProviderId(params.provider)) {
      continue;
    }
    const models = asMutableRecord(providerConfig)?.models;
    if (!Array.isArray(models)) {
      continue;
    }
    for (const model of models) {
      const record = asMutableRecord(model);
      if (
        !modelIdMatchesProviderModelEntry({
          entryId: record?.id,
          provider: params.provider,
          modelId: params.modelId,
        })
      ) {
        continue;
      }
      const runtimeId = normalizeRuntimeString(asMutableRecord(record?.agentRuntime)?.id);
      if (runtimeId && runtimeId !== "auto" && runtimeId !== "default" && runtimeId !== "codex") {
        return runtimeId;
      }
    }
  }
  return undefined;
}

function agentModelMapExactRuntimeIdForLegacyRef(params: {
  cfg: OpenClawConfig;
  legacyModelRef: string;
  agentId?: string;
}): string | undefined {
  const parsed = parseModelRef(params.legacyModelRef);
  if (!parsed) {
    return undefined;
  }
  const agentId = normalizeAgentId(params.agentId);
  const agent = agentId
    ? (params.cfg.agents?.list ?? []).find((entry) => normalizeAgentId(entry.id) === agentId)
    : undefined;
  const modelMaps = [
    asMutableRecord(agent?.models),
    asMutableRecord(params.cfg.agents?.defaults?.models),
  ];
  for (const models of modelMaps) {
    for (const [key, entry] of Object.entries(models ?? {})) {
      if (
        !modelIdMatchesProviderModelEntry({
          entryId: key,
          provider: parsed.provider,
          modelId: parsed.modelId,
        })
      ) {
        continue;
      }
      const runtimeId = normalizeRuntimeString(
        asMutableRecord(asMutableRecord(entry)?.agentRuntime)?.id,
      );
      if (runtimeId && runtimeId !== "auto" && runtimeId !== "default") {
        return runtimeId;
      }
    }
  }
  return undefined;
}

function preRepairLegacyModelPolicyExplicitNonDefaultRuntimePin(params: {
  cfg: OpenClawConfig;
  legacyModelRef?: string;
  agentId?: string;
}): PreRepairRuntimePin | undefined {
  if (!params.legacyModelRef || !isOpenAICodexModelRef(params.legacyModelRef)) {
    return undefined;
  }
  const parsed = parseModelRef(params.legacyModelRef);
  if (!parsed) {
    return undefined;
  }
  const resolved = resolveModelRuntimePolicy({
    config: params.cfg,
    provider: parsed.provider,
    modelId: parsed.modelId,
    agentId: params.agentId,
  });
  const runtimeId = normalizeRuntimeString(resolved.policy?.id);
  if (!runtimeId || runtimeId === "auto" || runtimeId === "default" || runtimeId === "codex") {
    return undefined;
  }
  if (resolved.source === "model") {
    const providerModelRuntimeId = providerModelExplicitNonDefaultRuntimeId({
      cfg: params.cfg,
      provider: parsed.provider,
      modelId: parsed.modelId,
    });
    const agentModelRuntimeId = agentModelMapExactRuntimeIdForLegacyRef({
      cfg: params.cfg,
      legacyModelRef: params.legacyModelRef,
      agentId: params.agentId,
    });
    if (providerModelRuntimeId === runtimeId && !agentModelRuntimeId) {
      return { runtimeId, source: "provider-model" };
    }
  }
  return { runtimeId, source: resolved.source ?? "model" };
}

export function ensureCodexRuntimePolicy(params: {
  cfg: OpenClawConfig;
  agent: MutableRecord;
  agentPath: string;
  agentId?: string;
  modelRef: string;
  legacyModelRef?: string;
  isDefaults?: boolean;
  preRepairCfg?: OpenClawConfig;
  changes: string[];
  env?: NodeJS.ProcessEnv;
}): void {
  const models = asMutableRecord(params.agent.models);
  const entry = asMutableRecord(models?.[params.modelRef]);
  const priorRuntime = asMutableRecord(entry?.agentRuntime);
  const runtimeId = normalizeString(priorRuntime?.id);
  const pinnedRuntimeId =
    runtimeId && runtimeId !== "auto" && runtimeId !== "default" ? runtimeId : undefined;
  const legacyModelRuntimeId = models
    ? legacyEntryExplicitNonDefaultRuntimeId(models, params.modelRef)
    : undefined;
  const preRepairRuntimePin = preRepairLegacyModelPolicyExplicitNonDefaultRuntimePin({
    cfg: params.preRepairCfg ?? params.cfg,
    legacyModelRef: params.legacyModelRef,
    agentId: params.agentId,
  });
  const targetRuntimeId =
    pinnedRuntimeId ??
    legacyModelRuntimeId ??
    (preRepairRuntimePin?.source === "provider" || preRepairRuntimePin?.source === "provider-model"
      ? preRepairRuntimePin.runtimeId
      : undefined) ??
    "codex";
  if (params.isDefaults) {
    shieldExplicitListedAgentRefsFromDefaultPolicy({
      cfg: params.cfg,
      modelRef: params.modelRef,
      targetRuntimeId,
      changes: params.changes,
      env: params.env,
    });
  }
  if (pinnedRuntimeId || legacyModelRuntimeId) {
    return;
  }
  if (preRepairRuntimePin) {
    if (
      preRepairRuntimePin.source === "provider" ||
      preRepairRuntimePin.source === "provider-model"
    ) {
      setModelRuntimePolicy({
        agent: params.agent,
        agentPath: params.agentPath,
        modelRef: params.modelRef,
        runtimeId: preRepairRuntimePin.runtimeId,
        changes: params.changes,
        reason: "so legacy provider runtime pins survive Codex route repair",
      });
    }
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

export function rewriteStringModelSlotIfCanonicalCodexRuntime(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
  env?: NodeJS.ProcessEnv;
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
      env: params.env,
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

export function rewriteModelConfigSlotIfCanonicalCodexRuntime(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  hits: CodexRouteHit[];
  container: MutableRecord | undefined;
  key: string;
  path: string;
  env?: NodeJS.ProcessEnv;
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
    ...params,
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
        env: params.env,
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

export function clearConfigLegacyAgentRuntimePolicies(cfg: OpenClawConfig): string[] {
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
