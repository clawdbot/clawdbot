// Gateway shared request-state types.
// Defines cached dedupe entries for idempotent Gateway method calls.
import type { ErrorShape } from "../../packages/gateway-protocol/src/schema/frames.js";

export const PENDING_CHAT_SEND_DEDUPE_PREFIX = "pending-chat:";

export function pendingChatSendDedupeKey(runId: string): string {
  return `${PENDING_CHAT_SEND_DEDUPE_PREFIX}${runId}`;
}

// Dedupe entries cache recent request results so repeated gateway calls can
// replay the same success/error payload without re-running the method.
export type DedupeEntry = {
  ts: number;
  ok: boolean;
  /** Optional effectful-request fingerprint for methods with caller-supplied operation ids. */
  requestIdentity?: string;
  /** Per-request recovery capability retained across agent-run dedupe state transitions. */
  agentReplayCapability?: string;
  payload?: unknown;
  error?: ErrorShape;
};
