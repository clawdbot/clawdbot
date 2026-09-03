import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
// Models gateway methods expose prepared, cached, and explicitly refreshed catalog views.
import { validateModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export { buildModelsListResult };

// Automatic clients opt into preparedOnly; omitted mode preserves shipped wildcard discovery.
export const modelsHandlers: GatewayRequestHandlers = {
  "models.list": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateModelsListParams, "models.list", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const resolved = resolveAgentIdOrRespondError({
      rawAgentId: params.agentId ?? tryResolveAmbientOwnerAgentId(cfg),
      respond,
      cfg,
      normalize: normalizeOptionalString,
    });
    if (!resolved) {
      return;
    }
    respond(
      true,
      await buildModelsListResult({
        source: { kind: "gateway", context },
        agentId: resolved.agentId,
        params,
      }),
      undefined,
    );
  },
};
