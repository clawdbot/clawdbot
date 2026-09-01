import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  type UiCommandParams,
  validateUiCommandParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestContextWithClientLookup } from "../server-request-context.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { resolveStoredSessionKeyForAgentStore } from "../session-store-key.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

export const uiCommandHandlers: GatewayRequestHandlers = {
  "ui.command": defineValidatedGatewayMethod(
    "ui.command",
    validateUiCommandParams,
    ({ params: commandParams, respond, context }) => {
      const commandSessionKey =
        "sessionKey" in commandParams.command
          ? commandParams.command.sessionKey
          : commandParams.sessionKey;
      const requestedSession = commandSessionKey
        ? resolveRequestedSessionAgentId(
            context.getRuntimeConfig(),
            commandSessionKey,
            commandParams.agentId,
          )
        : undefined;
      if (requestedSession && !requestedSession.ok) {
        respond(false, undefined, requestedSession.error);
        return;
      }
      const canonicalSessionKey =
        commandSessionKey && requestedSession?.ok
          ? resolveStoredSessionKeyForAgentStore({
              cfg: context.getRuntimeConfig(),
              agentId: requestedSession.agentId,
              sessionKey: commandSessionKey,
            })
          : undefined;
      const normalizedParams: UiCommandParams = {
        ...commandParams,
        ...(canonicalSessionKey ? { sessionKey: canonicalSessionKey } : {}),
        ...(requestedSession?.ok ? { agentId: requestedSession.agentId } : {}),
        command:
          canonicalSessionKey && "sessionKey" in commandParams.command
            ? { ...commandParams.command, sessionKey: canonicalSessionKey }
            : commandParams.command,
      };
      const clientContext = context as GatewayRequestContextWithClientLookup;
      // v1 intentionally fans out to every capable Control UI; session-targeted routing is out of scope.
      const connIds =
        clientContext.getClientConnIds?.(
          (client) =>
            client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI &&
            hasGatewayClientCap(client.connect.caps, GATEWAY_CLIENT_CAPS.UI_COMMANDS),
        ) ?? new Set<string>();
      if (connIds.size === 0) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "no ui client"));
        return;
      }

      context.broadcastToConnIds("ui.command", normalizedParams, connIds);
      respond(true, { ok: true });
    },
  ),
};
