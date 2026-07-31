import type { GatewayBrowserClient, GatewayHelloOk } from "../api/gateway.ts";
import type { UpdateAvailable } from "../api/types.ts";
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

export async function requestUpdateRestartStatus(
  client: Pick<GatewayBrowserClient, "request">,
  timeoutMs: number,
): Promise<UpdateRestartStatusResponse | null> {
  try {
    return await client.request<UpdateRestartStatusResponse>("update.status", {}, { timeoutMs });
  } catch {
    return null;
  }
}

export function resolveUpdateVerificationWindow(
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
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return null;
  }
  const value = update as Partial<UpdateAvailable>;
  return typeof value.currentVersion === "string" &&
    typeof value.latestVersion === "string" &&
    typeof value.channel === "string"
    ? {
        currentVersion: value.currentVersion,
        latestVersion: value.latestVersion,
        channel: value.channel,
      }
    : null;
}

export function resolveControlUiRefreshRequiredBanner(): ApplicationStatusBanner {
  return {
    tone: "info",
    text: t("updates.refreshRequired"),
  };
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

export function resolveUpdateVerificationBanner(params: {
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

export function resolvePostRestartUpdateBanner(
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

export function resolvePendingUpdateHandoffTimeoutBanner(): ApplicationStatusBanner {
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

export function resolveAmbiguousUpdateOutcomeBanner(
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
