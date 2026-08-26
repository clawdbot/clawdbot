import type { TerminalPendingOpen } from "./session-manager.types.js";

function addIndexed<Value>(index: Map<string, Set<Value>>, connId: string, value: Value): void {
  const values = index.get(connId) ?? new Set<Value>();
  values.add(value);
  index.set(connId, values);
}

function removeIndexed<Value>(index: Map<string, Set<Value>>, connId: string, value: Value): void {
  const values = index.get(connId);
  values?.delete(value);
  if (values?.size === 0) {
    index.delete(connId);
  }
}

/** Reverse indexes live sessions and in-flight opens by their browser connection. */
export class TerminalConnectionIndex {
  private readonly sessions = new Map<string, Set<string>>();
  private readonly pendingOpens = new Map<string, Set<TerminalPendingOpen>>();

  addSession(connId: string, sessionId: string): void {
    addIndexed(this.sessions, connId, sessionId);
  }

  removeSession(connId: string, sessionId: string): void {
    removeIndexed(this.sessions, connId, sessionId);
  }

  sessionIds(connId: string): string[] | undefined {
    const ids = this.sessions.get(connId);
    return ids ? [...ids] : undefined;
  }

  clearSessions(connId: string): void {
    this.sessions.delete(connId);
  }

  addPendingOpen(connId: string, pending: TerminalPendingOpen): void {
    addIndexed(this.pendingOpens, connId, pending);
  }

  removePendingOpen(connId: string, pending: TerminalPendingOpen): void {
    removeIndexed(this.pendingOpens, connId, pending);
  }

  pendingFor(connId: string): TerminalPendingOpen[] | undefined {
    const pending = this.pendingOpens.get(connId);
    return pending ? [...pending] : undefined;
  }
}
