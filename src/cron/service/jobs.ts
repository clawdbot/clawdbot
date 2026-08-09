/** Cron job scheduling, validation, creation, and patch helpers. */
import crypto from "node:crypto";
import {
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import type { CronConfig } from "../../config/types.cron.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import type { CronScheduledToolPolicy } from "../scheduled-tool-policy.js";
import { normalizeCronScriptPayload } from "../script-payload.js";
import { normalizeCronStaggerMs, resolveDefaultCronStaggerMs } from "../stagger.js";
import { createCronStreamSourceIdentity } from "../stream-schedule.js";
import { applyDefaultCronToolsAllow, cronJobUsesToolRuntime } from "../tools-allow.js";
import type {
  CronDelivery,
  CronDeliveryPatch,
  CronFailureAlert,
  CronFailureAlertPatch,
  CronJobCreate,
  CronJobPatch,
  CronJobState,
  CronStoredJob,
  CronToolsAllowProvenance,
} from "../types.js";
import { resolveInitialCronDelivery } from "./initial-delivery.js";
import {
  computeJobNextRunAtMs,
  normalizeStreamScheduleBounds,
  resolveEveryAnchorMs,
} from "./jobs-scheduling.js";
import {
  reconcileScheduledToolPolicy,
  reconcileToolsAllowProvenance,
  stampScheduledToolPolicy,
} from "./jobs-tool-policy.js";
import {
  assertAnnounceDeliveryChannelSupport,
  assertCronExpressionSatisfiable,
  assertDeliverySupport,
  assertFailureDestinationSupport,
  assertMainSessionAgentId,
  assertPacingSupport,
  assertScriptPayloadSupport,
  assertStreamScheduleSupport,
  assertSupportedJobSpec,
  assertTriggerSupport,
  hasConcreteFailureDestination,
} from "./jobs-validation.js";
import { normalizeOptionalAgentId, normalizeRequiredName } from "./normalize.js";
import { mergeCronPayload } from "./payload-merge.js";
import type { CronServiceState } from "./state.js";

const CRON_DECLARATIVE_LABEL_MAX_LENGTH = 200;
type DeliveryValidationOptions = { configuredChannels?: readonly string[] };

export { assertSupportedJobSpec };

export {
  DEFAULT_ERROR_BACKOFF_SCHEDULE_MS,
  hasScheduledNextRunAtMs,
  resolveJobLastRunStatus,
  errorBackoffMs,
  resolveJobErrorBackoffUntilMs,
  findJobOrThrow,
  isJobEnabled,
  computeJobNextRunAtMs,
  computeJobPreviousRunAtOrBeforeMs,
  recordScheduleComputeError,
  recomputeNextRuns,
  recomputeNextRunsForMaintenance,
  nextWakeAtMs,
  hasActiveCronRun,
  isJobDue,
  resolveJobPayloadTextForMain,
} from "./jobs-scheduling.js";
/** Creates a normalized cron job row from public add input and computes its initial schedule. */
export function createJob(
  state: CronServiceState,
  input: CronJobCreate,
  opts?: DeliveryValidationOptions & {
    scheduledToolPolicy?: CronScheduledToolPolicy;
    toolsAllowProvenance?: CronToolsAllowProvenance;
  },
): CronStoredJob {
  const now = state.deps.nowMs();
  const id = normalizeOptionalString(input.id) ?? crypto.randomUUID();
  const schedule =
    input.schedule.kind === "every"
      ? {
          ...input.schedule,
          anchorMs: resolveEveryAnchorMs({
            schedule: input.schedule,
            fallbackAnchorMs: now,
          }),
        }
      : input.schedule.kind === "cron"
        ? (() => {
            const explicitStaggerMs = normalizeCronStaggerMs(input.schedule.staggerMs);
            if (explicitStaggerMs !== undefined) {
              return { ...input.schedule, staggerMs: explicitStaggerMs };
            }
            const defaultStaggerMs = resolveDefaultCronStaggerMs(input.schedule.expr);
            return defaultStaggerMs !== undefined
              ? { ...input.schedule, staggerMs: defaultStaggerMs }
              : input.schedule;
          })()
        : normalizeStreamScheduleBounds(input.schedule);
  const deleteAfterRun =
    typeof input.deleteAfterRun === "boolean"
      ? input.deleteAfterRun
      : schedule.kind === "at"
        ? true
        : undefined;
  const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
  const declarationKey = normalizeOptionalString(input.declarationKey);
  if (input.declarationKey !== undefined && !declarationKey) {
    throw new Error("cron declarationKey must not be blank");
  }
  if (declarationKey && declarationKey.length > CRON_DECLARATIVE_LABEL_MAX_LENGTH) {
    throw new Error(
      `cron declarationKey must be at most ${CRON_DECLARATIVE_LABEL_MAX_LENGTH} characters`,
    );
  }
  const displayName = normalizeOptionalString(input.displayName);
  if (input.displayName !== undefined && !displayName) {
    throw new Error("cron displayName must not be blank");
  }
  if (displayName && displayName.length > CRON_DECLARATIVE_LABEL_MAX_LENGTH) {
    throw new Error(
      `cron displayName must be at most ${CRON_DECLARATIVE_LABEL_MAX_LENGTH} characters`,
    );
  }
  const ownerAgentId = normalizeOptionalAgentId(input.owner?.agentId);
  const ownerSessionKey = normalizeOptionalString(input.owner?.sessionKey);
  const ownerAccountId = normalizeOptionalAccountId(input.owner?.accountId);
  const initialState = { ...input.state } as Partial<CronJobState>;
  // Schedule activation is stamped only by committed scheduling mutations.
  // Accepting caller state here would let imports spoof restart catch-up ownership.
  delete initialState.scheduleActivatedAtMs;
  const job: CronStoredJob = {
    id,
    ...(declarationKey ? { declarationKey } : {}),
    ...(displayName ? { displayName } : {}),
    ...(ownerAgentId || ownerSessionKey || ownerAccountId
      ? {
          owner: {
            ...(ownerAgentId ? { agentId: ownerAgentId } : {}),
            ...(ownerSessionKey ? { sessionKey: ownerSessionKey } : {}),
            ...(ownerAccountId ? { accountId: ownerAccountId } : {}),
          },
        }
      : {}),
    agentId: normalizeOptionalAgentId(input.agentId),
    sessionKey: normalizeOptionalString((input as { sessionKey?: unknown }).sessionKey),
    name: normalizeRequiredName(input.name),
    description: normalizeOptionalString(input.description),
    enabled,
    deleteAfterRun,
    createdAtMs: now,
    updatedAtMs: now,
    schedule,
    ...(input.pacing !== undefined ? { pacing: structuredClone(input.pacing) } : {}),
    sessionTarget: input.sessionTarget,
    wakeMode: input.wakeMode,
    payload:
      input.payload.kind === "script"
        ? normalizeCronScriptPayload(structuredClone(input.payload))
        : structuredClone(input.payload),
    delivery: resolveInitialCronDelivery(input),
    failureAlert: input.failureAlert,
    ...(input.trigger ? { trigger: structuredClone(input.trigger) } : {}),
    state: {
      ...initialState,
      ...(schedule.kind === "stream"
        ? { streamSourceIdentity: createCronStreamSourceIdentity() }
        : {}),
    },
  };
  // New trusted jobs are explicit by construction. Agent-runtime callers are
  // required to arrive with a creator cap before the service can apply this default.
  applyDefaultCronToolsAllow(job);
  stampScheduledToolPolicy(job, opts?.scheduledToolPolicy);
  reconcileToolsAllowProvenance({
    job,
    explicitlyMutatesToolsAllow: true,
    toolsAllowProvenance: opts?.toolsAllowProvenance,
  });
  assertSupportedJobSpec(job);
  assertPacingSupport(job);
  assertTriggerSupport(job, {
    cronConfig: state.deps.cronConfig,
    requireEnabled: job.trigger !== undefined,
  });
  assertScriptPayloadSupport(job, {
    cronConfig: state.deps.cronConfig,
    requireEnabled: job.payload.kind === "script",
  });
  assertStreamScheduleSupport(job, {
    cronConfig: state.deps.cronConfig,
    requireEnabled: true,
  });
  assertMainSessionAgentId(job, state.deps.defaultAgentId);
  assertDeliverySupport(job);
  assertAnnounceDeliveryChannelSupport(job, opts?.configuredChannels);
  assertFailureDestinationSupport(job);
  assertCronExpressionSatisfiable(job, now, computeJobNextRunAtMs);
  job.state.nextRunAtMs = computeJobNextRunAtMs(job, now);
  return job;
}

/** Applies a public cron patch in-place, preserving omitted nested fields and validating the result. */
export function applyJobPatch(
  job: CronStoredJob,
  patch: CronJobPatch,
  opts?: {
    defaultAgentId?: string;
    scheduleValidationNowMs?: number;
    cronConfig?: CronConfig;
    scheduledToolPolicy?: CronScheduledToolPolicy;
    toolsAllowProvenance?: CronToolsAllowProvenance;
  } & DeliveryValidationOptions,
) {
  const previouslyUsedToolRuntime = cronJobUsesToolRuntime(job);
  const explicitlyClearsToolsAllow = patch.payload?.toolsAllow === null;
  const previousScheduleKind = job.schedule.kind;
  if ("name" in patch) {
    job.name = normalizeRequiredName(patch.name);
  }
  if ("description" in patch) {
    job.description = normalizeOptionalString(patch.description);
  }
  if ("displayName" in patch) {
    const displayName = normalizeOptionalString(patch.displayName);
    if (patch.displayName !== null && patch.displayName !== undefined && !displayName) {
      throw new Error("cron displayName must not be blank");
    }
    if (displayName && displayName.length > CRON_DECLARATIVE_LABEL_MAX_LENGTH) {
      throw new Error(
        `cron displayName must be at most ${CRON_DECLARATIVE_LABEL_MAX_LENGTH} characters`,
      );
    }
    if (displayName) {
      job.displayName = displayName;
    } else {
      delete job.displayName;
    }
  }
  if (typeof patch.enabled === "boolean") {
    job.enabled = patch.enabled;
  }
  const hasDeleteAfterRunPatch = typeof patch.deleteAfterRun === "boolean";
  if (hasDeleteAfterRunPatch) {
    job.deleteAfterRun = patch.deleteAfterRun;
  } else if (
    patch.schedule?.kind === "at" &&
    (previousScheduleKind === "every" || previousScheduleKind === "cron")
  ) {
    // A schedule-kind transition starts a new retention contract. Do not let a
    // recurring job's ignored/stale flag defeat the one-shot cleanup default.
    job.deleteAfterRun = true;
  } else if (
    previousScheduleKind === "at" &&
    (patch.schedule?.kind === "every" || patch.schedule?.kind === "cron")
  ) {
    delete job.deleteAfterRun;
  }
  if (patch.schedule) {
    if (patch.schedule.kind === "cron") {
      const explicitStaggerMs = normalizeCronStaggerMs(patch.schedule.staggerMs);
      if (explicitStaggerMs !== undefined) {
        job.schedule = { ...patch.schedule, staggerMs: explicitStaggerMs };
      } else if (job.schedule.kind === "cron" && job.schedule.expr === patch.schedule.expr) {
        // Metadata-only resaves keep the existing stagger, but a replacement
        // expression owns a fresh default and must not inherit stale timing.
        job.schedule = { ...patch.schedule, staggerMs: job.schedule.staggerMs };
      } else {
        const defaultStaggerMs = resolveDefaultCronStaggerMs(patch.schedule.expr);
        job.schedule =
          defaultStaggerMs !== undefined
            ? { ...patch.schedule, staggerMs: defaultStaggerMs }
            : patch.schedule;
      }
    } else {
      job.schedule = normalizeStreamScheduleBounds(patch.schedule);
    }
  }
  if ("trigger" in patch) {
    if (patch.trigger === null || patch.trigger === undefined) {
      delete job.trigger;
    } else {
      job.trigger = structuredClone(patch.trigger);
    }
  }
  if ("pacing" in patch) {
    if (patch.pacing === null || patch.pacing === undefined) {
      delete job.pacing;
    } else {
      job.pacing = structuredClone(patch.pacing);
    }
  }
  if (patch.sessionTarget) {
    job.sessionTarget = patch.sessionTarget;
  }
  if (patch.wakeMode) {
    job.wakeMode = patch.wakeMode;
  }
  if (patch.payload) {
    job.payload = mergeCronPayload(job.payload, patch.payload);
    if (job.payload.kind === "script") {
      job.payload = normalizeCronScriptPayload(job.payload);
    }
  }
  if (cronJobUsesToolRuntime(job) && (!previouslyUsedToolRuntime || explicitlyClearsToolsAllow)) {
    // `null` means unrestricted, not a return to ambiguous legacy semantics.
    // Ordinary edits to an existing capless job intentionally remain legacy.
    applyDefaultCronToolsAllow(job);
  }
  reconcileScheduledToolPolicy({
    job,
    previouslyUsedToolRuntime,
    explicitlyMutatesToolsAllow:
      patch.payload !== undefined && Object.hasOwn(patch.payload, "toolsAllow"),
    scheduledToolPolicy: opts?.scheduledToolPolicy,
  });
  reconcileToolsAllowProvenance({
    job,
    explicitlyMutatesToolsAllow:
      patch.payload !== undefined && Object.hasOwn(patch.payload, "toolsAllow"),
    toolsAllowProvenance: opts?.toolsAllowProvenance,
  });
  if (patch.delivery) {
    const implicitMode = resolveCronDeliveryPlan(job).mode;
    job.delivery = mergeCronDelivery(job.delivery, patch.delivery, implicitMode);
  }
  if ("failureAlert" in patch) {
    job.failureAlert = mergeCronFailureAlert(job.failureAlert, patch.failureAlert);
  }
  if (
    job.sessionTarget === "main" &&
    job.delivery?.mode !== "webhook" &&
    hasConcreteFailureDestination(job.delivery?.failureDestination)
  ) {
    throw new Error(
      'cron delivery.failureDestination is only supported for sessionTarget="isolated" unless delivery.mode="webhook"',
    );
  }
  if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook") {
    // Main-session jobs cannot auto-announce; keep only an empty failure
    // destination object when the patch is clearing nested fields.
    const failureDestination = job.delivery?.failureDestination;
    job.delivery =
      failureDestination && !hasConcreteFailureDestination(failureDestination)
        ? { mode: "none", failureDestination }
        : undefined;
  }
  if (patch.state) {
    const statePatch = { ...patch.state } as Partial<CronJobState>;
    // Runtime state patches may report execution progress, but the scheduler
    // alone owns the boundary that decides whether restart catch-up can run.
    delete statePatch.scheduleActivatedAtMs;
    delete statePatch.autoDisabled;
    job.state = { ...job.state, ...statePatch };
  }
  if (patch.enabled === true) {
    delete job.state.autoDisabled;
    job.state.consecutiveErrors = 0;
    job.state.scheduleErrorCount = 0;
  }
  if ("agentId" in patch) {
    job.agentId = normalizeOptionalAgentId((patch as { agentId?: unknown }).agentId);
  }
  if ("sessionKey" in patch) {
    job.sessionKey = normalizeOptionalString((patch as { sessionKey?: unknown }).sessionKey);
  }
  if (job.schedule.kind === "stream" && patch.enabled === true) {
    job.state.streamRestartExhausted = undefined;
    job.state.streamConsecutiveFailures = 0;
    job.state.streamError = undefined;
  }
  if (previousScheduleKind === "stream" && job.schedule.kind !== "stream") {
    job.state.streamStatus = undefined;
    job.state.streamError = undefined;
    job.state.streamConsecutiveFailures = undefined;
    job.state.streamRestartExhausted = undefined;
    job.state.streamSourceIdentity = undefined;
    job.state.streamDroppedBatches = undefined;
    job.state.streamCoalescedBatches = undefined;
    job.state.streamLastStartedAtMs = undefined;
    job.state.streamLastExitAtMs = undefined;
  }
  assertSupportedJobSpec(job);
  assertPacingSupport(job);
  assertTriggerSupport(job, {
    cronConfig: opts?.cronConfig,
    requireEnabled: patch.trigger !== null && patch.trigger !== undefined,
  });
  assertScriptPayloadSupport(job, {
    cronConfig: opts?.cronConfig,
    requireEnabled: patch.payload?.kind === "script",
    // Enabled-only/rename patches must keep working on jobs stored with a
    // malformed script (pre-validation persistence); re-check syntax only
    // when this patch rewrites the payload, or disable becomes a dead end.
    validateSyntax: patch.payload !== undefined,
  });
  assertStreamScheduleSupport(job, {
    cronConfig: opts?.cronConfig,
    requireEnabled: patch.enabled === true || patch.schedule?.kind === "stream",
  });
  assertMainSessionAgentId(job, opts?.defaultAgentId);
  assertDeliverySupport(job);
  assertAnnounceDeliveryChannelSupport(job, opts?.configuredChannels, patch);
  assertFailureDestinationSupport(job);
  if (
    opts?.scheduleValidationNowMs !== undefined &&
    (patch.schedule !== undefined || patch.enabled === true)
  ) {
    assertCronExpressionSatisfiable(job, opts.scheduleValidationNowMs, computeJobNextRunAtMs);
  }
}

