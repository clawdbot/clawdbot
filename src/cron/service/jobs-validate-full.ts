/** Full cron job validation orchestration. */
import type { CronConfig } from "../../config/types.cron.js";
import type { CronJobCreate, CronJobPatch, CronStoredJob } from "../types.js";
import { computeJobNextRunAtMs } from "./jobs-scheduling.js";
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
  assertPrecheckSupport,
  assertTriggerSupport,
} from "./jobs-validation.js";

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

export function validateFullJob(
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
  const precheckTouched =
    context.kind === "create"
      ? Boolean(job.precheck?.command)
      : context.kind === "patch"
        ? "precheck" in context.patch && context.patch.precheck != null
        : Boolean(context.input.precheck?.command);
  const validateCapabilities = () => {
    assertTriggerSupport(job, {
      cronConfig,
      validateAuthoredTrigger: triggerTouched,
    });
    assertPrecheckSupport(job, { cronConfig, requireEnabled: precheckTouched });
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
