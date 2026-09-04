import {
  ErrorCodes,
  errorShape,
  validateTalkModeParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/** Broadcasts Talk mode changes independently of speech and realtime provider loading. */
export const talkModeHandlers: GatewayRequestHandlers = {
  "talk.mode": async ({ params, respond, context, client, isWebchatConnect }) => {
    if (client && isWebchatConnect(client.connect) && !(await context.hasConnectedTalkNode())) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "talk disabled: no connected Talk-capable nodes"),
      );
      return;
    }
    if (!assertValidParams(params, validateTalkModeParams, "talk.mode", respond)) {
      return;
    }
    const payload = {
      enabled: params.enabled,
      phase: params.phase ?? null,
      ts: Date.now(),
    };
    context.broadcast("talk.mode", payload, { dropIfSlow: true });
    respond(true, payload, undefined);
  },
};
