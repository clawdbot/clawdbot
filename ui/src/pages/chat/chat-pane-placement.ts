import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionMoveTarget } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import {
  requestCloudWorkerStop,
  resolveCloudWorkerStopAction,
} from "../../components/cloud-worker-stop.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
import { t } from "../../i18n/index.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";
import { requestPlaceCatalog } from "../new-session/cloud-target.ts";
import { readDraftNodes } from "../new-session/discovery.ts";

export function resolveChatPaneDesktopTarget(
  session: GatewaySessionRow | undefined,
): string | null {
  if (!session) {
    return null;
  }
  const placement = session.placement;
  if (isCloudWorkerPlacementState(placement?.state)) {
    return "environmentId" in placement
      ? (normalizeOptionalString(placement.environmentId) ?? null)
      : null;
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

async function loadPlacementMoveCatalog(client: GatewayBrowserClient, includeNodes: boolean) {
  const [catalog, nodesResult] = await Promise.all([
    requestPlaceCatalog(client),
    includeNodes
      ? client.request<{ nodes?: unknown }>("node.list", {})
      : Promise.resolve({ nodes: [] }),
  ]);
  return { profiles: catalog.profiles, nodes: readDraftNodes(nodesResult?.nodes) };
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
  refreshReplacement: (agentId?: string | null) => Promise<void>;
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
  const { showSessionPlacementMoveDialog } =
    await import("../../components/session-placement-move-dialog.ts");
  const target: SessionMoveTarget | null = await showSessionPlacementMoveDialog({
    sessionLabel: params.row.label || params.row.key,
    activeRun: params.row.hasActiveRun === true,
    loadCatalog: async () =>
      await loadPlacementMoveCatalog(
        client,
        hasOperatorAdminAccess(params.gatewaySnapshot.hello?.auth ?? null),
      ),
  });
  if (!target) {
    return;
  }
  if (!params.isCurrent(client, params.connectionGeneration)) {
    params.publishError(t("sessionsView.actionUnavailable"));
    return;
  }
  const agentId = parseAgentSessionKey(params.row.key)?.agentId;
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

export async function reclaimChatPanePlacement(params: {
  client: GatewayBrowserClient | null;
  connectionGeneration: number;
  gatewaySnapshot: ApplicationGatewaySnapshot;
  reclaimingKey: string | null;
  row: GatewaySessionRow;
  isCurrent: (client: GatewayBrowserClient, generation: number) => boolean;
  onReclaimingChange: (reclaimingKey: string | null) => void;
  publishError: (error: unknown) => void;
  refreshReplacement: (agentId?: string | null) => Promise<void>;
  requestUpdate: () => void;
}): Promise<void> {
  const client = params.client;
  const connectionGeneration = params.connectionGeneration;
  const action = resolveCloudWorkerStopAction(params.row.placement);
  const reclaiming = params.reclaimingKey === params.row.key;
  if (
    !client ||
    reclaiming ||
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
  const confirmed = await showConfirmDialog({
    message: t("sessionsView.stopCloudWorkerConfirm", {
      session: params.row.label || params.row.key,
    }),
    confirmLabel: t("sessionsView.stopCloudWorkerConfirmAction"),
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
    await requestCloudWorkerStop(client, {
      key: params.row.key,
      ...(agentId ? { agentId } : {}),
    });
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
