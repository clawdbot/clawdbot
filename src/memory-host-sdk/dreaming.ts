// Memory host dreaming helpers record and load memory dreaming artifacts.
import { parseBoolean } from "@openclaw/normalization-core/boolean-coercion";
import {
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { resolveWorkspaceStateIdentity } from "../agents/workspace-state-identity.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const DEFAULT_MEMORY_DREAMING_ENABLED = true;
const DEFAULT_MEMORY_DREAMING_TIMEZONE = undefined;
const DEFAULT_MEMORY_DREAMING_VERBOSE_LOGGING = false;
const DEFAULT_MEMORY_DREAMING_STORAGE_MODE = "separate";
const DEFAULT_MEMORY_DREAMING_SEPARATE_REPORTS = false;
export const DEFAULT_MEMORY_DREAMING_FREQUENCY = "0 3 * * *";
export const DEFAULT_MEMORY_DREAMING_PLUGIN_ID = "memory-core";
export const MANAGED_MEMORY_DREAMING_CRON_NAME = "Memory Dreaming Promotion";
export const MANAGED_MEMORY_DREAMING_CRON_TAG = "[managed-by=memory-core.short-term-promotion]";
export const MEMORY_DREAMING_SYSTEM_EVENT_TEXT =
  "__openclaw_memory_core_short_term_promotion_dream__";
export const LEGACY_MEMORY_LIGHT_DREAMING_CRON_NAME = "Memory Light Dreaming";
export const LEGACY_MEMORY_LIGHT_DREAMING_CRON_TAG = "[managed-by=memory-core.dreaming.light]";
export const LEGACY_MEMORY_LIGHT_DREAMING_EVENT_TEXT = "__openclaw_memory_core_light_sleep__";
export const LEGACY_MEMORY_REM_DREAMING_CRON_NAME = "Memory REM Dreaming";
export const LEGACY_MEMORY_REM_DREAMING_CRON_TAG = "[managed-by=memory-core.dreaming.rem]";
export const LEGACY_MEMORY_REM_DREAMING_EVENT_TEXT = "__openclaw_memory_core_rem_sleep__";
const DEFAULT_MEMORY_LIGHT_DREAMING_LOOKBACK_DAYS = 2;
const DEFAULT_MEMORY_LIGHT_DREAMING_LIMIT = 100;
const DEFAULT_MEMORY_LIGHT_DREAMING_DEDUPE_SIMILARITY = 0.9;
export const DEFAULT_MEMORY_DEEP_DREAMING_LIMIT = 10;
// Deterministic calibration scores 3-day/3-query durable facts at 0.750-0.756,
// versus repeated filler at 0.489-0.549 and high-relevance one-offs at 0.529-0.606.
export const DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE = 0.75;
export const DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT = 3;
export const DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES = 3;
export const DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS = 14;
const DEFAULT_MEMORY_DEEP_DREAMING_MAX_AGE_DAYS = 30;
export const DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS = 160;
export const DEFAULT_MEMORY_DEEP_DREAMING_MAX_PRIOR_ENTRY_LOSS_FRACTION = 0.25;

const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_ENABLED = true;
const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_TRIGGER_BELOW_HEALTH = 0.35;
const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_LOOKBACK_DAYS = 30;
const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_MAX_CANDIDATES = 20;
const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_MIN_CONFIDENCE = 0.9;
const DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_AUTO_WRITE_MIN_CONFIDENCE = 0.97;
const DEFAULT_MEMORY_REM_DREAMING_LOOKBACK_DAYS = 7;
const DEFAULT_MEMORY_REM_DREAMING_LIMIT = 10;
const DEFAULT_MEMORY_REM_DREAMING_MIN_PATTERN_STRENGTH = 0.75;

const DEFAULT_MEMORY_DREAMING_SPEED = "balanced";
const DEFAULT_MEMORY_DREAMING_THINKING = "medium";
const DEFAULT_MEMORY_DREAMING_BUDGET = "medium";

type MemoryDreamingSpeed = "fast" | "balanced" | "slow";
type MemoryDreamingThinking = "low" | "medium" | "high";
type MemoryDreamingBudget = "cheap" | "medium" | "expensive";
type MemoryDreamingStorageMode = "inline" | "separate" | "both";

type MemoryLightDreamingSource = "daily" | "sessions" | "recall";
type MemoryDeepDreamingSource = "daily" | "memory" | "sessions" | "logs" | "recall";
type MemoryRemDreamingSource = "memory" | "daily" | "deep";

type MemoryDreamingExecutionConfig = {
  speed: MemoryDreamingSpeed;
  thinking: MemoryDreamingThinking;
  budget: MemoryDreamingBudget;
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

export type MemoryDreamingStorageConfig = {
  mode: MemoryDreamingStorageMode;
  separateReports: boolean;
};

export type DreamingArtifactsAuditIssue = {
  severity: "warn" | "error";
  code:
    | "dreaming-session-corpus-unreadable"
    | "dreaming-session-corpus-self-ingested"
    | "dreaming-session-ingestion-unreadable"
    | "dreaming-diary-unreadable";
  message: string;
  fixable: boolean;
};

export type DreamingArtifactsAuditSummary = {
  dreamsPath?: string;
  sessionCorpusDir: string;
  sessionCorpusFileCount: number;
  suspiciousSessionCorpusFileCount: number;
  suspiciousSessionCorpusLineCount: number;
  sessionIngestionPath: string;
  sessionIngestionExists: boolean;
  issues: DreamingArtifactsAuditIssue[];
};

export type RepairDreamingArtifactsResult = {
  changed: boolean;
  archiveDir?: string;
  archivedDreamsDiary: boolean;
  archivedSessionCorpus: boolean;
  archivedSessionIngestion: boolean;
  archivedPaths: string[];
  warnings: string[];
};

export type ShortTermAuditIssue = {
  severity: "warn" | "error";
  code:
    | "recall-store-unreadable"
    | "recall-store-empty"
    | "recall-store-invalid"
    | "recall-store-dangling"
    | "recall-store-over-limit"
    | "recall-lock-stale"
    | "recall-lock-unreadable";
  message: string;
  fixable: boolean;
};

export type ShortTermAuditSummary<TConceptTagScripts = Record<string, unknown>> = {
  storePath: string;
  lockPath: string;
  updatedAt?: string;
  exists: boolean;
  entryCount: number;
  promotedCount: number;
  spacedEntryCount: number;
  conceptTaggedEntryCount: number;
  conceptTagScripts?: TConceptTagScripts;
  invalidEntryCount: number;
  danglingEntryCount?: number;
  issues: ShortTermAuditIssue[];
};

export type RepairShortTermPromotionArtifactsResult = {
  changed: boolean;
  removedInvalidEntries: number;
  removedDanglingEntries?: number;
  removedOverflowEntries?: number;
  rewroteStore: boolean;
  removedStaleLock: boolean;
};

export type ShortTermDreamingStatsEntry = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalSignalCount: number;
  lightHits: number;
  remHits: number;
  phaseHitCount: number;
  promotedAt?: string;
  lastRecalledAt?: string;
};

export type ShortTermDreamingStats = {
  shortTermCount: number;
  recallSignalCount: number;
  dailySignalCount: number;
  groundedSignalCount: number;
  totalSignalCount: number;
  phaseSignalCount: number;
  lightPhaseHitCount: number;
  remPhaseHitCount: number;
  promotedTotal: number;
  promotedToday: number;
  storePath: string;
  phaseSignalPath: string;
  phaseSignalError?: string;
  lastPromotedAt?: string;
  shortTermEntries: ShortTermDreamingStatsEntry[];
  signalEntries: ShortTermDreamingStatsEntry[];
  promotedEntries: ShortTermDreamingStatsEntry[];
};

type MemoryLightDreamingConfig = {
  enabled: boolean;
  cron: string;
  lookbackDays: number;
  limit: number;
  dedupeSimilarity: number;
  sources: MemoryLightDreamingSource[];
  execution: MemoryDreamingExecutionConfig;
};

type MemoryDeepDreamingRecoveryConfig = {
  enabled: boolean;
  triggerBelowHealth: number;
  lookbackDays: number;
  maxRecoveredCandidates: number;
  minRecoveryConfidence: number;
  autoWriteMinConfidence: number;
};

type MemoryDeepDreamingConfig = {
  enabled: boolean;
  cron: string;
  limit: number;
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays: number;
  maxAgeDays?: number;
  maxPromotedSnippetTokens?: number;
  maxPriorEntryLossFraction: number;
  sources: MemoryDeepDreamingSource[];
  recovery: MemoryDeepDreamingRecoveryConfig;
  execution: MemoryDreamingExecutionConfig;
};

type MemoryRemDreamingConfig = {
  enabled: boolean;
  cron: string;
  lookbackDays: number;
  limit: number;
  minPatternStrength: number;
  sources: MemoryRemDreamingSource[];
  execution: MemoryDreamingExecutionConfig;
};

export type MemoryDreamingPhaseName = "light" | "deep" | "rem";

type MemoryDreamingConfig = {
  enabled: boolean;
  frequency: string;
  timezone?: string;
  verboseLogging: boolean;
  storage: MemoryDreamingStorageConfig;
  execution: {
    defaults: MemoryDreamingExecutionConfig;
  };
  phases: {
    light: MemoryLightDreamingConfig;
    deep: MemoryDeepDreamingConfig;
    rem: MemoryRemDreamingConfig;
  };
};

type MemoryDreamingWorkspace = {
  workspaceDir: string;
  agentIds: string[];
};

type MemoryDreamingWorkspaceOptions = {
  primaryWorkspaceDir?: string | null;
  primaryAgentId?: string | null;
  env?: NodeJS.ProcessEnv;
};

const DEFAULT_MEMORY_LIGHT_DREAMING_SOURCES: MemoryLightDreamingSource[] = [
  "daily",
  "sessions",
  "recall",
];
const DEFAULT_MEMORY_DEEP_DREAMING_SOURCES: MemoryDeepDreamingSource[] = [
  "daily",
  "memory",
  "sessions",
  "logs",
  "recall",
];
const DEFAULT_MEMORY_REM_DREAMING_SOURCES: MemoryRemDreamingSource[] = ["memory", "daily", "deep"];

function normalizeScore(value: unknown, fallback: number): number {
  const normalized = normalizeStringifiedOptionalString(value);
  if (typeof value === "string" && !normalized) {
    return fallback;
  }
  const num = typeof value === "string" ? Number(normalized) : Number(value);
  if (!Number.isFinite(num) || num < 0 || num > 1) {
    return fallback;
  }
  return num;
}

function normalizeStringArray<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: readonly T[],
): T[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }
  const allowedSet = new Set(allowed);
  const normalized: T[] = [];
  for (const entry of value) {
    const normalizedEntry = normalizeOptionalLowercaseString(entry);
    if (!normalizedEntry || !allowedSet.has(normalizedEntry as T)) {
      continue;
    }
    if (!normalized.includes(normalizedEntry as T)) {
      normalized.push(normalizedEntry as T);
    }
  }
  return normalized.length > 0 ? normalized : [...fallback];
}

