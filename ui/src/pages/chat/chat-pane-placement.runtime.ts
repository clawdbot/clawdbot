import type { SessionMoveTarget } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import type { ApplicationPlacementStartup } from "../../app/session-placement-startup.ts";
import { requestCloudWorkerStop } from "../../components/cloud-worker-stop.runtime.ts";
import { resolveCloudWorkerStopAction } from "../../components/cloud-worker-stop.ts";
import { t } from "../../i18n/index.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import type { SessionCapability } from "../../lib/sessions/session-capability.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { requestPlaceCatalog } from "../new-session/cloud-target.ts";
import {
  projectDevicePlacements,
  type DevicePlacementRequirement,
} from "../new-session/device-placement.ts";
import { draftCloudProfileSupportsExecutionMode } from "../new-session/discovery.ts";
import { resolveChatPaneWorkerPresentation } from "./chat-pane-placement.ts";

async function loadPlacementMoveCatalog(
  client: GatewayBrowserClient,
  includeProfiles: boolean,
  runtimeId: string | undefined,
  requirement?: DevicePlacementRequirement,
) {
  const catalog = await requestPlaceCatalog(client, runtimeId);
  return {
    profiles: includeProfiles ? catalog.profiles : [],
    devices: projectDevicePlacements(catalog.environments, requirement),
  };
}

async function selectChatPanePlacementTarget(params: {
  client: GatewayBrowserClient;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  mode: "move" | "restart";
  row: GatewaySessionRow;
}): Promise<SessionMoveTarget | null> {
  const { showSessionPlacementTargetDialog } =
    await import("../../components/session-placement-move-dialog.ts");
  const runtime = params.row.agentRuntime;
  return await showSessionPlacementTargetDialog({
    mode: params.mode,
    sessionLabel: params.row.label || params.row.key,
    activeRun: params.row.hasActiveRun === true,
    deviceDisabledReason:
      runtime && !runtime.devicePlacement ? t("newSession.deviceRuntimeUnsupported") : undefined,
    profileDisabledReason: (profile) => {
      if (runtime?.cloudPlacementSupported === false) {
        return t("newSession.cloudRuntimeUnsupported", { runtime: runtime.id });
      }
      return runtime?.cloudPlacementExecutionMode &&
        !draftCloudProfileSupportsExecutionMode(profile, runtime.cloudPlacementExecutionMode)
        ? t("newSession.cloudProfileRuntimeUnsupported", { runtime: runtime.id })
        : undefined;
    },
    loadCatalog: async () =>
      await loadPlacementMoveCatalog(
        params.client,
        hasOperatorAdminAccess(params.gatewaySnapshot.hello?.auth ?? null),
        runtime?.id,
        runtime?.devicePlacement,
      ),
  });
}

export async function moveChatPanePlacement(params: {
  client: GatewayBrowserClient | null;
  connectionGeneration: number;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  movingKey: string | null;
  row: GatewaySessionRow;
  isCurrent: (client: GatewayBrowserClient, generation: number) => boolean;
  onMovingChange: (movingKey: string | null) => void;
  publishError: (error: unknown) => void;
  refreshReplacement: SessionCapability["refreshReplacement"];
  requestUpdate: () => void;
}): Promise<void> {
  const client = params.client;
  const placement = params.row.placement;
  if (
    !client ||
    params.movingKey === params.row.key ||
    (params.row.placementMove !== undefined && params.row.placementMove.error === undefined) ||
    placement?.state !== "active"
  ) {
    return;
  }
  const access = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.move",
    requiredScope: "operator.write",
  });
  if (!access.allowed) {
    params.publishError(access.reason);
    return;
  }
  const agentId = parseAgentSessionKey(params.row.key)?.agentId;
  const abandonSource =
    placement.runner?.kind === "device" && placement.runner.status === "offline";
  let target: SessionMoveTarget | null;
  if (abandonSource) {
    const { showConfirmDialog } = await import("../../components/confirm-dialog.js");
    const confirmed = await showConfirmDialog({
      message: t("sessionsView.continueOnGatewayConfirm", {
        session: params.row.label || params.row.key,
      }),
      confirmLabel: t("sessionsView.continueOnGatewayAction"),
      danger: true,
    });
    target = confirmed ? { kind: "gateway" } : null;
  } else {
    target = await selectChatPanePlacementTarget({
      client,
      gatewaySnapshot: params.gatewaySnapshot,
      mode: "move",
      row: params.row,
    });
  }
  if (!target) {
    return;
  }
  if (!params.isCurrent(client, params.connectionGeneration)) {
    params.publishError(t("sessionsView.actionUnavailable"));
    return;
  }
  params.onMovingChange(params.row.key);
  try {
    await client.request("sessions.move", {
      key: params.row.key,
      ...(agentId ? { agentId } : {}),
      expected: {
        generation: placement.generation,
        environmentId: placement.environmentId,
        ownerEpoch: placement.activeOwnerEpoch,
      },
      target,
      ...(abandonSource ? { abandonSource: true } : {}),
    });
    if (params.isCurrent(client, params.connectionGeneration)) {
      await params.refreshReplacement(agentId);
    }
  } catch (error) {
    if (params.isCurrent(client, params.connectionGeneration)) {
      await params.refreshReplacement(agentId).catch(() => undefined);
      params.publishError(error);
    }
  } finally {
    params.onMovingChange(null);
    params.requestUpdate();
  }
}