/** Converges the declared schedule, payload, delivery, and display label only. */
export function applyDeclarativeJobSpec(
  job: CronStoredJob,
  input: CronJobCreate,
  opts: {
    defaultAgentId?: string;
    enabledExplicit: boolean;
    nowMs: number;
    cronConfig?: CronConfig;
    scheduledToolPolicy?: CronScheduledToolPolicy;
    toolsAllowProvenance?: CronToolsAllowProvenance;
  } & DeliveryValidationOptions,
) {
  const previouslyUsedToolRuntime = cronJobUsesToolRuntime(job);
  const explicitlyDeclaresToolsAllow = input.payload.toolsAllow !== undefined;
  const previousToolsAllow = job.payload.toolsAllow;
  const previousToolsAllowIsDefault = job.payload.toolsAllowIsDefault;
  // Name, target, routing, owner, and run policy remain outside declaration
  // convergence; changing those uses cron.update and cannot retarget an identity.
  const displayName = normalizeOptionalString(input.displayName);
  if (input.displayName !== undefined && !displayName) {
    throw new Error("cron displayName must not be blank");
  }
  if (displayName && displayName.length > CRON_DECLARATIVE_LABEL_MAX_LENGTH) {
    throw new Error(
      `cron displayName must be at most ${CRON_DECLARATIVE_LABEL_MAX_LENGTH} characters`,
    );
  }
  if (displayName) {
    job.displayName = displayName;
  } else {
    delete job.displayName;
  }

  if (
    input.schedule.kind === "every" &&
    input.schedule.anchorMs === undefined &&
    job.schedule.kind === "every" &&
    job.schedule.everyMs === input.schedule.everyMs
  ) {
    job.schedule = { ...input.schedule, anchorMs: job.schedule.anchorMs };
  } else if (input.schedule.kind === "every" && input.schedule.anchorMs === undefined) {
    job.schedule = { ...input.schedule, anchorMs: opts.nowMs };
  } else if (input.schedule.kind === "cron") {
    const explicitStaggerMs = normalizeCronStaggerMs(input.schedule.staggerMs);
    const defaultStaggerMs = resolveDefaultCronStaggerMs(input.schedule.expr);
    job.schedule = {
      ...input.schedule,
      ...(explicitStaggerMs !== undefined
        ? { staggerMs: explicitStaggerMs }
        : defaultStaggerMs !== undefined
          ? { staggerMs: defaultStaggerMs }
          : {}),
    };
  } else {
    job.schedule = normalizeStreamScheduleBounds(structuredClone(input.schedule));
  }
  if (input.pacing !== undefined) {
    job.pacing = structuredClone(input.pacing);
  } else {
    delete job.pacing;
  }
  job.payload =
    input.payload.kind === "script"
      ? normalizeCronScriptPayload(structuredClone(input.payload))
      : structuredClone(input.payload);
  if (input.trigger) {
    job.trigger = structuredClone(input.trigger);
  } else {
    delete job.trigger;
  }
  if (cronJobUsesToolRuntime(job) && job.payload.toolsAllow === undefined) {
    if (previousToolsAllow !== undefined) {
      // Omitted declaration fields preserve explicit authority already stored
      // on the job, including the server-managed creator-default marker.
      job.payload.toolsAllow = [...previousToolsAllow];
      if (previousToolsAllowIsDefault === true) {
        job.payload.toolsAllowIsDefault = true;
      }
    } else if (!previouslyUsedToolRuntime) {
      // A declaration that newly becomes tool-bearing adopts current explicit semantics.
      applyDefaultCronToolsAllow(job);
    }
  }
  reconcileScheduledToolPolicy({
    job,
    previouslyUsedToolRuntime,
    explicitlyMutatesToolsAllow: explicitlyDeclaresToolsAllow,
    scheduledToolPolicy: opts.scheduledToolPolicy,
  });
  reconcileToolsAllowProvenance({
    job,
    explicitlyMutatesToolsAllow: explicitlyDeclaresToolsAllow,
    toolsAllowProvenance: opts.toolsAllowProvenance,
  });
  const delivery = resolveInitialCronDelivery(input);
  if (delivery) {
    job.delivery = structuredClone(delivery);
  } else {
    delete job.delivery;
  }
  if (opts.enabledExplicit) {
    job.enabled = input.enabled;
  }
  assertTriggerSupport(job, {
    cronConfig: opts.cronConfig,
    requireEnabled: input.trigger !== undefined,
  });
  assertScriptPayloadSupport(job, {
    cronConfig: opts.cronConfig,
    requireEnabled: input.payload.kind === "script",
  });
  assertStreamScheduleSupport(job, {
    cronConfig: opts.cronConfig,
    requireEnabled: true,
  });

  assertSupportedJobSpec(job);
  assertPacingSupport(job);
  assertMainSessionAgentId(job, opts.defaultAgentId);
  assertDeliverySupport(job);
  assertAnnounceDeliveryChannelSupport(job, opts.configuredChannels);
  assertFailureDestinationSupport(job);
  assertCronExpressionSatisfiable(job, opts.nowMs, computeJobNextRunAtMs);
}

