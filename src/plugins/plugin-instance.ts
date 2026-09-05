import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import {
  bindNativeReceiver,
  collectionCallbackIndex,
  isPluginData,
} from "./plugin-instance-native-cleanup.js";
import { PluginInstanceResources } from "./plugin-instance-resources.js";
import {
  pluginInstanceState,
  resolvePluginInstanceOwner,
  type PluginInstanceOwner,
} from "./plugin-instance-scope.js";
import type { PluginInstanceLifecycle } from "./plugin-instance.types.js";
import type { PluginRecord, PluginRegistry } from "./registry-types.js";
import {
  withPluginRuntimePluginScope,
  withPluginRuntimeRegistryScope,
} from "./runtime/gateway-request-scope.js";
import { getPluginRuntimeGenerationRegistry } from "./runtime/generation-scope.js";

const { values: valueInstances, invocation } = pluginInstanceState;
const SHUTDOWN_TIMEOUT_MS = 5_000;
const DATA_FIELDS = new Set([
  "parameters",
  "schema",
  "configSchema",
  "configJsonSchema",
  "inputSchema",
  "outputSchema",
]);

function settlePluginCall<T>(
  pending: PromiseLike<T>,
  release: () => void | Promise<void>,
): Promise<T> {
  return Promise.resolve(pending).then(
    async (result) => {
      await release();
      return result;
    },
    async (error: unknown) => {
      // Preserve the call's failure; lifecycle observers still receive cleanup failures.
      await release()?.catch(() => {});
      throw error;
    },
  );
}

function pluginMemberDescriptor(object: object, key: PropertyKey) {
  let descriptor: PropertyDescriptor | undefined;
  for (
    let source: object | null = object;
    source && !descriptor;
    source = Object.getPrototypeOf(source)
  ) {
    descriptor = Object.getOwnPropertyDescriptor(source, key);
  }
  return descriptor;
}

function readPluginMember(
  object: object,
  key: PropertyKey,
  invoke: (run: () => unknown) => unknown,
  receiver = object,
): unknown {
  const read = () => Reflect.get(object, key, receiver);
  return pluginMemberDescriptor(object, key)?.get ? invoke(read) : read();
}

export class PluginInstance {
  readonly slots = new Map<string | symbol, { runtime: unknown }>();
  readonly controller = new AbortController();
  readonly lifecycle: PluginInstanceLifecycle;
  sourceDigest?: string;
  private moduleLoader?: (source: string) => unknown;
  private moduleSourceExists?: (source: string) => boolean;
  private accepting = true;
  private readonly calls = new Set<object>();
  private readonly cleanups = new Set<() => void | Promise<void>>();
  private readonly waiters = new Set<() => void>();
  private readonly wrapped = new WeakMap<object, unknown>();
  private readonly originalValues = new WeakMap<object, object>();
  private readonly derivedReceivers = new WeakSet<object>();
  private readonly prototypeReceivers = new WeakMap<object, WeakMap<object, object>>();
  private readonly callbackArguments = new WeakMap<Function, Function>();
  private disposal?: Promise<void>;
  private readonly resources = new PluginInstanceResources(
    this,
    (callback) => this.bindCallback(callback),
    (value) => this.wrapResult(value),
    (run, completed) => {
      const lease = this.lease(false);
      return this.invoke(run, {
        token: lease.token,
        release: () => (completed ? completed.then(lease.release) : lease.release()),
      });
    },
  );
  readonly globals = this.resources.globals;
  readonly owner?: PluginInstanceOwner;

  constructor(
    readonly pluginId: string,
    owner?: { record: PluginRecord; registry: PluginRegistry },
  ) {
    if (owner) {
      this.owner = resolvePluginInstanceOwner(owner.record, owner.registry);
      if (this.owner.instance) {
        throw new Error(`Plugin ${pluginId} already owns a runtime instance`);
      }
      this.owner.instance = this;
    }
    this.lifecycle = Object.freeze({
      signal: this.controller.signal,
      onDispose: (cleanup: () => void | Promise<void>) => {
        if (
          this.controller.signal.aborted ||
          ((!this.accepting || this.owner?.revoked) && !this.activeCall())
        ) {
          throw new Error(`Plugin ${pluginId} is retiring`);
        }
        this.cleanups.add(cleanup);
        return () => void this.cleanups.delete(cleanup);
      },
    });
  }

