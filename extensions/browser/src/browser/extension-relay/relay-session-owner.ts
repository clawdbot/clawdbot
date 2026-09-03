import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { RelayFetch } from "./relay-fetch.js";
import { RelayRuntime } from "./relay-runtime.js";
import { RelayTarget } from "./relay-target.js";

type PhysicalSender = (
  childSessionId: string | undefined,
  method: string,
  params: Record<string, unknown> | undefined,
  signal: AbortSignal,
) => Promise<unknown>;
type PhysicalSession = {
  id: string;
  tabId: number;
  nativeTargetId: string;
  rootSessionId: string;
  childSessionId?: string;
  runtime: RelayRuntime;
  target: RelayTarget<LogicalSession>;
  parent?: PhysicalSession;
  children: Set<PhysicalSession>;
  subscribers: Set<LogicalSession>;
  attached?: { targetInfo: Record<string, unknown>; waitingForDebugger: boolean };
  retiring?: Promise<void>;
  fetch: RelayFetch;
  transport: PhysicalSender;
  active: AbortController;
  lifetime: AbortController;
};
type LogicalSession = {
  physical: PhysicalSession;
  client: RelaySessionClient;
  id: string;
  parentSessionId?: string;
  parent?: LogicalSession;
  children: Map<PhysicalSession, LogicalSession>;
  flat: boolean;
  detachedChildren: Set<PhysicalSession>;
  frameTreeRead?: Promise<void>;
  runtimeGeneration: number;
};
export type RelaySessionClient = {
  socket: { send: (data: string) => void };
  sessions: Map<string, LogicalSession>;
};

// Cleanup must not wait for a hung body read/evaluation. After one second the
// native owner detaches even if cleanup is incomplete; detach can resume unseen requests.
const SESSION_RETIREMENT_MS = 1_000;

/** Owns physical debugger lifetimes and their per-connection logical sessions. */
export class RelaySessionOwner {
  private readonly physical = new Map<string, PhysicalSession>();
  private nextAlias = 1;

  constructor(
    private readonly clients: ReadonlySet<RelaySessionClient>,
    private readonly retireAttachment: (rootSessionId: string) => Promise<void>,
    private readonly report: (error: unknown) => void,
    private readonly hasPendingClaims: (tabId: number) => boolean,
  ) {}

  registerRoot(
    tabId: number,
    nativeTargetId: string,
    sessionId: string,
    transport: PhysicalSender,
  ): void {
    this.register({ tabId, nativeTargetId, rootSessionId: sessionId, transport });
  }

  private register(
    scope: Pick<
      PhysicalSession,
      "tabId" | "nativeTargetId" | "rootSessionId" | "transport" | "childSessionId" | "parent"
    >,
  ): PhysicalSession {
    const active = new AbortController();
    const physical: PhysicalSession = {
      ...scope,
      id: scope.childSessionId ?? scope.rootSessionId,
      runtime: new RelayRuntime(active.signal, (method, params) =>
        this.send(physical, method, params),
      ),
      target: new RelayTarget(
        (params) => this.send(physical, "Target.setAutoAttach", params, "target"),
        () => this.reconcileChildren(physical),
        () => active.signal.throwIfAborted(),
      ),
      children: new Set(),
      subscribers: new Set(),
      active,
      lifetime: new AbortController(),
      fetch: new RelayFetch((method, params) => this.send(physical, method, params, "fetch")),
    };
    physical.parent?.children.add(physical);
    this.physical.set(scope.childSessionId ?? scope.rootSessionId, physical);
    return physical;
  }

  async send(
    physical: PhysicalSession,
    method: string,
    params?: Record<string, unknown>,
    domain?: "fetch" | "target",
  ): Promise<unknown> {
    const assertCurrent = () => {
      physical.lifetime.signal.throwIfAborted();
      if (this.physical.get(physical.id) !== physical) {
        throw new Error("Physical session detached");
      }
    };
    assertCurrent();
    // prepareRetirement is the only Fetch admission after active work is fenced.
    const signal = physical.active.signal.aborted
      ? physical.lifetime.signal
      : physical.active.signal;
    if (domain !== "fetch") {
      physical.active.signal.throwIfAborted();
    }
    try {
      const result = await physical.transport(physical.childSessionId, method, params, signal);
      assertCurrent();
      signal.throwIfAborted();
      if (method === "Runtime.runIfWaitingForDebugger" && physical.attached) {
        physical.attached.waitingForDebugger = false;
      }
      return result;
    } catch (error) {
      if (domain && !physical.active.signal.aborted) {
        // Only an actual sender failure retires the scope. Local ownership/stage
        // rejections never pass here and cannot evict another logical user.
        void this.retireAttachment(physical.rootSessionId).catch(this.report);
      }
      throw error;
    }
  }

