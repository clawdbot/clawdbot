// Owner-scoped manual input finalization for speech-only realtime relay sessions.
import { getRelaySession } from "./talk-realtime-relay-operations.js";
import { MAX_MANUAL_COMMITTED_TURN_IDS, broadcastToOwner } from "./talk-realtime-relay-state.js";

/** Commits one owner-scoped manual input-audio turn and requests exactly one response. */
export function commitTalkRealtimeRelayAudio(params: {
  relaySessionId: string;
  connId: string;
  turnId: string;
}): { status: "committed" | "duplicate"; turnId: string } {
  const session = getRelaySession(params.relaySessionId, params.connId);
  if (session.inputAudioTurnDetection !== "manual" || session.toolsEnabled) {
    throw new Error("Realtime relay session does not use manual input audio commit");
  }
  const turnId = params.turnId.trim();
  if (!turnId) {
    throw new Error("Realtime relay commit requires a turn id");
  }
  if (session.committedManualTurnIds.has(turnId)) {
    return { status: "duplicate", turnId };
  }
  if (session.outputOwnership.phase === "cancelling") {
    throw new Error("Realtime relay turn is cancelling");
  }
  if (!session.harness.talk.activeTurnId || session.manualInputAudioBytes === 0) {
    throw new Error("Realtime relay input audio buffer is empty");
  }
  if (session.harness.talk.activeTurnId !== turnId) {
    throw new Error("Realtime relay commit turn does not match the active turn");
  }
  if (session.committedManualTurnIds.size >= MAX_MANUAL_COMMITTED_TURN_IDS) {
    session.failSession("Realtime relay manual-commit session limit exceeded");
    throw new Error("Realtime relay manual-commit session limit exceeded");
  }
  // Record the tombstone before the provider write. If the write is ambiguous, the
  // fail-closed session teardown prevents any retry from duplicating provider work.
  session.committedManualTurnIds.add(turnId);
  try {
    session.bridge.commitInputAudio();
  } catch (error) {
    session.failSession("Realtime provider input audio commit failed.");
    throw error;
  }
  session.manualInputAudioBytes = 0;
  broadcastToOwner(session.context, session.connId, {
    relaySessionId: session.id,
    type: "inputAudio",
    byteLength: 0,
    talkEvent: session.harness.talk.emit({
      type: "input.audio.committed",
      turnId,
      payload: {},
      final: true,
    }),
  });
  return { status: "committed", turnId };
}
