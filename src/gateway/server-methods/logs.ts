import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateLogsTailParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readConfiguredLogTail } from "../../logging/log-tail.js";
import type { GatewayRequestHandlers } from "./types.js";

export const logsHandlers: GatewayRequestHandlers = {
  "logs.tail": async ({ params, respond }) => {
    if (!validateLogsTailParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid logs.tail params: ${formatValidationErrors(validateLogsTailParams.errors)}`,
        ),
      );
      return;
    }

    const p = params as { cursor?: number; limit?: number; maxBytes?: number };
    try {
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