export async function restartChatPanePlacement(params: {
  client: GatewayBrowserClient | null;
  connectionGeneration: number;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  restartingKey: string | null;
  row: GatewaySessionRow;
  isCurrent: (client: GatewayBrowserClient, generation: number) => boolean;
  onRestartingChange: (restartingKey: string | null) => void;
  publishError: (error: unknown) => void;
  refreshReplacement: SessionCapability["refreshReplacement"];
  requestUpdate: () => void;
}): Promise<void> {
  const client = params.client;
  const placement = params.row.placement;
  if (
    !client ||
    params.restartingKey === params.row.key ||
    placement?.state !== "failed" ||
    placement.recoveryAction !== "restart"
  ) {
    return;
  }
  const access = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.dispatch",
    requiredScope: "operator.write",
  });
  if (!access.allowed) {
    params.publishError(access.reason);
    return;
  }
  const target = await selectChatPanePlacementTarget({
    client,
    gatewaySnapshot: params.gatewaySnapshot,
    mode: "restart",
    row: params.row,
  });
  if (!target || target.kind === "gateway") {
    return;
  }
  if (!params.isCurrent(client, params.connectionGeneration)) {
    params.publishError(t("sessionsView.actionUnavailable"));
    return;
  }
  const agentId = parseAgentSessionKey(params.row.key)?.agentId;
  params.onRestartingChange(params.row.key);
  try {
    await client.request("sessions.dispatch", {
      key: params.row.key,
      ...(agentId ? { agentId } : {}),
      ...(target.kind === "profile"
        ? {
            profileId: target.profileId,
            ...(target.machineClass ? { machineClass: target.machineClass } : {}),
          }
        : { deviceId: target.deviceId }),
    });
    if (params.isCurrent(client, params.connectionGeneration)) {
      await params.refreshReplacement(agentId);
    }
  } catch (error) {
    if (params.isCurrent(client, params.connectionGeneration)) {
      await params.refreshReplacement(agentId).catch(() => undefined);
      params.publishError(error);
    }
  } finally {
    params.onRestartingChange(null);
    params.requestUpdate();
  }
}

export async function reclaimChatPanePlacement(params: {
  client: GatewayBrowserClient | null;
  connectionGeneration: number;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  reclaimingKey: string | null;
  placementStartup: ApplicationPlacementStartup;
  row: GatewaySessionRow;
  isCurrent: (client: GatewayBrowserClient, generation: number) => boolean;
  onReclaimingChange: (reclaimingKey: string | null) => void;
  publishError: (error: unknown) => void;
  refreshReplacement: SessionCapability["refreshReplacement"];
  requestUpdate: () => void;
}): Promise<void> {
  const client = params.client;
  const connectionGeneration = params.connectionGeneration;
  const action = resolveCloudWorkerStopAction(params.row.placement);
  const reclaiming = params.reclaimingKey === params.row.key;
  const placement = params.row.placement;
  const deviceOffline =
    placement?.state === "active" &&
    placement.runner?.kind === "device" &&
    placement.runner.status === "offline";
  if (
    !client ||
    reclaiming ||
    deviceOffline ||
    (action?.blocksActiveRun && params.row.hasActiveRun === true) ||
    action?.method !== "sessions.reclaim"
  ) {
    return;
  }
  const access = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.reclaim",
    requiredScope: "operator.write",
  });
  if (!access.allowed) {
    params.publishError(access.reason);
    return;
  }
  const { showConfirmDialog } = await import("../../components/confirm-dialog.js");
  const worker = resolveChatPaneWorkerPresentation(
    params.row,
    params.placementStartup.get(params.row.key),
  );
  const confirmed = await showConfirmDialog({
    message: worker.confirmMessage,
    confirmLabel: worker.confirmLabel,
    danger: true,
  });
  if (!confirmed) {
    return;
  }
  if (!params.isCurrent(client, connectionGeneration)) {
    params.publishError(t("sessionsView.actionUnavailable"));
    return;
  }
  const agentId = parseAgentSessionKey(params.row.key)?.agentId;
  params.onReclaimingChange(params.row.key);
  try {
    await requestCloudWorkerStop(
      client,
      {
        key: params.row.key,
        ...(agentId ? { agentId } : {}),
      },
      params.placementStartup,
    );
    if (params.isCurrent(client, connectionGeneration)) {
      await params.refreshReplacement(agentId);
    }
  } catch (error) {
    if (params.isCurrent(client, connectionGeneration)) {
      params.publishError(error);
    }
  } finally {
    params.onReclaimingChange(null);
    params.requestUpdate();
  }
}
