import {
  mergeAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../agents/agent-run-terminal-outcome.js";
import type { AuditEventInput } from "./audit-event-types.js";

export type AgentAuditProjection = {
  input: AuditEventInput;
  terminal?: { outcome: AgentRunTerminalOutcome; phase: "end" | "error" };
};

export type AgentAuditTerminalCandidate = {
  attemptKey: string;
  input: AuditEventInput;
  observedThroughSequence: number;
  outcome: AgentRunTerminalOutcome;
  phase: "end" | "error";
};

type AgentAuditPendingTerminal = AgentAuditTerminalCandidate & {
  timer: ReturnType<typeof setTimeout>;
};

export type AgentAuditPendingTerminalWithOwnership = AgentAuditPendingTerminal & {
  flushTarget: { attemptStateKey: string };
  runInstance: string;
  contextLifecycleToken?: object;
};

export type AgentAuditSettledRun = {
  terminalSequence: number;
  reopenedStartSequence?: number;
};

export type AgentAuditOpenAttempt = {
  attemptEpoch: number;
  open: boolean;
  startSequence: number;
  startAccepted: boolean;
};

export function createAgentAuditPendingTerminal(params: {
  attemptStateKey: string;
  candidate: AgentAuditTerminalCandidate;
  contextLifecycleToken?: object;
  flush: (attemptStateKey: string) => void;
  runInstance: string;
  settleMs: number;
}): AgentAuditPendingTerminalWithOwnership {
  const flushTarget = { attemptStateKey: params.attemptStateKey };
  const timer = setTimeout(() => params.flush(flushTarget.attemptStateKey), params.settleMs);
  timer.unref?.();
  return {
    ...params.candidate,
    flushTarget,
    timer,
    runInstance: params.runInstance,
    ...(params.contextLifecycleToken
      ? { contextLifecycleToken: params.contextLifecycleToken }
      : {}),
  };
}

export function createAgentAuditSettledAttemptRecorder(
  settledAttempts: Map<string, AgentAuditSettledRun>,
  maxTracked: number,
) {
  return (attemptStateKey: string, observedThroughSequence: number): void => {
    settledAttempts.delete(attemptStateKey);
    settledAttempts.set(attemptStateKey, { terminalSequence: observedThroughSequence });
    while (settledAttempts.size > maxTracked) {
      const oldest = settledAttempts.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      settledAttempts.delete(oldest);
    }
  };
}

export function agentAuditAttemptKey(runInstance: string, attemptEpoch: number): string {
  return `${runInstance}\0${attemptEpoch}`;
}

export function createAgentAuditAttemptStateKeyResolver() {
  const keyByContext = new WeakMap<object, string>();
  let nextId = 0;
  return (runInstance: string, contextLifecycleToken?: object): string => {
    if (!contextLifecycleToken) {
      return runInstance;
    }
    const existing = keyByContext.get(contextLifecycleToken);
    if (existing) {
      return existing;
    }
    const created = `${runInstance}\0context:${++nextId}`;
    keyByContext.set(contextLifecycleToken, created);
    return created;
  };
}

export function agentAuditRunInstanceFromAttemptStateKey(attemptStateKey: string): string {
  const contextSeparator = attemptStateKey.lastIndexOf("\0context:");
  return contextSeparator >= 0 ? attemptStateKey.slice(0, contextSeparator) : attemptStateKey;
}

export function matchingRetiredAgentAuditAttemptStates(
  retiredAttemptStates: ReadonlySet<string>,
  runInstance: string,
  currentAttemptState: string,
): string[] {
  return [...retiredAttemptStates].filter(
    (attemptState) =>
      attemptState !== currentAttemptState &&
      agentAuditRunInstanceFromAttemptStateKey(attemptState) === runInstance,
  );
}

export function settledAgentAuditAttemptFloor(
  settled: AgentAuditSettledRun | undefined,
): number | undefined {
  return settled?.reopenedStartSequence === undefined
    ? undefined
    : Math.max(settled.terminalSequence, settled.reopenedStartSequence);
}

export function selectAgentAuditTerminalCandidate(
  existing: AgentAuditTerminalCandidate,
  incoming: AgentAuditTerminalCandidate,
): AgentAuditTerminalCandidate {
  // A bare cleanup end can follow a definitive error without a retry start.
  // Otherwise use the shared sticky timeout/cancellation merge contract.
  const cleanupAfterError =
    existing.phase === "error" &&
    incoming.phase === "end" &&
    incoming.outcome.reason === "completed";
  if (cleanupAfterError) {
    return {
      ...existing,
      observedThroughSequence: Math.max(
        existing.observedThroughSequence,
        incoming.observedThroughSequence,
      ),
    };
  }
  const merged = mergeAgentRunTerminalOutcome(existing.outcome, incoming.outcome);
  const selected = merged === existing.outcome ? existing : incoming;
  return {
    ...selected,
    observedThroughSequence: Math.max(
      existing.observedThroughSequence,
      incoming.observedThroughSequence,
    ),
  };
}
