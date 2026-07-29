// Models gateway methods expose model catalog browse results without triggering
// auth probes or fresh provider discovery on each request.
import {
  ErrorCodes,
  errorShape,
  validateModelsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export { buildModelsListResult };

// The gateway model list is a browse API, not an auth probe. It reuses the
// current runtime catalog snapshot and applies visibility rules without doing
// extra runtime discovery on each request.
export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateModelsListParams, "models.list", respond)) {
      return;
    }
    try {
      respond(true, await buildModelsListResult({ context, params }), undefined);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    }
  },
};
