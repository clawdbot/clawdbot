// Logs gateway methods expose bounded tails from the configured gateway log.
import {
  ErrorCodes,
  errorShape,
  validateLogsTailParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readConfiguredLogTail } from "../../logging/log-tail.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

/** Gateway handler for bounded reads from the configured gateway log. */
export const logsHandlers: GatewayRequestHandlers = {
  "logs.tail": async ({ params, respond }) => {
    if (!assertValidParams(params, validateLogsTailParams, "logs.tail", respond)) {
      return;
    }

    const p = params as { cursor?: number; limit?: number; maxBytes?: number };
    try {
      // The log-tail reader enforces cursor/byte limits and source selection;
      // the handler only maps protocol params and failure shape.
      const result = await readConfiguredLogTail({
        cursor: p.cursor,
        limit: p.limit,
        maxBytes: p.maxBytes,
      });
      respond(true, result, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, `log read failed: ${String(err)}`),
      );
    }
  },
};
