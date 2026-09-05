import { EventEmitter } from "node:events";
import { unwatchFile, watchFile } from "node:fs";
import { watch as watchPromise } from "node:fs/promises";
import { ClientRequest } from "node:http";
import { Server, Socket } from "node:net";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  bindNativeReceiver,
  PluginInstanceNativeCleanup,
  type PluginCleanupInvoker,
} from "./plugin-instance-native-cleanup.js";
import { pluginInstanceState } from "./plugin-instance-scope.js";
import {
  composePluginSignalOptions,
  createPluginSignalView,
  mapPluginSignalOptions,
  nativeSignalOptionsIndex,
} from "./plugin-instance-signal-options.js";
import { PluginInstanceTimers } from "./plugin-instance-timers.js";
import type { PluginInstanceAdmission } from "./plugin-instance.types.js";

type Resource = EventEmitter & Record<PropertyKey, unknown>;
type OwnedResource = {
  resource: Resource;
  closeEvent: "close" | "exit";
  parent?: OwnedResource;
  closed?: Promise<void>;
  closing?: Promise<void>;
};
type EmitterMethod = "on" | "once" | "removeListener" | "listeners" | "rawListeners" | "eventNames";
const emitterMethods = EventEmitter.prototype;
const { resourceInvocation: hostCall } = pluginInstanceState;
const childEvents = new Set(["connection", "secureConnection", "session", "stream"]);

/** Native objects keep one identity; the owner instruments admission at their API boundary. */
export class PluginInstanceResources {
  private readonly resources = new Set<OwnedResource>();
  private readonly owned = new WeakMap<object, OwnedResource>();
  private readonly builtins = new Map<string, unknown>();
  private readonly timers: PluginInstanceTimers;
  private readonly emitters = new WeakMap<object, object>();
  private readonly prototypes = new WeakMap<object, object>();
  private readonly callbacks = new WeakMap<Function, Function>();
  private readonly activeEmitters = new Map<EventEmitter, () => void>();
  private readonly pollingWatchers = new WeakMap<EventEmitter, string>();
  private cleanupRegistered = false;
  private readonly nativeCleanup: PluginInstanceNativeCleanup;
  private readonly signalView = createPluginSignalView((listener) =>
    this.nativeCleanup.bindCallback(listener, true),
  );

  constructor(
    private readonly instance: PluginInstanceAdmission,
    private readonly bindCallback: (callback: Function) => (...args: unknown[]) => unknown,
    private readonly wrapResult: (value: unknown) => unknown,
    invokeCleanup: PluginCleanupInvoker,
  ) {
    this.nativeCleanup = new PluginInstanceNativeCleanup(this, instance, invokeCleanup);
    this.timers = new PluginInstanceTimers(instance, (callback) => this.callback(callback));
  }

  get globals() {
    return this.timers.globals;
  }

  private nativeEmitter<K extends EmitterMethod>(
    method: K,
    emitter: EventEmitter,
    args: unknown[],
  ): ReturnType<EventEmitter[K]> {
    // Even native once/removeListener dispatch through other receiver methods.
    return hostCall.run(this, () => Reflect.apply(emitterMethods[method], emitter, args));
  }

  private callback(original: Function) {
    const invoke = this.bindCallback(function (this: unknown, ...args: unknown[]) {
      return hostCall.run(undefined, () => Reflect.apply(original, this, args));
    });
    const wrapped = bindNativeReceiver((receiver: EventEmitter, args) => {
      try {
        return Reflect.apply(invoke, receiver, args);
      } finally {
        // Node removes once listeners before invoking them; consult that owner.
        this.pruneListeners(receiver);
      }
    });
    this.callbacks.set(wrapped, original);
    return wrapped;
  }

  private arguments(args: unknown[], signalOptionsIndex?: number): unknown[] {
    return args.map((arg, index) =>
      typeof arg === "function" && !this.nativeCleanup.callbacks.has(arg)
        ? this.callback(arg)
        : index === signalOptionsIndex
          ? mapPluginSignalOptions(arg, (signal) => this.signalView(signal))
          : arg,
    );
  }

