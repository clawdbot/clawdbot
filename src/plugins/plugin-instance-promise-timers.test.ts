import { createHook } from "node:async_hooks";
import { createRequire } from "node:module";
import type * as NativeTimers from "node:timers";
import * as nativeTimers from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { PluginInstance } from "./plugin-instance.js";

const require = createRequire(import.meta.url);
type TimerApi = "setTimeout" | "setImmediate" | "setInterval" | "scheduler.wait";
const timerApis: TimerApi[] = ["setTimeout", "setImmediate", "setInterval", "scheduler.wait"];

function invokeTimer(
  timers: typeof nativeTimers,
  api: TimerApi,
  options: unknown,
  timeout = 1,
): unknown {
  if (api === "scheduler.wait") {
    // oxlint-disable-next-line typescript/unbound-method -- Reflect.apply supplies Node's scheduler receiver.
    return Reflect.apply(timers.scheduler.wait, timers.scheduler, [timeout, options]);
  }
  return Reflect.apply(
    timers[api],
    timers,
    api === "setImmediate" ? ["value", options] : [timeout, "value", options],
  );
}

function errorShape(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, code: "code" in error ? error.code : undefined }
    : { thrown: error };
}

async function observeTimer(
  timers: typeof nativeTimers,
  api: TimerApi,
  makeOptions: (trace: string[]) => unknown,
) {
  const trace: string[] = [];
  let value: unknown;
  try {
    value = invokeTimer(timers, api, makeOptions(trace));
  } catch (error) {
    return { phase: "call", error: errorShape(error), traceAtCall: [...trace] };
  }
  const traceAtCall = [...trace];
  // SAFETY: This branch invokes Node's setInterval, whose public result is an async iterator.
  const iterator = api === "setInterval" ? (value as AsyncIterator<unknown>) : undefined;
  try {
    const result = iterator ? await iterator.next() : await value;
    return { phase: iterator ? "next-resolved" : "resolved", result, traceAtCall, trace };
  } catch (error) {
    return {
      phase: iterator ? "next-rejected" : "rejected",
      error: errorShape(error),
      traceAtCall,
      trace,
    };
  } finally {
    await iterator?.return?.();
  }
}

function loadOwnedTimers(instance: PluginInstance) {
  // SAFETY: The managed builtin preserves Node's public promise timer namespace.
  return instance.loadBuiltin("node:timers/promises", require) as typeof nativeTimers;
}

const invalidOptions: Array<{ name: string; create: (trace: string[]) => unknown }> = [
  { name: "null options", create: () => null },
  { name: "false options", create: () => false },
  { name: "truthy invalid options", create: () => "invalid" },
  { name: "array options", create: () => [] },
  { name: "false signal", create: () => ({ signal: false }) },
  { name: "null signal", create: () => ({ signal: null }) },
  { name: "truthy invalid signal", create: () => ({ signal: "invalid" }) },
  { name: "invalid ref", create: () => ({ ref: "invalid" }) },
  {
    name: "throwing signal getter",
    create: (trace) => ({
      get signal() {
        trace.push("signal");
        throw new Error("signal getter failed");
      },
    }),
  },
];

function propertyOptions(
  placement: "inherited" | "nonenumerable",
  values: Record<string, unknown>,
) {
  if (placement === "inherited") {
    return Object.create(values);
  }
  return Object.defineProperties(
    {},
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
  );
}

const placements = ["inherited", "nonenumerable"] as const;

