/** Consent-gated Gateway owner for one sanitized failed-update report. */
import {
  ErrorCodes,
  validateUpdateReportParams,
  validateUpdateReportResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_OWNER_PROFILE_ID } from "../../../packages/gateway-protocol/src/schema/users.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import { PACKAGE_POST_INSTALL_DOCTOR_ADVISORY } from "../../infra/update-doctor-result.js";
import {
  prepareUpdateFailureReport,
  submitUpdateFailureReport,
  type UpdateFailureReportInput,
  type UpdateFailureReportSubmitResult,
} from "../../infra/update-failure-report.js";
import { findActiveUpdateRun, listUpdateRuns } from "../../infra/update-run-ledger.js";
import { classifyUpdateOutcome, isReportableUpdateRun } from "../../shared/update-outcome.js";
import { refreshLatestUpdateRestartSentinel } from "../server-restart-sentinel.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function readIdentity(value: Record<string, unknown> | null | undefined) {
  return value
    ? {
        ...(typeof value.sha === "string" ? { sha: value.sha } : {}),
        ...(typeof value.version === "string" ? { version: value.version } : {}),
        ...(typeof value.buildId === "string" ? { buildId: value.buildId } : {}),
        ...(typeof value.upstreamRef === "string" ? { upstreamRef: value.upstreamRef } : {}),
      }
    : undefined;
}

function projectReportInput(payload: RestartSentinelPayload): UpdateFailureReportInput | null {
  if (
    payload.kind !== "update" ||
    classifyUpdateOutcome({
      status: payload.status,
      reason: payload.stats?.reason ?? undefined,
    }) !== "failed" ||
    !payload.stats
  ) {
    return null;
  }
  const stats = payload.stats;
  const mode =
    stats.mode === "git" || stats.mode === "pnpm" || stats.mode === "bun" || stats.mode === "npm"
      ? stats.mode
      : "unknown";
  const recovery = stats.recovery;
  return {
    attemptId: stats.runId?.trim() || stats.handoffId?.trim() || `recorded:${payload.ts}`,
    result: {
      status: payload.status,
      mode,
      ...(typeof stats.reason === "string" ? { reason: stats.reason } : {}),
      ...(readIdentity(stats.before) ? { before: readIdentity(stats.before) } : {}),
      ...(readIdentity(stats.after) ? { after: readIdentity(stats.after) } : {}),
      steps: (stats.steps ?? []).map((step) => {
        const projected: UpdateFailureReportInput["result"]["steps"][number] = {
          name: step.name,
          command: "",
          cwd: "",
          durationMs: step.durationMs ?? 0,
          exitCode: step.log?.exitCode ?? null,
        };
        if (step.advisory) {
          projected.advisory = PACKAGE_POST_INSTALL_DOCTOR_ADVISORY;
        }
        return projected;
      }),
      durationMs: stats.durationMs ?? 0,
      ...(recovery ? { recovery } : {}),
    },
    ...(stats.target ? { target: stats.target } : {}),
  };
}

async function readCurrentReportInput(hasCurrentAuthority: () => boolean) {
  const sentinel = await refreshLatestUpdateRestartSentinel();
  if (!hasCurrentAuthority()) {
    return null;
  }
  // Match update.status authority, not a legacy sentinel's timestamp. Only
  // same-run evidence may enrich a ledger row; reads never create a store.
  const run = findActiveUpdateRun() ?? listUpdateRuns({ limit: 1 })[0];
  if (!run) {
    return sentinel ? projectReportInput(sentinel) : null;
  }
  if (!isReportableUpdateRun(run)) {
    return null;
  }
  const matching =
    sentinel?.stats?.runId === run.runId && sentinel.stats.reason === run.reason
      ? projectReportInput(sentinel)
      : null;
  const target =
    run.target.sha ??
    run.target.version ??
    run.target.tag ??
    (run.target.channel ? `${run.target.channel} channel` : matching?.target);
  const input: UpdateFailureReportInput = {
    attemptId: run.runId,
    ...(target ? { target } : {}),
    result: {
      status: "error",
      mode: matching?.result.mode ?? (run.target.kind === "git" ? "git" : "unknown"),
      ...(run.reason ? { reason: run.reason } : {}),
      before: readIdentity(run.before),
      after: readIdentity(run.after),
      durationMs: Math.max(0, (run.finishedAtMs ?? run.updatedAtMs) - run.createdAtMs),
      steps: run.steps
        .filter((step) => step.status === "failed")
        .map((step) => ({
          name: step.step,
          command: "",
          cwd: "",
          durationMs: Math.max(0, (step.endedAtMs ?? 0) - (step.startedAtMs ?? 0)),
          exitCode:
            matching?.result.steps.find((entry) => !entry.advisory && entry.name === step.step)
              ?.exitCode ?? null,
        })),
      // The ledger's rolled-back label is not a verification receipt. Only
      // the same failed attempt's final sentinel can supply rollback facts.
      ...(matching?.result.recovery ? { recovery: matching.result.recovery } : {}),
    },
  };
  return input;
}

