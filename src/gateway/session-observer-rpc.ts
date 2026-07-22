import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  GatewayErrorDetailCodes,
  validateSessionsObserverAskParams,
  validateSessionsObserverVisibilityParams,
  type SessionsObserverAskParams,
  type SessionsObserverVisibilityParams,
} from "../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";
import { SessionObserverAskError } from "./session-observer-contract.js";

export const sessionObserverHandlers: GatewayRequestHandlers = {
  "sessions.observer.visibility": ({ params, respond, client, context }) => {
    if (!validateSessionsObserverVisibilityParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.observer.visibility params: ${formatValidationErrors(validateSessionsObserverVisibilityParams.errors)}`,
        ),
      );
      return;
    }
    if (!client?.connId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.FORBIDDEN,
          "Session observer visibility requires a connected client.",
        ),
      );
      return;
    }
    if (!context.sessionObserver) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Session observer is unavailable."),
      );
      return;
    }
    const { visible } = params as SessionsObserverVisibilityParams;
    context.sessionObserver.setConnectionVisibility(client.connId, visible);
    respond(true, { ok: true });
  },
  "sessions.observer.ask": async ({ params, respond, client, context }) => {
    if (!validateSessionsObserverAskParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid sessions.observer.ask params: ${formatValidationErrors(validateSessionsObserverAskParams.errors)}`,
        ),
      );
      return;
    }
    const { sessionKey, question } = params as SessionsObserverAskParams;
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
        errorShape(ErrorCodes.FORBIDDEN, "Session observer asks require a connected subscriber."),
      );
      return;
    }
    if (!context.sessionObserver) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "Session observer is unavailable."),
      );
      return;
    }
    try {
      const result = await context.sessionObserver.ask({
        sessionKey,
        question,
        connId: client.connId,
      });
      respond(true, result);
    } catch (error) {
      if (!(error instanceof SessionObserverAskError)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "The session observer could not answer right now."),
        );
        return;
      }
      if (error.reason === "busy") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, error.message, {
            details: { code: GatewayErrorDetailCodes.SESSION_OBSERVER_BUSY },
            retryable: true,
          }),
        );
        return;
      }
      if (error.reason === "rate-limited") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, error.message, {
            details: {
              code: GatewayErrorDetailCodes.SESSION_OBSERVER_UNAVAILABLE,
              reason: error.reason,
            },
            retryable: true,
            retryAfterMs: error.retryAfterMs ?? 60_000,
          }),
        );
        return;
      }
      respond(
        false,
        undefined,
        errorShape(
          error.reason === "not-subscribed" ? ErrorCodes.FORBIDDEN : ErrorCodes.UNAVAILABLE,
          error.message,
          {
            details: {
              code: GatewayErrorDetailCodes.SESSION_OBSERVER_UNAVAILABLE,
              reason: error.reason,
            },
          },
        ),
      );
    }
  },
};
