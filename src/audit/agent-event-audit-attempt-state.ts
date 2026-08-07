import type {
  AgentAuditPendingTerminalWithOwnership,
  AgentAuditSettledRun,
} from "./agent-event-audit-terminal.js";

function moveMapValue<T>(map: Map<string, T>, from: string, to: string): void {
  const value = map.get(from);
  if (value === undefined || map.has(to)) {
    return;
  }
  map.delete(from);
  map.set(to, value);
}

function moveSetValue(set: Set<string>, from: string, to: string): void {
  if (set.delete(from)) {
    set.add(to);
  }
}

function movePendingTerminal(
  pendingTerminals: Map<string, AgentAuditPendingTerminalWithOwnership>,
  from: string,
  to: string,
): void {
  const pending = pendingTerminals.get(from);
  if (!pending || pendingTerminals.has(to)) {
    return;
  }
  pendingTerminals.delete(from);
  pending.flushTarget.attemptStateKey = to;
  pendingTerminals.set(to, pending);
}

export function adoptAgentAuditAttemptState(params: {
  from: string;
  to: string;
  openAttempts: Set<string>;
  unownedAttempts: Set<string>;
  rejectedStarts: Set<string>;
  pendingTerminals: Map<string, AgentAuditPendingTerminalWithOwnership>;
  settledAttempts: Map<string, AgentAuditSettledRun>;
  attemptEpochs: Map<string, number>;
  attemptStartSequences: Map<string, number>;
}): boolean {
  if (params.from === params.to || !params.openAttempts.has(params.from)) {
    return false;
  }
  moveSetValue(params.openAttempts, params.from, params.to);
  params.unownedAttempts.delete(params.from);
  moveSetValue(params.rejectedStarts, params.from, params.to);
  movePendingTerminal(params.pendingTerminals, params.from, params.to);
  moveMapValue(params.settledAttempts, params.from, params.to);
  moveMapValue(params.attemptEpochs, params.from, params.to);
  moveMapValue(params.attemptStartSequences, params.from, params.to);
  return true;
}
