import fs from "node:fs";
import {
  ensureAuthProfileStore,
  resolveAuthProfileOrder,
  resolveProfileUnusableUntilForDisplay,
} from "../../../agents/auth-profiles.js";
import { evaluateStoredCredentialEligibility } from "../../../agents/auth-profiles/credential-state.js";
import { AGENT_MODEL_CONFIG_KEYS } from "../../../config/model-refs.js";
import { loadSessionStore, updateSessionStore } from "../../../config/sessions/store.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../../../config/sessions/targets.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { AgentRuntimePolicyConfig } from "../../../config/types.agents-shared.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  getInstalledPluginRecord,
  isInstalledPluginEnabled,
  loadInstalledPluginIndex,
} from "../../../plugins/installed-plugin-index.js";

type CodexRouteHit = {
  path: string;
  model: string;
  canonicalModel: string;
  runtime?: string;
  setsRuntime?: boolean;
};

type CodexRepairRuntime = "codex" | "pi";
type MutableRecord = Record<string, unknown>;
type SessionRouteRepairResult = {
  changed: boolean;
  sessionKeys: string[];
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
}): string {
  return (
    normalizeString(params.env?.OPENCLAW_AGENT_RUNTIME) ??
    normalizeString(params.agentRuntime?.id) ??
    normalizeString(params.defaultsRuntime?.id) ??
    "pi"
  );
}

function recordCodexModelHit(params: {
  hits: CodexRouteHit[];
  path: string;
  model: string;
  runtime?: string;
  setsRuntime?: boolean;
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
    ...(params.setsRuntime ? { setsRuntime: true } : {}),
  });
  return canonicalModel;
}

function collectStringModelSlot(params: {
  hits: CodexRouteHit[];
  path: string;
  value: unknown;
  runtime?: string;
  setsRuntime?: boolean;
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
    setsRuntime: params.setsRuntime,
  });
}

