import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Memory Core plugin module implements dreaming behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resolveMemoryDreamingPluginConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS as DEFAULT_MEMORY_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  DEFAULT_MEMORY_DEEP_DREAMING_RECENCY_HALF_LIFE_DAYS as DEFAULT_MEMORY_DREAMING_RECENCY_HALF_LIFE_DAYS,
  LEGACY_MEMORY_LIGHT_DREAMING_CRON_NAME as LEGACY_LIGHT_SLEEP_CRON_NAME,
  LEGACY_MEMORY_LIGHT_DREAMING_CRON_TAG as LEGACY_LIGHT_SLEEP_CRON_TAG,
  LEGACY_MEMORY_LIGHT_DREAMING_EVENT_TEXT as LEGACY_LIGHT_SLEEP_EVENT_TEXT,
  LEGACY_MEMORY_REM_DREAMING_CRON_NAME as LEGACY_REM_SLEEP_CRON_NAME,
  LEGACY_MEMORY_REM_DREAMING_CRON_TAG as LEGACY_REM_SLEEP_CRON_TAG,
  LEGACY_MEMORY_REM_DREAMING_EVENT_TEXT as LEGACY_REM_SLEEP_EVENT_TEXT,
  MANAGED_MEMORY_DREAMING_CRON_NAME as MANAGED_DREAMING_CRON_NAME,
  MANAGED_MEMORY_DREAMING_CRON_TAG as MANAGED_DREAMING_CRON_TAG,
  MEMORY_DREAMING_SYSTEM_EVENT_TEXT as DREAMING_SYSTEM_EVENT_TEXT,
  resolveMemoryDeepDreamingConfig,
  resolveMemoryDreamingWorkspaces,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { peekSystemEventEntries } from "openclaw/plugin-sdk/system-event-runtime";
import { appendFailedDreamingEvent } from "./dreaming-events.js";
import type { NarrativePhaseData } from "./dreaming-narrative.js";
import { formatErrorMessage, includesSystemEventToken } from "./dreaming-shared.js";

const RUNTIME_CRON_RECONCILE_INTERVAL_MS = 60_000;
const STARTUP_CRON_RETRY_DELAY_MS = 5_000;
const STARTUP_CRON_RETRY_MAX_ATTEMPTS = 12;
const HEARTBEAT_ISOLATED_SESSION_SUFFIX = ":heartbeat";
const MANAGED_DREAMING_DECLARATION_KEY = "memory-core:memory-dreaming-promotion";

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;

type CronSchedule = { kind: "cron"; expr: string; tz?: string };
type CronPayload =
  | { kind: "systemEvent"; text: string }
  | { kind: "agentTurn"; message: string; lightContext?: boolean };
type ManagedCronJobCreate = {
  declarationKey: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode: "now";
  payload: CronPayload;
  delivery?: {
    mode: "none";
  };
};

type ManagedCronJobPatch = {
  name?: string;
  description?: string;
  enabled?: boolean;
  schedule?: CronSchedule;
  sessionTarget?: "main" | "isolated";
  wakeMode?: "now";
  payload?: CronPayload;
  delivery?: {
    mode: "none";
  };
};

type ManagedCronJobLike = {
  id: string;
  declarationKey?: string;
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
    message?: string;
    lightContext?: boolean;
  };
  delivery?: {
    mode?: string;
  };
  createdAtMs?: number;
};

type CronServiceLike = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<ManagedCronJobLike[]>;
  add: (input: ManagedCronJobCreate) => Promise<unknown>;
  update: (id: string, patch: ManagedCronJobPatch) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
  removeStaleJobFamily: (family: {
    declarationKey: string;
    name: string;
    ownerPluginTag: string;
  }) => Promise<number>;
};

