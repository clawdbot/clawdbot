import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import type { ApplicationPlacementStartupStatus } from "../../app/session-placement-startup.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionPlacementEnglish } from "../../i18n/locales/en-session-placement.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import type { ChatComposerDisabledBanner } from "./components/chat-composer-types.ts";

registerSessionPlacementEnglish();

type ChatPanePlacementComposerState =
  | { kind: "ready" }
  | { kind: "busy"; message: string }
  | { kind: "failed"; recoveryAction?: "restart" | "stop-first" };

export type PlacementComposerPresentation = {
  state: ChatPanePlacementComposerState;
  blocksSend: boolean;
  busyMessage: string | null;
  diskSpace: Extract<NonNullable<GatewaySessionRow["placement"]>, { state: "active" }>["diskSpace"];
  runError: { summary: string } | null;
  failedUnavailableMessage: string;
  disabledBanner: ChatComposerDisabledBanner | undefined;
};

function resolvePlacementComposerState(params: {
  reclaimingKey: string | null;
  restartingKey: string | null;
  row: GatewaySessionRow | undefined;
}): ChatPanePlacementComposerState {
  if (params.restartingKey === params.row?.key) {
    return { kind: "busy", message: t("sessionsView.restartingSession") };
  }
  if (params.reclaimingKey === params.row?.key) {
    return { kind: "busy", message: t("sessionsView.stoppingSession") };
  }
  switch (params.row?.placement?.state) {
    case "requested":
    case "provisioning":
      return { kind: "busy", message: t("chat.startupStatus.provisioningEnvironment") };
    case "syncing":
      return { kind: "busy", message: t("chat.startupStatus.preparingWorkspace") };
    case "starting":
      return { kind: "busy", message: t("newSession.starting") };
    case "draining":
    case "reconciling":
      return { kind: "busy", message: t("sessionsView.finishingSessionMove") };
    case "failed":
      return {
        kind: "failed",
        ...(params.row.placement.recoveryAction
          ? { recoveryAction: params.row.placement.recoveryAction }
          : {}),
      };
    default:
      // Local, active, and reclaimed placements can all accept a turn. Reclaimed
      // placements intentionally redispatch when the next turn is admitted.
      return { kind: "ready" };
  }
}

export function resolvePlacementComposer(params: {
  gatewaySnapshot: ApplicationGatewaySnapshot;
  movingKey: string | null;
  reclaimingKey: string | null;
  restartingKey: string | null;
  row: GatewaySessionRow | undefined;
  startupPending: boolean;
  onRestart: () => void;
  onReclaim: () => void;
}): PlacementComposerPresentation {
  const state = resolvePlacementComposerState(params);
  const controls = resolveChatPanePlacement(params);
  const busyMessage = !params.startupPending && state.kind === "busy" ? state.message : null;
  const placement = params.row?.placement;
  const terminalReason =
    placement && "terminalReason" in placement ? placement.terminalReason : undefined;
  const failureReason = placement?.state === "failed" ? placement.recoveryError : terminalReason;
  const common = {
    state,
    blocksSend: state.kind !== "ready",
    busyMessage,
    diskSpace: placement?.state === "active" ? placement.diskSpace : undefined,
    runError: failureReason
      ? { summary: t("chat.cloudWorkerFailed", { error: failureReason }) }
      : null,
    failedUnavailableMessage: t("sessionsView.failedSessionUnavailable"),
  };
  if (params.startupPending || state.kind !== "failed" || !state.recoveryAction || !params.row) {
    return { ...common, disabledBanner: undefined };
  }
  const restart = state.recoveryAction === "restart";
  return {
    ...common,
    disabledBanner: {
      kind: "above-composer",
      title: t("sessionsView.failedSessionTitle"),
      text: t(
        restart
          ? "sessionsView.failedSessionRestartPrompt"
          : "sessionsView.failedSessionStopPrompt",
      ),
      icon: "warning",
      actionLabel: t(restart ? "sessionsView.restartSession" : "sessionsView.stopCloudWorker"),
      actionStyle: "primary",
      disabledReason: restart ? controls.restartDisabledReason : controls.reclaimDisabledReason,
      onAction: restart ? params.onRestart : params.onReclaim,
    },
  };
}

