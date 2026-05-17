import fs from "node:fs";
import path from "node:path";
import { resolveAgentModelFallbackValues } from "../config/model-input.js";
import { hasSessionAutoModelFallbackProvenance } from "../config/sessions/model-override-provenance.js";
export { hasSessionAutoModelFallbackProvenance } from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.js";
import { isPathInside } from "../infra/path-guards.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import {
  lowercasePreservingWhitespace,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "./agent-scope-config.js";
import { resolveEffectiveAgentSkillFilter } from "./skills/agent-filter.js";
export {
  listAgentEntries,
  listAgentIds,
  resolveAgentConfig,
  resolveAgentContextLimits,
  resolveAgentDir,
  resolveDefaultAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  type ResolvedAgentConfig,
} from "./agent-scope-config.js";

/** Strip null bytes from paths to prevent ENOTDIR errors. */
function stripNullBytes(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\0/g, "");
}

const AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_FALLBACK_PRIMARY_PROBE_MAX_KEYS = 4096;
const autoFallbackPrimaryProbeState = new Map<string, number>();

function autoFallbackPrimaryProbeStateKey(params: {
  sessionKey?: string | null;
  primaryProvider: string;
  primaryModel: string;
}): string {
  return [
    normalizeOptionalString(params.sessionKey) ?? "",
    `${params.primaryProvider}/${params.primaryModel}`,
  ].join("\0");
}

function pruneAutoFallbackPrimaryProbeState(params: {
  state: Map<string, number>;
  now: number;
  minIntervalMs: number;
  maxKeys?: number;
}): void {
  const maxKeys = Math.max(1, Math.trunc(params.maxKeys ?? AUTO_FALLBACK_PRIMARY_PROBE_MAX_KEYS));
  const staleBefore = params.now - params.minIntervalMs;
  for (const [key, lastProbeAt] of params.state) {
    if (!Number.isFinite(lastProbeAt) || lastProbeAt < staleBefore) {
      params.state.delete(key);
    }
  }
  if (params.state.size <= maxKeys) {
    return;
  }
  const removeCount = params.state.size - maxKeys;
  let removed = 0;
  for (const key of params.state.keys()) {
    params.state.delete(key);
    removed += 1;
    if (removed >= removeCount) {
      break;
    }
  }
}

export type AutoFallbackPrimaryProbe = {
  provider: string;
  model: string;
  fallbackProvider: string;
  fallbackModel: string;
  fallbackAuthProfileId?: string;
  fallbackAuthProfileIdSource?: "auto" | "user";
};

export function resolveAutoFallbackPrimaryProbe(params: {
  entry:
    | Pick<
        SessionEntry,
        | "providerOverride"
        | "modelOverride"
        | "modelOverrideSource"
        | "modelOverrideFallbackOriginProvider"
        | "modelOverrideFallbackOriginModel"
        | "authProfileOverride"
        | "authProfileOverrideSource"
        | "authProfileOverrideCompactionCount"
      >
    | null
    | undefined;
  sessionKey?: string | null;
  primaryProvider: string;
  primaryModel: string;
  now?: number;
  minIntervalMs?: number;
  maxTrackedProbeKeys?: number;
  probeState?: Map<string, number>;
}): AutoFallbackPrimaryProbe | undefined {
  const entry = params.entry;
  if (!entry) {
    return undefined;
  }
  const recoveredAutoFallbackOverride =
    entry.modelOverrideSource === undefined && hasSessionAutoModelFallbackProvenance(entry);
  if (entry.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
    return undefined;
  }

  const originProvider = normalizeOptionalString(entry.modelOverrideFallbackOriginProvider);
  const originModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
  const overrideProvider = normalizeOptionalString(entry.providerOverride);
  const overrideModel = normalizeOptionalString(entry.modelOverride);
  const primaryProvider = normalizeOptionalString(params.primaryProvider);
  const primaryModel = normalizeOptionalString(params.primaryModel);
  if (!originProvider || !originModel || !overrideProvider || !overrideModel) {
    return undefined;
  }
  if (!primaryProvider || !primaryModel) {
    return undefined;
  }
  if (originProvider !== primaryProvider || originModel !== primaryModel) {
    return undefined;
  }
  if (overrideProvider === originProvider && overrideModel === originModel) {
    return undefined;
  }

  const now = params.now ?? Date.now();
  const minIntervalMs = params.minIntervalMs ?? AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS;
  const state = params.probeState ?? autoFallbackPrimaryProbeState;
  pruneAutoFallbackPrimaryProbeState({
    state,
    now,
    minIntervalMs,
    maxKeys: params.maxTrackedProbeKeys,
  });
  const key = autoFallbackPrimaryProbeStateKey({
    sessionKey: params.sessionKey,
    primaryProvider: originProvider,
    primaryModel: originModel,
  });
  const lastProbeAt = state.get(key);
  if (
    typeof lastProbeAt === "number" &&
    Number.isFinite(lastProbeAt) &&
    now - lastProbeAt < minIntervalMs
  ) {
    return undefined;
  }
  const fallbackAuthProfileId = normalizeOptionalString(entry.authProfileOverride);
  const fallbackAuthProfileIdSource =
    entry.authProfileOverrideSource ??
    (entry.authProfileOverrideCompactionCount !== undefined ? "auto" : undefined);
  return {
    provider: originProvider,
    model: originModel,
    fallbackProvider: overrideProvider,
    fallbackModel: overrideModel,
    ...(fallbackAuthProfileId
      ? {
          fallbackAuthProfileId,
          ...(fallbackAuthProfileIdSource ? { fallbackAuthProfileIdSource } : {}),
        }
      : {}),
  };
}

