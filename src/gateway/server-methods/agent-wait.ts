import {
  validateAgentWaitParams,
  type AgentWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { createAgentTurnService } from "../agent-turn/agent-turn-service.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const agentWaitHandler: GatewayRequestHandlers["agent.wait"] = async ({
  params,
  respond,
  context,
  isWebchatConnect,
}) => {
  if (!assertValidParams(params, validateAgentWaitParams, "agent.wait", respond)) {
    return;
  }
  const result = await createAgentTurnService({ context, isWebchatConnect }).waitForTurn(
    params as AgentWaitParams,
  );
  respond(true, result);
};
