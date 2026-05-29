import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
} from "../../logging/diagnostic-stability.js";
import type { GatewayRequestHandlers } from "./types.js";

export const diagnosticsHandlers: GatewayRequestHandlers = {
  "diagnostics.stability": async ({ params, respond }) => {
    try {
      const query = normalizeDiagnosticStabilityQuery(params);
      respond(true, getDiagnosticStabilitySnapshot(query), undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          err instanceof Error ? err.message : "invalid diagnostics.stability params",
        ),
      );
    }
  },
};