  private ensureCleanup(): void {
    if (this.cleanupRegistered) {
      return;
    }
    this.instance.lifecycle.onDispose(async () => {
      for (const emitter of this.activeEmitters.keys()) {
        this.removeListeners(emitter);
      }
      // A server joins its accepted sockets; initiate every close before awaiting any.
      while (this.resources.size) {
        await Promise.all([...this.resources].map((entry) => this.close(entry)));
      }
      if (this.nativeCleanup.failures.length) {
        throw new AggregateError(this.nativeCleanup.failures, "Plugin resource cleanup failed");
      }
    });
    this.instance.lifecycle.signal.addEventListener(
      "abort",
      () => {
        for (const { resource } of this.resources) {
          this.nativeEmitter("on", resource, ["error", this.shutdownError]);
        }
      },
      { once: true },
    );
    this.cleanupRegistered = true;
  }

  private ownedListeners(emitter: EventEmitter, event?: unknown) {
    const owned: {
      event: unknown;
      raw: Function;
      original: Function;
    }[] = [];
    for (const name of event === undefined
      ? this.nativeEmitter("eventNames", emitter, [])
      : [event]) {
      for (const raw of this.nativeEmitter("rawListeners", emitter, [name])) {
        const wrapped = Reflect.get(raw, "listener");
        const original =
          this.callbacks.get(raw) ??
          (typeof wrapped === "function" ? this.callbacks.get(wrapped) : undefined);
        if (original) {
          if (typeof wrapped === "function" && this.callbacks.has(wrapped)) {
            // Node's bound once state keeps invoking the owned callback; only its
            // public listener property exposes the original, as native reflection does.
            this.callbacks.set(raw, original);
            Reflect.set(raw, "listener", original);
          }
          owned.push({ event: name, raw, original });
        }
      }
    }
    return owned;
  }

  private adoptListeners(emitter: EventEmitter): void {
    if (!this.ownedListeners(emitter).length || this.activeEmitters.has(emitter)) {
      return;
    }
    this.ensureCleanup();
    // Closed requests cannot remain rooted by disposal; reusable resources
    // re-enroll their still-registered callbacks only when acquired again.
    const release = () => {
      this.activeEmitters.delete(emitter);
      this.nativeEmitter("removeListener", emitter, ["close", release]);
    };
    this.activeEmitters.set(emitter, release);
    this.nativeEmitter("once", emitter, ["close", release]);
  }

  private pruneListeners(emitter: EventEmitter): void {
    const release = this.activeEmitters.get(emitter);
    if (release && !this.ownedListeners(emitter).length) {
      release();
    }
  }

  private removeListeners(emitter: EventEmitter, event?: unknown, listener?: unknown): void {
    for (const entry of this.ownedListeners(emitter, event).toReversed()) {
      if (!listener || entry.original === listener || entry.raw === listener) {
        const rawRequested = listener === undefined || listener === entry.raw;
        const once = Reflect.get(entry.raw, "listener") === entry.original;
        const filename = this.pollingWatchers.get(emitter);
        if (filename && entry.event === "change") {
          // Native unwatch decrements the shared poller's ref-count before removing the listener.
          Reflect.apply(unwatchFile, undefined, [filename, entry.raw]);
        }
        this.nativeEmitter("removeListener", emitter, [
          entry.event,
          rawRequested || !once ? entry.raw : entry.original,
        ]);
        if (listener) {
          break;
        }
      }
    }
    this.pruneListeners(emitter);
  }

