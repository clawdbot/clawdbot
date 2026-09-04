import { isDeepStrictEqual } from "node:util";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
} from "../../agents/agent-lifecycle-registry.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import {
  type CronActiveJobMarker,
  isCronJobActive,
  noteActiveCronJobRemoval,
  noteActiveCronJobScheduleMutation,
  noteActiveCronJobTriggerMutation,
  onCronJobInactive,
  requestActiveCronJobCancellation,
} from "../active-jobs.js";
import { resolveCronJobConfigRevision } from "../config-revision.js";
import { cronSchedulingInputsEqual } from "../schedule-identity.js";
import { removeCronJobBaseSession } from "../session-reaper.js";
import { removeStaleCronJobFamilyRows } from "../store.js";
import { createCronStreamSourceIdentity, cronStreamScheduleKey } from "../stream-schedule.js";
import { systemOwnedDeclarationKeyNamespace } from "../system-owned-declaration.js";
import { normalizeCronTaskRunJobId } from "../task-run-history.js";
import {
  isSystemOwnedCronPayloadKind,
  type CronJob,
  type CronJobCreate,
  type CronJobPatch,
  type CronStoredJob,
} from "../types.js";
import {
  computeJobNextRunAtMs,
  findJobOrThrow,
  hasScheduledNextRunAtMs,
  isJobEnabled,
  nextWakeAtMs,
  recomputeNextRunsForMaintenance,
} from "./jobs-scheduling.js";
import { reconcileRuntimeAuthority } from "./jobs-tool-policy.js";
import { cronPatchTouchesDeliveryResolution } from "./jobs-validation.js";
import { applyJobPatch, applyDeclarativeJobSpec, createJob } from "./jobs.js";
import {
  getPendingCronSessionCleanup,
  locked,
  registerPendingCronSessionCleanup,
} from "./locked.js";
import { normalizeOptionalAgentId } from "./normalize.js";
import { resolveCurrentDefaultAgentId, resolveEffectiveJobAgentId } from "./ops-shared.js";
import { cronRunReceiptOwnerMutationHooks } from "./run-receipts.js";
import type {
  CronAddResult,
  CronAddOptions,
  CronServiceState,
  CronUpdateOptions,
  CronUpdatePrecondition,
  DeferredCronNotifications,
} from "./state.js";
import { emit } from "./state.js";
import {
  ensureLoaded,
  ensureLoadedForOperation,
  persist,
  persistOrRestore,
  pruneCronJobScratchAfterCommit,
  runPostPersistCronNotifications,
  snapshotStoreForRollback,
  type CronRollbackSnapshot,
  warnIfDisabled,
} from "./store.js";
import { armTimer } from "./timer.js";

const RETRY_ADD_AFTER_SESSION_CLEANUP = new Error("retry add after session cleanup");

async function resolveConfiguredChannelsForValidation(
  state: CronServiceState,
): Promise<readonly string[] | undefined> {
  if (!state.deps.listConfiguredChannels) {
    return undefined;
  }
  try {
    return await state.deps.listConfiguredChannels();
  } catch {
    // Channel discovery is advisory at mutation time. Runtime delivery remains
    // authoritative, so discovery failures must not create false rejections.
    state.deps.log.debug({}, "cron: configured channel validation skipped");
    return undefined;
  }
}

function reconcileStreamSourceIdentity(job: CronJob, nextJob: CronJob): void {
  if (nextJob.schedule.kind !== "stream") {
    nextJob.state.streamSourceIdentity = undefined;
    return;
  }
  const sourceChanged =
    job.schedule.kind !== "stream" ||
    cronStreamScheduleKey(job.schedule) !== cronStreamScheduleKey(nextJob.schedule) ||
    isJobEnabled(job) !== isJobEnabled(nextJob);
  const currentIdentity =
    job.schedule.kind === "stream" ? job.state.streamSourceIdentity : undefined;
  nextJob.state.streamSourceIdentity =
    sourceChanged || !currentIdentity ? createCronStreamSourceIdentity() : currentIdentity;
}

