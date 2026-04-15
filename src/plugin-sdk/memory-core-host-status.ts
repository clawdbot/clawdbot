import type { OpenClawConfig } from "../config/config.js";
import { resolveDefaultAgentId, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  resolveMemoryCacheSummary,
  resolveMemoryFtsState,
  resolveMemoryVectorState,
  type Tone,
} from "../memory/status-format.js";

export type { Tone };

export const DEFAULT_MEMORY_DREAMING_FREQUENCY = "0 3 * * *";
export const DEFAULT_MEMORY_DEEP_DREAMING_LIMIT = 10;
export const DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE = 0.8;
export const DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT = 3;
export const DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES = 3;
export const DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS = 14;
export const DEFAULT_MEMORY_DEEP_DREAMING_MAX_AGE_DAYS = 30;
export const DEFAULT_MEMORY_LIGHT_DREAMING_LOOKBACK_DAYS = 2;
export const DEFAULT_MEMORY_LIGHT_DREAMING_LIMIT = 20;
export const DEFAULT_MEMORY_LIGHT_DREAMING_DEDUPE_SIMILARITY = 0.9;
export const DEFAULT_MEMORY_REM_DREAMING_LOOKBACK_DAYS = 7;
export const DEFAULT_MEMORY_REM_DREAMING_LIMIT = 10;
export const DEFAULT_MEMORY_REM_DREAMING_MIN_PATTERN_STRENGTH = 0.75;

type RecordLike = Record<string, unknown>;

export type MemoryDreamingWorkspace = {
  workspaceDir: string;
  agentIds: string[];
};

export type MemoryDreamingConfig = {
  enabled: boolean;
  frequency: string;
  timezone?: string;
};

export type MemoryDeepDreamingConfig = {
  enabled: boolean;
  frequency: string;
  timezone?: string;
  limit: number;
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays: number;
  maxAgeDays: number;
  verboseLogging: boolean;
  storage: {
    mode: "inline" | "separate" | "both";
    separateReports: boolean;
  };
};

export type MemoryLightDreamingConfig = {
  enabled: boolean;
  timezone?: string;
  lookbackDays: number;
  limit: number;
  dedupeSimilarity: number;
  storage: {
    mode: "inline" | "separate" | "both";
    separateReports: boolean;
  };
};

export type MemoryRemDreamingConfig = {
  enabled: boolean;
  timezone?: string;
  lookbackDays: number;
  limit: number;
  minPatternStrength: number;
  storage: {
    mode: "inline" | "separate" | "both";
    separateReports: boolean;
  };
};

function asRecord(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordLike)
    : undefined;
}

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const trimmed = trimToUndefined(value)?.toLowerCase();
  if (trimmed === "true") {
    return true;
  }
  if (trimmed === "false") {
    return false;
  }
  return undefined;
}

function parseNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  const trimmed = trimToUndefined(value);
  if (!trimmed) {
    return undefined;
  }
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseFraction(value: unknown): number | undefined {
  const parsed = parseNonNegativeNumber(value);
  return parsed !== undefined && parsed <= 1 ? parsed : undefined;
}

function resolveDreamingPluginConfig(pluginConfig: unknown): RecordLike {
  const record = asRecord(pluginConfig) ?? {};
  return asRecord(record.dreaming) ?? {};
}

function resolveStorageConfig(dreaming: RecordLike) {
  const storage = asRecord(dreaming.storage) ?? {};
  const modeValue = trimToUndefined(storage.mode);
  const mode =
    modeValue === "inline" || modeValue === "separate" || modeValue === "both"
      ? modeValue
      : "inline";
  return {
    mode,
    separateReports: parseBoolean(storage.separateReports) ?? false,
  } as const;
}

function resolveTimezone(dreaming: RecordLike, cfg?: OpenClawConfig): string | undefined {
  return trimToUndefined(dreaming.timezone) ?? trimToUndefined(cfg?.agents?.defaults?.userTimezone);
}

function resolvePhaseConfig(dreaming: RecordLike, phase: "light" | "deep" | "rem"): RecordLike {
  return asRecord(asRecord(dreaming.phases)?.[phase]) ?? {};
}

export function resolveMemoryCorePluginConfig(cfg: OpenClawConfig): RecordLike {
  return asRecord(asRecord(cfg.plugins?.entries)?.["memory-core"])?.config as RecordLike ?? {};
}

export function resolveMemoryDreamingConfig(params: {
  pluginConfig?: unknown;
  cfg?: OpenClawConfig;
}): MemoryDreamingConfig {
  const dreaming = resolveDreamingPluginConfig(params.pluginConfig);
  return {
    enabled: parseBoolean(dreaming.enabled) ?? false,
    frequency: trimToUndefined(dreaming.frequency) ?? DEFAULT_MEMORY_DREAMING_FREQUENCY,
    timezone: resolveTimezone(dreaming, params.cfg),
  };
}

