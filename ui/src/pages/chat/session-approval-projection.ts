import { Value } from "typebox/value";
import type { PendingApprovalSnapshot } from "../../../../packages/gateway-protocol/src/index.js";
import {
  SessionApprovalEventSchema,
  SessionApprovalReplaySchema,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { ExecApprovalRequest } from "../../app/exec-approval.ts";
import {
  isUiGlobalSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../lib/sessions/session-key.ts";

function approvalStreamMatchesSession(
  streamSessionKey: string,
  sessionKey: string,
  selectedAgentId?: string,
): boolean {
  if (streamSessionKey === sessionKey) {
    return true;
  }
  const stream = parseAgentSessionKey(streamSessionKey);
  return Boolean(
    selectedAgentId &&
    isUiGlobalSessionKey(sessionKey) &&
    stream?.rest === "global" &&
    normalizeAgentId(stream.agentId) === normalizeAgentId(selectedAgentId),
  );
}

function projectPendingApproval(
  approval: PendingApprovalSnapshot,
  sessionKey: string,
  sourceSessionKey?: string,
): ExecApprovalRequest {
  const presentation = approval.presentation;
  const common = {
    id: approval.id,
    request: {
      command: presentation.kind === "exec" ? presentation.commandText : presentation.title,
      agentId: presentation.agentId ?? null,
      sessionKey,
      allowedDecisions: presentation.allowedDecisions,
    },
    ...(sourceSessionKey && sourceSessionKey !== sessionKey ? { sourceSessionKey } : {}),
    createdAtMs: approval.createdAtMs,
    expiresAtMs: approval.expiresAtMs,
  } satisfies Partial<ExecApprovalRequest>;
  if (presentation.kind === "exec") {
    return {
      ...common,
      kind: "exec",
      request: {
        ...common.request,
        host: presentation.host ?? null,
      },
    };
  }
  if (presentation.kind === "plugin") {
    return {
      ...common,
      kind: "plugin",
      pluginTitle: presentation.title,
      pluginDescription: presentation.description,
      pluginSeverity: presentation.severity,
      pluginId: presentation.pluginId ?? null,
    };
  }
  return {
    ...common,
    kind: "system-agent",
    pluginTitle: presentation.title,
    pluginDescription: presentation.description,
    proposalHash: presentation.proposalHash,
  };
}

export function projectSessionApprovalReplay(
  value: unknown,
  sessionKey: string,
  selectedAgentId?: string,
): ExecApprovalRequest[] {
  if (!Value.Check(SessionApprovalReplaySchema, value)) {
    return [];
  }
  const replay = Value.Decode(SessionApprovalReplaySchema, value);
  if (!approvalStreamMatchesSession(replay.sessionKey, sessionKey, selectedAgentId)) {
    return [];
  }
  return replay.approvals
    .filter((approval) => approval.status === "pending")
    .map((approval) => projectPendingApproval(approval, sessionKey, approval.sourceSessionKey));
}

export function reconcileSessionApprovalEvent(
  queue: readonly ExecApprovalRequest[],
  value: unknown,
  sessionKey?: string,
  selectedAgentId?: string,
): ExecApprovalRequest[] | null {
  if (!Value.Check(SessionApprovalEventSchema, value)) {
    return null;
  }
  const event = Value.Decode(SessionApprovalEventSchema, value);
  const presentationSessionKey = sessionKey ?? event.sessionKey;
  if (!approvalStreamMatchesSession(event.sessionKey, presentationSessionKey, selectedAgentId)) {
    return null;
  }
  if (event.phase === "terminal") {
    return queue.filter((entry) => entry.id !== event.approval.id);
  }
  const next = queue.filter((entry) => entry.id !== event.approval.id);
  next.push(projectPendingApproval(event.approval, presentationSessionKey, event.sourceSessionKey));
  return next.toSorted((left, right) => left.createdAtMs - right.createdAtMs);
}
