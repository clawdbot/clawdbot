/** Cron job scheduling, validation, creation, and patch helpers. */
import crypto from "node:crypto";
import {
  normalizeOptionalString,
  normalizeOptionalThreadValue,
} from "@openclaw/normalization-core/string-coerce";
import type { CronConfig } from "../../config/types.cron.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { assertCronJobStateTimestamps } from "../persisted-shape.js";
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
  CronSchedule,
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
  assertTimeScheduleSatisfiable,
  assertDeliverySupport,
  assertFailureDestinationSupport,
  assertMainSessionAgentId,
  assertPacingSupport,
  assertScriptPayloadSupport,
  assertStreamScheduleSupport,
  assertSupportedJobSpec,
  assertTriggerSupport,
} from "./jobs-validation.js";
import { normalizeOptionalAgentId, normalizeRequiredName } from "./normalize.js";
import { mergeCronPayload } from "./payload-merge.js";
import type { CronServiceState } from "./state.js";

const CRON_DECLARATIVE_LABEL_MAX_LENGTH = 200;
type DeliveryValidationOptions = { configuredChannels?: readonly string[] };

type ScheduleNormalizationContext =
  | { kind: "create"; nowMs: number }
  | { kind: "patch"; previous: CronSchedule }
  | { kind: "declarative"; previous: CronSchedule; nowMs: number; fallbackAnchorMs: number };

function normalizeJobSchedule(
  schedule: CronSchedule,
  context: ScheduleNormalizationContext,
): CronSchedule {
  if (schedule.kind === "every") {
    if (context.kind === "patch") {
      return schedule;
    }
    if (context.kind === "create") {
      return {
        ...schedule,
        anchorMs: resolveEveryAnchorMs({ schedule, fallbackAnchorMs: context.nowMs }),
      };
    }
    if (schedule.anchorMs !== undefined) {
      return schedule;
    }
    const anchorMs =
      context.previous.kind === "every" && context.previous.everyMs === schedule.everyMs
        ? resolveEveryAnchorMs({
            schedule: context.previous,
            fallbackAnchorMs: context.fallbackAnchorMs,
          })
        : context.nowMs;
    return {
      ...schedule,
      anchorMs,
    };
  }
  if (schedule.kind === "cron") {
    const explicitStaggerMs = normalizeCronStaggerMs(schedule.staggerMs);
    if (explicitStaggerMs !== undefined) {
      return { ...schedule, staggerMs: explicitStaggerMs };
    }
    if (
      context.kind !== "create" &&
      context.previous.kind === "cron" &&
      context.previous.expr === schedule.expr
    ) {
      return { ...schedule, staggerMs: context.previous.staggerMs };
    }
    const defaultStaggerMs = resolveDefaultCronStaggerMs(schedule.expr);
    if (defaultStaggerMs !== undefined) {
      return { ...schedule, staggerMs: defaultStaggerMs };
    }
    return context.kind === "declarative" ? { ...schedule } : schedule;
  }
  const input = context.kind === "declarative" ? structuredClone(schedule) : schedule;
  return normalizeStreamScheduleBounds(input);
}

function normalizeDeclarativeLabel(
  value: unknown,
  field: "declarationKey" | "displayName",
  nullable = false,
): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!(nullable && value == null) && value !== undefined && !normalized) {
    throw new Error(`cron ${field} must not be blank`);
  }
  if (normalized && normalized.length > CRON_DECLARATIVE_LABEL_MAX_LENGTH) {
    throw new Error(
      `cron ${field} must be at most ${CRON_DECLARATIVE_LABEL_MAX_LENGTH} characters`,
    );
  }
  return normalized;
}

type JobValidationContext =
  | { kind: "create"; cronConfig?: CronConfig; defaultAgentId?: string; nowMs: number }
  | {
      kind: "patch";
      patch: CronJobPatch;
      defaultAgentId?: string;
      nowMs?: number;
      cronConfig?: CronConfig;
    }
  | {
      kind: "declarative";
      input: CronJobCreate;
      defaultAgentId?: string;
      nowMs: number;
      cronConfig?: CronConfig;
    };

