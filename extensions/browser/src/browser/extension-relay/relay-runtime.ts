import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type Subscription = {
  send: (method: string, params: unknown) => void;
  pending: number;
  delivered?: Set<number>;
};

/** One physical Runtime, subscribed by the same exact logical owners as Fetch. */
export class RelayRuntime {
  private readonly contexts = new Map<number, unknown>();
  private readonly subscribers = new Map<object, Subscription>();

  constructor(private readonly active: AbortSignal) {}

  async enable(
    owner: object,
    send: Subscription["send"],
    admit: () => Promise<unknown>,
  ): Promise<void> {
    this.active.throwIfAborted();
    let subscription = this.subscribers.get(owner);
    if (!subscription) {
      subscription = { send, pending: 0, delivered: new Set() };
      this.subscribers.set(owner, subscription);
    }
    subscription.pending++;
    try {
      // Each enable must pass the worker's current access gate, even when native
      // Runtime is already enabled and no longer emits its existing contexts.
      await admit();
      this.active.throwIfAborted();
      if (this.subscribers.get(owner) !== subscription) {
        throw new Error("Runtime session detached or disabled");
      }
      if (subscription.delivered) {
        for (const [id, params] of this.contexts) {
          if (!subscription.delivered.has(id)) {
            subscription.send("Runtime.executionContextCreated", params);
          }
        }
        subscription.delivered = undefined;
      }
    } finally {
      subscription.pending--;
      if (
        subscription.delivered &&
        subscription.pending === 0 &&
        this.subscribers.get(owner) === subscription
      ) {
        this.subscribers.delete(owner);
      }
    }
  }

  disable(owner: object): void {
    this.subscribers.delete(owner);
    // Keep the physical subscription until debugger detach: disabling it can
    // lose context destruction events and reset another subscriber's Runtime.
  }

  event(method: string, params: unknown): void {
    if (this.active.aborted) {
      return;
    }
    const createdId = asOptionalRecord(asOptionalRecord(params)?.context)?.id;
    const destroyedId = asOptionalRecord(params)?.executionContextId;
    if (method === "Runtime.executionContextCreated" && typeof createdId === "number") {
      this.contexts.set(createdId, params);
    } else if (method === "Runtime.executionContextDestroyed" && typeof destroyedId === "number") {
      this.contexts.delete(destroyedId);
    } else if (method === "Runtime.executionContextsCleared") {
      this.contexts.clear();
    }
    for (const subscription of this.subscribers.values()) {
      // Producer-authorized events stay live while admission awaits. Remember
      // only current context IDs until initial replay, so that replay cannot duplicate them.
      if (method === "Runtime.executionContextCreated" && typeof createdId === "number") {
        subscription.delivered?.add(createdId);
      } else if (
        method === "Runtime.executionContextDestroyed" &&
        typeof destroyedId === "number"
      ) {
        subscription.delivered?.delete(destroyedId);
      } else if (method === "Runtime.executionContextsCleared") {
        subscription.delivered?.clear();
      }
      subscription.send(method, params);
    }
  }

  dispose(): void {
    this.contexts.clear();
    this.subscribers.clear();
  }
}
