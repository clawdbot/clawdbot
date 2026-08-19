/**
 * Direct completion fallback and source-delivery evidence for subagent announcements.
 */
import { sanitizePendingFinalDeliveryText } from "../../../auto-reply/reply/pending-final-delivery.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { sourceDeliveryTargetsMatch } from "../../../infra/outbound/source-delivery-plan.js";
import { deriveSessionChatTypeFromKey } from "../../../sessions/session-chat-type-shared.js";
import { isNonTerminalAgentRunStatus } from "../../../shared/agent-run-status.js";
import { sanitizeAgentRunTerminalReplyText } from "../../agent-run-terminal-reply.js";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
} from "../../embedded-agent-runner/delivery-evidence.js";
import type { AgentInternalEvent } from "../../internal-events.js";
import {
  sourceOwnerChangedResult,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  sendSubagentAnnounceMessage,
  tryResolveSubagentRequesterAgentId,
} from "./subagent-announce-delivery.runtime.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { inferDeliveryTargetChatType } from "./subagent-announce-origin.js";

export function isGatewayAgentRunPending(response: unknown): boolean {
  if (!response || typeof response !== "object") {
    return false;
  }
  const status = (response as { status?: unknown }).status;
  return isNonTerminalAgentRunStatus(status);
}

export function isDirectMessageDeliveryTarget(
  target: { channel?: string; to?: string; threadId?: string },
  requesterSessionKey: string,
): boolean {
  if (target.threadId) {
    return false;
  }
  const targetChatType = inferDeliveryTargetChatType(target);
  if (targetChatType) {
    return targetChatType === "direct";
  }
  return deriveSessionChatTypeFromKey(requesterSessionKey) === "direct";
}