function finalizeUpdatedJob(params: {
  job: CronJob;
  nextJob: CronJob;
  now: number;
  schedulingInputsRequested: boolean;
  scheduleChanged: boolean;
  explicitTriggerState?: CronJobPatch["state"];
}) {
  const { job, nextJob, now } = params;
  if (nextJob.schedule.kind === "every") {
    const anchor = nextJob.schedule.anchorMs;
    if (typeof anchor !== "number" || !Number.isFinite(anchor)) {
      // Inherit the previous cadence anchor only for an unchanged-interval
      // re-save (UIs resubmit the schedule without the internal anchorMs).
      // Without this an idempotent edit re-phases the job to now, shifting
      // every future fire time and skipping an already-due slot. A genuine
      // interval change still anchors to the edit time so the new cadence
      // starts now, matching the prior update semantics.
      const previousAnchorMs =
        job.schedule.kind === "every" &&
        job.schedule.everyMs === nextJob.schedule.everyMs &&
        typeof job.schedule.anchorMs === "number" &&
        Number.isFinite(job.schedule.anchorMs)
          ? job.schedule.anchorMs
          : undefined;
      const fallbackAnchorMs =
        previousAnchorMs ??
        (params.scheduleChanged
          ? now
          : typeof nextJob.createdAtMs === "number" && Number.isFinite(nextJob.createdAtMs)
            ? nextJob.createdAtMs
            : now);
      nextJob.schedule = {
        ...nextJob.schedule,
        anchorMs: Math.max(0, Math.floor(fallbackAnchorMs)),
      };
    }
  }
  // Source identity belongs to the durable job mutation, not the process
  // watcher. Equivalent resaves preserve it; disable/enable and source changes
  // rotate it in the same write that changes the public job definition.
  reconcileStreamSourceIdentity(job, nextJob);

  const previousScript = job.payload.kind === "script" ? job.payload.script : undefined;
  const nextScript = nextJob.payload.kind === "script" ? nextJob.payload.script : undefined;
  if (!isDeepStrictEqual(job.trigger, nextJob.trigger) || previousScript !== nextScript) {
    // Trigger and payload scripts share one durable state slot. Exact persisted
    // definitions own it, matching in-flight ownership; explicit replacements win.
    for (const field of [
      "triggerState",
      "triggerEvalCount",
      "lastTriggerEvalAtMs",
      "lastTriggerFireAtMs",
    ] as const) {
      if (params.explicitTriggerState && Object.hasOwn(params.explicitTriggerState, field)) {
        Object.assign(nextJob.state, { [field]: params.explicitTriggerState[field] });
      } else {
        delete nextJob.state[field];
      }
    }
  }

  // Only advance a recurring job's next run when the schedule/enabled inputs
  // actually changed. An idempotent re-save (same schedule, or re-enabling an
  // already-enabled job) must preserve a still-due slot, matching the
  // add/remove maintenance recompute; otherwise the pending run is dropped.
  const schedulingInputsChanged =
    params.schedulingInputsRequested && !cronSchedulingInputsEqual(job, nextJob);

  if (params.scheduleChanged && nextJob.schedule.kind === "cron" && !isJobEnabled(nextJob)) {
    computeJobNextRunAtMs({ ...nextJob, enabled: true }, now);
  }

  nextJob.updatedAtMs = now;
  if (schedulingInputsChanged) {
    // Anchor restart catch-up to the new inputs. Without this, startup replays a
    // slot the previous schedule never had, because lastRunAtMs still belongs to
    // the old one and looks perpetually stale against the new slots (#91944).
    nextJob.state.scheduleActivatedAtMs = now;
    nextJob.state.startupCatchupAtMs = undefined;
    // A paced timestamp is owned by the exact schedule, pacing bounds, and
    // trigger mode that produced it. Configuration changes release both the
    // slot and its provenance so natural schedule math can take ownership.
    nextJob.state.pacedNextRunAtMs = undefined;
    nextJob.state.forcePreservedNextRunAtMs = undefined;
    if (isJobEnabled(nextJob)) {
      nextJob.state.nextRunAtMs = computeJobNextRunAtMs(nextJob, now);
    } else {
      nextJob.state.nextRunAtMs = undefined;
      nextJob.state.queuedAtMs = undefined;
      // Preserve only genuine execution. Queued reservations must clear so a
      // disabled job can accept a later force run with the same timestamp.
      if (!isCronJobActive(nextJob.id)) {
        nextJob.state.runningAtMs = undefined;
      }
    }
  } else if (isJobEnabled(nextJob) && !hasScheduledNextRunAtMs(nextJob.state.nextRunAtMs)) {
    nextJob.state.nextRunAtMs = computeJobNextRunAtMs(nextJob, now);
  }
}

