/**
 * Local exec approval prompt suppression.
 *
 * Lets channel plugins hide generic local prompts while native approval routes are active.
 */
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getGatewayNativeApprovalRuntime } from "../../infra/approval-gateway-runtime-context.js";
import { hasActiveApprovalNativeRouteRuntime } from "../../infra/approval-native-route-coordinator.js";
import { getChannelPlugin, normalizeChannelId } from "./registry.js";

export function shouldSuppressLocalExecApprovalPrompt(params: {
  channel?: string | null;
  cfg: OpenClawConfig;
  accountId?: string | null;
  payload: ReplyPayload;
}): boolean {
  const channel = params.channel ? normalizeChannelId(params.channel) : null;
  if (!channel) {
    return false;
  }
  // Native-route state is process-local and transient. Pass it as a hint so the
  // channel owns the UX decision without duplicating route lookup logic.
  return (
    getChannelPlugin(channel)?.outbound?.shouldSuppressLocalPayloadPrompt?.({
      cfg: params.cfg,
      accountId: params.accountId,
      payload: params.payload,
      hint: {
        kind: "approval-pending",
        approvalKind: "exec",
        nativeRouteActive:
          getGatewayNativeApprovalRuntime()?.routeCoordinator.hasActiveRuntime({
            channel,
            accountId: params.accountId,
            approvalKind: "exec",
          }) ??
          hasActiveApprovalNativeRouteRuntime({
            channel,
            accountId: params.accountId,
            approvalKind: "exec",
          }),
      },
    }) ?? false
  );
}
