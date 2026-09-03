import {
  ErrorCodes,
  errorShape,
  validateUsersMentionableParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const usersMentionableHandlers: GatewayRequestHandlers = {
  "users.mentionable": ({ client, context, params, respond }) => {
    if (!assertValidParams(params, validateUsersMentionableParams, "users.mentionable", respond)) {
      return;
    }
    if (!context.mentionInbox) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "The mention directory is unavailable. Reconnect to retry.",
        ),
      );
      return;
    }
    const result = context.mentionInbox.mentionable(client, params);
    respond(result.ok, result.ok ? result.value : undefined, result.ok ? undefined : result.error);
  },
};
