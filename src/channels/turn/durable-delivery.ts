import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { FinalizedMsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeDeliverableOutboundChannel } from "../../infra/outbound/channel-resolution.js";
import {
  type DeliverOutboundPayloadsParams,
  type DurableFinalDeliveryRequirement,
  type DurableFinalDeliveryRequirements,
  type OutboundDeliveryIntent,
  resolveOutboundDurableFinalDeliverySupport,
} from "../../infra/outbound/deliver.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { deriveDurableFinalDeliveryRequirements } from "../message/capabilities.js";
import { sendDurableMessageBatch } from "../message/send.js";
import { createChannelDeliveryResultFromReceipt } from "./delivery-result.js";
import type { ChannelDeliveryInfo, ChannelDeliveryResult } from "./types.js";

export type DurableInboundReplyDeliveryOptions = Pick<
  DeliverOutboundPayloadsParams,
  "deps" | "formatting" | "identity" | "mediaAccess" | "replyToMode" | "silent" | "threadId"
> & {
  to?: string | null;
  replyToId?: string | null;
  requiredCapabilities?: DurableFinalDeliveryRequirements;
};

export type DurableInboundReplyDeliveryParams = DurableInboundReplyDeliveryOptions & {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  ctxPayload: FinalizedMsgContext;
  payload: ReplyPayload;
  info: ChannelDeliveryInfo;
};

export type DurableInboundReplyDeliveryResult =
  | { status: "not_applicable"; reason: "non_final" }
  | {
      status: "unsupported";
      reason:
        | "missing_channel"
        | "missing_target"
        | "missing_outbound_handler"
        | "capability_mismatch";
      capability?: DurableFinalDeliveryRequirement;
    }
  | { status: "handled_visible"; delivery: ChannelDeliveryResult }
  | { status: "handled_no_send"; reason: "no_visible_result"; delivery: ChannelDeliveryResult }
  | { status: "failed"; error: unknown };

function resolveDeliveryTarget(params: DurableInboundReplyDeliveryParams): string | undefined {
  return (
    normalizeOptionalString(params.to) ??
    normalizeOptionalString(params.ctxPayload.OriginatingTo) ??
    normalizeOptionalString(params.ctxPayload.To)
  );
}

export function resolveDurableInboundReplyToId(
  params: Pick<DurableInboundReplyDeliveryParams, "ctxPayload" | "payload" | "replyToId">,
): string | null | undefined {
  if (params.replyToId === null || params.payload.replyToId === null) {
    return null;
  }
  return (
    normalizeOptionalString(params.replyToId) ??
    normalizeOptionalString(params.payload.replyToId) ??
    normalizeOptionalString(params.ctxPayload.ReplyToIdFull) ??
    normalizeOptionalString(params.ctxPayload.ReplyToId)
  );
}

function resolveDurableInboundReplyThreadId(
  params: DurableInboundReplyDeliveryParams,
): string | number | null | undefined {
  if ("threadId" in params) {
    return params.threadId;
  }
  return params.ctxPayload.MessageThreadId;
}

function stringifyThreadId(value: string | number | null | undefined): string | undefined {
  return value == null ? undefined : String(value);
}

function toDeliveryIntent(intent: OutboundDeliveryIntent): ChannelDeliveryResult["deliveryIntent"] {
  return {
    id: intent.id,
    kind: "outbound_queue",
    queuePolicy: intent.queuePolicy,
  };
}

export function isDurableInboundReplyDeliveryHandled(
  result: DurableInboundReplyDeliveryResult,
): result is Extract<
  DurableInboundReplyDeliveryResult,
  { status: "handled_visible" | "handled_no_send" }
> {
  return result.status === "handled_visible" || result.status === "handled_no_send";
}

export function throwIfDurableInboundReplyDeliveryFailed(
  result: DurableInboundReplyDeliveryResult,
): void {
  if (result.status === "failed") {
    throw result.error;
  }
}

export async function deliverInboundReplyWithMessageSendContext(
  params: DurableInboundReplyDeliveryParams,
): Promise<DurableInboundReplyDeliveryResult> {
  if (params.info.kind !== "final") {
    return { status: "not_applicable", reason: "non_final" };
  }

  const channel = normalizeDeliverableOutboundChannel(params.channel);
  const to = resolveDeliveryTarget(params);
  if (!channel) {
    return { status: "unsupported", reason: "missing_channel" };
  }
  if (!to) {
    return { status: "unsupported", reason: "missing_target" };
  }

  const replyToId = resolveDurableInboundReplyToId(params);
  const threadId = resolveDurableInboundReplyThreadId(params);
  const requiredCapabilities =
    params.requiredCapabilities ??
    deriveDurableFinalDeliveryRequirements({
      payload: params.payload,
      replyToId,
      threadId,
      silent: params.silent,
    });
  const durability =
    requiredCapabilities.reconcileUnknownSend === true ? "required" : "best_effort";

  let support: Awaited<ReturnType<typeof resolveOutboundDurableFinalDeliverySupport>>;
  try {
    support = await resolveOutboundDurableFinalDeliverySupport({
      cfg: params.cfg,
      channel,
      requirements: requiredCapabilities,
    });
  } catch (err: unknown) {
    return { status: "failed", error: err };
  }
  if (!support.ok) {
    return {
      status: "unsupported",
      reason: support.reason,
      ...(support.capability ? { capability: support.capability } : {}),
    };
  }

  const session = buildOutboundSessionContext({
    cfg: params.cfg,
    sessionKey: params.ctxPayload.SessionKey,
    policySessionKey: params.ctxPayload.RuntimePolicySessionKey,
    conversationType: params.ctxPayload.ChatType,
    agentId: params.agentId,
    requesterAccountId: params.accountId ?? params.ctxPayload.AccountId,
    requesterSenderId: params.ctxPayload.SenderId ?? params.ctxPayload.From,
    requesterSenderName: params.ctxPayload.SenderName,
    requesterSenderUsername: params.ctxPayload.SenderUsername,
    requesterSenderE164: params.ctxPayload.SenderE164,
  });

  const send = await sendDurableMessageBatch({
    cfg: params.cfg,
    channel,
    to,
    accountId: params.accountId,
    payloads: [params.payload],
    threadId,
    replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    identity: params.identity,
    deps: params.deps,
    mediaAccess: params.mediaAccess,
    silent: params.silent,
    durability,
    session,
    gatewayClientScopes: params.ctxPayload.GatewayClientScopes,
  });
  if (send.status === "failed") {
    return { status: "failed" as const, error: send.error };
  }
  if (send.status === "partial_failed") {
    return { status: "failed" as const, error: send.error };
  }

  const delivery = createChannelDeliveryResultFromReceipt({
    receipt: send.receipt,
    threadId: stringifyThreadId(threadId),
    ...(replyToId ? { replyToId } : {}),
    visibleReplySent: send.status === "sent",
    ...(send.deliveryIntent ? { deliveryIntent: toDeliveryIntent(send.deliveryIntent) } : {}),
  });
  if (send.status === "suppressed") {
    return { status: "handled_no_send", reason: "no_visible_result", delivery };
  }
  return { status: "handled_visible", delivery };
}

/** @deprecated Use `deliverInboundReplyWithMessageSendContext`. */
export const deliverDurableInboundReplyPayload = deliverInboundReplyWithMessageSendContext;
