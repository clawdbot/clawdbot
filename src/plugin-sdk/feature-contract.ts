/** Browser-safe typed operations over the existing plugin session-action transport. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Static, TSchema } from "typebox";

export type FeatureDisposer = () => void;

/** A connection-owned transport usable from browsers or other feature clients. */
export type FeatureTransport = {
  readonly pluginId: string;
  readonly signal: AbortSignal;
  readonly connection: { connected: boolean };
  request: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
  onEvent: (event: string, listener: (payload: unknown) => void) => FeatureDisposer;
  subscribe: (listener: () => void) => FeatureDisposer;
};

export type FeatureOperation = {
  kind: "query" | "action";
  description: string;
  input: TSchema;
  output: TSchema;
  tool?: { name: string; label?: string; optional?: boolean };
};

export type FeatureContract = {
  pluginId: string;
  operations: Readonly<Record<string, FeatureOperation>>;
  events: Readonly<Record<string, TSchema>>;
};

export type FeatureOperationName<C extends FeatureContract> = keyof C["operations"] & string;
export type FeatureEventName<C extends FeatureContract> = keyof C["events"] & string;
export type FeatureInput<C extends FeatureContract, K extends FeatureOperationName<C>> = Static<
  C["operations"][K]["input"]
>;
export type FeatureOutput<C extends FeatureContract, K extends FeatureOperationName<C>> = Static<
  C["operations"][K]["output"]
>;
export type FeatureEvent<C extends FeatureContract, K extends FeatureEventName<C>> = Static<
  C["events"][K]
>;
export type FeatureQueryName<C extends FeatureContract> = {
  [K in FeatureOperationName<C>]: C["operations"][K]["kind"] extends "query" ? K : never;
}[FeatureOperationName<C>];
export type FeatureRequestOptions = { sessionKey?: string; agentId?: string };

export function defineFeatureContract<const C extends FeatureContract>(contract: C): C {
  if (
    !contract.pluginId.trim() ||
    Object.keys(contract.operations).length > 64 ||
    Object.keys(contract.events).length > 64
  ) {
    throw new Error("Feature contracts require a plugin id and at most 64 operations and events");
  }
  for (const id of Object.keys(contract.operations)) {
    if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(id)) {
      throw new Error(`Invalid feature operation id: ${id}`);
    }
  }
  for (const id of Object.keys(contract.events)) {
    if (!/^[a-z][a-z0-9_-]{0,127}$/u.test(id)) {
      throw new Error(`Invalid feature event id: ${id}`);
    }
  }
  return contract;
}

export type FeatureClient<C extends FeatureContract> = {
  invoke: <K extends FeatureOperationName<C>>(
    operation: K,
    input: FeatureInput<C, K>,
    options?: FeatureRequestOptions,
  ) => Promise<FeatureOutput<C, K>>;
  on: <K extends FeatureEventName<C>>(
    event: K,
    listener: (payload: FeatureEvent<C, K>) => void,
  ) => FeatureDisposer;
  watch: <K extends FeatureQueryName<C>>(
    operation: K,
    input: FeatureInput<C, K>,
    options: FeatureRequestOptions & {
      events: readonly FeatureEventName<C>[];
      onChange: (output: FeatureOutput<C, K>) => void;
      onError: (error: Error) => void;
    },
  ) => FeatureDisposer;
};

/** Uses only the current browser connection; it does not mint scopes or a backend client. */
export function createFeatureClient<C extends FeatureContract>(
  contract: C,
  host: FeatureTransport,
): FeatureClient<C> {
  if (host.pluginId !== contract.pluginId) {
    throw new Error("Feature contract must belong to the active browser plugin");
  }
  const invoke: FeatureClient<C>["invoke"] = async (operation, input, options = {}) => {
    host.signal.throwIfAborted();
    const result = await host.request("plugins.sessionAction", {
      pluginId: contract.pluginId,
      actionId: operation,
      payload: input,
      ...options,
    });
    host.signal.throwIfAborted();
    if (!isRecord(result) || result.ok !== true) {
      throw new Error(
        isRecord(result) && typeof result.error === "string"
          ? result.error
          : "Feature operation returned an invalid response",
      );
    }
    // SAFETY: defineFeaturePlugin validates successful results against this operation's output schema.
    return result.result as FeatureOutput<C, typeof operation>;
  };
  const on: FeatureClient<C>["on"] = (event, listener) =>
    host.onEvent(`plugin.${contract.pluginId}.${event}`, (payload) =>
      // SAFETY: the contract's backend emitter validates this namespaced event against its schema.
      listener(payload as FeatureEvent<C, typeof event>),
    );
  const watch: FeatureClient<C>["watch"] = (operation, input, options) => {
    if (contract.operations[operation]?.kind !== "query") {
      throw new Error("Only feature queries can be watched");
    }
    let disposed = false;
    let generation = 0;
    let scheduled = false;
    let connected = host.connection.connected;
    const refresh = () => {
      generation += 1;
      if (disposed || !host.connection.connected || scheduled) {
        return;
      }
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (disposed || !host.connection.connected) {
          return;
        }
        const current = generation;
        void invoke(operation, input, {
          sessionKey: options.sessionKey,
          agentId: options.agentId,
        }).then(
          (output) => {
            if (!disposed && current === generation && host.connection.connected) {
              options.onChange(output);
            }
          },
          (error: unknown) => {
            if (!disposed && current === generation && host.connection.connected) {
              options.onError(error instanceof Error ? error : new Error(String(error)));
            }
          },
        );
      });
    };
    const subscriptions = options.events.map((event) => on(event, refresh));
    subscriptions.push(
      host.subscribe(() => {
        if (connected !== host.connection.connected) {
          connected = host.connection.connected;
          refresh();
        }
      }),
    );
    const dispose = () => {
      disposed = true;
      generation += 1;
      for (const unsubscribe of subscriptions) {
        unsubscribe();
      }
      host.signal.removeEventListener("abort", dispose);
    };
    host.signal.addEventListener("abort", dispose, { once: true });
    if (host.signal.aborted) {
      dispose();
    } else {
      refresh();
    }
    return dispose;
  };
  return { invoke, on, watch };
}