function mergeCronDelivery(
  existing: CronDelivery | undefined,
  patch: CronDeliveryPatch,
  implicitMode: CronDelivery["mode"],
): CronDelivery | undefined {
  const hasCompletionDestinationPatch = "completionDestination" in patch;
  const next: CronDelivery = {
    mode: existing?.mode ?? implicitMode,
    channel: existing?.channel,
    to: existing?.to,
    threadId: existing?.threadId,
    accountId: existing?.accountId,
    bestEffort: existing?.bestEffort,
    completionDestination: existing?.completionDestination,
    failureDestination: existing?.failureDestination,
  };

  if (typeof patch.mode === "string") {
    const previousMode = next.mode;
    next.mode = (patch.mode as string) === "deliver" ? "announce" : patch.mode;
    if (previousMode !== next.mode && (previousMode === "webhook" || next.mode === "webhook")) {
      // `to` has different meaning for channel targets and webhook URLs; clear
      // it when crossing that boundary so stale destinations do not leak.
      next.to = undefined;
    }
    if (next.mode === "webhook") {
      next.channel = undefined;
      next.threadId = undefined;
      next.accountId = undefined;
    }
    if (!hasCompletionDestinationPatch && (next.mode === "none" || next.mode === "webhook")) {
      next.completionDestination = undefined;
    }
  }
  if ("channel" in patch) {
    next.channel = normalizeOptionalString(patch.channel);
  }
  if ("to" in patch) {
    next.to = normalizeOptionalString(patch.to);
  }
  if ("threadId" in patch) {
    next.threadId = normalizeOptionalThreadValue(patch.threadId);
  }
  if ("accountId" in patch) {
    next.accountId = normalizeOptionalString(patch.accountId);
  }
  if (typeof patch.bestEffort === "boolean") {
    next.bestEffort = patch.bestEffort;
  }
  if (hasCompletionDestinationPatch) {
    if (patch.completionDestination == null) {
      next.completionDestination = undefined;
    } else {
      const to = normalizeOptionalString(patch.completionDestination.to);
      next.completionDestination = {
        mode: "webhook",
        ...(to ? { to } : {}),
      };
    }
  }
  if ("failureDestination" in patch) {
    if (patch.failureDestination == null) {
      next.failureDestination = undefined;
    } else {
      const existingFd = next.failureDestination;
      const patchFd = patch.failureDestination;
      const nextFd: typeof next.failureDestination = {};
      if (existingFd) {
        if (Object.hasOwn(existingFd, "channel")) {
          nextFd.channel = existingFd.channel;
        }
        if (Object.hasOwn(existingFd, "to")) {
          nextFd.to = existingFd.to;
        }
        if (Object.hasOwn(existingFd, "accountId")) {
          nextFd.accountId = existingFd.accountId;
        }
        if (Object.hasOwn(existingFd, "mode")) {
          nextFd.mode = existingFd.mode;
        }
      }
      if (patchFd) {
        if ("channel" in patchFd) {
          const channel = normalizeOptionalString(patchFd.channel) ?? "";
          nextFd.channel = channel ? channel : undefined;
        }
        if ("to" in patchFd) {
          const to = normalizeOptionalString(patchFd.to) ?? "";
          nextFd.to = to ? to : undefined;
        }
        if ("accountId" in patchFd) {
          const accountId = normalizeOptionalString(patchFd.accountId) ?? "";
          nextFd.accountId = accountId ? accountId : undefined;
        }
        if ("mode" in patchFd) {
          const mode = normalizeOptionalString(patchFd.mode) ?? "";
          nextFd.mode = mode === "announce" || mode === "webhook" ? mode : undefined;
        }
      }
      const hasFailureDestination =
        Object.hasOwn(nextFd, "channel") ||
        Object.hasOwn(nextFd, "to") ||
        Object.hasOwn(nextFd, "accountId") ||
        Object.hasOwn(nextFd, "mode");
      next.failureDestination = hasFailureDestination ? nextFd : undefined;
    }
  }

  if (
    existing === undefined &&
    !("mode" in patch) &&
    next.channel === undefined &&
    next.to === undefined &&
    next.threadId === undefined &&
    next.accountId === undefined &&
    next.bestEffort === undefined &&
    next.completionDestination === undefined &&
    next.failureDestination === undefined
  ) {
    // Clearing an absent override must preserve implicit detached-job delivery.
    return undefined;
  }

  return next;
}

