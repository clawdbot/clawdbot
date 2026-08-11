import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayBrowserClient, GatewayHelloOk } from "../api/gateway.ts";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { t } from "../i18n/index.ts";

export type ApplicationStatusBanner = {
  tone: "danger" | "warn" | "info";
  text: string;
};

export const UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";
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
};

export type UpdateRestartStatusResponse = {
  sentinel?: {
    kind?: string;
    status?: string;
    stats?: {
      reason?: string | null;
      after?: { sha?: string | null; version?: string | null } | null;
    } | null;
  } | null;
  updateAvailable?: UpdateAvailable | null;
  schedule?: UpdateScheduleState;
};

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
): Promise<UpdateRestartStatusResponse | null> {
  try {
    return await client.request<UpdateRestartStatusResponse>("update.status", {}, { timeoutMs });
  } catch {
    return null;
  }
}

export function createUpdateStatusRefresher(params: {
  getClient: () => GatewayBrowserClient | null;
  getEpoch: () => number;
  canRefresh: () => boolean;
  isCurrent: (client: GatewayBrowserClient, epoch: number) => boolean;
  onStatus: (response: UpdateRestartStatusResponse) => void;
}) {
  return async () => {
    const client = params.getClient();
    const epoch = params.getEpoch();
    if (!client || !params.canRefresh()) {
      return;
    }
    const response = await requestUpdateRestartStatus(client, 5_000);
    if (response && params.isCurrent(client, epoch)) {
      params.onStatus(response);
    }
  };
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
        params.publishBanner(resolvePostRestartUpdateBanner(sentinel.stats?.reason));
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

export function readUpdateAvailable(hello: GatewayHelloOk | null): UpdateAvailable | null {
  const snapshot = hello?.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    return null;
  }
  const update = (snapshot as { updateAvailable?: unknown }).updateAvailable;
  return readUpdateAvailableValue(update);
}

export function readUpdateAvailableValue(update: unknown): UpdateAvailable | null {
  if (!isRecord(update)) {
    return null;
  }
  const rawCommits = update.commits;
  const commits =
    Array.isArray(rawCommits) &&
    rawCommits.length <= 5 &&
    rawCommits.every(
      (commit): commit is { sha: string; subject: string } =>
        isRecord(commit) &&
        typeof commit.sha === "string" &&
        commit.sha.length > 0 &&
        typeof commit.subject === "string" &&
        commit.subject.length <= 120,
    )
      ? rawCommits.map((commit) => ({ sha: commit.sha, subject: commit.subject }))
      : undefined;
  return typeof update.currentVersion === "string" &&
    typeof update.latestVersion === "string" &&
    typeof update.channel === "string"
    ? {
        currentVersion: update.currentVersion,
        latestVersion: update.latestVersion,
        channel: update.channel,
        ...(typeof update.currentSha === "string" ? { currentSha: update.currentSha } : {}),
        ...(typeof update.upstreamRef === "string" ? { upstreamRef: update.upstreamRef } : {}),
        ...(typeof update.upstreamSha === "string" ? { upstreamSha: update.upstreamSha } : {}),
        ...(Number.isInteger(update.commitsBehind) && Number(update.commitsBehind) >= 0
          ? { commitsBehind: Number(update.commitsBehind) }
          : {}),
        ...(commits ? { commits } : {}),
      }
    : null;
}

function readScheduleTarget(value: unknown): UpdateScheduleState["target"] | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "package" && typeof value.version === "string") {
    return { kind: "package", version: value.version };
  }
  if (
    value.kind === "git" &&
    typeof value.upstreamRef === "string" &&
    typeof value.upstreamSha === "string" &&
    Number.isInteger(value.commitsBehind) &&
    Number(value.commitsBehind) >= 0
  ) {
    return {
      kind: "git",
      upstreamRef: value.upstreamRef,
      upstreamSha: value.upstreamSha,
      commitsBehind: Number(value.commitsBehind),
    };
  }
  return null;
}

function readGitInstallMetadata(value: Record<string, unknown>): {
  currentSha?: string;
  commitAtMs?: number;
  installedAtMs?: number;
} | null {
  if (
    (value.currentSha !== undefined &&
      (typeof value.currentSha !== "string" || value.currentSha.length === 0)) ||
    (value.commitAtMs !== undefined &&
      (!Number.isInteger(value.commitAtMs) || Number(value.commitAtMs) < 0)) ||
    (value.installedAtMs !== undefined &&
      (!Number.isInteger(value.installedAtMs) || Number(value.installedAtMs) < 0))
  ) {
    return null;
  }
  return {
    ...(typeof value.currentSha === "string" ? { currentSha: value.currentSha } : {}),
    ...(value.commitAtMs === undefined ? {} : { commitAtMs: Number(value.commitAtMs) }),
    ...(value.installedAtMs === undefined ? {} : { installedAtMs: Number(value.installedAtMs) }),
  };
}

function readGitUpdateStatus(
  value: unknown,
): NonNullable<NonNullable<UpdateScheduleState["install"]>["git"]> | null {
  if (!isRecord(value)) {
    return null;
  }
  const metadata = readGitInstallMetadata(value);
  if (!metadata) {
    return null;
  }
  if (value.status === "current") {
    return { ...metadata, status: "current" };
  }
  if (
    value.status === "behind" &&
    Number.isInteger(value.commitsBehind) &&
    Number(value.commitsBehind) > 0
  ) {
    return { ...metadata, status: "behind", commitsBehind: Number(value.commitsBehind) };
  }
  if (
    value.status === "ahead" &&
    Number.isInteger(value.commitsAhead) &&
    Number(value.commitsAhead) > 0
  ) {
    return { ...metadata, status: "ahead", commitsAhead: Number(value.commitsAhead) };
  }
  if (
    value.status === "diverged" &&
    Number.isInteger(value.commitsAhead) &&
    Number(value.commitsAhead) > 0 &&
    Number.isInteger(value.commitsBehind) &&
    Number(value.commitsBehind) > 0
  ) {
    return {
      ...metadata,
      status: "diverged",
      commitsAhead: Number(value.commitsAhead),
      commitsBehind: Number(value.commitsBehind),
    };
  }
  if (
    value.status === "unavailable" &&
    (value.reason === "fetch-failed" ||
      value.reason === "no-upstream" ||
      value.reason === "no-upstream-sha" ||
      value.reason === "comparison-failed" ||
      value.reason === "git-unavailable")
  ) {
    return { ...metadata, status: "unavailable", reason: value.reason };
  }
  return null;
}