async function persistUpdatedJob(params: {
  state: CronServiceState;
  snapshot: CronRollbackSnapshot;
  previousJob: CronJob;
  nextJob: CronJob;
}) {
  const { state, snapshot, previousJob, nextJob } = params;
  if (
    nextJob.state.queuedAtMs !== undefined &&
    resolveCronJobConfigRevision(previousJob) !== resolveCronJobConfigRevision(nextJob)
  ) {
    // Retire the occurrence with its owning edit; A→B→A cannot revive a queued snapshot.
    delete nextJob.state.queuedAtMs;
  }
  if (state.store) {
    const index = state.store.jobs.findIndex((entry) => entry.id === nextJob.id);
    if (index >= 0) {
      state.store.jobs[index] = nextJob;
    }
  }

  const defaultAgentId = resolveCurrentDefaultAgentId(state);
  const ownerChanged =
    resolveEffectiveJobAgentId(previousJob, defaultAgentId) !==
    resolveEffectiveJobAgentId(nextJob, defaultAgentId);
  await persistOrRestore(state, snapshot, {
    suppressScheduledJobId: nextJob.id,
    transactionHooks: ownerChanged
      ? cronRunReceiptOwnerMutationHooks({ state, jobId: nextJob.id })
      : undefined,
  });
  if (!cronSchedulingInputsEqual(previousJob, nextJob)) {
    // Mark only committed edits; a failed SQLite write cannot retire the run's
    // schedule ownership, and idempotent re-saves must not create a new claim.
    noteActiveCronJobScheduleMutation(nextJob.id);
  }
  if (isJobEnabled(previousJob) && !isJobEnabled(nextJob)) {
    requestActiveCronJobCancellation(nextJob.id, "Cron job disabled by operator.");
  }
  if (
    !isDeepStrictEqual(previousJob.trigger, nextJob.trigger) ||
    !isDeepStrictEqual(previousJob.state.triggerState, nextJob.state.triggerState) ||
    ((previousJob.payload.kind === "script" || nextJob.payload.kind === "script") &&
      !isDeepStrictEqual(previousJob.payload, nextJob.payload))
  ) {
    // Trigger/script definitions and shared-state edits retire the admitted
    // state writer; otherwise an obsolete evaluation or script wins later.
    noteActiveCronJobTriggerMutation(nextJob.id);
  }
  armTimer(state);
  emit(state, {
    jobId: nextJob.id,
    action: "updated",
    job: nextJob,
    nextRunAtMs: nextJob.state.nextRunAtMs,
  });
}

function declarativeFields(job: CronStoredJob, includeEnabled: boolean) {
  return {
    schedule: job.schedule,
    pacing: job.pacing,
    trigger: job.trigger,
    payload: job.payload,
    scheduledToolPolicy: job.scheduledToolPolicy,
    toolsAllowProvenance: job.toolsAllowProvenance,
    toolsAllowExecTarget: job.toolsAllowExecTarget,
    runtimeAuthority: job.runtimeAuthority,
    runtimeAuthorityRecoveryRequired: job.runtimeAuthorityRecoveryRequired,
    delivery: job.delivery,
    displayName: job.displayName,
    ...(includeEnabled ? { enabled: job.enabled } : {}),
  };
}

function consumeRuntimeAuthorityMutationOptions(
  opts: CronAddOptions | CronUpdateOptions | undefined,
): Pick<Parameters<typeof reconcileRuntimeAuthority>[0], "captured" | "runtimeAuthority"> {
  // Validation-only guards must not look like an empty fresh capture: that
  // would erase an existing runtime ceiling during an otherwise routine edit.
  opts?.commitGuard?.();
  return {
    captured: opts?.captureRuntimeAuthority !== undefined,
    runtimeAuthority: opts?.captureRuntimeAuthority?.(),
  };
}

