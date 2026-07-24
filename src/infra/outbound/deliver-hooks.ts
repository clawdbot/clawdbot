// Applies outbound hooks and shapes stable delivery outcomes/errors.
import { runReplyPayloadSendingHook } from "../../auto-reply/reply/reply-payload-sending-hook.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { formatErrorMessage } from "../errors.js";
import {
  OutboundDeliveryError,
  type OutboundDeliveryFailureStage,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
  type OutboundPayloadDeliverySuppressionReason,
} from "./deliver-types.js";
import type { QueuedReplyPayloadSendingHook } from "./delivery-queue.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import type { OutboundChannel } from "./targets.js";

export { createMessageSentEmitter } from "./message-sent-hook.js";

export async function applyMessageSendingHook(params: {
  hookRunner: ReturnType<typeof getGlobalHookRunner>;
  enabled: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
  to: string;
  channel: Exclude<OutboundChannel, "none">;
  accountId?: string;
  replyToId?: string | null;
  threadId?: string | number | null;
  sessionKey?: string;
}): Promise<{
  cancelled: boolean;
  cancelReason?: string;
  hookMetadata?: Record<string, unknown>;
  contentRewritten: boolean;
  payload: ReplyPayload;
  payloadSummary: NormalizedOutboundPayload;
}> {
  if (!params.enabled) {
    return {
      cancelled: false,
      contentRewritten: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
  try {
    const sendingResult = await params.hookRunner!.runMessageSending(
      {
        to: params.to,
        content: params.payloadSummary.hookContent ?? params.payloadSummary.text,
        replyToId: params.replyToId ?? undefined,
        threadId: params.threadId ?? undefined,
        metadata: {
          channel: params.channel,
          accountId: params.accountId,
          mediaUrls: params.payloadSummary.mediaUrls,
        },
      },
      {
        channelId: params.channel,
        accountId: params.accountId ?? undefined,
        conversationId: params.to,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
      },
    );
    if (sendingResult?.cancel) {
      return {
        cancelled: true,
        ...(sendingResult.cancelReason ? { cancelReason: sendingResult.cancelReason } : {}),
        ...(sendingResult.metadata ? { hookMetadata: sendingResult.metadata } : {}),
        contentRewritten: false,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    if (sendingResult?.content == null) {
      return {
        cancelled: false,
        contentRewritten: false,
        payload: params.payload,
        payloadSummary: params.payloadSummary,
      };
    }
    if (params.payloadSummary.hookContent && !params.payloadSummary.text) {
      const spokenText = sendingResult.content;
      return {
        cancelled: false,
        contentRewritten: true,
        payload: {
          ...params.payload,
          spokenText,
        },
        payloadSummary: {
          ...params.payloadSummary,
          hookContent: spokenText,
        },
      };
    }
    const payload = {
      ...params.payload,
      text: sendingResult.content,
    };
    return {
      cancelled: false,
      contentRewritten: true,
      payload,
      payloadSummary: {
        ...params.payloadSummary,
        text: sendingResult.content,
      },
    };
  } catch {
    // Don't block delivery on hook failure.
    return {
      cancelled: false,
      contentRewritten: false,
      payload: params.payload,
      payloadSummary: params.payloadSummary,
    };
  }
}

export async function applyReplyPayloadSendingHook(params: {
  hook: QueuedReplyPayloadSendingHook | undefined;
  payload: ReplyPayload;
}): Promise<{
  cancelled: boolean;
  payload: ReplyPayload;
  changed: boolean;
}> {
  if (!params.hook) {
    return { cancelled: false, payload: params.payload, changed: false };
  }
  const nextPayload = await runReplyPayloadSendingHook({
    payload: params.payload,
    kind: params.hook.kind,
    ...(params.hook.channel ? { channel: params.hook.channel } : {}),
    ...(params.hook.sessionKey ? { sessionKey: params.hook.sessionKey } : {}),
    ...(params.hook.runId ? { runId: params.hook.runId } : {}),
    context: params.hook.context,
  });
  if (!nextPayload) {
    return { cancelled: true, payload: params.payload, changed: false };
  }
  return {
    cancelled: false,
    payload: nextPayload,
    changed: nextPayload !== params.payload,
  };
}

export function toOutboundDeliveryError(params: {
  error: unknown;
  results: readonly OutboundDeliveryResult[];
  payloadOutcomes: readonly OutboundPayloadDeliveryOutcome[];
  stage: OutboundDeliveryFailureStage;
}): OutboundDeliveryError {
  if (params.error instanceof OutboundDeliveryError) {
    return params.error;
  }
  return new OutboundDeliveryError(formatErrorMessage(params.error), {
    cause: params.error,
    results: params.results,
    payloadOutcomes: params.payloadOutcomes,
    stage: params.stage,
  });
}

export function suppressedPayloadOutcome(params: {
  index: number;
  reason: OutboundPayloadDeliverySuppressionReason;
  hookEffect?: {
    cancelReason?: string;
    metadata?: Record<string, unknown>;
  };
}): OutboundPayloadDeliveryOutcome {
  return {
    index: params.index,
    status: "suppressed",
    reason: params.reason,
    ...(params.hookEffect ? { hookEffect: params.hookEffect } : {}),
  };
}

/** Adds directive-derived media to the queue copy before spool custody. */
