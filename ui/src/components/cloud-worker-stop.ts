import type { EnvironmentsDestroyResult } from "../../../packages/gateway-protocol/src/schema/environments.ts";
import { isCloudWorkerPlacementState } from "../../../packages/gateway-protocol/src/schema/session-placement-state.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { t } from "../i18n/index.ts";

export type CloudWorkerStopAction =
  | { method: "sessions.reclaim"; requiredScope: "operator.admin" }
  | {
      method: "environments.destroy";
      params: { environmentId: string; force?: true };
      requiredScope: "operator.admin";
    };

export function resolveCloudWorkerStopAction(
  placement: GatewaySessionRow["placement"],
): CloudWorkerStopAction | null {
  if (!placement || !isCloudWorkerPlacementState(placement.state)) {
    return null;
  }
  if (placement.state === "active") {
    return { method: "sessions.reclaim", requiredScope: "operator.admin" };
  }
  if (!("environmentId" in placement) || !placement.environmentId) {
    return null;
  }
  const force =
    placement.state === "failed" &&
    placement.terminalRecovery?.action === "force-destroy-environment" &&
    placement.terminalRecovery.dataLoss === "unreconciled-workspace-result";
  return {
    method: "environments.destroy",
    params: { environmentId: placement.environmentId, ...(force ? { force: true as const } : {}) },
    requiredScope: "operator.admin",
  };
}

export function resolveCloudWorkerStopConfirmation(
  action: CloudWorkerStopAction,
  session: string,
): { message: string; confirmLabel: string; danger: true } {
  const abandonsWorkspaceResult =
    action.method === "environments.destroy" && action.params.force === true;
  return {
    message: abandonsWorkspaceResult
      ? t("sessionsView.abandonCloudWorkerResultConfirm", { session })
      : t("sessionsView.stopCloudWorkerConfirm", { session }),
    confirmLabel: abandonsWorkspaceResult
      ? t("sessionsView.abandonCloudWorkerResultConfirmAction")
      : t("sessionsView.stopCloudWorkerConfirmAction"),
    danger: true,
  };
}

export async function requestCloudWorkerStop(
  client: GatewayBrowserClient,
  action: CloudWorkerStopAction,
  session: { key: string; agentId?: string },
): Promise<EnvironmentsDestroyResult | null> {
  if (action.method === "environments.destroy") {
    return client.request<EnvironmentsDestroyResult>("environments.destroy", action.params);
  }
  await client.request(
    "sessions.reclaim",
    { key: session.key, ...(session.agentId ? { agentId: session.agentId } : {}) },
    { timeoutMs: 10 * 60_000 },
  );
  return null;
}