export function resolveChatPaneWorkerPresentation(
  session: GatewaySessionRow,
  startup: Pick<ApplicationPlacementStartupStatus, "phase" | "targetKind"> | null | undefined,
) {
  const placement = session.placement;
  // Active ownership wins even when cloud placements omit runner. Failed startup
  // intent is retained for retry, not evidence of a later placement's target;
  // only a live initial handoff can identify a not-yet-active worker.
  let targetKind = startup?.phase !== "failed" ? startup?.targetKind : undefined;
  if (placement?.state === "active") {
    targetKind = placement.runner?.kind === "device" ? "device" : "profile";
  }
  let label: string;
  let stopKey: string;
  if (targetKind === "device" || targetKind === "auto-device") {
    label = t("sessionsView.runsOnDevice");
    stopKey = "sessionsView.stopDeviceWorker";
  } else if (targetKind === "profile") {
    const worker =
      placement && placement.state !== "local" && placement.state !== "requested"
        ? placement
        : undefined;
    label =
      worker?.providerId && worker.profileId
        ? `${worker.providerId} · ${worker.profileId}`
        : t("newSession.runsOn", { place: t("newSession.cloud") });
    stopKey = "sessionsView.stopCloudWorker";
  } else {
    label = t("sessionsView.runsOnWorker");
    stopKey = "sessionsView.stopWorker";
  }
  return {
    label,
    stopLabel: t(stopKey),
    confirmMessage: t(`${stopKey}Confirm`, { session: session.label || session.key }),
    confirmLabel: t(`${stopKey}ConfirmAction`),
  };
}

export function resolveChatPaneDesktopTarget(
  session: GatewaySessionRow | undefined,
): string | null {
  if (!session) {
    return null;
  }
  const placement = session.placement;
  if (placement && placement.state !== "local") {
    // Wait for the active owner; starting or reclaimed sessions do not own a desktop yet.
    if (placement.state !== "active") {
      return null;
    }
    if (placement.runner?.kind === "device") {
      const nodeId = normalizeOptionalString(placement.runner.deviceId);
      return placement.runner.status === "available" && nodeId ? `node:${nodeId}` : null;
    }
    return normalizeOptionalString(placement.environmentId) ?? null;
  }
  const execNode = normalizeOptionalString(session.execNode);
  return execNode ? `node:${execNode}` : "gateway";
}

export function resolveChatPanePlacement(params: {
  gatewaySnapshot: ApplicationGatewaySnapshot;
  movingKey: string | null;
  reclaimingKey: string | null;
  restartingKey?: string | null;
  row: GatewaySessionRow | undefined;
}): {
  moving: boolean;
  restarting: boolean;
  moveDisabledReason: string | undefined;
  reclaimDisabledReason: string | undefined;
  restartDisabledReason: string | undefined;
} {
  const moving =
    params.movingKey === params.row?.key ||
    (params.row?.placementMove !== undefined && params.row.placementMove.error === undefined);
  const reclaiming = params.reclaimingKey === params.row?.key;
  const restarting = params.restartingKey === params.row?.key;
  const action = resolveCloudWorkerStopAction(params.row?.placement);
  const moveAccess = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.move",
    requiredScope: "operator.write",
  });
  const reclaimAccess = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.reclaim",
    requiredScope: "operator.write",
  });
  const restartAccess = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.dispatch",
    requiredScope: "operator.write",
  });
  const placementState = params.row?.placement?.state;
  const recoveryAction =
    placementState === "failed" ? params.row?.placement?.recoveryAction : undefined;
  const runner = placementState === "active" ? params.row?.placement?.runner : undefined;
  const deviceOffline = runner?.kind === "device" && runner.status === "offline";
  const moveDisabledReason = moving
    ? t("common.loading")
    : reclaiming
      ? t("sessionsView.actionUnavailable")
      : placementState !== "active"
        ? t("sessionsView.actionUnavailable")
        : moveAccess.allowed
          ? undefined
          : moveAccess.reason;
  const restartDisabledReason = restarting
    ? t("common.loading")
    : moving || reclaiming
      ? t("sessionsView.actionUnavailable")
      : recoveryAction !== "restart"
        ? t("sessionsView.actionUnavailable")
        : restartAccess.allowed
          ? undefined
          : restartAccess.reason;
  const reclaimDisabledReason = reclaiming
    ? t("common.loading")
    : restarting
      ? t("sessionsView.actionUnavailable")
      : deviceOffline
        ? t("sessionsView.offlineDeviceStopUnavailable")
        : action?.blocksActiveRun && params.row?.hasActiveRun === true
          ? t("sessionsView.activeRun")
          : action?.method !== "sessions.reclaim"
            ? t("sessionsView.actionUnavailable")
            : reclaimAccess.allowed
              ? undefined
              : reclaimAccess.reason;
  return {
    moving,
    restarting,
    moveDisabledReason,
    reclaimDisabledReason,
    restartDisabledReason,
  };
}
