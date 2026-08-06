// Voice Call plugin module implements stale call reaper behavior.
import type { CallId, CallRecord, CallState } from "../types.js";
import { TerminalStates } from "../types.js";

// Background cleanup loop for calls that never reached answered/terminal state.

const CHECK_INTERVAL_MS = 30_000;

/** States that indicate a live conversation with speech/transcription.
 * Inbound Twilio calls may never fire a call.answered event, so answeredAt
 * can be absent even while the call is actively transcribing. These states
 * prove the call is live and should not be reaped. */
const LiveConversationStates: ReadonlySet<CallState> = new Set(["speaking", "listening"]);

type StaleCallReaperManager = {
  getActiveCalls(): Array<Pick<CallRecord, "answeredAt" | "callId" | "startedAt" | "state">>;
  endCall(callId: CallId): Promise<{ success: boolean; error?: string }>;
};

/** Start a stale-call reaper and return its cleanup callback. */
export function startStaleCallReaper(params: {
  manager: StaleCallReaperManager;
  staleCallReaperSeconds?: number;
}): (() => void) | null {
  const maxAgeSeconds = params.staleCallReaperSeconds;
  if (!maxAgeSeconds || maxAgeSeconds <= 0) {
    return null;
  }

  const maxAgeMs = maxAgeSeconds * 1000;
  const callsBeingReaped = new Set<string>();
  const interval = setInterval(() => {
    const now = Date.now();
    for (const call of params.manager.getActiveCalls()) {
      // Skip calls that have been answered (answeredAt set) or are in a live
      // conversation state. Inbound Twilio calls may never fire a call.answered
      // event so answeredAt may be absent even when the call is actively
      // transcribing/responding. Without this state guard live calls in
      // speaking/listening state get reaped as stale.
      if (
        call.answeredAt ||
        TerminalStates.has(call.state) ||
        LiveConversationStates.has(call.state)
      ) {
        continue;
      }

      // Unanswered provider calls can be stranded when callbacks are missed; end them explicitly.
      const age = now - call.startedAt;
      if (age > maxAgeMs && !callsBeingReaped.has(call.callId)) {
        // Keep one hangup attempt per call in flight; settlement releases the call for later retries.
        callsBeingReaped.add(call.callId);
        console.log(
          `[voice-call] Reaping stale call ${call.callId} (age: ${Math.round(age / 1000)}s, state: ${call.state})`,
        );
        void params.manager
          .endCall(call.callId)
          .catch((err: unknown) => {
            console.warn(`[voice-call] Reaper failed to end call ${call.callId}:`, err);
          })
          .finally(() => {
            callsBeingReaped.delete(call.callId);
          });
      }
    }
  }, CHECK_INTERVAL_MS);

  return () => {
    clearInterval(interval);
  };
}
