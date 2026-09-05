import { createRequire } from "node:module";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { PluginInstance } from "./plugin-instance.js";

const require = createRequire(import.meta.url);

describe("native callback invocation ownership", () => {
  it.each(["current", "captured"] as const)(
    "joins an async listener after its %s parent admission finishes",
    async (admission) => {
      const instance = new PluginInstance(`callback-${admission}`);
      const facade = instance.prepareGlobals(require).process as NodeJS.Process;
      const event = `openclaw-callback-ownership-${admission}`;
      const started = createDeferredCore();
      const release = createDeferredCore();
      const finished = createDeferredCore();
      const releaseParent = createDeferredCore();
      const helper = instance.wrap(() => "callback completed");
      let result: unknown;
      const listener = async () => {
        started.resolve();
        await release.promise;
        try {
          await new Promise<void>((resolve) => {
            instance.globals.setImmediate(() => resolve());
          });
          result = helper();
        } catch (error) {
          result = error;
        } finally {
          finished.resolve();
        }
      };
      const parent = instance.run(async () => {
        // oxlint-disable-next-line typescript/no-misused-promises -- Exercise Node's promise-returning listeners so disposal must join their completion.
        facade.on(event, listener);
        if (admission === "current") {
          facade.emit(event);
        }
        await releaseParent.promise;
      });
      if (admission === "captured") {
        instance.quiesce();
        process.emit(event);
      }
      await started.promise;
      let disposed = false;
      const disposal = instance.dispose().then(() => {
        disposed = true;
      });
      releaseParent.resolve();
      try {
        await yieldImmediate();
        expect(disposed, "retirement finished before its admitted async listener").toBe(false);
        release.resolve();
        await finished.promise;
        await Promise.all([parent, disposal]);
        expect(result).toBe("callback completed");
        expect(instance.lifecycle.signal.aborted).toBe(true);
      } finally {
        releaseParent.resolve();
        release.resolve();
        await Promise.allSettled([parent, disposal, finished.promise]);
        expect(process.listeners(event)).toHaveLength(0);
      }
    },
  );
});

describe("plugin values delivered through caller callbacks", () => {
  it.each(["array", "map", "set", "map-callback", "reduce", "exported-function"] as const)(
    "fences callable values delivered by %s after retirement",
    async (surface) => {
      const instance = new PluginInstance(`collection-${surface}`);
      const handler = () => "current";
      const retained: Array<() => string> = [];
      class Receiver {
        #label = "caller receiver";
        read() {
          return this.#label;
        }
      }
      const receiver = new Receiver();
      const collect = function (this: Receiver, value: () => string, key?: unknown) {
        expect(this).toBe(receiver);
        expect(this.read()).toBe("caller receiver");
        retained.push(value);
        if (typeof key === "function") {
          retained.push(key as () => string);
        }
        return value;
      };
      try {
        if (surface === "map") {
          instance.wrap(new Map([[handler, handler]])).forEach(collect, receiver);
        } else if (surface === "set") {
          instance.wrap(new Set([handler])).forEach(collect, receiver);
        } else if (surface === "exported-function") {
          const deliver = instance.wrap((callback: typeof collect, target: Receiver) => {
            callback.call(target, handler);
          });
          deliver(collect, receiver);
        } else {
          const collection = instance.wrap([handler]);
          if (surface === "map-callback") {
            collection.map(collect, receiver);
          } else if (surface === "reduce") {
            collection.reduce((_previous, value) => collect.call(receiver, value), handler);
          } else {
            collection.forEach(collect, receiver);
          }
        }
        expect(retained.length).toBeGreaterThan(0);
        for (const callback of retained) {
          expect(callback()).toBe("current");
        }
        await instance.dispose();
        for (const callback of retained) {
          expect(() => callback()).toThrow("reloaded or disabled");
        }
      } finally {
        await instance.dispose();
      }
    },
  );

  it("preserves caller callback identity for registration and removal", async () => {
    const instance = new PluginInstance("callback-identity");
    const listeners = new Set<() => void>();
    const subscription = instance.wrap({
      on(callback: () => void) {
        listeners.add(callback);
      },
      off(callback: () => void) {
        listeners.delete(callback);
      },
      emit() {
        for (const listener of listeners) {
          listener();
        }
      },
    });
    let calls = 0;
    const callback = () => {
      calls += 1;
    };
    try {
      subscription.on(callback);
      subscription.emit();
      subscription.off(callback);
      subscription.emit();
      expect(calls).toBe(1);
    } finally {
      await instance.dispose();
    }
  });
});

