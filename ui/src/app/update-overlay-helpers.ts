import type { UpdateRunRecord } from "../../../src/infra/update-run-record.js";
import { renderUpdateRunReport } from "../../../src/infra/update-run-report.js";
import { classifyUpdateOutcome } from "../../../src/shared/update-outcome.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { formatUiExternalText } from "../lib/format-error.ts";
import { readUpdateAvailableValue, readUpdateScheduleValue } from "./update-schedule-dto.ts";

export type ApplicationStatusBanner = {
  source?: "read";
  tone: "danger" | "warn" | "info";
  text: string;
};

export type RecordedUpdateAttempt = {
  timestampMs: number;
  status: string;
  reason: string;
  installKind: string | null;
  beforeVersion: string | null;
  beforeSha: string | null;
  afterVersion: string | null;
  afterSha: string | null;
  failure: UpdateFailureCause | null;
};

export type UpdateFailureTriage = {
  id: string;
  outcome: "failed" | "unknown";
  attempt: RecordedUpdateAttempt | null;
  banner: ApplicationStatusBanner;
  reconciledRecord?: UpdateOutcomeRecord;
};

type UpdateOutcomeRecord = { id: string | null; timestampMs: number | null };

export type UpdateTriageAdmission = {
  isCurrent: () => boolean;
  admit: () => boolean;
};

const UPDATE_FAILURE_REASON_KEYS: Record<string, string> = {
  dirty: "updates.failureReasons.dirty",
  "no-upstream": "updates.failureReasons.noUpstream",
  "not-git-install": "updates.failureReasons.notGitInstall",
  "not-openclaw-root": "updates.failureReasons.notOpenclawRoot",
  "deps-install-failed": "updates.failureReasons.depsInstallFailed",
  "build-failed": "updates.failureReasons.buildFailed",
  "build-dirty": "updates.failureReasons.buildDirty",
  "ui-build-failed": "updates.failureReasons.uiBuildFailed",
  "global-install-failed": "updates.failureReasons.globalInstallFailed",
  "restart-disabled": "updates.failureReasons.restartDisabled",
  "restart-unavailable": "updates.failureReasons.restartUnavailable",
  "restart-unhealthy": "updates.failureReasons.restartUnhealthy",
  "restart-revision-mismatch": "updates.failureReasons.restartRevisionMismatch",
  "restart-revision-unavailable": "updates.failureReasons.restartRevisionUnavailable",
  "already-current": "updates.failureReasons.alreadyCurrent",
  "managed-service-handoff-already-running":
    "updates.failureReasons.managedServiceHandoffAlreadyRunning",
  "managed-service-handoff-unavailable": "updates.failureReasons.managedServiceHandoffUnavailable",
  "doctor-failed": "updates.failureReasons.doctorFailed",
  // The detached helper owns these; its output never reaches the gateway log,
  // so the default "see the gateway logs" guidance would send operators nowhere.
  "managed-service-handoff-failed": "updates.failureReasons.managedServiceHandoffFailed",
  "managed-service-handoff-spawn-failed": "updates.failureReasons.managedServiceHandoffSpawnFailed",
  "managed-service-handoff-helper-failed": "updates.failureReasons.managedServiceHandoffFailed",
  "managed-service-handoff-parent-timeout":
    "updates.failureReasons.managedServiceHandoffParentTimeout",
};
// One line is enough to name the cause; the full tail belongs in the CLI.
const MAX_UPDATE_FAILURE_CAUSE_CHARS = 180;

type UpdateSentinelStep = {
  name?: string | null;
  log?: {
    stdoutTail?: string | null;
    stderrTail?: string | null;
    exitCode?: number | null;
  } | null;
};

export type UpdateRestartStatusResponse = {
  activeRun?: UpdateRunRecord;
  lastRun?: UpdateRunRecord;
  sentinel?: {
    kind?: string;
    status?: string;
    ts?: number;
    stats?: {
      mode?: string | null;
      reason?: string | null;
      runId?: string | null;
      handoffId?: string | null;
      before?: { sha?: string | null; version?: string | null } | null;
      after?: { sha?: string | null; version?: string | null } | null;
      steps?: UpdateSentinelStep[] | null;
    } | null;
  } | null;
  updateAvailable?: UpdateAvailable | null;
  schedule?: UpdateScheduleState;
};

type UpdateFailureCause = { step: string; detail: string };

function readUpdateAttemptId(sentinel: UpdateRestartStatusResponse["sentinel"]): string | null {
  const id = sentinel?.stats?.runId?.trim() || sentinel?.stats?.handoffId?.trim();
  return id && id.length <= 256 ? id : null;
}