function resolveTextCompletionDirectFallback(events: readonly AgentInternalEvent[] | undefined) {
  for (let index = (events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = events?.[index];
    if (event?.type !== "task_completion" || event.source !== "subagent") {
      continue;
    }
    if (event.status !== "ok") {
      continue;
    }
    const result =
      typeof event.result === "string"
        ? sanitizeAgentRunTerminalReplyText(sanitizePendingFinalDeliveryText(event.result))
        : "";
    if (result && result !== "(no output)") {
      return result;
    }
  }
  return undefined;
}

export function hasFailedSubagentNoOutputCompletion(
  events: readonly AgentInternalEvent[] | undefined,
) {
  return (
    events?.some(
      (event) =>
        event.type === "task_completion" &&
        event.source === "subagent" &&
        event.status !== "ok" &&
        event.result.trim() === "(no output)",
    ) === true
  );
}

export async function deliverCompletionDirect(params: {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  requesterAgentId?: string;
  directIdempotencyKey: string;
  deliveryTarget: {
    deliver: boolean;
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string;
  };
  internalEvents?: readonly AgentInternalEvent[];
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  isSourceSessionEffectsAllowed?: () => boolean;
}): Promise<SubagentAnnounceDeliveryResult | undefined> {
  const content = resolveTextCompletionDirectFallback(params.internalEvents);
  if (
    !content ||
    !params.deliveryTarget.deliver ||
    !params.deliveryTarget.channel ||
    !params.deliveryTarget.to ||
    !isDirectMessageDeliveryTarget(params.deliveryTarget, params.requesterSessionKey)
  ) {
    return undefined;
  }
  const agentId = tryResolveSubagentRequesterAgentId(
    params.cfg,
    params.requesterSessionKey,
    params.requesterAgentId,
  );
  if (!agentId) {
    return undefined;
  }
  const idempotencyKey = `${params.directIdempotencyKey}:text-direct`;
  let committedDelivery: SubagentAnnounceDeliveryResult | undefined;
  try {
    if (params.isSourceSessionEffectsAllowed?.() === false) {
      return sourceOwnerChangedResult();
    }
    const sendResult = await sendSubagentAnnounceMessage({
      cfg: params.cfg,
      channel: params.deliveryTarget.channel,
      to: params.deliveryTarget.to,
      accountId: params.deliveryTarget.accountId,
      threadId: params.deliveryTarget.threadId,
      requesterSessionKey: params.requesterSessionKey,
      agentId,
      conversationType: "direct",
      content,
      idempotencyKey,
      onDeliveryResult: () => {
        if (committedDelivery) {
          return;
        }
        // Platform identity is committed before transcript mirroring, which
        // may wait behind the requester's still-active SQLite writer.
        committedDelivery = { delivered: true, path: "direct", deliveredAt: Date.now() };
        params.onDeliveryResult?.(committedDelivery);
      },
      mirror: {
        sessionKey: params.requesterSessionKey,
        agentId,
        idempotencyKey,
      },
    });
    if (committedDelivery) {
      return committedDelivery;
    }
    if (sendResult.deliveryStatus === "suppressed") {
      const ambiguous = sendResult.suppressionReason === "adapter_returned_no_identity";
      return {
        delivered: false,
        path: "direct",
        error: ambiguous
          ? "text completion direct delivery could not be confirmed: adapter returned no identity"
          : `text completion direct delivery was suppressed: ${sendResult.suppressionReason ?? "unknown reason"}`,
        ...(ambiguous
          ? { disposition: "ambiguous" as const }
          : { disposition: "intentional_non_delivery" as const, terminal: true }),
      };
    }
    return { delivered: true, path: "direct" };
  } catch (err) {
    if (committedDelivery) {
      // Post-send bookkeeping must never turn an identified delivery into a
      // retryable failure and send the same completion twice.
      return committedDelivery;
    }
    return {
      delivered: false,
      path: "direct",
      error: `text completion direct delivery failed: ${summarizeDeliveryError(err)}`,
    };
  }
}

export function hasMessagingToolDeliveryToSource(
  result: {
    didDeliverSourceReplyViaMessageTool?: unknown;
    didSendViaMessagingTool?: unknown;
    messagingToolSentTargets?: unknown;
    messagingToolSourceReplyPayloads?: unknown;
  },
  deliveryTarget: Parameters<typeof sourceDeliveryTargetsMatch>[1],
  options?: { requireFinalReply?: boolean },
): boolean {
  const targets = Array.isArray(result.messagingToolSentTargets)
    ? result.messagingToolSentTargets
    : [];
  const sourceTargets = targets.filter((target) => {
    if (
      !target ||
      typeof target !== "object" ||
      Array.isArray(target) ||
      !deliveryTarget.channel ||
      !deliveryTarget.to
    ) {
      return false;
    }
    const record = target as Parameters<typeof sourceDeliveryTargetsMatch>[0];
    // Older source receipts omit `to`; explicit off-target sends must never satisfy it.
    const sourceTarget =
      typeof record.to === "string" && record.to.trim()
        ? record
        : { ...record, to: deliveryTarget.to };
    return sourceDeliveryTargetsMatch(sourceTarget, deliveryTarget);
  });
  if (options?.requireFinalReply) {
    const hasCommittedSourceDelivery =
      hasCommittedSourceReplyDeliveryEvidence(result) ||
      (hasMessagingToolDeliveryEvidence(result) && sourceTargets.length > 0);
    // Only current-source final markers count; another target's final cannot
    // turn a source progress update into the owed requester reply.
    return (
      hasCommittedSourceDelivery &&
      resolveExplicitFinalSourceReplyDeliveryEvidence({
        messagingToolSentTargets: sourceTargets,
        messagingToolSourceReplyPayloads: result.messagingToolSourceReplyPayloads,
      }) !== false
    );
  }
  if (
    hasCommittedSourceReplyDeliveryEvidence(result) ||
    hasUnaccountedMessagingToolAggregateEvidence({ ...result, didSendViaMessagingTool: false })
  ) {
    return true;
  }

  if (targets.length === 0 || !deliveryTarget.channel || !deliveryTarget.to) {
    return hasMessagingToolDeliveryEvidence(result);
  }

  return hasMessagingToolDeliveryEvidence(result) && sourceTargets.length > 0;
}
