import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { RelayRuntime } from "./relay-runtime.js";

type PhysicalSession = {
  tabId: number;
  rootSessionId: string;
  childSessionId?: string;
  parentSessionId?: string;
  runtime: RelayRuntime;
};

type LogicalSession = {
  physical: PhysicalSession;
  parentSessionId?: string;
};

export type RelaySessionClient = {
  socket: { send: (data: string) => void };
  sessions: Map<string, LogicalSession>;
};

/** Owns physical debugger lifetimes and their per-connection logical sessions. */
export class RelaySessionOwner {
  private readonly physical = new Map<string, PhysicalSession>();

  constructor(private readonly clients: ReadonlySet<RelaySessionClient>) {}

  registerRoot(tabId: number, sessionId: string): void {
    this.physical.set(sessionId, { tabId, rootSessionId: sessionId, runtime: new RelayRuntime() });
  }

  announce(
    client: RelaySessionClient,
    sessionId: string,
    physicalId: string,
    params: unknown,
    parentSessionId?: string,
  ): void {
    const physical = this.physical.get(physicalId);
    if (!physical || !this.clients.has(client) || client.sessions.has(sessionId)) {
      return;
    }
    client.sessions.set(sessionId, { physical, parentSessionId });
    client.socket.send(
      JSON.stringify({ sessionId: parentSessionId, method: "Target.attachedToTarget", params }),
    );
  }

  detach(client: RelaySessionClient, sessionId: string, targetId?: string): void {
    const session = client.sessions.get(sessionId);
    if (!session) {
      return;
    }
    session.physical.runtime.disable(client, sessionId);
    client.sessions.delete(sessionId);
    client.socket.send(
      JSON.stringify({
        sessionId: session.parentSessionId,
        method: "Target.detachedFromTarget",
        params: { sessionId, ...(targetId ? { targetId } : {}) },
      }),
    );
    this.detachChildren(client, sessionId);
  }

  detachChildren(client: RelaySessionClient, parentSessionId: string): void {
    for (const [sessionId, session] of client.sessions) {
      if (session.parentSessionId === parentSessionId) {
        this.detach(client, sessionId);
      }
    }
  }

  retire(sessionId: string, targetId?: string): void {
    const physical = this.physical.get(sessionId);
    if (!physical) {
      return;
    }
    this.physical.delete(sessionId);
    physical.runtime.dispose();
    for (const client of this.clients) {
      for (const [id, session] of client.sessions) {
        if (session.physical === physical) {
          this.detach(client, id, targetId);
        }
      }
    }
    for (const [childId, child] of this.physical) {
      if (child.parentSessionId === sessionId) {
        this.retire(childId);
      }
    }
  }

  hasTabSessions(tabId: number): boolean {
    return [...this.clients].some((client) =>
      [...client.sessions.values()].some((session) => session.physical.tabId === tabId),
    );
  }

  close(client: RelaySessionClient): void {
    for (const session of client.sessions.values()) {
      session.physical.runtime.disable(client);
    }
    client.sessions.clear();
  }

  forward(
    rootSessionId: string,
    childSessionId: string | undefined,
    method: string,
    params: unknown,
  ): void {
    const sessionId = childSessionId ?? rootSessionId;
    const physical = this.physical.get(sessionId);
    // Only a parent attachment creates child routing; late events cannot
    // resurrect a detached child or cross into a replacement root attachment.
    if (!physical || physical.rootSessionId !== rootSessionId) {
      return;
    }
    if (method.startsWith("Runtime.")) {
      physical.runtime.event(method, params);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const detached = asOptionalRecord(params);
      if (
        typeof detached?.sessionId === "string" &&
        this.physical.get(detached.sessionId)?.parentSessionId === sessionId
      ) {
        this.retire(
          detached.sessionId,
          typeof detached.targetId === "string" ? detached.targetId : undefined,
        );
      }
      return;
    }
    if (method === "Target.attachedToTarget") {
      const childId = asOptionalRecord(params)?.sessionId;
      if (typeof childId !== "string") {
        return;
      }
      if (!this.physical.has(childId)) {
        this.physical.set(childId, {
          tabId: physical.tabId,
          rootSessionId,
          childSessionId: childId,
          parentSessionId: sessionId,
          runtime: new RelayRuntime(),
        });
      }
      // A real child id is connection-scoped. Announce it once on an owned
      // parent, including alias-only clients, rather than duplicating it on every alias.
      for (const client of this.clients) {
        const parent = [...client.sessions].find(([, session]) => session.physical === physical);
        if (parent) {
          this.announce(client, childId, childId, params, parent[0]);
        }
      }
      return;
    }
    for (const client of this.clients) {
      for (const [id, session] of client.sessions) {
        if (session.physical === physical) {
          client.socket.send(JSON.stringify({ sessionId: id, method, params }));
        }
      }
    }
  }

  dispose(): void {
    for (const session of this.physical.values()) {
      session.runtime.dispose();
    }
    this.physical.clear();
    for (const client of this.clients) {
      client.sessions.clear();
    }
  }
}