describe("native collection data argument identity", () => {
  it.each(
    (["map", "set", "array"] as const).flatMap((collection) =>
      (["raw", "member", "callback"] as const).flatMap((acquisition) =>
        (["host", "VM"] as const).map((realm) => ({ collection, acquisition, realm })),
      ),
    ),
  )(
    "preserves $realm $collection callable data acquired through $acquisition",
    async ({ collection, acquisition, realm }) => {
      const instance = new PluginInstance(`data-${collection}-${acquisition}`);
      const original = () => "original";
      const replacement = () => "replacement";
      let key = original;
      try {
        if (collection === "map") {
          const source: Map<() => string, () => string> =
            realm === "host"
              ? new Map([[original, () => "value"]])
              : runInNewContext('new Map([[original, () => "value"]])', { original });
          const view = instance.wrap(source);
          if (acquisition === "member") {
            key = view.keys().next().value!;
          } else if (acquisition === "callback") {
            view.forEach((_value, candidate) => {
              key = candidate;
            });
          }
          expect(view.has(key)).toBe(true);
          expect(view.get(key)!()).toBe("value");
          expect(view.set(key, replacement)).toBe(view);
          expect(source.size).toBe(1);
          expect(source.get(original)).toBe(replacement);
          expect(view.get(key)!()).toBe("replacement");
          expect(view.delete(key)).toBe(true);
          expect(source.size).toBe(0);
        } else if (collection === "set") {
          const source: Set<() => string> =
            realm === "host"
              ? new Set([original])
              : runInNewContext("new Set([original])", { original });
          const view = instance.wrap(source);
          if (acquisition === "member") {
            key = view.values().next().value!;
          } else if (acquisition === "callback") {
            view.forEach((candidate) => {
              key = candidate;
            });
          }
          expect(view.has(key)).toBe(true);
          expect(view.add(key)).toBe(view);
          expect(source.size).toBe(1);
          view.add(replacement);
          expect(source.has(replacement)).toBe(true);
          expect(view.delete(key)).toBe(true);
          expect(source.has(original)).toBe(false);
          expect(view.delete(replacement)).toBe(true);
        } else {
          const source: Array<() => string> =
            realm === "host" ? [original] : runInNewContext("[original]", { original });
          const view = instance.wrap(source);
          if (acquisition === "member") {
            key = view[0]!;
          } else if (acquisition === "callback") {
            view.forEach((candidate) => {
              key = candidate;
            });
          }
          expect(view.includes(key)).toBe(true);
          expect(view.indexOf(key)).toBe(0);
          view.push(replacement);
          expect(source[1]).toBe(replacement);
          expect(view.includes(view[1]!)).toBe(true);
          view.splice(0, 1, replacement);
          expect(source[0]).toBe(replacement);
        }
      } finally {
        await instance.dispose();
      }
    },
  );

  it("keeps the caller's reduce accumulator while fencing collection arguments", async () => {
    const instance = new PluginInstance("reduce-data");
    const accumulator = () => "caller accumulator";
    const view = instance.wrap([() => "plugin element"]);
    let retained = view;
    try {
      const result = view.reduce((current, element, index, collection) => {
        expect(current).toBe(accumulator);
        expect(element()).toBe("plugin element");
        expect(index).toBe(0);
        retained = collection;
        return current;
      }, accumulator);
      expect(result()).toBe("caller accumulator");
      await instance.dispose();
      expect(() => retained.forEach(() => {})).toThrow("reloaded or disabled");
      expect(accumulator()).toBe("caller accumulator");
    } finally {
      await instance.dispose();
    }
  });
});

