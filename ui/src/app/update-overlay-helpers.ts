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
  "managed-service-handoff-already-running":
    "updates.failureReasons.managedServiceHandoffAlreadyRunning",
  "doctor-failed": "updates.failureReasons.doctorFailed",
};

type UpdateRestartStatusResponse = {
  sentinel?: {
    kind?: string;
    status?: string;
    stats?: {
      reason?: string | null;
      after?: { version?: string | null } | null;
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
    after?: { version?: string | null } | null;
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

export type PendingUpdateReconciliation = {
  expected: string | null;
  kind: "ambiguous" | "handoff" | "restart";
};

type UpdateVerificationWait = {
  timer: ReturnType<typeof globalThis.setTimeout>;
  resolve: (active: boolean) => void;
};

export function createUpdateVerificationController(params: {
  getPending: () => PendingUpdateReconciliation | null;
  clearPending: () => void;
  isCurrent: (client: GatewayBrowserClient, epoch: number) => boolean;
  getHello: () => GatewayHelloOk | null;
  publish: () => void;
  publishBanner: (banner: ApplicationStatusBanner | null) => void;
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
    const expectedVersion = reconciliation.expected?.trim() || null;
    if (reconciliation.kind === "ambiguous") {
      // Only the replacement Gateway version can prove a response-lost request; status is cached.
      params.clearPending();
      params.publishBanner(resolveAmbiguousUpdateOutcomeBanner(expectedVersion, params.getHello()));
      return;
    }
    const isCurrent = () => currentGeneration === generation && params.isCurrent(client, epoch);
    let { deadline, pollMs } = resolveUpdateVerificationWindow(reconciliation.kind);
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
      if (
        sentinel?.kind === "update" &&
        sentinel.status === "ok" &&
        !actualVersion &&
        !expectedVersion
      ) {
        params.clearPending();
        params.publish();
        return;
      }
      if (sentinel?.kind === "update" && actualVersion) {
        params.clearPending();
        params.publishBanner(
          expectedVersion && actualVersion !== expectedVersion
            ? resolveUpdateVerificationBanner({ expectedVersion, actualVersion })
            : null,
        );
        return;
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
      expectedVersion && currentVersion !== expectedVersion
        ? resolveUpdateVerificationBanner({ expectedVersion, actualVersion: currentVersion })
        : reconciliation.kind === "handoff"
          ? resolvePendingUpdateHandoffTimeoutBanner()
          : null,
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
  const rawInstallKind = isRecord(value.install) ? value.install.kind : undefined;
  const installKind =
    rawInstallKind === "package" || rawInstallKind === "git" || rawInstallKind === "unknown"
      ? rawInstallKind
      : undefined;
  if (value.install !== undefined && installKind === undefined) {
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
    ...(installKind ? { install: { kind: installKind } } : {}),
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
  expectedVersion: string;
  actualVersion: string | null;
}): ApplicationStatusBanner {
  return {
    tone: "danger",
    text: params.actualVersion
      ? t("updates.verificationFailedWithVersions", {
          expectedVersion: params.expectedVersion,
          actualVersion: params.actualVersion,
        })
      : t("updates.verificationFailed"),
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

function resolveAmbiguousUpdateOutcomeBanner(
  expectedVersion: string | null,
  hello: GatewayHelloOk | null,
): ApplicationStatusBanner | null {
  const currentVersion = hello?.server?.version?.trim() || null;
  return expectedVersion && currentVersion === expectedVersion
    ? null
    : resolveUnknownUpdateOutcomeBanner();
}

export function isPendingUpdateHandoffSentinel(
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