describe("managed promise timer native contracts", () => {
  it.each(timerApis)(
    "%s can finish inside lifecycle cleanup without an explicit signal",
    async (api) => {
      const instance = new PluginInstance("promise-timer-cleanup");
      const timers = loadOwnedTimers(instance);
      const expected = await observeTimer(nativeTimers, api, () => undefined);
      let observed: unknown;
      instance.lifecycle.onDispose(async () => {
        observed = await observeTimer(timers, api, () => undefined);
      });
      await instance.dispose();
      expect(observed).toEqual(expected);
    },
  );

  it.each(timerApis)(
    "%s preserves an explicit aborted lifecycle signal during cleanup",
    async (api) => {
      const instance = new PluginInstance("promise-timer-explicit-cleanup-signal");
      const timers = loadOwnedTimers(instance);
      instance.lifecycle.onDispose(async () => {
        const value = invokeTimer(timers, api, { signal: instance.lifecycle.signal });
        // SAFETY: This branch invokes Node's interval API, whose result is an async iterator.
        const iterator = api === "setInterval" ? (value as AsyncIterator<unknown>) : undefined;
        try {
          await expect(iterator ? iterator.next() : value).rejects.toMatchObject({
            name: "AbortError",
            cause: instance.lifecycle.signal.reason,
          });
        } finally {
          await iterator?.return?.();
        }
      });
      await instance.dispose();
    },
  );

  it.each(
    timerApis.flatMap((api) => invalidOptions.map(({ name, create }) => ({ api, name, create }))),
  )("$api preserves native validation and timing for $name", async ({ api, create }) => {
    const instance = new PluginInstance("promise-timer-validation");
    try {
      const native = await observeTimer(nativeTimers, api, create);
      const owned = await observeTimer(loadOwnedTimers(instance), api, create);
      expect(owned).toEqual(native);
      expect(native.phase).toBe(api === "setInterval" ? "next-rejected" : "rejected");
    } finally {
      await instance.dispose();
    }
  });

  it.each(timerApis.flatMap((api) => placements.map((placement) => ({ api, placement }))))(
    "$api preserves $placement signal properties",
    async ({ api, placement }) => {
      const instance = new PluginInstance("promise-timer-signal");
      const options = () =>
        propertyOptions(placement, { signal: AbortSignal.abort("owner-requested") });
      try {
        expect(await observeTimer(loadOwnedTimers(instance), api, options)).toEqual(
          await observeTimer(nativeTimers, api, options),
        );
      } finally {
        await instance.dispose();
      }
    },
  );

  it.each(timerApis.flatMap((api) => placements.map((placement) => ({ api, placement }))))(
    "$api preserves $placement ref false in the native handle",
    async ({ api, placement }) => {
      const observations: boolean[][] = [];
      for (const mode of ["native", "owned"]) {
        const instance = new PluginInstance("promise-timer-ref");
        const timers = mode === "native" ? nativeTimers : loadOwnedTimers(instance);
        const controller = new AbortController();
        const hasRefs: Array<() => unknown> = [];
        const hook = createHook({
          init(_id, type, _trigger, resource) {
            if (type === "Timeout" || type === "Immediate") {
              const hasRef = Reflect.get(resource, "hasRef");
              if (typeof hasRef === "function") {
                hasRefs.push(() => Reflect.apply(hasRef, resource, []));
              }
            }
          },
        });
        let iterator: AsyncIterator<unknown> | undefined;
        let pending: Promise<unknown> | undefined;
        try {
          hook.enable();
          const value = invokeTimer(
            timers,
            api,
            propertyOptions(placement, { ref: false, signal: controller.signal }),
            60_000,
          );
          // SAFETY: The selected native interval operation returns an async iterator.
          iterator = api === "setInterval" ? (value as AsyncIterator<unknown>) : undefined;
          pending = Promise.resolve(iterator ? iterator.next() : value).catch(() => {});
          hook.disable();
          observations.push(hasRefs.map((hasRef) => hasRef() === true));
        } finally {
          hook.disable();
          controller.abort();
          await instance.dispose();
          await pending;
          await iterator?.return?.();
        }
      }
      expect(observations[0]).toEqual([false]);
      expect(observations[1]).toEqual(observations[0]);
    },
  );

  it.each(["direct-first", "alias-first"])(
    "shares the owned promises facade when loaded %s",
    async (order) => {
      const instance = new PluginInstance("promise-timer-alias");
      try {
        const direct = order === "direct-first" ? loadOwnedTimers(instance) : undefined;
        // SAFETY: The managed builtin preserves Node's public callback timer namespace.
        const callbacks = instance.loadBuiltin("node:timers", require) as typeof NativeTimers;
        expect(callbacks.promises).toBe(direct ?? loadOwnedTimers(instance));
      } finally {
        await instance.dispose();
      }
    },
  );

  it("aborts pending promise timers reached through the callback namespace", async () => {
    const instance = new PluginInstance("promise-timer-alias-retirement");
    const controller = new AbortController();
    // SAFETY: The managed builtin preserves Node's public callback timer namespace.
    const callbacks = instance.loadBuiltin("node:timers", require) as typeof NativeTimers;
    let result: unknown;
    const pending = callbacks.promises
      .setTimeout(60_000, "pending", { signal: controller.signal })
      .then(
        (value) => {
          result = { value };
        },
        (error: unknown) => {
          result = errorShape(error);
        },
      );
    try {
      await instance.dispose();
      await nativeTimers.setTimeout(5);
      expect(result).toMatchObject({ name: "AbortError" });
    } finally {
      controller.abort();
      await pending;
      await instance.dispose();
    }
  });

  it("fences promise timer acquisition through the callback namespace", async () => {
    const instance = new PluginInstance("promise-timer-alias-admission");
    // SAFETY: The managed builtin preserves Node's public callback timer namespace.
    const callbacks = instance.loadBuiltin("node:timers", require) as typeof NativeTimers;
    let pending: Promise<unknown> | undefined;
    try {
      instance.quiesce();
      expect(() => {
        pending = callbacks.promises.setTimeout(1);
      }).toThrow(/reloaded|disabled|retiring/);
    } finally {
      await pending;
      await instance.dispose();
    }
  });
});
