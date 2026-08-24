import { gatewayStartupUnavailableDetails } from "@openclaw/gateway-protocol/startup-unavailable";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
// Models gateway methods expose prepared, cached, and explicitly refreshed catalog views.
import { validateModelsListParams } from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveAmbientOwnerAgentId } from "../../agents/agent-scope-config.js";
import { MODEL_RUNTIME_DISCOVERY_RECOVERY_DELAY_MS } from "../../agents/prepared-model-runtime-recovery.js";
import { resolveAgentIdOrRespondError } from "./agent-id-shared.js";
import {
  buildModelsListResult,
  ModelsListRuntimeDiscoveryPendingError,
} from "./models-list-result.js";
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
    try {
      respond(
        true,
        await buildModelsListResult({ context, agentId: resolved.agentId, params }),
        undefined,
      );
    } catch (error) {
      if (!(error instanceof ModelsListRuntimeDiscoveryPendingError)) {
        throw error;
      }
      // Ordinary prepared reads retain their static catalog. New Session alone
      // opts into retryable readiness so it cannot cache partial runtime rows.
      respond(false, undefined, {
        code: "UNAVAILABLE",
        message: "prepared model catalog is waiting for post-ready runtime discovery",
        details: gatewayStartupUnavailableDetails(),
        retryable: true,
        retryAfterMs: MODEL_RUNTIME_DISCOVERY_RECOVERY_DELAY_MS,
      });
    }
  },
};