/** Adds or converges a declaration-keyed cron job inside one store lock and write transaction. */
export async function add(
  state: CronServiceState,
  input: CronJobCreate,
  opts?: CronAddOptions,
): Promise<CronAddResult> {
  let pendingSessionCleanup: Promise<void> | undefined;
  return await locked(state, async () => {
    warnIfDisabled(state, "add");
    const declarationKey = normalizeOptionalString(input.declarationKey);
    if (
      input.payload &&
      isSystemOwnedCronPayloadKind(input.payload.kind) &&
      opts?.systemOwned !== true
    ) {
      throw new Error("system-owned payloads cannot be created by cron clients");
    }
    const systemOwnedDeclarationNamespace = systemOwnedDeclarationKeyNamespace(declarationKey);
    if (systemOwnedDeclarationNamespace && opts?.systemOwned !== true) {
      throw new Error(
        `cron declarationKey namespace "${systemOwnedDeclarationNamespace}" is system-owned; jobs cannot be created with it`,
      );
    }
    await ensureLoadedForOperation(state);
    const agentId = resolveEffectiveJobAgentId(input, resolveCurrentDefaultAgentId(state));
    if (state.deps.isAgentAvailable?.(agentId) === false) {
      throw new Error(`cron job agent is unavailable: ${agentId}`);
    }
    const normalizedId = normalizeOptionalString(input.id);
    if (input.id !== undefined && !normalizedId) {
      throw new Error("cron job id must not be blank");
    }
    if (normalizedId) {
      normalizeCronTaskRunJobId(normalizedId);
      pendingSessionCleanup = getPendingCronSessionCleanup(state, normalizedId);
      if (pendingSessionCleanup) {
        throw RETRY_ADD_AFTER_SESSION_CLEANUP;
      }
    }
    const normalizedInput = normalizedId ? { ...input, id: normalizedId } : input;
    const matches = declarationKey
      ? (state.store?.jobs.filter(
          (job) => job.declarationKey === declarationKey && (opts?.matchesExisting?.(job) ?? true),
        ) ?? [])
      : [];
    if (matches.length > 1) {
      throw new Error(`cron declarationKey is ambiguous within caller scope: ${declarationKey}`);
    }
    const existing = matches[0];
    const configuredChannels = await resolveConfiguredChannelsForValidation(state);

    if (existing) {
      // A declarative upsert may not repurpose an existing system-owned monitor
      // with a different payload; only the gateway's own convergence touches it.
      if (isSystemOwnedCronPayloadKind(existing.payload.kind) && opts?.systemOwned !== true) {
        throw new Error("system-owned monitor jobs cannot be edited by cron clients");
      }
      const now = state.deps.nowMs();
      const nextJob = structuredClone(existing);
      applyDeclarativeJobSpec(nextJob, normalizedInput, {
        defaultAgentId: state.deps.defaultAgentId,
        enabledExplicit: opts?.enabledExplicit === true,
        nowMs: now,
        cronConfig: state.deps.cronConfig,
        scheduledToolPolicy: opts?.scheduledToolPolicy,
        toolsAllowProvenance: opts?.toolsAllowProvenance,
        toolsAllowExecTarget: opts?.toolsAllowExecTarget,
        configuredChannels,
      });
      const runtimeAuthorityMutation = consumeRuntimeAuthorityMutationOptions(opts);
      reconcileRuntimeAuthority({
        job: nextJob,
        ...runtimeAuthorityMutation,
        explicitlyMutatesToolsAllow: normalizedInput.payload.toolsAllow !== undefined,
      });
      const includeEnabled = opts?.enabledExplicit === true;
      if (
        isDeepStrictEqual(
          declarativeFields(existing, includeEnabled),
          declarativeFields(nextJob, includeEnabled),
        )
      ) {
        return { ...existing, created: false, updated: false, job: existing };
      }
      const snapshot = snapshotStoreForRollback(state);
      finalizeUpdatedJob({
        job: existing,
        nextJob,
        now,
        schedulingInputsRequested: true,
        scheduleChanged: !isDeepStrictEqual(existing.schedule, nextJob.schedule),
        explicitTriggerState: normalizedInput.state,
      });
      await persistUpdatedJob({ state, snapshot, previousJob: existing, nextJob });
      return { ...nextJob, created: false, updated: true, job: nextJob };
    }

    if (normalizedId && state.store?.jobs.some((job) => job.id === normalizedId)) {
      throw new Error(`cron job already exists: ${normalizedId}`);
    }
    const explicitOwnerAgentId =
      normalizeOptionalAgentId(normalizedInput.agentId) ??
      parseAgentSessionKey(normalizeOptionalString(normalizedInput.sessionKey))?.agentId;
    const retainedLegacyAgentId = normalizeOptionalAgentId(state.deps.legacyDefaultAgentId);
    const creationInput =
      !explicitOwnerAgentId && retainedLegacyAgentId === agentId
        ? { ...normalizedInput, agentId }
        : normalizedInput;
    const snapshot = snapshotStoreForRollback(state);
    const job = createJob(state, creationInput, {
      scheduledToolPolicy: opts?.scheduledToolPolicy,
      toolsAllowProvenance: opts?.toolsAllowProvenance,
      toolsAllowExecTarget: opts?.toolsAllowExecTarget,
      configuredChannels,
    });
    if (opts?.createdActor) {
      job.createdActor = structuredClone(opts.createdActor);
    }
    if (opts?.skillLibrarySelections) {
      job.skillLibrarySelections = structuredClone(opts.skillLibrarySelections);
    }
    const runtimeAuthorityMutation = consumeRuntimeAuthorityMutationOptions(opts);
    reconcileRuntimeAuthority({
      job,
      ...runtimeAuthorityMutation,
      explicitlyMutatesToolsAllow: normalizedInput.payload.toolsAllow !== undefined,
    });
    state.store?.jobs.push(job);

    // Mutation notifications describe durable state, so publish them only
    // after the write succeeds instead of leaking a rolled-back transition.
    const postPersistNotifications: DeferredCronNotifications = [];
    recomputeNextRunsForMaintenance(state, {
      deferredNotifications: postPersistNotifications,
    });

    await persistOrRestore(state, snapshot, {
      postPersistNotifications,
      suppressScheduledJobId: job.id,
    });
    armTimer(state);

    state.deps.log.info(
      {
        jobId: job.id,
        jobName: job.name,
        nextRunAtMs: job.state.nextRunAtMs,
        schedulerNextWakeAtMs: nextWakeAtMs(state) ?? null,
        timerArmed: state.timer !== null,
        cronEnabled: state.deps.cronEnabled,
      },
      "cron: job added",
    );

    emit(state, {
      jobId: job.id,
      action: "added",
      job,
      nextRunAtMs: job.state.nextRunAtMs,
    });
    return declarationKey ? { ...job, created: true, job } : job;
  }).catch(async (error: unknown) => {
    if (error !== RETRY_ADD_AFTER_SESSION_CLEANUP || !pendingSessionCleanup) {
      throw error;
    }
    await pendingSessionCleanup;
    return await add(state, input, opts);
  });
}

