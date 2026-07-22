import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import { AGENT_SESSION_RESET_COMMAND_RE } from "../agent-command-policy.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { formatForLog } from "../ws-log.js";
import { setGatewayDedupeEntries } from "./agent-dedupe.js";
import { clientHasAdminScope } from "./agent-handler-helpers.js";
import type { AgentRunRequest } from "./agent-request-types.js";
import {
  buildBareSessionResetResponse,
  loadBareSessionResetDeliverySession,
  resolveBareSessionResetResult,
  runSessionResetFromAgent,
} from "./agent-session-reset.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type CommittedResetCompletion = {
  reason: "new" | "reset";
  sessionId?: string;
  sessionKey: string;
  agentId?: string;
  followUpPending: boolean;
};

type AgentResetPhaseResult = {
  stop: boolean;
  accepted: boolean;
  requestedSessionKey?: string;
  resolvedSessionId?: string;
  effectiveTranscriptInputText: string;
  message: string;
};

export async function runAgentResetPhase(params: {
  request: AgentRunRequest;
  cfg: OpenClawConfig;
  requestedSessionKey?: string;
  resolvedSessionId?: string;
  effectiveTranscriptInputText: string;
  message: string;
  agentId?: string;
  sessionKeyFromTo?: string;
  lifecycleGeneration: string;
  runId: string;
  agentDedupeKeys: readonly string[];
  client: GatewayRequestHandlerOptions["client"];
  context: GatewayRequestHandlerOptions["context"];
  respond: GatewayRequestHandlerOptions["respond"];
  abortForLifecycleRotation: (target?: { sessionKey?: string; agentId?: string }) => boolean;
  setCommittedResetCompletion: (completion: CommittedResetCompletion) => void;
}): Promise<AgentResetPhaseResult> {
  const base = {
    requestedSessionKey: params.requestedSessionKey,
    resolvedSessionId: params.resolvedSessionId,
    effectiveTranscriptInputText: params.effectiveTranscriptInputText,
    message: params.message,
  };
  const resetCommandMatch = params.message.match(AGENT_SESSION_RESET_COMMAND_RE);
  if (!resetCommandMatch || !params.requestedSessionKey) {
    return { ...base, stop: false, accepted: false };
  }
  if (
    params.abortForLifecycleRotation({
      sessionKey: params.requestedSessionKey,
      agentId: params.agentId,
    })
  ) {
    return { ...base, stop: true, accepted: true };
  }
  const postResetMessage = normalizeOptionalString(resetCommandMatch[2]) ?? "";
  if (!clientHasAdminScope(params.client)) {
    params.respond(
      false,
      undefined,
      missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
    );
    return { ...base, stop: true, accepted: false };
  }
  const resetReason =
    normalizeOptionalLowercaseString(resetCommandMatch[1]) === "new" ? "new" : "reset";
  let resetResult: Awaited<ReturnType<typeof runSessionResetFromAgent>>;
  try {
    resetResult = await runSessionResetFromAgent({
      key: params.requestedSessionKey,
      ...(params.requestedSessionKey === "global" && params.agentId
        ? { agentId: params.agentId }
        : {}),
      reason: resetReason,
      createdBy: gatewayClientSessionCreator(params.client),
      assertCurrent: () => assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration),
      onCommitted: (commit) => {
        params.setCommittedResetCompletion({
          reason: resetReason,
          sessionId: commit.sessionId,
          sessionKey: commit.key,
          agentId: params.agentId,
          followUpPending: Boolean(postResetMessage),
        });
      },
    });
  } catch (err) {
    if (
      params.abortForLifecycleRotation({
        sessionKey: params.requestedSessionKey,
        agentId: params.agentId,
      })
    ) {
      return { ...base, stop: true, accepted: true };
    }
    throw err;
  }
  if (!resetResult.ok) {
    params.respond(false, undefined, resetResult.error);
    return { ...base, stop: true, accepted: false };
  }
  const next = {
    ...base,
    requestedSessionKey: resetResult.key,
    resolvedSessionId: resetResult.sessionId ?? params.resolvedSessionId,
  };
  params.setCommittedResetCompletion({
    reason: resetReason,
    sessionId: resetResult.sessionId,
    sessionKey: resetResult.key,
    agentId: params.agentId,
    followUpPending: Boolean(postResetMessage),
  });
  if (postResetMessage) {
    if (
      params.abortForLifecycleRotation({ sessionKey: resetResult.key, agentId: params.agentId })
    ) {
      return { ...next, stop: true, accepted: true };
    }
    return {
      ...next,
      stop: false,
      accepted: false,
      effectiveTranscriptInputText: postResetMessage,
      message: postResetMessage,
    };
  }

  try {
    const deliverySession =
      params.request.deliver === true
        ? loadBareSessionResetDeliverySession({
            cfg: params.cfg,
            sessionKey: resetResult.key,
            ...(params.agentId ? { agentId: params.agentId } : {}),
          })
        : undefined;
    const resetAckResult = await resolveBareSessionResetResult({
      cfg: deliverySession?.cfg ?? params.cfg,
      context: params.context,
      reason: resetReason,
      sessionId: resetResult.sessionId,
      sessionKey: resetResult.key,
      agentId: deliverySession?.agentId ?? params.agentId,
      sessionEntry: deliverySession?.entry,
      request: params.sessionKeyFromTo ? { ...params.request, to: undefined } : params.request,
      runId: params.runId,
      assertCurrent: () => assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration),
    });
    const responsePayload = buildBareSessionResetResponse({
      runId: params.runId,
      result: resetAckResult,
    });
    setGatewayDedupeEntries({
      dedupe: params.context.dedupe,
      keys: params.agentDedupeKeys,
      entry: { ts: Date.now(), ok: true, payload: responsePayload },
    });
    params.respond(true, responsePayload, undefined, { runId: params.runId });
    emitSessionsChanged(params.context, {
      sessionKey: resetResult.key,
      ...(resetResult.key === "global" && params.agentId ? { agentId: params.agentId } : {}),
      reason: resetReason,
    });
    return { ...next, stop: true, accepted: true };
  } catch (err) {
    if (
      params.abortForLifecycleRotation({ sessionKey: resetResult.key, agentId: params.agentId })
    ) {
      return { ...next, stop: true, accepted: true };
    }
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
    return { ...next, stop: true, accepted: false };
  }
}
