// Durable final-reply delivery for inbound channel turns.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  markModelSpendAlertsQueued,
  preparePendingModelSpendAlertBestEffort,
  releasePreparedModelSpendAlertsBestEffort,
} from "../../agents/model-spend-alerts.js";
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
import { isPrivateOwnerRouteTarget } from "../../routing/private-owner-route.js";
import { deriveDurableFinalDeliveryRequirements } from "../message/capabilities.js";
import { sendDurableMessageBatch } from "../message/send.js";
import { createChannelDeliveryResultFromReceipt } from "./delivery-result.js";
import type { ChannelDeliveryInfo, ChannelDeliveryResult } from "./types.js";

/** Options controlling durable final delivery for inbound channel replies. */
export type DurableInboundReplyDeliveryOptions = Pick<
  DeliverOutboundPayloadsParams,
  "deps" | "formatting" | "identity" | "mediaAccess" | "replyToMode" | "silent" | "threadId"
> & {
  to?: string | null;
  replyToId?: string | null;
  requiredCapabilities?: DurableFinalDeliveryRequirements;
};

/** Full context required to deliver one inbound final reply through durable message sending. */
export type DurableInboundReplyDeliveryParams = DurableInboundReplyDeliveryOptions & {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string;
  agentId: string;
  ctxPayload: FinalizedMsgContext;
  payload: ReplyPayload;
  info: ChannelDeliveryInfo;
};

/** Outcome of attempting durable final delivery for an inbound reply payload. */
type DurableInboundReplyDeliveryResult =
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
  | { status: "failed"; error: unknown; sentBeforeError?: true };

function resolveDeliveryTarget(params: DurableInboundReplyDeliveryParams): string | undefined {
  return (
    normalizeOptionalString(params.to) ??
    normalizeOptionalString(params.ctxPayload.OriginatingTo) ??
    normalizeOptionalString(params.ctxPayload.To)
  );
}

function resolveDurableInboundReplyToId(
  params: Pick<DurableInboundReplyDeliveryParams, "ctxPayload" | "payload" | "replyToId">,
): string | null | undefined {
  // Explicit null means "do not reply to a source message"; do not fall back to context ids.
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

function resolveDurableSuppression(
  send: Extract<Awaited<ReturnType<typeof sendDurableMessageBatch>>, { status: "suppressed" }>,
): NonNullable<ChannelDeliveryResult["suppression"]> {
  const hookEffect = send.payloadOutcomes?.find(
    (outcome) => outcome.status === "suppressed",
  )?.hookEffect;
  return {
    reason: send.reason,
    ...(hookEffect?.cancelReason ? { cancelReason: hookEffect.cancelReason } : {}),
    ...(hookEffect?.metadata ? { metadata: hookEffect.metadata } : {}),
  };
}

/** Narrows durable delivery results that handled the payload without caller fallback. */
export function isDurableInboundReplyDeliveryHandled(
  result: DurableInboundReplyDeliveryResult,
): result is Extract<
  DurableInboundReplyDeliveryResult,
  { status: "handled_visible" | "handled_no_send" }
> {
  return result.status === "handled_visible" || result.status === "handled_no_send";
}

/** Throws failed durable delivery results, preserving visible-send metadata when applicable. */
export function throwIfDurableInboundReplyDeliveryFailed(
  result: DurableInboundReplyDeliveryResult,
): void {
  if (result.status === "failed") {
    throw result.sentBeforeError === true
      ? markDurableInboundReplyDeliveryErrorVisible(result.error)
      : result.error;
  }
}

function markDurableInboundReplyDeliveryErrorVisible(error: unknown): unknown {
  // Partial durable sends must suppress duplicate fallback delivery while still surfacing failure.
  if (typeof error === "object" && error !== null && Object.isExtensible(error)) {
    Object.assign(error, { sentBeforeError: true, visibleReplySent: true });
    return error;
  }

  const visibleError = new Error("visible durable reply delivery failed", { cause: error });
  Object.assign(visibleError, { sentBeforeError: true, visibleReplySent: true });
  return visibleError;
}

/** Delivers final inbound replies through the durable message-send context when supported. */
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
  // Agent-wide billing totals are private operator data. Leave alerts pending
  // until a final reply targets a configured owner in an explicit direct chat.
  const canDeliverSpendAlert =
    session?.conversationKind === "direct" &&
    isPrivateOwnerRouteTarget({ cfg: params.cfg, channel, to });
  const spendAlert = canDeliverSpendAlert
    ? preparePendingModelSpendAlertBestEffort({
        cfg: params.cfg,
        agentId: params.agentId,
        sessionKey: params.ctxPayload.SessionKey,
      })
    : undefined;
  const deliveryPayload = spendAlert
    ? {
        ...params.payload,
        text: [params.payload.text, spendAlert.text].filter(Boolean).join("\n\n"),
      }
    : params.payload;
  const spendAlertCompletion = spendAlert
    ? {
        kind: "model_spend_alert" as const,
        agentId: params.agentId,
        alertIds: spendAlert.alertIds,
        deliveryIntentId: spendAlert.deliveryIntentId,
      }
    : undefined;

  let send: Awaited<ReturnType<typeof sendDurableMessageBatch>>;
  try {
    send = await sendDurableMessageBatch({
      cfg: params.cfg,
      channel,
      to,
      accountId: params.accountId,
      payloads: [deliveryPayload],
      threadId,
      replyToId,
      replyToMode: params.replyToMode,
      formatting: params.formatting,
      identity: params.identity,
      deps: params.deps,
      mediaAccess: params.mediaAccess,
      silent: params.silent,
      durability,
      ...(durability === "required" ? { requireUnknownSendReconciliation: true } : {}),
      session,
      gatewayClientScopes: params.ctxPayload.GatewayClientScopes ?? [],
      ...(spendAlertCompletion
        ? {
            deliveryCompletion: spendAlertCompletion,
            deliveryIntentId: spendAlertCompletion.deliveryIntentId,
            // This is the fencing check before platform I/O. A stale lease must
            // abort the queued send instead of delivering an old alert payload.
            onDeliveryIntent: (intent) =>
              markModelSpendAlertsQueued(spendAlertCompletion, intent.id),
          }
        : {}),
    });
  } catch (error) {
    if (spendAlertCompletion) {
      releasePreparedModelSpendAlertsBestEffort(spendAlertCompletion);
    }
    return { status: "failed", error };
  }
  if (send.status === "failed") {
    if (spendAlertCompletion) {
      releasePreparedModelSpendAlertsBestEffort(spendAlertCompletion);
    }
    return { status: "failed" as const, error: send.error };
  }
  if (send.status === "partial_failed") {
    return {
      status: "failed" as const,
      error: markDurableInboundReplyDeliveryErrorVisible(send.error),
      sentBeforeError: true,
    };
  }

  const receiptDelivery = createChannelDeliveryResultFromReceipt({
    receipt: send.receipt,
    threadId: stringifyThreadId(threadId),
    ...(replyToId ? { replyToId } : {}),
    visibleReplySent: send.status === "sent",
    ...(send.deliveryIntent ? { deliveryIntent: toDeliveryIntent(send.deliveryIntent) } : {}),
  });
  const delivery: ChannelDeliveryResult =
    send.status === "suppressed"
      ? { ...receiptDelivery, suppression: resolveDurableSuppression(send) }
      : receiptDelivery;
  if (send.status === "suppressed") {
    return { status: "handled_no_send", reason: "no_visible_result", delivery };
  }
  return { status: "handled_visible", delivery };
}