  private invokeNative(
    resource: Resource,
    key: PropertyKey,
    method: Function,
    args: unknown[],
  ): unknown {
    const fromNative = hostCall.getStore() === this;
    const call = (input: unknown[]) => {
      let values = input;
      if (key === "emit") {
        // Adopt before listeners run. Ordinary request sockets remain borrowed;
        // upgrade/CONNECT transfers them out of the Agent before closing the request.
        const event = values[0];
        const childIndex =
          resource instanceof ClientRequest && (event === "upgrade" || event === "connect")
            ? 2
            : typeof event === "string" && childEvents.has(event)
              ? 1
              : undefined;
        if (this.owned.has(resource) && childIndex !== undefined) {
          // SAFETY: These Node events supply their accepted or transferred EventEmitter at this index.
          const child = values[childIndex] as Resource;
          this.own(child, Object.getPrototypeOf(child));
        }
        const listener = values[2];
        if (
          fromNative &&
          (event === "newListener" || event === "removeListener") &&
          typeof listener === "function"
        ) {
          const original = this.callbacks.get(listener);
          if (original && Reflect.get(listener, "listener") !== original) {
            values = [...values];
            values[2] = original;
          }
        }
      }
      return Reflect.apply(method, resource, values);
    };
    if (fromNative) {
      return call(args);
    }
    if (key === "off" || key === "removeListener" || key === "removeAllListeners") {
      if (key !== "removeAllListeners" && typeof args[1] !== "function") {
        return hostCall.run(this, () => Reflect.apply(method, resource, args));
      }
      this.removeListeners(resource, args[0], args[1]);
      return resource;
    }
    if (key === "rawListeners") {
      return this.nativeEmitter("rawListeners", resource, args).map((listener) => {
        const original = this.callbacks.get(listener);
        return original && Reflect.get(listener, "listener") !== original ? original : listener;
      });
    }
    if (key === "listeners" || (key === "listenerCount" && typeof args[1] === "function")) {
      const listeners: Function[] = this.nativeEmitter("listeners", resource, [args[0]]);
      const originals = listeners.map((listener) => this.callbacks.get(listener) ?? listener);
      return key === "listeners"
        ? originals
        : originals.filter((listener) => listener === args[1]).length;
    }
    return this.instance.run(() => {
      const entry = this.owned.get(resource);
      if (
        entry &&
        ((key === "listen" && resource instanceof Server) ||
          (key === "connect" && resource instanceof Socket))
      ) {
        this.instance.lifecycle.signal.throwIfAborted();
        this.retain(entry);
      }
      const result = hostCall.run(this, () =>
        call(
          key === "emit"
            ? args
            : this.arguments(args, nativeSignalOptionsIndex(undefined, key, args)),
        ),
      );
      if (
        key !== "emit" &&
        args.some((arg) => typeof arg === "function" && !this.nativeCleanup.callbacks.has(arg))
      ) {
        // Node also installs callbacks from listen/connect and similar methods.
        this.adoptListeners(resource);
      }
      // Borrowed arguments retain their owner; newly returned native children
      // settle through their close event, never an unconsumed iterable lease.
      if (result === resource || args.includes(result)) {
        return result;
      }
      if (result instanceof EventEmitter) {
        return this.owned.has(resource)
          ? this.own(result as Resource, Object.getPrototypeOf(result)) // SAFETY: This owned native receiver returned its child.
          : result;
      }
      return this.wrapResult(result);
    });
  }

  private nativeMethod(key: PropertyKey, method: Function): Function {
    return bindNativeReceiver((receiver: Resource, args) =>
      this.invokeNative(receiver, key, method, args),
    );
  }

  private instrumentMethod(
    resource: Resource,
    key: PropertyKey,
    descriptor?: PropertyDescriptor,
  ): void {
    if (
      !descriptor?.configurable ||
      typeof key !== "string" ||
      key.startsWith("_") ||
      typeof descriptor.value !== "function"
    ) {
      return;
    }
    let value: unknown = this.nativeMethod(key, descriptor.value);
    // HTTP replaces socket listener methods during setup and parser detachment.
    // Keep their admission boundary through both native assignments.
    Object.defineProperty(resource, key, {
      configurable: true,
      enumerable: descriptor.enumerable,
      get: () => value,
      set:
        descriptor.writable === false
          ? undefined
          : (next: unknown) => {
              value =
                typeof next !== "function"
                  ? next
                  : hostCall.getStore() === this
                    ? this.nativeMethod(key, next)
                    : this.callback(next);
            },
    });
  }

  private nativePrototypeView(prototype: object): object {
    const cached = this.prototypes.get(prototype);
    if (cached) {
      return cached;
    }
    const methods = new Map<PropertyKey, { source: Function; wrapped: Function }>();
    const view = new Proxy(Object.create(prototype), {
      set: (target, key, value, receiver) => {
        const assigned = Reflect.set(target, key, value, receiver);
        if (assigned && typeof value === "function" && hostCall.getStore() === this) {
          this.instrumentMethod(receiver, key, Object.getOwnPropertyDescriptor(receiver, key));
        }
        return assigned;
      },
      get: (target, key, receiver) => {
        const value = hostCall.run(this, () => Reflect.get(target, key, receiver));
        if (typeof value !== "function" || key === "constructor") {
          return value;
        }
        const method = methods.get(key);
        if (method && method.source === value) {
          return method.wrapped;
        }
        const wrapped = this.nativeMethod(key, value);
        methods.set(key, { source: value, wrapped });
        return wrapped;
      },
    });
    this.prototypes.set(prototype, view);
    return view;
  }

