// Doctor gateway methods inspect and repair memory dreaming artifacts and managed cron state.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { parseDateStringTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  resolveMemoryDeepDreamingConfig,
  resolveMemoryLightDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingWorkspaces,
  resolveMemoryRemDreamingConfig,
} from "../../memory-host-sdk/dreaming.js";
import { getActiveMemorySearchManagerCore } from "../../plugins/memory-runtime.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { formatError } from "../server-utils.js";
import {
  dedupeDreamDiaryEntries,
  loadShortTermPromotionDreamingStats,
  previewGroundedRemMarkdown,
  removeBackfillDiaryEntries,
  removeGroundedShortTermCandidates,
  repairDreamingArtifacts,
  writeBackfillDiaryEntries,
} from "./doctor.memory-core-runtime.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";

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
    checked?: boolean;
    cached?: boolean;
    checkedAtMs?: number;
    cacheExpiresAtMs?: number;
  };
  embeddingRuntime?: DoctorMemoryEmbeddingRuntimePayload;
  dreaming?: DoctorMemoryDreamingPayload;
};

export type DoctorMemoryEmbeddingRuntimePayload = {
  engine: "llama.cpp";
  state: "ready" | "failed";
  backend?: "metal" | "cuda" | "vulkan" | "cpu";
  buildType?: "localBuild" | "prebuilt";
  deviceNames?: string[];
  memory?: {
    totalBytes: number;
    usedBytes: number;
    freeBytes: number;
    unifiedBytes: number;
    observedAtMs: number;
  };
  offload?: {
    supported: boolean;
    offloadedLayers?: number;
    totalLayers?: number;
  };
  context?: {
    requestedSize: number | "auto";
  };
  loadError?: string;
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
  const match = filePath.replaceAll("\\", "/").match(/(\d{4}-\d{2}-\d{2})(?:-[^/]+)?\.md$/i);
  return match?.[1] ?? null;
}

