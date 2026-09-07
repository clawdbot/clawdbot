/** Validation helpers for cron schedules, targets, payloads, and delivery. */
import { parseCodeModeScriptSyntax } from "../../agents/code-mode-script-syntax.js";
import { resolveCronTriggerMinIntervalMs } from "../../config/cron-limits.js";
import type { CronConfig } from "../../config/types.cron.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { compileSafeRegexDetailed } from "../../security/safe-regex.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { parseCronPacingBounds } from "../pacing.js";
import { parseAbsoluteTimeMs } from "../parse.js";
import { assertSafeCronSessionTargetId } from "../session-target.js";
import {
  isSystemOwnedCronPayloadKind,
  type CronDelivery,
  type CronJob,
  type CronJobPatch,
} from "../types.js";
import { normalizeHttpWebhookUrl } from "../webhook-url.js";

function assertCronScriptSyntax(script: string, subject: "script payload" | "trigger script") {
  if (!script.trim()) {
    throw new Error(`cron ${subject} must not be empty`);
  }
  const parsed = parseCodeModeScriptSyntax(script);
  if (!parsed.ok) {
    throw new Error(
      `cron ${subject} has a syntax error: ${parsed.message} (line ${parsed.line}, column ${parsed.column})`,
    );
  }
}

/** Validates that session target and payload kind form a supported cron job shape. */
export function assertSupportedJobSpec(
  job: Pick<CronJob, "schedule" | "sessionTarget" | "payload">,
) {
  if (typeof job.sessionTarget !== "string") {
    throw new Error(
      'cron job is missing sessionTarget; expected "main", "isolated", "current", or "session:<id>"',
    );
  }
  const isIsolatedLike =
    job.sessionTarget === "isolated" ||
    job.sessionTarget === "current" ||
    job.sessionTarget.startsWith("session:");
  if (job.sessionTarget.startsWith("session:")) {
    assertSafeCronSessionTargetId(job.sessionTarget.slice(8));
  }
  if (
    job.sessionTarget === "main" &&
    job.payload.kind !== "systemEvent" &&
    job.payload.kind !== "script" &&
    !isSystemOwnedCronPayloadKind(job.payload.kind)
  ) {
    throw new Error('main cron jobs require payload.kind="systemEvent" or "script"');
  }
  if (
    job.payload.kind === "script" &&
    job.sessionTarget !== "main" &&
    job.sessionTarget !== "isolated"
  ) {
    throw new Error('script cron jobs require sessionTarget="main" or "isolated"');
  }
  if (
    isIsolatedLike &&
    job.payload.kind !== "agentTurn" &&
    job.payload.kind !== "command" &&
    !(job.sessionTarget === "isolated" && job.payload.kind === "script")
  ) {
    throw new Error(
      'isolated cron jobs require payload.kind="agentTurn", "command", or "script"; script payloads do not support current/session targets',
    );
  }
}

export function assertScriptPayloadSupport(
  job: Pick<CronJob, "payload" | "trigger">,
  opts?: { cronConfig?: CronConfig; requireEnabled?: boolean; validateSyntax?: boolean },
) {
  if (job.payload.kind !== "script") {
    return;
  }
  if (opts?.validateSyntax !== false) {
    assertCronScriptSyntax(job.payload.script, "script payload");
  } else if (!job.payload.script.trim()) {
    throw new Error("cron script payload must not be empty");
  }
  if (job.trigger) {
    // Both script kinds expose trigger.state, so composing them would give one
    // persisted state slot two owners and make the next trigger run ambiguous.
    throw new Error("cron script payloads cannot be combined with a condition trigger");
  }
  if (opts?.requireEnabled && opts.cronConfig?.triggers?.enabled === false) {
    throw new Error(
      "cron script payloads are disabled because the operator set cron.triggers.enabled: false; remove it or set it to true to allow unattended scripts",
    );
  }
}