  private instrument(resource: Resource, nativePrototype: object, boundary?: object): void {
    const ownDescriptors = Object.getOwnPropertyDescriptors(resource);
    // Derived fields initialize on this exact return value from super(). A second
    // object would split their private brand from Node's native receiver.
    if (boundary) {
      for (
        let current = Object.getPrototypeOf(resource);
        current && current !== boundary;
        current = Object.getPrototypeOf(current)
      ) {
        for (const key of Reflect.ownKeys(current)) {
          if (key === "constructor" || Object.hasOwn(resource, key)) {
            continue;
          }
          const descriptor = Object.getOwnPropertyDescriptor(current, key)!;
          const bind = (method: Function) =>
            this.nativeCleanup.bindVirtual(resource, key, method, this.callback(method));
          Object.defineProperty(resource, key, {
            ...descriptor,
            ...(typeof descriptor.value === "function" ? { value: bind(descriptor.value) } : {}),
            ...(descriptor.get ? { get: bind(descriptor.get.bind(resource)) } : {}),
            ...(descriptor.set ? { set: bind(descriptor.set.bind(resource)) } : {}),
          });
        }
      }
    } else {
      Object.setPrototypeOf(resource, this.nativePrototypeView(nativePrototype));
    }
    // Some Node APIs install public operations directly on each instance (IPC send).
    for (const [key, descriptor] of Object.entries(ownDescriptors)) {
      this.instrumentMethod(resource, key, descriptor);
    }
  }

  private own(
    resource: Resource,
    nativePrototype: object,
    boundary?: object,
    closeEvent: "close" | "exit" = "close",
    parent?: OwnedResource,
  ): Resource {
    if (this.owned.has(resource)) {
      return resource;
    }
    this.instrument(resource, nativePrototype, boundary);
    const entry = { resource, closeEvent, parent };
    this.owned.set(resource, entry);
    this.emitters.set(resource, resource);
    if (resource instanceof Socket) {
      this.nativeCleanup.bindSocketHandle(resource);
    }
    // ChildProcess exposes its created pipes through the documented stdio array.
    if (Array.isArray(resource.stdio)) {
      for (const pipe of resource.stdio) {
        if (pipe) {
          this.own(pipe, Object.getPrototypeOf(pipe), undefined, "close", entry);
        }
      }
    }
    this.retain(entry);
    return resource;
  }

  private retain(entry: OwnedResource): void {
    if (this.resources.has(entry)) {
      return;
    }
    this.ensureCleanup();
    this.resources.add(entry);
    entry.closed = new Promise<void>((resolve) => {
      this.nativeEmitter("once", entry.resource, [
        entry.closeEvent,
        () => {
          this.nativeEmitter("removeListener", entry.resource, ["error", this.shutdownError]);
          if (!entry.closing) {
            this.resources.delete(entry);
          }
          this.activeEmitters.get(entry.resource)?.();
          entry.parent = undefined;
          resolve();
        },
      ]);
    });
    if (this.instance.lifecycle.signal.aborted) {
      this.nativeEmitter("on", entry.resource, ["error", this.shutdownError]);
      void this.close(entry);
    } else {
      this.adoptListeners(entry.resource);
    }
  }

  private readonly shutdownError = () => {};