/** Prunes an owned job family from obsolete store partitions after active-store convergence. */
export async function removeStaleJobFamily(
  state: CronServiceState,
  family: { declarationKey: string; name: string; ownerPluginTag: string },
): Promise<number> {
  return await locked(state, async () => {
    await ensureLoadedForOperation(state);
    return removeStaleCronJobFamilyRows(state.deps.storePath, family);
  });
}

async function updateLoadedJob(params: {
  state: CronServiceState;
  id: string;
  patch: CronJobPatch;
  precondition?: CronUpdatePrecondition;
  opts?: CronUpdateOptions;
}) {
  const { state, id, patch, precondition, opts } = params;
  warnIfDisabled(state, "update");
  // Mirrors the add-time boundary: no caller may patch a job into (or edit)
  // a system-owned monitor payload; the gateway converges via add only.
  if (patch.payload && isSystemOwnedCronPayloadKind(patch.payload.kind)) {
    throw new Error("system-owned payloads cannot be patched by cron clients");
  }
  await ensureLoadedForOperation(state);
  const job = findJobOrThrow(state, id);
  // Existing monitors are config-driven: any patch (disable, reschedule,
  // repurpose) would silently diverge from its owner until the next reconcile,
  // so updates are rejected outright. Removal stays allowed only to the owner.
  if (isSystemOwnedCronPayloadKind(job.payload.kind)) {
    throw new Error("system-owned monitor jobs cannot be edited by cron clients");
  }
  const now = state.deps.nowMs();
  const configuredChannels = cronPatchTouchesDeliveryResolution(patch)
    ? await resolveConfiguredChannelsForValidation(state)
    : undefined;
  await precondition?.(structuredClone(job), now);
  const nextJob = structuredClone(job);
  applyJobPatch(nextJob, patch, {
    defaultAgentId: state.deps.defaultAgentId,
    scheduleValidationNowMs: now,
    cronConfig: state.deps.cronConfig,
    scheduledToolPolicy: opts?.scheduledToolPolicy,
    toolsAllowProvenance: opts?.toolsAllowProvenance,
    toolsAllowExecTarget: opts?.toolsAllowExecTarget,
    configuredChannels,
  });
  if (patch.agentId !== undefined) {
    const agentId = resolveEffectiveJobAgentId(nextJob, resolveCurrentDefaultAgentId(state));
    if (state.deps.isAgentAvailable?.(agentId) === false) {
      throw new Error(`cron job agent is unavailable: ${agentId}`);
    }
  }
  finalizeUpdatedJob({
    job,
    nextJob,
    now,
    schedulingInputsRequested:
      patch.schedule !== undefined ||
      patch.enabled !== undefined ||
      "trigger" in patch ||
      "pacing" in patch,
    scheduleChanged: patch.schedule !== undefined,
    explicitTriggerState: patch.state,
  });
  const runtimeAuthorityMutation = consumeRuntimeAuthorityMutationOptions(opts);
  reconcileRuntimeAuthority({
    job: nextJob,
    ...runtimeAuthorityMutation,
    explicitlyMutatesToolsAllow:
      patch.payload !== undefined && Object.hasOwn(patch.payload, "toolsAllow"),
  });
  const snapshot = snapshotStoreForRollback(state);
  await persistUpdatedJob({ state, snapshot, previousJob: job, nextJob });
  return nextJob;
}

