import {
  ErrorCodes,
  errorShape,
  validateAgentWaitParams,
  type AgentWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getAgentRunContext } from "../../infra/agent-run-registry.js";
import { createAgentTurnService } from "../agent-turn/agent-turn-service.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import {
  createSessionListEntryFilter,
  isGatewayAdmin,
  resolveSessionSharingTarget,
} from "../session-sharing.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const agentWaitHandler: GatewayRequestHandlers["agent.wait"] = async ({
  params,
  respond,
  context,
  client,
  isWebchatConnect,
}) => {
  if (!assertValidParams(params, validateAgentWaitParams, "agent.wait", respond)) {
    return;
  }
  const gatewayClient = client ?? null;
  if (gatewayClient?.authenticatedUserProfile && !isGatewayAdmin(gatewayClient)) {
    const cfg = context.getRuntimeConfig();
    if (operatorSessionCap(gatewayClient, cfg) === "none") {
      const run = getAgentRunContext(params.runId);
      const target = run?.sessionKey
        ? resolveSessionSharingTarget({ cfg, sessionKey: run.sessionKey, agentId: run.agentId })
        : null;
      const visibilityFilter = createSessionListEntryFilter({ client: gatewayClient, cfg });
      if (!target || visibilityFilter?.(target.storeKey, target.entry) === false) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "agent run was not found"),
        );
        return;
      }
    }
  }
  const result = await createAgentTurnService({ context, isWebchatConnect }).waitForTurn(
    params as AgentWaitParams,
  );
  respond(true, result);
};
