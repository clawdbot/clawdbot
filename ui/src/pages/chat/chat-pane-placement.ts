import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { t } from "../../i18n/index.ts";
import { registerSessionPlacementEnglish } from "../../i18n/locales/en-session-placement.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";

registerSessionPlacementEnglish();

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
  row: GatewaySessionRow | undefined;
}): {
  moving: boolean;
  moveDisabledReason: string | undefined;
  reclaimDisabledReason: string | undefined;
} {
  const moving =
    params.movingKey === params.row?.key ||
    (params.row?.placementMove !== undefined && params.row.placementMove.error === undefined);
  const reclaiming = params.reclaimingKey === params.row?.key;
  const action = resolveCloudWorkerStopAction(params.row?.placement);
  const moveAccess = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.move",
    requiredScope: "operator.write",
  });
  const reclaimAccess = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.reclaim",
    requiredScope: "operator.write",
  });
  const placementState = params.row?.placement?.state;
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
  const reclaimDisabledReason = reclaiming
    ? t("common.loading")
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
    moveDisabledReason,
    reclaimDisabledReason,
  };
}
