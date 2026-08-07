/** Redaction-safe projection from live agent events into durable audit metadata. */
import { AGENT_RUN_TERMINAL_RETRY_GRACE_MS } from "../agents/agent-run-terminal-outcome.js";
import { getAgentEventContextLifecycleToken } from "../infra/agent-event-execution-context.js";
import { isAgentEventLifecycleGenerationCurrent } from "../infra/agent-events.js";
import { onAgentRunContextRetired } from "../infra/agent-run-context-retirement.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { adoptAgentAuditAttemptState } from "./agent-event-audit-attempt-state.js";
import { projectAgentEvent } from "./agent-event-audit-lifecycle-projection.js";
import {
  adoptAuthoritativeOpenRunProvenance,
  buildRunInstance,
  createAgentAuditProjectionState,
  forgetAuthoritativeOpenRun,
  forgetOpenRun,
  getAuthoritativeRunContextToken,
  hasAuthoritativeRunContext,
  MAX_TRACKED_RUN_PROVENANCE,
  nonEmptyString,
  retainAuthoritativeOpenRunForRetirement,
  trimUnownedOpenRuns,
} from "./agent-event-audit-provenance.js";
import {
  agentAuditAttemptKey,
  agentAuditRunInstanceFromAttemptStateKey,
  createAgentAuditPendingTerminal,
  createAgentAuditAttemptStateKeyResolver,
  createAgentAuditSettledAttemptRecorder,
  matchingRetiredAgentAuditAttemptStates,
  selectAgentAuditTerminalCandidate,
  settledAgentAuditAttemptFloor,
  type AgentAuditOpenAttempt,
  type AgentAuditPendingTerminalWithOwnership,
  type AgentAuditSettledRun,
  type AgentAuditTerminalCandidate,
} from "./agent-event-audit-terminal.js";
import { projectToolExecutionEventToAudit } from "./agent-event-audit-tool-projection.js";
import type { AgentEventAuditRecorder } from "./agent-event-audit-types.js";
import { createAuditEventWriter, type AuditEventWriter } from "./audit-event-writer.js";

const log = createSubsystemLogger("audit/events");
let persistenceFailureWarned = false;

export type { AgentEventAuditRecorder } from "./agent-event-audit-types.js";

