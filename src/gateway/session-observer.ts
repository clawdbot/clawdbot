import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  createSessionActivityNoteState,
  flushSessionActivityAssistantNote,
  noteSessionActivityEvent,
  readFiniteNumber,
  terminalHealthFor,
} from "../agents/session-activity-notes.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createSessionObserverAskRuntime } from "./session-observer-ask.js";
import { createSessionObserverAudience } from "./session-observer-audience.js";
import { createSessionObserverCompletion } from "./session-observer-completion.js";
import type { SessionObserverEvent, SessionObserverService } from "./session-observer-contract.js";
import { createSessionObserverModelSlots } from "./session-observer-model-slots.js";
import {
  createDormantSessionObserverRun,
  defaultCompleteModel,
  defaultPersistDigest,
  defaultPrepareModel,
  defaultReadSession,
  isTerminalLifecycleEvent,
  markSessionObserverRunSuperseded,
  rememberSessionObserverDisabledRun,
  rememberSessionObserverDormantRun,
  rememberSessionObserverRevisionFloor,
  synthesizeSessionObserverTerminalDigest,
} from "./session-observer-model.js";
import type {
  DormantSessionObserverRun,
  SessionObserverDeps,
  SessionObserverRevisionFloor,
  SessionObserverState,
} from "./session-observer-model.js";
import { createSessionObserverDigestPersister } from "./session-observer-persistence.js";
import { createSessionObserverPreamblePublisher } from "./session-observer-preamble.js";

const observerLog = createSubsystemLogger("gateway/session-observer");

const MIN_NOTES_PER_DIGEST = 4;
const MIN_DIGEST_INTERVAL_MS = 12_000;
const MAX_DIGESTS_PER_RUN = 40;
const MAX_LIVE_DIGESTS_PER_RUN = MAX_DIGESTS_PER_RUN - 1;
const MAX_CONSECUTIVE_FAILURES = 2;
const FINAL_DIGEST_MIN_RUN_MS = 30_000;
// The Control UI opens at most six live session subscriptions; matching that cap
// prevents background observer calls from outgrowing the surface consuming them.
const MAX_CONCURRENT_MODEL_SESSIONS = 6;

type SessionObserver = SessionObserverService &
  Pick<ReturnType<typeof createSessionObserverAskRuntime>, "getSnapshot">;

