import fs from "node:fs/promises";
import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isSameMemoryDreamingDay,
  resolveMemoryDeepDreamingConfig,
  resolveMemoryLightDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingWorkspaces,
  resolveMemoryRemDreamingConfig,
} from "../../memory-host-sdk/dreaming.js";
import { getActiveMemorySearchManager } from "../../plugins/memory-runtime.js";
import { formatError } from "../server-utils.js";
import {
  dedupeDreamDiaryEntries,
  removeBackfillDiaryEntries,
  removeGroundedShortTermCandidates,
  previewGroundedRemMarkdown,
  repairDreamingArtifacts,
  writeBackfillDiaryEntries,
} from "./doctor.memory-core-runtime.js";
import { asRecord, normalizeTrimmedString } from "./record-shared.js";
import type { GatewayRequestHandlers } from "./types.js";

const SHORT_TERM_STORE_RELATIVE_PATH = path.join("memory", ".dreams", "short-term-recall.json");
const SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH = path.join("memory", ".dreams", "phase-signals.json");
const MANAGED_DEEP_SLEEP_CRON_NAME = "Memory Dreaming Promotion";
const MANAGED_DEEP_SLEEP_CRON_TAG = "[managed-by=memory-core.short-term-promotion]";
const DEEP_SLEEP_SYSTEM_EVENT_TEXT = "__openclaw_memory_core_short_term_promotion_dream__";
const DREAM_DIARY_FILE_NAMES = ["DREAMS.md", "dreams.md"] as const;

