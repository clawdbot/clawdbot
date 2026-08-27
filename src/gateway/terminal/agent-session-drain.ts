import type {
  AgentTerminalOwner,
  AgentTerminalSessionDrain,
  TerminalOwner,
  TerminalSession,
} from "./session-manager.types.js";

export function agentTerminalOwnerMatches(
  owner: TerminalOwner | null,
  expected: AgentTerminalOwner,
): boolean {
  if (owner?.kind !== "agent") {
    return false;
  }
  return (
    owner.agentSessionKey === expected.agentSessionKey &&
    owner.agentSessionId === expected.agentSessionId &&
    owner.agentId === expected.agentId
  );
}

type TaskBoundAgentOwner = Extract<TerminalOwner, { kind: "agent" }> & { taskId?: string };

export function terminalTaskOwnerMatches(owner: TerminalOwner | null, taskId: string): boolean {
  // SAFETY: taskId is manager-private metadata added only to host-minted agent owners.
  return owner?.kind === "agent" && (owner as TaskBoundAgentOwner).taskId === taskId;
}

function drainKey(owner: AgentTerminalOwner): string {
  return JSON.stringify([owner.agentSessionKey, owner.agentSessionId, owner.agentId]);
}

export class AgentTerminalSessionDrainTracker {
  private readonly active = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly exiting = new Set<TerminalSession>();

  begin(owner: AgentTerminalOwner, hasWork: () => boolean): AgentTerminalSessionDrain {
    const key = drainKey(owner);
    this.active.add(key);
    let resolveDrain!: () => void;
    const drained = new Promise<void>((resolve) => {
      resolveDrain = resolve;
      const waiters = this.waiters.get(key) ?? new Set();
      waiters.add(resolve);
      this.waiters.set(key, waiters);
    });
    this.resolveIfIdle(owner, hasWork);
    let released = false;
    return {
      drained,
      hasWork,
      release: () => {
        if (released) {
          return;
        }
        released = true;
        this.active.delete(key);
        const waiters = this.waiters.get(key);
        waiters?.delete(resolveDrain);
        if (waiters?.size === 0) {
          this.waiters.delete(key);
        }
      },
    };
  }

  isActive(owner: AgentTerminalOwner): boolean {
    return this.active.has(drainKey(owner));
  }

  trackExit(session: TerminalSession): void {
    this.exiting.add(session);
  }

  observeExit(session: TerminalSession): void {
    this.exiting.delete(session);
  }

  hasExiting(owner: AgentTerminalOwner): boolean {
    return [...this.exiting].some((session) => agentTerminalOwnerMatches(session.owner, owner));
  }

  resolveIfIdle(owner: AgentTerminalOwner, hasWork: () => boolean): void {
    if (hasWork()) {
      return;
    }
    const key = drainKey(owner);
    const waiters = this.waiters.get(key);
    if (!waiters) {
      return;
    }
    this.waiters.delete(key);
    for (const resolve of waiters) {
      resolve();
    }
  }
}