function collectModelConfigSlot(params: {
  hits: CodexRouteHit[];
  path: string;
  value: unknown;
  runtime?: string;
  setsRuntimeOnPrimary?: boolean;
}): boolean {
  if (typeof params.value === "string") {
    return collectStringModelSlot({
      hits: params.hits,
      path: params.path,
      value: params.value,
      runtime: params.runtime,
      setsRuntime: params.setsRuntimeOnPrimary,
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
      setsRuntime: params.setsRuntimeOnPrimary,
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
      setsRuntimeOnPrimary: key === "model",
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
  setsRuntime?: boolean;
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
    setsRuntime: params.setsRuntime,
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
  setsRuntimeOnPrimary?: boolean;
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
      setsRuntime: params.setsRuntimeOnPrimary,
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
    setsRuntime: params.setsRuntimeOnPrimary,
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
    params.models[canonicalModel] ??= params.models[legacyRef] ?? {};
    delete params.models[legacyRef];
  }
}

function rewriteAgentModelRefs(params: {
  hits: CodexRouteHit[];
  agent: MutableRecord | undefined;
  path: string;
  runtime: CodexRepairRuntime;
  currentRuntime: string;
  rewriteModelsMap?: boolean;
}): void {
  if (!params.agent) {
    return;
  }
  for (const key of AGENT_MODEL_CONFIG_KEYS) {
    const rewrotePrimary = rewriteModelConfigSlot({
      hits: params.hits,
      container: params.agent,
      key,
      path: `${params.path}.${key}`,
      runtime: key === "model" ? params.currentRuntime : undefined,
      setsRuntimeOnPrimary: key === "model",
    });
    if (key === "model" && rewrotePrimary) {
      const agentRuntime = asMutableRecord(params.agent.agentRuntime) ?? {};
      agentRuntime.id = params.runtime;
      params.agent.agentRuntime = agentRuntime;
    }
  }
  rewriteStringModelSlot({
    hits: params.hits,
    container: asMutableRecord(params.agent.heartbeat),
    key: "model",
    path: `${params.path}.heartbeat.model`,
  });
  rewriteModelConfigSlot({
    hits: params.hits,
    container: asMutableRecord(params.agent.subagents),
    key: "model",
    path: `${params.path}.subagents.model`,
  });
  const compaction = asMutableRecord(params.agent.compaction);
  rewriteStringModelSlot({
    hits: params.hits,
    container: compaction,
    key: "model",
    path: `${params.path}.compaction.model`,
  });
  rewriteStringModelSlot({
    hits: params.hits,
    container: asMutableRecord(compaction?.memoryFlush),
    key: "model",
    path: `${params.path}.compaction.memoryFlush.model`,
  });
  if (params.rewriteModelsMap) {
    rewriteModelsMap({
      hits: params.hits,
      models: asMutableRecord(params.agent.models),
      path: `${params.path}.models`,
    });
  }
}

function rewriteConfigModelRefs(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  runtime: CodexRepairRuntime;
}): { cfg: OpenClawConfig; changes: CodexRouteHit[] } {
  const nextConfig = structuredClone(params.cfg);
  const hits: CodexRouteHit[] = [];
  const defaultsRuntime = nextConfig.agents?.defaults?.agentRuntime;
  rewriteAgentModelRefs({
    hits,
    agent: asMutableRecord(nextConfig.agents?.defaults),
    path: "agents.defaults",
    runtime: params.runtime,
    currentRuntime: resolveRuntime({ env: params.env, defaultsRuntime }),
    rewriteModelsMap: true,
  });
  for (const [index, agent] of (nextConfig.agents?.list ?? []).entries()) {
    const id = typeof agent.id === "string" && agent.id.trim() ? agent.id.trim() : String(index);
    rewriteAgentModelRefs({
      hits,
      agent: agent as MutableRecord,
      path: `agents.list.${id}`,
      runtime: params.runtime,
      currentRuntime: resolveRuntime({
        env: params.env,
        agentRuntime: agent.agentRuntime,
        defaultsRuntime,
      }),
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
        rewriteStringModelSlot({
          hits,
          container: targets,
          key: targetId,
          path: `channels.modelByChannel.${channelId}.${targetId}`,
        });
      }
    }
  }
  for (const [index, mapping] of (nextConfig.hooks?.mappings ?? []).entries()) {
    rewriteStringModelSlot({
      hits,
      container: mapping as MutableRecord,
      key: "model",
      path: `hooks.mappings.${index}.model`,
    });
  }
  rewriteStringModelSlot({
    hits,
    container: asMutableRecord(nextConfig.hooks?.gmail),
    key: "model",
    path: "hooks.gmail.model",
  });
  rewriteModelConfigSlot({
    hits,
    container: asMutableRecord(nextConfig.tools?.subagents),
    key: "model",
    path: "tools.subagents.model",
  });
  rewriteStringModelSlot({
    hits,
    container: asMutableRecord(nextConfig.messages?.tts),
    key: "summaryModel",
    path: "messages.tts.summaryModel",
  });
  rewriteStringModelSlot({
    hits,
    container: asMutableRecord(asMutableRecord(nextConfig.channels?.discord)?.voice),
    key: "model",
    path: "channels.discord.voice.model",
  });
  return {
    cfg: hits.length > 0 ? nextConfig : params.cfg,
    changes: hits,
  };
}

function hasUsableCodexOAuthProfile(cfg: OpenClawConfig): boolean {
  try {
    const store = ensureAuthProfileStore(undefined, { allowKeychainPrompt: false, config: cfg });
    const now = Date.now();
    return resolveAuthProfileOrder({ cfg, store, provider: "openai-codex" }).some((profileId) => {
      const credential = store.profiles[profileId];
      if (!credential || credential.type !== "oauth") {
        return false;
      }
      const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profileId);
      if (unusableUntil && now < unusableUntil) {
        return false;
      }
      return evaluateStoredCredentialEligibility({ credential, now }).eligible;
    });
  } catch {
    return false;
  }
}

function isCodexPluginInstalledAndEnabled(cfg: OpenClawConfig, env?: NodeJS.ProcessEnv): boolean {
  const index = loadInstalledPluginIndex({ config: cfg, env });
  const record = getInstalledPluginRecord(index, "codex");
  if (!record || !record.startup.agentHarnesses.includes("codex")) {
    return false;
  }
  return isInstalledPluginEnabled(index, "codex", cfg);
}

