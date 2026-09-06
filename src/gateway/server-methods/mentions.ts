import {
  ErrorCodes,
  errorShape,
  validateMentionsDismissParams,
  validateMentionsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const mentionHandlers: GatewayRequestHandlers = {
  "mentions.list": ({ client, context, params, respond }) => {
    if (!assertValidParams(params, validateMentionsListParams, "mentions.list", respond)) {
      return;
    }
    if (!context.mentionInbox) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "The mention Inbox is unavailable. Reconnect to retry."),
      );
      return;
    }
    const result = context.mentionInbox.list(client);
    respond(result.ok, result.ok ? result.value : undefined, result.ok ? undefined : result.error);
  },
  "mentions.dismiss": ({ client, context, params, respond }) => {
    if (!assertValidParams(params, validateMentionsDismissParams, "mentions.dismiss", respond)) {
      return;
    }
    if (!context.mentionInbox) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "The mention Inbox is unavailable. Reconnect to retry."),
      );
      return;
    }
    const result = context.mentionInbox.dismiss(client, params.ids);
    respond(result.ok, result.ok ? result.value : undefined, result.ok ? undefined : result.error);
  },
};
