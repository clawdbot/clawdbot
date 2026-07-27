// Read-only observation of the restored-admission state owned by this Gateway.
import {
  ErrorCodes,
  errorShape,
  validateGatewayRestoreStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const restoreHandlers: GatewayRequestHandlers = {
  "gateway.restore.status": async ({ respond, params, context }) => {
    if (!validateGatewayRestoreStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "invalid gateway.restore.status params"),
      );
      return;
    }
    const result = context.getRestoredAdmissionStatus();
    if (
      result.status !== "not-restored" &&
      result.restoreOperationId !== params.restoreOperationId
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "a different restored admission owns this Gateway", {
          retryable: false,
          details: { reason: "restored-admission-conflict" },
        }),
      );
      return;
    }
    respond(true, result);
  },
};
