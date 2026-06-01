import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  getDiagnosticStabilitySnapshot,
  normalizeDiagnosticStabilityQuery,
} from "../../logging/diagnostic-stability.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Gateway handler for payload-free stability diagnostics. */
export const diagnosticsHandlers: GatewayRequestHandlers = {
  "diagnostics.stability": async ({ params, respond }) => {
    try {
      // Normalization owns parameter bounds so malformed diagnostic requests
      // return a client error instead of leaking logging internals.
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
