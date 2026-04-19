import type { GatewayBrowserClient, GatewayHelloOk } from "../gateway.ts";
import { isPluginEnabledInConfigSnapshot } from "../plugin-activation.ts";
import type { ConfigSnapshot } from "../types.ts";

export type DreamingPhaseId = "light" | "deep" | "rem";
const DEFAULT_DREAM_DIARY_PATH = "DREAMS.md";
const DEFAULT_DREAMING_PLUGIN_ID = "memory-core";
const MEMORY_WIKI_PLUGIN_ID = "memory-wiki";

type DreamingPhaseStatusBase = {
  enabled: boolean;
  cron: string;
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

type LightDreamingStatus = DreamingPhaseStatusBase & {
  lookbackDays: number;
  limit: number;
};

type DeepDreamingStatus = DreamingPhaseStatusBase & {
  limit: number;
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays: number;
  maxAgeDays?: number;
};

type RemDreamingStatus = DreamingPhaseStatusBase & {
  lookbackDays: number;
  limit: number;
  minPatternStrength: number;
};

export type DreamingEntry = {
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

export type DreamingStatus = {
  enabled: boolean;
  timezone?: string;
  verboseLogging: boolean;
  storageMode: "inline" | "separate" | "both";
  separateReports: boolean;
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
  storePath?: string;
  phaseSignalPath?: string;
  storeError?: string;
  phaseSignalError?: string;
  shortTermEntries: DreamingEntry[];
  signalEntries: DreamingEntry[];
  promotedEntries: DreamingEntry[];
  phases?: {
    light: LightDreamingStatus;
    deep: DeepDreamingStatus;
    rem: RemDreamingStatus;
  };
};

export type WikiImportInsightItem = {
  pagePath: string;
  title: string;
  riskLevel: "low" | "medium" | "high" | "unknown";
  riskReasons: string[];
  labels: string[];
  topicKey: string;
  topicLabel: string;
  digestStatus: "available" | "withheld";
  activeBranchMessages: number;
  userMessageCount: number;
  assistantMessageCount: number;
  firstUserLine?: string;
  lastUserLine?: string;
  assistantOpener?: string;
  summary: string;
  candidateSignals: string[];
  correctionSignals: string[];
  preferenceSignals: string[];
  createdAt?: string;
  updatedAt?: string;
};

export type WikiImportInsightCluster = {
  key: string;
  label: string;
  itemCount: number;
  highRiskCount: number;
  withheldCount: number;
  preferenceSignalCount: number;
  updatedAt?: string;
  items: WikiImportInsightItem[];
};

export type WikiImportInsights = {
  sourceType: "chatgpt";
  totalItems: number;
  totalClusters: number;
  clusters: WikiImportInsightCluster[];
};

export type WikiMemoryPalaceItem = {
  pagePath: string;
  title: string;
  kind: "entity" | "concept" | "source" | "synthesis" | "report";
  id?: string;
  updatedAt?: string;
  sourceType?: string;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  claims: string[];
  questions: string[];
  contradictions: string[];
  snippet?: string;
};

export type WikiMemoryPalaceCluster = {
  key: WikiMemoryPalaceItem["kind"];
  label: string;
  itemCount: number;
  claimCount: number;
  questionCount: number;
  contradictionCount: number;
  updatedAt?: string;
  items: WikiMemoryPalaceItem[];
};

export type WikiMemoryPalace = {
  totalItems: number;
  totalClaims: number;
  totalQuestions: number;
  totalContradictions: number;
  clusters: WikiMemoryPalaceCluster[];
};

type DoctorMemoryStatusPayload = {
  dreaming?: unknown;
};

type DoctorMemoryDreamDiaryPayload = {
  found?: unknown;
  path?: unknown;
  content?: unknown;
};

type DoctorMemoryDreamActionPayload = {
  action?: unknown;
  removedEntries?: unknown;
  dedupedEntries?: unknown;
  keptEntries?: unknown;
  written?: unknown;
  replaced?: unknown;
  removedShortTermEntries?: unknown;
  changed?: unknown;
  archiveDir?: unknown;
  archivedSessionCorpus?: unknown;
  archivedSessionIngestion?: unknown;
  archivedDreamsDiary?: unknown;
  warnings?: unknown;
};

type WikiImportInsightsPayload = {
  sourceType?: unknown;
  totalItems?: unknown;
  totalClusters?: unknown;
  clusters?: unknown;
};

type WikiMemoryPalacePayload = {
  totalItems?: unknown;
  totalClaims?: unknown;
  totalQuestions?: unknown;
  totalContradictions?: unknown;
  clusters?: unknown;
};

export type DreamingState = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  configSnapshot: ConfigSnapshot | null;
  applySessionKey: string;
  dreamingStatusLoading: boolean;
  dreamingStatusError: string | null;
  dreamingStatus: DreamingStatus | null;
  dreamingModeSaving: boolean;
  dreamDiaryLoading: boolean;
  dreamDiaryActionLoading: boolean;
  dreamDiaryActionMessage: { kind: "success" | "error"; text: string } | null;
  dreamDiaryActionArchivePath: string | null;
  dreamDiaryError: string | null;
  dreamDiaryPath: string | null;
  dreamDiaryContent: string | null;
  wikiImportInsightsLoading: boolean;
  wikiImportInsightsError: string | null;
  wikiImportInsights: WikiImportInsights | null;
  wikiMemoryPalaceLoading: boolean;
  wikiMemoryPalaceError: string | null;
  wikiMemoryPalace: WikiMemoryPalace | null;
  lastError: string | null;
};

function confirmDreamingAction(message: string): boolean {
  if (typeof globalThis.confirm !== "function") {
    return true;
  }
  return globalThis.confirm(message);
}

function isMemoryWikiEnabled(state: DreamingState): boolean {
  return isPluginEnabledInConfigSnapshot(state.configSnapshot, MEMORY_WIKI_PLUGIN_ID, {
    enabledByDefault: false,
  });
}

function hasGatewayMethod(state: DreamingState, method: string): boolean | null {
  const methods = state.hello?.features?.methods;
  if (!Array.isArray(methods)) {
    return null;
  }
  return methods.includes(method);
}

function canCallMemoryWikiMethod(state: DreamingState, method: string): boolean {
  const available = hasGatewayMethod(state, method);
  if (available !== null) {
    return available;
  }
  return isMemoryWikiEnabled(state);
}

function buildDreamDiaryActionSuccessMessage(
  method:
    | "doctor.memory.backfillDreamDiary"
    | "doctor.memory.resetDreamDiary"
    | "doctor.memory.resetGroundedShortTerm"
    | "doctor.memory.repairDreamingArtifacts"
    | "doctor.memory.dedupeDreamDiary",
  payload: DoctorMemoryDreamActionPayload | undefined,
): string {
  switch (method) {
    case "doctor.memory.dedupeDreamDiary": {
      const removed =
        typeof payload?.dedupedEntries === "number"
          ? payload.dedupedEntries
          : typeof payload?.removedEntries === "number"
            ? payload.removedEntries
            : 0;
      const kept = typeof payload?.keptEntries === "number" ? payload.keptEntries : undefined;
      return kept !== undefined
        ? `Removed ${removed} duplicate dream ${removed === 1 ? "entry" : "entries"} and kept ${kept}.`
        : `Removed ${removed} duplicate dream ${removed === 1 ? "entry" : "entries"}.`;
    }
    case "doctor.memory.repairDreamingArtifacts": {
      const actions: string[] = [];
      const archiveDir = normalizeTrimmedString(payload?.archiveDir);
      if (payload?.archivedSessionCorpus === true) {
        actions.push("archived session corpus");
      }
      if (payload?.archivedSessionIngestion === true) {
        actions.push("archived ingestion state");
      }
      if (payload?.archivedDreamsDiary === true) {
        actions.push("archived dream diary");
      }
      if (actions.length === 0) {
        return "Dream cache repair finished with no changes.";
      }
      return archiveDir
        ? `Dream cache repair complete: ${actions.join(", ")}. Archive: ${archiveDir}`
        : `Dream cache repair complete: ${actions.join(", ")}.`;
    }
    case "doctor.memory.backfillDreamDiary":
      return `Backfilled ${typeof payload?.written === "number" ? payload.written : 0} dream diary entries.`;
    case "doctor.memory.resetDreamDiary":
      return `Removed ${typeof payload?.removedEntries === "number" ? payload.removedEntries : 0} backfilled dream diary entries.`;
    case "doctor.memory.resetGroundedShortTerm":
      return `Cleared ${typeof payload?.removedShortTermEntries === "number" ? payload.removedShortTermEntries : 0} replayed short-term entries.`;
  }
  return "Dream diary action complete.";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function normalizeTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeFiniteInt(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function normalizeFiniteScore(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, value));
}

function normalizeStorageMode(value: unknown): DreamingStatus["storageMode"] {
  const normalized = normalizeTrimmedString(value)?.toLowerCase();
  if (normalized === "inline" || normalized === "separate" || normalized === "both") {
    return normalized;
  }
  return "inline";
}

function normalizeNextRun(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizePhaseStatusBase(record: Record<string, unknown> | null): DreamingPhaseStatusBase {
  return {
    enabled: normalizeBoolean(record?.enabled, false),
    cron: normalizeTrimmedString(record?.cron) ?? "",
    managedCronPresent: normalizeBoolean(record?.managedCronPresent, false),
    ...(normalizeNextRun(record?.nextRunAtMs) !== undefined
      ? { nextRunAtMs: normalizeNextRun(record?.nextRunAtMs) }
      : {}),
  };
}

function resolveDreamingPluginId(configValue: Record<string, unknown> | null): string {
  const plugins = asRecord(configValue?.plugins);
  const slots = asRecord(plugins?.slots);
  const configuredSlot = normalizeTrimmedString(slots?.memory);
  if (configuredSlot && configuredSlot.toLowerCase() !== "none") {
    return configuredSlot;
  }
  return DEFAULT_DREAMING_PLUGIN_ID;
}

export function resolveConfiguredDreaming(configValue: Record<string, unknown> | null): {
  pluginId: string;
  enabled: boolean;
} {
  const pluginId = resolveDreamingPluginId(configValue);
  const plugins = asRecord(configValue?.plugins);
  const entries = asRecord(plugins?.entries);
  const pluginEntry = asRecord(entries?.[pluginId]);
  const config = asRecord(pluginEntry?.config);
  const dreaming = asRecord(config?.dreaming);
  return {
    pluginId,
    enabled: normalizeBoolean(dreaming?.enabled, false),
  };
}

function normalizeDreamingEntry(raw: unknown): DreamingEntry | null {
  const record = asRecord(raw);
  const key = normalizeTrimmedString(record?.key);
  const path = normalizeTrimmedString(record?.path);
  const snippet = normalizeTrimmedString(record?.snippet);
  if (!key || !path || !snippet) {
    return null;
  }
  const promotedAt = normalizeTrimmedString(record?.promotedAt);
  const lastRecalledAt = normalizeTrimmedString(record?.lastRecalledAt);
  return {
    key,
    path,
    startLine: Math.max(1, normalizeFiniteInt(record?.startLine, 1)),
    endLine: Math.max(1, normalizeFiniteInt(record?.endLine, 1)),
    snippet,
    recallCount: normalizeFiniteInt(record?.recallCount, 0),
    dailyCount: normalizeFiniteInt(record?.dailyCount, 0),
    groundedCount: normalizeFiniteInt(record?.groundedCount, 0),
    totalSignalCount: normalizeFiniteInt(record?.totalSignalCount, 0),
    lightHits: normalizeFiniteInt(record?.lightHits, 0),
    remHits: normalizeFiniteInt(record?.remHits, 0),
    phaseHitCount: normalizeFiniteInt(record?.phaseHitCount, 0),
    ...(promotedAt ? { promotedAt } : {}),
    ...(lastRecalledAt ? { lastRecalledAt } : {}),
  };
}

function normalizeDreamingEntries(raw: unknown): DreamingEntry[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((entry) => normalizeDreamingEntry(entry))
    .filter((entry): entry is DreamingEntry => entry !== null);
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function normalizeWikiImportInsightItem(raw: unknown): WikiImportInsightItem | null {
  const record = asRecord(raw);
  const pagePath = normalizeTrimmedString(record?.pagePath);
  const title = normalizeTrimmedString(record?.title);
  const riskLevel = normalizeTrimmedString(record?.riskLevel);
  const topicKey = normalizeTrimmedString(record?.topicKey);
  const topicLabel = normalizeTrimmedString(record?.topicLabel);
  const digestStatus = normalizeTrimmedString(record?.digestStatus);
  const summary = normalizeTrimmedString(record?.summary);
  if (
    !pagePath ||
    !title ||
    !topicKey ||
    !topicLabel ||
    !summary ||
    (riskLevel !== "low" &&
      riskLevel !== "medium" &&
      riskLevel !== "high" &&
      riskLevel !== "unknown") ||
    (digestStatus !== "available" && digestStatus !== "withheld")
  ) {
    return null;
  }
  return {
    pagePath,
    title,
    riskLevel,
    riskReasons: normalizeStringArray(record?.riskReasons),
    labels: normalizeStringArray(record?.labels),
    topicKey,
    topicLabel,
    digestStatus,
    activeBranchMessages: normalizeFiniteInt(record?.activeBranchMessages, 0),
    userMessageCount: normalizeFiniteInt(record?.userMessageCount, 0),
    assistantMessageCount: normalizeFiniteInt(record?.assistantMessageCount, 0),
    ...(normalizeTrimmedString(record?.firstUserLine)
      ? { firstUserLine: normalizeTrimmedString(record?.firstUserLine) }
      : {}),
    ...(normalizeTrimmedString(record?.lastUserLine)
      ? { lastUserLine: normalizeTrimmedString(record?.lastUserLine) }
      : {}),
    ...(normalizeTrimmedString(record?.assistantOpener)
      ? { assistantOpener: normalizeTrimmedString(record?.assistantOpener) }
      : {}),
    summary,
    candidateSignals: normalizeStringArray(record?.candidateSignals),
    correctionSignals: normalizeStringArray(record?.correctionSignals),
    preferenceSignals: normalizeStringArray(record?.preferenceSignals),
    ...(normalizeTrimmedString(record?.createdAt)
      ? { createdAt: normalizeTrimmedString(record?.createdAt) }
      : {}),
    ...(normalizeTrimmedString(record?.updatedAt)
      ? { updatedAt: normalizeTrimmedString(record?.updatedAt) }
      : {}),
  };
}

function normalizeWikiImportInsightCluster(raw: unknown): WikiImportInsightCluster | null {
  const record = asRecord(raw);
  const key = normalizeTrimmedString(record?.key);
  const label = normalizeTrimmedString(record?.label);
  if (!key || !label) {
    return null;
  }
  const items = Array.isArray(record?.items)
    ? record.items
        .map((entry) => normalizeWikiImportInsightItem(entry))
        .filter((entry): entry is WikiImportInsightItem => entry !== null)
    : [];
  return {
    key,
    label,
    itemCount: normalizeFiniteInt(record?.itemCount, items.length),
    highRiskCount: normalizeFiniteInt(
      record?.highRiskCount,
      items.filter((entry) => entry.riskLevel === "high").length,
    ),
    withheldCount: normalizeFiniteInt(
      record?.withheldCount,
      items.filter((entry) => entry.digestStatus === "withheld").length,
    ),
    preferenceSignalCount: normalizeFiniteInt(
      record?.preferenceSignalCount,
      items.reduce((sum, entry) => sum + entry.preferenceSignals.length, 0),
    ),
    ...(normalizeTrimmedString(record?.updatedAt)
      ? { updatedAt: normalizeTrimmedString(record?.updatedAt) }
      : {}),
    items,
  };
}

function normalizeWikiImportInsights(raw: unknown): WikiImportInsights {
  const record = asRecord(raw);
  const clusters = Array.isArray(record?.clusters)
    ? record.clusters
        .map((entry) => normalizeWikiImportInsightCluster(entry))
        .filter((entry): entry is WikiImportInsightCluster => entry !== null)
    : [];
  return {
    sourceType: record?.sourceType === "chatgpt" ? "chatgpt" : "chatgpt",
    totalItems: normalizeFiniteInt(
      record?.totalItems,
      clusters.reduce((sum, cluster) => sum + cluster.itemCount, 0),
    ),
    totalClusters: normalizeFiniteInt(record?.totalClusters, clusters.length),
    clusters,
  };
}

function normalizeWikiPageKind(value: unknown): WikiMemoryPalaceItem["kind"] | undefined {
  return value === "entity" ||
    value === "concept" ||
    value === "source" ||
    value === "synthesis" ||
    value === "report"
    ? value
    : undefined;
}

function normalizeWikiMemoryPalaceItem(raw: unknown): WikiMemoryPalaceItem | null {
  const record = asRecord(raw);
  const pagePath = normalizeTrimmedString(record?.pagePath);
  const title = normalizeTrimmedString(record?.title);
  const kind = normalizeWikiPageKind(record?.kind);
  if (!pagePath || !title || !kind) {
    return null;
  }
  return {
    pagePath,
    title,
    kind,
    ...(normalizeTrimmedString(record?.id) ? { id: normalizeTrimmedString(record?.id) } : {}),
    ...(normalizeTrimmedString(record?.updatedAt)
      ? { updatedAt: normalizeTrimmedString(record?.updatedAt) }
      : {}),
    ...(normalizeTrimmedString(record?.sourceType)
      ? { sourceType: normalizeTrimmedString(record?.sourceType) }
      : {}),
    claimCount: normalizeFiniteInt(record?.claimCount, 0),
    questionCount: normalizeFiniteInt(record?.questionCount, 0),
    contradictionCount: normalizeFiniteInt(record?.contradictionCount, 0),
    claims: normalizeStringArray(record?.claims),
    questions: normalizeStringArray(record?.questions),
    contradictions: normalizeStringArray(record?.contradictions),
    ...(normalizeTrimmedString(record?.snippet)
      ? { snippet: normalizeTrimmedString(record?.snippet) }
      : {}),
  };
}

function normalizeWikiMemoryPalaceCluster(raw: unknown): WikiMemoryPalaceCluster | null {
  const record = asRecord(raw);
  const key = normalizeWikiPageKind(record?.key);
  const label = normalizeTrimmedString(record?.label);
  if (!key || !label) {
    return null;
  }
  const items = Array.isArray(record?.items)
    ? record.items
        .map((entry) => normalizeWikiMemoryPalaceItem(entry))
        .filter((entry): entry is WikiMemoryPalaceItem => entry !== null)
    : [];
  return {
    key,
    label,
    itemCount: normalizeFiniteInt(record?.itemCount, items.length),
    claimCount: normalizeFiniteInt(
      record?.claimCount,
      items.reduce((sum, item) => sum + item.claimCount, 0),
    ),
    questionCount: normalizeFiniteInt(
      record?.questionCount,
      items.reduce((sum, item) => sum + item.questionCount, 0),
    ),
    contradictionCount: normalizeFiniteInt(
      record?.contradictionCount,
      items.reduce((sum, item) => sum + item.contradictionCount, 0),
    ),
    ...(normalizeTrimmedString(record?.updatedAt)
      ? { updatedAt: normalizeTrimmedString(record?.updatedAt) }
      : {}),
    items,
  };
}

function normalizeWikiMemoryPalace(raw: unknown): WikiMemoryPalace {
  const record = asRecord(raw);
  const clusters = Array.isArray(record?.clusters)
    ? record.clusters
        .map((entry) => normalizeWikiMemoryPalaceCluster(entry))
        .filter((entry): entry is WikiMemoryPalaceCluster => entry !== null)
    : [];
  return {
    totalItems: normalizeFiniteInt(
      record?.totalItems,
      clusters.reduce((sum, cluster) => sum + cluster.itemCount, 0),
    ),
    totalClaims: normalizeFiniteInt(
      record?.totalClaims,
      clusters.reduce((sum, cluster) => sum + cluster.claimCount, 0),
    ),
    totalQuestions: normalizeFiniteInt(
      record?.totalQuestions,
      clusters.reduce((sum, cluster) => sum + cluster.questionCount, 0),
    ),
    totalContradictions: normalizeFiniteInt(
      record?.totalContradictions,
      clusters.reduce((sum, cluster) => sum + cluster.contradictionCount, 0),
    ),
    clusters,
  };
}

function normalizeDreamingStatus(raw: unknown): DreamingStatus | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const phasesRecord = asRecord(record.phases);
  const lightRecord = asRecord(phasesRecord?.light);
  const deepRecord = asRecord(phasesRecord?.deep);
  const remRecord = asRecord(phasesRecord?.rem);
  const phases =
    lightRecord && deepRecord && remRecord
      ? {
          light: {
            ...normalizePhaseStatusBase(lightRecord),
            lookbackDays: normalizeFiniteInt(lightRecord.lookbackDays, 0),
            limit: normalizeFiniteInt(lightRecord.limit, 0),
          },
          deep: {
            ...normalizePhaseStatusBase(deepRecord),
            limit: normalizeFiniteInt(deepRecord.limit, 0),
            minScore: normalizeFiniteScore(deepRecord.minScore, 0),
            minRecallCount: normalizeFiniteInt(deepRecord.minRecallCount, 0),
            minUniqueQueries: normalizeFiniteInt(deepRecord.minUniqueQueries, 0),
            recencyHalfLifeDays: normalizeFiniteInt(deepRecord.recencyHalfLifeDays, 0),
            ...(typeof deepRecord.maxAgeDays === "number" && Number.isFinite(deepRecord.maxAgeDays)
              ? { maxAgeDays: normalizeFiniteInt(deepRecord.maxAgeDays, 0) }
              : {}),
          },
          rem: {
            ...normalizePhaseStatusBase(remRecord),
            lookbackDays: normalizeFiniteInt(remRecord.lookbackDays, 0),
            limit: normalizeFiniteInt(remRecord.limit, 0),
            minPatternStrength: normalizeFiniteScore(remRecord.minPatternStrength, 0),
          },
        }
      : undefined;
  const timezone = normalizeTrimmedString(record.timezone);
  const storePath = normalizeTrimmedString(record.storePath);
  const phaseSignalPath = normalizeTrimmedString(record.phaseSignalPath);
  const storeError = normalizeTrimmedString(record.storeError);
  const phaseSignalError = normalizeTrimmedString(record.phaseSignalError);

  return {
    enabled: normalizeBoolean(record.enabled, false),
    ...(timezone ? { timezone } : {}),
    verboseLogging: normalizeBoolean(record.verboseLogging, false),
    storageMode: normalizeStorageMode(record.storageMode),
    separateReports: normalizeBoolean(record.separateReports, false),
    shortTermCount: normalizeFiniteInt(record.shortTermCount, 0),
    recallSignalCount: normalizeFiniteInt(record.recallSignalCount, 0),
    dailySignalCount: normalizeFiniteInt(record.dailySignalCount, 0),
    groundedSignalCount: normalizeFiniteInt(record.groundedSignalCount, 0),
    totalSignalCount: normalizeFiniteInt(record.totalSignalCount, 0),
    phaseSignalCount: normalizeFiniteInt(record.phaseSignalCount, 0),
    lightPhaseHitCount: normalizeFiniteInt(record.lightPhaseHitCount, 0),
    remPhaseHitCount: normalizeFiniteInt(record.remPhaseHitCount, 0),
    promotedTotal: normalizeFiniteInt(record.promotedTotal, 0),
    promotedToday: normalizeFiniteInt(record.promotedToday, 0),
    ...(storePath ? { storePath } : {}),
    ...(phaseSignalPath ? { phaseSignalPath } : {}),
    ...(storeError ? { storeError } : {}),
    ...(phaseSignalError ? { phaseSignalError } : {}),
    shortTermEntries: normalizeDreamingEntries(record.shortTermEntries),
    signalEntries: normalizeDreamingEntries(record.signalEntries),
    promotedEntries: normalizeDreamingEntries(record.promotedEntries),
    ...(phases ? { phases } : {}),
  };
}

export async function loadDreamingStatus(state: DreamingState): Promise<void> {
  if (!state.client || !state.connected || state.dreamingStatusLoading) {
    return;
  }
  state.dreamingStatusLoading = true;
  state.dreamingStatusError = null;
  try {
    const payload = await state.client.request<DoctorMemoryStatusPayload>(
      "doctor.memory.status",
      {},
    );
    state.dreamingStatus = normalizeDreamingStatus(payload?.dreaming);
  } catch (err) {
    state.dreamingStatusError = String(err);
  } finally {
    state.dreamingStatusLoading = false;
  }
}

export async function loadDreamDiary(state: DreamingState): Promise<void> {
  if (!state.client || !state.connected || state.dreamDiaryLoading) {
    return;
  }
  state.dreamDiaryLoading = true;
  state.dreamDiaryError = null;
  try {
    const payload = await state.client.request<DoctorMemoryDreamDiaryPayload>(
      "doctor.memory.dreamDiary",
      {},
    );
    const path = normalizeTrimmedString(payload?.path) ?? DEFAULT_DREAM_DIARY_PATH;
    const found = payload?.found === true;
    if (found) {
      state.dreamDiaryPath = path;
      state.dreamDiaryContent = typeof payload?.content === "string" ? payload.content : "";
    } else {
      state.dreamDiaryPath = path;
      state.dreamDiaryContent = null;
    }
  } catch (err) {
    state.dreamDiaryError = String(err);
  } finally {
    state.dreamDiaryLoading = false;
  }
}

export async function loadWikiImportInsights(state: DreamingState): Promise<void> {
  if (!state.client || !state.connected || state.wikiImportInsightsLoading) {
    return;
  }
  if (!canCallMemoryWikiMethod(state, "wiki.importInsights")) {
    state.wikiImportInsights = null;
    state.wikiImportInsightsError = null;
    return;
  }
  state.wikiImportInsightsLoading = true;
  state.wikiImportInsightsError = null;
  try {
    const payload = await state.client.request<WikiImportInsightsPayload>(
      "wiki.importInsights",
      {},
    );
    state.wikiImportInsights = normalizeWikiImportInsights(payload);
  } catch (err) {
    state.wikiImportInsightsError = String(err);
  } finally {
    state.wikiImportInsightsLoading = false;
  }
}

export async function loadWikiMemoryPalace(state: DreamingState): Promise<void> {
  if (!state.client || !state.connected || state.wikiMemoryPalaceLoading) {
    return;
  }
  if (!canCallMemoryWikiMethod(state, "wiki.palace")) {
    state.wikiMemoryPalace = null;
    state.wikiMemoryPalaceError = null;
    return;
  }
  state.wikiMemoryPalaceLoading = true;
  state.wikiMemoryPalaceError = null;
  try {
    const payload = await state.client.request<WikiMemoryPalacePayload>("wiki.palace", {});
    state.wikiMemoryPalace = normalizeWikiMemoryPalace(payload);
  } catch (err) {
    state.wikiMemoryPalaceError = String(err);
  } finally {
    state.wikiMemoryPalaceLoading = false;
  }
}

async function runDreamDiaryAction(
  state: DreamingState,
  method:
    | "doctor.memory.backfillDreamDiary"
    | "doctor.memory.resetDreamDiary"
    | "doctor.memory.resetGroundedShortTerm"
    | "doctor.memory.repairDreamingArtifacts"
    | "doctor.memory.dedupeDreamDiary",
  options?: {
    reloadDiary?: boolean;
  },
): Promise<boolean> {
  if (!state.client || !state.connected || state.dreamDiaryActionLoading) {
    return false;
  }
  if (
    method === "doctor.memory.repairDreamingArtifacts" &&
    !confirmDreamingAction(
      "Repair Dream Cache? This archives derived dream cache files and rebuilds them from clean inputs. Your dream diary stays untouched.",
    )
  ) {
    return false;
  }
  if (
    method === "doctor.memory.dedupeDreamDiary" &&
    !confirmDreamingAction(
      "Dedupe Dream Diary? This rewrites DREAMS.md and removes only exact duplicate diary entries.",
    )
  ) {
    return false;
  }
  state.dreamDiaryActionLoading = true;
  state.dreamingStatusError = null;
  state.dreamDiaryError = null;
  state.dreamDiaryActionMessage = null;
  state.dreamDiaryActionArchivePath = null;
  try {
    const payload = await state.client.request<DoctorMemoryDreamActionPayload>(method, {});
    if (options?.reloadDiary !== false) {
      await loadDreamDiary(state);
    }
    await loadDreamingStatus(state);
    state.dreamDiaryActionArchivePath =
      method === "doctor.memory.repairDreamingArtifacts"
        ? (normalizeTrimmedString(payload?.archiveDir) ?? null)
        : null;
    state.dreamDiaryActionMessage = {
      kind: "success",
      text: buildDreamDiaryActionSuccessMessage(method, payload),
    };
    return true;
  } catch (err) {
    const message = String(err);
    state.dreamingStatusError = message;
    state.lastError = message;
    state.dreamDiaryActionArchivePath = null;
    state.dreamDiaryActionMessage = { kind: "error", text: message };
    return false;
  } finally {
    state.dreamDiaryActionLoading = false;
  }
}

export async function backfillDreamDiary(state: DreamingState): Promise<boolean> {
  return runDreamDiaryAction(state, "doctor.memory.backfillDreamDiary");
}

export async function resetDreamDiary(state: DreamingState): Promise<boolean> {
  return runDreamDiaryAction(state, "doctor.memory.resetDreamDiary");
}

export async function resetGroundedShortTerm(state: DreamingState): Promise<boolean> {
  return runDreamDiaryAction(state, "doctor.memory.resetGroundedShortTerm", {
    reloadDiary: false,
  });
}

export async function repairDreamingArtifacts(state: DreamingState): Promise<boolean> {
  return runDreamDiaryAction(state, "doctor.memory.repairDreamingArtifacts", {
    reloadDiary: false,
  });
}

export async function copyDreamingArchivePath(state: DreamingState): Promise<boolean> {
  const path = state.dreamDiaryActionArchivePath;
  if (!path) {
    return false;
  }
  if (!globalThis.navigator?.clipboard?.writeText) {
    state.dreamDiaryActionMessage = {
      kind: "error",
      text: "Could not copy archive path.",
    };
    return false;
  }
  try {
    await globalThis.navigator.clipboard.writeText(path);
    state.dreamDiaryActionMessage = {
      kind: "success",
      text: "Archive path copied.",
    };
    return true;
  } catch {
    state.dreamDiaryActionMessage = {
      kind: "error",
      text: "Could not copy archive path.",
    };
    return false;
  }
}

export async function dedupeDreamDiary(state: DreamingState): Promise<boolean> {
  return runDreamDiaryAction(state, "doctor.memory.dedupeDreamDiary");
}

async function writeDreamingPatch(
  state: DreamingState,
  patch: Record<string, unknown>,
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return false;
  }
  if (state.dreamingModeSaving) {
    return false;
  }
  const baseHash = state.configSnapshot?.hash;
  if (!baseHash) {
    state.dreamingStatusError = "Config hash missing; refresh and retry.";
    return false;
  }

  state.dreamingModeSaving = true;
  state.dreamingStatusError = null;
  try {
    await state.client.request("config.patch", {
      baseHash,
      raw: JSON.stringify(patch),
      sessionKey: state.applySessionKey,
      note: "Dreaming settings updated from the Dreaming tab.",
    });
    return true;
  } catch (err) {
    const message = String(err);
    state.dreamingStatusError = message;
    state.lastError = message;
    return false;
  } finally {
    state.dreamingModeSaving = false;
  }
}

function lookupIncludesDreamingProperty(value: unknown): boolean {
  const lookup = asRecord(value);
  const children = Array.isArray(lookup?.children) ? lookup.children : [];
  for (const child of children) {
    const childRecord = asRecord(child);
    if (normalizeTrimmedString(childRecord?.key) === "dreaming") {
      return true;
    }
  }
  return false;
}

function lookupDisallowsUnknownProperties(value: unknown): boolean {
  const lookup = asRecord(value);
  const schema = asRecord(lookup?.schema);
  return schema?.additionalProperties === false;
}

async function ensureDreamingPathSupported(
  state: DreamingState,
  pluginId: string,
): Promise<boolean> {
  if (!state.client || !state.connected) {
    return true;
  }
  try {
    const lookup = await state.client.request("config.schema.lookup", {
      path: `plugins.entries.${pluginId}.config`,
    });
    if (lookupIncludesDreamingProperty(lookup)) {
      return true;
    }
    if (lookupDisallowsUnknownProperties(lookup)) {
      const message = `Selected memory plugin "${pluginId}" does not support dreaming settings.`;
      state.dreamingStatusError = message;
      state.lastError = message;
      return false;
    }
  } catch {
    return true;
  }
  return true;
}

export async function updateDreamingEnabled(
  state: DreamingState,
  enabled: boolean,
): Promise<boolean> {
  if (state.dreamingModeSaving) {
    return false;
  }
  if (!state.configSnapshot?.hash) {
    state.dreamingStatusError = "Config hash missing; refresh and retry.";
    return false;
  }
  const { pluginId } = resolveConfiguredDreaming(asRecord(state.configSnapshot?.config) ?? null);
  if (!(await ensureDreamingPathSupported(state, pluginId))) {
    return false;
  }
  const ok = await writeDreamingPatch(state, {
    plugins: {
      entries: {
        [pluginId]: {
          config: {
            dreaming: {
              enabled,
            },
          },
        },
      },
    },
  });
  if (ok && state.dreamingStatus) {
    state.dreamingStatus = {
      ...state.dreamingStatus,
      enabled,
    };
  }
  return ok;
}
