import type { ControlUiHost } from "../../../src/plugin-sdk/control-ui.js";

/** A mounted view cannot retain host calls or listeners after its own lifetime ends. */
export function scopeControlUiHost(host: ControlUiHost, signal: AbortSignal): ControlUiHost {
  const check = () => {
    if (signal.aborted || host.signal.aborted) {
      throw new Error("This plugin UI view has ended.");
    }
  };
  const disposers = new Set<() => void>();
  const keep = (dispose: () => void) => {
    let active = true;
    const stop = () => {
      if (!active) {
        return;
      }
      active = false;
      disposers.delete(stop);
      dispose();
    };
    disposers.add(stop);
    return stop;
  };
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
  const services = <T extends object>(source: T): T =>
    new Proxy(source, {
      get(target, property, receiver) {
        check();
        const value = Reflect.get(target, property, receiver) as unknown;
        if (typeof value !== "function") {
          return value;
        }
        return (...args: unknown[]) => {
          check();
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
            return new Proxy(result, {
              get(handle, key, handleReceiver) {
                if (key === "dispose") {
                  return stop;
                }
                check();
                const method = Reflect.get(handle, key, handleReceiver) as unknown;
                return typeof method === "function"
                  ? (...handleArgs: unknown[]) => {
                      check();
                      return Reflect.apply(method, handle, handleArgs);
                    }
                  : method;
              },
            });
          }
          if (result instanceof Promise) {
            return result.then((next) => {
              check();
              return next;
            });
          }
          return result;
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
      return keep(
        host.onEvent(name, (payload) => {
          if (!signal.aborted) {
            listener(payload);
          }
        }),
      );
    },
    subscribe: (listener) => {
      check();
      return keep(
        host.subscribe(() => {
          if (!signal.aborted) {
            listener();
          }
        }),
      );
    },
    sessions: services(host.sessions),
    agents: services(host.agents),
    navigation: services(host.navigation),
    ui: services(host.ui),
    components: services(host.components),
  };
}
