import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  AGENT_RUN_TERMINAL_RETRY_GRACE_MS,
  isDefinitiveRunLifecycle,
} from "../agents/agent-run-terminal-outcome.js";
import {
  createSessionActivityNoteState,
  flushSessionActivityAssistantNote,
  noteSessionActivityEvent,
  terminalHealthFor,
} from "../agents/session-activity-notes.js";
import { resolveUtilityModelRefForAgent } from "../agents/utility-model.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  createSessionObserverAudience,
  createSessionObserverAudienceLifecycle,
} from "./session-observer-audience.js";
import { createSessionObserverCompanionSnapshotReader } from "./session-observer-companion.js";
import { createSessionObserverCompletion } from "./session-observer-completion.js";
import type { SessionObserverEvent, SessionObserverService } from "./session-observer-contract.js";
import { createSessionObserverModelSlots } from "./session-observer-model-slots.js";
import {
  createDormantSessionObserverRun,
  defaultCompleteModel,
  defaultPersistDigest,
  defaultPrepareModel,
  defaultReadSession,
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
import { resolveSessionSubscriptionKey } from "./session-subscription-keys.js";

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

export function createSessionObserver(deps: SessionObserverDeps): SessionObserverService {
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
  const pendingTerminalErrors = new Map<string, ReturnType<typeof setTimeout>>();
  const disabledRuns = new Set<string>();
  const visibleConnections = new Set<string>();
  let disposed = false;
  const clearPendingTerminalError = (runId: string) => {
    clearTimeoutFn(pendingTerminalErrors.get(runId));
    pendingTerminalErrors.delete(runId);
  };
  const getCompanionSnapshot = createSessionObserverCompanionSnapshotReader({
    getConfig: deps.getConfig,
    readSession,
    states,
  });
  const audience = createSessionObserverAudience({
    subscribers: deps.subscribers,
    sessionEventSubscribers: deps.sessionEventSubscribers,
    isVisible: (connId) => visibleConnections.has(connId),
    getConfig: deps.getConfig,
  });
  type ObservedAudience = ReturnType<typeof audience.classify>;
  const broadcastDigest = (
    digest: SessionObserverDigest,
    connIds: ReadonlySet<string>,
    agentId: string,
  ) =>
    deps.broadcastToConnIds(
      "session.observer",
      digest,
      connIds,
      audience.deliveryOptions(digest.sessionKey, agentId),
    );
  // Narrow run-identity guard shared by persist paths: a digest may still land
  // while its session is unwatched, but never after a newer run replaces it.
  const runStillCurrent = (runId: string, sessionKey: string, agentId: string) => () =>
    !disposed &&
    !supersededRuns.has(runId) &&
    (states.get(resolveSessionSubscriptionKey(sessionKey, agentId))?.runId ?? runId) === runId;

  const persistAcceptedDigest = createSessionObserverDigestPersister({
    now,
    persistDigest,
    stillCurrent: runStillCurrent,
    onMissingEntry: (state) => {
      // An unpersistable session must not re-bill the utility model every cycle.
      disableModelForRun(state);
    },
    // JSON logging drops Error's non-enumerable fields; format before serializing.
    onError: (state, error) =>
      observerLog.warn("session observer digest persistence failed", {
        sessionKey: state.sessionKey,
        runId: state.runId,
        error: formatErrorMessage(error),
      }),
  });
  const preamblePublisher = createSessionObserverPreamblePublisher({
    now,
    setTimeoutFn,
    clearTimeoutFn,
    isCurrent: (state) => audienceLifecycle.stateIsCurrent(state),
    publish: (state, digest) => {
      broadcastDigest(digest, audience.recipients(state.sessionKey, state.agentId), state.agentId);
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
    const agentId = source.event?.agentId ?? source.state?.agentId ?? dormant?.agentId;
    if (!sessionKey || !agentId) {
      return;
    }
    const stillCurrent = runStillCurrent(runId, sessionKey, agentId);
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
        broadcastDigest(digest, audience.recipients(digest.sessionKey, agentId), agentId);
      }
    } catch (error) {
      observerLog.warn("session observer terminal digest synthesis failed", {
        runId,
        error: formatErrorMessage(error),
      });
    }
  }

  const stateIsTracked = (state: SessionObserverState): boolean =>
    states.get(resolveSessionSubscriptionKey(state.sessionKey, state.agentId)) === state;

  const dropState = (state: SessionObserverState) => {
    preamblePublisher.clear(state);
    if (state.timer) {
      clearTimeoutFn(state.timer);
    }
    modelSlots.invalidateRequest(state);
    if (stateIsTracked(state)) {
      const scopeKey = resolveSessionSubscriptionKey(state.sessionKey, state.agentId);
      if (
        state.terminalHealth === "failed" &&
        !terminalRuns.has(state.runId) &&
        state.previousDigest
      ) {
        rememberSessionObserverRevisionFloor(revisionFloors, scopeKey, {
          revision: state.revision,
          previousDigest: state.previousDigest,
        });
      }
      states.delete(scopeKey);
    }
  };

  const retireTerminalState = (state: SessionObserverState) => {
    void synthesizeTerminalDigest({ state });
    dormantRuns.delete(state.runId);
    dropState(state);
  };

  const suspendState = (state: SessionObserverState) => {
    if (state.terminalHealth) {
      retireTerminalState(state);
      return;
    }
    rememberSessionObserverDormantRun(
      dormantRuns,
      revisionFloors,
      createDormantSessionObserverRun(state),
    );
    dropState(state);
  };
  const retireInactiveState = (state: SessionObserverState) =>
    (disposed ? dropState : suspendState)(state);

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

  const audienceLifecycle = createSessionObserverAudienceLifecycle({
    audience,
    states,
    subscribers: deps.subscribers,
    isCurrent: (state) =>
      !disposed &&
      stateIsTracked(state) &&
      deps.getConfig().gateway?.controlUi?.sessionObserver !== false,
    resolveUtilityModelRef: (agentId) => resolveUtilityModelRef({ cfg: deps.getConfig(), agentId }),
    suspend: suspendState,
    demote: demoteUtilityModel,
  });

  const { modelStateIsCurrent } = audienceLifecycle;

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
    observedAudience?: ObservedAudience,
  ) => {
    const currentAudience = observedAudience ?? audience.classify(state.sessionKey, state.agentId);
    if (!audienceLifecycle.stateIsCurrent(state, currentAudience)) {
      retireInactiveState(state);
      return;
    }
    if (
      !modelStateIsCurrent(state, currentAudience) ||
      state.inFlight ||
      state.timer ||
      state.terminalHealth ||
      state.digestCount >= MAX_LIVE_DIGESTS_PER_RUN ||
      pendingNotes(state).length < MIN_NOTES_PER_DIGEST
    ) {
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
    const currentAudience = audience.classify(state.sessionKey, state.agentId);
    if (!audienceLifecycle.stateIsCurrent(state, currentAudience)) {
      retireInactiveState(state);
      return;
    }
    if (!modelStateIsCurrent(state, currentAudience)) {
      if (final) {
        retireTerminalState(state);
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
    const retireSelectedNotes = () => {
      // Run rollover replaces state; inFlight keeps its note retirement monotonic.
      state.lastDigestNoteSequence = Math.max(state.lastDigestNoteSequence, lastSelectedSequence);
    };
    const requestGeneration = modelSlots.beginRequest(state);
    const digestIsStale = () =>
      !modelStateIsCurrent(state) ||
      !modelSlots.requestIsCurrent(state, requestGeneration) ||
      (!final && state.terminalHealth !== undefined);
    state.digestCount += 1;
    void (async () => {
      try {
        const modelDigest = await requestModelDigest(
          state,
          selectedNotes.map((note) => note.text),
        );
        if (digestIsStale()) {
          retireSelectedNotes();
          if (final && stateIsTracked(state)) {
            retireTerminalState(state);
          }
          return;
        }
        // A deleted/reset session cannot accept this run's digest. Disable its
        // model work so pending notes cannot keep scheduling unpersistable results.
        if (
          state.sessionId &&
          readSession(state.sessionKey, state.agentId)?.sessionId !== state.sessionId
        ) {
          return disableModelForRun(state);
        }
        preamblePublisher.clear(state);
        state.consecutiveFailures = 0;
        state.revision += 1;
        retireSelectedNotes();
        const digest: SessionObserverDigest = {
          sessionKey: state.sessionKey,
          agentId: state.agentId,
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
        const previous = state.previousDigest?.health;
        const next = digest.health;
        const criticalTransition =
          (next === "stuck" || next === "waiting-on-user") && previous !== next;
        state.previousDigest = digest;
        // The existing gateway.controlUi.sessionObserver=false gate prevents this
        // run entirely, so the wider critical announce inherits the same opt-out.
        const recipients = criticalTransition
          ? audience.criticalRecipients(state.sessionKey, state.agentId)
          : audience.recipients(state.sessionKey, state.agentId);
        broadcastDigest(digest, recipients, state.agentId);
        await persistAcceptedDigest(state, digest, final);
        if (final) {
          dormantRuns.delete(state.runId);
        }
      } catch (error) {
        if (digestIsStale()) {
          retireSelectedNotes();
          if (final && stateIsTracked(state)) {
            retireTerminalState(state);
          }
          return;
        }
        state.consecutiveFailures += 1;
        if (state.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          observerLog.warn("session observer disabled after consecutive failures", {
            sessionKey: state.sessionKey,
            runId: state.runId,
            error: formatErrorMessage(error),
          });
          if (final || state.finalPending || state.terminalHealth) {
            retireTerminalState(state);
          } else {
            disableModelForRun(state);
          }
        } else if (final) {
          state.finalPending = true;
        }
      } finally {
        if (stateIsTracked(state)) {
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
    sessionKey: string,
    agentId: string,
    observedAudience: ObservedAudience,
  ): SessionObserverState | undefined => {
    if (observedAudience === "none") {
      return undefined;
    }
    const scopeKey = resolveSessionSubscriptionKey(sessionKey, agentId);
    const cfg = deps.getConfig();
    if (cfg.gateway?.controlUi?.sessionObserver === false) {
      return undefined;
    }
    const utilityModelRef =
      disabledRuns.has(event.runId) || observedAudience !== "direct"
        ? undefined
        : modelSlots.claim(agentId);
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
        ...(dormantState.lastPreambleHeadline
          ? { lastPublishedPreambleHeadline: dormantState.lastPreambleHeadline }
          : {}),
        ...(utilityModelRef ? { utilityModelRef } : {}),
        lastActivityAt: event.ts,
        lastRunAt: now(),
        lastDigestNoteSequence: 0,
        inFlight: false,
        finalPending: false,
      };
      states.set(scopeKey, state);
      return state;
    }
    const session = readSession(sessionKey, agentId);
    const startedAt =
      asFiniteNumber(event.data.startedAt) ?? session?.startedAt ?? event.ts ?? now();
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
    states.set(scopeKey, state);
    return state;
  };

  const handleEvent = (event: SessionObserverEvent, settledError = false) => {
    if (disposed || getAgentRunContext(event.runId)?.isHeartbeat) {
      return;
    }
    const lifecyclePhase = event.stream === "lifecycle" ? event.data.phase : undefined;
    const terminal =
      settledError || isDefinitiveRunLifecycle({ phase: lifecyclePhase, data: event.data });
    if (lifecyclePhase === "error" && !terminal) {
      clearPendingTerminalError(event.runId);
      const timer = setTimeoutFn(() => handleEvent(event, true), AGENT_RUN_TERMINAL_RETRY_GRACE_MS);
      pendingTerminalErrors.set(event.runId, timer);
      return;
    }
    if (terminal || lifecyclePhase === "start") {
      clearPendingTerminalError(event.runId);
    }
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
    // A terminal with no recoverable run context still closes the live run, but
    // one routed terminal duplicate must pass later to finalize durable state.
    if (contextlessTerminalRuns.has(event.runId) && !terminal) {
      return;
    }
    const eventSessionKey = event.sessionKey?.trim();
    const eventAgentId = event.agentId?.trim();
    let knownRun: SessionObserverState | DormantSessionObserverRun | undefined;
    // Context-reduced terminals may omit either routing field. Recover their
    // tracked owner by run id before the agent-scoped fail-closed branch.
    if (terminal && (!eventSessionKey || !eventAgentId)) {
      for (const candidate of states.values()) {
        if (candidate.runId === event.runId) {
          knownRun = candidate;
          break;
        }
      }
      knownRun ??= dormantRuns.get(event.runId);
    }
    const sessionKey = eventSessionKey || knownRun?.sessionKey;
    if (!sessionKey) {
      if (terminal) {
        markSessionObserverRunSuperseded(contextlessTerminalRuns, event.runId, event.ts);
      }
      return;
    }
    const agentId = eventAgentId || knownRun?.agentId;
    if (terminal) {
      contextlessTerminalRuns.delete(event.runId);
      if (!settledError) {
        markSessionObserverRunSuperseded(terminalRuns, event.runId, event.ts);
      }
    }
    const isPreamble = event.stream === "item" && event.data.kind === "preamble";
    if (!agentId) {
      if (terminal) {
        void synthesizeTerminalDigest({ event });
        dormantRuns.delete(event.runId);
        disabledRuns.delete(event.runId);
      }
      return;
    }
    const currentAudience = audience.classify(sessionKey, agentId);
    const scopeKey = resolveSessionSubscriptionKey(sessionKey, agentId);
    if (terminal && audience.recipients(sessionKey, agentId).size === 0) {
      void synthesizeTerminalDigest({ event, state: states.get(scopeKey) });
      dormantRuns.delete(event.runId);
      disabledRuns.delete(event.runId);
      return;
    }
    const isRunStart = event.stream === "lifecycle" && event.data.phase === "start";
    let revisionFloor = revisionFloors.get(scopeKey);
    let state = states.get(scopeKey);
    if (state && state.runId !== event.runId) {
      const candidate = { revision: state.revision, previousDigest: state.previousDigest };
      if (!revisionFloor || candidate.revision > revisionFloor.revision) {
        revisionFloor = candidate;
      }
      const supersededRunId = state.runId;
      clearPendingTerminalError(supersededRunId);
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
        .filter(
          (run) =>
            resolveSessionSubscriptionKey(run.sessionKey, run.agentId) === scopeKey &&
            run.runId !== event.runId,
        )
        .toSorted(
          (left, right) => right.revision - left.revision || left.runId.localeCompare(right.runId),
        );
      const latest = superseded[0];
      if (latest && (!revisionFloor || latest.revision > revisionFloor.revision)) {
        revisionFloor = { revision: latest.revision, previousDigest: latest.previousDigest };
      }
      if (isRunStart) {
        if (revisionFloor) {
          rememberSessionObserverRevisionFloor(revisionFloors, scopeKey, revisionFloor);
          const previousRunId = revisionFloor.previousDigest?.runId;
          if (previousRunId && previousRunId !== event.runId) {
            markSessionObserverRunSuperseded(supersededRuns, previousRunId, event.ts);
          }
        }
        for (const run of superseded) {
          markSessionObserverRunSuperseded(supersededRuns, run.runId, event.ts);
          clearPendingTerminalError(run.runId);
          dormantRuns.delete(run.runId);
        }
      }
    }
    if (
      state &&
      (currentAudience === "none" || deps.getConfig().gateway?.controlUi?.sessionObserver === false)
    ) {
      suspendState(state);
      state = undefined;
    }
    if (!state) {
      state = admitState(event, isPreamble, sessionKey, agentId, currentAudience);
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
    revisionFloors.delete(scopeKey);
    const utilityModelRef =
      disabledRuns.has(state.runId) || currentAudience !== "direct"
        ? undefined
        : modelSlots.claim(state.agentId, state);
    if (state.utilityModelRef !== utilityModelRef) {
      modelSlots.invalidateRequest(state);
      state.preparedPromise = undefined;
      state.utilityModelRef = utilityModelRef;
      state.consecutiveFailures = 0;
    }
    state.lastActivityAt = event.ts;
    const eventStartedAt = asFiniteNumber(event.data.startedAt);
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
      const endedAt = asFiniteNumber(event.data.endedAt) ?? now();
      // previousDigest is set on every ACCEPTED digest of this run; digestCount now
      // counts attempts (budget), so it no longer implies any digest was published.
      const hasRunDigest = state.previousDigest?.runId === state.runId;
      if (!hasRunDigest && endedAt - state.startedAt < FINAL_DIGEST_MIN_RUN_MS) {
        dormantRuns.delete(state.runId);
        dropState(state);
        return;
      }
      runDigest(state, true);
      return;
    }
    schedule(state, runDigest, currentAudience);
  };

  return {
    handleEvent,
    setConnectionVisibility(connId, visible) {
      if (visible) {
        visibleConnections.add(connId);
        return;
      }
      visibleConnections.delete(connId);
      audienceLifecycle.reconcileAll();
    },
    removeConnection(connId) {
      if (visibleConnections.delete(connId)) {
        audienceLifecycle.reconcileAll();
      }
    },
    getCompanionSnapshot,
    dispose() {
      disposed = true;
      pendingTerminalErrors.forEach((_timer, runId) => clearPendingTerminalError(runId));
      preamblePublisher.dispose();
      audienceLifecycle.unsubscribe();
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
