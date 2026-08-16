import {
  ErrorCodes,
  errorShape,
  type SessionSuggestionEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionSharingTarget,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "../session-sharing.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export function requireSuggestionTarget(params: {
  context: GatewayRequestContext;
  sessionKey: string;
  agentId?: string;
  respond: RespondFn;
}) {
  const cfg = params.context.getRuntimeConfig();
  const requestedAgent = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requestedAgent.ok) {
    params.respond(false, undefined, requestedAgent.error);
    return null;
  }
  const target = resolveSessionSharingTarget({
    cfg,
    sessionKey: params.sessionKey,
    agentId: requestedAgent.agentId,
  });
  if (!target) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown session: ${params.sessionKey}`),
    );
    return null;
  }
  return target;
}

export function requireVisibleSuggestionRole(params: {
  client: GatewayClient | null;
  sessionKey: string;
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
  respond: RespondFn;
}) {
  const role = resolveSessionSharingRole({ client: params.client, target: params.target });
  const incognitoError = authorizeIncognitoSessionTarget({
    client: params.client,
    sessionKey: params.sessionKey,
    target: params.target,
  });
  if (incognitoError) {
    params.respond(false, undefined, incognitoError);
    return null;
  }
  if (resolveSessionVisibility(params.target.entry) !== "draft") {
    return role;
  }
  const error = authorizeSessionSharingTarget({ client: params.client, target: params.target });
  if (!error) {
    return role;
  }
  params.respond(false, undefined, error);
  return null;
}

export function publishSuggestion(
  context: GatewayRequestContext,
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>,
  requestedSessionKey: string,
  event: SessionSuggestionEvent,
): void {
  context.broadcast("session.suggestion", event, {
    sessionKeys: [
      ...new Set([requestedSessionKey, target.canonicalKey, target.storeKey]),
    ].toSorted(),
    agentId: event.suggestion.agentId,
  });
}
