// Heartbeat reply payload selector for multi-payload auto-reply results.
import {
  hasOutboundReplyContent,
  isReasoningReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { getReplyPayloadMetadata } from "./reply-payload.js";
import type { ReplyPayload } from "./types.js";

export type HeartbeatTerminalToolFailure = {
  toolName: string;
};

/** Resolve structured terminal tool-failure state carried by an agent reply. */
export function resolveHeartbeatTerminalToolFailure(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): HeartbeatTerminalToolFailure | undefined {
  if (!replyResult) {
    return undefined;
  }
  const payloads = Array.isArray(replyResult) ? replyResult : [replyResult];
  for (let idx = payloads.length - 1; idx >= 0; idx -= 1) {
    const payload = payloads[idx];
    if (!payload) {
      continue;
    }
    const failure = getReplyPayloadMetadata(payload)?.heartbeatTerminalToolFailure;
    if (failure) {
      return failure;
    }
  }
  return undefined;
}

/**
 * Pick the last outbound-capable reply payload for heartbeat delivery.
 *
 * Reasoning payloads are skipped using the shared SDK classifier
 * `isReasoningReplyPayload`, which recognizes the `isReasoning` flag plus the
 * common reasoning/thinking text prefixes (including lowercased and Markdown
 * blockquoted forms). Heartbeat reasoning is delivered separately and only when
 * `includeReasoning` is enabled; without this guard a trailing reasoning
 * payload (which reasoning models can emit after the final answer) would be
 * selected as the user-visible heartbeat reply.
 */
export function resolveHeartbeatReplyPayload(
  replyResult: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  if (!replyResult) {
    return undefined;
  }
  if (!Array.isArray(replyResult)) {
    // Scalar results can be reasoning-only too; without this guard a scalar
    // reasoning payload becomes the user-visible reply while the array path
    // filters it, so the leak depends on the result shape.
    return isReasoningReplyPayload(replyResult) ? undefined : replyResult;
  }
  for (let idx = replyResult.length - 1; idx >= 0; idx -= 1) {
    const payload = replyResult[idx];
    if (!payload) {
      continue;
    }
    if (isReasoningReplyPayload(payload)) {
      continue;
    }
    if (hasOutboundReplyContent(payload)) {
      return payload;
    }
  }
  return undefined;
}