function mergeCronFailureAlert(
  existing: CronFailureAlert | false | undefined,
  patch: CronFailureAlertPatch | false | null | undefined,
): CronFailureAlert | false | undefined {
  if (patch === false) {
    return false;
  }
  if (patch === null) {
    return undefined;
  }
  if (patch === undefined) {
    return existing;
  }
  const base = existing === false || existing === undefined ? {} : existing;
  const next: CronFailureAlert = { ...base };

  if ("after" in patch) {
    const after = typeof patch.after === "number" && Number.isFinite(patch.after) ? patch.after : 0;
    next.after = after > 0 ? Math.floor(after) : undefined;
  }
  if ("channel" in patch) {
    next.channel = normalizeOptionalString(patch.channel);
  }
  if ("to" in patch) {
    next.to = normalizeOptionalString(patch.to);
  }
  if ("cooldownMs" in patch) {
    const cooldownMs =
      typeof patch.cooldownMs === "number" && Number.isFinite(patch.cooldownMs)
        ? patch.cooldownMs
        : -1;
    next.cooldownMs = cooldownMs >= 0 ? Math.floor(cooldownMs) : undefined;
  }
  if ("includeSkipped" in patch) {
    next.includeSkipped =
      typeof patch.includeSkipped === "boolean" ? patch.includeSkipped : undefined;
  }
  if ("mode" in patch) {
    const mode = normalizeOptionalString(patch.mode) ?? "";
    next.mode = mode === "announce" || mode === "webhook" ? mode : undefined;
  }
  if ("accountId" in patch) {
    const accountId = normalizeOptionalString(patch.accountId) ?? "";
    next.accountId = accountId ? accountId : undefined;
  }

  return next;
}

/**
 * Covers both durable reservations and the process marker that survives mutable job state.
 * Every timer/manual admission path must use this or disable/re-enable can duplicate a run.
 */
