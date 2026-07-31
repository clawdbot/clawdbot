// Agent cron-tool write safety and optimistic update orchestration.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "../../utils.js";
import { planCronJobUpdatePatch } from "./cron-tool-creator-cap.js";
import type { CronCreatorToolAllowlistEntry, GatewayToolCaller } from "./cron-tool.types.js";
import type { GatewayCallOptions } from "./gateway.js";

export function assertNoCronShellExecution(value: unknown): void {
  if (!isRecord(value)) {
    return;
  }
  const payload = isRecord(value.payload) ? value.payload : undefined;
  if (normalizeLowercaseStringOrEmpty(payload?.kind) === "command") {
    throw new Error(
      "automation command payloads cannot be created or edited through the agent automations tool; use the CLI or Gateway API.",
    );
  }
  const schedule = isRecord(value.schedule) ? value.schedule : undefined;
  // value.kind covers raw flat params before schedule recovery.
  if (schedule?.kind === "on-exit" || value.kind === "on-exit") {
    throw new Error(
      "automation on-exit schedules cannot be created or edited through the agent automations tool; use the CLI or Gateway API.",
    );
  }
  // command/cwd are intentionally not recovered by the model-facing
  // canonicalizer. Reject them before recovery so they cannot be dropped.
  // Stream argv is the one legitimate model-facing exception: it is
  // authorized by the Gateway's cron.triggers.enabled gate, matching
  // trigger-script trust rather than ordinary agent exec policy.
  const isStreamSchedule = schedule?.kind === "stream";
  if (
    value.command !== undefined ||
    value.cwd !== undefined ||
    (!isStreamSchedule && (schedule?.command !== undefined || schedule?.cwd !== undefined))
  ) {
    throw new Error(
      "cron command/cwd fields cannot be set through the agent cron tool; use the CLI or Gateway API.",
    );
  }
  if (isStreamSchedule) {
    // The gateway's CronScheduleSchema requires a complete argv for a stream
    // schedule (schedule as a whole is optional on patches, but a present
    // schedule is never partial), and normalizeCronJobPatch/Create can let a
    // malformed non-array command survive instead of dropping it. Validate
    // the shape here so a bad call fails locally with a clear message
    // instead of a confusing downstream gateway rejection.
    const command = schedule.command;
    const isValidArgv =
      Array.isArray(command) &&
      command.length > 0 &&
      command.every((entry) => typeof entry === "string" && entry.length > 0);
    if (!isValidArgv) {
      throw new Error("cron stream schedules require a non-empty command argv array.");
    }
    if (
      schedule.cwd !== undefined &&
      (typeof schedule.cwd !== "string" || schedule.cwd.length === 0)
    ) {
      throw new Error("cron stream schedule cwd must be a non-empty string.");
    }
  }
}

async function prepareCronJobUpdateForGateway(params: {
  id: string;
  patch: Record<string, unknown>;
  creatorToolAllowlist: readonly CronCreatorToolAllowlistEntry[] | undefined;
  gatewayOpts: GatewayCallOptions;
  callGateway: GatewayToolCaller;
}): Promise<{ patch: Record<string, unknown>; expectedConfigRevision?: string }> {
  const initialPlan = planCronJobUpdatePatch({
    patch: params.patch,
    creatorToolAllowlist: params.creatorToolAllowlist,
  });
  if (initialPlan.kind === "ready") {
    return { patch: initialPlan.patch };
  }

  const existing = await params.callGateway("cron.get", params.gatewayOpts, { id: params.id });
  const existingRecord = isRecord(existing) ? existing : undefined;
  const expectedConfigRevision = existingRecord?.configRevision;
  if (typeof expectedConfigRevision !== "string" || expectedConfigRevision.length === 0) {
    throw new Error(
      "cron.get response is missing configRevision; restart the Gateway before retrying this update",
    );
  }
  const finalPlan = planCronJobUpdatePatch({
    patch: params.patch,
    creatorToolAllowlist: params.creatorToolAllowlist,
    currentJob: existingRecord,
  });
  if (finalPlan.kind !== "ready") {
    throw new Error("cron update patch planning did not use the loaded job");
  }
  return { patch: finalPlan.patch, expectedConfigRevision };
}

function isCronJobConfigRevisionConflict(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== "GatewayClientRequestError") {
    return false;
  }
  const details = isRecord((error as Error & { details?: unknown }).details)
    ? (error as Error & { details: Record<string, unknown> }).details
    : undefined;
  return details?.code === "CRON_JOB_CHANGED";
}

export async function updateCronJobFromAgentTool(params: {
  id: string;
  patch: Record<string, unknown>;
  creatorToolAllowlist: readonly CronCreatorToolAllowlistEntry[] | undefined;
  gatewayOpts: GatewayCallOptions;
  callGateway: GatewayToolCaller;
}): Promise<unknown> {
  const callerIncludedPayloadPatch = isRecord(params.patch.payload);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const prepared = await prepareCronJobUpdateForGateway(params);
    if (callerIncludedPayloadPatch) {
      // Kind-less caller payloads inherit the stored kind above. Recheck those
      // edits, but not a toolsAllow cap synthesized internally.
      assertNoCronShellExecution(prepared.patch);
    }
    try {
      return await params.callGateway("cron.update", params.gatewayOpts, {
        id: params.id,
        patch: prepared.patch,
        ...(prepared.expectedConfigRevision
          ? { expectedConfigRevision: prepared.expectedConfigRevision }
          : {}),
      });
    } catch (error) {
      if (attempt === 0 && isCronJobConfigRevisionConflict(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("cron update retry exhausted");
}