type ShortTermPromotionDreamingConfig = {
  enabled: boolean;
  cron: string;
  timezone?: string;
  limit: number;
  minScore: number;
  minRecallCount: number;
  minUniqueQueries: number;
  recencyHalfLifeDays?: number;
  maxAgeDays?: number;
  maxPromotedSnippetTokens?: number;
  maxPriorEntryLossFraction: number;
  verboseLogging: boolean;
  storage?: {
    mode: "inline" | "separate" | "both";
    separateReports: boolean;
  };
  execution?: {
    model?: string;
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
  removedDanglingEntries?: number;
  removedOverflowEntries?: number;
  removedStaleLock: boolean;
}): string {
  const actions: string[] = [];
  if (repair.rewroteStore) {
    const removedOverflowEntries = repair.removedOverflowEntries ?? 0;
    const details = [
      repair.removedInvalidEntries > 0 ? `-${repair.removedInvalidEntries} invalid` : null,
      (repair.removedDanglingEntries ?? 0) > 0
        ? `-${repair.removedDanglingEntries} dangling`
        : null,
      removedOverflowEntries > 0 ? `-${removedOverflowEntries} overflow` : null,
    ]
      .filter(Boolean)
      .join(", ");
    actions.push(`rewrote recall store${details ? ` (${details})` : ""}`);
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
    declarationKey: MANAGED_DREAMING_DECLARATION_KEY,
    name: MANAGED_DREAMING_CRON_NAME,
    description: resolveManagedCronDescription(config),
    enabled: true,
    schedule: {
      kind: "cron",
      expr: config.cron,
      ...(config.timezone ? { tz: config.timezone } : {}),
    },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: {
      kind: "agentTurn",
      message: DREAMING_SYSTEM_EVENT_TEXT,
      lightContext: true,
    },
    // Dreaming is a maintenance sweep, not a user-facing announce job.
    delivery: {
      mode: "none",
    },
  };
}

function resolveManagedDreamingPayloadToken(
  payload: ManagedCronJobLike["payload"],
): string | undefined {
  const payloadKind = normalizeLowercaseStringOrEmpty(normalizeOptionalString(payload?.kind));
  if (payloadKind === "systemevent") {
    return normalizeOptionalString(payload?.text);
  }
  if (payloadKind === "agentturn") {
    return normalizeOptionalString(payload?.message);
  }
  return undefined;
}

function isManagedDreamingJob(job: ManagedCronJobLike): boolean {
  if (normalizeOptionalString(job.declarationKey) === MANAGED_DREAMING_DECLARATION_KEY) {
    return true;
  }
  const name = normalizeOptionalString(job.name);
  if (name !== MANAGED_DREAMING_CRON_NAME) {
    return false;
  }
  const description = normalizeOptionalString(job.description);
  if (description?.includes(MANAGED_DREAMING_CRON_TAG)) {
    return true;
  }
  return resolveManagedDreamingPayloadToken(job.payload) === DREAMING_SYSTEM_EVENT_TEXT;
}

function isLegacyPhaseDreamingJob(job: ManagedCronJobLike): boolean {
  const description = normalizeOptionalString(job.description);
  if (
    description?.includes(LEGACY_LIGHT_SLEEP_CRON_TAG) ||
    description?.includes(LEGACY_REM_SLEEP_CRON_TAG)
  ) {
    return true;
  }
  const name = normalizeOptionalString(job.name);
  const payloadText = normalizeOptionalString(job.payload?.text);
  if (name === LEGACY_LIGHT_SLEEP_CRON_NAME && payloadText === LEGACY_LIGHT_SLEEP_EVENT_TEXT) {
    return true;
  }
  return name === LEGACY_REM_SLEEP_CRON_NAME && payloadText === LEGACY_REM_SLEEP_EVENT_TEXT;
}