type DoctorMemoryDreamingPhasePayload = {
  enabled: boolean;
  cron: string;
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

type DoctorMemoryLightDreamingPayload = DoctorMemoryDreamingPhasePayload & {
  lookbackDays: number;
  limit: number;
};

type DoctorMemoryDeepDreamingPayload = DoctorMemoryDreamingPhasePayload & {
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays: number;
  maxAgeDays?: number;
  limit: number;
};

type DoctorMemoryRemDreamingPayload = DoctorMemoryDreamingPhasePayload & {
  lookbackDays: number;
  limit: number;
  minPatternStrength: number;
};

type DoctorMemoryDreamingEntryPayload = {
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

type DoctorMemoryDreamingPayload = {
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
  lastPromotedAt?: string;
  storeError?: string;
  phaseSignalError?: string;
  shortTermEntries: DoctorMemoryDreamingEntryPayload[];
  signalEntries: DoctorMemoryDreamingEntryPayload[];
  promotedEntries: DoctorMemoryDreamingEntryPayload[];
  phases: {
    light: DoctorMemoryLightDreamingPayload;
    deep: DoctorMemoryDeepDreamingPayload;
    rem: DoctorMemoryRemDreamingPayload;
  };
};

export type DoctorMemoryStatusPayload = {
  agentId: string;
  provider?: string;
  embedding: {
    ok: boolean;
    error?: string;
  };
  dreaming?: DoctorMemoryDreamingPayload;
};

export type DoctorMemoryDreamDiaryPayload = {
  agentId: string;
  found: boolean;
  path: string;
  content?: string;
  updatedAtMs?: number;
};

export type DoctorMemoryDreamActionPayload = {
  agentId: string;
  action:
    | "backfill"
    | "reset"
    | "resetGroundedShortTerm"
    | "repairDreamingArtifacts"
    | "dedupeDreamDiary";
  path?: string;
  found?: boolean;
  scannedFiles?: number;
  written?: number;
  replaced?: number;
  removedEntries?: number;
  removedShortTermEntries?: number;
  changed?: boolean;
  archiveDir?: string;
  archivedDreamsDiary?: boolean;
  archivedSessionCorpus?: boolean;
  archivedSessionIngestion?: boolean;
  warnings?: string[];
  dedupedEntries?: number;
  keptEntries?: number;
};

function extractIsoDayFromPath(filePath: string): string | null {
  const match = filePath.replaceAll("\\", "/").match(/(\d{4}-\d{2}-\d{2})\.md$/i);
  return match?.[1] ?? null;
}

function groundedMarkdownToDiaryLines(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^##\s+/, "").trimEnd())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1]?.length > 0));
}

async function listWorkspaceDailyFiles(memoryDir: string): Promise<string[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(memoryDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return entries
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/i.test(name))
    .map((name) => path.join(memoryDir, name))
    .toSorted((left, right) => left.localeCompare(right));
}

function resolveDreamingConfig(
  cfg: OpenClawConfig,
): Omit<
  DoctorMemoryDreamingPayload,
  | "shortTermCount"
  | "recallSignalCount"
  | "dailySignalCount"
  | "groundedSignalCount"
  | "totalSignalCount"
  | "phaseSignalCount"
  | "lightPhaseHitCount"
  | "remPhaseHitCount"
  | "promotedTotal"
  | "promotedToday"
  | "storePath"
  | "phaseSignalPath"
  | "lastPromotedAt"
  | "storeError"
  | "phaseSignalError"
> {
  const resolved = resolveMemoryDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
    cfg,
  });
  const light = resolveMemoryLightDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
    cfg,
  });
  const deep = resolveMemoryDeepDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
    cfg,
  });
  const rem = resolveMemoryRemDreamingConfig({
    pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
    cfg,
  });
  return {
    enabled: resolved.enabled,
    ...(resolved.timezone ? { timezone: resolved.timezone } : {}),
    verboseLogging: resolved.verboseLogging,
    storageMode: resolved.storage.mode,
    separateReports: resolved.storage.separateReports,
    shortTermEntries: [],
    signalEntries: [],
    promotedEntries: [],
    phases: {
      light: {
        enabled: light.enabled,
        cron: light.cron,
        lookbackDays: light.lookbackDays,
        limit: light.limit,
        managedCronPresent: false,
      },
      deep: {
        enabled: deep.enabled,
        cron: deep.cron,
        limit: deep.limit,
        minScore: deep.minScore,
        minRecallCount: deep.minRecallCount,
        minUniqueQueries: deep.minUniqueQueries,
        recencyHalfLifeDays: deep.recencyHalfLifeDays,
        managedCronPresent: false,
        ...(typeof deep.maxAgeDays === "number" ? { maxAgeDays: deep.maxAgeDays } : {}),
      },
      rem: {
        enabled: rem.enabled,
        cron: rem.cron,
        lookbackDays: rem.lookbackDays,
        limit: rem.limit,
        minPatternStrength: rem.minPatternStrength,
        managedCronPresent: false,
      },
    },
  };
}

function normalizeMemoryPath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function normalizeMemoryPathForWorkspace(workspaceDir: string, rawPath: string): string {
  const normalized = normalizeMemoryPath(rawPath);
  const workspaceNormalized = normalizeMemoryPath(workspaceDir);
  if (path.isAbsolute(rawPath) && normalized.startsWith(`${workspaceNormalized}/`)) {
    return normalized.slice(workspaceNormalized.length + 1);
  }
  return normalized;
}