export function resolveMemoryDeepDreamingConfig(params: {
  pluginConfig?: unknown;
  cfg?: OpenClawConfig;
}): MemoryDeepDreamingConfig {
  const dreaming = resolveDreamingPluginConfig(params.pluginConfig);
  const deep = resolvePhaseConfig(dreaming, "deep");
  return {
    enabled: (parseBoolean(deep.enabled) ?? parseBoolean(dreaming.enabled) ?? false) === true,
    frequency: trimToUndefined(dreaming.frequency) ?? DEFAULT_MEMORY_DREAMING_FREQUENCY,
    timezone: resolveTimezone(dreaming, params.cfg),
    limit: parseNonNegativeNumber(deep.limit) ?? DEFAULT_MEMORY_DEEP_DREAMING_LIMIT,
    minScore: parseFraction(deep.minScore) ?? DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE,
    minRecallCount:
      parseNonNegativeNumber(deep.minRecallCount) ?? DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT,
    minUniqueQueries:
      parseNonNegativeNumber(deep.minUniqueQueries) ??
      DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
    recencyHalfLifeDays:
      parseNonNegativeNumber(deep.recencyHalfLifeDays) ??
      DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS,
    maxAgeDays:
      parseNonNegativeNumber(deep.maxAgeDays) ?? DEFAULT_MEMORY_DEEP_DREAMING_MAX_AGE_DAYS,
    verboseLogging: parseBoolean(dreaming.verboseLogging) ?? false,
    storage: resolveStorageConfig(dreaming),
  };
}

export function resolveMemoryLightDreamingConfig(params: {
  pluginConfig?: unknown;
  cfg?: OpenClawConfig;
}): MemoryLightDreamingConfig {
  const dreaming = resolveDreamingPluginConfig(params.pluginConfig);
  const light = resolvePhaseConfig(dreaming, "light");
  return {
    enabled: (parseBoolean(light.enabled) ?? parseBoolean(dreaming.enabled) ?? false) === true,
    timezone: resolveTimezone(dreaming, params.cfg),
    lookbackDays:
      parseNonNegativeNumber(light.lookbackDays) ?? DEFAULT_MEMORY_LIGHT_DREAMING_LOOKBACK_DAYS,
    limit: parseNonNegativeNumber(light.limit) ?? DEFAULT_MEMORY_LIGHT_DREAMING_LIMIT,
    dedupeSimilarity:
      parseFraction(light.dedupeSimilarity) ?? DEFAULT_MEMORY_LIGHT_DREAMING_DEDUPE_SIMILARITY,
    storage: resolveStorageConfig(dreaming),
  };
}

export function resolveMemoryRemDreamingConfig(params: {
  pluginConfig?: unknown;
  cfg?: OpenClawConfig;
}): MemoryRemDreamingConfig {
  const dreaming = resolveDreamingPluginConfig(params.pluginConfig);
  const rem = resolvePhaseConfig(dreaming, "rem");
  return {
    enabled: (parseBoolean(rem.enabled) ?? parseBoolean(dreaming.enabled) ?? false) === true,
    timezone: resolveTimezone(dreaming, params.cfg),
    lookbackDays:
      parseNonNegativeNumber(rem.lookbackDays) ?? DEFAULT_MEMORY_REM_DREAMING_LOOKBACK_DAYS,
    limit: parseNonNegativeNumber(rem.limit) ?? DEFAULT_MEMORY_REM_DREAMING_LIMIT,
    minPatternStrength:
      parseFraction(rem.minPatternStrength) ?? DEFAULT_MEMORY_REM_DREAMING_MIN_PATTERN_STRENGTH,
    storage: resolveStorageConfig(dreaming),
  };
}

export function formatMemoryDreamingDay(nowMs: number, timezone?: string): string {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(new Date(nowMs));
}

export function resolveMemoryDreamingWorkspaces(cfg: OpenClawConfig): MemoryDreamingWorkspace[] {
  const byWorkspace = new Map<string, Set<string>>();
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const agentIds = new Set<string>([defaultAgentId]);
  for (const agent of cfg.agents?.list ?? []) {
    if (typeof agent?.id === "string" && agent.id.trim()) {
      agentIds.add(agent.id);
    }
  }
  for (const agentId of agentIds) {
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    if (!workspaceDir) {
      continue;
    }
    let bucket = byWorkspace.get(workspaceDir);
    if (!bucket) {
      bucket = new Set<string>();
      byWorkspace.set(workspaceDir, bucket);
    }
    bucket.add(agentId);
  }
  return [...byWorkspace.entries()].map(([workspaceDir, ids]) => ({
    workspaceDir,
    agentIds: [...ids].sort(),
  }));
}

export { resolveMemoryCacheSummary, resolveMemoryFtsState, resolveMemoryVectorState };