async function removeStaleManagedDreamingRows(cron: CronServiceLike): Promise<number> {
  // Adopt legacy pre-declaration-key jobs copied under obsolete store keys. Leaving one
  // behind means both it and the declared replacement can run, producing duplicate sweeps.
  return (
    (await cron.removeStaleJobFamily({
      declarationKey: MANAGED_DREAMING_DECLARATION_KEY,
      name: MANAGED_DREAMING_CRON_NAME,
      ownerPluginTag: MANAGED_DREAMING_CRON_TAG,
    })) ?? 0
  );
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

  if (!compareOptionalStrings(normalizeOptionalString(job.name), desired.name)) {
    patch.name = desired.name;
  }
  if (!compareOptionalStrings(normalizeOptionalString(job.description), desired.description)) {
    patch.description = desired.description;
  }
  if (job.enabled !== true) {
    patch.enabled = true;
  }

  const scheduleKind = normalizeLowercaseStringOrEmpty(normalizeOptionalString(job.schedule?.kind));
  const scheduleExpr = normalizeOptionalString(job.schedule?.expr);
  const scheduleTz = normalizeOptionalString(job.schedule?.tz);
  if (
    scheduleKind !== "cron" ||
    !compareOptionalStrings(scheduleExpr, desired.schedule.expr) ||
    !compareOptionalStrings(scheduleTz, desired.schedule.tz)
  ) {
    patch.schedule = desired.schedule;
  }

  const sessionTarget = normalizeLowercaseStringOrEmpty(normalizeOptionalString(job.sessionTarget));
  if (sessionTarget !== desired.sessionTarget) {
    patch.sessionTarget = desired.sessionTarget;
  }
  const wakeMode = normalizeLowercaseStringOrEmpty(normalizeOptionalString(job.wakeMode));
  if (wakeMode !== "now") {
    patch.wakeMode = "now";
  }

  const payloadKind = normalizeLowercaseStringOrEmpty(normalizeOptionalString(job.payload?.kind));
  const payloadToken = resolveManagedDreamingPayloadToken(job.payload);
  const desiredPayloadToken =
    desired.payload.kind === "systemEvent" ? desired.payload.text : desired.payload.message;
  const payloadNeedsUpdate =
    payloadKind !== normalizeLowercaseStringOrEmpty(desired.payload.kind) ||
    !compareOptionalStrings(payloadToken, desiredPayloadToken) ||
    (desired.payload.kind === "agentTurn" &&
      job.payload?.lightContext !== desired.payload.lightContext);
  if (payloadNeedsUpdate) {
    patch.payload = desired.payload;
  }
  const deliveryMode = normalizeLowercaseStringOrEmpty(normalizeOptionalString(job.delivery?.mode));
  if (deliveryMode !== "none") {
    patch.delivery = desired.delivery;
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
    typeof cron.remove !== "function" ||
    typeof cron.removeStaleJobFamily !== "function"
  ) {
    return null;
  }
  return cron as CronServiceLike;
}

function resolveCronServiceFromGatewayContext(context: { getCron?: () => unknown } | undefined) {
  return resolveCronServiceFromCandidate(context?.getCron?.());
}

function resolveDreamingTriggerSessionKeys(sessionKey?: string): string[] {
  const normalized = normalizeOptionalString(sessionKey);
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

  return uniqueStrings(keys);
}