  private close(entry: OwnedResource): Promise<void> {
    if (entry.closing) {
      return entry.closing;
    }
    const { resource } = entry;
    const closing = hostCall
      .run(this, async () => {
        // ChildProcess exit destroys stdin and drains its output pipes. Their
        // close events join that owner instead of racing separate disposal.
        if (entry.parent) {
          await this.close(entry.parent);
          await entry.closed;
          return;
        }
        // A signal may already be destroying the stream. Join its native close;
        // asyncDispose would replay the earlier operation error as a cleanup error.
        if (resource.destroyed === true) {
          await entry.closed;
          return;
        }
        const dispose = resource[Symbol.asyncDispose];
        if (typeof dispose === "function") {
          await Reflect.apply(dispose, resource, []);
        } else {
          for (const name of ["destroy", "terminate", "kill", "close"]) {
            const cleanup = resource[name];
            if (typeof cleanup === "function") {
              // FSWatcher errors clear the native handle without emitting close.
              if (name === "close" && Reflect.get(resource, "_handle") === null) {
                break;
              }
              await Reflect.apply(cleanup, resource, []);
              await entry.closed;
              break;
            }
          }
        }
      })
      .catch((error: unknown) => {
        // HTTP Server disposal delegates to close even when it never listened.
        if (
          !(
            resource instanceof Server &&
            error instanceof Error &&
            "code" in error &&
            error.code === "ERR_SERVER_NOT_RUNNING"
          )
        ) {
          this.nativeCleanup.failures.push(error);
        }
      })
      .finally(() => {
        this.resources.delete(entry);
      });
    entry.closing = closing;
    return closing;
  }

  wrapEmitter<T extends object>(target: T, overrides: Record<string, unknown> = {}): T {
    const cached = this.emitters.get(target);
    if (cached) {
      // SAFETY: This map contains only an exact owned object or its borrowed view.
      return cached as T;
    }
    const facade = new Proxy(target, {
      get: (resource, key) => {
        if (typeof key === "string" && Object.hasOwn(overrides, key)) {
          return overrides[key];
        }
        const value = Reflect.get(resource, key, resource);
        if (typeof value !== "function" || key === "constructor") {
          return value;
        }
        return (...args: unknown[]) => {
          // SAFETY: Only EventEmitter-shaped host callback values enter this view.
          const result = this.invokeNative(resource as T & Resource, key, value, args);
          return result === resource ? facade : result;
        };
      },
    });
    this.emitters.set(target, facade);
    this.emitters.set(facade, facade);
    return facade;
  }

  private factory(module: string, key: string, target: Function): Function {
    const closeEvent = module === "worker_threads" && key === "Worker" ? "exit" : "close";
    const nativePrototype = target.prototype;
    let boundary: object | undefined;
    const invoke = (receiver: unknown, newTarget: Function | undefined, args: unknown[]) => {
      const constructing = newTarget !== undefined;
      return this.instance.run(() => {
        this.instance.lifecycle.signal.throwIfAborted();
        return hostCall.run(this, () => {
          // Install retirement error handling before native signal callbacks.
          this.ensureCleanup();
          const input = this.arguments(args, nativeSignalOptionsIndex(module, key, args));
          const value = constructing
            ? Reflect.construct(target, input, newTarget)
            : Reflect.apply(target, receiver, input);
          if (value && typeof value === "object") {
            return this.own(
              value,
              constructing && boundary ? nativePrototype : Object.getPrototypeOf(value),
              constructing ? boundary : undefined,
              closeEvent,
            );
          }
          return value;
        });
      });
    };
    function factory(this: unknown, ...args: unknown[]) {
      return invoke(this, new.target, args);
    }
    Object.setPrototypeOf(factory, target);
    Object.defineProperties(factory, {
      name: { value: target.name },
      length: { value: target.length },
    });
    const custom = Reflect.get(target, promisify.custom);
    if (
      module === "child_process" &&
      (key === "exec" || key === "execFile") &&
      typeof custom === "function"
    ) {
      Object.defineProperty(factory, promisify.custom, {
        value: (...args: unknown[]) =>
          this.instance.run(() =>
            hostCall.run(this, () => {
              this.instance.lifecycle.signal.throwIfAborted();
              this.ensureCleanup();
              const promise = Reflect.apply(
                custom,
                target,
                this.arguments(args, nativeSignalOptionsIndex(module, key, args)),
                // SAFETY: Node exec/execFile custom promises expose their actual ChildProcess at .child.
              ) as Promise<unknown> & {
                child: Resource;
              };
              this.own(promise.child, Object.getPrototypeOf(promise.child));
              return { promise };
            }),
          ).promise,
      });
    }
    if (nativePrototype && Object.prototype.isPrototypeOf.call(emitterMethods, nativePrototype)) {
      boundary = this.nativePrototypeView(nativePrototype);
      Object.defineProperty(factory, "prototype", { value: boundary });
      Object.defineProperty(factory, Symbol.hasInstance, {
        value(this: Function, value: unknown) {
          // Native base classes retain cross-module instanceof; derived classes
          // still require their own prototype instead of inheriting a broad match.
          return Reflect.apply(
            Function.prototype[Symbol.hasInstance],
            this === factory ? target : this,
            [value],
          );
        },
      });
      Object.defineProperty(boundary, "constructor", {
        value: factory,
        configurable: true,
        writable: true,
      });
    }
    return factory;
  }

