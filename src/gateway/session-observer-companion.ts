import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { flushSessionActivityAssistantNote } from "../agents/session-activity-notes.js";
import type { SessionObserverCompanionSnapshot } from "./session-observer-contract.js";
import type { SessionObserverDeps, SessionObserverState } from "./session-observer-model.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { resolveSessionSubscriptionKey } from "./session-subscription-keys.js";

export function createSessionObserverCompanionSnapshotReader(params: {
  getConfig: SessionObserverDeps["getConfig"];
  readSession: NonNullable<SessionObserverDeps["readSession"]>;
  states: Map<string, SessionObserverState>;
}): (sessionKey: string, selectedAgentId?: string) => SessionObserverCompanionSnapshot {
  return (sessionKey, selectedAgentId) => {
    const cfg = params.getConfig();
    const agentId = resolveSessionAgentId({
      sessionKey,
      config: cfg,
      ...(selectedAgentId ? { agentId: selectedAgentId } : {}),
    });
    const canonicalSessionKey = resolveStoredSessionKeyForAgentStore({
      cfg,
      agentId,
      sessionKey,
    });
    const state = params.states.get(resolveSessionSubscriptionKey(canonicalSessionKey, agentId));
    if (state) {
      flushSessionActivityAssistantNote(state);
      return {
        agentId: state.agentId,
        runId: state.runId,
        ...(state.previousDigest ? { digest: state.previousDigest } : {}),
        notes: state.notes.map((note) => ({ sequence: note.sequence, text: note.text })),
      };
    }
    const digest = params.readSession(canonicalSessionKey, agentId)?.observerDigest;
    return {
      agentId,
      ...(digest?.runId ? { runId: digest.runId } : {}),
      ...(digest ? { digest } : {}),
      notes: [],
    };
  };
}