  private activeCall(scope = invocation.getStore()) {
    return scope?.instance === this && this.calls.has(scope.token) ? scope : undefined;
  }

  run<T>(run: () => T): T {
    const current = this.activeCall();
    if (current) {
      return this.enter(current.token, run);
    }
    if (!this.accepting || this.owner?.revoked) {
      throw new Error(`Plugin ${this.pluginId} was reloaded or disabled; use its current tools.`);
    }
    return this.invoke(run);
  }

  /** Only lifecycle owners may admit teardown after ordinary calls have stopped. */
  runCleanup<T>(run: () => T): T {
    const current = this.activeCall();
    if (current) {
      return this.enter(current.token, run);
    }
    this.controller.signal.throwIfAborted();
    return this.invoke(run);
  }

  private invoke<T>(run: () => T, { token, release } = this.lease()): T {
    try {
      const value = this.enter(token, run);
      if (isPromiseLike(value)) {
        // SAFETY: Promise-like calls retain their resolved value while joining owner cleanup.
        return settlePluginCall(value, release) as T;
      }
      void release();
      return value;
    } catch (error) {
      void release();
      throw error;
    }
  }

  private enter<T>(token: object, run: () => T): T {
    const invoke = () => invocation.run({ instance: this, token }, run);
    if (!this.owner) {
      return invoke();
    }
    const { record } = this.owner;
    const generation = getPluginRuntimeGenerationRegistry();
    // Prepared callers retain their catalog; detached work follows the same
    // instance when publication adopts it into a replacement registry.
    const registry = generation?.plugins.includes(record) ? generation : this.owner.registry;
    return withPluginRuntimeRegistryScope(registry, () =>
      withPluginRuntimePluginScope(
        {
          pluginId: record.id,
          pluginSource: record.source,
          pluginOrigin: record.origin,
          pluginTrustedOfficialInstall: record.trustedOfficialInstall,
        },
        invoke,
      ),
    );
  }

  private lease(joinDisposal = true) {
    const token = {};
    this.calls.add(token);
    return {
      token,
      release: () => {
        this.calls.delete(token);
        this.waiters.forEach((wake) => wake());
        // Earlier borrowers may feed other calls or hand off a stream. Only the
        // last borrower joins disposal; cleanup callbacks cannot await themselves.
        return joinDisposal && this.calls.size === 0 && !this.controller.signal.aborted
          ? this.disposal
          : undefined;
      },
    };
  }

  private wrapResult<T>(result: T): T {
    if (isPromiseLike(result)) {
      // SAFETY: Promise-like results retain their resolved type while callable values stay owned.
      return Promise.resolve(result).then((resolved) => this.wrap(resolved)) as T;
    }
    return this.wrap(result);
  }

  private wrapArguments(args: unknown[], callbackIndex?: 0 | null, field = ""): unknown[] {
    if (callbackIndex === null) {
      return args.map((value) =>
        value && (typeof value === "object" || typeof value === "function")
          ? (this.originalValues.get(value) ?? value)
          : value,
      );
    }
    const callerData =
      callbackIndex === 0 && (field === "reduce" || field === "reduceRight")
        ? args.slice(1, 2)
        : undefined;
    return args.map((value, index) => {
      if (typeof value !== "function" || (callbackIndex !== undefined && index !== callbackIndex)) {
        return value;
      }
      let callback = callerData ? undefined : this.callbackArguments.get(value);
      if (!callback) {
        const invoke = <R>(values: unknown[], run: (values: unknown[]) => R): R =>
          this.run(() =>
            this.invoke(() =>
              run(
                values.map((entry, position) =>
                  position === 0 && callerData?.includes(entry) ? entry : this.wrap(entry),
                ),
              ),
            ),
          );
        // Caller objects and receivers stay native; only values delivered back through callbacks are owned.
        callback = new Proxy(value, {
          apply: (target, receiver, values) =>
            invoke(values, (wrapped) => Reflect.apply(target, receiver, wrapped)),
          construct: (target, values, newTarget) =>
            invoke(values, (wrapped) =>
              Reflect.construct(target, wrapped, newTarget === callback ? target : newTarget),
            ),
        });
        this.originalValues.set(callback, value);
        if (!callerData) {
          this.callbackArguments.set(value, callback);
          this.callbackArguments.set(callback, callback);
        }
      }
      return callback;
    });
  }

