import {
  ErrorCodes,
  errorShape,
  type SessionSuggestionEvent,
} from "../../../packages/gateway-protocol/src/index.js";
import { hasOperatorBoundary } from "../operator-role-policy.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionSharingTarget,
  createSessionListEntryFilter,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "../session-sharing.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export function requireSuggestionTarget(params: {
  client: GatewayClient | null;
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
  if (
    !target ||
    (hasOperatorBoundary(params.client, cfg) &&
      createSessionListEntryFilter({ client: params.client, cfg })?.(
        target.storeKey,
        target.entry,
      ) === false)
  ) {
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
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  client: GatewayClient | null;
  sessionKey: string;
  target: NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
  respond: RespondFn;
}) {
  const role = resolveSessionSharingRole({
    client: params.client,
    cfg: params.cfg,
    target: params.target,
  });
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
  const error = authorizeSessionSharingTarget({
    client: params.client,
    cfg: params.cfg,
    target: params.target,
  });
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