function normalizeStorageMode(value: unknown): MemoryDreamingStorageMode {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "inline" || normalized === "separate" || normalized === "both") {
    return normalized;
  }
  return DEFAULT_MEMORY_DREAMING_STORAGE_MODE;
}

function normalizeSpeed(value: unknown): MemoryDreamingSpeed | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "fast" || normalized === "balanced" || normalized === "slow") {
    return normalized;
  }
  return undefined;
}

function normalizeThinking(value: unknown): MemoryDreamingThinking | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "low" || normalized === "medium" || normalized === "high") {
    return normalized;
  }
  return undefined;
}

function normalizeBudget(value: unknown): MemoryDreamingBudget | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (normalized === "cheap" || normalized === "medium" || normalized === "expensive") {
    return normalized;
  }
  return undefined;
}

function resolveExecutionConfig(
  value: unknown,
  fallback: MemoryDreamingExecutionConfig,
): MemoryDreamingExecutionConfig {
  const record = asNullableRecord(value);
  const maxOutputTokens = parseStrictPositiveInteger(record?.maxOutputTokens);
  const timeoutMs = parseStrictPositiveInteger(record?.timeoutMs);
  const temperatureRaw = record?.temperature;
  const temperature =
    typeof temperatureRaw === "number" && Number.isFinite(temperatureRaw) && temperatureRaw >= 0
      ? Math.min(2, temperatureRaw)
      : undefined;
  const model = normalizeOptionalString(record?.model) ?? fallback.model;

  return {
    speed: normalizeSpeed(record?.speed) ?? fallback.speed,
    thinking: normalizeThinking(record?.thinking) ?? fallback.thinking,
    budget: normalizeBudget(record?.budget) ?? fallback.budget,
    ...(model ? { model } : {}),
    ...(typeof maxOutputTokens === "number" ? { maxOutputTokens } : {}),
    ...(typeof temperature === "number" ? { temperature } : {}),
    ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
  };
}

