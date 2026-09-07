import type { PluginApprovalRequestPayload } from "../../infra/plugin-approvals.js";
import { runApprovalRequestDeliveries } from "./approval-request-delivery.js";
import { buildRequestedApprovalEvent, handlePendingApprovalRequest } from "./approval-shared.js";
import type { GatewayRequestContext } from "./types.js";

type PendingPluginApproval = Pick<
  Parameters<typeof handlePendingApprovalRequest<PluginApprovalRequestPayload>>[0],
  "manager" | "record" | "respond" | "context" | "clientConnId" | "twoPhase"
>;

export function handlePendingPluginApprovalRequest(
  params: PendingPluginApproval & {
    forwardRequest: GatewayRequestContext["forwardPluginApprovalRequest"];
    getIosPushDelivery: () => GatewayRequestContext["pluginApprovalIosPushDelivery"];
    source: "rpc" | "node-policy";
  },
): Promise<void> {
  const { forwardRequest, getIosPushDelivery, source, ...pending } = params;
  const requestEvent = buildRequestedApprovalEvent(pending.record, "plugin");
  const iosPushDelivery = getIosPushDelivery();
  const iosPushRequest = iosPushDelivery?.handleRequested?.bind(iosPushDelivery);
  const logContext = source === "node-policy" ? "node policy " : "";
  return handlePendingApprovalRequest({
    ...pending,
    requestEventName: "plugin.approval.requested",
    requestEvent,
    approvalKind: "plugin",
    deliverRequest: () =>
      runApprovalRequestDeliveries({
        context: pending.context,
        record: pending.record,
        forward: forwardRequest
          ? [
              () => forwardRequest(requestEvent),
              `plugin approvals: forward ${logContext}request failed`,
            ]
          : undefined,
        iosPush: iosPushRequest
          ? [
              (isTargetVisible) => iosPushRequest(requestEvent, { isTargetVisible }),
              `plugin approvals: iOS push ${logContext}request failed`,
            ]
          : undefined,
      }),
    afterDecision: async (decision) => {
      if (decision === null) {
        // Expiration uses the current delivery owner after the approval wait.
        await getIosPushDelivery()?.handleExpired?.(requestEvent);
      }
    },
    afterDecisionErrorLabel: `plugin approvals: iOS push ${logContext}expire failed`,
  });
}
