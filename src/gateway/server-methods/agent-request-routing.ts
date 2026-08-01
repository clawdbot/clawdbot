import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { isExecApprovalFollowupSessionRebound } from "../../agents/bash-tools.exec-approval-followup-state.js";
import {
  resolveAgentIdFromSessionKey,
  resolveExplicitAgentSessionKey,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { emitDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { resolveAgentExplicitRecipientSession } from "../../infra/outbound/agent-delivery.js";
import {
  classifySessionKeyShape,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { loadSessionEntry, resolveSessionStoreKey } from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import {
  validateExpectedExistingSessionTarget,
  type ExpectedExistingSessionConstraint,
} from "./agent-expected-session.js";
import { respondUnavailableAgentSessionForKey } from "./agent-handler-helpers.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

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
  context: GatewayRequestHandlerOptions["context"];
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
  if (!agentId && requestedSessionKeyRaw) {
    const parsed = parseAgentSessionKey(requestedSessionKeyRaw);
    const inferredAgentId =
      parsed &&
      resolveSessionStoreKey({ cfg: params.cfg, sessionKey: requestedSessionKeyRaw }) === "global"
        ? normalizeAgentId(parsed.agentId)
        : undefined;
    if (inferredAgentId && !knownAgents.includes(inferredAgentId)) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: unknown agent id "${parsed?.agentId}"`,
        ),
      );
      return undefined;
    }
    agentId = inferredAgentId;
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
    explicitRecipientSession?.sessionKey ??
    (!requestedSessionId
      ? resolveAgentExplicitRecipientSessionKey(params.cfg, agentId)
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
  if (agentId && requestedSessionKeyRaw) {
    const parsed = parseAgentSessionKey(requestedSessionKeyRaw);
    const canonicalKey = resolveSessionStoreKey({
      cfg: params.cfg,
      sessionKey: requestedSessionKeyRaw,
    });
    const sessionAgentId = parsed?.agentId
      ? normalizeAgentId(parsed.agentId)
      : canonicalKey === "global"
        ? agentId
        : resolveAgentIdFromSessionKey(requestedSessionKeyRaw, resolveDefaultAgentId(params.cfg));
    if (sessionAgentId !== agentId) {
      params.respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: agent "${params.request.agentId}" does not match session key agent "${sessionAgentId}"`,
        ),
      );
      return undefined;
    }
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
    })
  ) {
    return undefined;
  }
  const preAcceptedReservedSessionKey =
    requestedSessionKey &&
    resolveSessionStoreKey({ cfg: params.cfg, sessionKey: requestedSessionKey }) === "global"
      ? "global"
      : requestedSessionKey;
  if (preAcceptedReservedSessionKey) {
    params.reserveDedupe(preAcceptedReservedSessionKey, agentId);
  }
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
  execApprovalFollowupApprovalId?: string;
  runId: string;
  agentDedupeKeys: string[];
  context: GatewayRequestHandlerOptions["context"];
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
      loadSessionEntry(params.requestedSessionKeyRaw).entry?.sessionId,
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