function formatLocalIsoDay(epochMs: number): string {
  const date = new Date(epochMs);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function resolveMemoryDreamingPluginId(
  cfg: OpenClawConfig | Record<string, unknown> | undefined,
): string {
  const root = asNullableRecord(cfg);
  const plugins = asNullableRecord(root?.plugins);
  const slots = asNullableRecord(plugins?.slots);
  const configuredSlot = normalizeOptionalString(slots?.memory);
  if (configuredSlot && normalizeLowercaseStringOrEmpty(configuredSlot) !== "none") {
    return configuredSlot;
  }
  return DEFAULT_MEMORY_DREAMING_PLUGIN_ID;
}

export function resolveMemoryDreamingPluginConfig(
  cfg: OpenClawConfig | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const root = asNullableRecord(cfg);
  const plugins = asNullableRecord(root?.plugins);
  const entries = asNullableRecord(plugins?.entries);
  const pluginId = resolveMemoryDreamingPluginId(cfg);
  const memoryPlugin = asNullableRecord(entries?.[pluginId]);
  return asNullableRecord(memoryPlugin?.config) ?? undefined;
}

export function resolveMemoryDreamingConfig(params: {
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
}): MemoryDreamingConfig {
  const dreaming = asNullableRecord(params.pluginConfig?.dreaming);
  const frequency =
    normalizeOptionalString(dreaming?.frequency) ?? DEFAULT_MEMORY_DREAMING_FREQUENCY;
  const timezone =
    normalizeOptionalString(dreaming?.timezone) ??
    normalizeOptionalString(params.cfg?.agents?.defaults?.userTimezone) ??
    DEFAULT_MEMORY_DREAMING_TIMEZONE;
  const storage = asNullableRecord(dreaming?.storage);
  const execution = asNullableRecord(dreaming?.execution);
  const phases = asNullableRecord(dreaming?.phases);
  const topLevelModel = normalizeOptionalString(dreaming?.model);

  const defaultExecution = resolveExecutionConfig(execution?.defaults, {
    speed: DEFAULT_MEMORY_DREAMING_SPEED,
    thinking: DEFAULT_MEMORY_DREAMING_THINKING,
    budget: DEFAULT_MEMORY_DREAMING_BUDGET,
    ...(topLevelModel ? { model: topLevelModel } : {}),
  });

  const light = asNullableRecord(phases?.light);
  const deep = asNullableRecord(phases?.deep);
  const rem = asNullableRecord(phases?.rem);
  const deepRecovery = asNullableRecord(deep?.recovery);
  const maxAgeDays = parseStrictPositiveInteger(deep?.maxAgeDays);
  const maxPromotedSnippetTokens = parseStrictPositiveInteger(deep?.maxPromotedSnippetTokens);

  return {
    enabled: parseBoolean(dreaming?.enabled) ?? DEFAULT_MEMORY_DREAMING_ENABLED,
    frequency,
    ...(timezone ? { timezone } : {}),
    verboseLogging:
      parseBoolean(dreaming?.verboseLogging) ?? DEFAULT_MEMORY_DREAMING_VERBOSE_LOGGING,
    storage: {
      mode: normalizeStorageMode(storage?.mode),
      separateReports:
        parseBoolean(storage?.separateReports) ?? DEFAULT_MEMORY_DREAMING_SEPARATE_REPORTS,
    },
    execution: {
      defaults: defaultExecution,
    },
    phases: {
      light: {
        enabled: parseBoolean(light?.enabled) ?? true,
        cron: frequency,
        lookbackDays:
          parseStrictNonNegativeInteger(light?.lookbackDays) ??
          DEFAULT_MEMORY_LIGHT_DREAMING_LOOKBACK_DAYS,
        limit: parseStrictNonNegativeInteger(light?.limit) ?? DEFAULT_MEMORY_LIGHT_DREAMING_LIMIT,
        dedupeSimilarity: normalizeScore(
          light?.dedupeSimilarity,
          DEFAULT_MEMORY_LIGHT_DREAMING_DEDUPE_SIMILARITY,
        ),
        sources: normalizeStringArray(
          light?.sources,
          ["daily", "sessions", "recall"] as const,
          DEFAULT_MEMORY_LIGHT_DREAMING_SOURCES,
        ),
        execution: resolveExecutionConfig(light?.execution, {
          ...defaultExecution,
          speed: "fast",
          thinking: "low",
          budget: "cheap",
        }),
      },
      deep: {
        enabled: parseBoolean(deep?.enabled) ?? true,
        cron: frequency,
        limit: parseStrictNonNegativeInteger(deep?.limit) ?? DEFAULT_MEMORY_DEEP_DREAMING_LIMIT,
        minScore: normalizeScore(deep?.minScore, DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE),
        minRecallCount:
          parseStrictNonNegativeInteger(deep?.minRecallCount) ??
          DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT,
        minUniqueQueries:
          parseStrictNonNegativeInteger(deep?.minUniqueQueries) ??
          DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
        recencyHalfLifeDays:
          parseStrictNonNegativeInteger(deep?.recencyHalfLifeDays) ??
          DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS,
        ...(typeof maxAgeDays === "number"
          ? { maxAgeDays }
          : typeof DEFAULT_MEMORY_DEEP_DREAMING_MAX_AGE_DAYS === "number"
            ? { maxAgeDays: DEFAULT_MEMORY_DEEP_DREAMING_MAX_AGE_DAYS }
            : {}),
        maxPromotedSnippetTokens:
          maxPromotedSnippetTokens ?? DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
        maxPriorEntryLossFraction: normalizeScore(
          deep?.maxPriorEntryLossFraction,
          DEFAULT_MEMORY_DEEP_DREAMING_MAX_PRIOR_ENTRY_LOSS_FRACTION,
        ),
        sources: normalizeStringArray(
          deep?.sources,
          ["daily", "memory", "sessions", "logs", "recall"] as const,
          DEFAULT_MEMORY_DEEP_DREAMING_SOURCES,
        ),
        recovery: {
          enabled:
            parseBoolean(deepRecovery?.enabled) ?? DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_ENABLED,
          triggerBelowHealth: normalizeScore(
            deepRecovery?.triggerBelowHealth,
            DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_TRIGGER_BELOW_HEALTH,
          ),
          lookbackDays:
            parseStrictNonNegativeInteger(deepRecovery?.lookbackDays) ??
            DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_LOOKBACK_DAYS,
          maxRecoveredCandidates:
            parseStrictNonNegativeInteger(deepRecovery?.maxRecoveredCandidates) ??
            DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_MAX_CANDIDATES,
          minRecoveryConfidence: normalizeScore(
            deepRecovery?.minRecoveryConfidence,
            DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_MIN_CONFIDENCE,
          ),
          autoWriteMinConfidence: normalizeScore(
            deepRecovery?.autoWriteMinConfidence,
            DEFAULT_MEMORY_DEEP_DREAMING_RECOVERY_AUTO_WRITE_MIN_CONFIDENCE,
          ),
        },
        execution: resolveExecutionConfig(deep?.execution, {
          ...defaultExecution,
          speed: "balanced",
          thinking: "high",
          budget: "medium",
        }),
      },
      rem: {
        enabled: parseBoolean(rem?.enabled) ?? true,
        cron: frequency,
        lookbackDays:
          parseStrictNonNegativeInteger(rem?.lookbackDays) ??
          DEFAULT_MEMORY_REM_DREAMING_LOOKBACK_DAYS,
        limit: parseStrictNonNegativeInteger(rem?.limit) ?? DEFAULT_MEMORY_REM_DREAMING_LIMIT,
        minPatternStrength: normalizeScore(
          rem?.minPatternStrength,
          DEFAULT_MEMORY_REM_DREAMING_MIN_PATTERN_STRENGTH,
        ),
        sources: normalizeStringArray(
          rem?.sources,
          ["memory", "daily", "deep"] as const,
          DEFAULT_MEMORY_REM_DREAMING_SOURCES,
        ),
        execution: resolveExecutionConfig(rem?.execution, {
          ...defaultExecution,
          speed: "slow",
          thinking: "high",
          budget: "expensive",
        }),
      },
    },
  };
}

export function resolveMemoryDeepDreamingConfig(params: {
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
}): MemoryDeepDreamingConfig & {
  timezone?: string;
  verboseLogging: boolean;
  storage: MemoryDreamingStorageConfig;
} {
  const resolved = resolveMemoryDreamingConfig(params);
  return {
    ...resolved.phases.deep,
    enabled: resolved.enabled && resolved.phases.deep.enabled,
    ...(resolved.timezone ? { timezone: resolved.timezone } : {}),
    verboseLogging: resolved.verboseLogging,
    storage: resolved.storage,
  };
}

export function resolveMemoryLightDreamingConfig(params: {
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
}): MemoryLightDreamingConfig & {
  timezone?: string;
  verboseLogging: boolean;
  storage: MemoryDreamingStorageConfig;
} {
  const resolved = resolveMemoryDreamingConfig(params);
  return {
    ...resolved.phases.light,
    enabled: resolved.enabled && resolved.phases.light.enabled,
    ...(resolved.timezone ? { timezone: resolved.timezone } : {}),
    verboseLogging: resolved.verboseLogging,
    storage: resolved.storage,
  };
}

export function resolveMemoryRemDreamingConfig(params: {
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
}): MemoryRemDreamingConfig & {
  timezone?: string;
  verboseLogging: boolean;
  storage: MemoryDreamingStorageConfig;
} {
  const resolved = resolveMemoryDreamingConfig(params);
  return {
    ...resolved.phases.rem,
    enabled: resolved.enabled && resolved.phases.rem.enabled,
    ...(resolved.timezone ? { timezone: resolved.timezone } : {}),
    verboseLogging: resolved.verboseLogging,
    storage: resolved.storage,
  };
}

export function formatMemoryDreamingDay(epochMs: number, timezone?: string): string {
  if (!timezone) {
    return formatLocalIsoDay(epochMs);
  }
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date(epochMs));
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = values.get("year");
    const month = values.get("month");
    const day = values.get("day");
    if (year && month && day) {
      return `${year}-${month}-${day}`;
    }
  } catch {
    // Fall back to host-local day for invalid or unsupported timezones.
  }
  return formatLocalIsoDay(epochMs);
}

