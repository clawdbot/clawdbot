import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import { EventStream } from "@openclaw/llm-core/event-stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { createDeferredCore } from "../shared/deferred.js";
import { attachPluginApiFacades, instrumentPluginInstanceApi } from "./api-facades.js";
import { registerPluginCommandInRegistry } from "./command-registration.js";
import type {
  PluginAgentEventSubscriptionRegistration,
  PluginRuntimeLifecycleRegistration,
  PluginSessionActionRegistration,
} from "./host-hooks.js";
import { registerPluginHttpRoute } from "./http-registry.js";
import { registerMemoryCapability } from "./memory-state.js";
import { runPluginCleanup } from "./plugin-instance-scope.js";
import { PluginInstance } from "./plugin-instance.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { adoptPluginRegistryRecords } from "./registry-lifecycle.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginApi } from "./types.js";

const require = createRequire(import.meta.url);

describe("managed plugin instances", () => {
  afterEach(() => vi.useRealTimers());

  it("drains admitted calls, rejects new calls, and releases owned timers", async () => {
    const instance = new PluginInstance("clock");
    const deferred = createDeferredCore<string>();
    const tick = vi.fn();
    const timer = instance.globals.setInterval(tick, 10);
    const tool = instance.wrap({ execute: () => deferred.promise });
    const call = tool.execute();
    let drained = false;
    const draining = instance.drain().then(() => {
      drained = true;
    });
    try {
      expect(() => tool.execute()).toThrow("reloaded or disabled");
      await delay(20);
      expect(tick).not.toHaveBeenCalled();
      expect(drained).toBe(false);
      deferred.resolve("finished");
      await expect(call).resolves.toBe("finished");
      await draining;
    } finally {
      deferred.resolve("finished");
      await instance.dispose();
    }
    expect(Reflect.get(timer, "_destroyed")).toBe(true);
  });

  it("lets a self-retiring call finish with its resources before joined cleanup", async () => {
    const instance = new PluginInstance("self");
    const events: string[] = [];
    instance.lifecycle.onDispose(async () => {
      await Promise.resolve();
      events.push("cleanup");
    });
    const helper = instance.wrap(() => "receipt completed");
    const tool = instance.wrap(async () => {
      await instance.dispose();
      events.push("reload published");
      const result = await new Promise<string>((resolve) => {
        instance.globals.setImmediate(() => resolve(helper()));
      });
      events.push(result);
      return result;
    });
    const call = tool();
    const disposal = instance.dispose();
    expect(() => tool()).toThrow("reloaded or disabled");
    await expect(call).resolves.toBe("receipt completed");
    await disposal;
    expect(events).toEqual(["reload published", "receipt completed", "cleanup"]);
    expect(instance.lifecycle.signal.aborted).toBe(true);
  });

  it("lets admitted calls consume a self-retiring call's result before cleanup", async () => {
    const instance = new PluginInstance("dependent-calls");
    const startRetirement = createDeferredCore();
    const events: string[] = [];
    instance.lifecycle.onDispose(() => {
      events.push("cleanup");
    });
    const first = instance.wrap(async () => {
      await startRetirement.promise;
      await instance.dispose();
      return "first result";
    })();
    const second = instance.wrap(async () => {
      events.push(await first);
      return "second result";
    })();
    startRetirement.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["first result", "second result"]);
    expect(events).toEqual(["first result", "cleanup"]);
  });

  it("hands an asynchronously returned stream to its consumer before joining retirement", async () => {
    const instance = new PluginInstance("async-stream");
    const cleaned = vi.fn();
    instance.lifecycle.onDispose(cleaned);
    const helper = instance.wrap(() => "chunk");
    const open = instance.wrap(async () => {
      await instance.dispose();
      return (async function* () {
        yield helper();
      })();
    });
    const stream = await open();
    expect(cleaned).not.toHaveBeenCalled();
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["chunk"]);
    expect(cleaned).toHaveBeenCalledOnce();
    expect(() => helper()).toThrow("reloaded or disabled");
  });

  it("admits teardown only from its host owner and fences retained cleanup after disposal", async () => {
    const instance = new PluginInstance("teardown");
    const called = vi.fn();
    const helper = instance.wrap(() => called());
    const service = instance.wrap({
      async stop() {
        await Promise.resolve();
        helper();
      },
      cleanup: helper,
      dispose: helper,
      return: helper,
    });
    instance.quiesce();
    for (const method of Object.values(service)) {
      expect(() => method()).toThrow("reloaded or disabled");
    }
    await runPluginCleanup(service, () => service.stop());
    expect(called).toHaveBeenCalledOnce();
    await instance.dispose();
    expect(() => runPluginCleanup(service, () => service.stop())).toThrow("retiring");
    for (const method of Object.values(service)) {
      expect(() => method()).toThrow("reloaded or disabled");
    }
    expect(called).toHaveBeenCalledOnce();
  });

  it("keeps cached SDK runtime stores separate during preparation and rollback", async () => {
    const store = createPluginRuntimeStore<string>({ pluginId: "shared", errorMessage: "not set" });
    const current = new PluginInstance("shared");
    const candidate = new PluginInstance("shared");
    current.run(() => store.setRuntime("current"));
    candidate.run(() => store.setRuntime("candidate"));
    expect(current.run(store.getRuntime)).toBe("current");
    expect(candidate.run(store.getRuntime)).toBe("candidate");
    await candidate.dispose();
    expect(current.run(store.getRuntime)).toBe("current");
    await current.dispose();
  });

  it("preserves class receivers and fences callable re-exports, including frozen getters", async () => {
    const instance = new PluginInstance("classes");
    class Counter {
      static #label = "counter";
      static label() {
        return this.#label;
      }
      static get reader() {
        return () => this.#label;
      }
      #value: number;
      constructor(value: number) {
        this.#value = value;
      }
      get read() {
        return () => this.#value;
      }
      increment() {
        return ++this.#value;
      }
    }
    const WrappedCounter = instance.wrap(Object.freeze(Counter));
    const label: () => string = Reflect.get(WrappedCounter, "label");
    const readLabel = WrappedCounter.reader;
    expect(label()).toBe("counter");
    expect(readLabel()).toBe("counter");
    const counter = new WrappedCounter(2);
    const readExport = vi.fn(() => counter.read);
    const exports = instance.wrap(
      Object.freeze({
        get read() {
          return readExport();
        },
      }),
    );
    expect(Object.keys(exports)).toEqual(["read"]);
    const readDescriptor = Object.getOwnPropertyDescriptor(exports, "read")!;
    expect(typeof readDescriptor.get).toBe("function");
    expect(readExport).not.toHaveBeenCalled();
    const read = exports.read;
    expect(counter).toBeInstanceOf(Counter);
    expect(counter.increment()).toBe(3);
    expect(read()).toBe(3);
    await instance.dispose();
    expect(() => read()).toThrow("reloaded or disabled");
    expect(() => exports.read).toThrow("reloaded or disabled");
    expect(() => new WrappedCounter(4)).toThrow("reloaded or disabled");
    expect(() => label()).toThrow("reloaded or disabled");
    expect(() => readLabel()).toThrow("reloaded or disabled");
    expect(() => WrappedCounter.reader).toThrow("reloaded or disabled");
    expect(() => readDescriptor.get!()).toThrow("reloaded or disabled");
  });

  it.each(
    (["host", "VM"] as const).flatMap((realm) =>
      (["before wrapping", "after wrapping", "after growing"] as const).map((freezeAt) => ({
        realm,
        freezeAt,
      })),
    ),
  )("preserves $realm array descriptors frozen $freezeAt", async ({ realm, freezeAt }) => {
    const instance = new PluginInstance("frozen-array");
    const source: Array<{ execute(): string }> =
      realm === "host"
        ? [{ execute: () => "current" }]
        : runInNewContext('[{ execute() { return "current"; } }]');
    try {
      if (freezeAt === "before wrapping") {
        Object.freeze(source);
      }
      const view = instance.wrap(source);
      if (freezeAt === "after growing") {
        source.push({ execute: () => "second" });
      }
      Object.freeze(source);
      expect(Array.isArray(view)).toBe(true);
      expect(Object.keys(view)).toEqual(Object.keys(source));
      expect(Object.getOwnPropertyDescriptor(view, "length")).toEqual(
        Object.getOwnPropertyDescriptor(source, "length"),
      );
      expect(view.length).toBe(source.length);
      const execute: () => string = Reflect.get(view[0]!, "execute");
      expect(execute()).toBe("current");
      await instance.dispose();
      expect(() => execute()).toThrow("reloaded or disabled");
    } finally {
      await instance.dispose();
    }
  });

  it("preserves async function metadata used by synchronous registration contracts", async () => {
    const instance = new PluginInstance("metadata");
    const project = instance.wrap(async () => ({}));
    expect(project.constructor.name).toBe("AsyncFunction");
    const constructor = project.constructor;
    await instance.dispose();
    expect(() => Reflect.apply(constructor, undefined, [])).toThrow("reloaded or disabled");
  });

  it("keeps ordinary tool data and cross-realm byte views compatible with native consumers", async () => {
    const instance = new PluginInstance("data");
    const data = runInNewContext(
      "({ nested: [{ value: 2 }], bytes: new Uint8Array([1, 2]), buffer: new ArrayBuffer(4) })",
    ) as {
      nested: { value: number }[];
      bytes: Uint8Array;
      buffer: ArrayBuffer;
    };
    const tool = instance.wrap({ prepareArguments: () => data, execute: () => Buffer.from("ok") });
    expect(structuredClone(tool.prepareArguments()).nested).toEqual([{ value: 2 }]);
    expect(ArrayBuffer.isView(tool.prepareArguments().bytes)).toBe(true);
    expect(Buffer.from(tool.prepareArguments().bytes).toString("hex")).toBe("0102");
    expect(Buffer.isBuffer(tool.execute())).toBe(true);
    await instance.dispose();
    expect(structuredClone(data).nested).toEqual([{ value: 2 }]);
  });

  it("lets an admitted callback finish through an owned timer while draining", async () => {
    const instance = new PluginInstance("timer-call");
    const helper = instance.wrap(() => "complete");
    const call = instance.wrap(
      () =>
        new Promise<string>((resolve) => {
          instance.globals.setTimeout(() => resolve(helper()), 10);
        }),
    )();
    const draining = instance.drain();
    try {
      await expect(call).resolves.toBe("complete");
      await draining;
    } finally {
      await instance.dispose();
    }
    expect(() => instance.globals.setTimeout(() => {}, 10)).toThrow("reloaded or disabled");
  });

  it("retains streams through iteration and preserves the separately awaited final result", async () => {
    const instance = new PluginInstance("stream");
    const source = new EventStream<string>(
      () => false,
      (value) => value,
    );
    const stream = instance.wrap(() => source)();
    for (const method of ["next", "return", "throw"]) {
      expect(Reflect.get(stream, method)).toBeUndefined();
    }
    const iterator = stream[Symbol.asyncIterator]();
    source.push("chunk");
    await expect(iterator.next()).resolves.toEqual({ value: "chunk", done: false });
    let drained = false;
    const draining = instance.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    source.end("final");
    await expect(iterator.next()).resolves.toMatchObject({ done: true });
    await draining;
    await expect(stream.result()).resolves.toBe("final");
    await instance.dispose();
  });

  it.each(["stream", "iterator"] as const)(
    "fences retained %s getters after stream closure without hiding plain data",
    async (target) => {
      const instance = new PluginInstance("stream-getters");
      const read = vi.fn(() => "retired getter");
      const iterator = (async function* () {
        yield "chunk";
      })();
      const source = {
        [Symbol.asyncIterator]: () => iterator,
        label: "retained data",
      };
      Object.defineProperty(iterator, "status", { get: read });
      Object.defineProperty(source, "status", { get: read });
      const stream = instance.wrap(source);
      const view = stream[Symbol.asyncIterator]();
      await expect(view.next()).resolves.toEqual({ done: false, value: "chunk" });
      await expect(view.next()).resolves.toMatchObject({ done: true });
      await instance.dispose();
      expect(() => Reflect.get(target === "stream" ? stream : view, "status")).toThrow(
        "stream is closed",
      );
      expect(read).not.toHaveBeenCalled();
      expect(stream.label).toBe("retained data");
    },
  );

  it("captures a terminal result getter once and retains its data after disposal", async () => {
    const instance = new PluginInstance("terminal-getter");
    const read = vi.fn(() => () => Promise.resolve("final"));
    const stream = instance.wrap({
      async *[Symbol.asyncIterator]() {
        yield "chunk";
      },
      get result() {
        return read();
      },
    });
    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    await instance.dispose();
    await expect(stream.result()).resolves.toBe("final");
    await expect(stream.result()).resolves.toBe("final");
    expect(chunks).toEqual(["chunk"]);
    expect(read).toHaveBeenCalledOnce();
  });

  it.each([
    "sourceMember",
    "iteratorMember",
    "sourceMethod",
    "asyncSourceMethod",
    "iteratorMethod",
    "asyncIteratorMethod",
    "yieldedValue",
    "terminalValue",
  ] as const)("fences callable values returned through a stream's %s", async (target) => {
    const instance = new PluginInstance("stream-values");
    const read = vi.fn(() => "owned value");
    // A helper's data is not an iterator completion signal.
    const payload = { read, done: true };
    const iterator = Object.assign(
      (async function* () {
        yield payload;
      })(),
      { member: payload, inspect: () => payload, inspectAsync: async () => payload },
    );
    const stream = instance.wrap({
      [Symbol.asyncIterator]: () => iterator,
      member: payload,
      helper: () => read,
      helperAsync: async () => read,
      result: async () => payload,
    });
    const view = stream[Symbol.asyncIterator]();
    const first = await view.next();
    if (first.done) {
      throw new Error("Expected the fixture's first chunk");
    }
    const readers = {
      sourceMember: () => stream.member.read,
      iteratorMember: () => view.member.read,
      sourceMethod: () => stream.helper(),
      asyncSourceMethod: () => stream.helperAsync(),
      iteratorMethod: () => view.inspect().read,
      asyncIteratorMethod: async () => (await view.inspectAsync()).read,
      yieldedValue: () => first.value.read,
      terminalValue: async () => (await stream.result()).read,
    };
    const retained = await readers[target]();
    expect(retained()).toBe("owned value");
    await expect(view.next()).resolves.toMatchObject({ done: true });
    await instance.dispose();
    expect(() => retained()).toThrow("reloaded or disabled");
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(["source", "iterator"] as const)(
    "joins an admitted async %s helper after its cursor ends",
    async (target) => {
      const instance = new PluginInstance("stream-helper");
      const proceed = createDeferredCore();
      const events: string[] = [];
      const cleaned = vi.fn(() => {
        events.push("cleanup");
      });
      instance.lifecycle.onDispose(cleaned);
      const read = instance.wrap(() => "owned value");
      const inspect = async () => {
        await proceed.promise;
        const value = read();
        events.push("helper");
        return value;
      };
      const source = Object.assign(
        (async function* () {
          yield "chunk";
        })(),
        { inspect },
      );
      const stream = instance.wrap({ [Symbol.asyncIterator]: () => source, inspect });
      const iterator = stream[Symbol.asyncIterator]();
      const pending = target === "source" ? stream.inspect() : iterator.inspect();
      try {
        await expect(iterator.next()).resolves.toEqual({ value: "chunk", done: false });
        await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
        const disposing = instance.dispose();
        await Promise.resolve();
        expect(cleaned).not.toHaveBeenCalled();
        proceed.resolve();
        await expect(pending).resolves.toBe("owned value");
        await disposing;
        expect(events).toEqual(["helper", "cleanup"]);
      } finally {
        proceed.resolve();
        await Promise.allSettled([pending, iterator.return(undefined), instance.dispose()]);
      }
    },
  );

  it("releases a directly consumed async generator when its consumer returns early", async () => {
    const instance = new PluginInstance("iterator");
    const finished = vi.fn();
    const stream = instance.wrap(async function* () {
      try {
        yield "chunk";
        yield "unused";
      } finally {
        finished();
      }
    })();
    await expect(stream.next()).resolves.toEqual({ value: "chunk", done: false });
    const draining = instance.drain();
    await stream.return(undefined);
    await draining;
    expect(finished).toHaveBeenCalledOnce();
    await instance.dispose();
  });

  it.each(["completion", "failure"] as const)(
    "permits terminal return after %s without reentering plugin code",
    async (outcome) => {
      const instance = new PluginInstance("terminal-return");
      const finished = vi.fn();
      const failure = new Error("generator failed");
      const source = (async function* () {
        try {
          yield "chunk";
          if (outcome === "failure") {
            throw failure;
          }
          return "original result";
        } finally {
          finished();
        }
      })();
      const originalReturn = source.return.bind(source);
      const readReturn = vi.fn(() => originalReturn);
      Object.defineProperty(source, "return", { get: readReturn });
      const stream = instance.wrap(source);
      const iterator = stream[Symbol.asyncIterator]();
      const retainedReturn = iterator.return.bind(iterator);
      try {
        await expect(iterator.next()).resolves.toEqual({ done: false, value: "chunk" });
        if (outcome === "failure") {
          await expect(iterator.next()).rejects.toBe(failure);
        } else {
          await expect(iterator.next()).resolves.toEqual({ done: true, value: "original result" });
        }
        await instance.dispose();
        for (const getClose of [
          () => retainedReturn,
          () => iterator.return.bind(iterator),
          () => stream.return.bind(stream),
        ]) {
          await expect(getClose()(Promise.resolve("closed"))).resolves.toEqual({
            done: true,
            value: "closed",
          });
        }
        expect(readReturn).toHaveBeenCalledOnce();
        expect(finished).toHaveBeenCalledOnce();
        await expect(iterator.next()).rejects.toThrow("stream is closed");
        await expect(iterator.throw(failure)).rejects.toThrow("stream is closed");
      } finally {
        await instance.dispose();
      }
    },
  );

  it("waits for a stream's independent terminal result after its iterator ends", async () => {
    const instance = new PluginInstance("terminal-stream");
    const terminal = createDeferredCore<string>();
    const stream = instance.wrap({
      async *[Symbol.asyncIterator]() {
        yield "chunk";
      },
      result: () => terminal.promise,
    });
    let drained = false;
    const draining = instance.drain().then(() => {
      drained = true;
    });
    for await (const chunk of stream) {
      expect(chunk).toBe("chunk");
    }
    await Promise.resolve();
    expect(drained).toBe(false);
    const second = stream[Symbol.asyncIterator]();
    await expect(second.next()).resolves.toEqual({ value: "chunk", done: false });
    terminal.resolve("final");
    await expect(stream.result()).resolves.toBe("final");
    expect(drained).toBe(false);
    await expect(second.next()).resolves.toEqual({ value: undefined, done: true });
    await draining;
    await instance.dispose();
  });

  it.each(["iteration", "result"] as const)(
    "reports cleanup failures to a self-retiring stream's %s consumer",
    async (terminal) => {
      const instance = new PluginInstance("stream-cleanup");
      const failure = new Error("owned cleanup failed");
      instance.lifecycle.onDispose(async () => {
        await Promise.resolve();
        throw failure;
      });
      const stream = instance.wrap({
        async *[Symbol.asyncIterator]() {
          await instance.dispose();
          yield "chunk";
        },
        async result() {
          await instance.dispose();
          return "final";
        },
      });
      const consume = async () => {
        if (terminal === "result") {
          return await stream.result();
        }
        for await (const chunk of stream) {
          expect(chunk).toBe("chunk");
        }
        return undefined;
      };
      await expect(consume()).rejects.toMatchObject({ errors: [failure] });
      await expect(instance.dispose()).rejects.toMatchObject({ errors: [failure] });
    },
  );

  it("preserves a stream failure when retirement cleanup also fails", async () => {
    const instance = new PluginInstance("failed-stream");
    const failure = new Error("stream failed");
    instance.lifecycle.onDispose(() => {
      throw new Error("cleanup failed too");
    });
    const stream = instance.wrap(async function* () {
      await instance.dispose();
      yield "chunk";
      throw failure;
    })();
    await expect(stream.next()).resolves.toEqual({ value: "chunk", done: false });
    await expect(stream.next()).rejects.toBe(failure);
    await expect(instance.dispose()).rejects.toThrow("cleanup failed");
  });

  it("cleans resources after a drain timeout and allows exact cleanup callbacks to finish", async () => {
    vi.useFakeTimers();
    const instance = new PluginInstance("stuck");
    const pending = createDeferredCore();
    const resumedStream = vi.fn();
    const stream = instance.wrap(async function* () {
      resumedStream();
      yield "stale";
    })();
    const helper = instance.wrap(() => "current");
    const call = instance.wrap(async () => {
      await pending.promise;
      return helper();
    })();
    const rejectedCall = expect(call).rejects.toThrow("reloaded or disabled");
    instance.globals.setInterval(() => {}, 100);
    const facade = instance.prepareGlobals(require).process as NodeJS.Process;
    const cleaned = vi.fn();
    instance.lifecycle.onDispose(
      () =>
        new Promise<void>((resolve) => {
          facade.nextTick(() => {
            cleaned();
            resolve();
          });
        }),
    );
    const disposing = instance.dispose();
    const rejected = expect(disposing).rejects.toThrow("cleanup failed");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(instance.lifecycle.signal.aborted).toBe(true);
    expect(cleaned).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    await expect(stream.return(undefined)).rejects.toThrow("stream is closed");
    await expect(stream.next()).rejects.toThrow("stream is closed");
    expect(resumedStream).not.toHaveBeenCalled();
    pending.resolve();
    await rejectedCall;
    expect(instance.dispose()).toBe(disposing);
  });

  it("preserves prepared caller scope and follows an adopted instance for detached work", async () => {
    const record = createPluginRecord({ id: "owned" });
    const first = createEmptyPluginRegistry();
    first.plugins.push(record);
    const next = { ...createEmptyPluginRegistry(), plugins: [record] };
    const instance = new PluginInstance(record.id, { record, registry: first });
    let observed: ReturnType<typeof getPluginRuntimeGatewayRequestScope>;
    const callback = instance.wrap(() => {
      observed = getPluginRuntimeGatewayRequestScope();
    });
    adoptPluginRegistryRecords(first);
    adoptPluginRegistryRecords(next);
    callback();
    expect(observed?.pluginRegistry).toBe(next);
    const caller = { isWebchatConnect: () => false, invokeWithSessionNodeAuthority: vi.fn() };
    withPluginRuntimeGatewayRequestScope(caller, () =>
      withPluginRuntimeGenerationScope(
        {
          metadataSnapshot: { index: {}, configFingerprint: "test", owners: {} } as never,
          pluginRegistry: first,
        },
        () => {
          callback();
          expect(observed?.pluginRegistry).toBe(first);
          expect(observed?.pluginId).toBe(record.id);
          expect(observed?.invokeWithSessionNodeAuthority).toBe(
            caller.invokeWithSessionNodeAuthority,
          );
        },
      ),
    );
    expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
    await instance.dispose();
  });

  it("owns flat and grouped SDK registrations after repeated facade attachment", async () => {
    const instance = new PluginInstance("facades");
    const registerSessionAction = vi.fn<(entry: PluginSessionActionRegistration) => void>();
    const registerAgentEventSubscription =
      vi.fn<(entry: PluginAgentEventSubscriptionRegistration) => void>();
    const registerRuntimeLifecycle = vi.fn<(entry: PluginRuntimeLifecycleRegistration) => void>();
    const api = attachPluginApiFacades(
      instrumentPluginInstanceApi(
        {
          registerSessionAction,
          registerAgentEventSubscription,
          registerRuntimeLifecycle,
        } as unknown as OpenClawPluginApi,
        instance,
      ),
    );
    const handler = vi.fn<() => void>();
    api.registerSessionAction({ id: "flat", handler });
    api.session.controls.registerSessionAction({ id: "grouped", handler });
    api.agent.events.registerAgentEventSubscription({ id: "events", handle: handler });
    api.lifecycle.registerRuntimeLifecycle({ id: "lifecycle", cleanup: () => {} });
    const disposed = vi.fn();
    api.lifecycle.onDispose?.(disposed);
    expect(api.lifecycle.signal).toBe(instance.controller.signal);
    expect(registerRuntimeLifecycle).toHaveBeenCalledOnce();
    const callbacks = [
      ...registerSessionAction.mock.calls.map(([entry]) => entry.handler),
      registerAgentEventSubscription.mock.calls[0]![0].handle,
    ];
    for (const callback of callbacks) {
      Reflect.apply(callback, undefined, []);
    }
    expect(handler).toHaveBeenCalledTimes(3);
    await instance.dispose();
    expect(disposed).toHaveBeenCalledOnce();
    for (const callback of callbacks) {
      expect(() => Reflect.apply(callback, undefined, [])).toThrow("reloaded or disabled");
    }
  });

  it("owns direct SDK registrations in the candidate registry and fences retained callbacks", async () => {
    const registry = createEmptyPluginRegistry();
    const record = createPluginRecord({ id: "direct" });
    registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry });
    instance.run(() => {
      expect(
        registerPluginCommandInRegistry(registry, record.id, {
          name: "direct",
          description: "Direct SDK command",
          handler: () => ({ text: "current" }),
        }),
      ).toEqual({ ok: true });
      registerMemoryCapability(record.id, { promptBuilder: () => ["current"] });
      registerPluginHttpRoute({
        path: "/direct",
        pluginId: record.id,
        auth: "plugin",
        handler: () => true,
      });
    });
    expect(registry.httpRoutes).toHaveLength(1);
    const command = registry.commands[0]!.command.handler;
    const memory = registry.memoryCapabilities[0]!.capability.promptBuilder!;
    const route = registry.httpRoutes[0]!.handler;
    expect(command({} as never)).toEqual({ text: "current" });
    expect(memory({} as never)).toEqual(["current"]);
    expect(route({} as never, {} as never)).toBe(true);
    await instance.dispose();
    for (const callback of [command, memory, route]) {
      expect(() => Reflect.apply(callback, undefined, [])).toThrow("reloaded or disabled");
    }
  });

  it("removes only owned process listeners and aborts pending promise timers", async () => {
    const instance = new PluginInstance("resources");
    const facade = instance.prepareGlobals(require).process as NodeJS.Process;
    expect(instance.loadBuiltin("node:process", require)).toBe(facade);
    const event = "openclaw-plugin-instance-test";
    const hostListener = vi.fn();
    const pluginListener = vi.fn();
    process.on(event, hostListener);
    try {
      facade.on(event, pluginListener);
      facade.off(event, pluginListener);
      process.emit(event);
      expect(pluginListener).not.toHaveBeenCalled();
      facade.once(event, pluginListener);
      process.emit(event);
      process.emit(event);
      expect(pluginListener).toHaveBeenCalledOnce();
      facade.on(event, pluginListener);
      const timers = instance.loadBuiltin(
        "node:timers/promises",
        require,
      ) as typeof import("node:timers/promises");
      const timer = timers.setTimeout(60_000);
      const rejected = expect(timer).rejects.toMatchObject({ name: "AbortError" });
      await instance.dispose();
      await rejected;
      process.emit(event);
      expect(pluginListener).toHaveBeenCalledOnce();
      expect(hostListener).toHaveBeenCalledTimes(4);
    } finally {
      process.removeListener(event, hostListener);
    }
  });
});