/** One projection owns the recorded display facts and the typed triage transition. */
export function projectUpdateSentinel(
  sentinel: UpdateRestartStatusResponse["sentinel"],
  requestId?: string,
): {
  outcome: ReturnType<typeof classifyUpdateOutcome>;
  record: UpdateOutcomeRecord;
  attempt: RecordedUpdateAttempt | null;
  banner: ApplicationStatusBanner | null;
  failure: UpdateFailureTriage | null;
} | null {
  if (sentinel?.kind !== "update" || !sentinel.status) {
    return null;
  }
  const stats = sentinel.stats;
  const outcome = classifyUpdateOutcome({
    status: sentinel.status,
    reason: stats?.reason ?? undefined,
  });
  const showResult = outcome !== "succeeded" && outcome !== "pending";
  const cause = showResult ? readUpdateFailureCause(sentinel) : null;
  const attempt =
    showResult && typeof sentinel.ts === "number"
      ? {
          timestampMs: sentinel.ts,
          status: sentinel.status,
          reason: stats?.reason?.trim() || "unexpected-error",
          installKind: stats?.mode?.trim() || null,
          beforeVersion: stats?.before?.version?.trim() || null,
          beforeSha: stats?.before?.sha?.trim() || null,
          afterVersion: stats?.after?.version?.trim() || null,
          afterSha: stats?.after?.sha?.trim() || null,
          failure: cause,
        }
      : null;
  const banner = showResult
    ? resolveUpdateStatusBanner({
        status: sentinel.status,
        reason: stats?.reason ?? undefined,
        cause,
      })
    : null;
  if (banner && outcome === "failed") {
    banner.text += ` ${t("updates.triage.hostHint")}`;
  }
  const record = {
    id:
      readUpdateAttemptId(sentinel) ??
      (typeof sentinel.ts === "number" ? `recorded:${sentinel.ts}` : null),
    timestampMs: sentinel.ts ?? null,
  };
  const id = record.id ?? requestId;
  const failure: UpdateFailureTriage | null =
    outcome === "failed" && id && banner ? { id, outcome, attempt, banner } : null;
  // A response can carry a newer failure than the persisted status record.
  if (failure && (record.id !== null || record.timestampMs !== null)) {
    failure.reconciledRecord = record;
  }
  return {
    outcome,
    record,
    attempt,
    banner,
    failure,
  };
}

function lastLogLine(tail: string | null | undefined): string | null {
  // Redact before clipping: a truncated URL can lose its credential delimiter.
  const lines = formatUiExternalText(tail)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  return last ? last.slice(0, MAX_UPDATE_FAILURE_CAUSE_CHARS) : null;
}

/**
 * The updater records why it stopped — the failing step plus its captured
 * output — in the restart sentinel. Read that recorded fact instead of making
 * the operator reconstruct a disk-full or build failure from a reason slug.
 */
function readUpdateFailureCause(
  sentinel: UpdateRestartStatusResponse["sentinel"],
): UpdateFailureCause | null {
  const steps = sentinel?.stats?.steps;
  // The run stops at its first failure, so the last non-zero exit is the cause.
  const failed = Array.isArray(steps)
    ? steps.findLast((step) => typeof step?.log?.exitCode === "number" && step.log.exitCode !== 0)
    : undefined;
  const detail = lastLogLine(failed?.log?.stderrTail) ?? lastLogLine(failed?.log?.stdoutTail);
  const step = failed?.name?.trim();
  return step && detail ? { step, detail } : null;
}

export type UpdateRunResponse = {
  runId?: string;
  ok?: boolean;
  result?: {
    status?: string;
    reason?: string;
    before?: { sha?: string | null; version?: string | null } | null;
    after?: { sha?: string | null; version?: string | null } | null;
  };
  handoff?: { status?: string };
  restart?: { coalesced?: boolean } | null;
  sentinel?: { payload?: UpdateRestartStatusResponse["sentinel"] } | null;
};

async function requestUpdateRestartStatus(
  client: Pick<GatewayBrowserClient, "request">,
  timeoutMs: number,
  request: { refreshCheckout?: true } = {},
  onError?: (error: unknown) => void,
): Promise<UpdateRestartStatusResponse | null> {
  try {
    return await client.request<UpdateRestartStatusResponse>("update.status", request, {
      timeoutMs,
    });
  } catch (error) {
    onError?.(error);
    return null;
  }
}

