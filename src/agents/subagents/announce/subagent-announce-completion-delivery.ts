/**
 * Direct completion fallback and source-delivery evidence for subagent announcements.
 */
import { sanitizePendingFinalDeliveryText } from "../../../auto-reply/reply/pending-final-delivery.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeOutboundReplyPayloadCore } from "../../../infra/outbound/reply-payload-normalize.js";
import { sourceDeliveryTargetsMatch } from "../../../infra/outbound/source-delivery-plan.js";
import { splitMediaFromOutput } from "../../../media/parse.js";
import { deriveSessionChatTypeFromKey } from "../../../sessions/session-chat-type-shared.js";
import { isNonTerminalAgentRunStatus } from "../../../shared/agent-run-status.js";
import { sanitizeAgentRunTerminalReplyText } from "../../agent-run-terminal-reply.js";
import {
  hasCommittedSourceReplyDeliveryEvidence,
  hasMessagingToolDeliveryEvidence,
  hasUnaccountedMessagingToolAggregateEvidence,
  resolveExplicitFinalSourceReplyDeliveryEvidence,
} from "../../embedded-agent-runner/delivery-evidence.js";
import { hasVisibleAgentPayload } from "../../embedded-agent-runner/message-visibility.js";
import { collectAgentInternalEventMedia, type AgentInternalEvent } from "../../internal-events.js";
import {
  SourceOwnerChangedError,
  sourceOwnerChangedResult,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  sendSubagentAnnounceMessage,
  tryResolveSubagentRequesterAgentId,
} from "./subagent-announce-delivery.runtime.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { inferDeliveryTargetChatType } from "./subagent-announce-origin.js";

const FAILED_COMPLETION_NOTICE =
  "A delegated task failed before it could report a result. Please retry the task.";

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

type DirectCompletionContent = { content: string; mediaUrls: string[] };

function collectDirectCompletionContent(params: {
  agentResult?: { payloads?: unknown };
  events: readonly AgentInternalEvent[] | undefined;
  contentKind: "completed_result" | "failed_notice";
}): DirectCompletionContent | undefined {
  if (params.contentKind === "failed_notice") {
    return { content: FAILED_COMPLETION_NOTICE, mediaUrls: [] };
  }
  const collect = (payloads: readonly unknown[]): DirectCompletionContent | undefined => {
    const textParts: string[] = [];
    const mediaUrls = new Set<string>();
    for (const payload of payloads) {
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        continue;
      }
      // SAFETY: The object/array guard above narrows payload to a plain record boundary.
      const record = payload as Record<string, unknown>;
      if (
        !hasVisibleAgentPayload(
          { payloads: [record] },
          {
            includeErrorPayloads: false,
            includeReasoningPayloads: false,
            includeSilentReplyPayloads: false,
            requireTerminalContent: true,
          },
        )
      ) {
        continue;
      }
      const normalized = normalizeOutboundReplyPayloadCore(record);
      const parsed = splitMediaFromOutput(normalized.text ?? "");
      const text = sanitizeAgentRunTerminalReplyText(sanitizePendingFinalDeliveryText(parsed.text));
      if (text && text !== "(no output)") {
        textParts.push(text);
      }
      for (const mediaUrl of [
        ...(normalized.mediaUrl ? [normalized.mediaUrl] : []),
        ...(normalized.mediaUrls ?? []),
        ...(parsed.mediaUrls ?? []),
      ]) {
        mediaUrls.add(mediaUrl);
      }
    }
    return textParts.length > 0 || mediaUrls.size > 0
      ? { content: textParts.join("\n\n"), mediaUrls: [...mediaUrls] }
      : undefined;
  };

  const payloadContent = Array.isArray(params.agentResult?.payloads)
    ? collect(params.agentResult.payloads)
    : undefined;
  if (payloadContent && payloadContent.mediaUrls.length > 0) {
    return payloadContent;
  }
  for (let index = (params.events?.length ?? 0) - 1; index >= 0; index -= 1) {
    const event = params.events?.[index];
    if (event?.type !== "task_completion" || event.source !== "subagent" || event.status !== "ok") {
      continue;
    }
    const parsedEvent = collect([{ text: event.result }]);
    const eventMediaUrls = collectAgentInternalEventMedia([event]).mediaUrls;
    const mediaUrls = new Set([...(parsedEvent?.mediaUrls ?? []), ...eventMediaUrls]);
    if (parsedEvent || mediaUrls.size > 0) {
      return {
        content: parsedEvent?.content ?? "",
        mediaUrls: [...mediaUrls],
      };
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
  contentKind: "completed_result" | "failed_notice";
  signal?: AbortSignal;
  agentResult?: { payloads?: unknown };
  onDeliveryResult?: (delivery: SubagentAnnounceDeliveryResult) => void;
  isSourceSessionEffectsAllowed?: () => boolean;
}): Promise<SubagentAnnounceDeliveryResult | undefined> {
  const completionContent = collectDirectCompletionContent({
    agentResult: params.agentResult,
    events: params.internalEvents,
    contentKind: params.contentKind,
  });
  if (
    !completionContent ||
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
    if (params.signal?.aborted) {
      return { delivered: false, path: "none" };
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
      content: completionContent.content,
      ...(completionContent.mediaUrls.length > 0 ? { mediaUrls: completionContent.mediaUrls } : {}),
      idempotencyKey,
      skipQueue: true,
      abortSignal: params.signal,
      onPlatformSendDispatch: async () => {
        params.signal?.throwIfAborted();
        if (params.isSourceSessionEffectsAllowed?.() === false) {
          throw new SourceOwnerChangedError();
        }
      },
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
    if (err instanceof SourceOwnerChangedError) {
      return sourceOwnerChangedResult();
    }
    if (params.signal?.aborted) {
      return { delivered: false, path: "none" };
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
