import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ACTIVE_EMBEDDED_RUNS,
  ACTIVE_EMBEDDED_RUN_REGISTRATIONS,
} from "../../agents/embedded-agent-runner/run-state.js";
import {
  getAttachedBackend,
  operationsByUpstreamAbortSignal,
  resolveActiveReplyRunOwnerForSignal,
} from "../../auto-reply/reply/reply-run-registry.state.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import type { controlRealtimeVoiceAgentRun } from "../../talk/agent-run-control.js";
import { resolveClientVoiceRunBinding } from "../../talk/client-voice-session.js";
import type { PreparedTalkSessionTarget } from "../talk-session-target.types.js";
import type { GatewayRequestContext } from "./types.js";

export function resolveOwnedActiveTalkRunTarget(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  clientConnId?: string;
  sessionTarget: PreparedTalkSessionTarget;
  /** The shipped talk.client.steer RPC is session-wide; attached transports select their call. */
  scope: { kind: "session" } | { kind: "voice-session"; voiceSessionId: string };
  assertCurrent?: () => void;
}):
  | (NonNullable<Parameters<typeof controlRealtimeVoiceAgentRun>[0]["runTarget"]> & {
      toolAuthoritySource?: "reply" | "attempt";
    })
  | null {
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
    const handle = ACTIVE_EMBEDDED_RUNS.get(entry.sessionId);
    const registration = handle ? ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) : undefined;
    const voiceBinding =
      params.scope.kind === "voice-session" ? resolveClientVoiceRunBinding(runId) : undefined;
    // Session RPCs can own a queued reply before its backend exists. Attached
    // voice controls instead preserve captured backend absence across their FIFO.
    const reply =
      params.scope.kind === "session" && !handle
        ? operationsByUpstreamAbortSignal.get(signal)
        : undefined;
    const isCurrent = (resolvedSessionId?: string) => {
      params.assertCurrent?.();
      const replyOwner =
        reply && operationsByUpstreamAbortSignal.get(signal) === reply
          ? resolveActiveReplyRunOwnerForSignal(signal)
          : undefined;
      const replyHandle = replyOwner ? ACTIVE_EMBEDDED_RUNS.get(replyOwner.sessionId) : undefined;
      if (params.scope.kind === "voice-session") {
        // Retain the claim instance: A-to-B-to-A is reassignment, not revival.
        // Identical registrations preserve this snapshot at the producer.
        if (
          !voiceBinding ||
          resolveClientVoiceRunBinding(runId) !== voiceBinding ||
          voiceBinding.voiceSessionId !== params.scope.voiceSessionId ||
          voiceBinding.agentId !== agentId ||
          voiceBinding.sessionKey !== sessionKey
        ) {
          return false;
        }
      }
      return (
        params.context.chatAbortControllers.get(runId) === entry &&
        entry.agentId === agentId &&
        (entry.sessionKey === sessionKey || entry.sessionKey === canonicalKey) &&
        entry.ownerConnId === connId &&
        entry.kind !== "agent" &&
        entry.registrationCleanupRequested !== true &&
        (!reply ||
          (replyOwner?.sessionKey === canonicalKey &&
            (!replyHandle || getAttachedBackend(reply) === replyHandle))) &&
        (resolvedSessionId === undefined ||
          (entry.sessionId === resolvedSessionId &&
            (replyOwner
              ? replyOwner.sessionId === resolvedSessionId
              : handle !== undefined &&
                ACTIVE_EMBEDDED_RUNS.get(resolvedSessionId) === handle &&
                ACTIVE_EMBEDDED_RUN_REGISTRATIONS.get(handle) === registration))) &&
        entry.controller.signal === signal &&
        !signal.aborted &&
        entry.lifecycleGeneration === generation &&
        isAgentEventLifecycleGenerationCurrent(generation)
      );
    };
    if (isCurrent()) {
      const toolAuthoritySource = reply ? "reply" : registration?.toolAuthority?.source;
      return { runId, signal, isCurrent, toolAuthoritySource };
    }
  }
  return null;
}
