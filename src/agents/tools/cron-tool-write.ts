// Agent cron-tool write safety and optimistic update orchestration.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isRecord } from "../../utils.js";
import {
  CRON_CREATOR_AUTHORITY_RECOVERY_MESSAGE,
  INCOMPLETE_CRON_CREATOR_AUTHORITY_MESSAGE,
  isCronCreatorToolCaptureComplete,
  planCronJobUpdatePatch,
} from "./cron-tool-creator-cap.js";
import type {
  CronCreatorToolAllowlistEntry,
  CronCreatorToolAuthoritySnapshot,
  CronToolsAllowCaptureRef,
  GatewayToolCaller,
} from "./cron-tool.types.js";
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
  if (schedule?.kind === "on-exit") {
    throw new Error(
      "automation on-exit schedules cannot be created or edited through the agent automations tool; use the CLI or Gateway API.",
    );
  }
  // Stream argv is authorized by the Gateway's cron.triggers.enabled gate,
  // matching trigger-script trust rather than ordinary agent exec policy.
}

export function assertCronCreatorAuthorityResolutionAvailable(params: {
  required: boolean;
  resolveCreatorToolAuthority?: unknown;
  creatorToolAllowlistCaptureRef?: CronToolsAllowCaptureRef;
  unavailableReason?: "queued-local-operator-configured-mcp";
}): void {
  if (!params.required || params.resolveCreatorToolAuthority) {
    return;
  }
  if (
    params.unavailableReason === "queued-local-operator-configured-mcp" ||
    !isCronCreatorToolCaptureComplete(params.creatorToolAllowlistCaptureRef)
  ) {
    throw new Error(
      params.unavailableReason === "queued-local-operator-configured-mcp"
        ? `Configured MCP authority is unavailable because this local operator turn was queued. ${CRON_CREATOR_AUTHORITY_RECOVERY_MESSAGE}`
        : INCOMPLETE_CRON_CREATOR_AUTHORITY_MESSAGE,
    );
  }
}