export function isSameMemoryDreamingDay(
  firstEpochMs: number,
  secondEpochMs: number,
  timezone?: string,
): boolean {
  return (
    formatMemoryDreamingDay(firstEpochMs, timezone) ===
    formatMemoryDreamingDay(secondEpochMs, timezone)
  );
}

export function resolveMemoryDreamingWorkspaces(
  cfg: OpenClawConfig,
  options: MemoryDreamingWorkspaceOptions = {},
): MemoryDreamingWorkspace[] {
  const agentIds = listAgentIds(cfg);
  if (agentIds.length === 0) {
    agentIds.push(resolveDefaultAgentId(cfg));
  }

  const byWorkspace = new Map<string, MemoryDreamingWorkspace>();
  const addWorkspace = (workspaceDirRaw: string | undefined, agentIdRaw: string): void => {
    const workspaceDir = workspaceDirRaw?.trim();
    if (!workspaceDir) {
      return;
    }
    const agentId = normalizeOptionalLowercaseString(agentIdRaw) || resolveDefaultAgentId(cfg);
    const key = resolveWorkspaceStateIdentity(workspaceDir).workspacePath;
    const existing = byWorkspace.get(key);
    if (existing) {
      if (!existing.agentIds.includes(agentId)) {
        existing.agentIds.push(agentId);
      }
      return;
    }
    byWorkspace.set(key, { workspaceDir, agentIds: [agentId] });
  };

  for (const agentId of agentIds) {
    addWorkspace(resolveAgentWorkspaceDir(cfg, agentId, options.env), agentId);
  }
  const primaryWorkspaceDir = options.primaryWorkspaceDir?.trim();
  if (primaryWorkspaceDir) {
    addWorkspace(primaryWorkspaceDir, options.primaryAgentId ?? resolveDefaultAgentId(cfg));
  }
  return [...byWorkspace.values()];
}