function hasPendingManagedDreamingCronEvent(sessionKey?: string): boolean {
  return resolveDreamingTriggerSessionKeys(sessionKey).some((candidateSessionKey) =>
    peekSystemEventEntries(candidateSessionKey).some(
      (event) =>
        event.contextKey?.startsWith("cron:") === true &&
        normalizeOptionalString(event.text) === DREAMING_SYSTEM_EVENT_TEXT,
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
    maxPromotedSnippetTokens:
      resolved.maxPromotedSnippetTokens ?? DEFAULT_MEMORY_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
    maxPriorEntryLossFraction: resolved.maxPriorEntryLossFraction,
    verboseLogging: resolved.verboseLogging,
    storage: resolved.storage,
    ...(resolved.execution.model ? { execution: { model: resolved.execution.model } } : {}),
  };
}

async function reconcileShortTermDreamingCronJob(params: {
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
    removed += await removeStaleManagedDreamingRows(cron);
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
    const removedStale = await removeStaleManagedDreamingRows(cron);
    params.logger.info("memory-core: created managed dreaming cron job.");
    return { status: "added", removed: migratedLegacy + removedStale };
  }

  if (!managed.some((job) => job.declarationKey === MANAGED_DREAMING_DECLARATION_KEY)) {
    await cron.add(desired);
    let removed = await migrateLegacyPhaseDreamingCronJobs({
      cron,
      legacyJobs: legacyPhaseJobs,
      logger: params.logger,
      mode: "enabled",
    });
    for (const job of managed) {
      const result = await cron.remove(job.id);
      if (result.removed !== true) {
        throw new Error(`failed to replace legacy managed dreaming cron job ${job.id}`);
      }
      removed += 1;
    }
    removed += await removeStaleManagedDreamingRows(cron);
    params.logger.info("memory-core: replaced legacy managed dreaming cron job identity.");
    return { status: "added", removed };
  }

  const primary = expectDefined(
    managed.find((job) => job.declarationKey === MANAGED_DREAMING_DECLARATION_KEY),
    "declaration-keyed managed dreaming job",
  );
  const duplicates = sortManagedJobs(managed.filter((job) => job.id !== primary.id));
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
  removed += await removeStaleManagedDreamingRows(cron);

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

async function runShortTermDreamingPromotionIfTriggered(params: {
  cleanedBody: string;
  trigger?: string;
  /** Agent whose heartbeat/cron turn triggered the sweep. */
  agentId?: string;
  workspaceDir?: string;
  cfg?: OpenClawConfig;
  config: ShortTermPromotionDreamingConfig;
  logger: Logger;
  subagent?: OpenClawPluginApi["runtime"]["subagent"];
}): Promise<{ handled: true; reason: string } | undefined> {
  if (params.trigger !== "heartbeat" && params.trigger !== "cron") {
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
  const fallbackWorkspaceDir = normalizeOptionalString(params.workspaceDir);
  // Narrative subagent sessions live in per-agent SQLite stores, so every swept workspace
  // carries its owning agent. The triggering agent owns whatever the roster cannot attribute.
  const triggerAgentId = normalizeLowercaseStringOrEmpty(params.agentId);
  const seenWorkspaces = new Set<string>();
  const workspaces: Array<{ agentId?: string; workspaceDir: string }> = [];
  const addWorkspace = (workspaceDir: string, agentId: string): void => {
    if (!workspaceDir || seenWorkspaces.has(workspaceDir)) {
      return;
    }
    seenWorkspaces.add(workspaceDir);
    workspaces.push({ ...(agentId ? { agentId } : {}), workspaceDir });
  };
  // The triggering agent wins its own workspace; otherwise sort so a workspace shared by
  // several agents always resolves the same owner across sweeps.
  const resolveWorkspaceOwnerAgentId = (agentIds: readonly string[]): string => {
    if (triggerAgentId && agentIds.includes(triggerAgentId)) {
      return triggerAgentId;
    }
    return agentIds.toSorted()[0] ?? triggerAgentId;
  };
  if (params.cfg) {
    for (const entry of resolveMemoryDreamingWorkspaces(params.cfg, {
      primaryWorkspaceDir: fallbackWorkspaceDir,
      // Attribute the hook's own workspace to the agent whose turn triggered the sweep;
      // the host falls back to the roster default agent when the turn has no id.
      ...(triggerAgentId ? { primaryAgentId: triggerAgentId } : {}),
    })) {
      addWorkspace(entry.workspaceDir, resolveWorkspaceOwnerAgentId(entry.agentIds));
    }
  }
  if (workspaces.length === 0 && fallbackWorkspaceDir) {
    addWorkspace(fallbackWorkspaceDir, triggerAgentId);
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
  let degradedNarratives = 0;
  let pendingNarratives = 0;
  const pluginConfig = params.cfg ? resolveMemoryDreamingPluginConfig(params.cfg) : undefined;
  const detachNarratives = params.trigger === "cron";
  const [
    { writeDeepDreamingReport },
    { appendFallbackNarrativeEntry, runDreamNarrative },
    { runDreamingSweepPhases },
    {
      applyShortTermPromotions,
      repairShortTermPromotionArtifacts,
      rankShortTermPromotionCandidates,
    },
  ] = await Promise.all([
    import("./dreaming-markdown.js"),
    import("./dreaming-narrative.js"),
    import("./dreaming-phases.js"),
    import("./short-term-promotion.js"),
  ]);
  for (const { agentId, workspaceDir } of workspaces) {
    const sweepNowMs = Date.now();
    try {
      const phaseResult = await runDreamingSweepPhases({
        agentId,
        workspaceDir,
        pluginConfig,
        cfg: params.cfg,
        logger: params.logger,
        subagent: params.subagent,
        detachNarratives,
        nowMs: sweepNowMs,
      });
      degradedNarratives += phaseResult?.degradedPhases ?? 0;
      pendingNarratives += phaseResult?.pendingNarratives ?? 0;
    } catch (err) {
      failedWorkspaces += 1;
      params.logger.error(
        `memory-core: dreaming sweep failed for workspace ${workspaceDir}: ${formatErrorMessage(err)}`,
      );
      continue;
    }

    try {
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
                    `${candidate.path}:${candidate.startLine}-${candidate.endLine} score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount} queries=${candidate.uniqueQueries} components={freq=${candidate.components.frequency.toFixed(3)},rel=${candidate.components.relevance.toFixed(3)},div=${candidate.components.diversity.toFixed(3)},rec=${candidate.components.recency.toFixed(3)},cons=${candidate.components.consolidation.toFixed(3)},concept=${candidate.components.conceptual.toFixed(3)}}`,
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
        maxPromotedSnippetTokens: params.config.maxPromotedSnippetTokens,
        maxPriorEntryLossFraction: params.config.maxPriorEntryLossFraction,
        consolidation: {
          ...(params.subagent ? { subagent: params.subagent } : {}),
          ...(params.config.execution?.model ? { model: params.config.execution.model } : {}),
          logger: params.logger,
        },
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
                    `${candidate.path}:${candidate.startLine}-${candidate.endLine} score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount}`,
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
        storage: params.config.storage ?? { mode: "separate", separateReports: false },
      });
      // Generate dream diary narrative from promoted memories.
      if (candidates.length > 0 || applied.applied > 0) {
        const data: NarrativePhaseData = {
          phase: "deep",
          snippets: candidates.map((c) => c.snippet).filter(Boolean),
          promotions: applied.appliedCandidates.map((c) => c.snippet).filter(Boolean),
        };
        if (!params.subagent) {
          await appendFallbackNarrativeEntry({
            workspaceDir,
            data,
            nowMs: sweepNowMs,
            timezone: params.config.timezone,
            logger: params.logger,
            reason: "subagent runtime is unavailable",
          });
        } else {
          const narrativeOutcome = await runDreamNarrative({
            agentId,
            subagent: params.subagent,
            workspaceDir,
            data,
            nowMs: sweepNowMs,
            timezone: params.config.timezone,
            model: params.config.execution?.model,
            logger: params.logger,
            detached: detachNarratives,
          });
          if (narrativeOutcome.status === "degraded") {
            degradedNarratives += 1;
          } else if (narrativeOutcome.status === "pending") {
            pendingNarratives += 1;
          }
        }
      }
    } catch (err) {
      failedWorkspaces += 1;
      const error = formatErrorMessage(err);
      params.logger.error(
        `memory-core: dreaming promotion failed for workspace ${workspaceDir}: ${error}`,
      );
      await appendFailedDreamingEvent({
        workspaceDir,
        phase: "deep",
        error,
        storageMode: params.config.storage?.mode ?? "separate",
        nowMs: sweepNowMs,
        logger: params.logger,
      });
    }
  }
  // A summary that reads identically whether the sweep worked or failed everywhere is how
  // a broken pipeline stays unnoticed; escalate when no workspace produced anything.
  const summary = `memory-core: dreaming promotion complete (workspaces=${workspaces.length}, candidates=${totalCandidates}, applied=${totalApplied}, failed=${failedWorkspaces}, degraded=${degradedNarratives}, narrativesPending=${pendingNarratives}).`;
  if (failedWorkspaces === workspaces.length || degradedNarratives > 0) {
    params.logger.warn(summary);
  } else {
    params.logger.info(summary);
  }

  return {
    handled: true,
    reason:
      degradedNarratives > 0
        ? "memory-core: short-term dreaming degraded"
        : "memory-core: short-term dreaming processed",
  };
}

export function registerShortTermPromotionDreaming(api: OpenClawPluginApi): void {
  let resolveStartupCron: (() => CronServiceLike | null) | null = null;
  // Hold a live reference to the gateway context so we can retry cron resolution at runtime.
  // The startup capture may fail if the cron service isn't available yet (race condition in
  // startGatewaySidecars — the startup event fires via setTimeout(250ms) before deps.cron is
  // attached). By keeping the context, we can call getCron() again on later reconciliation
  // attempts when the service is guaranteed to be ready.  Fixes #67362.
  let gatewayContext: { getCron?: () => CronServiceLike | null } | null = null;
  let unavailableCronWarningEmitted = false;
  let lastRuntimeReconcileAtMs = 0;
  let lastRuntimeConfigKey: string | null = null;
  let lastRuntimeCronRef: CronServiceLike | null = null;
  let startupCronRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let startupDreamingCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let runtimeCronReconcileTimer: ReturnType<typeof setInterval> | null = null;
  let startupCronRetryAttempts = 0;
  let gatewayLifecycleGeneration = 0;
  let disposed = false;

  const resolveCurrentConfig = (): OpenClawConfig =>
    (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;

  const clearStartupCronRetry = (): void => {
    if (startupCronRetryTimer) {
      clearTimeout(startupCronRetryTimer);
      startupCronRetryTimer = null;
    }
    startupCronRetryAttempts = 0;
  };

  const hasStartupCron = (): boolean => {
    try {
      return Boolean(resolveStartupCron?.());
    } catch {
      return false;
    }
  };

  const hasCronManagementContext = (): boolean =>
    Boolean(resolveStartupCron || gatewayContext?.getCron);

  const disposeStartupCronRetry = (): void => {
    disposed = true;
    gatewayLifecycleGeneration += 1;
    clearStartupCronRetry();
    if (startupDreamingCleanupTimer) {
      clearTimeout(startupDreamingCleanupTimer);
      startupDreamingCleanupTimer = null;
    }
    if (runtimeCronReconcileTimer) {
      clearInterval(runtimeCronReconcileTimer);
      runtimeCronReconcileTimer = null;
    }
    gatewayContext = null;
    resolveStartupCron = null;
  };

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
    reason: "startup" | "startup_retry" | "runtime";
    startupConfig?: OpenClawConfig;
    startupCron?: (() => CronServiceLike | null) | null;
  }): Promise<ShortTermPromotionDreamingConfig> => {
    const startupCfg =
      params.reason === "startup" ? (params.startupConfig ?? api.config) : resolveCurrentConfig();
    const pluginConfig =
      params.reason === "startup"
        ? (resolveMemoryDreamingPluginConfig(startupCfg) ??
          resolveMemoryDreamingPluginConfig(api.config) ??
          api.pluginConfig)
        : resolveMemoryDreamingPluginConfig(startupCfg);
    const config = resolveShortTermPromotionDreamingConfig({
      pluginConfig,
      cfg: startupCfg,
    });
    if (params.reason === "startup") {
      resolveStartupCron = params.startupCron ?? null;
    }
    let cron = resolveStartupCron?.() ?? null;
    // Runtime fallback: retry resolving the cron service from the gateway context.
    // This handles the case where the cron service was not yet available during
    // gateway_start (250ms deferred init race in startGatewaySidecars) but is
    // available now.  Fixes #67362.
    if (!cron && params.reason !== "startup" && gatewayContext) {
      try {
        cron = resolveCronServiceFromGatewayContext(gatewayContext);
        if (cron) {
          // Refresh the startup capture so subsequent calls resolve immediately.
          resolveStartupCron = () => cron;
        }
      } catch {
        // Ignore — fall through with cron = null
      }
    }
    const configKey = runtimeConfigKey(config);
    if (!cron && config.enabled && !unavailableCronWarningEmitted) {
      // Avoid a noisy startup-path warning when the gateway has not exposed cron yet.
      // The runtime reconciliation path (heartbeat-driven) will still warn if the
      // cron service remains unavailable after boot.
      if (params.reason === "startup" || params.reason === "startup_retry") {
        api.logger.debug?.(
          "memory-core: cron service not yet available at gateway_start; deferring to runtime reconciliation.",
        );
      } else {
        api.logger.warn(
          "memory-core: managed dreaming cron could not be reconciled (cron service unavailable).",
        );
        unavailableCronWarningEmitted = true;
      }
    }
    if (cron) {
      unavailableCronWarningEmitted = false;
      clearStartupCronRetry();
    }
    // Startup retries only probe cron availability; the exhausted retry path
    // re-enters runtime reconciliation so persistent failures still warn once.
    if (!cron && params.reason === "startup_retry") {
      return config;
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

  const scheduleStartupCronRetry = (): void => {
    if (disposed || hasStartupCron()) {
      clearStartupCronRetry();
      return;
    }
    if (startupCronRetryTimer || startupCronRetryAttempts >= STARTUP_CRON_RETRY_MAX_ATTEMPTS) {
      return;
    }
    startupCronRetryTimer = setTimeout(() => {
      startupCronRetryTimer = null;
      if (disposed) {
        return;
      }
      startupCronRetryAttempts += 1;
      void reconcileManagedDreamingCron({ reason: "startup_retry" })
        .then(async () => {
          if (disposed || hasStartupCron()) {
            clearStartupCronRetry();
            return;
          }
          if (startupCronRetryAttempts >= STARTUP_CRON_RETRY_MAX_ATTEMPTS) {
            await reconcileManagedDreamingCron({ reason: "runtime" });
            return;
          }
          scheduleStartupCronRetry();
        })
        .catch((err: unknown) => {
          if (disposed) {
            return;
          }
          api.logger.error(
            `memory-core: deferred dreaming cron retry failed: ${formatErrorMessage(err)}`,
          );
          scheduleStartupCronRetry();
        });
    }, STARTUP_CRON_RETRY_DELAY_MS);
  };

  const startRuntimeCronReconcileTimer = (): void => {
    if (disposed || runtimeCronReconcileTimer) {
      return;
    }
    runtimeCronReconcileTimer = setInterval(() => {
      void reconcileManagedDreamingCron({ reason: "runtime" }).catch((err: unknown) => {
        api.logger.error(`memory-core: dreaming cron reconcile failed: ${formatErrorMessage(err)}`);
      });
    }, RUNTIME_CRON_RECONCILE_INTERVAL_MS);
    runtimeCronReconcileTimer.unref?.();
  };

  const startDreamingSessionCleanup = async (
    config: OpenClawConfig,
    generation: number,
    startupStartedAtMs: number,
  ): Promise<void> => {
    const { DREAMING_ORPHAN_MIN_AGE_MS, scrubDreamingNarrativeArtifacts } =
      await import("./dreaming-session-cleanup.js");
    if (disposed || generation !== gatewayLifecycleGeneration) {
      return;
    }
    const scrubConfiguredAgents = async (
      currentConfig: OpenClawConfig,
      nowMs?: number,
    ): Promise<void> => {
      const agentIds = uniqueStrings(
        resolveMemoryDreamingWorkspaces(currentConfig).flatMap(
          ({ agentIds: workspaceAgentIds }) => workspaceAgentIds,
        ),
      );
      for (const agentId of agentIds) {
        if (disposed || generation !== gatewayLifecycleGeneration) {
          return;
        }
        try {
          await scrubDreamingNarrativeArtifacts({
            agentId,
            config: currentConfig,
            logger: api.logger,
            ...(nowMs === undefined ? {} : { nowMs }),
          });
        } catch (error) {
          api.logger.warn(
            `memory-core: dreaming startup cleanup failed for agent ${agentId}: ${formatErrorMessage(error)}`,
          );
        }
      }
    };

    // Cron reconciliation can itself stall; never classify sessions admitted after startup.
    await scrubConfiguredAgents(config, startupStartedAtMs);
    if (disposed || generation !== gatewayLifecycleGeneration) {
      return;
    }
    // Interrupted runs are initially indistinguishable from live runs; revisit once their
    // persisted activity ages past the same guard used by normal narrative cleanup.
    const cleanupTimer = setTimeout(() => {
      if (
        disposed ||
        generation !== gatewayLifecycleGeneration ||
        startupDreamingCleanupTimer !== cleanupTimer
      ) {
        return;
      }
      startupDreamingCleanupTimer = null;
      // Keep the cutoff strictly before startup: equal-millisecond sessions may have
      // started after the hook and must survive even when this timer runs late.
      void scrubConfiguredAgents(
        resolveCurrentConfig(),
        startupStartedAtMs + DREAMING_ORPHAN_MIN_AGE_MS - 1,
      ).catch((error: unknown) => {
        api.logger.warn(
          `memory-core: deferred dreaming startup cleanup failed: ${formatErrorMessage(error)}`,
        );
      });
    }, DREAMING_ORPHAN_MIN_AGE_MS);
    startupDreamingCleanupTimer = cleanupTimer;
    startupDreamingCleanupTimer.unref?.();
  };

  api.on("gateway_start", async (_event, ctx) => {
    const startupStartedAtMs = Date.now();
    disposed = false;
    if (startupDreamingCleanupTimer) {
      clearTimeout(startupDreamingCleanupTimer);
      startupDreamingCleanupTimer = null;
    }
    const generation = ++gatewayLifecycleGeneration;
    // Store the gateway context for runtime cron resolution retries.
    gatewayContext = ctx as unknown as { getCron?: () => CronServiceLike | null };
    try {
      await reconcileManagedDreamingCron({
        reason: "startup",
        startupConfig: ctx.config,
        startupCron: () => resolveCronServiceFromGatewayContext(ctx),
      });
    } catch (err) {
      api.logger.error(
        `memory-core: dreaming startup reconciliation failed: ${formatErrorMessage(err)}`,
      );
    } finally {
      startRuntimeCronReconcileTimer();
      scheduleStartupCronRetry();
      await startDreamingSessionCleanup(
        ctx.config ?? api.config,
        generation,
        startupStartedAtMs,
      ).catch((error: unknown) => {
        api.logger.warn(
          `memory-core: dreaming startup cleanup failed: ${formatErrorMessage(error)}`,
        );
      });
    }
  });

  api.on("gateway_stop", () => {
    disposeStartupCronRetry();
  });

  api.on(
    "before_agent_reply",
    async (event, ctx) => {
      try {
        if (ctx.trigger !== "heartbeat" && ctx.trigger !== "cron") {
          return undefined;
        }
        const currentConfig = resolveCurrentConfig();
        const hasManagedDreamingToken = includesSystemEventToken(
          event.cleanedBody,
          DREAMING_SYSTEM_EVENT_TEXT,
        );
        const isManagedHeartbeatTrigger =
          ctx.trigger === "heartbeat" && hasPendingManagedDreamingCronEvent(ctx.sessionKey);
        const isManagedCronTrigger = ctx.trigger === "cron";
        const shouldHandleManagedDreaming =
          hasManagedDreamingToken && (isManagedHeartbeatTrigger || isManagedCronTrigger);
        if (!shouldHandleManagedDreaming && !hasCronManagementContext()) {
          return undefined;
        }
        const config = await reconcileManagedDreamingCron({
          reason: "runtime",
        });
        if (!shouldHandleManagedDreaming) {
          return undefined;
        }
        return await runShortTermDreamingPromotionIfTriggered({
          cleanedBody: event.cleanedBody,
          trigger: ctx.trigger,
          agentId: ctx.agentId,
          workspaceDir: ctx.workspaceDir,
          cfg: currentConfig,
          config,
          logger: api.logger,
          subagent: config.enabled ? api.runtime?.subagent : undefined,
        });
      } catch (err) {
        api.logger.error(`memory-core: dreaming trigger failed: ${formatErrorMessage(err)}`);
        return undefined;
      }
    },
    { eligibleTriggers: ["heartbeat", "cron"] },
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
