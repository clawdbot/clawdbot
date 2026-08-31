import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import type { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import type { PreparedTalkSessionTarget } from "../talk-session-target.types.js";
import type { GatewayRequestContext } from "./types.js";

export function resolveOwnedActiveTalkRunTarget(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  clientConnId?: string;
  sessionTarget: PreparedTalkSessionTarget;
  assertCurrent?: () => void;
}): NonNullable<Parameters<typeof controlRealtimeVoiceAgentRun>[0]["runTarget"]> | null {
  const connId = normalizeOptionalString(params.clientConnId);
  if (!connId) {
    return null;
  }
  const { agentId, sessionKey, canonicalKey } = params.sessionTarget;
  for (const [runId, entry] of params.context.chatAbortControllers) {
    const generation = entry.lifecycleGeneration;
    if (!generation) {
      continue;
    }
    const signal = entry.controller.signal;
    // Backing identity can materialize after admission; compare the live owner's
    // session ID with this same registration's current value, not an early snapshot.
    const isCurrent = (resolvedSessionId?: string) => {
      params.assertCurrent?.();
      return (
        params.context.chatAbortControllers.get(runId) === entry &&
        entry.agentId === agentId &&
        (entry.sessionKey === sessionKey || entry.sessionKey === canonicalKey) &&
        entry.ownerConnId === connId &&
        entry.kind !== "agent" &&
        entry.registrationCleanupRequested !== true &&
        (resolvedSessionId === undefined || entry.sessionId === resolvedSessionId) &&
        entry.controller.signal === signal &&
        !signal.aborted &&
        entry.lifecycleGeneration === generation &&
        isAgentEventLifecycleGenerationCurrent(generation)
      );
    };
    if (isCurrent()) {
      return { runId, signal, isCurrent };
    }
  }
  return null;
}