  /** Callables retain their instance; schemas remain data for host validators. */
  wrap<T>(value: T, field = "", callbackIndex?: 0 | null): T {
    if ((!value || typeof value !== "object") && typeof value !== "function") {
      return value;
    }
    // Native APIs and structuredClone reject Proxy data, including byte views.
    if (DATA_FIELDS.has(field) || isPluginData(value)) {
      return value;
    }
    const object: object = value;
    const cached = this.wrapped.get(object);
    if (cached) {
      // SAFETY: The cache stores only the view created for this exact input value.
      return cached as T;
    }
    const methods = new Map<PropertyKey, { original: Function; wrapped: unknown }>();
    const derivedFields = new Set<PropertyKey>();
    const resolveReceiver = (key: PropertyKey, receiver: object) => {
      const receivers = this.prototypeReceivers.get(object);
      if (receivers) {
        const original = this.originalValues.get(receiver) ?? receiver;
        return receivers.get(original) ?? original;
      }
      return this.derivedReceivers.has(object) &&
        (!Object.hasOwn(object, key) || derivedFields.has(key))
        ? result
        : object;
    };
    const read = (key: PropertyKey, receiver = object) => {
      const property = readPluginMember(
        object,
        key,
        (run) => this.run(run),
        resolveReceiver(key, receiver),
      );
      if (typeof property !== "function" || key === "constructor") {
        return this.wrap(property, String(key));
      }
      const cachedMethod = methods.get(key);
      if (cachedMethod && cachedMethod.original === property) {
        return cachedMethod.wrapped;
      }
      const bound = this.wrap(
        this.prototypeReceivers.has(object)
          ? new Proxy(property, {
              apply: (target, callReceiver, args) =>
                Reflect.apply(target, resolveReceiver(key, callReceiver), args),
            })
          : Function.prototype.bind.call(property, resolveReceiver(key, receiver)),
        String(key),
        collectionCallbackIndex(object, key),
      );
      this.originalValues.set(bound, property);
      methods.set(key, { original: property, wrapped: bound });
      return bound;
    };
    const handlers: ProxyHandler<object> = {
      get: (target, key, receiver) => {
        const fixed = Object.getOwnPropertyDescriptor(target, key);
        return fixed?.configurable === false && "value" in fixed && !fixed.writable
          ? fixed.value
          : read(key, receiver);
      },
      has: (_target, key) => Reflect.has(object, key),
      // Native instanceof needs original prototype identity; reflection is not a revocation boundary.
      getPrototypeOf: () =>
        this.prototypeReceivers.has(object) ? object : Object.getPrototypeOf(object),
      ownKeys: () => Reflect.ownKeys(object),
      getOwnPropertyDescriptor: (target, key) => {
        const original = Object.getOwnPropertyDescriptor(object, key);
        if (!original) {
          return undefined;
        }
        const configurable = key !== "length" || !Array.isArray(value);
        const fixed = Object.getOwnPropertyDescriptor(target, key);
        if (configurable && fixed?.configurable === false) {
          return "value" in fixed && fixed.writable ? { ...fixed, value: read(key) } : fixed;
        }
        if (!configurable) {
          // Array length is fixed on the target too; otherwise frozen-array reflection throws.
          Object.defineProperty(target, key, original);
        }
        return "value" in original
          ? { ...original, configurable, value: read(key) }
          : {
              ...original,
              configurable,
              get: original.get
                ? bindNativeReceiver((receiver: object) => read(key, receiver))
                : undefined,
              set: original.set
                ? bindNativeReceiver((receiver: object, [next]) =>
                    this.run(() =>
                      Reflect.set(object, key, next, resolveReceiver(key, receiver ?? object)),
                    ),
                  )
                : undefined,
            };
      },
      set: (_target, key, next, receiver) =>
        this.run(() =>
          Reflect.set(
            object,
            key,
            next,
            pluginMemberDescriptor(object, key)?.set ? resolveReceiver(key, receiver) : receiver,
          ),
        ),
      // Freezing only the shadow would invalidate its live original-property projection.
      preventExtensions: () => false,
      defineProperty: (target, key, attributes) =>
        this.run(() => {
          const current = handlers.getOwnPropertyDescriptor!(target, key);
          if (!Reflect.defineProperty(object, key, attributes)) {
            return false;
          }
          derivedFields.add(key);
          // Fixed descriptors must exist on the target, retaining projected plugin methods
          // and the exact identity of any explicitly supplied caller-owned member.
          if (current) {
            Object.defineProperty(target, key, current);
          }
          return Reflect.defineProperty(target, key, attributes);
        }),
      deleteProperty: (_target, key) => this.run(() => Reflect.deleteProperty(object, key)),
    };
    let result: object;
    if (typeof value === "function") {
      const prototype = Object.getOwnPropertyDescriptor(value, "prototype")?.value;
      const receivers =
        prototype && typeof prototype === "object"
          ? (this.prototypeReceivers.get(prototype) ?? new WeakMap<object, object>())
          : undefined;
      if (receivers) {
        this.prototypeReceivers.set(prototype, receivers);
      }
      const invoke = <R>(run: () => R): R => this.run(() => this.wrapResult(run()));
      // A bound target has no fixed static properties, so frozen exports can
      // expose fenced members without violating Proxy descriptor invariants.
      result = new Proxy(Function.prototype.bind.call(value, undefined), {
        ...handlers,
        apply: (_target, receiver, args) =>
          invoke(() =>
            Reflect.apply(value, receiver, this.wrapArguments(args, callbackIndex, field)),
          ),
        construct: (_target, args, newTarget): object =>
          this.run(() => {
            const constructed = Reflect.construct(
              value,
              this.wrapArguments(args, callbackIndex, field),
              newTarget === result ? value : newTarget,
            );
            receivers?.set(this.originalValues.get(constructed) ?? constructed, constructed);
            // Derived private fields are installed on super()'s returned view;
            // base prototype methods still require the original branded receiver.
            if (newTarget !== result) {
              this.derivedReceivers.add(constructed);
            }
            return this.wrap(constructed);
          }),
      });
    } else if (
      typeof readPluginMember(object, Symbol.asyncIterator, (run) => this.run(run)) === "function"
    ) {
      // SAFETY: The iterator factory is verified above; its view preserves the original stream members.
      return this.wrapIterable(object as AsyncIterable<unknown>) as T;
    } else {
      // A view preserves class/private-field receivers and live properties. A plain
      // record copy loses both; proxying a frozen original forbids wrapped methods.
      result = new Proxy(
        Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(object)),
        handlers,
      );
    }
    this.wrapped.set(object, result);
    this.wrapped.set(result, result);
    this.originalValues.set(result, object);
    valueInstances.set(result, this);
    // SAFETY: The view retains the input prototype and routes each member to the original object.
    return result as T;
  }

  private wrapIterable(source: AsyncIterable<unknown>): AsyncIterable<unknown> {
    const { token, release } = this.run(() => this.lease());
    let active = true;
    let iterating = 0;
    // Stream helpers and queued protocol calls keep their admitted token until
    // their promises and protocol result inspection have both settled.
    let pendingOperations = 0;
    let consumerSettled = false;
    let terminalSettled = true;
    let completion: Promise<void> | undefined;
    const finish = () => {
      if (active) {
        active = false;
        completion = release();
      }
      return completion;
    };
    const finishWhenSettled = () => {
      if (consumerSettled && terminalSettled && pendingOperations === 0) {
        return finish();
      }
      return undefined;
    };
    const releaseOperation = () => {
      pendingOperations -= 1;
      return finishWhenSettled();
    };
    const invoke = <T>(run: () => T): T => {
      if (!active || !this.calls.has(token)) {
        throw new Error(`Plugin ${this.pluginId} stream is closed`);
      }
      pendingOperations += 1;
      return this.invoke(run, { token, release: releaseOperation });
    };
    const callHelper = (receiver: object, key: PropertyKey, method: Function, args: unknown[]) =>
      invoke(() => {
        const input = this.wrapArguments(args, collectionCallbackIndex(receiver, key), String(key));
        return this.wrapResult(Reflect.apply(method, receiver, input));
      });
    // EventStream consumers commonly await result() after iteration has ended.
    // Capture that terminal promise while admitted; later reads execute no plugin code.
    let terminal: Promise<unknown> | undefined;
    try {
      const resultMethod = readPluginMember(source, "result", invoke);
      terminal =
        typeof resultMethod === "function"
          ? Promise.resolve(invoke(() => this.wrapResult(Reflect.apply(resultMethod, source, []))))
          : undefined;
    } catch (error) {
      void finish();
      throw error;
    }
    if (terminal) {
      terminalSettled = false;
      const settle = () => {
        terminalSettled = true;
        return finishWhenSettled();
      };
      terminal = settlePluginCall(terminal, settle);
      void terminal.catch(() => {});
    }
    const iterators = new WeakMap<object, object>();
    const wrapIterator = (iterator: AsyncIterator<unknown> | AsyncIterable<unknown>) => {
      const cached = iterators.get(iterator);
      if (cached) {
        return cached;
      }
      iterating += 1;
      consumerSettled = false;
      let done = false;
      const completedReturn = async (value: unknown) => ({ done: true, value: await value });
      const settle = () => {
        if (!done) {
          done = true;
          if (--iterating === 0) {
            consumerSettled = true;
          }
        }
      };
      const view: object = new Proxy(Object.create(Object.getPrototypeOf(iterator)), {
        get: (_item, method) => {
          if (method === Symbol.asyncIterator) {
            return () => view;
          }
          // Completed return is protocol cleanup, not renewed plugin admission.
          if (method === "return" && done) {
            return completedReturn;
          }
          const value = readPluginMember(iterator, method, invoke);
          if (typeof value !== "function") {
            return this.wrap(value, String(method));
          }
          // Helper results keep their own return shape; only protocol methods finish iteration.
          if (method !== "next" && method !== "return" && method !== "throw") {
            return (...args: unknown[]) => callHelper(iterator, method, value, args);
          }
          return async (...args: unknown[]) => {
            if (method === "return" && done) {
              return completedReturn(args[0]);
            }
            return invoke(async () => {
              try {
                const next: IteratorResult<unknown> = await this.wrapResult(
                  Reflect.apply(value, iterator, args),
                );
                if (invoke(() => next?.done)) {
                  settle();
                }
                return next;
              } catch (error) {
                settle();
                throw error;
              }
            });
          };
        },
      });
      iterators.set(iterator, view);
      valueInstances.set(view, this);
      return view;
    };
    const result = new Proxy<AsyncIterable<unknown>>(Object.create(Object.getPrototypeOf(source)), {
      get: (_target, key) => {
        if (key === Symbol.asyncIterator) {
          return () => wrapIterator(invoke(() => source[Symbol.asyncIterator]()));
        }
        if (key === "result" && terminal) {
          return () =>
            settlePluginCall(terminal, () => {
              if (iterating === 0) {
                consumerSettled = true;
                return finishWhenSettled();
              }
              return undefined;
            });
        }
        const iterator = iterators.get(source);
        if (key === "return" && iterator) {
          return Reflect.get(iterator, key);
        }
        const value = readPluginMember(source, key, invoke);
        if (typeof value !== "function") {
          return this.wrap(value, String(key));
        }
        if (key === "next" || key === "return" || key === "throw") {
          return Reflect.get(wrapIterator(source), key);
        }
        return (...args: unknown[]) => callHelper(source, key, value, args);
      },
    });
    this.wrapped.set(source, result);
    this.wrapped.set(result, result);
    valueInstances.set(result, this);
    return result;
  }

  bindModuleLoader(
    load: (source: string) => unknown,
    hasSource?: (source: string) => boolean,
  ): void {
    if (this.moduleLoader) {
      throw new Error(`Plugin ${this.pluginId} already owns its module loader`);
    }
    this.moduleLoader = load;
    this.moduleSourceExists = hasSource;
  }

  loadModule(source: string): unknown {
    return this.run(() => {
      if (!this.moduleLoader) {
        throw new Error(`Plugin ${this.pluginId} has no captured module loader`);
      }
      return this.wrap(this.moduleLoader(source));
    });
  }

  hasModuleSource(source: string): boolean | undefined {
    return this.moduleSourceExists?.(source);
  }

  private bindCallback(callback: Function): (...args: unknown[]) => unknown {
    const admitted = invocation.getStore();
    return bindNativeReceiver((receiver: unknown, args) => {
      const active = this.activeCall() ?? this.activeCall(admitted);
      if (!active && (this.controller.signal.aborted || !this.accepting || this.owner?.revoked)) {
        return undefined;
      }
      const scoped = (value: unknown) =>
        value && typeof value === "object" && typeof Reflect.get(value, "on") === "function"
          ? this.resources.wrapEmitter(value)
          : value;
      // Native emitters do not await callbacks; their promises must outlive the admitting parent.
      return this.invoke(() => Reflect.apply(callback, scoped(receiver), args.map(scoped)));
    });
  }

  loadBuiltin(specifier: string, load: (specifier: string) => unknown): unknown {
    return this.resources.loadBuiltin(specifier, load);
  }

  prepareGlobals(load: (specifier: string) => unknown): Record<string, unknown> {
    return this.resources.prepareGlobals(load);
  }

  quiesce(): boolean {
    const accepting = this.accepting;
    this.accepting = false;
    return accepting;
  }

  drain(): Promise<void> {
    this.quiesce();
    return this.waitForCalls(this.activeCall()?.token);
  }

  private async waitForCalls(ownToken?: object): Promise<void> {
    const settled = () => [...this.calls].every((token) => token === ownToken);
    if (settled()) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(wake);
        reject(
          new Error(
            `Plugin ${this.pluginId} still has active calls after ${SHUTDOWN_TIMEOUT_MS}ms`,
          ),
        );
      }, SHUTDOWN_TIMEOUT_MS);
      const wake = () => {
        if (settled()) {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        }
      };
      this.waiters.add(wake);
    });
  }

  resume(): void {
    if (!this.disposal && !this.controller.signal.aborted && !this.owner?.revoked) {
      this.accepting = true;
    }
  }

  dispose(beforeCleanup?: () => void | Promise<void>): Promise<void> {
    if (beforeCleanup && this.disposal) {
      return Promise.reject(new Error(`Plugin ${this.pluginId} disposal already started`));
    }
    if (!this.disposal) {
      this.quiesce();
      this.disposal = this.finishDisposal(beforeCleanup);
      // Self-retirement is joined by the last returning call or stream.
      void this.disposal.catch(() => {});
    }
    return this.activeCall() ? Promise.resolve() : this.disposal;
  }

  private async finishDisposal(beforeCleanup?: () => void | Promise<void>): Promise<void> {
    if (this.owner) {
      this.owner.revoked = true;
    }
    const failures: unknown[] = [];
    let deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    try {
      await this.waitForCalls();
    } catch (error) {
      failures.push(error);
    }
    // Retirement is final even when a borrower fails to drain. Revoke its
    // tokens before cleanup; only newly admitted cleanup callbacks may finish.
    this.calls.clear();
    if (beforeCleanup) {
      // Legacy host hooks own their individual bounds; resource cleanup must join
      // those hooks before applying its separate instance cleanup budget.
      try {
        // Their resources are still live; this internal lease cannot join the
        // disposal promise that is itself waiting for these hooks to finish.
        await this.invoke(beforeCleanup, this.lease(false));
      } catch (error) {
        failures.push(error);
      }
      deadline = Date.now() + SHUTDOWN_TIMEOUT_MS;
    }
    const reason = new Error(`Plugin ${this.pluginId} is retiring`);
    this.resources.beginDisposal(reason);
    this.controller.abort(reason);
    for (const cleanup of Array.from(this.cleanups).toReversed()) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.invoke(cleanup),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Plugin ${this.pluginId} cleanup did not settle`)),
              Math.max(0, deadline - Date.now()),
            );
          }),
        ]);
      } catch (error) {
        failures.push(error);
      } finally {
        clearTimeout(timer);
      }
    }
    this.cleanups.clear();
    this.calls.clear();
    this.waiters.forEach((wake) => wake());
    this.resources.clear();
    this.moduleLoader = undefined;
    this.slots.clear();
    if (failures.length) {
      throw new AggregateError(failures, `Plugin ${this.pluginId} cleanup failed`);
    }
  }
}
