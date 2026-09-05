import * as promiseTimers from "node:timers/promises";
import { promisify } from "node:util";
import { composePluginSignalOptions } from "./plugin-instance-signal-options.js";
import type { PluginInstanceAdmission } from "./plugin-instance.types.js";

type TimerCleanup = (operation?: "settled" | "cancel") => void;

/** Timer acquisition is admitted synchronously; retirement aborts the scheduled lifetime. */
export class PluginInstanceTimers {
  private readonly timerCleanups = new Map<object | string, TimerCleanup>();
  private cancellation = new AbortController();

  constructor(
    private readonly instance: PluginInstanceAdmission,
    private readonly callback: (callback: Function) => (...args: unknown[]) => unknown,
  ) {
    for (const key of ["setTimeout", "setImmediate"] as const) {
      Object.defineProperty(this.globals[key], promisify.custom, {
        value: (...args: unknown[]) => this.promiseTimer(key, args),
      });
    }
  }

  private promiseTimer(key: string, args: unknown[]): unknown {
    // Admit creation, not the timer's lifetime: retirement must be able to abort it.
    return this.instance.run(() => {
      const index = key === "setImmediate" ? 1 : 2;
      args[index] = this.timerOptions(args[index]);
      return { timer: Reflect.apply(Reflect.get(promiseTimers, key), promiseTimers, args) };
    }).timer;
  }

  private timerOptions(options: unknown = {}) {
    return composePluginSignalOptions(this.cancellation.signal, options);
  }

  promises(): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of ["setTimeout", "setImmediate", "setInterval"]) {
      result[key] = (...args: unknown[]) => this.promiseTimer(key, args);
    }
    const instance = this.instance;
    const timerOptions = this.timerOptions.bind(this);
    result.scheduler = Object.assign(Object.create(promiseTimers.scheduler), {
      wait(
        this: typeof promiseTimers.scheduler,
        delay: number,
        options?: Parameters<typeof promiseTimers.scheduler.wait>[1],
      ) {
        return instance.run(() => ({
          // Preserve native option validation while binding the caller's scheduler receiver.
          timer: Reflect.apply(promiseTimers.scheduler.wait.bind(this), undefined, [
            delay,
            timerOptions(options),
          ]),
        })).timer;
      },
      yield(this: typeof promiseTimers.scheduler) {
        // Native yield has no delay/signal: drain joins its single event-loop
        // turn while retaining Node's private receiver validation.
        return instance.run(() => promiseTimers.scheduler.yield.call(this));
      },
    });
    return result;
  }

  private callbackTimer<T extends object>(
    create: () => T,
    callback: Function,
    cancel: (handle: T) => void,
    repeat = false,
  ): T {
    return this.instance.run(() => {
      // Node validates the original callback and coerces delay before ownership
      // wraps its native callback slot; dispatch cannot occur in this same turn.
      const handle = create();
      const invoke = this.callback(callback);
      const callbackKey = Object.hasOwn(handle, "_onTimeout") ? "_onTimeout" : "_onImmediate";
      const remove = this.retainTimer(handle, () => cancel(handle), callbackKey);
      Reflect.set(handle, callbackKey, function (this: T, ...args: unknown[]) {
        if (!repeat) {
          remove();
        }
        Reflect.apply(invoke, this, args);
      });
      return handle;
    });
  }

  private retainTimer(
    handle: object,
    cancel: () => void,
    callbackKey: "_onTimeout" | "_onImmediate",
  ): () => void {
    let id: string | undefined;
    const release: TimerCleanup = (operation) => {
      if (operation === "cancel") {
        cancel();
      }
      // Node nulls its callback on cancellation; a missing numeric ID is a
      // native no-op and must not release an otherwise live timer's cleanup.
      if (operation === undefined && Reflect.get(handle, callbackKey) !== null) {
        return;
      }
      this.timerCleanups.delete(handle);
      if (id !== undefined) {
        this.timerCleanups.delete(id);
      }
    };
    const retain = () => {
      this.timerCleanups.set(handle, release);
      if (id !== undefined) {
        this.timerCleanups.set(id, release);
      }
    };
    retain();
    for (const key of ["refresh", "close", Symbol.dispose, Symbol.toPrimitive]) {
      const method = Reflect.get(handle, key);
      if (typeof method !== "function") {
        continue;
      }
      const invoke = (args: unknown[]) => {
        const result = Reflect.apply(method, handle, args);
        if (key === Symbol.toPrimitive) {
          // Node registers only its first primitive ID. Never coerce eagerly:
          // that changes registration after a naturally fired timer is refreshed.
          id ??= String(result);
          if (this.timerCleanups.has(handle)) {
            this.timerCleanups.set(id, release);
          }
        } else if (key === "refresh") {
          if (Reflect.get(handle, callbackKey) !== null && !this.timerCleanups.has(handle)) {
            retain();
          }
        } else {
          release();
        }
        return result;
      };
      Object.defineProperty(handle, key, {
        configurable: true,
        writable: true,
        value: (...args: unknown[]) =>
          key === "refresh" ? this.instance.run(() => invoke(args)) : invoke(args),
      });
    }
    return () => release("settled");
  }

  private releaseTimer(handle: object | string | number | undefined): void {
    if (handle !== undefined) {
      this.timerCleanups.get(typeof handle === "number" ? String(handle) : handle)?.();
    }
  }

  beginDisposal(reason: unknown): void {
    this.clear(reason);
    this.cancellation = new AbortController();
  }

  clear(reason: unknown): void {
    this.cancellation.abort(reason);
    for (const cleanup of this.timerCleanups.values()) {
      cleanup("cancel");
    }
  }

  readonly globals = {
    setTimeout: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      this.callbackTimer(() => setTimeout(callback, delay, ...args), callback, clearTimeout),
    clearTimeout: (handle: Parameters<typeof clearTimeout>[0]) => {
      clearTimeout(handle);
      this.releaseTimer(handle);
    },
    setInterval: (callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) =>
      this.callbackTimer(
        () => setInterval(callback, delay, ...args),
        callback,
        clearInterval,
        true,
      ),
    clearInterval: (handle: Parameters<typeof clearInterval>[0]) => {
      clearInterval(handle);
      this.releaseTimer(handle);
    },
    setImmediate: (callback: (...args: unknown[]) => void, ...args: unknown[]) =>
      this.callbackTimer(() => setImmediate(callback, ...args), callback, clearImmediate),
    clearImmediate: (handle: Parameters<typeof clearImmediate>[0]) => {
      clearImmediate(handle);
      this.releaseTimer(handle);
    },
  };
}