function isShortTermMemoryPath(filePath: string): boolean {
  const normalized = normalizeMemoryPath(filePath);
  if (/(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/.test(normalized)) {
    return true;
  }
  if (
    /(?:^|\/)memory\/\.dreams\/session-corpus\/(\d{4})-(\d{2})-(\d{2})\.(?:md|txt)$/.test(
      normalized,
    )
  ) {
    return true;
  }
  return /^(\d{4})-(\d{2})-(\d{2})\.md$/.test(normalized);
}

type DreamingStoreStats = Pick<
  DoctorMemoryDreamingPayload,
  | "shortTermCount"
  | "recallSignalCount"
  | "dailySignalCount"
  | "groundedSignalCount"
  | "totalSignalCount"
  | "phaseSignalCount"
  | "lightPhaseHitCount"
  | "remPhaseHitCount"
  | "promotedTotal"
  | "promotedToday"
  | "storePath"
  | "phaseSignalPath"
  | "lastPromotedAt"
  | "storeError"
  | "phaseSignalError"
  | "shortTermEntries"
  | "signalEntries"
  | "promotedEntries"
>;

const DREAMING_ENTRY_LIST_LIMIT = 8;

function toNonNegativeInt(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.max(0, Math.floor(num));
}

function parseEntryRangeFromKey(
  key: string,
  fallbackStartLine: unknown,
  fallbackEndLine: unknown,
): { startLine: number; endLine: number } {
  const startLine = toNonNegativeInt(fallbackStartLine);
  const endLine = toNonNegativeInt(fallbackEndLine);
  if (startLine > 0 && endLine > 0) {
    return { startLine, endLine };
  }
  const match = key.match(/:(\d+):(\d+)$/);
  if (match) {
    return {
      startLine: Math.max(1, toNonNegativeInt(match[1])),
      endLine: Math.max(1, toNonNegativeInt(match[2])),
    };
  }
  return { startLine: 1, endLine: 1 };
}

function compareDreamingEntryByRecency(
  a: DoctorMemoryDreamingEntryPayload,
  b: DoctorMemoryDreamingEntryPayload,
): number {
  const aMs = a.lastRecalledAt ? Date.parse(a.lastRecalledAt) : Number.NEGATIVE_INFINITY;
  const bMs = b.lastRecalledAt ? Date.parse(b.lastRecalledAt) : Number.NEGATIVE_INFINITY;
  if (Number.isFinite(aMs) || Number.isFinite(bMs)) {
    if (bMs !== aMs) {
      return bMs - aMs;
    }
  }
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  return a.path.localeCompare(b.path);
}

function compareDreamingEntryBySignals(
  a: DoctorMemoryDreamingEntryPayload,
  b: DoctorMemoryDreamingEntryPayload,
): number {
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  if (b.phaseHitCount !== a.phaseHitCount) {
    return b.phaseHitCount - a.phaseHitCount;
  }
  return compareDreamingEntryByRecency(a, b);
}

function compareDreamingEntryByPromotion(
  a: DoctorMemoryDreamingEntryPayload,
  b: DoctorMemoryDreamingEntryPayload,
): number {
  const aMs = a.promotedAt ? Date.parse(a.promotedAt) : Number.NEGATIVE_INFINITY;
  const bMs = b.promotedAt ? Date.parse(b.promotedAt) : Number.NEGATIVE_INFINITY;
  if (Number.isFinite(aMs) || Number.isFinite(bMs)) {
    if (bMs !== aMs) {
      return bMs - aMs;
    }
  }
  return compareDreamingEntryBySignals(a, b);
}

function trimDreamingEntries(
  entries: DoctorMemoryDreamingEntryPayload[],
  compare: (a: DoctorMemoryDreamingEntryPayload, b: DoctorMemoryDreamingEntryPayload) => number,
): DoctorMemoryDreamingEntryPayload[] {
  return entries.toSorted(compare).slice(0, DREAMING_ENTRY_LIST_LIMIT);
}

async function loadDreamingStoreStats(
  workspaceDir: string,
  nowMs: number,
  timezone?: string,
): Promise<DreamingStoreStats> {
  const storePath = path.join(workspaceDir, SHORT_TERM_STORE_RELATIVE_PATH);
  const phaseSignalPath = path.join(workspaceDir, SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH);
  try {
    const raw = await fs.readFile(storePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    const store = asRecord(parsed);
    const entries = asRecord(store?.entries) ?? {};
    let shortTermCount = 0;
    let recallSignalCount = 0;
    let dailySignalCount = 0;
    let groundedSignalCount = 0;
    let totalSignalCount = 0;
    let phaseSignalCount = 0;
    let lightPhaseHitCount = 0;
    let remPhaseHitCount = 0;
    let promotedTotal = 0;
    let promotedToday = 0;
    let latestPromotedAtMs = Number.NEGATIVE_INFINITY;
    let latestPromotedAt: string | undefined;
    const activeKeys = new Set<string>();
    const activeEntries = new Map<string, DoctorMemoryDreamingEntryPayload>();
    const shortTermEntries: DoctorMemoryDreamingEntryPayload[] = [];
    const promotedEntries: DoctorMemoryDreamingEntryPayload[] = [];

    for (const [entryKey, value] of Object.entries(entries)) {
      const entry = asRecord(value);
      if (!entry) {
        continue;
      }
      const source = normalizeTrimmedString(entry.source);
      const entryPath = normalizeTrimmedString(entry.path);
      if (source !== "memory" || !entryPath || !isShortTermMemoryPath(entryPath)) {
        continue;
      }
      const range = parseEntryRangeFromKey(entryKey, entry.startLine, entry.endLine);
      const recallCount = toNonNegativeInt(entry.recallCount);
      const dailyCount = toNonNegativeInt(entry.dailyCount);
      const groundedCount = toNonNegativeInt(entry.groundedCount);
      const totalEntrySignalCount = recallCount + dailyCount + groundedCount;
      const normalizedEntryPath = normalizeMemoryPathForWorkspace(workspaceDir, entryPath);
      const snippet =
        normalizeTrimmedString(entry.snippet) ??
        normalizeTrimmedString(entry.summary) ??
        normalizedEntryPath;
      const lastRecalledAt = normalizeTrimmedString(entry.lastRecalledAt);
      const detail: DoctorMemoryDreamingEntryPayload = {
        key: entryKey,
        path: normalizedEntryPath,
        startLine: range.startLine,
        endLine: Math.max(range.startLine, range.endLine),
        snippet,
        recallCount,
        dailyCount,
        groundedCount,
        totalSignalCount: totalEntrySignalCount,
        lightHits: 0,
        remHits: 0,
        phaseHitCount: 0,
        ...(lastRecalledAt ? { lastRecalledAt } : {}),
      };
      const promotedAt = normalizeTrimmedString(entry.promotedAt);
      if (!promotedAt) {
        shortTermCount += 1;
        activeKeys.add(entryKey);
        recallSignalCount += recallCount;
        dailySignalCount += dailyCount;
        groundedSignalCount += groundedCount;
        totalSignalCount += totalEntrySignalCount;
        shortTermEntries.push(detail);
        activeEntries.set(entryKey, detail);
        continue;
      }
      promotedTotal += 1;
      promotedEntries.push({
        ...detail,
        promotedAt,
      });
      const promotedAtMs = Date.parse(promotedAt);
      if (Number.isFinite(promotedAtMs) && isSameMemoryDreamingDay(promotedAtMs, nowMs, timezone)) {
        promotedToday += 1;
      }
      if (Number.isFinite(promotedAtMs) && promotedAtMs > latestPromotedAtMs) {
        latestPromotedAtMs = promotedAtMs;
        latestPromotedAt = promotedAt;
      }
    }

    let phaseSignalError: string | undefined;
    try {
      const phaseRaw = await fs.readFile(phaseSignalPath, "utf-8");
      const parsedPhase = JSON.parse(phaseRaw) as unknown;
      const phaseStore = asRecord(parsedPhase);
      const phaseEntries = asRecord(phaseStore?.entries) ?? {};
      for (const [key, value] of Object.entries(phaseEntries)) {
        if (!activeKeys.has(key)) {
          continue;
        }
        const phaseEntry = asRecord(value);
        const lightHits = toNonNegativeInt(phaseEntry?.lightHits);
        const remHits = toNonNegativeInt(phaseEntry?.remHits);
        lightPhaseHitCount += lightHits;
        remPhaseHitCount += remHits;
        phaseSignalCount += lightHits + remHits;
        const detail = activeEntries.get(key);
        if (detail) {
          detail.lightHits = lightHits;
          detail.remHits = remHits;
          detail.phaseHitCount = lightHits + remHits;
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "ENOENT") {
        phaseSignalError = formatError(err);
      }
    }

    return {
      shortTermCount,
      recallSignalCount,
      dailySignalCount,
      groundedSignalCount,
      totalSignalCount,
      phaseSignalCount,
      lightPhaseHitCount,
      remPhaseHitCount,
      promotedTotal,
      promotedToday,
      storePath,
      phaseSignalPath,
      shortTermEntries: trimDreamingEntries(shortTermEntries, compareDreamingEntryByRecency),
      signalEntries: trimDreamingEntries(shortTermEntries, compareDreamingEntryBySignals),
      promotedEntries: trimDreamingEntries(promotedEntries, compareDreamingEntryByPromotion),
      ...(latestPromotedAt ? { lastPromotedAt: latestPromotedAt } : {}),
      ...(phaseSignalError ? { phaseSignalError } : {}),
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") {
      return {
        shortTermCount: 0,
        recallSignalCount: 0,
        dailySignalCount: 0,
        groundedSignalCount: 0,
        totalSignalCount: 0,
        phaseSignalCount: 0,
        lightPhaseHitCount: 0,
        remPhaseHitCount: 0,
        promotedTotal: 0,
        promotedToday: 0,
        storePath,
        phaseSignalPath,
        shortTermEntries: [],
        signalEntries: [],
        promotedEntries: [],
      };
    }
    return {
      shortTermCount: 0,
      recallSignalCount: 0,
      dailySignalCount: 0,
      groundedSignalCount: 0,
      totalSignalCount: 0,
      phaseSignalCount: 0,
      lightPhaseHitCount: 0,
      remPhaseHitCount: 0,
      promotedTotal: 0,
      promotedToday: 0,
      storePath,
      phaseSignalPath,
      shortTermEntries: [],
      signalEntries: [],
      promotedEntries: [],
      storeError: formatError(err),
    };
  }
}

function mergeDreamingStoreStats(stats: DreamingStoreStats[]): DreamingStoreStats {
  let shortTermCount = 0;
  let recallSignalCount = 0;
  let dailySignalCount = 0;
  let groundedSignalCount = 0;
  let totalSignalCount = 0;
  let phaseSignalCount = 0;
  let lightPhaseHitCount = 0;
  let remPhaseHitCount = 0;
  let promotedTotal = 0;
  let promotedToday = 0;
  let latestPromotedAtMs = Number.NEGATIVE_INFINITY;
  let lastPromotedAt: string | undefined;
  const storePaths = new Set<string>();
  const phaseSignalPaths = new Set<string>();
  const storeErrors: string[] = [];
  const phaseSignalErrors: string[] = [];
  const shortTermEntries: DoctorMemoryDreamingEntryPayload[] = [];
  const signalEntries: DoctorMemoryDreamingEntryPayload[] = [];
  const promotedEntries: DoctorMemoryDreamingEntryPayload[] = [];

  for (const stat of stats) {
    shortTermCount += stat.shortTermCount;
    recallSignalCount += stat.recallSignalCount;
    dailySignalCount += stat.dailySignalCount;
    groundedSignalCount += stat.groundedSignalCount;
    totalSignalCount += stat.totalSignalCount;
    phaseSignalCount += stat.phaseSignalCount;
    lightPhaseHitCount += stat.lightPhaseHitCount;
    remPhaseHitCount += stat.remPhaseHitCount;
    promotedTotal += stat.promotedTotal;
    promotedToday += stat.promotedToday;
    if (stat.storePath) {
      storePaths.add(stat.storePath);
    }
    if (stat.phaseSignalPath) {
      phaseSignalPaths.add(stat.phaseSignalPath);
    }
    if (stat.storeError) {
      storeErrors.push(stat.storeError);
    }
    if (stat.phaseSignalError) {
      phaseSignalErrors.push(stat.phaseSignalError);
    }
    shortTermEntries.push(...stat.shortTermEntries);
    signalEntries.push(...stat.signalEntries);
    promotedEntries.push(...stat.promotedEntries);
    const promotedAtMs = stat.lastPromotedAt ? Date.parse(stat.lastPromotedAt) : Number.NaN;
    if (Number.isFinite(promotedAtMs) && promotedAtMs > latestPromotedAtMs) {
      latestPromotedAtMs = promotedAtMs;
      lastPromotedAt = stat.lastPromotedAt;
    }
  }

  return {
    shortTermCount,
    recallSignalCount,
    dailySignalCount,
    groundedSignalCount,
    totalSignalCount,
    phaseSignalCount,
    lightPhaseHitCount,
    remPhaseHitCount,
    promotedTotal,
    promotedToday,
    shortTermEntries: trimDreamingEntries(shortTermEntries, compareDreamingEntryByRecency),
    signalEntries: trimDreamingEntries(signalEntries, compareDreamingEntryBySignals),
    promotedEntries: trimDreamingEntries(promotedEntries, compareDreamingEntryByPromotion),
    ...(storePaths.size === 1 ? { storePath: [...storePaths][0] } : {}),
    ...(phaseSignalPaths.size === 1 ? { phaseSignalPath: [...phaseSignalPaths][0] } : {}),
    ...(lastPromotedAt ? { lastPromotedAt } : {}),
    ...(storeErrors.length === 1
      ? { storeError: storeErrors[0] }
      : storeErrors.length > 1
        ? { storeError: `${storeErrors.length} dreaming stores had read errors.` }
        : {}),
    ...(phaseSignalErrors.length === 1
      ? { phaseSignalError: phaseSignalErrors[0] }
      : phaseSignalErrors.length > 1
        ? { phaseSignalError: `${phaseSignalErrors.length} phase signal stores had read errors.` }
        : {}),
  };
}

type ManagedDreamingCronStatus = {
  managedCronPresent: boolean;
  nextRunAtMs?: number;
};

type ManagedCronJobLike = {
  name?: string;
  description?: string;
  enabled?: boolean;
  payload?: { kind?: string; text?: string };
  state?: { nextRunAtMs?: number };
};

function isManagedDreamingJob(
  job: ManagedCronJobLike,
  params: { name: string; tag: string; payloadText: string },
): boolean {
  const description = normalizeTrimmedString(job.description);
  if (description?.includes(params.tag)) {
    return true;
  }
  const name = normalizeTrimmedString(job.name);
  const payloadKind = normalizeTrimmedString(job.payload?.kind)?.toLowerCase();
  const payloadText = normalizeTrimmedString(job.payload?.text);
  return (
    name === params.name && payloadKind === "systemevent" && payloadText === params.payloadText
  );
}

async function resolveManagedDreamingCronStatus(params: {
  context: {
    cron?: { list?: (opts?: { includeDisabled?: boolean }) => Promise<unknown[]> };
  };
  match: {
    name: string;
    tag: string;
    payloadText: string;
  };
}): Promise<ManagedDreamingCronStatus> {
  if (!params.context.cron || typeof params.context.cron.list !== "function") {
    return { managedCronPresent: false };
  }
  try {
    const jobs = await params.context.cron.list({ includeDisabled: true });
    const managed = jobs
      .filter((job): job is ManagedCronJobLike => typeof job === "object" && job !== null)
      .filter((job) => isManagedDreamingJob(job, params.match));
    let nextRunAtMs: number | undefined;
    for (const job of managed) {
      if (job.enabled !== true) {
        continue;
      }
      const candidate = job.state?.nextRunAtMs;
      if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
        continue;
      }
      if (nextRunAtMs === undefined || candidate < nextRunAtMs) {
        nextRunAtMs = candidate;
      }
    }
    return {
      managedCronPresent: managed.length > 0,
      ...(nextRunAtMs !== undefined ? { nextRunAtMs } : {}),
    };
  } catch {
    return { managedCronPresent: false };
  }
}

async function resolveAllManagedDreamingCronStatuses(context: {
  cron?: { list?: (opts?: { includeDisabled?: boolean }) => Promise<unknown[]> };
}): Promise<Record<"light" | "deep" | "rem", ManagedDreamingCronStatus>> {
  const sweepStatus = await resolveManagedDreamingCronStatus({
    context,
    match: {
      name: MANAGED_DEEP_SLEEP_CRON_NAME,
      tag: MANAGED_DEEP_SLEEP_CRON_TAG,
      payloadText: DEEP_SLEEP_SYSTEM_EVENT_TEXT,
    },
  });
  return {
    light: sweepStatus,
    deep: sweepStatus,
    rem: sweepStatus,
  };
}

async function readDreamDiary(
  workspaceDir: string,
): Promise<Omit<DoctorMemoryDreamDiaryPayload, "agentId">> {
  for (const name of DREAM_DIARY_FILE_NAMES) {
    const filePath = path.join(workspaceDir, name);
    let stat;
    try {
      stat = await fs.lstat(filePath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        continue;
      }
      return {
        found: false,
        path: name,
      };
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      continue;
    }
    try {
      const content = await fs.readFile(filePath, "utf-8");
      return {
        found: true,
        path: name,
        content,
        updatedAtMs: Math.floor(stat.mtimeMs),
      };
    } catch {
      return {
        found: false,
        path: name,
      };
    }
  }
  return {
    found: false,
    path: DREAM_DIARY_FILE_NAMES[0],
  };
}

export const doctorHandlers: GatewayRequestHandlers = {
  "doctor.memory.status": async ({ respond, context }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const { manager, error } = await getActiveMemorySearchManager({
      cfg,
      agentId,
      purpose: "status",
    });
    if (!manager) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: error ?? "memory search unavailable",
        },
      };
      respond(true, payload, undefined);
      return;
    }

    try {
      const status = manager.status();
      let embedding = await manager.probeEmbeddingAvailability();
      if (!embedding.ok && !embedding.error) {
        embedding = { ok: false, error: "memory embeddings unavailable" };
      }
      const nowMs = Date.now();
      const dreamingConfig = resolveDreamingConfig(cfg);
      const workspaceDir = normalizeTrimmedString((status as Record<string, unknown>).workspaceDir);
      const configuredWorkspaces = resolveMemoryDreamingWorkspaces(cfg).map(
        (entry) => entry.workspaceDir,
      );
      const allWorkspaces =
        configuredWorkspaces.length > 0 ? configuredWorkspaces : workspaceDir ? [workspaceDir] : [];
      const storeStats =
        allWorkspaces.length > 0
          ? mergeDreamingStoreStats(
              await Promise.all(
                allWorkspaces.map((entry) =>
                  loadDreamingStoreStats(entry, nowMs, dreamingConfig.timezone),
                ),
              ),
            )
          : {
              shortTermCount: 0,
              recallSignalCount: 0,
              dailySignalCount: 0,
              groundedSignalCount: 0,
              totalSignalCount: 0,
              phaseSignalCount: 0,
              lightPhaseHitCount: 0,
              remPhaseHitCount: 0,
              promotedTotal: 0,
              promotedToday: 0,
            };
      const cronStatuses = await resolveAllManagedDreamingCronStatuses(context);
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        provider: status.provider,
        embedding,
        dreaming: {
          ...dreamingConfig,
          ...storeStats,
          phases: {
            light: {
              ...dreamingConfig.phases.light,
              ...cronStatuses.light,
            },
            deep: {
              ...dreamingConfig.phases.deep,
              ...cronStatuses.deep,
            },
            rem: {
              ...dreamingConfig.phases.rem,
              ...cronStatuses.rem,
            },
          },
        },
      };
      respond(true, payload, undefined);
    } catch (err) {
      const payload: DoctorMemoryStatusPayload = {
        agentId,
        embedding: {
          ok: false,
          error: `gateway memory probe failed: ${formatError(err)}`,
        },
      };
      respond(true, payload, undefined);
    } finally {
      await manager.close?.().catch(() => {});
    }
  },
  "doctor.memory.dreamDiary": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const dreamDiary = await readDreamDiary(workspaceDir);
    const payload: DoctorMemoryDreamDiaryPayload = {
      agentId,
      ...dreamDiary,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.backfillDreamDiary": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const memoryDir = path.join(workspaceDir, "memory");
    const sourceFiles = await listWorkspaceDailyFiles(memoryDir);
    if (sourceFiles.length === 0) {
      const dreamDiary = await readDreamDiary(workspaceDir);
      const payload: DoctorMemoryDreamActionPayload = {
        agentId,
        path: dreamDiary.path,
        action: "backfill",
        found: dreamDiary.found,
        scannedFiles: 0,
        written: 0,
        replaced: 0,
      };
      respond(true, payload, undefined);
      return;
    }
    const grounded = await previewGroundedRemMarkdown({
      workspaceDir,
      inputPaths: sourceFiles,
    });
    const remConfig = resolveMemoryRemDreamingConfig({
      pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
      cfg,
    });
    const entries = grounded.files
      .map((file) => {
        const isoDay = extractIsoDayFromPath(file.path);
        if (!isoDay) {
          return null;
        }
        return {
          isoDay,
          sourcePath: file.path,
          bodyLines: groundedMarkdownToDiaryLines(file.renderedMarkdown),
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    const written = await writeBackfillDiaryEntries({
      workspaceDir,
      entries,
      timezone: remConfig.timezone,
    });
    const dreamDiary = await readDreamDiary(workspaceDir);
    const payload: DoctorMemoryDreamActionPayload = {
      agentId,
      path: dreamDiary.path,
      action: "backfill",
      found: dreamDiary.found,
      scannedFiles: grounded.scannedFiles,
      written: written.written,
      replaced: written.replaced,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.resetDreamDiary": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const removed = await removeBackfillDiaryEntries({ workspaceDir });
    const dreamDiary = await readDreamDiary(workspaceDir);
    const payload: DoctorMemoryDreamActionPayload = {
      agentId,
      path: dreamDiary.path,
      action: "reset",
      found: dreamDiary.found,
      removedEntries: removed.removed,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.resetGroundedShortTerm": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const removed = await removeGroundedShortTermCandidates({ workspaceDir });
    const payload: DoctorMemoryDreamActionPayload = {
      agentId,
      action: "resetGroundedShortTerm",
      removedShortTermEntries: removed.removed,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.repairDreamingArtifacts": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const repair = await repairDreamingArtifacts({ workspaceDir });
    const payload: DoctorMemoryDreamActionPayload = {
      agentId,
      action: "repairDreamingArtifacts",
      changed: repair.changed,
      archiveDir: repair.archiveDir,
      archivedDreamsDiary: repair.archivedDreamsDiary,
      archivedSessionCorpus: repair.archivedSessionCorpus,
      archivedSessionIngestion: repair.archivedSessionIngestion,
      warnings: repair.warnings,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.dedupeDreamDiary": async ({ respond }) => {
    const cfg = loadConfig();
    const agentId = resolveDefaultAgentId(cfg);
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const dedupe = await dedupeDreamDiaryEntries({ workspaceDir });
    const dreamDiary = await readDreamDiary(workspaceDir);
    const payload: DoctorMemoryDreamActionPayload = {
      agentId,
      action: "dedupeDreamDiary",
      path: dreamDiary.path,
      found: dreamDiary.found,
      removedEntries: dedupe.removed,
      dedupedEntries: dedupe.removed,
      keptEntries: dedupe.kept,
    };
    respond(true, payload, undefined);
  },
};
