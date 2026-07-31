import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  getLatestSubagentRunByChildSessionKey,
  getSubagentRunByRunId,
  recordSwarmStructuredOutput,
} from "./subagent-registry.js";
import { resolveSwarmConfig } from "./swarm-config.js";
import { createAgentsWaitTool } from "./tools/agents-wait-tool.js";
import type { AnyAgentTool } from "./tools/common.js";
import { createStructuredOutputTool } from "./tools/structured-output-tool.js";

export function createOpenClawSwarmToolGroups(params: {
  config?: OpenClawConfig;
  effectiveRequesterAgentId: string;
  agentSessionKey?: string;
  runSessionKey?: string;
  runId?: string;
  swarmCollector?: boolean;
  swarmOutputSchema?: Record<string, unknown>;
}): { structuredOutput: AnyAgentTool[]; agentsWait: AnyAgentTool[] } {
  const childSessionKey = params.runSessionKey ?? params.agentSessionKey;
  const collectorEntry =
    params.swarmCollector && params.runId && params.swarmOutputSchema
      ? (getSubagentRunByRunId(params.runId) ??
        (childSessionKey ? getLatestSubagentRunByChildSessionKey(childSessionKey) : undefined))
      : undefined;
  const structuredOutput =
    params.swarmCollector && params.runId && params.swarmOutputSchema
      ? [
          createStructuredOutputTool({
            runId: params.runId,
            schema: params.swarmOutputSchema,
            initialState: collectorEntry?.structuredOutput,
            onStateChange: (state) =>
              recordSwarmStructuredOutput({ runId: params.runId, childSessionKey }, state),
          }),
        ]
      : [];
  const agentsWait = resolveSwarmConfig(params.config, params.effectiveRequesterAgentId).enabled
    ? [
        createAgentsWaitTool({
          agentSessionKey: params.agentSessionKey,
          runSessionKey: params.runSessionKey,
          agentId: params.effectiveRequesterAgentId,
          config: params.config,
        }),
      ]
    : [];
  return { structuredOutput, agentsWait };
}
