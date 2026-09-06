import { types } from "node:util";
import { createDeferredCore } from "../shared/deferred.js";
import { pluginInstanceState } from "./plugin-instance-scope.js";
import type { PluginInstanceAdmission } from "./plugin-instance.types.js";

const { resourceInvocation: hostCall } = pluginInstanceState;

export function isPluginData(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") {
    return typeof value !== "function";
  }
  if (
    types.isAnyArrayBuffer(value) ||
    types.isArrayBufferView(value) ||
    types.isDate(value) ||
    types.isRegExp(value) ||
    types.isNativeError(value)
  ) {
    return true;
  }
  if (seen.has(value)) {
    return true;
  }
  seen.add(value);
  const native = Array.isArray(value)
    ? Array
    : types.isMap(value)
      ? Map
      : types.isSet(value)
        ? Set
        : Object;
  const prototype = Object.getPrototypeOf(value);
  const constructor = prototype && Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
  // Same-engine realm intrinsics share native source; subclasses retain their own executable source.
  if (
    prototype !== null &&
    (typeof constructor !== "function" ||
      Function.prototype.toString.call(constructor) !== Function.prototype.toString.call(native) ||
      Object.getOwnPropertyDescriptor(constructor, "prototype")?.value !== prototype)
  ) {
    return false;
  }
  const entries = native === Map || native === Set ? native.prototype.entries : undefined;
  return (
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      return "value" in descriptor && isPluginData(descriptor.value, seen);
    }) &&
    (!entries || [...Reflect.apply(entries, value, [])].every((entry) => isPluginData(entry, seen)))
  );
}

const arrayCallbacks = new Set([
  "every",
  "filter",
  "find",
  "findIndex",
  "findLast",
  "findLastIndex",
  "flatMap",
  "forEach",
  "map",
  "reduce",
  "reduceRight",
  "some",
  "sort",
  "toSorted",
]);

/** Native collection signatures distinguish callbacks from callable keys and stored values. */
export function collectionCallbackIndex(object: object, key: PropertyKey): 0 | null | undefined {
  const array = Array.isArray(object);
  const intrinsic = array
    ? Array.prototype
    : types.isMap(object)
      ? Map.prototype
      : types.isSet(object)
        ? Set.prototype
        : types.isWeakMap(object)
          ? WeakMap.prototype
          : types.isWeakSet(object)
            ? WeakSet.prototype
            : undefined;
  if (!intrinsic || !Object.hasOwn(intrinsic, key)) {
    return undefined;
  }
  let prototype: object | null = object;
  while (prototype && !Object.hasOwn(prototype, key)) {
    prototype = Object.getPrototypeOf(prototype);
  }
  const parent = prototype && Object.getPrototypeOf(prototype);
  // Intrinsic collection prototypes directly inherit their realm's Object.prototype.
  // Own/subclass overrides remain ordinary plugin methods, including custom higher-order methods.
  if (!parent || Object.getPrototypeOf(parent) !== null) {
    return undefined;
  }
  return key === "forEach" || (array && typeof key === "string" && arrayCallbacks.has(key))
    ? 0
    : null;
}

export type PluginCleanupInvoker = <T>(run: () => T, completed?: Promise<void>) => T;

export function bindNativeReceiver<T, R>(invoke: (receiver: T, args: unknown[]) => R) {
  return function (this: T, ...args: unknown[]): R {
    return invoke(this, args);
  };
}

/** Native callbacks retain their receiver, cleanup authority, and completion contract. */
export class PluginInstanceNativeCleanup {
  readonly callbacks = new WeakSet<Function>();
  readonly failures: unknown[] = [];
  private readonly socketHandles = new WeakSet<object>();
  private nativeTeardown = false;

  constructor(
    private readonly scope: object,
    private readonly instance: PluginInstanceAdmission,
    private invokeCleanup: PluginCleanupInvoker | undefined,
  ) {}

  bindCallback(callback: Function, nativeTeardown = false): Function {
    return bindNativeReceiver((receiver: unknown, args) =>
      hostCall.run(this.scope, () => {
        const previous = this.nativeTeardown;
        this.nativeTeardown = previous || nativeTeardown;
        try {
          return Reflect.apply(callback, receiver, args);
        } finally {
          this.nativeTeardown = previous;
        }
      }),
    );
  }

  bindSocketHandle(resource: object): void {
    // net.initSocketHandle installs this callback entry; closeSocketHandle consumes it.
    // SAFETY: Node Socket handles supply onread, close(callback), and TCP reset(callback).
    const handle = Reflect.get(resource, "_handle") as {
      onread: Function;
      close: Function;
      reset?: Function;
    } | null;
    if (!handle || this.socketHandles.has(handle)) {
      return;
    }
    this.socketHandles.add(handle);
    const bind = this.bindCallback.bind(this);
    // Accepted C++ handles predate JS adoption; their own async context does not
    // inherit the later destroy call. Bind the actual native callback entries.
    handle.onread = bind(handle.onread);
    for (const key of ["close", "reset"] as const) {
      const method = handle[key];
      if (method) {
        handle[key] = function (this: unknown, ...args: unknown[]) {
          return Reflect.apply(
            method,
            this,
            args.map((arg) => (typeof arg === "function" ? bind(arg) : arg)),
          );
        };
      }
    }
  }

  bindVirtual(resource: object, key: PropertyKey, method: Function, callback: Function) {
    return (...args: unknown[]) => {
      if (hostCall.getStore() === this.scope) {
        // Completion callbacks passed into virtual methods still belong to Node
        // when an override forwards them through super().
        // Node's _destroy callback owns completion; its return may be void.
        const completion =
          this.nativeTeardown && this.invokeCleanup && key === "_destroy"
            ? createDeferredCore()
            : undefined;
        const initiatingError = args[0];
        let completed = false;
        args = args.map((arg, index) => {
          if (typeof arg !== "function") {
            return arg;
          }
          const native = this.bindCallback(arg);
          const bound =
            completion && index === 1
              ? bindNativeReceiver((receiver: unknown, values) => {
                  if (!completed && values[0] && values[0] !== initiatingError) {
                    this.failures.push(values[0]);
                  }
                  completed = true;
                  try {
                    return Reflect.apply(native, receiver, values);
                  } finally {
                    completion.resolve();
                  }
                })
              : native;
          this.callbacks.add(bound);
          return bound;
        });
        // Only a native signal callback may admit a retired virtual destructor.
        // Plugin code still executes outside the native operation boundary.
        if (this.nativeTeardown && this.invokeCleanup) {
          return this.invokeCleanup(() => {
            try {
              return hostCall.run(undefined, () => Reflect.apply(method, resource, args));
            } catch (error) {
              this.failures.push(error);
              completed = true;
              completion?.resolve();
              throw error;
            }
          }, completion?.promise);
        }
        return Reflect.apply(callback, resource, args);
      }
      return this.instance.run(() =>
        hostCall.run(undefined, () => Reflect.apply(method, resource, args)),
      );
    };
  }

  clear(): void {
    this.invokeCleanup = undefined;
  }
}
