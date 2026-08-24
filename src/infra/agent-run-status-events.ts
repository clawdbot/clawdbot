import type { ChatRunStartupPhase } from "../../packages/gateway-protocol/src/schema/logs-chat.js";
import { emitAgentEvent } from "./agent-events.js";

/** Emits one typed startup status for projection onto an active chat run. */
export function emitAgentRunStatusEvent(params: {
  runId: string;
  phase: ChatRunStartupPhase;
  sessionKey?: string;
  agentId?: string;
}) {
  emitAgentEvent({
    runId: params.runId,
    stream: "run_status",
    data: { phase: params.phase },
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
}
