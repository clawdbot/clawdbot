import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";
import {
  requestCloudWorkerStop,
  resolveCloudWorkerStopConfirmation,
  resolveCloudWorkerStopAction,
} from "../../components/cloud-worker-stop.ts";
import { isCloudWorkerPlacementState } from "../../components/session-row-badges.ts";
import { t } from "../../i18n/index.ts";
import { readSessionMethodAccess } from "../../lib/session-method-access.ts";
import { parseAgentSessionKey } from "../../lib/sessions/session-key.ts";

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
  reclaimingKey: string | null;
  row: GatewaySessionRow | undefined;
}): { reclaimDisabledReason: string | undefined } {
  const reclaiming = params.reclaimingKey === params.row?.key;
  const action = resolveCloudWorkerStopAction(params.row?.placement);
  const access = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.reclaim",
    requiredScope: "operator.admin",
  });
  const reclaimDisabledReason = reclaiming
    ? t("common.loading")
    : params.row?.hasActiveRun === true
      ? t("sessionsView.activeRun")
      : action?.method !== "sessions.reclaim"
        ? t("sessionsView.actionUnavailable")
        : access.allowed
          ? undefined
          : access.reason;
  return {
    reclaimDisabledReason,
  };
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
    params.row.hasActiveRun === true ||
    action?.method !== "sessions.reclaim"
  ) {
    return;
  }
  const access = readSessionMethodAccess(params.gatewaySnapshot, {
    method: "sessions.reclaim",
    requiredScope: "operator.admin",
  });
  if (!access.allowed) {
    params.publishError(access.reason);
    return;
  }
  const { showConfirmDialog } = await import("../../components/confirm-dialog.js");
  const confirmed = await showConfirmDialog({
    ...resolveCloudWorkerStopConfirmation(action, params.row.label || params.row.key),
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
    await requestCloudWorkerStop(client, action, {
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
