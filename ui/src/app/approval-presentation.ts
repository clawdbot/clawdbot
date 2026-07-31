import { parseCatalogSessionKey } from "../lib/sessions/catalog-key.ts";
import {
  normalizeAgentId,
  normalizeSessionKeyForUiComparison,
  parseAgentSessionKey,
} from "../lib/sessions/session-key.ts";
import type { ExecApprovalRequest } from "./exec-approval.ts";

export type ApprovalBadgeSnapshot = {
  agentCounts: ReadonlyMap<string, number>;
  sessionKeys: ReadonlySet<string>;
};

export function findInlineApproval(
  queue: readonly ExecApprovalRequest[],
  sessionKey: string | null | undefined,
): ExecApprovalRequest | null {
  const normalizedSessionKey = normalizeSessionKeyForUiComparison(sessionKey);
  if (!normalizedSessionKey || parseCatalogSessionKey(normalizedSessionKey)) {
    return null;
  }
  return (
    queue.find(
      (entry) =>
        normalizeSessionKeyForUiComparison(entry.request.sessionKey) === normalizedSessionKey,
    ) ?? null
  );
}

export function modalApprovalQueue(
  queue: readonly ExecApprovalRequest[],
  inlineApprovalId: string | null | undefined,
): readonly ExecApprovalRequest[] {
  return inlineApprovalId ? queue.filter((entry) => entry.id !== inlineApprovalId) : queue;
}

export function deriveApprovalBadgeSnapshot(
  queue: readonly ExecApprovalRequest[],
): ApprovalBadgeSnapshot {
  const agentCounts = new Map<string, number>();
  const sessionKeys = new Set<string>();
  for (const entry of queue) {
    // agentId is optional on approval events; an agent-scoped session key
    // still names the owner, and dropping it would badge the session row
    // while the agent card shows no pending count.
    const agentId =
      entry.request.agentId?.trim() || parseAgentSessionKey(entry.request.sessionKey)?.agentId;
    if (agentId) {
      const normalizedAgentId = normalizeAgentId(agentId);
      agentCounts.set(normalizedAgentId, (agentCounts.get(normalizedAgentId) ?? 0) + 1);
    }
    const sessionKey = normalizeSessionKeyForUiComparison(entry.request.sessionKey);
    if (sessionKey) {
      sessionKeys.add(sessionKey);
    }
  }
  return { agentCounts, sessionKeys };
}

export function sessionHasPendingApproval(
  snapshot: ApprovalBadgeSnapshot,
  sessionKey: string | null | undefined,
): boolean {
  const normalizedSessionKey = normalizeSessionKeyForUiComparison(sessionKey);
  return normalizedSessionKey ? snapshot.sessionKeys.has(normalizedSessionKey) : false;
}
