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
      "cron command payloads cannot be created or edited through the agent cron tool; use the CLI or Gateway API.",
    );
  }
  const schedule = isRecord(value.schedule) ? value.schedule : undefined;
  if (schedule?.kind === "on-exit") {
    throw new Error(
      "cron on-exit schedules cannot be created or edited through the agent cron tool; use the CLI or Gateway API.",
    );
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
