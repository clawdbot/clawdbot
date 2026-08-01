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
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const uiCommandHandlers: GatewayRequestHandlers = {
  "ui.command": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateUiCommandParams, "ui.command", respond)) {
      return;
    }

    const commandParams = params as UiCommandParams;
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

    context.broadcastToConnIds("ui.command", commandParams, connIds);
    respond(true, { ok: true });
  },
};