export function createUpdateStatusRefresher(params: {
  getClient: () => GatewayBrowserClient | null;
  getEpoch: () => number;
  getRevision: () => number;
  canRefresh: () => boolean;
  isCurrent: (client: GatewayBrowserClient, epoch: number) => boolean;
  onRefreshing: (refreshing: boolean) => void;
  onStatus: (response: UpdateRestartStatusResponse) => void;
  onError: (error: unknown) => void;
}) {
  let generation = 0;
  let manualIsCurrent: (() => boolean) | null = null;
  return async (mode: "manual" | "background" | "completion" = "manual") => {
    const client = params.getClient();
    const epoch = params.getEpoch();
    if (
      !client ||
      !params.canRefresh() ||
      !params.isCurrent(client, epoch) ||
      (mode === "background" && manualIsCurrent?.())
    ) {
      return;
    }
    const refreshCheckout = mode === "manual";
    const operationGeneration = ++generation;
    const revision = params.getRevision();
    const ownsRequest = () => operationGeneration === generation && params.isCurrent(client, epoch);
    const isCurrent = () =>
      ownsRequest() && params.canRefresh() && revision === params.getRevision();
    if (refreshCheckout) {
      manualIsCurrent = isCurrent;
      params.onRefreshing(true);
    }
    try {
      const response = await requestUpdateRestartStatus(
        client,
        5_000,
        refreshCheckout ? { refreshCheckout: true } : {},
        (error) => {
          if (mode !== "background" && isCurrent()) {
            params.onError(error);
          }
        },
      );
      if (response && isCurrent()) {
        params.onStatus(response);
      }
    } finally {
      if (ownsRequest()) {
        manualIsCurrent = null;
        params.onRefreshing(false);
      }
    }
  };
}

/** Retained pre-ledger sentinels remain readable across a stable upgrade. */
export function projectUpdateStatusResponse(
  response: UpdateRestartStatusResponse,
  current: {
    updateStatusBanner: ApplicationStatusBanner | null;
    recordedUpdateAttempt: RecordedUpdateAttempt | null;
    heldUpdateCampaignId: string | null;
  },
) {
  const result = projectUpdateSentinel(response.sentinel);
  const updateSchedule = Object.hasOwn(response, "schedule")
    ? readUpdateScheduleValue(response.schedule)
    : undefined;
  return {
    failure: result?.failure ?? null,
    updateStatusBanner: result ? result.banner : current.updateStatusBanner,
    recordedUpdateAttempt: result ? result.attempt : current.recordedUpdateAttempt,
    ...(Object.hasOwn(response, "updateAvailable")
      ? { updateAvailable: readUpdateAvailableValue(response.updateAvailable) }
      : {}),
    ...(updateSchedule !== undefined
      ? {
          updateSchedule,
          heldUpdateCampaignId:
            updateSchedule?.campaign?.holdUntilMs !== undefined
              ? updateSchedule.campaign.id
              : current.heldUpdateCampaignId,
        }
      : {}),
  };
}

export function projectUpdateRunFailure(run: UpdateRunRecord): UpdateFailureTriage | null {
  if (run.status !== "failed" && run.status !== "rolled-back") {
    return null;
  }
  const step = run.steps.findLast((entry) => entry.status === "failed");
  return {
    id: run.runId,
    reconciledRecord: { id: run.runId, timestampMs: run.finishedAtMs ?? run.updatedAtMs },
    outcome: "failed",
    banner: { tone: "danger", text: renderUpdateRunReport(run).markdown },
    attempt: {
      timestampMs: run.finishedAtMs ?? run.updatedAtMs,
      status: run.status,
      reason: run.reason ?? "unexpected-error",
      installKind: run.target.kind ?? null,
      beforeVersion: run.before.version ?? null,
      beforeSha: run.before.sha ?? null,
      afterVersion: run.after.version ?? null,
      afterSha: run.after.sha ?? null,
      failure: step ? { step: step.step, detail: step.detail ?? "" } : null,
    },
  };
}

export function resolveUpdateStatusBanner(params: {
  status?: string;
  reason?: string;
  cause?: UpdateFailureCause | null;
}): ApplicationStatusBanner {
  const status = (params.status ?? "error").trim() || "error";
  const reason = (params.reason ?? "unexpected-error").trim() || "unexpected-error";
  const guidance = t(UPDATE_FAILURE_REASON_KEYS[reason] ?? "updates.failureReasons.default");
  const cause = params.cause;
  return {
    tone: status === "skipped" ? "warn" : "danger",
    // A recorded cause names what actually broke; the reason slug only names
    // which step owned it.
    text: cause
      ? `${t("updates.failedAtStep", { step: cause.step, cause: cause.detail })} ${guidance}`
      : t("updates.status", { status, reason, guidance }),
  };
}

export function resolveUnknownUpdateOutcomeBanner(): ApplicationStatusBanner {
  return {
    tone: "danger",
    text: t("updates.outcomeUnknown"),
  };
}