async function prepareCronJobUpdateForGateway(params: {
  id: string;
  patch: Record<string, unknown>;
  creatorToolAllowlist: readonly CronCreatorToolAllowlistEntry[] | undefined;
  creatorToolAllowlistCaptureRef?: CronToolsAllowCaptureRef;
  creatorAuthorityComplete: boolean;
  resolveCreatorToolAuthority?: (options?: {
    signal?: AbortSignal;
  }) => Promise<CronCreatorToolAuthoritySnapshot>;
  operationSignal?: AbortSignal;
  creatorAuthorityUnavailableReason?: "queued-local-operator-configured-mcp";
  gatewayOpts: GatewayCallOptions;
  callGateway: GatewayToolCaller;
}): Promise<{
  patch: Record<string, unknown>;
  expectedConfigRevision?: string;
  resolvedAuthority?: CronCreatorToolAuthoritySnapshot;
}> {
  params.operationSignal?.throwIfAborted();
  const initialPlan = planCronJobUpdatePatch({
    patch: params.patch,
    creatorToolAllowlist: params.creatorToolAllowlist,
    creatorAuthorityComplete: params.creatorAuthorityComplete,
  });
  if (initialPlan.kind === "ready") {
    return { patch: initialPlan.patch };
  }

  const existing = await params.callGateway("cron.get", params.gatewayOpts, { id: params.id });
  params.operationSignal?.throwIfAborted();
  const existingRecord = isRecord(existing) ? existing : undefined;
  const expectedConfigRevision = existingRecord?.configRevision;
  if (typeof expectedConfigRevision !== "string" || expectedConfigRevision.length === 0) {
    throw new Error(
      "cron.get response is missing configRevision; restart the Gateway before retrying this update",
    );
  }
  let resolvedAuthority: CronCreatorToolAuthoritySnapshot | undefined;
  let finalPlan = planCronJobUpdatePatch({
    patch: params.patch,
    creatorToolAllowlist: params.creatorToolAllowlist,
    currentJob: existingRecord,
    creatorAuthorityComplete: params.creatorAuthorityComplete,
  });
  if (finalPlan.kind === "needs-creator-authority") {
    assertCronCreatorAuthorityResolutionAvailable({
      required: true,
      resolveCreatorToolAuthority: params.resolveCreatorToolAuthority,
      creatorToolAllowlistCaptureRef: params.creatorToolAllowlistCaptureRef,
      unavailableReason: params.creatorAuthorityUnavailableReason,
    });
    if (!params.resolveCreatorToolAuthority) {
      throw new Error("cron update requires complete creator tool authority");
    }
    resolvedAuthority = await params.resolveCreatorToolAuthority({
      signal: params.operationSignal,
    });
    params.operationSignal?.throwIfAborted();
    finalPlan = planCronJobUpdatePatch({
      patch: params.patch,
      creatorToolAllowlist: resolvedAuthority.tools,
      currentJob: existingRecord,
      creatorAuthorityComplete: true,
    });
  }
  if (finalPlan.kind !== "ready") {
    throw new Error("cron update patch planning did not use the loaded job");
  }
  return { patch: finalPlan.patch, expectedConfigRevision, resolvedAuthority };
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
  creatorToolAllowlistCaptureRef?: CronToolsAllowCaptureRef;
  resolveCreatorToolAuthority?: (options?: {
    signal?: AbortSignal;
  }) => Promise<CronCreatorToolAuthoritySnapshot>;
  withCreatorAuthorityProvenance?: <T>(
    authority: CronCreatorToolAuthoritySnapshot,
    run: () => Promise<T>,
  ) => Promise<T>;
  gatewayOpts: GatewayCallOptions;
  callGateway: GatewayToolCaller;
  operationSignal?: AbortSignal;
  creatorAuthorityUnavailableReason?: "queued-local-operator-configured-mcp";
}): Promise<unknown> {
  const callerIncludedPayloadPatch = isRecord(params.patch.payload);
  let creatorAuthorityPromise: Promise<CronCreatorToolAuthoritySnapshot> | undefined;
  const resolveCreatorToolAuthority = params.resolveCreatorToolAuthority
    ? (options?: { signal?: AbortSignal }) =>
        (creatorAuthorityPromise ??= params.resolveCreatorToolAuthority!(options))
    : undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    params.operationSignal?.throwIfAborted();
    const prepared = await prepareCronJobUpdateForGateway({
      ...params,
      creatorAuthorityComplete:
        isCronCreatorToolCaptureComplete(params.creatorToolAllowlistCaptureRef) &&
        resolveCreatorToolAuthority === undefined &&
        params.creatorAuthorityUnavailableReason === undefined,
      resolveCreatorToolAuthority,
      operationSignal: params.operationSignal,
    });
    if (callerIncludedPayloadPatch) {
      // Kind-less caller payloads inherit the stored kind above. Recheck those
      // edits, but not a toolsAllow cap synthesized internally.
      assertNoCronShellExecution(prepared.patch);
    }
    const payload = isRecord(prepared.patch.payload) ? prepared.patch.payload : undefined;
    const captureSource = prepared.resolvedAuthority
      ? prepared.resolvedAuthority.provenance.source
      : params.creatorToolAllowlistCaptureRef?.value?.source;
    if (
      payload?.toolsAllowIsDefault === true &&
      (prepared.resolvedAuthority || params.creatorToolAllowlistCaptureRef) &&
      captureSource !== "final-executable-surface"
    ) {
      throw new Error(INCOMPLETE_CRON_CREATOR_AUTHORITY_MESSAGE);
    }
    if (prepared.resolvedAuthority && !params.withCreatorAuthorityProvenance) {
      throw new Error(
        "fresh configured MCP cron authority requires an authenticated local agent run",
      );
    }
    try {
      const write = async () => {
        params.operationSignal?.throwIfAborted();
        return await params.callGateway("cron.update", params.gatewayOpts, {
          id: params.id,
          patch: prepared.patch,
          ...(prepared.expectedConfigRevision
            ? { expectedConfigRevision: prepared.expectedConfigRevision }
            : {}),
        });
      };
      return prepared.resolvedAuthority && params.withCreatorAuthorityProvenance
        ? await params.withCreatorAuthorityProvenance(prepared.resolvedAuthority, write)
        : await write();
    } catch (error) {
      if (attempt === 0 && isCronJobConfigRevisionConflict(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("cron update retry exhausted");
}