function groundedMarkdownToDiaryLines(markdown: string): string[] {
  return markdown
    .split("\n")
    .map((line) => line.replace(/^##\s+/, "").trimEnd())
    .filter(
      (line, index, lines) =>
        line.length > 0 ||
        (index > 0 && expectDefined(lines[index - 1], "lines entry at index 1")?.length > 0),
    );
}

async function listWorkspaceDailyFiles(memoryDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(memoryDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return [];
    }
    throw err;
  }
  return entries
    .filter((name) => /^\d{4}-\d{2}-\d{2}(?:-[^/]+)?\.md$/i.test(name))
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

// Keep malformed persisted timestamps behind valid entries; returning NaN here
// makes Array.sort preserve arbitrary input order and can hide valid diagnostics.
function parseDreamingTimestampMs(value: string | undefined): number {
  return parseDateStringTimestampMs(value) ?? Number.NEGATIVE_INFINITY;
}

function compareDreamingEntryByRecency(
  a: DoctorMemoryDreamingEntryPayload,
  b: DoctorMemoryDreamingEntryPayload,
): number {
  const aMs = parseDreamingTimestampMs(a.lastRecalledAt);
  const bMs = parseDreamingTimestampMs(b.lastRecalledAt);
  if (bMs !== aMs) {
    return bMs > aMs ? 1 : -1;
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
  const aMs = parseDreamingTimestampMs(a.promotedAt);
  const bMs = parseDreamingTimestampMs(b.promotedAt);
  if (bMs !== aMs) {
    return bMs > aMs ? 1 : -1;
  }
  return compareDreamingEntryBySignals(a, b);
}

function trimDreamingEntries(
  entries: DoctorMemoryDreamingEntryPayload[],
  compare: (a: DoctorMemoryDreamingEntryPayload, b: DoctorMemoryDreamingEntryPayload) => number,
): DoctorMemoryDreamingEntryPayload[] {
  const selected: DoctorMemoryDreamingEntryPayload[] = [];
  for (const entry of entries) {
    // Keep the public status payload bounded while preserving the comparator's best entries.
    let insertAt = selected.length;
    for (let index = 0; index < selected.length; index += 1) {
      if (compare(entry, expectDefined(selected[index], "selected entry at index")) < 0) {
        insertAt = index;
        break;
      }
    }
    if (insertAt < DREAMING_ENTRY_LIST_LIMIT) {
      selected.splice(insertAt, 0, entry);
      if (selected.length > DREAMING_ENTRY_LIST_LIMIT) {
        selected.pop();
      }
    } else if (selected.length < DREAMING_ENTRY_LIST_LIMIT) {
      selected.push(entry);
    }
  }
  return selected;
}

async function loadDreamingStoreStats(
  workspaceDir: string,
  nowMs: number,
  timezone?: string,
): Promise<DreamingStoreStats> {
  try {
    return await loadShortTermPromotionDreamingStats({ workspaceDir, nowMs, timezone });
  } catch (err) {
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
  const description = normalizeOptionalString(job.description);
  if (description?.includes(params.tag)) {
    return true;
  }
  // Older managed jobs may lack the tag, so fall back to the exact system-event signature.
  const name = normalizeOptionalString(job.name);
  const payloadKind = normalizeOptionalString(job.payload?.kind)?.toLowerCase();
  const payloadText = normalizeOptionalString(job.payload?.text);
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
      // Ignore redirected diaries; doctor actions only operate on real workspace files.
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

function shouldProbeMemoryEmbeddings(params: unknown): boolean {
  if (!params || typeof params !== "object") {
    return false;
  }
  const record = params as Record<string, unknown>;
  return record.probe === true || record.deep === true;
}

function resolveDoctorMemoryAgent(
  context: GatewayRequestContext,
  params: unknown,
  respond: RespondFn,
): {
  cfg: OpenClawConfig;
  agentId: string;
  requestedAgentId?: string;
} | null {
  const cfg = context.getRuntimeConfig();
  const record = asOptionalRecord(params);
  const rawAgentId = record?.agentId;
  // Validate before resolving workspace or manager state; both paths can create agent storage.
  if (rawAgentId !== undefined && typeof rawAgentId !== "string") {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "agentId must be a string"));
    return null;
  }
  const requestedAgentId =
    typeof rawAgentId === "string" ? normalizeAgentId(rawAgentId) : undefined;
  let agentId = requestedAgentId;
  if (!agentId) {
    try {
      agentId = resolveDefaultAgentId(cfg, {
        surface: "doctor memory",
        hint: "Pass agentId to select a configured agent.",
      });
    } catch (error) {
      if (!(error instanceof AgentSelectionRequiredError)) {
        throw error;
      }
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
      return null;
    }
  }
  if (requestedAgentId && !listAgentIds(cfg).includes(agentId)) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${requestedAgentId}"`),
    );
    return null;
  }
  return { cfg, agentId, ...(requestedAgentId ? { requestedAgentId } : {}) };
}

function resolveDoctorMemoryTarget(
  context: GatewayRequestContext,
  params: unknown,
  respond: RespondFn,
): {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
} | null {
  const resolved = resolveDoctorMemoryAgent(context, params, respond);
  if (!resolved) {
    return null;
  }
  return {
    cfg: resolved.cfg,
    agentId: resolved.agentId,
    workspaceDir: resolveAgentWorkspaceDir(resolved.cfg, resolved.agentId),
  };
}

const SKIPPED_MEMORY_EMBEDDING_PROBE = {
  ok: false,
  checked: false,
  error: "memory embedding readiness not checked; run `openclaw memory status --deep` to probe",
} as const;

export const doctorHandlers: GatewayRequestHandlers = {
  "doctor.memory.status": async ({ respond, context, params }) => {
    const resolved = resolveDoctorMemoryAgent(context, params, respond);
    if (!resolved) {
      return;
    }
    const { cfg, agentId, requestedAgentId } = resolved;
    const { manager, error } = await getActiveMemorySearchManagerCore({
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
      let status = manager.status();
      const shouldProbe = shouldProbeMemoryEmbeddings(params);
      let embedding = shouldProbe
        ? await manager.probeEmbeddingAvailability()
        : (manager.getCachedEmbeddingAvailability?.() ?? SKIPPED_MEMORY_EMBEDDING_PROBE);
      if (shouldProbe) {
        status = manager.status();
      }
      if (!embedding.ok && !embedding.error) {
        embedding = { ok: false, error: "memory embeddings unavailable" };
      }
      const nowMs = Date.now();
      const dreamingConfig = resolveDreamingConfig(cfg);
      const workspaceDir = normalizeOptionalString(
        (status as Record<string, unknown>).workspaceDir,
      );
      const configuredWorkspaces = requestedAgentId
        ? workspaceDir
          ? [workspaceDir]
          : []
        : resolveMemoryDreamingWorkspaces(cfg, {
            primaryWorkspaceDir: workspaceDir,
            primaryAgentId: agentId,
          }).map((entry) => entry.workspaceDir);
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
        embeddingRuntime: (() => {
          const runtime = asOptionalRecord(asOptionalRecord(status.custom)?.llamaCppRuntime);
          return runtime?.engine === "llama.cpp"
            ? (runtime as DoctorMemoryEmbeddingRuntimePayload)
            : undefined;
        })(),
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
  "doctor.memory.dreamDiary": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { agentId, workspaceDir } = target;
    const dreamDiary = await readDreamDiary(workspaceDir);
    const payload: DoctorMemoryDreamDiaryPayload = {
      agentId,
      ...dreamDiary,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.backfillDreamDiary": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { cfg, agentId, workspaceDir } = target;
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
  "doctor.memory.resetDreamDiary": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { agentId, workspaceDir } = target;
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
  "doctor.memory.resetGroundedShortTerm": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { agentId, workspaceDir } = target;
    const removed = await removeGroundedShortTermCandidates({ workspaceDir });
    const payload: DoctorMemoryDreamActionPayload = {
      agentId,
      action: "resetGroundedShortTerm",
      removedShortTermEntries: removed.removed,
    };
    respond(true, payload, undefined);
  },
  "doctor.memory.repairDreamingArtifacts": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { agentId, workspaceDir } = target;
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
  "doctor.memory.dedupeDreamDiary": async ({ respond, context, params }) => {
    const target = resolveDoctorMemoryTarget(context, params, respond);
    if (!target) {
      return;
    }
    const { agentId, workspaceDir } = target;
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