function projectPublicSubmitResult(
  result: Exclude<UpdateFailureReportSubmitResult, { status: "stale" }>,
) {
  if (result.status === "created") {
    return {
      status: result.status,
      url: result.url,
      ...(result.message ? { message: result.message } : {}),
    };
  }
  if (result.status === "fallback") {
    return {
      status: result.status,
      fallbackUrl: result.fallbackUrl,
      message: result.message,
    };
  }
  return {
    status: result.status,
    message: result.message,
    ...(result.url ? { url: result.url } : {}),
    ...(result.fallbackUrl ? { fallbackUrl: result.fallbackUrl } : {}),
  };
}

function hasUpdateReportOwnerAuthority(
  client: Parameters<GatewayRequestHandlers["update.report"]>[0]["client"],
): boolean {
  return (
    client?.internal?.operatorRoleActor?.kind === "system" ||
    client?.authenticatedUserProfile?.profileId === GATEWAY_OWNER_PROFILE_ID
  );
}

export const updateReportHandler: GatewayRequestHandlers["update.report"] = async ({
  client,
  context,
  hasCurrentClientAuthority,
  params,
  respond,
}) => {
  if (!assertValidParams(params, validateUpdateReportParams, "update.report", respond)) {
    return;
  }
  if (!hasCurrentClientAuthority) {
    respond(false, undefined, {
      code: "INVALID_REQUEST",
      message: "Update report access requires a current authenticated client.",
    });
    return;
  }
  if (!hasUpdateReportOwnerAuthority(client)) {
    respond(false, undefined, {
      code: ErrorCodes.FORBIDDEN,
      message: "Update failure reports require gateway-owner or system administrator authority.",
    });
    return;
  }
  // Unlike ordinary admitted RPCs, report consent ends with its originating connection.
  // A delegated caller must also retain its run claim through the final effect.
  const runtimeIdentity = client?.internal?.agentRuntimeIdentity;
  const hasCurrentReportAuthority = () =>
    !client?.connectionSignal?.aborted &&
    hasCurrentClientAuthority() &&
    (!runtimeIdentity ||
      context.validateAgentRuntimeApprovalAuthority?.(runtimeIdentity) === true) &&
    hasUpdateReportOwnerAuthority(client);
  if (!hasCurrentReportAuthority()) {
    return;
  }
  try {
    const input = await readCurrentReportInput(hasCurrentReportAuthority);
    if (!hasCurrentReportAuthority()) {
      return;
    }
    if (!input || input.attemptId !== params.attemptId) {
      respond(false, undefined, {
        code: "INVALID_REQUEST",
        message: "This failed update attempt is stale or unavailable.",
      });
      return;
    }
    const prepared = await prepareUpdateFailureReport(input);
    if (!hasCurrentReportAuthority()) {
      return;
    }
    let result;
    if (params.action === "preview") {
      if (!hasCurrentReportAuthority()) {
        return;
      }
      result = {
        status: "ready" as const,
        attemptId: prepared.attemptId,
        body: prepared.body,
        previewDigest: prepared.previewDigest,
        title: prepared.title,
      };
    } else {
      const submitted = await submitUpdateFailureReport(prepared, params.previewDigest, {
        hasCurrentAuthority: hasCurrentReportAuthority,
        validateCurrentAttempt: async () => {
          const currentInput = await readCurrentReportInput(hasCurrentReportAuthority);
          if (currentInput?.attemptId !== params.attemptId) {
            return false;
          }
          const currentPrepared = await prepareUpdateFailureReport(currentInput);
          return currentPrepared.previewDigest === prepared.previewDigest;
        },
      });
      if (submitted.status === "stale") {
        respond(false, undefined, {
          code: "INVALID_REQUEST",
          message: submitted.message,
        });
        return;
      }
      result = projectPublicSubmitResult(submitted);
    }
    if (!validateUpdateReportResult(result)) {
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: "update report status is temporarily unavailable",
      });
      return;
    }
    respond(true, result);
  } catch {
    respond(false, undefined, {
      code: "INVALID_REQUEST",
      message: "Update report could not be prepared safely.",
    });
  }
};