export function assertTriggerSupport(
  job: Pick<CronJob, "schedule" | "trigger">,
  opts?: { cronConfig?: CronConfig; validateAuthoredTrigger?: boolean },
) {
  if (!job.trigger) {
    return;
  }
  if (opts?.validateAuthoredTrigger && opts.cronConfig?.triggers?.enabled === false) {
    throw new Error(
      "cron triggers are disabled because the operator set cron.triggers.enabled: false; remove it or set it to true",
    );
  }
  if (
    job.schedule.kind !== "every" &&
    job.schedule.kind !== "cron" &&
    job.schedule.kind !== "stream"
  ) {
    throw new Error("cron triggers require an every, cron, or stream schedule");
  }
  const minIntervalMs = resolveCronTriggerMinIntervalMs();
  if (job.schedule.kind === "every" && job.schedule.everyMs < minIntervalMs) {
    throw new Error(`cron trigger every interval must be at least ${minIntervalMs}ms`);
  }
  if (opts?.validateAuthoredTrigger) {
    assertCronScriptSyntax(job.trigger.script, "trigger script");
  }
}

export function assertPacingSupport(job: Pick<CronJob, "schedule" | "pacing">) {
  if (job.pacing === undefined) {
    return;
  }
  parseCronPacingBounds(job.pacing);
  if (job.schedule.kind !== "every" && job.schedule.kind !== "cron") {
    throw new Error("cron pacing requires an every or cron schedule");
  }
}

export function assertStreamScheduleSupport(
  job: Pick<CronJob, "schedule" | "payload">,
  opts?: { cronConfig?: CronConfig; requireEnabled?: boolean },
) {
  if (job.schedule.kind !== "stream") {
    return;
  }
  if (opts?.requireEnabled && opts.cronConfig?.triggers?.enabled === false) {
    throw new Error(
      "cron stream schedules are disabled because the operator set cron.triggers.enabled: false; remove it or set it to true",
    );
  }
  const { command, mode = "line", match } = job.schedule;
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    command.some((entry) => typeof entry !== "string" || entry.length === 0)
  ) {
    throw new Error("cron stream schedule requires a non-empty command argv array");
  }
  if (mode !== "line" && mode !== "match") {
    throw new Error('cron stream mode must be "line" or "match"');
  }
  if (mode === "match") {
    if (typeof match !== "string" || !match) {
      throw new Error('cron stream match is required when mode="match"');
    }
    const compiled = compileSafeRegexDetailed(match);
    if (!compiled.regex) {
      throw new Error(`cron stream match is not a safe regular expression (${compiled.reason})`);
    }
  } else if (match !== undefined) {
    throw new Error('cron stream match requires mode="match"');
  }
  if (job.payload.kind === "command") {
    throw new Error("cron stream schedules cannot use command payloads");
  }
}

export function assertTimeScheduleSatisfiable(
  job: CronJob,
  nowMs: number,
  computeJobNextRunAtMs: (job: CronJob, nowMs: number) => number | undefined,
) {
  if (job.schedule.kind === "at") {
    if (parseAbsoluteTimeMs(job.schedule.at) === null) {
      throw new Error("cron at schedule must contain a Date-valid absolute timestamp");
    }
    return;
  }
  if (job.schedule.kind !== "cron" && job.schedule.kind !== "every") {
    return;
  }
  if (computeJobNextRunAtMs({ ...job, enabled: true }, nowMs) !== undefined) {
    return;
  }
  if (job.schedule.kind === "every") {
    throw new Error("cron every schedule has no upcoming run time and would never fire");
  }
  throw new Error(
    `cron expression "${job.schedule.expr}" has no upcoming run time and would never fire`,
  );
}

export function assertMainSessionAgentId(
  job: Pick<CronJob, "sessionTarget" | "agentId" | "payload">,
  defaultAgentId: string | undefined,
  patch?: CronJobPatch,
) {
  // A changed default must not strand stored jobs. Revalidate newly authored bindings and kinds.
  if (
    patch &&
    !("agentId" in patch) &&
    !("sessionTarget" in patch) &&
    patch.payload?.kind === undefined
  ) {
    return;
  }
  if (job.sessionTarget !== "main") {
    return;
  }
  if (!job.agentId) {
    return;
  }
  // Script payloads run no agent turn; system-owned monitors invoke Gateway
  // dependencies directly, so both are valid for non-default agents.
  if (job.payload.kind === "script" || isSystemOwnedCronPayloadKind(job.payload.kind)) {
    return;
  }
  const normalized = normalizeAgentId(job.agentId);
  const normalizedDefault = normalizeAgentId(defaultAgentId);
  if (normalized !== normalizedDefault) {
    throw new Error(
      `cron: sessionTarget "main" is only valid for the default agent. Use sessionTarget "isolated" with payload.kind "agentTurn" for non-default agents (agentId: ${job.agentId})`,
    );
  }
}