function resolveCodexRepairRuntime(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  codexRuntimeReady?: boolean;
}): CodexRepairRuntime {
  if (params.codexRuntimeReady !== undefined) {
    return params.codexRuntimeReady ? "codex" : "pi";
  }
  return isCodexPluginInstalledAndEnabled(params.cfg, params.env) &&
    hasUsableCodexOAuthProfile(params.cfg)
    ? "codex"
    : "pi";
}

function formatCodexRouteChange(hit: CodexRouteHit, runtime: CodexRepairRuntime): string {
  const suffix = hit.setsRuntime ? `; set agentRuntime.id to "${runtime}"` : "";
  return `${hit.path}: ${hit.model} -> ${hit.canonicalModel}${suffix}.`;
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
      '- Run `openclaw doctor --fix`: it rewrites configured model refs and stale sessions; primary routes select `agentRuntime.id: "codex"` only when Codex is installed, enabled, and has usable OAuth, otherwise they select OpenClaw PI.',
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
  const runtime = resolveCodexRepairRuntime({
    cfg: params.cfg,
    env: params.env,
    codexRuntimeReady: params.codexRuntimeReady,
  });
  const repaired = rewriteConfigModelRefs({
    cfg: params.cfg,
    env: params.env,
    runtime,
  });
  return {
    cfg: repaired.cfg,
    warnings: [],
    changes: [
      `Repaired Codex model routes:\n${repaired.changes
        .map((hit) => `- ${formatCodexRouteChange(hit, runtime)}`)
        .join("\n")}`,
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

function clearStaleCodexAuthOverride(entry: SessionEntry, runtime: CodexRepairRuntime): boolean {
  if (runtime === "codex" || !entry.authProfileOverride?.startsWith("openai-codex:")) {
    return false;
  }
  delete entry.authProfileOverride;
  delete entry.authProfileOverrideSource;
  delete entry.authProfileOverrideCompactionCount;
  return true;
}

export function repairCodexSessionStoreRoutes(params: {
  store: Record<string, SessionEntry>;
  runtime: CodexRepairRuntime;
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
    const changedAuthOverride = clearStaleCodexAuthOverride(entry, params.runtime);
    const shouldRepinCodexHarness = entry.agentHarnessId === "codex" && params.runtime !== "codex";
    if (
      !changedModelRoute &&
      !changedFallbackNotice &&
      !changedAuthOverride &&
      !shouldRepinCodexHarness
    ) {
      continue;
    }
    if (changedModelRoute || shouldRepinCodexHarness) {
      entry.agentHarnessId = params.runtime;
      entry.agentRuntimeOverride = params.runtime;
    }
    entry.updatedAt = now;
    sessionKeys.push(sessionKey);
  }
  return {
    changed: sessionKeys.length > 0,
    sessionKeys,
  };
}

function scanCodexSessionStoreRoutes(
  store: Record<string, SessionEntry>,
  runtime: CodexRepairRuntime,
): string[] {
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
      isOpenAICodexModelRef(entry.fallbackNoticeActiveModel) ||
      (runtime !== "codex" && entry.authProfileOverride?.startsWith("openai-codex:") === true) ||
      (runtime !== "codex" && entry.agentHarnessId === "codex");
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
    const runtime = resolveCodexRepairRuntime({
      cfg: params.cfg,
      env: params.env,
      codexRuntimeReady: params.codexRuntimeReady,
    });
    const stale = targets.flatMap((target) => {
      const sessionKeys = scanCodexSessionStoreRoutes(loadSessionStore(target.storePath), runtime);
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
  const runtime = resolveCodexRepairRuntime({
    cfg: params.cfg,
    env: params.env,
    codexRuntimeReady: params.codexRuntimeReady,
  });
  let repairedStores = 0;
  let repairedSessions = 0;
  for (const target of targets) {
    const staleSessionKeys = scanCodexSessionStoreRoutes(
      loadSessionStore(target.storePath),
      runtime,
    );
    if (staleSessionKeys.length === 0) {
      continue;
    }
    const result = await updateSessionStore(
      target.storePath,
      (store) => repairCodexSessionStoreRoutes({ store, runtime }),
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
            } across ${repairedStores} store${repairedStores === 1 ? "" : "s"} to openai/* with agentRuntime "${runtime}".`,
          ]
        : [],
  };
}