function readScheduleCampaign(value: unknown): UpdateScheduleState["campaign"] | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    (value.state !== "waiting-for-idle" &&
      value.state !== "countdown" &&
      value.state !== "applying") ||
    !Number.isInteger(value.announcedAtMs) ||
    Number(value.announcedAtMs) < 0 ||
    !Number.isInteger(value.forceAtMs) ||
    Number(value.forceAtMs) < 0 ||
    !Number.isInteger(value.updatedAtMs) ||
    Number(value.updatedAtMs) < 0 ||
    (value.applyAtMs !== undefined &&
      (!Number.isInteger(value.applyAtMs) || Number(value.applyAtMs) < 0)) ||
    (value.holdUntilMs !== undefined &&
      (!Number.isInteger(value.holdUntilMs) || Number(value.holdUntilMs) < 0))
  ) {
    return null;
  }
  return {
    id: value.id,
    state: value.state,
    announcedAtMs: Number(value.announcedAtMs),
    ...(value.applyAtMs === undefined ? {} : { applyAtMs: Number(value.applyAtMs) }),
    ...(value.holdUntilMs === undefined ? {} : { holdUntilMs: Number(value.holdUntilMs) }),
    forceAtMs: Number(value.forceAtMs),
    updatedAtMs: Number(value.updatedAtMs),
  };
}

export function readUpdateScheduleValue(value: unknown): UpdateScheduleState | null {
  if (
    !isRecord(value) ||
    typeof value.channel !== "string" ||
    typeof value.autoEnabled !== "boolean"
  ) {
    return null;
  }
  const rawInstall = isRecord(value.install) ? value.install : null;
  const rawInstallKind = rawInstall?.kind;
  const installKind =
    rawInstallKind === "package" || rawInstallKind === "git" || rawInstallKind === "unknown"
      ? rawInstallKind
      : undefined;
  if (value.install !== undefined && installKind === undefined) {
    return null;
  }
  const gitStatus = rawInstall?.git === undefined ? undefined : readGitUpdateStatus(rawInstall.git);
  if (rawInstall?.git !== undefined && !gitStatus) {
    return null;
  }
  const target = value.target === undefined ? undefined : readScheduleTarget(value.target);
  const campaign = value.campaign === undefined ? undefined : readScheduleCampaign(value.campaign);
  if ((value.target !== undefined && !target) || (value.campaign !== undefined && !campaign)) {
    return null;
  }
  return {
    channel: value.channel,
    autoEnabled: value.autoEnabled,
    ...(installKind
      ? { install: { kind: installKind, ...(gitStatus ? { git: gitStatus } : {}) } }
      : {}),
    ...(target ? { target } : {}),
    ...(campaign ? { campaign } : {}),
  };
}

export function readUpdateSchedule(hello: GatewayHelloOk | null): UpdateScheduleState | null {
  const snapshot = hello?.snapshot;
  if (!isRecord(snapshot)) {
    return null;
  }
  return readUpdateScheduleValue(snapshot.updateSchedule);
}

export function projectUpdateStatusResponse(
  response: UpdateRestartStatusResponse,
  current: {
    updateStatusBanner: ApplicationStatusBanner | null;
    heldUpdateCampaignId: string | null;
  },
): {
  updateStatusBanner: ApplicationStatusBanner | null;
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
            })
        : current.updateStatusBanner,
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

function formatUpdateCountdown(deadlineMs: number, nowMs = Date.now()): string {
  const totalSeconds = Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
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
      time: formatUpdateCountdown(campaign.holdUntilMs, nowMs),
    });
  }
  if (campaign.state === "applying") {
    return t("updates.campaign.applying");
  }
  if (campaign.state === "waiting-for-idle") {
    return t("updates.campaign.waitingForIdle", {
      time: formatUpdateCountdown(campaign.forceAtMs, nowMs),
    });
  }
  return t("updates.campaign.countdown", {
    time: formatUpdateCountdown(campaign.applyAtMs ?? campaign.forceAtMs, nowMs),
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
}): ApplicationStatusBanner {
  const status = (params.status ?? "error").trim() || "error";
  const reason = (params.reason ?? "unexpected-error").trim() || "unexpected-error";
  const guidance = t(UPDATE_FAILURE_REASON_KEYS[reason] ?? "updates.failureReasons.default");
  return {
    tone: status === "skipped" ? "warn" : "danger",
    text: t("updates.status", { status, reason, guidance }),
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

function resolvePostRestartUpdateBanner(
  reason: string | null | undefined,
): ApplicationStatusBanner {
  const normalizedReason = reason?.trim() || "restart-unhealthy";
  const guidanceKey =
    normalizedReason === "restart-unhealthy"
      ? "updates.postRestart.restartUnhealthy"
      : "updates.postRestart.default";
  return {
    tone: "danger",
    text: t("updates.status", {
      status: "error",
      reason: normalizedReason,
      guidance: t(guidanceKey),
    }),
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