/** Updates a cron job patch in-place, recomputes affected schedule state, and persists it. */
export async function update(
  state: CronServiceState,
  id: string,
  patch: CronJobPatch,
  opts?: CronUpdateOptions,
) {
  return await locked(state, async () => await updateLoadedJob({ state, id, patch, opts }));
}

/** Updates a cron job only after a store-locked caller precondition passes. */
export async function updateWithPrecondition(
  state: CronServiceState,
  id: string,
  patch: CronJobPatch,
  precondition: CronUpdatePrecondition,
  opts?: CronUpdateOptions,
) {
  return await locked(
    state,
    async () => await updateLoadedJob({ state, id, patch, precondition, opts }),
  );
}

/** Removes a cron job by id and re-arms the timer when the in-memory store changes. */
export async function remove(
  state: CronServiceState,
  id: string,
  opts?: { systemOwned?: boolean; commitGuard?: () => void },
) {
  let sessionCleanup:
    | {
        activeMarker: CronActiveJobMarker | undefined;
        agentId: string;
        sessionStorePath: string;
        done: Promise<void>;
        finish: () => void;
        release: () => void;
      }
    | undefined;
  const result = await locked(state, async () => {
    warnIfDisabled(state, "remove");
    const previousStore = state.store;
    await ensureLoadedForOperation(state);
    if (!state.store) {
      return { ok: false, removed: false } as const;
    }
    const removedJob = state.store.jobs.find((j) => j.id === id);
    if (!removedJob) {
      if (state.store !== previousStore) {
        armTimer(state);
      }
      return { ok: true, removed: false } as const;
    }
    // Config is the monitor's source of truth: ad-hoc deletion would disable
    // the feature until an unrelated reload, so only gateway reconciliation
    // (stale-monitor cleanup) may remove one.
    if (isSystemOwnedCronPayloadKind(removedJob.payload.kind) && opts?.systemOwned !== true) {
      throw new Error("system-owned monitor jobs cannot be removed by cron clients");
    }
    opts?.commitGuard?.();
    const snapshot = snapshotStoreForRollback(state);
    state.store.jobs = state.store.jobs.filter((j) => j.id !== id);

    const postPersistNotifications: DeferredCronNotifications = [];
    recomputeNextRunsForMaintenance(state, {
      deferredNotifications: postPersistNotifications,
    });

    await persistOrRestore(state, snapshot, {
      postPersistNotifications,
      suppressScheduledJobId: id,
    });
    const activeMarker = noteActiveCronJobRemoval(id, opts?.commitGuard);
    const agentId = resolveEffectiveJobAgentId(removedJob, resolveCurrentDefaultAgentId(state));
    const sessionStorePath =
      state.deps.resolveSessionStorePath?.(agentId) ?? state.deps.sessionStorePath;
    if (
      sessionStorePath &&
      (removedJob.sessionTarget === "isolated" || removedJob.sessionTarget === "current")
    ) {
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const release = registerPendingCronSessionCleanup(state, id, done);
      sessionCleanup = {
        activeMarker,
        agentId,
        sessionStorePath,
        done,
        finish,
        release,
      };
    }
    pruneCronJobScratchAfterCommit(state, [id]);
    armTimer(state);
    emit(state, { jobId: id, action: "removed", job: removedJob });
    return { ok: true, removed: true } as const;
  });
  if (!sessionCleanup) {
    return result;
  }
  const { activeMarker, agentId, sessionStorePath, finish, release } = sessionCleanup;
  const cleanup = async () => {
    try {
      const shouldRemove = await locked(state, async () => {
        await ensureLoaded(state, { skipRecompute: true });
        return !state.store?.jobs.some((job) => job.id === id);
      });
      if (shouldRemove) {
        await removeCronJobBaseSession({
          agentId,
          jobId: id,
          sessionStorePath,
        });
      }
    } catch (error) {
      state.deps.log.warn({ jobId: id, err: String(error) }, "cron: session cleanup failed");
    } finally {
      release();
      finish();
    }
  };
  if (activeMarker) {
    onCronJobInactive(activeMarker, () => void cleanup());
    return result;
  }
  await cleanup();
  return result;
}

