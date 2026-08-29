import { once } from "node:events";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type RuntimeSubscription = {
  send: (method: string, params: unknown) => void;
  contexts: Set<number>;
};

/** One physical debugger Runtime, shared by connection + logical-session subscriptions. */
export class RelayRuntime {
  private readonly contexts = new Map<number, unknown>();
  private readonly subscribers = new Map<object, Map<string, RuntimeSubscription>>();
  private readonly retirement = new AbortController();
  private readonly retired = once(this.retirement.signal, "abort").then(() => undefined);

  async enable(
    client: object,
    sessionId: string,
    send: (method: string, params: unknown) => void,
    admit: () => Promise<unknown>,
  ): Promise<void> {
    if (this.retirement.signal.aborted) {
      throw new Error("Runtime session detached");
    }
    let sessions = this.subscribers.get(client);
    if (!sessions) {
      sessions = new Map();
      this.subscribers.set(client, sessions);
    }
    let subscription = sessions.get(sessionId);
    if (!subscription) {
      subscription = { send, contexts: new Set() };
      sessions.set(sessionId, subscription);
    }
    try {
      // Repeated native enable is idempotent (V8RuntimeAgentImpl::enable), but
      // every call still validates current worker policy before cached replay.
      await Promise.race([admit(), this.retired]);
    } catch (error) {
      if (sessions.get(sessionId) === subscription) {
        this.disable(client, sessionId);
      }
      throw error;
    }
    if (
      this.retirement.signal.aborted ||
      this.subscribers.get(client)?.get(sessionId) !== subscription
    ) {
      throw new Error("Runtime session detached or disabled");
    }
    // Native events may arrive during admission. Replay only contexts this
    // logical subscriber has not seen, before its enable response.
    for (const [id, params] of this.contexts) {
      if (!subscription.contexts.has(id)) {
        subscription.contexts.add(id);
        subscription.send("Runtime.executionContextCreated", params);
      }
    }
  }

  disable(client: object, sessionId?: string): void {
    const sessions = this.subscribers.get(client);
    if (sessionId !== undefined) {
      sessions?.delete(sessionId);
    }
    if (sessionId === undefined || sessions?.size === 0) {
      this.subscribers.delete(client);
    }
    // Keep the physical subscription until debugger detach: disabling it can
    // lose context destruction events and reset another subscriber's Runtime.
  }

  event(method: string, params: unknown): void {
    if (this.retirement.signal.aborted) {
      return;
    }
    const id =
      method === "Runtime.executionContextCreated"
        ? asOptionalRecord(asOptionalRecord(params)?.context)?.id
        : method === "Runtime.executionContextDestroyed"
          ? asOptionalRecord(params)?.executionContextId
          : undefined;
    if (method === "Runtime.executionContextsCleared") {
      this.contexts.clear();
    } else if (typeof id === "number") {
      if (method === "Runtime.executionContextCreated") {
        this.contexts.set(id, params);
      } else {
        this.contexts.delete(id);
      }
    }
    for (const sessions of this.subscribers.values()) {
      for (const subscription of sessions.values()) {
        if (method === "Runtime.executionContextsCleared") {
          subscription.contexts.clear();
        } else if (typeof id === "number") {
          if (method === "Runtime.executionContextCreated") {
            subscription.contexts.add(id);
          } else {
            subscription.contexts.delete(id);
          }
        }
        subscription.send(method, params);
      }
    }
  }

  dispose(): void {
    this.retirement.abort();
    this.contexts.clear();
    this.subscribers.clear();
  }
}
