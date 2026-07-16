import { AGENT_MODEL_CONFIG_KEYS } from "@openclaw/model-catalog-core/configured-model-refs";
import { asOptionalRecord as asMutableRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString as normalizeString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import {
  asAgentRuntimePolicyConfig,
  isOpenAICodexModelRef,
  modelRefUsesCodexRuntime,
  readLegacyDefaultsRuntime,
  readModelConfigPrimaryRef,
  resolveImplicitDefaultAgentModelRef,
  resolveRuntime,
  resolveRuntimeModelRef,
} from "./codex-route-model-ref.js";
import {
  collectCodexRuntimeModelPolicyRefs,
  collectModelConfigRefs,
  collectModelConfigSlot,
  collectStringModelConfigRef,
  collectStringModelSlot,
  recordCodexModelHit,
} from "./codex-route-model-slots.js";
import type {
  CodexRouteHit,
  DisabledCodexPluginRouteHit,
  DisabledCodexPluginRouteIssue,
  MutableRecord,
} from "./codex-route-types.js";

const AGENT_MEDIA_MODEL_CONFIG_KEYS = ["imageGenerationModel", "videoGenerationModel"] as const;

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
  for (const key of AGENT_MEDIA_MODEL_CONFIG_KEYS) {
    collectModelConfigSlot({
      hits: params.hits,
      path: `${params.path}.${key}`,
      value: agent[key],
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

export function collectConfigModelRefs(cfg: OpenClawConfig): CodexRouteHit[] {
  const hits: CodexRouteHit[] = [];
  const defaults = cfg.agents?.defaults;
  const defaultsRuntime = readLegacyDefaultsRuntime(defaults);
  collectAgentModelRefs({
    hits,
    agent: defaults,
    path: "agents.defaults",
    runtime: resolveRuntime({ defaultsRuntime }),
    collectModelsMap: true,
  });

  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asMutableRecord(agent);
    if (!agentRecord) {
      continue;
    }
    const id = readAgentPathId(agentRecord, index);
    collectAgentModelRefs({
      hits,
      agent: agentRecord,
      path: `agents.list.${id}`,
      runtime: resolveRuntime({
        agentRuntime: asAgentRuntimePolicyConfig(agentRecord.agentRuntime),
        defaultsRuntime,
      }),
    });
  }

  const channelsModelByChannel = asMutableRecord(cfg.channels?.modelByChannel);
  for (const [channelId, channelMap] of Object.entries(channelsModelByChannel ?? {})) {
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

  for (const [index, mapping] of (cfg.hooks?.mappings ?? []).entries()) {
    collectStringModelSlot({
      hits,
      path: `hooks.mappings.${index}.model`,
      value: mapping.model,
    });
  }
  collectStringModelSlot({ hits, path: "hooks.gmail.model", value: cfg.hooks?.gmail?.model });
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

export function collectDisabledCodexPluginRouteHits(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): DisabledCodexPluginRouteHit[] {
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
  const channelRefs = collectChannelAgentRuntimeModelRefs(cfg);
  const candidateRefs: Array<{ path: string; modelRef: string; agentId?: string }> =
    agents.length === 0 ? [...defaultRefs, ...channelRefs] : [];
  for (const [index, agent] of agents.entries()) {
    const agentRecord = asMutableRecord(agent);
    if (!agentRecord) {
      continue;
    }
    const pathId = readAgentPathId(agentRecord, index);
    const agentId = normalizeAgentId(
      typeof agentRecord.id === "string" ? agentRecord.id : undefined,
    );
    for (const ref of channelRefs) {
      candidateRefs.push({ path: ref.path, modelRef: ref.modelRef, agentId });
    }
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
        env,
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

/** Find Codex-routed model refs that require the Codex plugin while it is disabled. */
export function collectDisabledCodexPluginRouteIssues(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): DisabledCodexPluginRouteIssue[] {
  const blockedOutsideEntry = codexPluginIsBlockedOutsideEntry(cfg);
  return collectDisabledCodexPluginRouteHits(cfg, env).map((hit) => ({
    path: hit.path,
    modelRef: hit.modelRef,
    canonicalModel: hit.canonicalModel,
    blockedOutsideEntry,
  }));
}

export function enableCodexPluginForRequiredRoutes(params: {
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
    entries.codex = { ...codexEntry, enabled: true };
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

export function codexPluginIsBlockedOutsideEntry(cfg: OpenClawConfig): boolean {
  return cfg.plugins?.enabled === false || pluginIdListIncludes(cfg.plugins?.deny, "codex");
}

function isCodexPluginUnavailableByConfig(cfg: OpenClawConfig): boolean {
  if (codexPluginIsBlockedOutsideEntry(cfg)) {
    return true;
  }
  if (asMutableRecord(asMutableRecord(cfg.plugins?.entries)?.codex)?.enabled === false) {
    return true;
  }
  const allow = cfg.plugins?.allow;
  return Array.isArray(allow) && allow.length > 0 && !pluginIdListIncludes(allow, "codex");
}

function pluginIdListIncludes(value: unknown, pluginId: string): boolean {
  return Array.isArray(value) && value.some((entry) => normalizeString(entry) === pluginId);
}

function collectAgentRuntimeModelRefs(params: {
  agent: unknown;
  path: string;
  fallbackModelRefs?: ReadonlyArray<{ path: string; modelRef: string }>;
  inheritedModelRefs?: ReadonlyArray<{ path: string; modelRef: string }>;
}): Array<{ path: string; modelRef: string }> {
  const refs: Array<{ path: string; modelRef: string }> = [];
  const agent = asMutableRecord(params.agent);
  if (agent && Object.hasOwn(agent, "model")) {
    collectModelConfigRefs({ refs, path: `${params.path}.model`, value: agent.model });
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

function readAgentPathId(agent: MutableRecord, index: number): string {
  return typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
}
