import { agentCollectorSpawnHandler } from "./agent-collector-spawn.js";
import { agentResultGetHandler } from "./agent-result-get.js";
import { agentRunHandler } from "./agent-run-handler.js";
import { agentWaitHandler } from "./agent-wait.js";
// Gateway agent methods implement agent.run, agent.wait, and agent.result.get RPCs.
import type { GatewayRequestHandlers } from "./types.js";

export const agentHandlers: GatewayRequestHandlers = {
  agent: agentRunHandler,
  "agent.wait": agentWaitHandler,
  "agent.collector.spawn": agentCollectorSpawnHandler,
  "agent.result.get": agentResultGetHandler,
};
