import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSessionsObserverVisibilityParams,
  type SessionsObserverVisibilityParams,
} from "../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./server-methods/types.js";

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
};
