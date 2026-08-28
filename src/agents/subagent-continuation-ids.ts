import crypto from "node:crypto";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";

function deriveContinuationDigest(flowId: string): string {
  return crypto.createHash("sha256").update(flowId).digest("hex").slice(0, 32);
}

export function deriveContinuationDelegateChildSessionKey(
  targetAgentId: string,
  flowId: string,
): string {
  return `agent:${targetAgentId}:subagent:continuation-${deriveContinuationDigest(flowId)}`;
}

export function deriveContinuationDelegateChildSessionKeyFromParent(
  parentSessionKey: string,
  flowId: string,
): string {
  const parsed = parseAgentSessionKey(parentSessionKey);
  return deriveContinuationDelegateChildSessionKey(parsed?.agentId ?? "main", flowId);
}

export function deriveContinuationDelegateChildRunId(flowId: string): string {
  return `continuation-delegate-${deriveContinuationDigest(flowId)}`;
}
