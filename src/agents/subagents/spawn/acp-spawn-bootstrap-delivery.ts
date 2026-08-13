import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AcpTurnAttachment } from "../../../acp/control-plane/manager.types.js";
import {
  formatConversationTarget,
  routeFromBindingRecord,
  routeToDeliveryFields,
} from "../../../channels/route-projection.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SessionBindingRecord } from "../../../infra/outbound/session-binding-service.js";
import {
  resolveConversationRefForThreadBinding,
  resolveSpawnChannelAccountId,
} from "../../spawn-plan.js";
import type { AcpSpawnRequesterState } from "./acp-spawn-requester.js";

type GatewayImageAttachmentInput = {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};

export function toGatewayImageAttachments(
  attachments: AcpTurnAttachment[] | undefined,
): GatewayImageAttachmentInput[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: attachment.mediaType,
      data: attachment.data,
    },
  }));
}

export type AcpSpawnBootstrapDeliveryPlan = {
  useInlineDelivery: boolean;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
};

export function resolveAcpSpawnBootstrapDeliveryPlan(params: {
  cfg: OpenClawConfig;
  spawnMode: "run" | "session";
  requestThreadBinding: boolean;
  effectiveStreamToParent: boolean;
  requester: AcpSpawnRequesterState;
  binding: SessionBindingRecord | null;
}): AcpSpawnBootstrapDeliveryPlan {
  // Child-thread ACP spawns deliver bootstrap output to the new thread; current-conversation
  // binds deliver back to the originating target.
  const boundThreadIdRaw = params.binding?.conversation.conversationId;
  const boundThreadId = boundThreadIdRaw ? normalizeOptionalString(boundThreadIdRaw) : undefined;
  const fallbackThreadIdRaw = params.requester.origin?.threadId;
  const fallbackThreadId =
    fallbackThreadIdRaw != null ? normalizeOptionalString(String(fallbackThreadIdRaw)) : undefined;
  const deliveryThreadId = boundThreadId ?? fallbackThreadId;
  const requesterConversationRef = resolveConversationRefForThreadBinding({
    cfg: params.cfg,
    channel: params.requester.origin?.channel,
    accountId: params.requester.origin?.accountId,
    threadId: fallbackThreadId,
    to: params.requester.origin?.to,
  });
  const requesterAccountId = resolveSpawnChannelAccountId({
    cfg: params.cfg,
    channel: params.requester.origin?.channel,
    accountId: params.requester.origin?.accountId,
  });
  const bindingMatchesRequesterConversation = Boolean(
    params.requester.origin?.channel &&
    params.binding?.conversation.channel === params.requester.origin.channel &&
    params.binding?.conversation.accountId === requesterAccountId &&
    requesterConversationRef?.conversationId &&
    params.binding?.conversation.conversationId === requesterConversationRef.conversationId &&
    (params.binding?.conversation.parentConversationId ?? undefined) ===
      (requesterConversationRef.parentConversationId ?? undefined),
  );
  const boundDeliveryTarget = routeToDeliveryFields(routeFromBindingRecord(params.binding));
  const inferredDeliveryTo =
    (bindingMatchesRequesterConversation
      ? normalizeOptionalString(params.requester.origin?.to)
      : undefined) ??
    boundDeliveryTarget.to ??
    normalizeOptionalString(params.requester.origin?.to) ??
    formatConversationTarget({
      channel: params.requester.origin?.channel,
      conversationId: deliveryThreadId,
    });
  const resolvedDeliveryThreadId = bindingMatchesRequesterConversation
    ? fallbackThreadId
    : (boundDeliveryTarget.threadId ?? deliveryThreadId);
  const hasDeliveryTarget = Boolean(params.requester.origin?.channel && inferredDeliveryTo);

  // Thread-bound session spawns always deliver inline to their bound thread.
  // Background run-mode spawns should stay internal and report back through
  // the parent task lifecycle notifier instead of letting the child ACP
  // session write raw output directly into the originating channel.
  const useInlineDelivery =
    hasDeliveryTarget && !params.effectiveStreamToParent && params.spawnMode === "session";

  return {
    useInlineDelivery,
    channel: useInlineDelivery ? params.requester.origin?.channel : undefined,
    accountId: useInlineDelivery ? requesterAccountId : undefined,
    to: useInlineDelivery ? inferredDeliveryTo : undefined,
    threadId:
      useInlineDelivery && resolvedDeliveryThreadId != null
        ? normalizeOptionalString(String(resolvedDeliveryThreadId))
        : undefined,
  };
}
