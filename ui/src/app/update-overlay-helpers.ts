import type { GatewayBrowserClient, GatewayHelloOk } from "../api/gateway.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { t } from "../i18n/index.ts";
import { formatUiExternalText } from "../lib/format-error.ts";
import { formatCountdown } from "../lib/format.ts";
import type { UpdateProgress } from "./update-confirmation.ts";
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
  installedVersion: string | null;
  installedSha: string | null;
  targetVersion: string | null;
  targetSha: string | null;
  failure: UpdateFailureCause | null;
};

/**
 * Structural leaf contract, not `Pick<ApplicationContext, ...>`: `context.ts`
 * reaches this module through `overlays-types.ts`, so naming the context type
 * here closes an import cycle. Naming only the fields the watcher reads keeps
 * every real context assignable.
 */
type UpdateProgressSources = {
  gateway: {
    snapshot: { phase: string };
    subscribe: (listener: () => void) => () => void;
  };
  overlays: {
    snapshot: {
      updateRunning: boolean;
      updateReconciliationPending: boolean;
      updateStatusBanner: ApplicationStatusBanner | null;
    };
    subscribe: (listener: () => void) => () => void;
  };
};

export function createUpdateProgressWatcher(
  context: UpdateProgressSources,
): (listener: (progress: UpdateProgress) => void) => () => void {
  return (listener) => {
    const emit = () => {
      const update = context.overlays.snapshot;
      const banner = update.updateStatusBanner;
      listener({
        busy: update.updateRunning || update.updateReconciliationPending,
        connected: context.gateway.snapshot.phase === "connected",
        failure: banner && banner.tone !== "info" ? banner.text : null,
      });
    };
    const stopOverlays = context.overlays.subscribe(emit);
    const stopGateway = context.gateway.subscribe(emit);
    emit();
    return () => {
      stopOverlays();
      stopGateway();
    };
  };
}

const UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";
const UPDATE_RESTART_HEALTH_PENDING_REASON = "restart-health-pending";
const UPDATE_RESTART_VERIFICATION_POLL_MS = 250;
const UPDATE_RESTART_VERIFICATION_TIMEOUT_MS = 10_000;
const UPDATE_HANDOFF_POLL_MS = 1_000;
const UPDATE_HANDOFF_TIMEOUT_MS = 35 * 60_000;
const PENDING_UPDATE_HANDOFF_REASONS = new Set([
  UPDATE_HANDOFF_STARTED_REASON,
  UPDATE_RESTART_HEALTH_PENDING_REASON,
]);
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
      before?: { sha?: string | null; version?: string | null } | null;
      after?: { sha?: string | null; version?: string | null } | null;
      steps?: UpdateSentinelStep[] | null;
    } | null;
  } | null;
  updateAvailable?: UpdateAvailable | null;
  schedule?: UpdateScheduleState;
};

type UpdateFailureCause = { step: string; detail: string };

function readRecordedUpdateAttempt(
  sentinel: UpdateRestartStatusResponse["sentinel"],
): RecordedUpdateAttempt | null {
  if (
    sentinel?.kind !== "update" ||
    !sentinel.status ||
    sentinel.status === "ok" ||
    isPendingUpdateHandoffSentinel(sentinel) ||
    typeof sentinel.ts !== "number"
  ) {
    return null;
  }
  const stats = sentinel.stats;
  return {
    timestampMs: sentinel.ts,
    status: sentinel.status,
    reason: stats?.reason?.trim() || "unexpected-error",
    installKind: stats?.mode?.trim() || null,
    installedVersion: stats?.before?.version?.trim() || null,
    installedSha: stats?.before?.sha?.trim() || null,
    targetVersion: stats?.after?.version?.trim() || null,
    targetSha: stats?.after?.sha?.trim() || null,
    failure: readUpdateFailureCause(sentinel),
  };
}

