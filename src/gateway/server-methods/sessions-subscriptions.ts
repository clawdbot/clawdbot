// Session and transcript event subscription handlers.
import {
  ErrorCodes,
  errorShape,
  validateSessionsMessagesSubscribeParams,
  validateSessionsMessagesUnsubscribeParams,
  validateSessionsListParams,
  validateSessionsViewerPresenceSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { canReviewOperatorApproval } from "../operator-approval-authorization.js";
import { APPROVALS_SCOPE } from "../operator-scopes.js";
import { sessionObserverScopeKey } from "../session-observer-model.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveSessionSubscriptionKey } from "../session-subscription-keys.js";
import { resolveSessionStoreKey } from "../session-utils.js";
import { sessionsListHandler } from "./sessions-read.js";
import { requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const sessionSubscriptionHandlers: GatewayRequestHandlers = {
  "sessions.subscribe": async (options) => {
    const { client, context, params, respond } = options;
    if (!assertValidParams(params, validateSessionsListParams, "sessions.subscribe", respond)) {
      return;
    }
    const connId = client?.connId?.trim();
    if (connId) {
      // Subscribe before projecting the snapshot so mutations during the read
      // become live events; the UI queues one trailing refresh when needed.
      context.subscribeSessionEvents(connId);
    }
    if (!connId || Object.keys(params).length === 0) {
      respond(true, { subscribed: Boolean(connId) }, undefined);
      return;
    }
    await sessionsListHandler({
      ...options,
      params,
      respond: (ok, payload, error, meta) => {
        respond(ok, ok ? { subscribed: true, list: payload } : undefined, error, meta);
      },
    });
  },
  "sessions.viewers.set": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsViewerPresenceSetParams,
        "sessions.viewers.set",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const declarations = context.sessionViewerPresence;
    if (!connId || !declarations) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "session viewer presence unavailable"),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    const canonicalKeys: string[] = [];
    for (const rawKey of params.sessionKeys) {
      const trimmed = rawKey.trim();
      if (!trimmed) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid sessions.viewers.set params"),
        );
        return;
      }
      const requested = resolveRequestedSessionAgentId(
        cfg,
        trimmed,
        parseAgentSessionKey(trimmed) ? undefined : params.agentId,
      );
      if (!requested.ok) {
        respond(false, undefined, requested.error);
        return;
      }
      const canonicalKey = resolveSessionStoreKey({
        cfg,
        sessionKey: trimmed,
        storeAgentId: requested.agentId,
      });
      canonicalKeys.push(sessionObserverScopeKey(canonicalKey, requested.agentId));
    }
    const sessionKeys = declarations.replace(connId, canonicalKeys);
    respond(true, { sessionKeys }, undefined);
  },
  "sessions.messages.subscribe": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesSubscribeParams,
        "sessions.messages.subscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    if (p.includeApprovals === true && !canReviewOperatorApproval(client)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `sessions.messages.subscribe includeApprovals requires a paired device and gateway scope: ${APPROVALS_SCOPE}`,
        ),
      );
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const canonicalKey = resolveSessionStoreKey({
      cfg,
      sessionKey: key,
      storeAgentId: requestedAgentId,
    });
    const subscriptionKey = resolveSessionSubscriptionKey(canonicalKey, requestedAgentId);
    if (connId) {
      let approvalReplay;
      if (p.includeApprovals === true) {
        // Subscribe before the authoritative snapshot so a transition cannot
        // land between replay and live delivery. Clients reconcile by id.
        const rollbackSubscription = context.subscribeSessionMessageEvents(
          connId,
          subscriptionKey,
          { includeApprovals: true, provisional: true },
        );
        try {
          approvalReplay = context.listSessionPendingApprovals?.(subscriptionKey, client);
        } catch (error) {
          rollbackSubscription?.();
          context.logGateway.error(`session approval replay failed: ${String(error)}`);
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "session approval replay unavailable"),
          );
          return;
        }
        if (!approvalReplay) {
          rollbackSubscription?.();
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "session approval replay unavailable"),
          );
          return;
        }
        rollbackSubscription?.commit?.();
      } else {
        context.subscribeSessionMessageEvents(connId, subscriptionKey);
      }
      respond(
        true,
        {
          subscribed: true,
          key: canonicalKey,
          ...(p.includeApprovals === true
            ? {
                approvalReplay,
              }
            : {}),
        },
        undefined,
      );
      return;
    }
    respond(true, { subscribed: false, key: canonicalKey }, undefined);
  },
  "sessions.messages.unsubscribe": ({ params, client, context, respond }) => {
    if (
      !assertValidParams(
        params,
        validateSessionsMessagesUnsubscribeParams,
        "sessions.messages.unsubscribe",
        respond,
      )
    ) {
      return;
    }
    const connId = client?.connId?.trim();
    const p = params;
    const key = requireSessionKey(p.key, respond);
    if (!key) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const requestedAgent = resolveRequestedSessionAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      respond(false, undefined, requestedAgent.error);
      return;
    }
    const requestedAgentId = requestedAgent.agentId;
    const canonicalKey = resolveSessionStoreKey({
      cfg,
      sessionKey: key,
      storeAgentId: requestedAgentId,
    });
    const subscriptionKey = resolveSessionSubscriptionKey(canonicalKey, requestedAgentId);
    if (connId) {
      context.unsubscribeSessionMessageEvents(connId, subscriptionKey);
    }
    respond(true, { subscribed: false, key: canonicalKey }, undefined);
  },
};