/** Create the Gateway-owned non-blocking audit projection and persistence handle. */
export function createAgentEventAuditRecorder(options?: {
  writer?: AuditEventWriter;
  stateDir?: string;
  terminalSettleMs?: number;
}): AgentEventAuditRecorder {
  const projectionState = createAgentAuditProjectionState();
  const writer =
    options?.writer ??
    createAuditEventWriter({
      ...(options?.stateDir ? { stateDir: options.stateDir } : {}),
      onError: (error) => {
        if (!persistenceFailureWarned) {
          persistenceFailureWarned = true;
          log.warn(`audit event persistence failed: ${error}`);
        }
      },
    });
  const requestedTerminalSettleMs = options?.terminalSettleMs ?? AGENT_RUN_TERMINAL_RETRY_GRACE_MS;
  const terminalSettleMs = Math.max(0, Math.floor(requestedTerminalSettleMs));
  const pendingTerminals = new Map<string, AgentAuditPendingTerminalWithOwnership>();
  const getAttemptStateKey = createAgentAuditAttemptStateKeyResolver();
  const rejectedTerminalsByAttempt = new Map<
    string,
    AgentAuditTerminalCandidate & { attemptStateKey: string; runInstance: string }
  >();
  const rejectedCountByAttemptState = new Map<string, number>();
  const openAttemptStates = new Set<string>();
  const openAuthoritativeRunContexts = new WeakMap<object, AgentAuditOpenAttempt>();
  const retiredOpenAttemptStates = new Set<string>();
  const unownedOpenAttemptStates = new Set<string>();
  const rejectedStartAttemptStates = new Set<string>();
  const settledRunInstances = new Map<string, AgentAuditSettledRun>();
  const attemptEpochByState = new Map<string, number>();
  const attemptStartSequenceByState = new Map<string, number>();
  const adoptOpenAttemptState = (from: string, to: string) =>
    adoptAgentAuditAttemptState({
      from,
      to,
      openAttempts: openAttemptStates,
      unownedAttempts: unownedOpenAttemptStates,
      rejectedStarts: rejectedStartAttemptStates,
      pendingTerminals,
      settledAttempts: settledRunInstances,
      attemptEpochs: attemptEpochByState,
      attemptStartSequences: attemptStartSequenceByState,
    });
  const discardAttemptState = (attemptStateKey: string) => {
    openAttemptStates.delete(attemptStateKey);
    retiredOpenAttemptStates.delete(attemptStateKey);
    unownedOpenAttemptStates.delete(attemptStateKey);
    rejectedStartAttemptStates.delete(attemptStateKey);
    attemptStartSequenceByState.delete(attemptStateKey);
  };
  const rememberSettled = createAgentAuditSettledAttemptRecorder(
    settledRunInstances,
    MAX_TRACKED_RUN_PROVENANCE,
  );
  const forgetRejectedAttempt = (attemptKey: string) => {
    const rejected = rejectedTerminalsByAttempt.get(attemptKey);
    if (!rejected) {
      return;
    }
    rejectedTerminalsByAttempt.delete(attemptKey);
    const rejectedCount = (rejectedCountByAttemptState.get(rejected.attemptStateKey) ?? 1) - 1;
    if (rejectedCount > 0) {
      rejectedCountByAttemptState.set(rejected.attemptStateKey, rejectedCount);
    } else {
      rejectedCountByAttemptState.delete(rejected.attemptStateKey);
      if (!openAttemptStates.has(rejected.attemptStateKey)) {
        attemptEpochByState.delete(rejected.attemptStateKey);
      }
    }
  };
  const rememberRejectedTerminal = (
    attemptStateKey: string,
    runInstance: string,
    incoming: AgentAuditTerminalCandidate,
  ) => {
    const existing = rejectedTerminalsByAttempt.get(incoming.attemptKey);
    const selected = existing ? selectAgentAuditTerminalCandidate(existing, incoming) : incoming;
    if (!existing) {
      rejectedCountByAttemptState.set(
        attemptStateKey,
        (rejectedCountByAttemptState.get(attemptStateKey) ?? 0) + 1,
      );
    }
    rejectedTerminalsByAttempt.delete(incoming.attemptKey);
    rejectedTerminalsByAttempt.set(incoming.attemptKey, {
      ...selected,
      attemptStateKey,
      runInstance,
    });
    if (rejectedTerminalsByAttempt.size > MAX_TRACKED_RUN_PROVENANCE) {
      const oldest = rejectedTerminalsByAttempt.keys().next().value;
      if (oldest !== undefined) {
        forgetRejectedAttempt(oldest);
      }
    }
  };
  const clearPending = (attemptStateKey: string) => {
    const pending = pendingTerminals.get(attemptStateKey);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    pendingTerminals.delete(attemptStateKey);
  };
  const flushPending = (attemptStateKey: string) => {
    const pending = pendingTerminals.get(attemptStateKey);
    if (!pending) {
      return;
    }
    const { contextLifecycleToken, runInstance } = pending;
    clearPending(attemptStateKey);
    openAttemptStates.delete(attemptStateKey);
    const runId = nonEmptyString(pending.input.runId);
    const authoritativeContext = runId
      ? getAuthoritativeRunContextToken(runInstance, runId, contextLifecycleToken)
      : undefined;
    if (authoritativeContext && runId) {
      const attempt = openAuthoritativeRunContexts.get(authoritativeContext);
      if (attempt) {
        openAuthoritativeRunContexts.set(authoritativeContext, { ...attempt, open: false });
      }
      forgetAuthoritativeOpenRun(projectionState, runInstance, runId, contextLifecycleToken);
    }
    const rejected = rejectedTerminalsByAttempt.get(pending.attemptKey);
    const selected = rejected ? selectAgentAuditTerminalCandidate(rejected, pending) : pending;
    if (writer.record(selected.input)) {
      forgetRejectedAttempt(selected.attemptKey);
      if (runId) {
        forgetOpenRun(projectionState, runInstance, runId);
      }
      discardAttemptState(attemptStateKey);
      rememberSettled(attemptStateKey, selected.observedThroughSequence);
      if (!rejectedCountByAttemptState.has(attemptStateKey)) {
        attemptEpochByState.delete(attemptStateKey);
      }
    } else {
      rememberRejectedTerminal(attemptStateKey, runInstance, selected);
    }
  };
  const scheduleTerminal = (
    attemptStateKey: string,
    runInstance: string,
    contextLifecycleToken: object | undefined,
    incoming: AgentAuditTerminalCandidate,
  ) => {
    const existing = pendingTerminals.get(attemptStateKey);
    const selected = existing ? selectAgentAuditTerminalCandidate(existing, incoming) : incoming;
    if (existing) {
      clearTimeout(existing.timer);
    }
    const pending = createAgentAuditPendingTerminal({
      attemptStateKey,
      candidate: selected,
      flush: flushPending,
      runInstance,
      settleMs: terminalSettleMs,
      ...(contextLifecycleToken ? { contextLifecycleToken } : {}),
    });
    pendingTerminals.delete(attemptStateKey);
    pendingTerminals.set(attemptStateKey, pending);
    if (pendingTerminals.size > MAX_TRACKED_RUN_PROVENANCE) {
      const oldest = pendingTerminals.keys().next().value;
      if (oldest !== undefined) {
        flushPending(oldest);
      }
    }
  };
  const unsubscribeRunContextRetirement = onAgentRunContextRetired(
    ({ runId, lifecycleGeneration, contextLifecycleToken }) => {
      const runInstance = buildRunInstance(runId, lifecycleGeneration);
      const authoritativeContext =
        contextLifecycleToken ?? getAuthoritativeRunContextToken(runInstance, runId);
      const attemptStateKey = getAttemptStateKey(runInstance, authoritativeContext);
      const authoritativeAttempt = authoritativeContext
        ? openAuthoritativeRunContexts.get(authoritativeContext)
        : undefined;
      if (
        authoritativeContext &&
        attemptStateKey !== runInstance &&
        pendingTerminals.has(runInstance)
      ) {
        flushPending(runInstance);
      }
      if (
        authoritativeContext &&
        attemptStateKey !== runInstance &&
        !retiredOpenAttemptStates.has(runInstance) &&
        adoptOpenAttemptState(runInstance, attemptStateKey)
      ) {
        adoptAuthoritativeOpenRunProvenance(projectionState, runInstance, authoritativeContext);
      }
      const authoritativeOpenAttempt = authoritativeAttempt?.open
        ? authoritativeAttempt
        : undefined;
      if (
        authoritativeAttempt &&
        (pendingTerminals.has(attemptStateKey) || rejectedCountByAttemptState.has(attemptStateKey))
      ) {
        attemptEpochByState.set(attemptStateKey, authoritativeAttempt.attemptEpoch);
      }
      const retainedAuthoritativeRun = retainAuthoritativeOpenRunForRetirement(
        projectionState,
        runInstance,
        runId,
        authoritativeContext,
      );
      if (retainedAuthoritativeRun || projectionState.openRunProvenance.has(runInstance)) {
        // Context retirement can precede the final lifecycle event for every
        // registry removal path. Keep only open attempts in the bounded
        // retired set so delayed terminals retain their admitted provenance.
        if (authoritativeOpenAttempt) {
          attemptEpochByState.set(attemptStateKey, authoritativeOpenAttempt.attemptEpoch);
          attemptStartSequenceByState.set(attemptStateKey, authoritativeOpenAttempt.startSequence);
          if (authoritativeOpenAttempt.startAccepted) {
            rejectedStartAttemptStates.delete(attemptStateKey);
          } else {
            rejectedStartAttemptStates.add(attemptStateKey);
          }
          openAttemptStates.add(attemptStateKey);
        }
        retiredOpenAttemptStates.delete(attemptStateKey);
        retiredOpenAttemptStates.add(attemptStateKey);
        unownedOpenAttemptStates.delete(attemptStateKey);
        if (retiredOpenAttemptStates.size > MAX_TRACKED_RUN_PROVENANCE) {
          const oldest = retiredOpenAttemptStates.values().next().value;
          if (oldest !== undefined) {
            const oldestRunInstance = agentAuditRunInstanceFromAttemptStateKey(oldest);
            const separator = oldestRunInstance.indexOf("\0");
            const retiredRunId =
              separator >= 0 ? oldestRunInstance.slice(separator + 1) : oldestRunInstance;
            retiredOpenAttemptStates.delete(oldest);
            forgetOpenRun(projectionState, oldestRunInstance, retiredRunId);
            openAttemptStates.delete(oldest);
            rejectedStartAttemptStates.delete(oldest);
            attemptStartSequenceByState.delete(oldest);
            if (!pendingTerminals.has(oldest) && !rejectedCountByAttemptState.has(oldest)) {
              attemptEpochByState.delete(oldest);
            }
          }
        }
        return;
      }
      forgetOpenRun(projectionState, runInstance, runId);
      discardAttemptState(attemptStateKey);
      if (
        !pendingTerminals.has(attemptStateKey) &&
        !rejectedCountByAttemptState.has(attemptStateKey)
      ) {
        attemptEpochByState.delete(attemptStateKey);
      }
    },
  );
  return {
    record: (event) => {
      const runInstance = buildRunInstance(event.runId, event.lifecycleGeneration);
      const contextLifecycleToken = getAgentEventContextLifecycleToken(event);
      const phase = nonEmptyString(event.data.phase);
      const authoritativeContext = getAuthoritativeRunContextToken(
        runInstance,
        event.runId,
        contextLifecycleToken,
      );
      const attemptStateKey = getAttemptStateKey(runInstance, authoritativeContext);
      const authoritativeAttempt = authoritativeContext
        ? openAuthoritativeRunContexts.get(authoritativeContext)
        : undefined;
      if (event.stream === "lifecycle" && phase === "start" && authoritativeContext) {
        // A rebound token flushes retired attempts but adopts a still-open unowned attempt.
        for (const retiredAttemptState of matchingRetiredAgentAuditAttemptStates(
          retiredOpenAttemptStates,
          runInstance,
          attemptStateKey,
        )) {
          flushPending(retiredAttemptState);
          discardAttemptState(retiredAttemptState);
        }
        if (
          !retiredOpenAttemptStates.has(runInstance) &&
          adoptOpenAttemptState(runInstance, attemptStateKey)
        ) {
          adoptAuthoritativeOpenRunProvenance(projectionState, runInstance, authoritativeContext);
        }
        forgetOpenRun(projectionState, runInstance, event.runId);
      }
      const settled = settledRunInstances.get(attemptStateKey);
      const authoritativeOpenAttempt = authoritativeAttempt?.open
        ? authoritativeAttempt
        : undefined;
      if (event.stream === "lifecycle") {
        if (phase === "start") {
          if (settled && event.seq <= settled.terminalSequence) {
            return;
          }
          const attemptEpoch =
            authoritativeAttempt?.attemptEpoch ?? attemptEpochByState.get(attemptStateKey) ?? 0;
          const rejectedAttempt = rejectedTerminalsByAttempt.get(
            agentAuditAttemptKey(attemptStateKey, attemptEpoch),
          );
          if (rejectedAttempt && event.seq <= rejectedAttempt.observedThroughSequence) {
            return;
          }
          const pendingTerminal = pendingTerminals.get(attemptStateKey);
          if (pendingTerminal && event.seq <= pendingTerminal.observedThroughSequence) {
            return;
          }
          const cancelsPendingTerminal = pendingTerminal !== undefined;
          const hasOpenAttempt =
            openAttemptStates.has(attemptStateKey) || authoritativeOpenAttempt !== undefined;
          const canReplacePendingWithoutOpen =
            event.lifecycleGeneration === undefined ||
            isAgentEventLifecycleGenerationCurrent(event.lifecycleGeneration) ||
            authoritativeContext !== undefined;
          if (cancelsPendingTerminal && !hasOpenAttempt && !canReplacePendingWithoutOpen) {
            return;
          }
          if (hasOpenAttempt) {
            if (cancelsPendingTerminal) {
              clearPending(attemptStateKey);
            }
            const startSequence = Math.max(
              event.seq,
              authoritativeOpenAttempt?.startSequence ??
                attemptStartSequenceByState.get(attemptStateKey) ??
                event.seq,
            );
            if (authoritativeContext) {
              const startAccepted =
                authoritativeOpenAttempt?.startAccepted ??
                !rejectedStartAttemptStates.has(attemptStateKey);
              openAuthoritativeRunContexts.set(authoritativeContext, {
                attemptEpoch:
                  authoritativeOpenAttempt?.attemptEpoch ??
                  attemptEpochByState.get(attemptStateKey) ??
                  1,
                open: true,
                startSequence,
                startAccepted,
              });
              rejectedStartAttemptStates.delete(attemptStateKey);
            } else {
              openAttemptStates.add(attemptStateKey);
              attemptStartSequenceByState.set(attemptStateKey, startSequence);
            }
            return;
          }
          if (cancelsPendingTerminal) {
            clearPending(attemptStateKey);
          }
        } else if (phase === "end" || phase === "error") {
          const attemptStartSequence =
            authoritativeOpenAttempt?.startSequence ??
            attemptStartSequenceByState.get(attemptStateKey);
          const settledAttemptFloor = settledAgentAuditAttemptFloor(settled);
          if (
            (settled && settled.reopenedStartSequence === undefined) ||
            (attemptStartSequence !== undefined && event.seq <= attemptStartSequence) ||
            (settledAttemptFloor !== undefined && event.seq <= settledAttemptFloor)
          ) {
            return;
          }
        }
      }
      const projection = projectAgentEvent(projectionState, event);
      if (!projection) {
        return;
      }
      if (!projection.terminal) {
        // Retry starts cancel a provisional terminal for the same logical run.
        // A writer-rejected terminal already crossed the settle boundary and
        // remains a prior attempt; queue pressure must not rewrite that history.
        const startAccepted = writer.record(projection.input);
        if (authoritativeContext) {
          // Registry-owned weak identity carries authoritative live attempt
          // state without retaining completed run contexts.
          openAuthoritativeRunContexts.set(authoritativeContext, {
            attemptEpoch: (authoritativeAttempt?.attemptEpoch ?? 0) + 1,
            open: true,
            startSequence: event.seq,
            startAccepted,
          });
        } else {
          attemptEpochByState.set(
            attemptStateKey,
            (attemptEpochByState.get(attemptStateKey) ?? 0) + 1,
          );
          openAttemptStates.add(attemptStateKey);
          attemptStartSequenceByState.set(attemptStateKey, event.seq);
          if (startAccepted) {
            rejectedStartAttemptStates.delete(attemptStateKey);
          } else {
            rejectedStartAttemptStates.add(attemptStateKey);
          }
        }
        if (settled) {
          settledRunInstances.delete(attemptStateKey);
          settledRunInstances.set(attemptStateKey, {
            ...settled,
            reopenedStartSequence: event.seq,
          });
        }
        if (hasAuthoritativeRunContext(runInstance, event.runId, contextLifecycleToken)) {
          unownedOpenAttemptStates.delete(attemptStateKey);
        } else {
          // Supported event-bus producers receive a registry owner before this
          // callback. Bound malformed direct inputs that bypass that contract.
          unownedOpenAttemptStates.delete(attemptStateKey);
          unownedOpenAttemptStates.add(attemptStateKey);
          trimUnownedOpenRuns({
            state: projectionState,
            runInstances: unownedOpenAttemptStates,
            pendingTerminals,
            rejectedRunInstances: rejectedCountByAttemptState,
            rejectedTerminals: rejectedTerminalsByAttempt,
            openRunInstances: openAttemptStates,
            rejectedStartRunInstances: rejectedStartAttemptStates,
            attemptStartSequences: attemptStartSequenceByState,
            attemptEpochs: attemptEpochByState,
            clearPending,
            forgetRejectedAttempt,
          });
        }
        return;
      }
      const startWasRejected =
        authoritativeAttempt?.startAccepted === false ||
        (authoritativeAttempt === undefined && rejectedStartAttemptStates.has(attemptStateKey));
      if (startWasRejected) {
        openAttemptStates.delete(attemptStateKey);
        if (authoritativeContext && authoritativeAttempt) {
          openAuthoritativeRunContexts.set(authoritativeContext, {
            ...authoritativeAttempt,
            open: false,
          });
        }
        if (authoritativeContext) {
          forgetAuthoritativeOpenRun(
            projectionState,
            runInstance,
            event.runId,
            contextLifecycleToken,
          );
        }
        forgetOpenRun(projectionState, runInstance, event.runId);
        discardAttemptState(attemptStateKey);
        rememberSettled(attemptStateKey, event.seq);
        if (!rejectedCountByAttemptState.has(attemptStateKey)) {
          attemptEpochByState.delete(attemptStateKey);
        }
        return;
      }
      if (
        projection.terminal.outcome.reason === "completed" &&
        !pendingTerminals.has(attemptStateKey)
      ) {
        const attemptKey = agentAuditAttemptKey(
          attemptStateKey,
          authoritativeAttempt?.attemptEpoch ?? attemptEpochByState.get(attemptStateKey) ?? 0,
        );
        const incoming = {
          attemptKey,
          input: projection.input,
          observedThroughSequence: event.seq,
          ...projection.terminal,
        };
        const rejected = rejectedTerminalsByAttempt.get(attemptKey);
        const selected = rejected
          ? selectAgentAuditTerminalCandidate(rejected, incoming)
          : incoming;
        openAttemptStates.delete(attemptStateKey);
        const terminalAuthoritativeContext = getAuthoritativeRunContextToken(
          runInstance,
          event.runId,
          contextLifecycleToken,
        );
        if (terminalAuthoritativeContext) {
          // The terminal has crossed the settle boundary even when the writer
          // queues it for stop(); a later start therefore owns a new attempt.
          if (authoritativeAttempt) {
            openAuthoritativeRunContexts.set(terminalAuthoritativeContext, {
              ...authoritativeAttempt,
              open: false,
            });
          }
          forgetAuthoritativeOpenRun(
            projectionState,
            runInstance,
            event.runId,
            contextLifecycleToken,
          );
        }
        if (writer.record(selected.input)) {
          forgetRejectedAttempt(attemptKey);
          forgetOpenRun(projectionState, runInstance, event.runId);
          retiredOpenAttemptStates.delete(attemptStateKey);
          unownedOpenAttemptStates.delete(attemptStateKey);
          attemptStartSequenceByState.delete(attemptStateKey);
          rememberSettled(attemptStateKey, selected.observedThroughSequence);
          if (!rejectedCountByAttemptState.has(attemptStateKey)) {
            attemptEpochByState.delete(attemptStateKey);
          }
        } else {
          rememberRejectedTerminal(attemptStateKey, runInstance, selected);
        }
        return;
      }
      scheduleTerminal(attemptStateKey, runInstance, contextLifecycleToken, {
        attemptKey: agentAuditAttemptKey(
          attemptStateKey,
          authoritativeAttempt?.attemptEpoch ?? attemptEpochByState.get(attemptStateKey) ?? 0,
        ),
        input: projection.input,
        observedThroughSequence: event.seq,
        ...projection.terminal,
      });
    },
    recordTool: (event) => {
      const input = projectToolExecutionEventToAudit(projectionState, event);
      if (input) {
        writer.record(input);
      }
    },
    stop: async () => {
      for (const runInstance of pendingTerminals.keys()) {
        flushPending(runInstance);
      }
      try {
        await writer.stop(
          [...rejectedTerminalsByAttempt.values()].map((rejected) => rejected.input),
        );
      } finally {
        unsubscribeRunContextRetirement();
        // The registry remains authoritative when bounded projection entries
        // are evicted. Shutdown releases every local projection.
        projectionState.openRunProvenance.clear();
        projectionState.runProvenance.clear();
        projectionState.activeRunInstanceByRunId.clear();
        projectionState.seenRunInstances.clear();
        rejectedTerminalsByAttempt.clear();
        rejectedCountByAttemptState.clear();
        openAttemptStates.clear();
        retiredOpenAttemptStates.clear();
        unownedOpenAttemptStates.clear();
        rejectedStartAttemptStates.clear();
        settledRunInstances.clear();
        attemptEpochByState.clear();
        attemptStartSequenceByState.clear();
      }
    },
  };
}