export function markAutoFallbackPrimaryProbe(params: {
  probe: AutoFallbackPrimaryProbe;
  sessionKey?: string | null;
  now?: number;
  minIntervalMs?: number;
  maxTrackedProbeKeys?: number;
  probeState?: Map<string, number>;
}): void {
  const now = params.now ?? Date.now();
  const minIntervalMs = params.minIntervalMs ?? AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS;
  const state = params.probeState ?? autoFallbackPrimaryProbeState;
  pruneAutoFallbackPrimaryProbeState({
    state,
    now,
    minIntervalMs,
    maxKeys: params.maxTrackedProbeKeys,
  });
  const key = autoFallbackPrimaryProbeStateKey({
    sessionKey: params.sessionKey,
    primaryProvider: params.probe.provider,
    primaryModel: params.probe.model,
  });
  state.set(key, now);
  pruneAutoFallbackPrimaryProbeState({
    state,
    now,
    minIntervalMs,
    maxKeys: params.maxTrackedProbeKeys,
  });
}

export function entryMatchesAutoFallbackPrimaryProbe(
  entry:
    | Pick<
        SessionEntry,
        | "providerOverride"
        | "modelOverride"
        | "modelOverrideSource"
        | "modelOverrideFallbackOriginProvider"
        | "modelOverrideFallbackOriginModel"
      >
    | null
    | undefined,
  probe: AutoFallbackPrimaryProbe,
): boolean {
  if (!entry) {
    return false;
  }
  const recoveredAutoFallbackOverride =
    entry.modelOverrideSource === undefined && hasSessionAutoModelFallbackProvenance(entry);
  if (entry.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
    return false;
  }
  return (
    normalizeOptionalString(entry.providerOverride) === probe.fallbackProvider &&
    normalizeOptionalString(entry.modelOverride) === probe.fallbackModel &&
    normalizeOptionalString(entry.modelOverrideFallbackOriginProvider) === probe.provider &&
    normalizeOptionalString(entry.modelOverrideFallbackOriginModel) === probe.model
  );
}

export function clearAutoFallbackPrimaryProbeSelection(
  entry: SessionEntry,
  now = Date.now(),
): void {
  delete entry.providerOverride;
  delete entry.modelOverride;
  delete entry.modelOverrideSource;
  delete entry.modelOverrideFallbackOriginProvider;
  delete entry.modelOverrideFallbackOriginModel;
  if (
    entry.authProfileOverrideSource === "auto" ||
    (entry.authProfileOverrideSource === undefined &&
      entry.authProfileOverrideCompactionCount !== undefined)
  ) {
    delete entry.authProfileOverride;
    delete entry.authProfileOverrideSource;
    delete entry.authProfileOverrideCompactionCount;
  }
  delete entry.fallbackNoticeSelectedModel;
  delete entry.fallbackNoticeActiveModel;
  delete entry.fallbackNoticeReason;
  entry.updatedAt = now;
}

export { resolveAgentIdFromSessionKey };