  private pollingPath(filename: unknown): string {
    Reflect.apply(unwatchFile, undefined, [filename, () => {}]);
    // SAFETY: Native validation rejects invalid paths; the inaccessible listener preserves peers.
    return resolvePath(filename instanceof URL ? fileURLToPath(filename) : (filename as string));
  }

  loadBuiltin(specifier: string, load: (specifier: string) => unknown): unknown {
    const name = specifier.replace(/^node:/, "");
    if (this.builtins.has(name)) {
      return this.builtins.get(name);
    }
    if (name === "process") {
      const facade = this.wrapEmitter(process, {
        env: { ...process.env },
        getBuiltinModule: (builtinName: string) =>
          this.loadBuiltin(`node:${builtinName.replace(/^node:/, "")}`, load),
        nextTick: (callback: Function, ...args: unknown[]) =>
          this.instance.run(() =>
            hostCall.run(this, () => process.nextTick(this.callback(callback), ...args)),
          ),
      });
      this.builtins.set(name, facade);
      return facade;
    }
    // SAFETY: The module host resolves Node builtin namespaces before entering here.
    const loaded = load(specifier) as Record<string, unknown>;
    const result = { ...loaded };
    if (name === "fs/promises") {
      result.watch = (...args: unknown[]) =>
        this.instance.run(() =>
          Reflect.apply(watchPromise, undefined, [
            args[0],
            composePluginSignalOptions(this.instance.lifecycle.signal, args[1]),
          ]),
        );
    } else if (name === "timers") {
      Object.assign(result, this.globals, {
        promises: this.loadBuiltin("node:timers/promises", load),
      });
    } else if (name === "timers/promises") {
      Object.assign(result, this.timers.promises());
    } else if (
      ["http", "https", "http2", "net", "tls", "fs", "child_process", "worker_threads"].includes(
        name,
      )
    ) {
      if (name === "fs") {
        result.promises = this.loadBuiltin("node:fs/promises", load);
        result.watchFile = (...args: unknown[]) =>
          this.instance.run(() => {
            this.instance.lifecycle.signal.throwIfAborted();
            const filename = this.pollingPath(args[0]);
            const watcher = Reflect.apply(watchFile, undefined, [
              filename,
              ...this.arguments(args.slice(1)),
            ]);
            this.pollingWatchers.set(watcher, filename);
            this.adoptListeners(watcher);
            return this.wrapEmitter(watcher);
          });
        result.unwatchFile = (path: unknown, listener?: unknown) => {
          const filename = this.pollingPath(path);
          for (const watcher of this.activeEmitters.keys()) {
            if (this.pollingWatchers.get(watcher) === filename) {
              this.removeListeners(
                watcher,
                "change",
                typeof listener === "function" ? listener : undefined,
              );
            }
          }
        };
      }
      const factories = new Set([
        "createServer",
        "createConnection",
        "connect",
        "request",
        "get",
        "watch",
        "spawn",
        "fork",
        "exec",
        "execFile",
        "Worker",
        "Server",
        "Socket",
        "TLSSocket",
      ]);
      for (const [key, value] of Object.entries(loaded)) {
        if (factories.has(key) && typeof value === "function") {
          result[key] = this.factory(name, key, value);
        }
      }
    } else {
      return loaded;
    }
    this.builtins.set(name, result);
    return result;
  }

  prepareGlobals(load: (specifier: string) => unknown): Record<string, unknown> {
    return { ...this.globals, process: this.loadBuiltin("node:process", load) };
  }

  beginDisposal(reason: unknown): void {
    this.timers.beginDisposal(reason);
  }

  clear(): void {
    this.nativeCleanup.clear();
    this.timers.clear(this.instance.lifecycle.signal.reason);
    this.builtins.clear();
  }
}
