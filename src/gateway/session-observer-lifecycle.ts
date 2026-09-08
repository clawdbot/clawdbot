import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { createSessionActivityNoteState } from "../agents/session-activity-notes.js";
import type { SessionObserverEvent } from "./session-observer-contract.js";
import {
  isSameSessionObserverLifecycle,
  markSessionObserverRunSuperseded,
  rememberSessionObserverRevisionFloor,
  resolveSessionObserverDigestForLifecycle,
} from "./session-observer-model.js";
import type {
  DormantSessionObserverRun,
  SessionObserverDeps,
  SessionObserverRevisionFloor,
  SessionObserverState,
} from "./session-observer-model.js";
import { onGatewaySessionReset } from "./session-reset-notifications.js";
import { resolveSessionSubscriptionKey } from "./session-subscription-keys.js";

type ReadSession = NonNullable<SessionObserverDeps["readSession"]>;

export function createSessionObserverLifecycle(params: {
  getConfig: SessionObserverDeps["getConfig"];
  readSession: ReadSession;
  now: () => number;
  isTerminal: (runId: string) => boolean;
  clearPendingTerminalError: (runId: string) => void;
  releaseState: (state: SessionObserverState) => void;
}) {
  const states = new Map<string, SessionObserverState>();
  const dormantRuns = new Map<string, DormantSessionObserverRun>();
  const revisionFloors = new Map<string, SessionObserverRevisionFloor>();
  const supersededRuns = new Map<string, number>();
  const disabledRuns = new Set<string>();

  const isTracked = (state: SessionObserverState): boolean =>
    states.get(resolveSessionSubscriptionKey(state.sessionKey, state.agentId)) === state;

  const dropState = (state: SessionObserverState) => {
    params.releaseState(state);
    if (isTracked(state)) {
      const scopeKey = resolveSessionSubscriptionKey(state.sessionKey, state.agentId);
      if (
        state.terminalHealth === "failed" &&
        !params.isTerminal(state.runId) &&
        !supersededRuns.has(state.runId) &&
        state.previousDigest
      ) {
        rememberSessionObserverRevisionFloor(revisionFloors, scopeKey, {
          sessionId: state.sessionId,
          lifecycleRevision: state.lifecycleRevision,
          revision: state.revision,
          previousDigest: state.previousDigest,
        });
      }
      states.delete(scopeKey);
    }
  };

  const retireRun = (runId: string) => {
    markSessionObserverRunSuperseded(supersededRuns, runId, params.now());
    params.clearPendingTerminalError(runId);
    dormantRuns.delete(runId);
    disabledRuns.delete(runId);
  };

  const retireObsolete = (scopeKey: string, session: ReturnType<ReadSession>): void => {
    const state = states.get(scopeKey);
    if (state && !isSameSessionObserverLifecycle(state, session)) {
      retireRun(state.runId);
      dropState(state);
    }
    for (const run of dormantRuns.values()) {
      if (
        resolveSessionSubscriptionKey(run.sessionKey, run.agentId) === scopeKey &&
        !isSameSessionObserverLifecycle(run, session)
      ) {
        retireRun(run.runId);
      }
    }
    const floor = revisionFloors.get(scopeKey);
    if (floor && !isSameSessionObserverLifecycle(floor, session)) {
      if (floor.previousDigest?.runId) {
        retireRun(floor.previousDigest.runId);
      }
      revisionFloors.delete(scopeKey);
    }
  };

  const acceptPublication = (state: SessionObserverState): boolean => {
    const session = params.readSession(state.sessionKey, state.agentId);
    if (isSameSessionObserverLifecycle(state, session)) {
      return true;
    }
    retireObsolete(resolveSessionSubscriptionKey(state.sessionKey, state.agentId), session);
    return false;
  };

  const admit = (
    event: SessionObserverEvent,
    sessionKey: string,
    agentId: string,
    session: ReturnType<ReadSession>,
    utilityModelRef: string | undefined,
  ): SessionObserverState => {
    const scopeKey = resolveSessionSubscriptionKey(sessionKey, agentId);
    const dormant = dormantRuns.get(event.runId);
    if (dormant && isSameSessionObserverLifecycle(dormant, session)) {
      dormantRuns.delete(event.runId);
      const { utilityModelRef: _dormantModelRef, ...dormantState } = dormant;
      const state: SessionObserverState = {
        ...createSessionActivityNoteState(),
        ...dormantState,
        ...(dormantState.lastPreambleHeadline
          ? { lastPublishedPreambleHeadline: dormantState.lastPreambleHeadline }
          : {}),
        ...(utilityModelRef ? { utilityModelRef } : {}),
        lastActivityAt: event.ts,
        lastRunAt: params.now(),
        lastDigestNoteSequence: 0,
        inFlight: false,
        finalPending: false,
      };
      states.set(scopeKey, state);
      return state;
    }
    const previousDigest = resolveSessionObserverDigestForLifecycle(
      session?.observerDigest,
      session,
    );
    const startedAt =
      asFiniteNumber(event.data.startedAt) ?? session?.startedAt ?? event.ts ?? params.now();
    const state: SessionObserverState = {
      ...createSessionActivityNoteState(),
      sessionKey,
      sessionId: session?.sessionId,
      lifecycleRevision: session?.lifecycleRevision,
      runId: event.runId,
      agentId,
      ...(utilityModelRef ? { utilityModelRef } : {}),
      startedAt,
      lastActivityAt: event.ts,
      lastRunAt: startedAt,
      lastPersistedAt: previousDigest?.updatedAt,
      revision: previousDigest?.revision ?? 0,
      digestCount: 0,
      consecutiveFailures: 0,
      lastDigestNoteSequence: 0,
      previousDigest,
      inFlight: false,
      finalPending: false,
    };
    states.set(scopeKey, state);
    return state;
  };

  const unsubscribeReset = onGatewaySessionReset((sessionKey, suppliedAgentId) => {
    const agentId =
      suppliedAgentId ?? resolveSessionAgentId({ sessionKey, config: params.getConfig() });
    // Reset notification can follow awaited cleanup. Preserve a newer admitted owner.
    retireObsolete(
      resolveSessionSubscriptionKey(sessionKey, agentId),
      params.readSession(sessionKey, agentId),
    );
  });

  return {
    states,
    dormantRuns,
    revisionFloors,
    supersededRuns,
    disabledRuns,
    isTracked,
    dropState,
    retireObsolete,
    acceptPublication,
    admit,
    dispose() {
      unsubscribeReset();
      for (const state of states.values()) {
        dropState(state);
      }
      dormantRuns.clear();
      revisionFloors.clear();
      supersededRuns.clear();
      disabledRuns.clear();
    },
  };
}
