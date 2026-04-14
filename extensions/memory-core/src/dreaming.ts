import { peekSystemEventEntries } from "openclaw/plugin-sdk/infra-runtime";
import type { OpenClawConfig, OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import {
  DEFAULT_MEMORY_DREAMING_FREQUENCY as DEFAULT_MEMORY_DREAMING_CRON_EXPR,
  DEFAULT_MEMORY_DEEP_DREAMING_LIMIT as DEFAULT_MEMORY_DREAMING_LIMIT,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT as DEFAULT_MEMORY_DREAMING_MIN_RECALL_COUNT,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE as DEFAULT_MEMORY_DREAMING_MIN_SCORE,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES as DEFAULT_MEMORY_DREAMING_MIN_UNIQUE_QUERIES,
  DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS as DEFAULT_MEMORY_DREAMING_RECENCY_HALF_LIFE_DAYS,
  resolveMemoryCorePluginConfig,
  resolveMemoryDeepDreamingConfig,
  resolveMemoryDreamingWorkspaces,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { writeDeepDreamingReport } from "./dreaming-markdown.js";
import { generateAndAppendDreamNarrative, type NarrativePhaseData } from "./dreaming-narrative.js";
import { runDreamingSweepPhases } from "./dreaming-phases.js";
import {
  asRecord,
  formatErrorMessage,
  includesSystemEventToken,
  normalizeTrimmedString,
} from "./dreaming-shared.js";
import {
  applyShortTermPromotions,
  repairShortTermPromotionArtifacts,
  rankShortTermPromotionCandidates,
} from "./short-term-promotion.js";

const MANAGED_DREAMING_CRON_NAME = "Memory Dreaming Promotion";
const MANAGED_DREAMING_CRON_TAG = "[managed-by=memory-core.short-term-promotion]";
const DREAMING_SYSTEM_EVENT_TEXT = "__openclaw_memory_core_short_term_promotion_dream__";
const LEGACY_LIGHT_SLEEP_CRON_NAME = "Memory Light Dreaming";
const LEGACY_LIGHT_SLEEP_CRON_TAG = "[managed-by=memory-core.dreaming.light]";
const LEGACY_LIGHT_SLEEP_EVENT_TEXT = "__openclaw_memory_core_light_sleep__";
const LEGACY_REM_SLEEP_CRON_NAME = "Memory REM Dreaming";
const LEGACY_REM_SLEEP_CRON_TAG = "[managed-by=memory-core.dreaming.rem]";
const LEGACY_REM_SLEEP_EVENT_TEXT = "__openclaw_memory_core_rem_sleep__";
const RUNTIME_CRON_RECONCILE_INTERVAL_MS = 60_000;
const HEARTBEAT_ISOLATED_SESSION_SUFFIX = ":heartbeat";

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;

type CronSchedule = { kind: "cron"; expr: string; tz?: string };
type CronPayload = { kind: "systemEvent"; text: string };
type ManagedCronJobCreate = {
  name: string;
  description: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main";
  wakeMode: "now";
  payload: CronPayload;
};

type ManagedCronJobPatch = {
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  sessionTarget?: "main";
  wakeMode?: "now";
  payload?: CronPayload;
};

type ManagedCronJobLike = {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: {
    kind?: string;
    expr?: string;
    tz?: string;
  };
  sessionTarget?: string;
  wakeMode?: string;
  payload?: {
    kind?: string;
    text?: string;
  };
  createdAtMs?: number;
};

type CronServiceLike = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<ManagedCronJobLike[]>;
  add: (input: ManagedCronJobCreate) => Promise<unknown>;
  update: (id: string, patch: ManagedCronJobPatch) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
};

type StartupCronSourceRefs = {
  context: Record<string, unknown>;
  deps: Record<string, unknown> | null;
};

export type ShortTermPromotionDreamingConfig = {
  enabled: boolean;
  cron: string;
  timezone?: string;
  limit: number;
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays?: number;
  maxAgeDays?: number;
  verboseLogging: boolean;
  storage?: {
    mode: "inline" | "separate" | "both";
    separateReports: boolean;
  };
};

type ReconcileResult =
  | { status: "unavailable"; removed: number }
  | { status: "disabled"; removed: number }
  | { status: "added"; removed: number }
  | { status: "updated"; removed: number }
  | { status: "noop"; removed: number };

type LegacyPhaseMigrationMode = "enabled" | "disabled";

function formatRepairSummary(repair: {
  rewroteStore: boolean;
  removedInvalidEntries: number;
  removedStaleLock: boolean;
}): string {
  const actions: string[] = [];
  if (repair.rewroteStore) {
    actions.push(
      `rewrote recall store${repair.removedInvalidEntries > 0 ? ` (-${repair.removedInvalidEntries} invalid)` : ""}`,
    );
  }
  if (repair.removedStaleLock) {
    actions.push("removed stale promotion lock");
  }
  return actions.join(", ");
}

function resolveManagedCronDescription(config: ShortTermPromotionDreamingConfig): string {
  const recencyHalfLifeDays =
    config.recencyHalfLifeDays ?? DEFAULT_MEMORY_DREAMING_RECENCY_HALF_LIFE_DAYS;
  return `${MANAGED_DREAMING_CRON_TAG} Promote weighted short-term recalls into MEMORY.md (limit=${config.limit}, minScore=${config.minScore.toFixed(3)}, minRecallCount=${config.minRecallCount}, minUniqueQueries=${config.minUniqueQueries}, recencyHalfLifeDays=${recencyHalfLifeDays}, maxAgeDays=${config.maxAgeDays ?? "none"}).`;
}

function buildManagedDreamingCronJob(
  config: ShortTermPromotionDreamingConfig,
): ManagedCronJobCreate {
  return {
    name: MANAGED_DREAMING_CRON_NAME,
    description: resolveManagedCronDescription(config),
    enabled: true,
    schedule: {
      kind: "cron",
      expr: config.cron,
      ...(config.timezone ? { tz: config.timezone } : {}),
    },
    sessionTarget: "main",
    wakeMode: "now",
    payload: {
      kind: "systemEvent",
      text: DREAMING_SYSTEM_EVENT_TEXT,
    },
  };
}

function isManagedDreamingJob(job: ManagedCronJobLike): boolean {
  const description = normalizeTrimmedString(job.description);
  if (description?.includes(MANAGED_DREAMING_CRON_TAG)) {
    return true;
  }
  const name = normalizeTrimmedString(job.name);
  const payloadText = normalizeTrimmedString(job.payload?.text);
  return name === MANAGED_DREAMING_CRON_NAME && payloadText === DREAMING_SYSTEM_EVENT_TEXT;
}

function isLegacyPhaseDreamingJob(job: ManagedCronJobLike): boolean {
  const description = normalizeTrimmedString(job.description);
  if (
    description?.includes(LEGACY_LIGHT_SLEEP_CRON_TAG) ||
    description?.includes(LEGACY_REM_SLEEP_CRON_TAG)
  ) {
    return true;
  }
  const name = normalizeTrimmedString(job.name);
  const payloadText = normalizeTrimmedString(job.payload?.text);
  if (name === LEGACY_LIGHT_SLEEP_CRON_NAME && payloadText === LEGACY_LIGHT_SLEEP_EVENT_TEXT) {
    return true;
  }
  return name === LEGACY_REM_SLEEP_CRON_NAME && payloadText === LEGACY_REM_SLEEP_EVENT_TEXT;
}

function compareOptionalStrings(a: string | undefined, b: string | undefined): boolean {
  return a === b;
}

async function migrateLegacyPhaseDreamingCronJobs(params: {
  cron: CronServiceLike;
  legacyJobs: ManagedCronJobLike[];
  logger: Logger;
  mode: LegacyPhaseMigrationMode;
}): Promise<number> {
  let migrated = 0;
  for (const job of params.legacyJobs) {
    try {
      const result = await params.cron.remove(job.id);
      if (result.removed === true) {
        migrated += 1;
      }
    } catch (err) {
      params.logger.warn(
        `memory-core: failed to migrate legacy phase dreaming cron job ${job.id}: ${formatErrorMessage(err)}`,
      );
    }
  }
  if (migrated > 0) {
    if (params.mode === "enabled") {
      params.logger.info(
        `memory-core: migrated ${migrated} legacy phase dreaming cron job(s) to the unified dreaming controller.`,
      );
    } else {
      params.logger.info(
        `memory-core: completed legacy phase dreaming cron migration while unified dreaming is disabled (${migrated} job(s) removed).`,
      );
    }
  }
  return migrated;
}

function buildManagedDreamingPatch(
  job: ManagedCronJobLike,
  desired: ManagedCronJobCreate,
): ManagedCronJobPatch | null {
  const patch: ManagedCronJobPatch = {};

  if (!compareOptionalStrings(normalizeTrimmedString(job.name), desired.name)) {
    patch.name = desired.name;
  }
  if (!compareOptionalStrings(normalizeTrimmedString(job.description), desired.description)) {
    patch.description = desired.description;
  }
  if (job.enabled !== true) {
    patch.enabled = true;
  }

  const scheduleKind = normalizeLowercaseStringOrEmpty(normalizeTrimmedString(job.schedule?.kind));
  const scheduleExpr = normalizeTrimmedString(job.schedule?.expr);
  const scheduleTz = normalizeTrimmedString(job.schedule?.tz);
  if (
    scheduleKind !== "cron" ||
    !compareOptionalStrings(scheduleExpr, desired.schedule.expr) ||
    !compareOptionalStrings(scheduleTz, desired.schedule.tz)
  ) {
    patch.schedule = desired.schedule;
  }

  const sessionTarget = normalizeLowercaseStringOrEmpty(normalizeTrimmedString(job.sessionTarget));
  if (sessionTarget !== "main") {
    patch.sessionTarget = "main";
  }
  const wakeMode = normalizeLowercaseStringOrEmpty(normalizeTrimmedString(job.wakeMode));
  if (wakeMode !== "now") {
    patch.wakeMode = "now";
  }

  const payloadKind = normalizeLowercaseStringOrEmpty(normalizeTrimmedString(job.payload?.kind));
  const payloadText = normalizeTrimmedString(job.payload?.text);
  if (payloadKind !== "systemevent" || !compareOptionalStrings(payloadText, desired.payload.text)) {
    patch.payload = desired.payload;
  }

  return Object.keys(patch).length > 0 ? patch : null;
}

function sortManagedJobs(managed: ManagedCronJobLike[]): ManagedCronJobLike[] {
  return managed.toSorted((a, b) => {
    const aCreated =
      typeof a.createdAtMs === "number" && Number.isFinite(a.createdAtMs)
        ? a.createdAtMs
        : Number.MAX_SAFE_INTEGER;
    const bCreated =
      typeof b.createdAtMs === "number" && Number.isFinite(b.createdAtMs)
        ? b.createdAtMs
        : Number.MAX_SAFE_INTEGER;
    if (aCreated !== bCreated) {
      return aCreated - bCreated;
    }
    return a.id.localeCompare(b.id);
  });
}

function resolveCronServiceFromCandidate(candidate: unknown): CronServiceLike | null {
  if (!candidate || typeof candidate !== "object") {
    return null;
  }
  const cron = candidate as Partial<CronServiceLike>;
  if (
    typeof cron.list !== "function" ||
    typeof cron.add !== "function" ||
    typeof cron.update !== "function" ||
    typeof cron.remove !== "function"
  ) {
    return null;
  }
  return cron as CronServiceLike;
}

function resolveStartupCronSourceFromEvent(event: unknown): StartupCronSourceRefs | null {
  const payload = asRecord(event);
  if (!payload) {
    return null;
  }
  if (payload.type !== "gateway" || payload.action !== "startup") {
    return null;
  }
  const context = asRecord(payload.context);
  if (!context) {
    return null;
  }
  return { context, deps: asRecord(context.deps) };
}

function resolveCronServiceFromStartupSource(
  source: StartupCronSourceRefs | null,
): CronServiceLike | null {
  if (!source) {
    return null;
  }
  return (
    resolveCronServiceFromCandidate(source.context.cron) ??
    resolveCronServiceFromCandidate(source.deps?.cron)
  );
}

function resolveCronServiceFromStartupEvent(event: unknown): CronServiceLike | null {
  return resolveCronServiceFromStartupSource(resolveStartupCronSourceFromEvent(event));
}

function resolveStartupConfigFromEvent(event: unknown, fallback: OpenClawConfig): OpenClawConfig {
  const startupEvent = asRecord(event);
  const startupContext = asRecord(startupEvent?.context);
  const startupCfg = asRecord(startupContext?.cfg);
  if (!startupCfg) {
    return fallback;
  }
  return startupCfg as OpenClawConfig;
}

function resolveDreamingTriggerSessionKeys(sessionKey?: string): string[] {
  const normalized = normalizeTrimmedString(sessionKey);
  if (!normalized) {
    return [];
  }

  const keys = [normalized];
  // Isolated heartbeat runs execute in a sibling `:heartbeat` session while cron
  // system events stay queued on the base main session.
  if (normalized.endsWith(HEARTBEAT_ISOLATED_SESSION_SUFFIX)) {
    const baseSessionKey = normalized.slice(0, -HEARTBEAT_ISOLATED_SESSION_SUFFIX.length).trim();
    if (baseSessionKey) {
      keys.push(baseSessionKey);
    }
  }

  return Array.from(new Set(keys));
}

function hasPendingManagedDreamingCronEvent(sessionKey?: string): boolean {
  return resolveDreamingTriggerSessionKeys(sessionKey).some((candidateSessionKey) =>
    peekSystemEventEntries(candidateSessionKey).some(
      (event) =>
        event.contextKey?.startsWith("cron:") === true &&
        normalizeTrimmedString(event.text) === DREAMING_SYSTEM_EVENT_TEXT,
    ),
  );
}

export function resolveShortTermPromotionDreamingConfig(params: {
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
}): ShortTermPromotionDreamingConfig {
  const resolved = resolveMemoryDeepDreamingConfig(params);
  return {
    enabled: resolved.enabled,
    cron: resolved.cron,
    ...(resolved.timezone ? { timezone: resolved.timezone } : {}),
    limit: resolved.limit,
    minScore: resolved.minScore,
    minRecallCount: resolved.minRecallCount,
    minUniqueQueries: resolved.minUniqueQueries,
    recencyHalfLifeDays: resolved.recencyHalfLifeDays,
    ...(typeof resolved.maxAgeDays === "number" ? { maxAgeDays: resolved.maxAgeDays } : {}),
    verboseLogging: resolved.verboseLogging,
    storage: resolved.storage,
  };
}

export async function reconcileShortTermDreamingCronJob(params: {
  cron: CronServiceLike | null;
  config: ShortTermPromotionDreamingConfig;
  logger: Logger;
}): Promise<ReconcileResult> {
  const cron = params.cron;
  if (!cron) {
    return { status: "unavailable", removed: 0 };
  }

  const allJobs = await cron.list({ includeDisabled: true });
  const managed = allJobs.filter(isManagedDreamingJob);
  const legacyPhaseJobs = allJobs.filter(isLegacyPhaseDreamingJob);

  if (!params.config.enabled) {
    let removed = await migrateLegacyPhaseDreamingCronJobs({
      cron,
      legacyJobs: legacyPhaseJobs,
      logger: params.logger,
      mode: "disabled",
    });
    for (const job of managed) {
      try {
        const result = await cron.remove(job.id);
        if (result.removed === true) {
          removed += 1;
        }
      } catch (err) {
        params.logger.warn(
          `memory-core: failed to remove managed dreaming cron job ${job.id}: ${formatErrorMessage(err)}`,
        );
      }
    }
    if (removed > 0) {
      params.logger.info(`memory-core: removed ${removed} managed dreaming cron job(s).`);
    }
    return { status: "disabled", removed };
  }

  const desired = buildManagedDreamingCronJob(params.config);
  if (managed.length === 0) {
    await cron.add(desired);
    const migratedLegacy = await migrateLegacyPhaseDreamingCronJobs({
      cron,
      legacyJobs: legacyPhaseJobs,
      logger: params.logger,
      mode: "enabled",
    });
    params.logger.info("memory-core: created managed dreaming cron job.");
    return { status: "added", removed: migratedLegacy };
  }

  const [primary, ...duplicates] = sortManagedJobs(managed);
  let removed = await migrateLegacyPhaseDreamingCronJobs({
    cron,
    legacyJobs: legacyPhaseJobs,
    logger: params.logger,
    mode: "enabled",
  });
  for (const duplicate of duplicates) {
    try {
      const result = await cron.remove(duplicate.id);
      if (result.removed === true) {
        removed += 1;
      }
    } catch (err) {
      params.logger.warn(
        `memory-core: failed to prune duplicate managed dreaming cron job ${duplicate.id}: ${formatErrorMessage(err)}`,
      );
    }
  }

  const patch = buildManagedDreamingPatch(primary, desired);
  if (!patch) {
    if (removed > 0) {
      params.logger.info("memory-core: pruned duplicate managed dreaming cron jobs.");
    }
    return { status: "noop", removed };
  }

  await cron.update(primary.id, patch);
  params.logger.info("memory-core: updated managed dreaming cron job.");
  return { status: "updated", removed };
}

export async function runShortTermDreamingPromotionIfTriggered(params: {
  cleanedBody: string;
  trigger?: string;
  workspaceDir?: string;
  cfg?: OpenClawConfig;
  config: ShortTermPromotionDreamingConfig;
  logger: Logger;
  subagent?: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"];
}): Promise<{ handled: true; reason: string } | undefined> {
  if (params.trigger !== "heartbeat") {
    return undefined;
  }
  if (!includesSystemEventToken(params.cleanedBody, DREAMING_SYSTEM_EVENT_TEXT)) {
    return undefined;
  }
  if (!params.config.enabled) {
    return { handled: true, reason: "memory-core: short-term dreaming disabled" };
  }

  const recencyHalfLifeDays =
    params.config.recencyHalfLifeDays ?? DEFAULT_MEMORY_DREAMING_RECENCY_HALF_LIFE_DAYS;
  const workspaceCandidates = params.cfg
    ? resolveMemoryDreamingWorkspaces(params.cfg).map((entry) => entry.workspaceDir)
    : [];
  const seenWorkspaces = new Set<string>();
  const workspaces = workspaceCandidates.filter((workspaceDir) => {
    if (seenWorkspaces.has(workspaceDir)) {
      return false;
    }
    seenWorkspaces.add(workspaceDir);
    return true;
  });
  const fallbackWorkspaceDir = normalizeTrimmedString(params.workspaceDir);
  if (workspaces.length === 0 && fallbackWorkspaceDir) {
    workspaces.push(fallbackWorkspaceDir);
  }
  if (workspaces.length === 0) {
    params.logger.warn(
      "memory-core: dreaming promotion skipped because no memory workspace is available.",
    );
    return { handled: true, reason: "memory-core: short-term dreaming missing workspace" };
  }
  if (params.config.limit === 0) {
    params.logger.info("memory-core: dreaming promotion skipped because limit=0.");
    return { handled: true, reason: "memory-core: short-term dreaming disabled by limit" };
  }

  if (params.config.verboseLogging) {
    params.logger.info(
      `memory-core: dreaming verbose enabled (cron=${params.config.cron}, limit=${params.config.limit}, minScore=${params.config.minScore.toFixed(3)}, minRecallCount=${params.config.minRecallCount}, minUniqueQueries=${params.config.minUniqueQueries}, recencyHalfLifeDays=${recencyHalfLifeDays}, maxAgeDays=${params.config.maxAgeDays ?? "none"}, workspaces=${workspaces.length}).`,
    );
  }

  let totalCandidates = 0;
  let totalApplied = 0;
  let failedWorkspaces = 0;
  const pluginConfig = params.cfg ? resolveMemoryCorePluginConfig(params.cfg) : undefined;
  for (const workspaceDir of workspaces) {
    try {
      const sweepNowMs = Date.now();
      await runDreamingSweepPhases({
        workspaceDir,
        pluginConfig,
        cfg: params.cfg,
        logger: params.logger,
        subagent: params.subagent,
        nowMs: sweepNowMs,
      });

      const reportLines: string[] = [];
      const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
      if (repair.changed) {
        params.logger.info(
          `memory-core: normalized recall artifacts before dreaming (${formatRepairSummary(repair)}) [workspace=${workspaceDir}].`,
        );
        reportLines.push(`- Repaired recall artifacts: ${formatRepairSummary(repair)}.`);
      }
      const candidates = await rankShortTermPromotionCandidates({
        workspaceDir,
        limit: params.config.limit,
        minScore: params.config.minScore,
        minRecallCount: params.config.minRecallCount,
        minUniqueQueries: params.config.minUniqueQueries,
        recencyHalfLifeDays,
        maxAgeDays: params.config.maxAgeDays,
        nowMs: sweepNowMs,
      });
      totalCandidates += candidates.length;
      reportLines.push(`- Ranked ${candidates.length} candidate(s) for durable promotion.`);
      if (params.config.verboseLogging) {
        const candidateSummary =
          candidates.length > 0
            ? candidates
                .map(
                  (candidate) =>
                    `${candidate.path}:${candidate.startLine}-${candidate.endLine} score=${candidate.score.toFixed(3)} recalls=${candidate.recallCount} queries=${candidate.uniqueQueries} components={freq=${candidate.components.frequency.toFixed(3)},rel=${candidate.components.relevance.toFixed(3)},div=${candidate.components.diversity.toFixed(3)},rec=${candidate.components.recency.toFixed(3)},cons=${candidate.components.consolidation.toFixed(3)},concept=${candidate.components.conceptual.toFixed(3)}}`,
                )
                .join(" | ")
            : "none";
        params.logger.info(
          `memory-core: dreaming candidate details [workspace=${workspaceDir}] ${candidateSummary}`,
        );
      }
      const applied = await applyShortTermPromotions({
        workspaceDir,
        candidates,
        limit: params.config.limit,
        minScore: params.config.minScore,
        minRecallCount: params.config.minRecallCount,
        minUniqueQueries: params.config.minUniqueQueries,
        maxAgeDays: params.config.maxAgeDays,
        timezone: params.config.timezone,
        nowMs: sweepNowMs,
      });
      totalApplied += applied.applied;
      reportLines.push(`- Promoted ${applied.applied} candidate(s) into MEMORY.md.`);
      if (params.config.verboseLogging) {
        const appliedSummary =
          applied.appliedCandidates.length > 0
            ? applied.appliedCandidates
                .map(
                  (candidate) =>
                    `${candidate.path}:${candidate.startLine}-${candidate.endLine} score=${candidate.score.toFixed(3)} recalls=${candidate.recallCount}`,
                )
                .join(" | ")
            : "none";
        params.logger.info(
          `memory-core: dreaming applied details [workspace=${workspaceDir}] ${appliedSummary}`,
        );
      }
      await writeDeepDreamingReport({
        workspaceDir,
        bodyLines: reportLines,
        nowMs: sweepNowMs,
        timezone: params.config.timezone,
        storage: params.config.storage ?? { mode: "inline", separateReports: false },
      });
      // Generate dream diary narrative from promoted memories.
      if (params.subagent && (candidates.length > 0 || applied.applied > 0)) {
        const data: NarrativePhaseData = {
          phase: "deep",
          snippets: candidates.map((c) => c.snippet).filter(Boolean),
          promotions: applied.appliedCandidates.map((c) => c.snippet).filter(Boolean),
        };
        await generateAndAppendDreamNarrative({
          subagent: params.subagent,
          workspaceDir,
          data,
          nowMs: sweepNowMs,
          timezone: params.config.timezone,
          logger: params.logger,
        });
      }
    } catch (err) {
      failedWorkspaces += 1;
      params.logger.error(
        `memory-core: dreaming promotion failed for workspace ${workspaceDir}: ${formatErrorMessage(err)}`,
      );
    }
  }
  params.logger.info(
    `memory-core: dreaming promotion complete (workspaces=${workspaces.length}, candidates=${totalCandidates}, applied=${totalApplied}, failed=${failedWorkspaces}).`,
  );

  return { handled: true, reason: "memory-core: short-term dreaming processed" };
}

export function registerShortTermPromotionDreaming(api: OpenClawPluginApi): void {
  let startupCronSource: StartupCronSourceRefs | null = null;
  let unavailableCronWarningEmitted = false;
  let lastRuntimeReconcileAtMs = 0;
  let lastRuntimeConfigKey: string | null = null;
  let lastRuntimeCronRef: CronServiceLike | null = null;

  const runtimeConfigKey = (config: ShortTermPromotionDreamingConfig): string =>
    [
      config.enabled ? "enabled" : "disabled",
      config.cron,
      config.timezone ?? "",
      String(config.limit),
      String(config.minScore),
      String(config.minRecallCount),
      String(config.minUniqueQueries),
      String(config.recencyHalfLifeDays ?? ""),
      String(config.maxAgeDays ?? ""),
      config.verboseLogging ? "verbose" : "quiet",
      config.storage?.mode ?? "",
      config.storage?.separateReports ? "separate" : "inline",
    ].join("|");

  const reconcileManagedDreamingCron = async (params: {
    reason: "startup" | "runtime";
    startupEvent?: unknown;
  }): Promise<ShortTermPromotionDreamingConfig> => {
    const startupCfg =
      params.reason === "startup" && params.startupEvent !== undefined
        ? resolveStartupConfigFromEvent(params.startupEvent, api.config)
        : api.config;
    const config = resolveShortTermPromotionDreamingConfig({
      pluginConfig:
        resolveMemoryCorePluginConfig(startupCfg) ??
        resolveMemoryCorePluginConfig(api.config) ??
        api.pluginConfig,
      cfg: startupCfg,
    });
    if (params.reason === "startup" && params.startupEvent !== undefined) {
      startupCronSource = resolveStartupCronSourceFromEvent(params.startupEvent);
    }
    const cron = resolveCronServiceFromStartupSource(startupCronSource);
    const configKey = runtimeConfigKey(config);
    if (!cron && config.enabled && !unavailableCronWarningEmitted) {
      api.logger.warn(
        "memory-core: managed dreaming cron could not be reconciled (cron service unavailable).",
      );
      unavailableCronWarningEmitted = true;
    }
    if (cron) {
      unavailableCronWarningEmitted = false;
    }
    if (params.reason === "runtime") {
      const now = Date.now();
      const withinThrottleWindow =
        now - lastRuntimeReconcileAtMs < RUNTIME_CRON_RECONCILE_INTERVAL_MS;
      if (
        withinThrottleWindow &&
        lastRuntimeConfigKey === configKey &&
        lastRuntimeCronRef === cron
      ) {
        return config;
      }
      lastRuntimeReconcileAtMs = now;
      lastRuntimeConfigKey = configKey;
      lastRuntimeCronRef = cron;
    }
    await reconcileShortTermDreamingCronJob({
      cron,
      config,
      logger: api.logger,
    });
    return config;
  };

  api.registerHook(
    "gateway:startup",
    async (event: unknown) => {
      try {
        await reconcileManagedDreamingCron({
          reason: "startup",
          startupEvent: event,
        });
      } catch (err) {
        api.logger.error(
          `memory-core: dreaming startup reconciliation failed: ${formatErrorMessage(err)}`,
        );
      }
    },
    { name: "memory-core-short-term-dreaming-cron" },
  );

  api.on("before_agent_reply", async (event, ctx) => {
    try {
      if (ctx.trigger !== "heartbeat") {
        return undefined;
      }
      const config = await reconcileManagedDreamingCron({
        reason: "runtime",
      });
      if (
        !hasPendingManagedDreamingCronEvent(ctx.sessionKey) ||
        !includesSystemEventToken(event.cleanedBody, DREAMING_SYSTEM_EVENT_TEXT)
      ) {
        return undefined;
      }
      return await runShortTermDreamingPromotionIfTriggered({
        cleanedBody: event.cleanedBody,
        trigger: ctx.trigger,
        workspaceDir: ctx.workspaceDir,
        cfg: api.config,
        config,
        logger: api.logger,
        subagent: config.enabled ? api.runtime?.subagent : undefined,
      });
    } catch (err) {
      api.logger.error(`memory-core: dreaming trigger failed: ${formatErrorMessage(err)}`);
      return undefined;
    }
  });
}

export const __testing = {
  buildManagedDreamingCronJob,
  buildManagedDreamingPatch,
  isManagedDreamingJob,
  resolveCronServiceFromStartupEvent,
  constants: {
    MANAGED_DREAMING_CRON_NAME,
    MANAGED_DREAMING_CRON_TAG,
    DREAMING_SYSTEM_EVENT_TEXT,
    DEFAULT_DREAMING_CRON_EXPR: DEFAULT_MEMORY_DREAMING_CRON_EXPR,
    DEFAULT_DREAMING_LIMIT: DEFAULT_MEMORY_DREAMING_LIMIT,
    DEFAULT_DREAMING_MIN_SCORE: DEFAULT_MEMORY_DREAMING_MIN_SCORE,
    DEFAULT_DREAMING_MIN_RECALL_COUNT: DEFAULT_MEMORY_DREAMING_MIN_RECALL_COUNT,
    DEFAULT_DREAMING_MIN_UNIQUE_QUERIES: DEFAULT_MEMORY_DREAMING_MIN_UNIQUE_QUERIES,
    DEFAULT_DREAMING_RECENCY_HALF_LIFE_DAYS: DEFAULT_MEMORY_DREAMING_RECENCY_HALF_LIFE_DAYS,
  },
};
