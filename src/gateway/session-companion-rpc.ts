import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  GatewayErrorDetailCodes,
  validateSessionsCompanionAskParams,
  validateSessionsCompanionResetParams,
  validateSessionsCompanionStateParams,
  type SessionsCompanionAskParams,
  type SessionsCompanionResetParams,
  type SessionsCompanionStateParams,
} from "../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { SessionCompanionAskError } from "./session-companion-ask.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { resolveSessionStoreKey } from "./session-store-key.js";

function resolveCompanionTarget(
  params: { sessionKey: string; agentId?: string | undefined },
  context: Parameters<GatewayRequestHandlers[string]>[0]["context"],
) {
  const cfg = context.getRuntimeConfig();
  const requested = resolveRequestedSessionAgentId(cfg, params.sessionKey, params.agentId);
  if (!requested.ok) {
    return requested;
  }
  return {
    ok: true as const,
    agentId: requested.agentId,
    sessionKey: resolveSessionStoreKey({
      cfg,
      sessionKey: params.sessionKey,
      storeAgentId: requested.agentId,
    }),
  };
}

export const sessionCompanionHandlers: GatewayRequestHandlers = {
  "sessions.companion.ask": async ({ params, respond, client, context, signal }) => {
    if (!validateSessionsCompanionAskParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.companion.ask params: ${formatValidationErrors(validateSessionsCompanionAskParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, agentId, question } = params as SessionsCompanionAskParams;
    if (!question.trim()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "question must contain non-whitespace text"),
      );
      return;
    }
    if (!client?.connId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "Session companion asks require a connected client."),
      );
      return;
    }
    if (!context.sessionCompanion) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Session companion is unavailable."),
      );
      return;
    }
    const target = resolveCompanionTarget({ sessionKey, agentId }, context);
    if (!target.ok) {
      respond(false, undefined, target.error);
      return;
    }
    try {
      const result = await context.sessionCompanion.ask({
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        question,
        connId: client.connId,
        ...(signal ? { signal } : {}),
      });
      respond(true, result);
    } catch (error) {
      if (!(error instanceof SessionCompanionAskError)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "The session companion could not answer right now."),
        );
        return;
      }
      if (error.reason === "busy") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, error.message, {
            details: { code: GatewayErrorDetailCodes.SESSION_COMPANION_BUSY },
            retryable: true,
          }),
        );
        return;
      }
      const retryable = error.reason === "rate-limited" || error.reason === "context-unavailable";
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error.message, {
          details: { reason: error.reason },
          retryable,
          ...(error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : {}),
        }),
      );
    }
  },
  "sessions.companion.state": ({ params, respond, context }) => {
    if (!validateSessionsCompanionStateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.companion.state params: ${formatValidationErrors(validateSessionsCompanionStateParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.sessionCompanion) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Session companion is unavailable."),
      );
      return;
    }
    const { sessionKey, agentId } = params as SessionsCompanionStateParams;
    const target = resolveCompanionTarget({ sessionKey, agentId }, context);
    if (!target.ok) {
      respond(false, undefined, target.error);
      return;
    }
    respond(
      true,
      context.sessionCompanion.state({
        agentId: target.agentId,
        sessionKey: target.sessionKey,
      }),
    );
  },

  "sessions.companion.reset": ({ params, respond, context }) => {
    if (!validateSessionsCompanionResetParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.companion.reset params: ${formatValidationErrors(validateSessionsCompanionResetParams.errors)}`,
        ),
      );
      return;
    }
    if (!context.sessionCompanion) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Session companion is unavailable."),
      );
      return;
    }
    const { sessionKey, agentId } = params as SessionsCompanionResetParams;
    const target = resolveCompanionTarget({ sessionKey, agentId }, context);
    if (!target.ok) {
      respond(false, undefined, target.error);
      return;
    }
    context.sessionCompanion.reset({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
    });
    respond(true, { ok: true });
  },
};