/** Remove one agent's jobs while holding the cron lock across an external roster commit. */
export async function removeAgentJobsTransactional<T>(
  state: CronServiceState,
  agentId: string,
  commit: () => Promise<T>,
): Promise<T> {
  return await locked(state, async () => {
    warnIfDisabled(state, "remove agent jobs");
    await ensureLoadedForOperation(state);
    const id = normalizeOptionalAgentId(agentId);
    if (!id || !state.store) {
      return await commit();
    }
    const defaultAgentId = resolveCurrentDefaultAgentId(state);
    const removedJobs = state.store.jobs.filter(
      (job) => resolveEffectiveJobAgentId(job, defaultAgentId) === id,
    );
    if (removedJobs.length === 0) {
      return await commit();
    }
    const snapshot = snapshotStoreForRollback(state);
    state.store.jobs = state.store.jobs.filter(
      (job) => resolveEffectiveJobAgentId(job, defaultAgentId) !== id,
    );
    const postPersistNotifications: DeferredCronNotifications = [];
    recomputeNextRunsForMaintenance(state, { deferredNotifications: postPersistNotifications });
    // Cron is durable first, but notifications stay speculative until the roster commits.
    await persistOrRestore(state, snapshot);
    let result: T;
    try {
      result = await commit();
    } catch (error) {
      if (error instanceof AgentDeletionCommitUncertainError) {
        // Uncertain roster writes intentionally keep the cron deletion durable.
        runPostPersistCronNotifications(state, postPersistNotifications);
        armTimer(state);
        for (const job of removedJobs) {
          noteActiveCronJobRemoval(job.id);
        }
        pruneCronJobScratchAfterCommit(
          state,
          removedJobs.map((job) => job.id),
        );
        for (const job of removedJobs) {
          emit(state, { jobId: job.id, action: "removed", job });
        }
        throw error;
      }
      try {
        if (state.deps.cronEnabled) {
          state.store = snapshot.store;
          state.durableNextRunAtMsByJobId = snapshot.durableNextRunAtMsByJobId;
          if (!(await persist(state))) {
            throw new Error("cron: rollback store write did not complete", { cause: error });
          }
        } else {
          const deletedSnapshot = snapshotStoreForRollback(state);
          state.store = snapshot.store;
          state.durableNextRunAtMsByJobId = snapshot.durableNextRunAtMsByJobId;
          await persistOrRestore(state, deletedSnapshot, { preserveConcurrentAdds: true });
        }
        armTimer(state);
      } catch (rollbackError) {
        throw new AgentDeletionAuthorityRollbackError(
          [error, rollbackError],
          `cron: failed to roll back agent job deletion for ${id}`,
          { cause: error },
        );
      }
      throw error;
    }
    runPostPersistCronNotifications(state, postPersistNotifications);
    for (const job of removedJobs) {
      noteActiveCronJobRemoval(job.id);
    }
    pruneCronJobScratchAfterCommit(
      state,
      removedJobs.map((job) => job.id),
    );
    armTimer(state);
    for (const job of removedJobs) {
      emit(state, { jobId: job.id, action: "removed", job });
    }
    return result;
  });
}
