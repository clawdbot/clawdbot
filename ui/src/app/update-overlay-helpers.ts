import { classifyUpdateOutcome } from "../../../src/shared/update-outcome.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { formatUiExternalText } from "../lib/format-error.ts";
import { readUpdateAvailableValue, readUpdateScheduleValue } from "./update-schedule-dto.ts";

export type ApplicationStatusBanner = {
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
  verification?: Pick<PendingUpdateReconciliation, "expectedVersion" | "expectedSha" | "handoffId">;
};

type UpdateOutcomeRecord = { id: string | null; timestampMs: number | null };

export type UpdateTriageAdmission = {
  isCurrent: () => boolean;
  admit: () => boolean;
};

const UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";
const UPDATE_RESTART_VERIFICATION_POLL_MS = 250;
const UPDATE_RESTART_VERIFICATION_TIMEOUT_MS = 10_000;
const UPDATE_HANDOFF_POLL_MS = 1_000;
// Manual update.run uses a 30-minute command budget plus restart grace.
// Automatic campaigns own their separate server-side deadline.
export const UPDATE_HANDOFF_TIMEOUT_MS = 35 * 60_000;
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
  sentinel?: {
    kind?: string;
    status?: string;
    ts?: number;
    stats?: {
      mode?: string | null;
      reason?: string | null;
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

function readUpdateHandoffId(sentinel: UpdateRestartStatusResponse["sentinel"]): string | null {
  const id = sentinel?.stats?.handoffId?.trim();
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
      readUpdateHandoffId(sentinel) ??
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

/**
 * Reads what an `update.run` answer means for reconciliation. The RPC answers
 * long before a managed handoff finishes, so an accepted request yields the
 * pending record to verify after the restart, not an outcome.
 */
export function classifyUpdateRunResponse(
  response: UpdateRunResponse,
  pending: PendingUpdateReconciliation,
): { pending: PendingUpdateReconciliation; banner: ApplicationStatusBanner | null } | null {
  const status = response.result?.status ?? (response.ok === true ? "ok" : "error");
  const expectedVersion = response.result?.after?.version?.trim() || pending.expectedVersion;
  const expectedSha = response.result?.after?.sha?.trim() || pending.expectedSha;
  const handoffId = readUpdateHandoffId(response.sentinel?.payload) ?? pending.handoffId;
  const record = projectUpdateSentinel(response.sentinel?.payload)?.record ?? pending.record;
  const admitted = { ...pending, expectedVersion, expectedSha, handoffId, record };
  if (
    response.ok === true &&
    status === "skipped" &&
    response.result?.reason === UPDATE_HANDOFF_STARTED_REASON &&
    response.handoff?.status === "started"
  ) {
    return {
      pending: { ...admitted, kind: "handoff" },
      banner: null,
    };
  }
  if (response.ok === true && status === "ok") {
    return {
      pending: { ...admitted, kind: "restart" },
      banner:
        response.restart?.coalesced === true
          ? { tone: "info", text: t("updates.coalescedRestart") }
          : null,
    };
  }
  return null;
}

export function resolveExpectedUpdateSha(
  schedule: UpdateScheduleState | null,
  updateAvailable: UpdateAvailable | null,
): string | null {
  return schedule?.target?.kind === "git"
    ? schedule.target.upstreamSha.trim() || null
    : updateAvailable?.upstreamSha?.trim() || null;
}

export type PendingUpdateReconciliation = {
  requestId: string;
  profileId: string | null;
  expectedVersion: string | null;
  expectedSha: string | null;
  // Without a handoff id or learned server record, installed identity alone
  // cannot distinguish identical attempts after a lost response.
  handoffId: string | null;
  // Server timestamps order different attempts; the same handoff may finish
  // without changing its timestamp. Never compare them to the browser clock.
  record?: UpdateOutcomeRecord;
  deadlineAtMs: number;
  kind: "ambiguous" | "handoff" | "restart";
};

type UpdateVerificationWait = {
  timer: ReturnType<typeof globalThis.setTimeout>;
  resolve: (active: boolean) => void;
};

function commitsMatch(left: string, right: string): boolean {
  const normalizedLeft = left.trim().toLowerCase();
  const normalizedRight = right.trim().toLowerCase();
  return (
    normalizedLeft.length >= 7 &&
    normalizedRight.length >= 7 &&
    (normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft))
  );
}

function matchesUpdateIdentity(
  expected: { expectedVersion: string | null; expectedSha: string | null },
  actualVersion: string | null,
  actualSha: string | null,
): boolean {
  return (
    (!expected.expectedVersion || actualVersion === expected.expectedVersion) &&
    (!expected.expectedSha ||
      (actualSha !== null && commitsMatch(expected.expectedSha, actualSha))) &&
    (actualVersion !== null || actualSha !== null)
  );
}

function classifyUpdateObservation(
  target: UpdateFailureTriage["verification"],
  record: UpdateOutcomeRecord | undefined,
  result: NonNullable<ReturnType<typeof projectUpdateSentinel>>,
  sentinel: UpdateRestartStatusResponse["sentinel"],
): "same" | "newer" | "pending" | "verified" | "unrelated" {
  const handoffId = target?.handoffId;
  if (
    (result.record.id !== null && result.record.id === (handoffId ?? record?.id)) ||
    (!handoffId && record?.timestampMs != null && result.record.timestampMs === record.timestampMs)
  ) {
    return "same";
  }
  if (
    record?.timestampMs != null &&
    result.record.timestampMs != null &&
    result.record.timestampMs > record.timestampMs
  ) {
    return "newer";
  }
  // Without server ordering, retained terminal records cannot identify this request.
  // A live handoff can teach its identity; a success needs a concrete expected revision.
  if (!handoffId && !record) {
    if (result.outcome === "pending") {
      return "pending";
    }
    if (
      result.outcome === "succeeded" &&
      target &&
      (target.expectedVersion || target.expectedSha) &&
      matchesUpdateIdentity(
        target,
        sentinel?.stats?.after?.version?.trim() || null,
        sentinel?.stats?.after?.sha?.trim() || null,
      )
    ) {
      return "verified";
    }
  }
  return "unrelated";
}

export function createUpdateVerificationController(params: {
  getPending: () => PendingUpdateReconciliation | null;
  updatePending: (pending: PendingUpdateReconciliation) => void;
  clearPending: () => void;
  isCurrent: (client: GatewayBrowserClient, epoch: number) => boolean;
  publish: () => void;
  publishBanner: (banner: ApplicationStatusBanner | null) => void;
  publishRecordedAttempt?: (attempt: RecordedUpdateAttempt | null) => void;
  publishFailure: (failure: UpdateFailureTriage, profileId: string | null) => void;
  onVerifiedInstall?: (identity: { version: string | null; sha: string | null }) => void;
}) {
  let generation = 0;
  let wait: UpdateVerificationWait | null = null;
  const settleWait = (active: boolean) => {
    if (!wait) {
      return;
    }
    const current = wait;
    wait = null;
    globalThis.clearTimeout(current.timer);
    current.resolve(active);
  };
  const cancel = () => {
    generation += 1;
    settleWait(false);
  };
  const finishVerification = (
    reconciliation: PendingUpdateReconciliation,
    outcome: "failed" | "unknown",
    banner: ApplicationStatusBanner,
  ) => {
    params.clearPending();
    params.publishFailure(
      {
        id: reconciliation.handoffId ?? reconciliation.record?.id ?? reconciliation.requestId,
        outcome,
        attempt: null,
        banner,
        reconciledRecord: reconciliation.record,
        verification: {
          expectedVersion: reconciliation.expectedVersion,
          expectedSha: reconciliation.expectedSha,
          handoffId: reconciliation.handoffId,
        },
      },
      reconciliation.profileId,
    );
  };
  const expire = (banner: ApplicationStatusBanner) => {
    const reconciliation = params.getPending();
    if (reconciliation) {
      cancel();
      finishVerification(reconciliation, "unknown", banner);
    }
  };
  const waitForNextPoll = (delayMs: number, currentGeneration: number) =>
    new Promise<boolean>((resolve) => {
      settleWait(false);
      const timer = globalThis.setTimeout(() => {
        if (wait?.timer !== timer) {
          return;
        }
        wait = null;
        resolve(currentGeneration === generation);
      }, delayMs);
      wait = { timer, resolve };
    });
  const verify = async (client: GatewayBrowserClient, epoch: number) => {
    const currentGeneration = ++generation;
    settleWait(false);
    const reconciliation = params.getPending();
    if (!reconciliation) {
      return;
    }
    const isCurrent = () =>
      currentGeneration === generation &&
      params.getPending() === reconciliation &&
      params.isCurrent(client, epoch);
    const verificationKind = reconciliation.kind === "handoff" ? "handoff" : "restart";
    let { deadline, pollMs } = resolveUpdateVerificationWindow(verificationKind);
    deadline = Math.min(deadline, reconciliation.deadlineAtMs);
    while (isCurrent() && Date.now() < deadline) {
      const response = await requestUpdateRestartStatus(client, Math.max(0, deadline - Date.now()));
      if (!isCurrent()) {
        return;
      }
      const candidate = response?.sentinel;
      const observed = projectUpdateSentinel(candidate, reconciliation.requestId);
      const relation = observed
        ? classifyUpdateObservation(reconciliation, reconciliation.record, observed, candidate)
        : "unrelated";
      // A retained result from an earlier attempt is not this handoff's outcome,
      // even when both installs have the same package version.
      const result = observed && relation !== "unrelated" ? observed : null;
      const sentinel = result ? candidate : null;
      const outcome = result?.outcome;
      if (result) {
        const superseded = relation === "newer";
        const handoffId =
          readUpdateHandoffId(sentinel) ?? (superseded ? null : reconciliation.handoffId);
        const promoted = outcome === "pending" && reconciliation.kind !== "handoff";
        const changed =
          promoted ||
          handoffId !== reconciliation.handoffId ||
          reconciliation.record?.id !== result.record.id ||
          reconciliation.record?.timestampMs !== result.record.timestampMs;
        // A lost RPC may reveal its handoff only here. Persist the accepted
        // server identity before reload or expiry can retire this verifier.
        reconciliation.record = result.record;
        reconciliation.handoffId = handoffId;
        if (superseded) {
          // A later attempt owns its own target, but not a fresh browser wait budget.
          reconciliation.expectedVersion = null;
          reconciliation.expectedSha = null;
        }
        if (promoted) {
          // Confirmed updates can become managed handoffs; preserve the longer lifecycle budget.
          reconciliation.kind = "handoff";
          ({ deadline, pollMs } = resolveUpdateVerificationWindow("handoff"));
          deadline = Math.min(deadline, reconciliation.deadlineAtMs);
        }
        if (changed) {
          params.updatePending(reconciliation);
        }
        if (promoted) {
          params.publish();
        }
      }
      if (result?.failure) {
        params.clearPending();
        params.publishFailure(result.failure, reconciliation.profileId);
        return;
      }
      if (outcome === "noop") {
        params.clearPending();
        params.publishBanner(null);
        return;
      }
      const expectedVersion = reconciliation.expectedVersion?.trim() || null;
      const expectedSha = reconciliation.expectedSha?.trim() || null;
      const actualVersion = sentinel?.stats?.after?.version?.trim() || null;
      const actualSha = sentinel?.stats?.after?.sha?.trim() || null;
      if (sentinel?.kind === "update" && sentinel.status === "ok") {
        if (matchesUpdateIdentity({ expectedVersion, expectedSha }, actualVersion, actualSha)) {
          params.clearPending();
          params.publishRecordedAttempt?.(null);
          params.onVerifiedInstall?.({ version: actualVersion, sha: actualSha });
          params.publishBanner(null);
          return;
        }
        const versionMismatch =
          expectedVersion !== null && actualVersion !== null && actualVersion !== expectedVersion;
        const shaMismatch =
          expectedSha !== null && actualSha !== null && !commitsMatch(expectedSha, actualSha);
        if (versionMismatch || shaMismatch) {
          finishVerification(
            reconciliation,
            "failed",
            resolveUpdateVerificationBanner({
              expectedVersion,
              actualVersion,
              expectedSha,
              actualSha,
            }),
          );
          return;
        }
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }
      if (!(await waitForNextPoll(Math.min(pollMs, remainingMs), currentGeneration))) {
        return;
      }
    }
    if (!isCurrent()) {
      return;
    }
    expire(
      reconciliation.kind === "handoff"
        ? resolvePendingUpdateHandoffTimeoutBanner()
        : resolveUnknownUpdateOutcomeBanner(),
    );
  };
  return { cancel, verify, expire };
}

function resolveUpdateVerificationWindow(
  kind: "handoff" | "restart",
  nowMs = Date.now(),
): { deadline: number; pollMs: number } {
  const handoff = kind === "handoff";
  return {
    deadline:
      nowMs + (handoff ? UPDATE_HANDOFF_TIMEOUT_MS : UPDATE_RESTART_VERIFICATION_TIMEOUT_MS),
    pollMs: handoff ? UPDATE_HANDOFF_POLL_MS : UPDATE_RESTART_VERIFICATION_POLL_MS,
  };
}

export function projectUpdateStatusResponse(
  response: UpdateRestartStatusResponse,
  current: {
    updateStatusBanner: ApplicationStatusBanner | null;
    recordedUpdateAttempt: RecordedUpdateAttempt | null;
    heldUpdateCampaignId: string | null;
  },
  currentFailure: UpdateFailureTriage | null = null,
): {
  failure: UpdateFailureTriage | null;
  updateStatusBanner: ApplicationStatusBanner | null;
  recordedUpdateAttempt: RecordedUpdateAttempt | null;
  updateAvailable?: UpdateAvailable | null;
  updateSchedule?: UpdateScheduleState | null;
  heldUpdateCampaignId?: string | null;
} {
  const result = projectUpdateSentinel(response.sentinel);
  const updateSchedule = Object.hasOwn(response, "schedule")
    ? readUpdateScheduleValue(response.schedule)
    : undefined;
  const relation = result
    ? classifyUpdateObservation(
        currentFailure?.verification,
        currentFailure?.reconciledRecord,
        result,
        response.sentinel,
      )
    : "unrelated";
  const retainVerification = () => {
    const record = currentFailure?.reconciledRecord;
    const target = currentFailure?.verification;
    if (!record && !target) {
      return false;
    }
    if (!result || (result.outcome === "pending" && relation !== "newer")) {
      return true;
    }
    // Terminal facts for this handoff can retain its original timestamp.
    // Without any recorded ordering an ambiguous RPC can only compare identity.
    if (relation === "verified") {
      return false;
    }
    // Only server-recorded ordering can replace this attempt with another one.
    if (relation !== "same" && relation !== "newer") {
      return true;
    }
    if (result.outcome !== "succeeded") {
      return false;
    }
    const actualVersion = response.sentinel?.stats?.after?.version?.trim() || null;
    const actualSha = response.sentinel?.stats?.after?.sha?.trim() || null;
    return relation === "same"
      ? !target || !matchesUpdateIdentity(target, actualVersion, actualSha)
      : !actualVersion && !actualSha;
  };
  const failure = retainVerification()
    ? currentFailure
    : result?.failure && relation === "same" && currentFailure
      ? {
          ...result.failure,
          id: currentFailure.id,
          verification: currentFailure.verification,
          reconciledRecord: result.record,
        }
      : (result?.failure ?? null);
  const display = failure ?? result;
  return {
    failure,
    updateStatusBanner: display ? display.banner : current.updateStatusBanner,
    recordedUpdateAttempt: display ? display.attempt : current.recordedUpdateAttempt,
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

function resolveUpdateVerificationBanner(params: {
  expectedVersion: string | null;
  actualVersion: string | null;
  expectedSha: string | null;
  actualSha: string | null;
}): ApplicationStatusBanner {
  const expected = params.expectedSha
    ? params.expectedSha.slice(0, 12)
    : params.expectedVersion
      ? `v${params.expectedVersion}`
      : t("common.unknown");
  const actual = params.actualSha
    ? params.actualSha.slice(0, 12)
    : params.actualVersion
      ? `v${params.actualVersion}`
      : t("common.unknown");
  return {
    tone: "danger",
    text: t("updates.verificationFailedWithIdentity", { expected, actual }),
  };
}

function resolvePendingUpdateHandoffTimeoutBanner(): ApplicationStatusBanner {
  return {
    tone: "danger",
    text: t("updates.handoffTimeout"),
  };
}

export function resolveUnknownUpdateOutcomeBanner(): ApplicationStatusBanner {
  return {
    tone: "danger",
    text: t("updates.outcomeUnknown"),
  };
}