  announce(
    client: RelaySessionClient,
    sessionId: string,
    physicalId: string,
    params: unknown,
    parentSessionId?: string,
    flat = true,
  ): void {
    const physical = this.physical.get(physicalId);
    if (
      !physical ||
      physical.active.signal.aborted ||
      !this.clients.has(client) ||
      client.sessions.has(sessionId)
    ) {
      return;
    }
    const parent = parentSessionId ? client.sessions.get(parentSessionId) : undefined;
    const session: LogicalSession = {
      physical,
      client,
      id: sessionId,
      parentSessionId,
      parent,
      children: new Map(),
      flat,
      detachedChildren: new Set(),
      runtimeGeneration: 0,
    };
    client.sessions.set(sessionId, session);
    physical.subscribers.add(session);
    parent?.children.set(physical, session);
    this.parentEvent(session, "Target.attachedToTarget", params);
  }

  private deliver(
    session: LogicalSession,
    payload: Record<string, unknown>,
    flatId = session.id,
  ): void {
    if (session.parent && !session.flat) {
      const message = flatId === session.id ? payload : { ...payload, sessionId: flatId };
      this.deliver(session.parent, {
        method: "Target.receivedMessageFromTarget",
        params: {
          sessionId: session.id,
          targetId: session.physical.nativeTargetId,
          message: JSON.stringify(message),
        },
      });
    } else if (session.parent) {
      this.deliver(session.parent, payload, flatId);
    } else {
      session.client.socket.send(JSON.stringify({ ...payload, sessionId: flatId }));
    }
  }

  child(parent: LogicalSession, params?: Record<string, unknown>): LogicalSession {
    const child =
      params?.sessionId !== undefined
        ? typeof params.sessionId === "string"
          ? parent.client.sessions.get(params.sessionId)
          : undefined
        : [...parent.children.values()].find(
            (candidate) => candidate.physical.nativeTargetId === params?.targetId,
          );
    if (!child || child.parent !== parent) {
      throw new Error("Target child session not found");
    }
    return child;
  }

  private parentEvent(session: LogicalSession, method: string, params: unknown): void {
    if (session.parent) {
      this.deliver(session.parent, { method, params });
    } else {
      session.client.socket.send(
        JSON.stringify({ sessionId: session.parentSessionId, method, params }),
      );
    }
  }

  emit(session: LogicalSession, payload: Record<string, unknown>): void {
    if (this.clients.has(session.client) && session.client.sessions.get(session.id) === session) {
      this.deliver(session, payload);
    }
  }

  private childWanted(child: PhysicalSession): boolean {
    const parent = child.parent;
    return Boolean(
      parent &&
      [...parent.subscribers].some(
        (session) =>
          !session.detachedChildren.has(child) &&
          parent.target.interest(session, String(child.attached?.targetInfo.type)),
      ),
    );
  }

  private projectChild(parent: LogicalSession, child: PhysicalSession): void {
    const info = child.attached;
    const interest = parent.physical.target.interest(parent, String(info?.targetInfo.type));
    if (
      !info ||
      !interest?.admitted ||
      parent.children.has(child) ||
      parent.detachedChildren.has(child)
    ) {
      return;
    }
    const id = `openclaw-child-${this.nextAlias++}`;
    this.announce(
      parent.client,
      id,
      child.id,
      { ...info, sessionId: id },
      parent.id,
      interest.flatten,
    );
  }