function validateFullJob(
  job: CronStoredJob,
  context: JobValidationContext,
  configuredChannels?: readonly string[],
) {
  const cronConfig = context.cronConfig;
  const triggerTouched =
    context.kind === "create"
      ? job.trigger !== undefined
      : context.kind === "patch"
        ? context.patch.trigger != null
        : context.input.trigger !== undefined;
  const scriptTouched =
    context.kind === "create"
      ? job.payload.kind === "script"
      : context.kind === "patch"
        ? context.patch.payload?.kind === "script"
        : context.input.payload.kind === "script";
  const streamTouched =
    context.kind !== "patch" ||
    context.patch.enabled === true ||
    context.patch.schedule?.kind === "stream";
  const validateCapabilities = () => {
    assertTriggerSupport(job, {
      cronConfig,
      validateAuthoredTrigger: triggerTouched,
    });
    assertScriptPayloadSupport(job, {
      cronConfig,
      requireEnabled: scriptTouched,
      ...(context.kind === "patch" ? { validateSyntax: context.patch.payload !== undefined } : {}),
    });
    assertStreamScheduleSupport(job, { cronConfig, requireEnabled: streamTouched });
  };
  if (context.kind === "declarative") {
    validateCapabilities();
  }
  assertSupportedJobSpec(job);
  assertPacingSupport(job);
  if (context.kind !== "declarative") {
    validateCapabilities();
  }
  assertMainSessionAgentId(job, context.defaultAgentId);
  assertDeliverySupport(job);
  assertAnnounceDeliveryChannelSupport(
    job,
    configuredChannels,
    context.kind === "patch" ? context.patch : undefined,
  );
  assertFailureDestinationSupport(job);
  const scheduleTouched =
    context.kind !== "patch" ||
    context.patch.schedule !== undefined ||
    context.patch.enabled === true;
  if (context.nowMs !== undefined && scheduleTouched) {
    assertTimeScheduleSatisfiable(job, context.nowMs, computeJobNextRunAtMs);
  }
}
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
  const schedule = normalizeJobSchedule(input.schedule, { kind: "create", nowMs: now });
  const deleteAfterRun =
    typeof input.deleteAfterRun === "boolean"
      ? input.deleteAfterRun
      : schedule.kind === "at"
        ? true
        : undefined;
  const enabled = typeof input.enabled === "boolean" ? input.enabled : true;
  const declarationKey = normalizeDeclarativeLabel(input.declarationKey, "declarationKey");
  const displayName = normalizeDeclarativeLabel(input.displayName, "displayName");
  const ownerAgentId = normalizeOptionalAgentId(input.owner?.agentId);
  const ownerSessionKey = normalizeOptionalString(input.owner?.sessionKey);
  const ownerAccountId = normalizeOptionalAccountId(input.owner?.accountId);
  const initialState = { ...input.state } as Partial<CronJobState>;
  // Schedule activation is stamped only by committed scheduling mutations.
  // Accepting caller state here would let imports spoof restart catch-up ownership.
  delete initialState.scheduleActivatedAtMs;
  delete initialState.autoDisabled;
  assertCronJobStateTimestamps(initialState);
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
  validateFullJob(
    job,
    {
      kind: "create",
      cronConfig: state.deps.cronConfig,
      defaultAgentId: state.deps.defaultAgentId,
      nowMs: now,
    },
    opts?.configuredChannels,
  );
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
    const displayName = normalizeDeclarativeLabel(patch.displayName, "displayName", true);
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
    job.schedule = normalizeJobSchedule(patch.schedule, { kind: "patch", previous: job.schedule });
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
  if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook") {
    assertFailureDestinationSupport(job);
    // Retargeting may discard inherited announce routes, but must not silently
    // accept a newly authored delivery request before cleanup.
    const authoredDelivery =
      patch.delivery && mergeCronDelivery(undefined, patch.delivery, "announce");
    if (
      authoredDelivery &&
      (patch.delivery?.mode !== undefined ||
        authoredDelivery.channel !== undefined ||
        authoredDelivery.to !== undefined ||
        authoredDelivery.threadId !== undefined ||
        authoredDelivery.accountId !== undefined ||
        authoredDelivery.completionDestination !== undefined)
    ) {
      assertDeliverySupport({ sessionTarget: job.sessionTarget, delivery: authoredDelivery });
    }
    // Clear-only failure destinations retain their global-default opt-outs.
    const failureDestination = job.delivery?.failureDestination;
    job.delivery = failureDestination ? { mode: "none", failureDestination } : undefined;
  }
  if (patch.state) {
    const statePatch = { ...patch.state } as Partial<CronJobState>;
    // Runtime state patches may report execution progress, but the scheduler
    // alone owns the boundary that decides whether restart catch-up can run.
    delete statePatch.scheduleActivatedAtMs;
    delete statePatch.autoDisabled;
    assertCronJobStateTimestamps(statePatch);
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
  validateFullJob(
    job,
    {
      kind: "patch",
      patch,
      defaultAgentId: opts?.defaultAgentId,
      nowMs: opts?.scheduleValidationNowMs,
      cronConfig: opts?.cronConfig,
    },
    opts?.configuredChannels,
  );
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
  const displayName = normalizeDeclarativeLabel(input.displayName, "displayName");
  if (displayName) {
    job.displayName = displayName;
  } else {
    delete job.displayName;
  }

  job.schedule = normalizeJobSchedule(input.schedule, {
    kind: "declarative",
    previous: job.schedule,
    nowMs: opts.nowMs,
    fallbackAnchorMs: job.createdAtMs,
  });
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
  assertCronJobStateTimestamps(input.state ?? {});
  validateFullJob(
    job,
    {
      kind: "declarative",
      input,
      defaultAgentId: opts.defaultAgentId,
      nowMs: opts.nowMs,
      cronConfig: opts.cronConfig,
    },
    opts.configuredChannels,
  );
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
