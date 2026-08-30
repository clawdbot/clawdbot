import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type Subscription = {
  send: (method: string, params: unknown) => void;
  pending: number;
  delivered?: Set<number>;
};

type BindingOwner = {
  send: Subscription["send"];
  names: Set<string>;
  retired: boolean;
};

/** One physical Runtime, subscribed by the same exact logical owners as Fetch. */
export class RelayRuntime {
  private readonly contexts = new Map<number, unknown>();
  private readonly subscribers = new Map<object, Subscription>();
  // Context selectors still share the native Runtime; callback ownership is by
  // registered name and does not depend on Runtime.enable subscriptions.
  private readonly bindings = new Map<object, BindingOwner>();
  private bindingQueue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly active: AbortSignal,
    private readonly sendBinding: (
      method: string,
      params: Record<string, unknown>,
    ) => Promise<unknown>,
  ) {}

  binding(
    owner: object,
    send: Subscription["send"],
    method: "Runtime.addBinding" | "Runtime.removeBinding",
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    if (!params || typeof params.name !== "string") {
      return Promise.reject(new Error("Binding name must be a string"));
    }
    const name = params.name;
    let state = this.bindings.get(owner);
    if (!state) {
      state = { send, names: new Set(), retired: false };
      this.bindings.set(owner, state);
    }
    const binding = state;
    return this.enqueueBinding(async () => {
      if (binding.retired) {
        throw new Error("Runtime session detached");
      }
      if (method === "Runtime.removeBinding") {
        return this.removeBinding(binding, name);
      }
      const result = await this.sendBinding(method, params);
      this.active.throwIfAborted();
      // A successful native add must remain owned until queued detach cleanup,
      // even when the logical session closes while worker admission awaits.
      binding.names.add(name);
      if (binding.retired) {
        throw new Error("Runtime session detached");
      }
      return result;
    });
  }

  private enqueueBinding<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.bindingQueue.then(() => {
      this.active.throwIfAborted();
      return operation();
    });
    this.bindingQueue = result.catch(() => {});
    return result;
  }

  private async removeBinding(binding: BindingOwner, name: string): Promise<unknown> {
    if (!binding.names.has(name)) {
      return {};
    }
    let result: unknown = {};
    // Native removal affects every logical session on the physical debugger.
    // Retired peers still own their native registrations until their cleanup runs.
    if (![...this.bindings.values()].some((peer) => peer !== binding && peer.names.has(name))) {
      result = await this.sendBinding("Runtime.removeBinding", { name });
      this.active.throwIfAborted();
    }
    binding.names.delete(name);
    return result;
  }

  retire(owner: object): void {
    this.disable(owner);
    const binding = this.bindings.get(owner);
    if (binding) {
      binding.retired = true;
    }
  }

  close(owner: object): Promise<void> {
    const binding = this.bindings.get(owner);
    if (!binding) {
      return Promise.resolve();
    }
    return this.enqueueBinding(async () => {
      for (const name of binding.names) {
        await this.removeBinding(binding, name);
      }
      this.bindings.delete(owner);
    });
  }

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
    if (method === "Runtime.bindingCalled") {
      const name = asOptionalRecord(params)?.name;
      if (typeof name === "string") {
        for (const binding of this.bindings.values()) {
          if (!binding.retired && binding.names.has(name)) {
            binding.send(method, params);
          }
        }
      }
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
    this.bindings.clear();
  }
}
