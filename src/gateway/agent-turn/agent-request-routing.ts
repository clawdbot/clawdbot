import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../../agents/agent-scope.js";
import { isExecApprovalFollowupSessionRebound } from "../../agents/bash-tools.exec-approval-followup-state.js";
import { resolveExistingSessionKeyForRequest } from "../../agents/command/session.js";
import { resolveExplicitAgentSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { resolveAgentExplicitRecipientSession } from "../../infra/outbound/agent-delivery.js";
import { classifySessionKeyShape, normalizeAgentId } from "../../routing/session-key.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import {
  validateExpectedExistingSessionTarget,
  type ExpectedExistingSessionConstraint,
} from "../server-methods/agent-expected-session.js";
import type { AgentRunRequest } from "../server-methods/agent-request-types.js";
import { normalizeRpcAttachmentsToChatAttachments } from "../server-methods/attachment-normalize.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { loadSessionEntry, resolveSessionStoreKey } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { respondUnavailableAgentSessionForKey } from "./agent-handler-helpers.js";
import type { AgentTurnContext } from "./types.js";

type ExplicitRecipientSession = Awaited<ReturnType<typeof resolveAgentExplicitRecipientSession>>;

type AgentRequestRouting = {
  normalizedAttachments: ReturnType<typeof normalizeRpcAttachmentsToChatAttachments>;
  requestedBestEffortDeliver?: boolean;
  knownAgents: string[];
  agentId?: string;
  requestedSessionId?: string;
  requestedToRaw?: string;
  sessionKeyFromTo?: string;
  requestedSessionKeyRaw?: string;
  requestedSessionKey?: string;
  explicitRecipientSession?: ExplicitRecipientSession;
  preAcceptedReservedSessionKey?: string;
  preAttachmentSession?: { canonicalKey: string; sessionId: string };
};

export async function prepareAgentRequestRouting(params: {
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  expectedSession?: ExpectedExistingSessionConstraint;
  isRawModelRun: boolean;
  execApprovalFollowupApprovalId?: string;
  runId: string;
  agentDedupeKeys: string[];
  context: AgentTurnContext;
  respond: GatewayRequestHandlerOptions["respond"];
  reserveDedupe: (sessionKey?: string, agentId?: string) => void;
  clearDedupe: () => void;
}): Promise<AgentRequestRouting | undefined> {
  const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(
    params.request.attachments,
  );
  const requestedBestEffortDeliver =
    typeof params.request.bestEffortDeliver === "boolean"
      ? params.request.bestEffortDeliver
      : undefined;
  const knownAgents = listAgentIds(params.cfg);
  const agentIdRaw = normalizeOptionalString(params.request.agentId) ?? "";
  let agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
  if (agentId && !knownAgents.includes(agentId)) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid agent params: unknown agent id "${params.request.agentId}"`,
      ),
    );
    return undefined;
  }
  const requestedSessionKeyParam = normalizeOptionalString(params.request.sessionKey);
  const requestedSessionId = normalizeOptionalString(params.request.sessionId);
  const requestedToRaw = normalizeOptionalString(params.request.to);
  const sessionKeyFromTo =
    !requestedSessionKeyParam &&
    !requestedSessionId &&
    classifySessionKeyShape(requestedToRaw) === "agent"
      ? requestedToRaw
      : undefined;
  const requestedSessionKeyRaw = requestedSessionKeyParam ?? sessionKeyFromTo;
  if (
    requestedSessionKeyRaw &&
    classifySessionKeyShape(requestedSessionKeyRaw) === "malformed_agent"
  ) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid agent params: malformed session key "${requestedSessionKeyRaw}"`,
      ),
    );
    return undefined;
  }
  if (requestedSessionKeyRaw) {
    const requestedSessionAgent = resolveRequestedSessionAgentId(
      params.cfg,
      requestedSessionKeyRaw,
      agentId,
    );
    if (!requestedSessionAgent.ok) {
      params.respond(false, undefined, requestedSessionAgent.error);
      return undefined;
    }
    agentId = requestedSessionAgent.agentId;
  }
  let sessionIdTarget: ReturnType<typeof resolveExistingSessionKeyForRequest> | undefined;
  if (requestedSessionId && !requestedSessionKeyRaw) {
    try {
      sessionIdTarget = resolveExistingSessionKeyForRequest({
        cfg: params.cfg,
        sessionId: requestedSessionId,
        agentId,
        clone: false,
      });
      agentId = sessionIdTarget.agentId ?? agentId;
    } catch (error) {
      params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(error)));
      return undefined;
    }
  }
  if (!requestedSessionKeyRaw && !requestedSessionId && !agentId) {
    const implicitMainOwner = resolveRequestedSessionAgentId(params.cfg, "main");
    if (!implicitMainOwner.ok) {
      params.respond(false, undefined, implicitMainOwner.error);
      return undefined;
    }
    agentId = implicitMainOwner.agentId;
  }
  const explicitRecipientChannel = normalizeMessageChannel(params.request.channel);
  const explicitRecipient =
    !requestedSessionKeyRaw &&
    !requestedSessionId &&
    agentId &&
    explicitRecipientChannel &&
    isDeliverableMessageChannel(explicitRecipientChannel) &&
    requestedToRaw
      ? { agentId, channel: explicitRecipientChannel, to: requestedToRaw }
      : undefined;
  let explicitRecipientSession: ExplicitRecipientSession | undefined;
  if (explicitRecipient) {
    // Reservation protects the asynchronous provider-owned route lookup from duplicate starts.
    params.reserveDedupe(undefined, explicitRecipient.agentId);
    try {
      explicitRecipientSession = await resolveAgentExplicitRecipientSession({
        cfg: params.cfg,
        agentId: explicitRecipient.agentId,
        channel: explicitRecipient.channel,
        to: explicitRecipient.to,
        accountId: normalizeOptionalString(params.request.accountId),
        threadId: params.request.threadId,
      });
    } catch (error) {
      params.clearDedupe();
      params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(error)));
      return undefined;
    }
  }
  if (explicitRecipientSession?.error) {
    params.clearDedupe();
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, explicitRecipientSession.error.message),
    );
    return undefined;
  }
  const requestedSessionKey =
    requestedSessionKeyRaw ??
    sessionIdTarget?.sessionKey ??
    explicitRecipientSession?.sessionKey ??
    // Ownership selection alone must not turn a sessionless run into a main-session write.
    (!requestedSessionId
      ? resolveAgentExplicitRecipientSessionKey(params.cfg, agentIdRaw ? agentId : undefined)
      : undefined);
  const expectedSessionTargetError = validateExpectedExistingSessionTarget({
    constraint: params.expectedSession,
    requestedSessionId,
    requestedSessionKey,
  });
  if (expectedSessionTargetError) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, expectedSessionTargetError),
    );
    return undefined;
  }
  if (
    requestedSessionKey &&
    respondUnavailableAgentSessionForKey({
      sessionKey: requestedSessionKey,
      requestedSessionId,
      isRawModelRun: params.isRawModelRun,
      agentId,
      respond: params.respond,
    })
  ) {
    params.clearDedupe();
    return undefined;
  }
  if (
    dropReboundExecApprovalFollowup({
      ...params,
      requestedSessionKeyRaw,
      agentId,
    })
  ) {
    return undefined;
  }
  const preAcceptedReservedSessionKey =
    requestedSessionKey &&
    resolveSessionStoreKey({
      cfg: params.cfg,
      sessionKey: requestedSessionKey,
      storeAgentId: agentId,
    }) === "global"
      ? "global"
      : requestedSessionKey;
  // Keyless runs still need the run-id reservation before asynchronous preparation,
  // otherwise concurrent callers can dispatch the same id without a session owner.
  params.reserveDedupe(preAcceptedReservedSessionKey, agentId);
  const loaded = requestedSessionKey
    ? loadSessionEntry(requestedSessionKey, {
        ...(agentId ? { agentId } : {}),
        clone: false,
      })
    : undefined;
  return {
    normalizedAttachments,
    requestedBestEffortDeliver,
    knownAgents,
    agentId,
    requestedSessionId,
    requestedToRaw,
    sessionKeyFromTo,
    requestedSessionKeyRaw,
    requestedSessionKey,
    explicitRecipientSession,
    preAcceptedReservedSessionKey,
    preAttachmentSession: loaded?.entry
      ? { canonicalKey: loaded.canonicalKey, sessionId: loaded.entry.sessionId }
      : undefined,
  };
}

