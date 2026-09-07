import type { ControlUiHost } from "../../../src/plugin-sdk/control-ui.js";

/** A mounted view cannot retain host calls or listeners after its own lifetime ends. */
export function scopeControlUiHost(host: ControlUiHost, signal: AbortSignal): ControlUiHost {
  const check = () => {
    if (signal.aborted || host.signal.aborted) {
      throw new Error("This plugin UI view has ended.");
    }
  };
  const bindCallback =
    <Args extends unknown[]>(listener: (...args: Args) => void) =>
    (...args: Args) => {
      if (!signal.aborted && !host.signal.aborted) {
        listener(...args);
      }
    };
  const disposers = new Set<() => void>();
  const keep = (dispose: () => void) => {
    if (signal.aborted || host.signal.aborted) {
      dispose();
      check();
    }
    const stop = () => {
      if (disposers.delete(stop)) {
        dispose();
      }
    };
    disposers.add(stop);
    return stop;
  };
  const checkCompletion = (result: unknown) =>
    result instanceof Promise
      ? result.then((next) => {
          check();
          return next;
        })
      : result;
  signal.addEventListener(
    "abort",
    () => {
      for (const dispose of disposers) {
        try {
          dispose();
        } catch (error) {
          console.error("[openclaw] plugin UI cleanup failed", error);
        }
      }
      disposers.clear();
    },
    { once: true },
  );
  const services = <T extends object>(
    source: T,
    callbackArguments: Readonly<Partial<Record<PropertyKey, number>>> = {},
    disposeHandle?: () => void,
  ): T =>
    new Proxy(source, {
      get(target, property, receiver) {
        if (property === "dispose" && disposeHandle) {
          return disposeHandle;
        }
        check();
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          check();
          // An initial callback can retire the view before we retain its disposer.
          const callbackIndex = callbackArguments[property];
          if (callbackIndex !== undefined) {
            const callback = args[callbackIndex];
            if (typeof callback === "function") {
              args[callbackIndex] = bindCallback((...values: unknown[]) =>
                Reflect.apply(callback, undefined, values),
              );
            }
          }
          const result: unknown = Reflect.apply(value, target, args);
          if (typeof result === "function") {
            return keep(() => result());
          }
          if (
            result &&
            typeof result === "object" &&
            "dispose" in result &&
            typeof result.dispose === "function"
          ) {
            const dispose = result.dispose;
            const stop = keep(() => dispose.call(result));
            return services(result, {}, stop);
          }
          return checkCompletion(result);
        };
      },
    });
  return {
    ...host,
    signal,
    get connection() {
      check();
      return host.connection;
    },
    get locale() {
      check();
      return host.locale;
    },
    request: async <T>(method: string, params?: Record<string, unknown>): Promise<T> => {
      check();
      const result = await host.request<T>(method, params);
      check();
      return result;
    },
    onEvent: (name, listener) => {
      check();
      return keep(host.onEvent(name, bindCallback(listener)));
    },
    subscribe: (listener) => {
      check();
      return keep(host.subscribe(bindCallback(listener)));
    },
    sessions: services(host.sessions, { observe: 1 }),
    agents: services(host.agents),
    navigation: services(host.navigation),
    ui: services(host.ui),
    components: services(host.components),
  };
}