export function resolveSessionAgentIds(params: {
  sessionKey?: string;
  config?: OpenClawConfig;
  agentId?: string;
}): {
  defaultAgentId: string;
  sessionAgentId: string;
} {
  const defaultAgentId = resolveDefaultAgentId(params.config ?? {});
  const explicitAgentIdRaw = normalizeLowercaseStringOrEmpty(params.agentId);
  const explicitAgentId = explicitAgentIdRaw ? normalizeAgentId(explicitAgentIdRaw) : null;
  const sessionKey = params.sessionKey?.trim();
  const normalizedSessionKey = sessionKey ? normalizeLowercaseStringOrEmpty(sessionKey) : undefined;
  const parsed = normalizedSessionKey ? parseAgentSessionKey(normalizedSessionKey) : null;
  const sessionAgentId =
    explicitAgentId ?? (parsed?.agentId ? normalizeAgentId(parsed.agentId) : defaultAgentId);
  return { defaultAgentId, sessionAgentId };
}

export function resolveSessionAgentId(params: {
  sessionKey?: string;
  config?: OpenClawConfig;
}): string {
  return resolveSessionAgentIds(params).sessionAgentId;
}

export function resolveAgentExecutionContract(
  cfg: OpenClawConfig | undefined,
  agentId?: string | null,
): NonNullable<NonNullable<AgentDefaultsConfig["embeddedPi"]>["executionContract"]> | undefined {
  const defaultContract = cfg?.agents?.defaults?.embeddedPi?.executionContract;
  if (!cfg || !agentId) {
    return defaultContract;
  }
  const agentContract = resolveAgentConfig(cfg, agentId)?.embeddedPi?.executionContract;
  return agentContract ?? defaultContract;
}

export function resolveAgentSkillsFilter(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  return resolveEffectiveAgentSkillFilter(cfg, agentId);
}

export function resolveAgentExplicitModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  return resolvePrimaryStringValue(raw);
}

export function resolveAgentEffectiveModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  return (
    resolveAgentExplicitModelPrimary(cfg, agentId) ??
    resolvePrimaryStringValue(cfg.agents?.defaults?.model)
  );
}

function findMutableAgentEntry(cfg: OpenClawConfig, agentId: string): AgentConfig | undefined {
  const id = normalizeAgentId(agentId);
  return cfg.agents?.list?.find((entry) => normalizeAgentId(entry?.id) === id);
}

function updateAgentModelPrimary(
  existing: AgentModelConfig | undefined,
  primary: string,
): AgentModelConfig {
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return { ...existing, primary };
  }
  return primary;
}

export type AgentModelPrimaryWriteTarget = "agent" | "defaults";

export function setAgentEffectiveModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
  primary: string,
): AgentModelPrimaryWriteTarget {
  const id = normalizeAgentId(agentId);
  if (resolveAgentExplicitModelPrimary(cfg, id)) {
    const entry = findMutableAgentEntry(cfg, id);
    if (entry) {
      entry.model = updateAgentModelPrimary(entry.model, primary);
      return "agent";
    }
  }
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.model = updateAgentModelPrimary(cfg.agents.defaults.model, primary);
  return "defaults";
}

/** @deprecated Prefer explicit/effective helpers at new call sites. */
export function resolveAgentModelPrimary(cfg: OpenClawConfig, agentId: string): string | undefined {
  return resolveAgentExplicitModelPrimary(cfg, agentId);
}

export function resolveAgentModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  return resolveSelectedModelFallbacksOverride(resolveAgentConfig(cfg, agentId)?.model);
}

function resolveSelectedModelFallbacksOverride(
  raw: AgentModelConfig | undefined,
): string[] | undefined {
  if (!raw) {
    return undefined;
  }
  if (typeof raw === "string") {
    return resolvePrimaryStringValue(raw) ? [] : undefined;
  }
  // Important: treat an explicitly provided empty array as an override to disable global fallbacks.
  if (!Object.hasOwn(raw, "fallbacks")) {
    return Object.hasOwn(raw, "primary") && resolvePrimaryStringValue(raw) ? [] : undefined;
  }
  return Array.isArray(raw.fallbacks) ? raw.fallbacks : undefined;
}

export type SubagentModelConfigSelectionSource = "subagent" | "agent" | "default-subagent";

export type SubagentModelConfigSelectionResult = {
  raw: AgentModelConfig;
  source: SubagentModelConfigSelectionSource;
};

export function resolveSubagentModelConfigSelectionResult(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentConfigOverride?: Pick<AgentConfig, "model" | "subagents">;
}): SubagentModelConfigSelectionResult | undefined {
  const agentConfig =
    params.agentConfigOverride ??
    (params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined);
  const candidates: SubagentModelConfigSelectionResult[] = [
    ...(agentConfig?.subagents?.model
      ? [{ raw: agentConfig.subagents.model, source: "subagent" as const }]
      : []),
    ...(agentConfig?.model ? [{ raw: agentConfig.model, source: "agent" as const }] : []),
    ...(params.cfg.agents?.defaults?.subagents?.model
      ? [
          {
            raw: params.cfg.agents.defaults.subagents.model,
            source: "default-subagent" as const,
          },
        ]
      : []),
  ];
  return candidates.find((candidate) => resolvePrimaryStringValue(candidate.raw));
}