export function createSessionObserver(deps: SessionObserverDeps): SessionObserver {
  const now = deps.now ?? Date.now;
  const setTimeoutFn = deps.setTimeoutFn ?? setTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? clearTimeout;
  const resolveUtilityModelRef = deps.resolveUtilityModelRef ?? resolveUtilityModelRefForAgent;
  const prepareModel = deps.prepareModel ?? defaultPrepareModel;
  const completeModel = deps.completeModel ?? defaultCompleteModel;
  const readSession = deps.readSession ?? defaultReadSession;
  const persistDigest = deps.persistDigest ?? defaultPersistDigest;
  const states = new Map<string, SessionObserverState>();
  const dormantRuns = new Map<string, DormantSessionObserverRun>();
  const revisionFloors = new Map<string, SessionObserverRevisionFloor>();
  const supersededRuns = new Map<string, number>();
  const contextlessTerminalRuns = new Map<string, number>();
  const terminalRuns = new Map<string, number>();
  const disabledRuns = new Set<string>();
  const visibleConnections = new Set<string>();
  let disposed = false;
  const askRuntime = createSessionObserverAskRuntime({
    getConfig: deps.getConfig,
    subscribers: deps.subscribers,
    states,
    resolveUtilityModelRef,
    prepareModel,
    completeModel,
    readSession,
    now,
    setTimeoutFn,
    clearTimeoutFn,
    isDisposed: () => disposed,
  });
  const audience = createSessionObserverAudience({
    subscribers: deps.subscribers,
    sessionEventSubscribers: deps.sessionEventSubscribers,
    isVisible: (connId) => visibleConnections.has(connId),
  });
  // Narrow run-identity guard shared by persist paths: a digest may still land
  // while its session is unwatched, but never after a newer run replaces it.
  const runStillCurrent = (runId: string, sessionKey: string) => () =>
    !disposed && !supersededRuns.has(runId) && (states.get(sessionKey)?.runId ?? runId) === runId;
  const persistAcceptedDigest = createSessionObserverDigestPersister({
    now,
    persistDigest,
    stillCurrent: runStillCurrent,
    onError: (state, error) => {
      observerLog.warn("session observer digest persistence failed", {
        sessionKey: state.sessionKey,
        runId: state.runId,
        error,
      });
    },
  });
  const preamblePublisher = createSessionObserverPreamblePublisher({
    now,
    setTimeoutFn,
    clearTimeoutFn,
    isCurrent: stateIsCurrent,
    publish: (state, digest) => {
      deps.broadcastToConnIds("session.observer", digest, audience.recipients(state.sessionKey), {
        dropIfSlow: true,
      });
      void persistAcceptedDigest(state, digest, false, "preamble");
    },
  });

  // Terminal paths that cannot run the model must still retire same-run live
  // health, or idle session rows can display a stale in-progress judgment forever.
  async function synthesizeTerminalDigest(source: {
    event?: SessionObserverEvent;
    state?: SessionObserverState;
  }) {
    const runId = source.event?.runId ?? source.state?.runId;
    if (!runId) {
      return;
    }
    const dormant = dormantRuns.get(runId);
    const sessionKey = source.event?.sessionKey ?? source.state?.sessionKey ?? dormant?.sessionKey;
    if (!sessionKey) {
      return;
    }
    const stillCurrent = runStillCurrent(runId, sessionKey);
    if (!stillCurrent()) {
      return;
    }
    try {
      const digest = await synthesizeSessionObserverTerminalDigest({
        source,
        dormant,
        readSession,
        persistDigest,
        now,
        stillCurrent,
      });
      if (digest && stillCurrent()) {
        // Live subscribers already saw the in-progress digest over this event;
        // the synthesized terminal correction must reach them the same way.
        deps.broadcastToConnIds(
          "session.observer",
          digest,
          audience.recipients(digest.sessionKey),
          {
            dropIfSlow: true,
          },
        );
      }
    } catch (error) {
      observerLog.warn("session observer terminal digest synthesis failed", { runId, error });
    }
  }

  const dropState = (state: SessionObserverState) => {
    preamblePublisher.clear(state);
    if (state.timer) {
      clearTimeoutFn(state.timer);
    }
    modelSlots.invalidateRequest(state);
    if (states.get(state.sessionKey) === state) {
      states.delete(state.sessionKey);
    }
  };

  const suspendState = (state: SessionObserverState) => {
    if (state.terminalHealth) {
      void synthesizeTerminalDigest({ state });
      dormantRuns.delete(state.runId);
      dropState(state);
      return;
    }
    rememberSessionObserverDormantRun(
      dormantRuns,
      revisionFloors,
      createDormantSessionObserverRun(state),
    );
    dropState(state);
  };

  const demoteUtilityModel = (state: SessionObserverState): void => {
    if (state.timer) {
      clearTimeoutFn(state.timer);
      state.timer = undefined;
    }
    modelSlots.invalidateRequest(state);
    state.preparedPromise = undefined;
    state.utilityModelRef = undefined;
    state.consecutiveFailures = 0;
  };
  const modelSlots = createSessionObserverModelSlots({
    states,
    maxSessions: MAX_CONCURRENT_MODEL_SESSIONS,
    resolve: (agentId) => resolveUtilityModelRef({ cfg: deps.getConfig(), agentId }),
    demote: demoteUtilityModel,
  });

  const disableModelForRun = (state: SessionObserverState) => {
    rememberSessionObserverDisabledRun(disabledRuns, state.runId);
    demoteUtilityModel(state);
  };

  const suspendStatesWithoutAudience = () => {
    // suspendState deletes from `states`; Map iteration tolerates removal of
    // the entry being visited.
    for (const state of states.values()) {
      if (!audience.has(state.sessionKey)) {
        suspendState(state);
      }
    }
  };

  const unsubscribeChanges = deps.subscribers.onChange((sessionKey) => {
    const state = states.get(sessionKey);
    if (state && !audience.has(sessionKey)) {
      suspendState(state);
    }
  });

  function stateIsCurrent(state: SessionObserverState): boolean {
    return (
      !disposed &&
      states.get(state.sessionKey) === state &&
      audience.has(state.sessionKey) &&
      deps.getConfig().gateway?.controlUi?.sessionObserver !== false
    );
  }

  function modelStateIsCurrent(state: SessionObserverState): boolean {
    if (!stateIsCurrent(state) || !state.utilityModelRef) {
      return false;
    }
    return (
      resolveUtilityModelRef({ cfg: deps.getConfig(), agentId: state.agentId }) ===
      state.utilityModelRef
    );
  }

  const requestModelDigest = createSessionObserverCompletion({
    getConfig: deps.getConfig,
    prepareModel,
    completeModel,
    now,
    setTimeoutFn,
    clearTimeoutFn,
    isCurrent: modelStateIsCurrent,
  });

  const pendingNotes = (state: SessionObserverState) =>
    state.notes.filter((note) => note.sequence > state.lastDigestNoteSequence);

  const schedule = (
    state: SessionObserverState,
    run: (state: SessionObserverState, final: boolean) => void,
  ) => {
    if (!stateIsCurrent(state)) {
      if (disposed) {
        dropState(state);
      } else {
        suspendState(state);
      }
      return;
    }
    if (!modelStateIsCurrent(state)) {
      return;
    }
    if (state.inFlight || state.timer || state.terminalHealth) {
      return;
    }
    if (state.digestCount >= MAX_LIVE_DIGESTS_PER_RUN) {
      return;
    }
    if (pendingNotes(state).length < MIN_NOTES_PER_DIGEST) {
      return;
    }
    const delay = Math.max(0, MIN_DIGEST_INTERVAL_MS - (now() - state.lastRunAt));
    if (delay === 0) {
      run(state, false);
      return;
    }
    state.timer = setTimeoutFn(() => {
      state.timer = undefined;
      run(state, false);
    }, delay);
  };

  const runDigest = (state: SessionObserverState, final: boolean) => {
    if (!stateIsCurrent(state)) {
      if (disposed) {
        dropState(state);
      } else {
        suspendState(state);
      }
      return;
    }
    if (!modelStateIsCurrent(state)) {
      if (final) {
        void synthesizeTerminalDigest({ state });
        dormantRuns.delete(state.runId);
        dropState(state);
      }
      return;
    }
    if (state.inFlight) {
      state.finalPending ||= final;
      return;
    }
    const digestLimit = final ? MAX_DIGESTS_PER_RUN : MAX_LIVE_DIGESTS_PER_RUN;
    if (state.digestCount >= digestLimit) {
      return;
    }
    flushSessionActivityAssistantNote(state);
    const selectedNotes = pendingNotes(state);
    if (!final && selectedNotes.length < MIN_NOTES_PER_DIGEST) {
      return;
    }
    if (!final && now() - state.lastRunAt < MIN_DIGEST_INTERVAL_MS) {
      schedule(state, runDigest);
      return;
    }
    if (state.timer) {
      clearTimeoutFn(state.timer);
      state.timer = undefined;
    }
    state.inFlight = true;
    state.lastRunAt = now();
    const lastSelectedSequence = selectedNotes.at(-1)?.sequence ?? state.lastDigestNoteSequence;
    const requestedPreambleGeneration = preamblePublisher.generation(state);
    const requestGeneration = modelSlots.beginRequest(state);
    void (async () => {
      try {
        const modelDigest = await requestModelDigest(
          state,
          selectedNotes.map((note) => note.text),
        );
        const stale =
          !modelStateIsCurrent(state) ||
          !modelSlots.requestIsCurrent(state, requestGeneration) ||
          (!final && state.terminalHealth !== undefined) ||
          preamblePublisher.generation(state) !== requestedPreambleGeneration;
        if (stale) {
          if (final && states.get(state.sessionKey) === state) {
            void synthesizeTerminalDigest({ state });
            dormantRuns.delete(state.runId);
            dropState(state);
          }
          return;
        }
        // A session reset swaps sessionId under the same key; a digest accepted
        // for the old session must not reach the replacement session's watchers.
        if (
          state.sessionId &&
          readSession(state.sessionKey, state.agentId)?.sessionId !== state.sessionId
        ) {
          return;
        }
        preamblePublisher.clear(state);
        state.consecutiveFailures = 0;
        state.revision += 1;
        state.digestCount += 1;
        state.lastDigestNoteSequence = lastSelectedSequence;
        const digest: SessionObserverDigest = {
          sessionKey: state.sessionKey,
          runId: state.runId,
          revision: state.revision,
          updatedAt: now(),
          headline: modelDigest.headline,
          ...(modelDigest.assessment ? { assessment: modelDigest.assessment } : {}),
          health: final ? (state.terminalHealth ?? modelDigest.health) : modelDigest.health,
          ...((state.planProgress ?? modelDigest.planProgress)
            ? { planProgress: state.planProgress ?? modelDigest.planProgress }
            : {}),
        };
        state.previousDigest = digest;
        deps.broadcastToConnIds("session.observer", digest, audience.recipients(state.sessionKey), {
          dropIfSlow: true,
        });
        await persistAcceptedDigest(state, digest, final);
        if (final) {
          dormantRuns.delete(state.runId);
        }
      } catch (error) {
        const stale =
          !modelStateIsCurrent(state) ||
          !modelSlots.requestIsCurrent(state, requestGeneration) ||
          (!final && state.terminalHealth !== undefined);
        if (stale) {
          if (final && states.get(state.sessionKey) === state) {
            void synthesizeTerminalDigest({ state });
            dormantRuns.delete(state.runId);
            dropState(state);
          }
          return;
        }
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          observerLog.warn("session observer disabled after consecutive failures", {
            sessionKey: state.sessionKey,
            runId: state.runId,
            error,
          });
          if (final || state.finalPending || state.terminalHealth) {
            void synthesizeTerminalDigest({ state });
            dormantRuns.delete(state.runId);
            dropState(state);
          } else {
            disableModelForRun(state);
          }
        } else if (final) {
          state.finalPending = true;
        }
      } finally {
        if (states.get(state.sessionKey) === state) {
          state.inFlight = false;
          const runFinal = state.finalPending;
          state.finalPending = false;
          if (runFinal) {
            runDigest(state, true);
          } else if (final) {
            dropState(state);
          } else {
            schedule(state, runDigest);
          }
        }
      }
    })();
  };

  const admitState = (
    event: SessionObserverEvent,
    allowPreambleOnly: boolean,
  ): SessionObserverState | undefined => {
    const sessionKey = event.sessionKey?.trim();
    const agentId = event.agentId?.trim();
    if (!sessionKey || !agentId || !audience.has(sessionKey)) {
      return undefined;
    }
    const cfg = deps.getConfig();
    if (cfg.gateway?.controlUi?.sessionObserver === false) {
      return undefined;
    }
    const utilityModelRef = disabledRuns.has(event.runId) ? undefined : modelSlots.claim(agentId);
    if (!utilityModelRef && !allowPreambleOnly) {
      return undefined;
    }
    const dormant = dormantRuns.get(event.runId);
    if (dormant) {
      dormantRuns.delete(event.runId);
      const { utilityModelRef: _dormantModelRef, ...dormantState } = dormant;
      const state: SessionObserverState = {
        ...createSessionActivityNoteState(),
        ...dormantState,
        ...(utilityModelRef ? { utilityModelRef } : {}),
        lastActivityAt: event.ts,
        lastRunAt: now(),
        lastDigestNoteSequence: 0,
        inFlight: false,
        finalPending: false,
      };
      states.set(sessionKey, state);
      return state;
    }
    const session = readSession(sessionKey, agentId);
    const startedAt =
      readFiniteNumber(event.data.startedAt) ?? session?.startedAt ?? event.ts ?? now();
    const state: SessionObserverState = {
      ...createSessionActivityNoteState(),
      sessionKey,
      sessionId: event.sessionId ?? session?.sessionId,
      runId: event.runId,
      agentId,
      ...(utilityModelRef ? { utilityModelRef } : {}),
      startedAt,
      lastActivityAt: event.ts,
      lastRunAt: startedAt,
      lastPersistedAt: session?.observerDigest?.updatedAt,
      revision: session?.observerDigest?.revision ?? 0,
      digestCount: 0,
      consecutiveFailures: 0,
      lastDigestNoteSequence: 0,
      previousDigest: session?.observerDigest,
      inFlight: false,
      finalPending: false,
    };
    states.set(sessionKey, state);
    return state;
  };

  const handleEvent = (event: SessionObserverEvent) => {
    if (disposed || getAgentRunContext(event.runId)?.isHeartbeat) {
      return;
    }
    const terminal = isTerminalLifecycleEvent(event);
    if (terminalRuns.has(event.runId)) {
      return;
    }
    if (supersededRuns.has(event.runId)) {
      if (terminal) {
        markSessionObserverRunSuperseded(terminalRuns, event.runId, event.ts);
        contextlessTerminalRuns.delete(event.runId);
        supersededRuns.delete(event.runId);
        dormantRuns.delete(event.runId);
        disabledRuns.delete(event.runId);
      }
      return;
    }
    // A contextless terminal still closes the live run, but one routed terminal
    // duplicate must pass through later so durable state can be finalized.
    if (contextlessTerminalRuns.has(event.runId) && !terminal) {
      return;
    }
    const sessionKey = event.sessionKey?.trim();
    if (!sessionKey) {
      if (terminal) {
        markSessionObserverRunSuperseded(contextlessTerminalRuns, event.runId, event.ts);
      }
      return;
    }
    if (terminal) {
      contextlessTerminalRuns.delete(event.runId);
      markSessionObserverRunSuperseded(terminalRuns, event.runId, event.ts);
    }
    const isPreamble = event.stream === "item" && event.data.kind === "preamble";
    if (terminal && audience.recipients(sessionKey).size === 0) {
      void synthesizeTerminalDigest({ event, state: states.get(sessionKey) });
      dormantRuns.delete(event.runId);
      disabledRuns.delete(event.runId);
      return;
    }
    const isRunStart = event.stream === "lifecycle" && event.data.phase === "start";
    let revisionFloor = revisionFloors.get(sessionKey);
    let state = states.get(sessionKey);
    if (state && state.runId !== event.runId) {
      const candidate = { revision: state.revision, previousDigest: state.previousDigest };
      if (!revisionFloor || candidate.revision > revisionFloor.revision) {
        revisionFloor = candidate;
      }
      const supersededRunId = state.runId;
      if (isRunStart) {
        markSessionObserverRunSuperseded(supersededRuns, supersededRunId, event.ts);
      }
      suspendState(state);
      if (isRunStart) {
        dormantRuns.delete(supersededRunId);
      }
      state = undefined;
    }
    if (!state) {
      const superseded = [...dormantRuns.values()]
        .filter((run) => run.sessionKey === sessionKey && run.runId !== event.runId)
        .toSorted(
          (left, right) => right.revision - left.revision || left.runId.localeCompare(right.runId),
        );
      const latest = superseded[0];
      if (latest && (!revisionFloor || latest.revision > revisionFloor.revision)) {
        revisionFloor = { revision: latest.revision, previousDigest: latest.previousDigest };
      }
      if (isRunStart) {
        if (revisionFloor) {
          rememberSessionObserverRevisionFloor(revisionFloors, sessionKey, revisionFloor);
        }
        for (const run of superseded) {
          markSessionObserverRunSuperseded(supersededRuns, run.runId, event.ts);
          dormantRuns.delete(run.runId);
        }
      }
    }
    if (
      state &&
      (!audience.has(sessionKey) || deps.getConfig().gateway?.controlUi?.sessionObserver === false)
    ) {
      suspendState(state);
      state = undefined;
    }
    if (!state) {
      state = admitState(event, isPreamble);
    }
    if (!state) {
      if (terminal) {
        void synthesizeTerminalDigest({ event });
        dormantRuns.delete(event.runId);
        disabledRuns.delete(event.runId);
      }
      return;
    }
    if (state.terminalHealth) {
      return;
    }
    if (revisionFloor && revisionFloor.revision > state.revision) {
      state.revision = revisionFloor.revision;
      state.previousDigest = revisionFloor.previousDigest;
    }
    revisionFloors.delete(sessionKey);
    const utilityModelRef = disabledRuns.has(state.runId)
      ? undefined
      : modelSlots.claim(state.agentId, state);
    if (state.utilityModelRef !== utilityModelRef) {
      modelSlots.invalidateRequest(state);
      state.preparedPromise = undefined;
      state.utilityModelRef = utilityModelRef;
      state.consecutiveFailures = 0;
    }
    state.lastActivityAt = event.ts;
    const eventStartedAt = readFiniteNumber(event.data.startedAt);
    if (eventStartedAt !== undefined) {
      state.startedAt = Math.min(state.startedAt, eventStartedAt);
    }
    noteSessionActivityEvent(state, event);
    preamblePublisher.handle(state, event);
    if (terminal) {
      if (!state.terminalHealth) {
        modelSlots.invalidateRequest(state);
      }
      preamblePublisher.flush(state);
      preamblePublisher.clear(state);
      state.terminalHealth = terminalHealthFor(event);
      disabledRuns.delete(event.runId);
      const endedAt = readFiniteNumber(event.data.endedAt) ?? now();
      const hasRunDigest = state.digestCount > 0 || state.previousDigest?.runId === state.runId;
      if (!hasRunDigest && endedAt - state.startedAt < FINAL_DIGEST_MIN_RUN_MS) {
        dormantRuns.delete(state.runId);
        dropState(state);
        return;
      }
      runDigest(state, true);
      return;
    }
    schedule(state, runDigest);
  };

  return {
    handleEvent,
    setConnectionVisibility(connId, visible) {
      if (visible) {
        visibleConnections.add(connId);
        return;
      }
      visibleConnections.delete(connId);
      suspendStatesWithoutAudience();
    },
    removeConnection(connId) {
      if (visibleConnections.delete(connId)) {
        suspendStatesWithoutAudience();
      }
    },
    getSnapshot: askRuntime.getSnapshot,
    ask: askRuntime.ask,
    dispose() {
      disposed = true;
      preamblePublisher.dispose();
      unsubscribeChanges();
      askRuntime.dispose();
      for (const state of states.values()) {
        dropState(state);
      }
      dormantRuns.clear();
      revisionFloors.clear();
      supersededRuns.clear();
      terminalRuns.clear();
      disabledRuns.clear();
      visibleConnections.clear();
    },
  };
}
