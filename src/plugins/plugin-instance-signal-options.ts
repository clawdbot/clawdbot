/** Node's WebIDL signal domain, shared by timer composition and native callback binding. */
function isPluginAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === "object" &&
    Object.prototype.isPrototypeOf.call(AbortSignal.prototype, value)
  );
}

/** Transform a native signal option where Node reads it, preserving input validation. */
export function mapPluginSignalOptions(
  options: unknown,
  mapSignal: (signal: unknown) => unknown,
): unknown {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    return options;
  }
  // A fresh target permits frozen signal properties; getters keep their original
  // receiver and timing. Callers select Node's documented options position.
  return new Proxy(
    {},
    {
      get: (_target, key) => {
        const value = Reflect.get(options, key, options);
        return key === "signal" ? mapSignal(value) : value;
      },
      has: (_target, key) => Reflect.has(options, key),
      ownKeys: () => Reflect.ownKeys(options),
      getOwnPropertyDescriptor: (_target, key) => {
        const descriptor = Object.getOwnPropertyDescriptor(options, key);
        return descriptor ? { ...descriptor, configurable: true } : undefined;
      },
      set: (_target, key, value) => Reflect.set(options, key, value, options),
      deleteProperty: (_target, key) => Reflect.deleteProperty(options, key),
    },
  );
}

/** Native options retain validation while owner cancellation joins a supplied signal. */
export function composePluginSignalOptions(signal: AbortSignal, options: unknown = {}): unknown {
  return mapPluginSignalOptions(options, (value) =>
    value === undefined
      ? signal
      : isPluginAbortSignal(value)
        ? AbortSignal.any([value, signal])
        : value,
  );
}

export function nativeSignalOptionsIndex(
  module: string | undefined,
  key: PropertyKey,
  args: unknown[],
) {
  if (module === "child_process") {
    return key !== "exec" && (args[1] == null || Array.isArray(args[1])) ? 2 : 1;
  }
  if (key === "watch" || key === "TLSSocket" || (module === "http2" && key === "connect")) {
    return 1;
  }
  if (key === "request" || key === "get") {
    return !module || typeof args[0] === "string" || args[0] instanceof URL ? 1 : 0;
  }
  if (module === "tls" && key === "connect") {
    return typeof args[0] === "object" ? 0 : typeof args[1] === "object" ? 1 : 2;
  }
  return key === "listen" || key === "connect" || key === "createConnection" || key === "Socket"
    ? 0
    : undefined;
}

/** Only native consumers see this view; user signal listeners retain their own context. */
export function createPluginSignalView(bindNativeListener: (listener: Function) => Function) {
  const views = new WeakMap<AbortSignal, AbortSignal>();
  return (signal: unknown): unknown => {
    if (!isPluginAbortSignal(signal)) {
      return signal;
    }
    const cached = views.get(signal);
    if (cached) {
      return cached;
    }
    const listeners = new WeakMap<Function, Function>();
    const view = new Proxy(signal, {
      get: (_target, key) => {
        const value = Reflect.get(signal, key, signal);
        if (typeof value !== "function" || key === "constructor") {
          return value;
        }
        return (...args: unknown[]) => {
          const listener = args[1];
          if (typeof listener === "function") {
            if (key === "addEventListener" && !listeners.has(listener)) {
              listeners.set(listener, bindNativeListener(listener));
            }
            if (key === "addEventListener" || key === "removeEventListener") {
              args[1] = listeners.get(listener) ?? listener;
            }
          }
          return Reflect.apply(value, signal, args);
        };
      },
    });
    views.set(signal, view);
    return view;
  };
}