function resolveAgentExplicitRecipientSessionKey(cfg: OpenClawConfig, agentId?: string) {
  return resolveExplicitAgentSessionKey({ cfg, agentId });
}

function dropReboundExecApprovalFollowup(params: {
  request: AgentRunRequest;
  requestedSessionKeyRaw?: string;
  agentId?: string;
  execApprovalFollowupApprovalId?: string;
  runId: string;
  agentDedupeKeys: string[];
  context: AgentTurnContext;
  respond: GatewayRequestHandlerOptions["respond"];
}): boolean {
  if (!params.execApprovalFollowupApprovalId || !params.requestedSessionKeyRaw) {
    return false;
  }
  const expectedSessionId = normalizeOptionalString(
    params.request.execApprovalFollowupExpectedSessionId,
  );
  let currentSessionId: string | undefined;
  try {
    currentSessionId = normalizeOptionalString(
      loadSessionEntry(params.requestedSessionKeyRaw, {
        ...(params.agentId ? { agentId: params.agentId } : {}),
        clone: false,
      }).entry?.sessionId,
    );
  } catch {
    currentSessionId = undefined;
  }
  if (
    !isExecApprovalFollowupSessionRebound({
      expectedSessionId,
      resolvedSessionId: currentSessionId,
    })
  ) {
    return false;
  }
  emitDiagnosticEvent({
    type: "exec.approval.followup_suppressed",
    approvalId: params.execApprovalFollowupApprovalId,
    reason: "session_rebound",
    phase: "gateway_preflight",
  });
  params.context.logGateway.info(
    `Dropping stale exec approval followup ${params.execApprovalFollowupApprovalId}: session ${params.requestedSessionKeyRaw} rebound (expected ${expectedSessionId}, current ${currentSessionId}) before the approval resolved`,
  );
  const droppedPayload = {
    runId: params.runId,
    status: "ok" as const,
    summary: "exec approval followup dropped: session was reset before the approval resolved",
  };
  setGatewayDedupeEntries({
    dedupe: params.context.dedupe,
    keys: params.agentDedupeKeys,
    entry: { ts: Date.now(), ok: true, payload: droppedPayload },
  });
  params.respond(true, droppedPayload, undefined, { runId: params.runId });
  return true;
}