export function resolveSubagentModelConfigSelection(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentConfigOverride?: Pick<AgentConfig, "model" | "subagents">;
}): AgentModelConfig | undefined {
  return resolveSubagentModelConfigSelectionResult(params)?.raw;
}

export function resolveSubagentModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const subagentFallbacks = resolveSelectedModelFallbacksOverride(agentConfig?.subagents?.model);
  if (subagentFallbacks !== undefined) {
    return subagentFallbacks;
  }
  const selection = resolveSubagentModelConfigSelectionResult({ cfg, agentId });
  if (selection?.source === "agent") {
    return resolveSelectedModelFallbacksOverride(agentConfig?.model);
  }
  if (selection?.source === "default-subagent") {
    return resolveSelectedModelFallbacksOverride(cfg.agents?.defaults?.subagents?.model);
  }
  return undefined;
}

export function resolveFallbackAgentId(params: {
  agentId?: string | null;
  sessionKey?: string | null;
}): string {
  const explicitAgentId = normalizeOptionalString(params.agentId) ?? "";
  if (explicitAgentId) {
    return normalizeAgentId(explicitAgentId);
  }
  return resolveAgentIdFromSessionKey(params.sessionKey);
}

export function resolveRunModelFallbacksOverride(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): string[] | undefined {
  if (!params.cfg) {
    return undefined;
  }
  return resolveAgentModelFallbacksOverride(
    params.cfg,
    resolveFallbackAgentId({ agentId: params.agentId, sessionKey: params.sessionKey }),
  );
}

export function hasConfiguredModelFallbacks(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): boolean {
  const fallbacksOverride = resolveRunModelFallbacksOverride(params);
  const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.model);
  return (fallbacksOverride ?? defaultFallbacks).length > 0;
}

export function resolveEffectiveModelFallbacks(params: {
  cfg: OpenClawConfig;
  agentId: string;
  hasSessionModelOverride: boolean;
  modelOverrideSource?: "auto" | "user";
  hasAutoFallbackProvenance?: boolean;
}): string[] | undefined {
  const agentFallbacksOverride = resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
  if (!params.hasSessionModelOverride) {
    return agentFallbacksOverride;
  }
  const canUseConfiguredFallbacks =
    params.modelOverrideSource === "auto" ||
    (params.modelOverrideSource === undefined && params.hasAutoFallbackProvenance === true);
  if (!canUseConfiguredFallbacks) {
    return [];
  }
  const defaultFallbacks = resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model);
  return agentFallbacksOverride ?? defaultFallbacks;
}

function normalizePathForComparison(input: string): string {
  const resolved = path.resolve(stripNullBytes(resolveUserPath(input)));
  let normalized = resolved;
  // Prefer realpath when available to normalize aliases/symlinks (for example /tmp -> /private/tmp)
  // and canonical path case without forcing case-folding on case-sensitive macOS volumes.
  try {
    normalized = fs.realpathSync.native(resolved);
  } catch {
    // Keep lexical path for non-existent directories.
  }
  if (process.platform === "win32") {
    return lowercasePreservingWhitespace(normalized);
  }
  return normalized;
}

export function resolveAgentIdsByWorkspacePath(
  cfg: OpenClawConfig,
  workspacePath: string,
): string[] {
  const normalizedWorkspacePath = normalizePathForComparison(workspacePath);
  const ids = listAgentIds(cfg);
  const matches: Array<{ id: string; workspaceDir: string; order: number }> = [];

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index];
    const workspaceDir = normalizePathForComparison(resolveAgentWorkspaceDir(cfg, id));
    if (!isPathInside(workspaceDir, normalizedWorkspacePath)) {
      continue;
    }
    matches.push({ id, workspaceDir, order: index });
  }

  matches.sort((left, right) => {
    const workspaceLengthDelta = right.workspaceDir.length - left.workspaceDir.length;
    if (workspaceLengthDelta !== 0) {
      return workspaceLengthDelta;
    }
    return left.order - right.order;
  });

  return matches.map((entry) => entry.id);
}

export function resolveAgentIdByWorkspacePath(
  cfg: OpenClawConfig,
  workspacePath: string,
): string | undefined {
  return resolveAgentIdsByWorkspacePath(cfg, workspacePath)[0];
}
