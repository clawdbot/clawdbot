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

export const sessionCompanionHandlers: GatewayRequestHandlers = {
  "sessions.companion.ask": async ({ params, respond, client, context }) => {
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
    const { sessionKey, question } = params as SessionsCompanionAskParams;
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
    try {
      const result = await context.sessionCompanion.ask({
        sessionKey,
        question,
        connId: client.connId,
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
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, error.message, {
          details: { reason: error.reason },
          retryable: error.reason === "rate-limited",
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
    const { sessionKey } = params as SessionsCompanionStateParams;
    respond(true, context.sessionCompanion.state(sessionKey));
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
    const { sessionKey } = params as SessionsCompanionResetParams;
    context.sessionCompanion.reset(sessionKey);
    respond(true, { ok: true });
  },
};
