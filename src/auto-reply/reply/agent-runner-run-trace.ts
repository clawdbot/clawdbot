import type { RunReplyAgentParams } from "./agent-runner-core.js";

export function resolveReplyAgentRunTrace(params: RunReplyAgentParams) {
  const isHeartbeat = params.opts?.isHeartbeat === true;
  return {
    isHeartbeat,
    attributes: {
      provider: params.followupRun.run.provider,
      hasSessionKey: Boolean(params.sessionKey ?? params.followupRun.run.sessionKey),
      isHeartbeat:
        isHeartbeat &&
        params.opts?.reasoningPayloadsEnabled !== true &&
        params.opts?.commentaryPayloadsEnabled !== true,
      queueMode: params.resolvedQueue.mode,
      isActive: params.isActive,
      blockStreamingEnabled: params.blockStreamingEnabled,
    },
  };
}
