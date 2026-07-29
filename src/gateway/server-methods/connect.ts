// Connect method guard rejects late `connect` RPCs after the WebSocket
// handshake already established identity and authorization.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./types.js";

/**
 * Rejects `connect` after the WebSocket handshake already established identity.
 */
export const connectHandlers: GatewayRequestHandlers = {
  connect: ({ respond }) => {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "connect is only valid as the first request"),
    );
  },
};