function lastLogLine(tail: string | null | undefined): string | null {
  const lines = (tail ?? "")
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
  return step && detail ? { step, detail: formatUiExternalText(detail) } : null;
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
  canRefresh: () => boolean;
  isCurrent: (client: GatewayBrowserClient, epoch: number) => boolean;
  onRefreshing: (refreshing: boolean) => void;
  onStatus: (response: UpdateRestartStatusResponse) => void;
  onError: (error: unknown) => void;
}) {
  let generation = 0;
  return async () => {
    const client = params.getClient();
    const epoch = params.getEpoch();
    if (!client || !params.canRefresh()) {
      return;
    }
    const operationGeneration = ++generation;
    const isCurrent = () => operationGeneration === generation && params.isCurrent(client, epoch);
    params.onRefreshing(true);
    try {
      const response = await requestUpdateRestartStatus(
        client,
        5_000,
        { refreshCheckout: true },
        (error) => {
          if (isCurrent()) {
            params.onError(error);
          }
        },
      );
      if (response && isCurrent()) {
        params.onStatus(response);
      }
    } finally {
      if (isCurrent()) {
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
  if (
    response.ok === true &&
    status === "skipped" &&
    response.result?.reason === UPDATE_HANDOFF_STARTED_REASON &&
    response.handoff?.status === "started"
  ) {
    return { pending: { expectedVersion, expectedSha, kind: "handoff" }, banner: null };
  }
  if (response.ok === true && status === "ok") {
    return {
      pending: { expectedVersion, expectedSha, kind: "restart" },
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
  expectedVersion: string | null;
  expectedSha: string | null;
  kind: "ambiguous" | "handoff" | "restart";
};

export function createPendingUpdateReconciliation(
  kind: PendingUpdateReconciliation["kind"],
  expectedVersion: string | null,
  expectedSha: string | null,
): PendingUpdateReconciliation {
  return { expectedVersion, expectedSha, kind };
}

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

export function createUpdateVerificationController(params: {
  getPending: () => PendingUpdateReconciliation | null;
  clearPending: () => void;
  isCurrent: (client: GatewayBrowserClient, epoch: number) => boolean;
  getHello: () => GatewayHelloOk | null;
  publish: () => void;
  publishBanner: (banner: ApplicationStatusBanner | null) => void;
  publishRecordedAttempt?: (attempt: RecordedUpdateAttempt | null) => void;
  publishRecordedFailure: (params: {
    attempt: RecordedUpdateAttempt | null;
    banner: ApplicationStatusBanner;
  }) => void;
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
    const currentGeneration = generation;
    const reconciliation = params.getPending();
    if (!reconciliation) {
      return;
    }
    const expectedVersion = reconciliation.expectedVersion?.trim() || null;
    const expectedSha = reconciliation.expectedSha?.trim() || null;
    const isCurrent = () => currentGeneration === generation && params.isCurrent(client, epoch);
    const verificationKind = reconciliation.kind === "handoff" ? "handoff" : "restart";
    let { deadline, pollMs } = resolveUpdateVerificationWindow(verificationKind);
    while (isCurrent() && Date.now() < deadline) {
      const response = await requestUpdateRestartStatus(client, Math.max(0, deadline - Date.now()));
      if (!isCurrent()) {
        return;
      }
      const sentinel = response?.sentinel;
      if (isPendingUpdateHandoffSentinel(sentinel)) {
        if (reconciliation.kind !== "handoff") {
          // Confirmed updates can become managed handoffs; preserve the longer lifecycle budget.
          reconciliation.kind = "handoff";
          ({ deadline, pollMs } = resolveUpdateVerificationWindow("handoff"));
          params.publish();
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        if (!(await waitForNextPoll(Math.min(pollMs, remainingMs), currentGeneration))) {
          return;
        }
        continue;
      }
      if (sentinel?.kind === "update" && sentinel.status && sentinel.status !== "ok") {
        params.clearPending();
        params.publishRecordedFailure({
          attempt: readRecordedUpdateAttempt(sentinel),
          banner: resolveUpdateStatusBanner({
            status: "error",
            ...(sentinel.stats?.reason ? { reason: sentinel.stats.reason } : {}),
            cause: readUpdateFailureCause(sentinel),
          }),
        });
        return;
      }
      const actualVersion = sentinel?.stats?.after?.version?.trim() || null;
      const actualSha = sentinel?.stats?.after?.sha?.trim() || null;
      if (sentinel?.kind === "update" && sentinel.status === "ok") {
        const versionMatches = !expectedVersion || actualVersion === expectedVersion;
        const shaMatches =
          !expectedSha || (actualSha !== null && commitsMatch(expectedSha, actualSha));
        const hasExpectedIdentity = expectedVersion !== null || expectedSha !== null;
        const hasActualIdentity = actualVersion !== null || actualSha !== null;
        if (versionMatches && shaMatches && (hasActualIdentity || !hasExpectedIdentity)) {
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
          params.clearPending();
          params.publishBanner(
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
    const currentVersion = params.getHello()?.server?.version?.trim() || null;
    params.clearPending();
    params.publishBanner(
      expectedSha || (expectedVersion && currentVersion !== expectedVersion)
        ? resolveUpdateVerificationBanner({
            expectedVersion,
            actualVersion: currentVersion,
            expectedSha,
            actualSha: null,
          })
        : reconciliation.kind === "handoff"
          ? resolvePendingUpdateHandoffTimeoutBanner()
          : resolveUnknownUpdateOutcomeBanner(),
    );
  };
  return { cancel, verify };
}

export function createUpdateCampaignStatusPoller(params: {
  getClient: () => GatewayBrowserClient | null;
  getEpoch: () => number;
  canPoll: () => boolean;
  getSchedule: () => UpdateScheduleState | null;
  isCurrent: (client: GatewayBrowserClient, epoch: number) => boolean;
  onStatus: (response: UpdateRestartStatusResponse) => void;
}) {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const stop = () => {
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
  };
  const poll = async () => {
    timer = null;
    const client = params.getClient();
    const epoch = params.getEpoch();
    const campaign = params.getSchedule()?.campaign;
    if (!client || !params.canPoll() || !campaign) {
      return;
    }
    const response = await requestUpdateRestartStatus(client, 5_000);
    const currentCampaign = params.getSchedule()?.campaign;
    // An event can advance the campaign while this RPC is in flight; never overwrite that fact.
    const unchangedCampaign =
      currentCampaign?.id === campaign.id && currentCampaign.updatedAtMs === campaign.updatedAtMs;
    if (response && unchangedCampaign && params.canPoll() && params.isCurrent(client, epoch)) {
      params.onStatus(response);
    }
    sync();
  };
  const sync = () => {
    const client = params.getClient();
    if (!client || !params.canPoll() || !params.getSchedule()?.campaign) {
      stop();
      return;
    }
    if (timer === null) {
      timer = globalThis.setTimeout(() => void poll(), 5_000);
    }
  };
  return { stop, sync };
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
): {
  updateStatusBanner: ApplicationStatusBanner | null;
  recordedUpdateAttempt: RecordedUpdateAttempt | null;
  updateAvailable?: UpdateAvailable | null;
  updateSchedule?: UpdateScheduleState | null;
  heldUpdateCampaignId?: string | null;
} {
  const sentinel = response.sentinel;
  const updateSchedule = Object.hasOwn(response, "schedule")
    ? readUpdateScheduleValue(response.schedule)
    : undefined;
  return {
    updateStatusBanner:
      sentinel?.kind === "update" && sentinel.status
        ? sentinel.status === "ok" || isPendingUpdateHandoffSentinel(sentinel)
          ? null
          : resolveUpdateStatusBanner({
              status: sentinel.status,
              reason: sentinel.stats?.reason ?? undefined,
              cause: readUpdateFailureCause(sentinel),
            })
        : current.updateStatusBanner,
    recordedUpdateAttempt:
      sentinel?.kind === "update" && sentinel.status
        ? readRecordedUpdateAttempt(sentinel)
        : current.recordedUpdateAttempt,
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

export function formatUpdateCampaignLabel(
  schedule: UpdateScheduleState | null | undefined,
  nowMs = Date.now(),
): string | null {
  const campaign = schedule?.campaign;
  if (!campaign) {
    return null;
  }
  if (campaign.holdUntilMs !== undefined && campaign.holdUntilMs > nowMs) {
    return t("updates.campaign.held", {
      time: formatCountdown(campaign.holdUntilMs, nowMs),
    });
  }
  if (campaign.state === "applying") {
    return t("updates.campaign.applying");
  }
  if (campaign.state === "waiting-for-idle") {
    return t("updates.campaign.waitingForIdle", {
      time: formatCountdown(campaign.forceAtMs, nowMs),
    });
  }
  return t("updates.campaign.countdown", {
    time: formatCountdown(campaign.applyAtMs ?? campaign.forceAtMs, nowMs),
  });
}

export function formatUpdateTargetLabel(
  schedule: UpdateScheduleState | null | undefined,
  updateAvailable: UpdateAvailable | null | undefined,
): string | null {
  const target = schedule?.target;
  const commitsBehind =
    target?.kind === "git" ? target.commitsBehind : updateAvailable?.commitsBehind;
  if (commitsBehind !== undefined) {
    return t(commitsBehind === 1 ? "updates.target.commitBehind" : "updates.target.commitsBehind", {
      count: String(commitsBehind),
    });
  }
  const version = target?.kind === "package" ? target.version : updateAvailable?.latestVersion;
  return version ? t("updates.target.version", { version }) : null;
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

function isPendingUpdateHandoffSentinel(
  sentinel: UpdateRestartStatusResponse["sentinel"],
): boolean {
  const reason = sentinel?.stats?.reason;
  return (
    sentinel?.kind === "update" &&
    sentinel.status === "skipped" &&
    typeof reason === "string" &&
    PENDING_UPDATE_HANDOFF_REASONS.has(reason)
  );
}