  private async reconcileChildren(physical: PhysicalSession): Promise<void> {
    if (physical.active.signal.aborted) {
      return;
    }
    const removed: LogicalSession[] = [];
    for (const parent of physical.subscribers) {
      for (const child of physical.children) {
        const info = child.attached;
        if (!info || child.active.signal.aborted) {
          continue;
        }
        const interest = physical.target.interest(parent, String(info.targetInfo.type));
        const existing = parent.children.get(child);
        if (existing && (!interest || existing.flat !== interest.flatten)) {
          removed.push(...this.remove(existing.client, existing.id));
        }
        this.projectChild(parent, child);
      }
    }
    // The current parent Target transition already owns this queue; never enqueue
    // its own child cleanup behind itself. Fetch cleanup is bounded by retire().
    await Promise.all(
      [...physical.children].map(async (child) => {
        if (!child.subscribers.size && !this.childWanted(child)) {
          await this.retire(child.id, () =>
            this.send(
              physical,
              "Target.detachFromTarget",
              { sessionId: child.childSessionId },
              "target",
            ).then(() => {}),
          );
        }
      }),
    );
    await this.release(removed, physical);
  }

  private remove(client: RelaySessionClient, sessionId: string): LogicalSession[] {
    const session = client.sessions.get(sessionId);
    if (!session) {
      return [];
    }
    session.physical.runtime.retire(session);
    client.sessions.delete(sessionId);
    session.physical.subscribers.delete(session);
    session.parent?.children.delete(session.physical);
    if (this.clients.has(client)) {
      this.parentEvent(session, "Target.detachedFromTarget", {
        sessionId,
        targetId: session.physical.nativeTargetId,
      });
    }
    return [
      session,
      ...[...session.children.values()].flatMap((child) => this.remove(client, child.id)),
    ];
  }

  detach(client: RelaySessionClient, sessionId: string): Promise<void> {
    const session = client.sessions.get(sessionId);
    session?.parent?.detachedChildren.add(session.physical);
    return this.release(this.remove(client, sessionId));
  }

  detachChildren(client: RelaySessionClient, parentSessionId: string): Promise<void> {
    return this.release(
      [...client.sessions]
        .filter(([, session]) => session.parentSessionId === parentSessionId)
        .flatMap(([id]) => this.remove(client, id)),
    );
  }

