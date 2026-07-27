import type { GatewayHelloOk } from "../api/gateway.ts";
import type { UpdateAvailable } from "../api/types.ts";

export type ApplicationStatusBanner = {
  tone: "danger" | "warn" | "info";
  text: string;
};

export const UPDATE_HANDOFF_STARTED_REASON = "managed-service-handoff-started";
const UPDATE_RESTART_HEALTH_PENDING_REASON = "restart-health-pending";
export const UPDATE_RESTART_VERIFICATION_POLL_MS = 250;
export const UPDATE_RESTART_VERIFICATION_TIMEOUT_MS = 10_000;
export const UPDATE_HANDOFF_POLL_MS = 1_000;
export const UPDATE_HANDOFF_TIMEOUT_MS = 35 * 60_000;
const PENDING_UPDATE_HANDOFF_REASONS = new Set([
  UPDATE_HANDOFF_STARTED_REASON,
  UPDATE_RESTART_HEALTH_PENDING_REASON,
]);

export type UpdateRestartStatusResponse = {
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

export function resolveUpdateStatusBanner(params: {
  status?: string;
  reason?: string;
}): ApplicationStatusBanner {
  const status = (params.status ?? "error").trim() || "error";
  const reason = (params.reason ?? "unexpected-error").trim() || "unexpected-error";
  const guidance =
    {
      dirty: "Commit or stash changes, then retry.",
      "no-upstream": "Set an upstream branch, then retry.",
      "not-git-install":
        "Not a git checkout. Run `openclaw update` from the CLI for a global reinstall.",
      "not-openclaw-root":
        "Run the update from an OpenClaw checkout or use the CLI global reinstall path.",
      "deps-install-failed": "Dependency install failed. Fix the install error and retry.",
      "build-failed": "Build failed. Fix the build error and retry.",
      "build-dirty":
        "The selected revision's build changed checkout files. Retry with a revision that includes its generated artifacts.",
      "ui-build-failed": "The control UI rebuild failed. Fix the UI build error and retry.",
      "global-install-failed":
        "The global package install did not verify on disk. Retry or reinstall from the CLI.",
      "restart-disabled":
        "The update was not applied because gateway restarts are disabled. Enable restarts in config, then retry.",
      "restart-unavailable":
        "This global install cannot be safely replaced while restarts are disabled and no supervisor is present.",
      "restart-unhealthy":
        "The replacement process never became healthy. The previous process stayed up so you can recover.",
      "managed-service-handoff-already-running":
        "Another managed update is already running. Wait for it to complete, then refresh update status.",
      "doctor-failed": "Doctor repair failed. Run `openclaw doctor --non-interactive` and retry.",
    }[reason] ?? "See the gateway logs for the exact failure and retry once the cause is fixed.";
  return {
    tone: status === "skipped" ? "warn" : "danger",
    text: `Update ${status}: ${reason}. ${guidance}`,
  };
}

export function resolveUpdateVerificationBanner(params: {
  expectedVersion: string;
  actualVersion: string | null;
}): ApplicationStatusBanner {
  const actualSuffix = params.actualVersion
    ? ` Expected v${params.expectedVersion}, running v${params.actualVersion}.`
    : "";
  return {
    tone: "danger",
    text: `Update installed but running version did not change — restart may have been blocked.${actualSuffix}`,
  };
}

export function resolvePostRestartUpdateBanner(
  reason: string | null | undefined,
): ApplicationStatusBanner {
  const normalizedReason = reason?.trim() || "restart-unhealthy";
  const guidance =
    normalizedReason === "restart-unhealthy"
      ? "The replacement process never became healthy and the previous process stayed up."
      : "Check the gateway logs for the replacement failure.";
  return {
    tone: "danger",
    text: `Update error: ${normalizedReason}. ${guidance}`,
  };
}

export function resolvePendingUpdateHandoffTimeoutBanner(): ApplicationStatusBanner {
  return {
    tone: "danger",
    text: "Update handoff started, but completion was not reported after reconnect. Run `openclaw update status` for the final result.",
  };
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