describe("native collection method ownership", () => {
  it("keeps subclass overrides on their plugin callback contract", async () => {
    type Handler = () => string;
    type Visitor = (handler: Handler) => Handler;
    class CallbackMap extends Map<Visitor, Handler> {
      #handler = () => "private handler";
      override get(visit: Visitor) {
        return visit(this.#handler);
      }
    }
    const instance = new PluginInstance("collection-override");
    const view = instance.wrap(new CallbackMap([[(handler) => handler, () => "stored handler"]]));
    let retained: Handler | undefined;
    try {
      view.get((handler) => {
        retained = handler;
        return handler;
      });
      expect(retained?.()).toBe("private handler");
      await instance.dispose();
      expect(() => retained!()).toThrow("reloaded or disabled");
    } finally {
      await instance.dispose();
    }
  });

  it.each(["map", "set"] as const)("round-trips callable keys through a weak %s", async (kind) => {
    const instance = new PluginInstance(`weak-${kind}`);
    const key = () => "key";
    const source = kind === "map" ? new WeakMap([[key, "value"]]) : new WeakSet([key]);
    const view = instance.wrap(source);
    try {
      expect(view.has(key)).toBe(true);
      expect(view.has(instance.wrap(key))).toBe(true);
      expect(view.delete(instance.wrap(key))).toBe(true);
      expect(source.has(key)).toBe(false);
    } finally {
      await instance.dispose();
    }
  });
});

describe("async iterable helper callbacks", () => {
  it.each(
    (["source", "iterator"] as const).flatMap((target) =>
      (["retained", "async"] as const).map((lifetime) => ({ target, lifetime })),
    ),
  )("owns $lifetime callback values from a $target helper", async ({ target, lifetime }) => {
    const instance = new PluginInstance(`iterable-${target}-${lifetime}`);
    const release = createDeferredCore();
    const finished = createDeferredCore();
    class Visitor {
      #handler = () => "private helper value";
      visit(callback: (handler: () => string) => unknown) {
        callback(this.#handler);
      }
    }
    const iterator = Object.assign(new Visitor(), {
      next: async () => ({ done: true as const, value: undefined }),
      return: async () => ({ done: true as const, value: undefined }),
    });
    const stream = instance.wrap(
      Object.assign(new Visitor(), {
        [Symbol.asyncIterator]: () => iterator,
      }),
    );
    const view = stream[Symbol.asyncIterator]();
    const helper = target === "source" ? stream : view;
    let retained: (() => string) | undefined;
    let answer: unknown;
    let disposal: Promise<void> | undefined;
    try {
      helper.visit(
        lifetime === "retained"
          ? (handler) => {
              retained = handler;
              expect(handler()).toBe("private helper value");
            }
          : async (handler) => {
              try {
                await release.promise;
                answer = handler();
              } catch (error) {
                answer = error;
              } finally {
                finished.resolve();
              }
            },
      );
      await view.next();
      let disposed = false;
      disposal = instance.dispose().then(() => {
        disposed = true;
      });
      if (lifetime === "retained") {
        await disposal;
        expect(() => retained!()).toThrow("reloaded or disabled");
      } else {
        await yieldImmediate();
        expect(disposed, "stream completion retired an admitted helper callback").toBe(false);
        release.resolve();
        await finished.promise;
        await disposal;
        expect(answer).toBe("private helper value");
      }
    } finally {
      release.resolve();
      await view.return();
      await (disposal ?? instance.dispose());
      if (lifetime === "async") {
        await finished.promise;
      }
    }
  });

  it("preserves native lookup keys on an async iterable Map", async () => {
    class StreamMap extends Map<() => string, string> {
      async *[Symbol.asyncIterator]() {
        yield "complete";
      }
    }
    const instance = new PluginInstance("iterable-map");
    const key = () => "key";
    const stream = instance.wrap(new StreamMap([[key, "value"]]));
    const iterator = stream[Symbol.asyncIterator]();
    try {
      expect(stream.get(key)).toBe("value");
    } finally {
      await iterator.return(undefined);
      await instance.dispose();
    }
  });
});

describe("collection data classification", () => {
  it.each(
    (["map", "set", "array"] as const).flatMap((kind) =>
      (["host", "VM"] as const).flatMap((realm) =>
        (["own", "subclass"] as const).flatMap((placement) =>
          (["method", "getter", "iterator"] as const).flatMap((member) =>
            [false, true].map((populated) => ({ kind, realm, placement, member, populated })),
          ),
        ),
      ),
    ),
  )(
    "fences $realm $kind $placement $member (populated=$populated)",
    async ({ kind, realm, placement, member, populated }) => {
      const constructors: { Map: typeof Map; Set: typeof Set; Array: typeof Array } =
        realm === "VM" ? runInNewContext("({ Map, Set, Array })") : { Map, Set, Array };
      const MapType =
        placement === "subclass" ? class extends constructors.Map {} : constructors.Map;
      const SetType =
        placement === "subclass" ? class extends constructors.Set {} : constructors.Set;
      const ArrayType =
        placement === "subclass" ? class extends constructors.Array {} : constructors.Array;
      const source: Map<unknown, unknown> | Set<unknown> | unknown[] =
        kind === "map" ? new MapType() : kind === "set" ? new SetType() : new ArrayType();
      if (populated) {
        if ("set" in source) {
          source.set("key", "value");
        } else if ("add" in source) {
          source.add("key");
        } else {
          source.push("key");
        }
      }
      let getterCalls = 0;
      let calls = 0;
      const read = function (this: object) {
        calls += 1;
        if (member === "iterator") {
          throw new Error("classification executed a plugin iterator");
        }
        const has =
          kind === "map"
            ? constructors.Map.prototype.has.call(this, "key")
            : kind === "set"
              ? constructors.Set.prototype.has.call(this, "key")
              : constructors.Array.prototype.includes.call(this, "key");
        expect(has).toBe(populated);
        return "current";
      };
      const key = member === "iterator" ? Symbol.iterator : "read";
      Object.defineProperty(placement === "own" ? source : Object.getPrototypeOf(source), key, {
        configurable: true,
        ...(member === "getter"
          ? {
              get: () => {
                getterCalls += 1;
                return read.bind(source);
              },
            }
          : { value: read }),
      });
      const instance = new PluginInstance("collection-members");
      try {
        const view = instance.wrap(source);
        expect(getterCalls).toBe(0);
        expect(calls).toBe(0);
        const retained: () => string = Reflect.get(view, key);
        if (member !== "iterator") {
          expect(Reflect.apply(retained, source, [])).toBe("current");
        }
        await instance.dispose();
        expect(() => Reflect.apply(retained, source, [])).toThrow("reloaded or disabled");
        if (member === "getter") {
          expect(() => Reflect.get(view, key)).toThrow("reloaded or disabled");
          expect(getterCalls).toBe(1);
        }
      } finally {
        await instance.dispose();
      }
    },
  );

  it.each(["host", "VM"] as const)(
    "keeps plain $realm data collections native and cloneable",
    async (realm) => {
      const source: { map: Map<string, unknown>; set: Set<unknown>; array: unknown[] } =
        realm === "VM"
          ? runInNewContext(
              '({map:new Map([["key",{value:1}]]),set:new Set(["value"]),array:["value"]})',
            )
          : { map: new Map([["key", { value: 1 }]]), set: new Set(["value"]), array: ["value"] };
      const instance = new PluginInstance("plain-collections");
      const view = instance.wrap(source);
      expect(view).toBe(source);
      expect(Map.prototype.get.call(view.map, "key")).toEqual({ value: 1 });
      expect(Set.prototype.has.call(view.set, "value")).toBe(true);
      expect(Array.prototype.includes.call(view.array, "value")).toBe(true);
      expect(structuredClone(view)).toEqual({
        map: new Map([["key", { value: 1 }]]),
        set: new Set(["value"]),
        array: ["value"],
      });
      await instance.dispose();
      expect(Map.prototype.get.call(view.map, "key")).toEqual({ value: 1 });
    },
  );
});