  private async release(sessions: LogicalSession[], reconciling?: PhysicalSession): Promise<void> {
    await Promise.all(
      sessions.map(async (session) => {
        const physical = session.physical;
        if (physical.active.signal.aborted) {
          return;
        }
        if (
          !this.hasRootSessions(physical.rootSessionId) &&
          !this.hasPendingClaims(physical.tabId)
        ) {
          await this.retireAttachment(physical.rootSessionId);
          return;
        }
        const parent = physical.parent;
        if (
          parent &&
          !physical.subscribers.size &&
          !this.childWanted(physical) &&
          parent !== reconciling
        ) {
          await parent.target.enqueue(() => this.reconcileChildren(parent));
          return;
        }
        const targetCleanup = physical.target.remove(session);
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.all([
            targetCleanup,
            Promise.race([
              Promise.all([physical.fetch.close(session), physical.runtime.close(session)]),
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(
                  () => reject(new Error("Session owner cleanup timed out")),
                  SESSION_RETIREMENT_MS,
                );
                timer.unref?.();
              }),
            ]),
          ]);
        } catch (error) {
          await this.retireAttachment(physical.rootSessionId);
          throw error;
        } finally {
          clearTimeout(timer);
        }
        if (parent && parent !== reconciling && !physical.subscribers.size) {
          await parent.target.enqueue(() => this.reconcileChildren(parent));
        }
      }),
    );
  }

  retire(sessionId: string, detach?: () => Promise<void>): Promise<void> {
    const physical = this.physical.get(sessionId);
    if (!physical) {
      return Promise.resolve();
    }
    const descendants = (scope: PhysicalSession): PhysicalSession[] => [
      scope,
      ...[...scope.children].flatMap(descendants),
    ];
    const scopes = descendants(physical);
    for (const scope of scopes) {
      scope.active.abort(new Error("Physical session detached"));
      scope.runtime.dispose();
      scope.target.dispose();
      for (const session of scope.subscribers) {
        this.remove(session.client, session.id);
      }
    }

    const dispose = () => {
      for (const scope of scopes) {
        scope.lifetime.abort(new Error("Physical session detached"));
        scope.fetch.dispose();
        scope.parent?.children.delete(scope);
        for (const parent of scope.parent?.subscribers ?? []) {
          parent.detachedChildren.delete(scope);
        }
        const id = scope.childSessionId ?? scope.rootSessionId;
        if (this.physical.get(id) === scope) {
          this.physical.delete(id);
        }
      }
    };
    if (!detach) {
      dispose();
      return physical.retiring ?? Promise.resolve();
    }
    if (physical.retiring) {
      return physical.retiring;
    }
    const preparations = scopes.map((scope) =>
      scope.fetch.prepareRetirement(SESSION_RETIREMENT_MS),
    );
    return (physical.retiring = (async () => {
      try {
        const results = await Promise.all(preparations);
        for (const result of results) {
          for (const error of result.errors) {
            this.report(error);
          }
        }
      } finally {
        // Native closure/transport loss can end the scope while cleanup waits.
        // Its terminal lifetime prevents late cleanup from detaching a successor.
        const needsDetach = !physical.lifetime.signal.aborted;
        dispose();
        if (needsDetach) {
          await detach();
        }
      }
    })());
  }

  retireTab(tabId: number): void {
    for (const [id, scope] of this.physical) {
      if (scope.tabId === tabId) {
        void this.retire(id);
      }
    }
  }

  hasRootSessions(id: string): boolean {
    return (this.physical.get(id)?.subscribers.size ?? 0) > 0;
  }

  close(client: RelaySessionClient): Promise<void> {
    return this.release([...client.sessions.keys()].flatMap((id) => this.remove(client, id)));
  }

  forward(
    rootSessionId: string,
    childSessionId: string | undefined,
    method: string,
    params: unknown,
  ): void {
    const sessionId = childSessionId ?? rootSessionId;
    const physical = this.physical.get(sessionId);
    // Only parent attachment creates child routing; late events cannot resurrect a scope.
    if (!physical || physical.active.signal.aborted || physical.rootSessionId !== rootSessionId) {
      return;
    }
    if (physical.fetch.event(method, params)) {
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
        this.physical.get(detached.sessionId)?.parent === physical
      ) {
        void this.retire(detached.sessionId);
      }
      return;
    }
    if (method === "Target.targetInfoChanged") {
      const info = asOptionalRecord(asOptionalRecord(params)?.targetInfo);
      const child = [...physical.children].find(
        (candidate) => candidate.nativeTargetId === info?.targetId,
      );
      if (child?.attached && info && typeof info.type === "string") {
        child.attached.targetInfo = info;
        for (const parent of physical.subscribers) {
          if (parent.children.has(child) && physical.target.interest(parent, info.type)?.admitted) {
            this.emit(parent, { method, params });
          }
        }
        void physical.target.enqueue(() => this.reconcileChildren(physical)).catch(this.report);
        return;
      }
    }
    if (method === "Target.attachedToTarget") {
      const attached = asOptionalRecord(params);
      const childId = attached?.sessionId;
      const nativeTargetId = asOptionalRecord(attached?.targetInfo)?.targetId;
      if (typeof childId !== "string" || typeof nativeTargetId !== "string") {
        this.report(new Error("Native child attachment is missing its session or target identity"));
        return;
      }
      const targetInfo = asOptionalRecord(attached?.targetInfo);
      if (!targetInfo || typeof targetInfo.type !== "string" || !nativeTargetId) {
        this.report(new Error("Native child attachment is missing its target type"));
        return;
      }
      if (!this.physical.has(childId)) {
        const child = this.register({
          tabId: physical.tabId,
          nativeTargetId,
          rootSessionId,
          childSessionId: childId,
          parent: physical,
          transport: physical.transport,
        });
        child.attached = { targetInfo, waitingForDebugger: attached?.waitingForDebugger === true };
      }
      // Live projections use only admitted interests; a pending enable replays
      // cached children after that caller's worker admission succeeds.
      const child = this.physical.get(childId);
      if (!child || child.parent !== physical || child.active.signal.aborted) {
        return;
      }
      for (const parent of physical.subscribers) {
        this.projectChild(parent, child);
      }
      if (!physical.target.wanted(targetInfo.type)) {
        void physical.target.enqueue(() => this.reconcileChildren(physical)).catch(this.report);
      }
      return;
    }
    for (const session of physical.subscribers) {
      this.emit(session, { method, params });
    }
  }

  dispose(): void {
    for (const id of this.physical.keys()) {
      void this.retire(id);
    }
    for (const client of this.clients) {
      client.sessions.clear();
    }
  }
}
