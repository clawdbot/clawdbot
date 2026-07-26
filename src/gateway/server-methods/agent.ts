import { agentIdentityGetHandler } from "./agent-identity.js";
import { agentRunHandler } from "./agent-run-handler.js";
import { agentWaitHandler } from "./agent-wait.js";
// Gateway agent methods implement agent.run, agent.wait, and agent identity RPCs.
import type { GatewayRequestHandlers } from "./types.js";

export const agentHandlers: GatewayRequestHandlers = {
  agent: agentRunHandler,
  "agent.identity.get": agentIdentityGetHandler,
  "agent.wait": agentWaitHandler,
};