export function assertDeliverySupport(job: Pick<CronJob, "sessionTarget" | "delivery">) {
  if (!job.delivery) {
    return;
  }
  // No primary delivery and no completion webhook -- nothing to validate.
  if (job.delivery.mode === "none" && !job.delivery.completionDestination) {
    return;
  }
  // Webhook delivery is allowed for any session target
  if (job.delivery.mode === "webhook") {
    const target = normalizeHttpWebhookUrl(job.delivery.to);
    if (!target) {
      throw new Error("cron webhook delivery requires delivery.to to be a valid http(s) URL");
    }
    job.delivery.to = target;
  }
  if (job.delivery.completionDestination?.mode === "webhook") {
    if (job.delivery.mode !== "announce") {
      throw new Error(
        'cron completion destination webhook is only supported with delivery.mode="announce"',
      );
    }
    const target = normalizeHttpWebhookUrl(job.delivery.completionDestination.to);
    if (!target) {
      throw new Error(
        "cron completion destination webhook requires delivery.completionDestination.to to be a valid http(s) URL",
      );
    }
    job.delivery.completionDestination.to = target;
  }
  if (job.delivery.mode === "none") {
    return;
  }
  if (job.delivery.mode === "webhook") {
    // Webhook delivery is standalone and does not need an isolated chat target.
    return;
  }
  const isIsolatedLike =
    job.sessionTarget === "isolated" ||
    job.sessionTarget === "current" ||
    job.sessionTarget.startsWith("session:");
  if (!isIsolatedLike) {
    throw new Error('cron channel delivery config is only supported for sessionTarget="isolated"');
  }
}

export function assertAnnounceDeliveryChannelSupport(
  job: CronJob,
  configuredChannels?: readonly string[],
  patch?: CronJobPatch,
) {
  if (patch && !cronPatchTouchesDeliveryResolution(patch)) {
    return;
  }
  const plan = resolveCronDeliveryPlan(job);
  const channels = [...new Set(configuredChannels ?? [])].toSorted();
  // Provider-prefix recognition is plugin-backed and may not be loaded at this
  // seam. A prefixed target can still select its channel at runtime, so accept.
  const targetMaySelectChannel = /^[a-z][a-z0-9_-]*:/i.test(plan.to ?? "");
  if (
    job.sessionTarget !== "isolated" ||
    job.sessionKey?.trim() ||
    plan.mode !== "announce" ||
    (plan.channel !== undefined && plan.channel !== "last") ||
    targetMaySelectChannel ||
    job.delivery?.bestEffort === true ||
    channels.length < 2
  ) {
    return;
  }
  throw new Error(
    `cron announce delivery requires an explicit channel when multiple channels are configured (${channels.join(", ")}): set --channel <id> or use --best-effort-deliver`,
  );
}

export function cronPatchTouchesDeliveryResolution(patch: CronJobPatch): boolean {
  // Legacy ambiguous jobs must remain disableable and renameable. Only fields
  // that can change the delivery identity opt a patch back into validation.
  return (
    patch.delivery !== undefined ||
    patch.sessionTarget !== undefined ||
    "agentId" in patch ||
    "sessionKey" in patch
  );
}

function hasConcreteFailureDestination(
  destination: CronDelivery["failureDestination"] | undefined,
): boolean {
  return Boolean(
    destination &&
    (destination.channel !== undefined ||
      destination.to !== undefined ||
      destination.accountId !== undefined ||
      destination.mode !== undefined),
  );
}

export function assertFailureDestinationSupport(job: Pick<CronJob, "sessionTarget" | "delivery">) {
  const failureDestination = job.delivery?.failureDestination;
  if (!failureDestination) {
    return;
  }
  if (!hasConcreteFailureDestination(failureDestination)) {
    return;
  }
  if (job.sessionTarget === "main" && job.delivery?.mode !== "webhook") {
    throw new Error(
      'cron delivery.failureDestination is only supported for sessionTarget="isolated" unless delivery.mode="webhook"',
    );
  }
  if (failureDestination.mode === "webhook") {
    const target = normalizeHttpWebhookUrl(failureDestination.to);
    if (!target) {
      throw new Error(
        "cron failure destination webhook requires delivery.failureDestination.to to be a valid http(s) URL",
      );
    }
    failureDestination.to = target;
  }
}
