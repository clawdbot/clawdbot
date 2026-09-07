import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayClient } from "../gateway/client.js";
import { createNodeDuplexEndpoint } from "../infra/node-duplex-framing.js";
import { registerComputerUseProvider } from "../plugins/computer-use-contract.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  createPluginRegistryResourceOwner,
  drainPluginRegistryResourceDisposals,
  registerPluginRegistryResourceDisposer,
  requirePluginRegistryResourceScope,
} from "../plugins/registry-resources.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type {
  OpenClawPluginNodeHostCommandContext,
  OpenClawPluginNodeHostCommandIo,
} from "../plugins/types.node-host.js";
import { createDeferredCore } from "../shared/deferred.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { handleInvoke } from "./invoke.js";
import {
  ensureNodeHostPluginRegistry,
  invokeRegisteredNodeHostCommand,
  listRegisteredNodeHostCapsAndCommands,
  notifyRegisteredNodeHostCommandDisconnect,
  watchRegisteredNodeHostCommandAvailability,
} from "./plugin-node-host.js";
import { resetNodeHostPluginRegistry } from "./plugin-node-host.test-support.js";
import { prepareNodeHostRuntime } from "./runtime.js";

const loadRegistry = vi.hoisted(() => vi.fn());
vi.mock("../plugins/loader.js", () => ({ loadPluginRegistryHandle: loadRegistry }));

/** Verifies non-duplex plugin commands inherit the node invocation lifetime. */

describe("non-duplex node-host plugin cancellation", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("passes the actual invocation signal into the node-owned plugin context", async () => {
    const controller = new AbortController();
    const sendNodeEvent = vi.fn(async () => undefined);
    const handle = vi.fn(
      async (
        _paramsJSON?: string | null,
        _io?: unknown,
        context?: OpenClawPluginNodeHostCommandContext,
      ) => {
        await new Promise<void>((_resolve, reject) => {
          context?.signal?.addEventListener(
            "abort",
            () =>
              reject(
                context.signal?.reason instanceof Error
                  ? context.signal.reason
                  : new Error("node plugin invocation aborted", { cause: context.signal?.reason }),
              ),
            { once: true },
          );
        });
        return '{"stale":true}';
      },
    );
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "ollama",
        pluginName: "Ollama",
        command: { command: "ollama.chat", cap: "local-inference", handle },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);

    const invocation = handleInvoke(
      {
        id: "cancelable-model-inference",
        nodeId: "paired-node",
        command: "ollama.chat",
        paramsJSON: '{"model":"local-only:small"}',
        sessionKey: "agent:main:local-model",
      },
      { request } as unknown as GatewayClient,
      { current: async () => [] },
      undefined,
      { signal: controller.signal, pluginCommandContext: { sendNodeEvent } },
    );
    await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());

    controller.abort(new Error("paired inference canceled"));
    await invocation;

    expect(handle).toHaveBeenCalledWith('{"model":"local-only:small"}', undefined, {
      sendNodeEvent,
      sessionKey: "agent:main:local-model",
      signal: controller.signal,
      prepareExecAuthorization: expect.any(Function),
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("preserves legacy plugin context when the caller supplies no signal", async () => {
    const sendNodeEvent = vi.fn(async () => undefined);
    const handle = vi.fn(async () => '{"ok":true}');
    const registry = createEmptyPluginRegistry();
    registry.nodeHostCommands = [
      {
        pluginId: "ollama",
        pluginName: "Ollama",
        command: { command: "ollama.chat", cap: "local-inference", handle },
        source: "test",
      },
    ];
    setActivePluginRegistry(registry);
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);

    await handleInvoke(
      {
        id: "legacy-model-inference",
        nodeId: "paired-node",
        command: "ollama.chat",
        paramsJSON: "{}",
      },
      { request } as unknown as GatewayClient,
      { current: async () => [] },
      undefined,
      { pluginCommandContext: { sendNodeEvent } },
    );

    expect(handle).toHaveBeenCalledWith("{}", undefined, {
      sendNodeEvent,
      prepareExecAuthorization: expect.any(Function),
    });
    expect(request).toHaveBeenCalledWith(
      "node.invoke.result",
      expect.objectContaining({ ok: true, payloadJSON: '{"ok":true}' }),
    );
  });

  it.each(["success", "failure", "cancellation", "supersession", "different-error"] as const)(
    "settles pending asynchronous plugin listener delivery before result (%s)",
    async (outcome) => {
      let resolveListener!: () => void;
      let rejectListener!: (error: Error) => void;
      const listenerCompleted = new Promise<void>((resolve, reject) => {
        resolveListener = resolve;
        rejectListener = reject;
      });
      const controller = new AbortController();
      let currentInvocation = true;
      let framedFailure: Error | undefined;
      const framedIo = createNodeDuplexEndpoint({
        sendFrame: async () => undefined,
        onError: (error) => {
          framedFailure = error;
          controller.abort(error);
        },
      });
      controller.signal.addEventListener("abort", () => framedIo.close(), { once: true });
      const io: OpenClawPluginNodeHostCommandIo = {
        signal: controller.signal,
        emitChunk: vi.fn(async (_chunk: string) => undefined),
        onInput: vi.fn(),
        frames: framedIo,
      };
      const handle = vi.fn(
        async (_paramsJSON?: string | null, commandIo?: OpenClawPluginNodeHostCommandIo) => {
          commandIo?.frames?.onMessage(async () => await listenerCompleted);
          framedIo.receive(
            JSON.stringify({ v: 1, kind: "data", message: 0, index: 0, last: true, data: "Bw==" }),
          );
          if (outcome === "different-error") {
            await new Promise<void>((_resolve, reject) => {
              controller.signal.addEventListener(
                "abort",
                () => reject(new Error("identical framed failure message")),
                { once: true },
              );
            });
          }
          return '{"ok":true}';
        },
      );
      const registry = createEmptyPluginRegistry();
      registry.nodeHostCommands = [
        {
          pluginId: "frames-fixture",
          pluginName: "Frames fixture",
          command: { command: "fixture.duplex", duplex: true, handle },
          source: "test",
        },
      ];
      setActivePluginRegistry(registry);
      const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);

      const invocation = handleInvoke(
        { id: "pending-listener", nodeId: "paired-node", command: "fixture.duplex" },
        { request } as unknown as GatewayClient,
        { current: async () => [] },
        undefined,
        {
          signal: controller.signal,
          pluginCommandIo: io,
          flushPluginCommandIo: framedIo.drain,
          canReportAbortedFailure: (error) =>
            currentInvocation && error === framedFailure && error === controller.signal.reason,
        },
      );

      try {
        await vi.waitFor(() => expect(handle).toHaveBeenCalledOnce());
        expect(request).not.toHaveBeenCalled();
        if (outcome === "failure") {
          rejectListener(new Error("asynchronous plugin listener rejected"));
        } else if (outcome === "cancellation") {
          controller.abort(new Error("plugin command canceled"));
        } else if (outcome === "supersession") {
          currentInvocation = false;
          rejectListener(new Error("superseded plugin listener rejected"));
        } else if (outcome === "different-error") {
          rejectListener(new Error("identical framed failure message"));
        } else {
          resolveListener();
        }
        await invocation;

        if (outcome === "success") {
          expect(request).toHaveBeenCalledWith(
            "node.invoke.result",
            expect.objectContaining({ ok: true, payloadJSON: '{"ok":true}' }),
          );
        } else if (outcome === "failure") {
          expect(request).toHaveBeenCalledWith(
            "node.invoke.result",
            expect.objectContaining({
              ok: false,
              error: {
                code: "INVALID_REQUEST",
                message: "Error: asynchronous plugin listener rejected",
              },
            }),
          );
        } else {
          expect(controller.signal.aborted).toBe(true);
          expect(request).not.toHaveBeenCalled();
        }
      } finally {
        resolveListener();
        framedIo.close();
        await invocation;
      }
    },
  );
});

describe("Node plugin registration resource lifetime", () => {
  const context = { config: {}, env: {} };
  const databases: DatabaseSync[] = [];

  function createResource() {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    const registry = createEmptyPluginRegistry();
    const claim = createPluginRegistryResourceOwner(registry, "scoped");
    registerPluginRegistryResourceDisposer(registry, "node-fixture", {
      id: "node-fixture",
      dispose: () => db.close(),
    });
    return { db, registry, release: claim.release };
  }

  function readResource(resource: ReturnType<typeof createResource>, label: string) {
    requirePluginRegistryResourceScope().retain(resource.registry);
    expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(resource.registry);
    return resource.db.prepare("SELECT ? AS phase").get(label);
  }

  afterEach(async () => {
    await resetNodeHostPluginRegistry();
    resetPluginRuntimeStateForTest();
    await drainPluginRegistryResourceDisposals();
    for (const db of databases.splice(0)) {
      if (db.isOpen) {
        db.close();
      }
    }
    loadRegistry.mockReset();
  });

  it.each([
    "prepare",
    "isAvailable",
    "computerUse",
    "watchAvailability",
    "onChange",
    "cleanup",
    "onDisconnect",
  ] as const)("runs %s with the node's scoped SQLite registration", async (phase) => {
    const resource = createResource();
    const observed: unknown[] = [];
    const read = (current: string) => {
      if (current === phase) {
        observed.push(readResource(resource, current));
      }
    };
    let notify: (() => void) | undefined;
    resource.registry.nodeHostCommands.push({
      pluginId: "node-fixture",
      source: "test",
      command: {
        command: "fixture.read",
        prepare: async () => {
          await Promise.resolve();
          read("prepare");
        },
        isAvailable: () => {
          read("isAvailable");
          return true;
        },
        computerUse: () => {
          read("computerUse");
          return {
            contractVersion: 2,
            provider: { id: "fixture", label: "Fixture", generation: "generation-1" },
            actions: ["screenshot"],
            targets: ["screen"],
            deliveryModes: ["foreground"],
            observations: ["image"],
            features: { recording: false, agentCursor: false, multiDisplay: false },
          };
        },
        watchAvailability: (_context, callback) => {
          read("watchAvailability");
          notify = callback;
          return () => read("cleanup");
        },
        onDisconnect: async () => {
          await Promise.resolve();
          read("onDisconnect");
        },
        handle: async () => "{}",
      },
    });
    loadRegistry.mockReturnValue(resource);
    const host = await ensureNodeHostPluginRegistry(context);
    let stop: (() => Promise<void>) | undefined;
    try {
      listRegisteredNodeHostCapsAndCommands(context);
      stop = watchRegisteredNodeHostCommandAvailability(context, () => read("onChange"));
      setActivePluginRegistry(createEmptyPluginRegistry());
      notify?.();
      await stop();
      await notifyRegisteredNodeHostCommandDisconnect();
      expect(observed).toEqual([{ phase }]);
    } finally {
      await stop?.();
      await host.release();
    }
  });

  it("retains lazy preparation resources for later command callbacks", async () => {
    const resource = createResource();
    let preparedResource: ReturnType<typeof createResource> | undefined;
    resource.registry.nodeHostCommands.push({
      pluginId: "node-fixture",
      source: "test",
      command: {
        command: "fixture.read",
        prepare: () => {
          preparedResource = createResource();
          requirePluginRegistryResourceScope().adopt(preparedResource);
        },
        handle: async () => {
          if (!preparedResource) {
            throw new Error("Preparation did not produce the SQLite resource");
          }
          return JSON.stringify(preparedResource.db.prepare("SELECT 42 AS value").get());
        },
      },
    });
    loadRegistry.mockReturnValue(resource);
    const host = await ensureNodeHostPluginRegistry(context);
    try {
      await expect(invokeRegisteredNodeHostCommand("fixture.read")).resolves.toBe('{"value":42}');
      expect(preparedResource?.db.isOpen).toBe(true);
    } finally {
      await host.release();
    }
    await drainPluginRegistryResourceDisposals();
    expect(preparedResource?.db.isOpen).toBe(false);
  });

  it("holds a watcher notification through stop and host release", async () => {
    const resource = createResource();
    const pending = createDeferredCore();
    const notificationDone = createDeferredCore();
    let notify: (() => void) | undefined;
    resource.registry.nodeHostCommands.push({
      pluginId: "node-fixture",
      source: "test",
      command: {
        command: "fixture.read",
        watchAvailability: (_context, callback) => {
          readResource(resource, "watch");
          notify = callback;
          return () => {
            readResource(resource, "cleanup");
          };
        },
        handle: async () => "{}",
      },
    });
    loadRegistry.mockReturnValue(resource);
    const host = await ensureNodeHostPluginRegistry(context);
    let stop: (() => Promise<void>) | undefined;
    try {
      stop = watchRegisteredNodeHostCommandAvailability(context, async () => {
        try {
          await pending.promise;
          expect(readResource(resource, "notification")).toEqual({ phase: "notification" });
          notificationDone.resolve();
        } catch (error) {
          notificationDone.reject(error);
        }
      });
      notify?.();
      const stopping = stop();
      const closing = host.release();
      expect(resource.db.isOpen).toBe(true);
      pending.resolve();
      await notificationDone.promise;
      await Promise.all([stopping, closing]);
      await drainPluginRegistryResourceDisposals();
      expect(resource.db.isOpen).toBe(false);
    } finally {
      pending.resolve();
      await stop?.();
      await host.release();
    }
  });

  it("holds a disconnect callback through host release and awaited cleanup", async () => {
    const resource = createResource();
    const pending = createDeferredCore();
    const entered = createDeferredCore();
    resource.registry.nodeHostCommands.push({
      pluginId: "node-fixture",
      source: "test",
      command: {
        command: "fixture.read",
        onDisconnect: async () => {
          readResource(resource, "disconnect-start");
          entered.resolve();
          await pending.promise;
          expect(readResource(resource, "disconnect-end")).toEqual({ phase: "disconnect-end" });
        },
        handle: async () => "{}",
      },
    });
    loadRegistry.mockReturnValue(resource);
    const host = await ensureNodeHostPluginRegistry(context);
    const disconnect = notifyRegisteredNodeHostCommandDisconnect();
    try {
      // Either admission fails or the callback reaches the explicit suspension point.
      await Promise.race([entered.promise, disconnect]);
      await host.release();
      expect(resource.db.isOpen).toBe(true);
      pending.resolve();
      await disconnect;
      await drainPluginRegistryResourceDisposals();
      expect(resource.db.isOpen).toBe(false);
    } finally {
      pending.resolve();
      await host.release();
      await Promise.allSettled([disconnect]);
    }
  });

  it("shares the current node-host owner across duplicated runtime modules", async () => {
    const moduleUrl = new URL("./plugin-node-host.ts", import.meta.url).href;
    const first = (await import(
      `${moduleUrl}?t=node-owner-first`
    )) as typeof import("./plugin-node-host.js");
    const second = (await import(
      `${moduleUrl}?t=node-owner-second`
    )) as typeof import("./plugin-node-host.js");
    const firstResource = createResource();
    const secondResource = createResource();
    firstResource.registry.nodeHostCommands.push({
      pluginId: "node-fixture",
      source: "test",
      command: { command: "fixture.first", handle: async () => "{}" },
    });
    secondResource.registry.nodeHostCommands.push({
      pluginId: "node-fixture",
      source: "test",
      command: { command: "fixture.second", handle: async () => "{}" },
    });
    loadRegistry.mockReturnValueOnce(firstResource).mockReturnValueOnce(secondResource);
    const firstHost = await first.ensureNodeHostPluginRegistry(context);
    let secondHost: Awaited<ReturnType<typeof ensureNodeHostPluginRegistry>> | undefined;
    try {
      secondHost = await second.ensureNodeHostPluginRegistry(context);
      expect(first.listRegisteredNodeHostCapsAndCommands(context).commands).toEqual([
        "fixture.second",
      ]);
      await drainPluginRegistryResourceDisposals();
      expect(firstResource.db.isOpen).toBe(false);
      expect(secondResource.db.isOpen).toBe(true);
      await drainGlobalSingletonLifecycleState("restart");
      await drainPluginRegistryResourceDisposals();
      expect(secondResource.db.isOpen).toBe(false);
    } finally {
      await firstHost.release();
      await secondHost?.release();
    }
  });

  it("keeps accepted input and framed callbacks scoped through the invocation's frame drain", async () => {
    const resource = createResource();
    const pending = createDeferredCore();
    const flushing = createDeferredCore();
    const controller = new AbortController();
    const observed: number[] = [];
    let onInput: ((payload: string) => void) | undefined;
    const framed = createNodeDuplexEndpoint({
      sendFrame: async () => {},
      onError: (error) => controller.abort(error),
    });
    const frame = (message: number) =>
      JSON.stringify({
        v: 1,
        kind: "data",
        message,
        index: 0,
        last: true,
        data: Buffer.from([message]).toString("base64"),
      });
    resource.registry.nodeHostCommands.push({
      pluginId: "node-fixture",
      source: "test",
      command: {
        command: "fixture.frames",
        duplex: true,
        handle: async (_params, io) => {
          io?.onInput((payload) => {
            expect(readResource(resource, payload)).toEqual({ phase: "input" });
          });
          io?.frames?.onMessage(async (message) => {
            await pending.promise;
            expect(readResource(resource, "frame")).toEqual({ phase: "frame" });
            observed.push(...message);
          });
          // One accepted delivery keeps the real invoke.ts frame drain open after handle returns.
          framed.receive(frame(0));
          return '{"ok":true}';
        },
      },
    });
    loadRegistry.mockReturnValue(resource);
    const host = await ensureNodeHostPluginRegistry(context);
    const request = vi.fn<GatewayClient["request"]>().mockResolvedValue(null);
    const invocation = handleInvoke(
      { id: "scoped-frames", nodeId: "fixture", command: "fixture.frames" },
      { request } as unknown as GatewayClient,
      { current: async () => [] },
      undefined,
      {
        signal: controller.signal,
        pluginCommandIo: {
          signal: controller.signal,
          emitChunk: async () => {},
          onInput: (callback) => {
            onInput = callback;
          },
          frames: framed,
        },
        flushPluginCommandIo: async () => {
          flushing.resolve();
          await framed.drain();
        },
      },
    );
    try {
      await Promise.race([flushing.promise, invocation]);
      // These callbacks run from the transport owner, outside command.handle's async context.
      framed.receive(frame(1));
      onInput?.("input");
      await host.release();
      expect(resource.db.isOpen).toBe(true);
      expect(request).not.toHaveBeenCalled();
      pending.resolve();
      await invocation;
      expect(observed).toEqual([0, 1]);
      expect(request).toHaveBeenCalledWith(
        "node.invoke.result",
        expect.objectContaining({ ok: true, payloadJSON: '{"ok":true}' }),
      );
      await drainPluginRegistryResourceDisposals();
      expect(resource.db.isOpen).toBe(false);
    } finally {
      pending.resolve();
      await invocation;
      framed.close();
      await host.release();
    }
  });

  it("retries failed watcher cleanup through the real node runtime close owner", async () => {
    await withOpenClawTestState({ label: "node-watcher-close" }, async (state) => {
      const resource = createResource();
      const failure = new Error("watcher cleanup blocked");
      let blocked = true;
      const firstStop = vi.fn(() => {
        readResource(resource, "first-stop");
        if (blocked) {
          throw failure;
        }
      });
      const secondStop = vi.fn(() => {
        readResource(resource, "second-stop");
      });
      resource.registry.nodeHostCommands = [firstStop, secondStop].map((stop, index) => ({
        pluginId: "node-fixture",
        source: "test",
        command: {
          command: `fixture.${index}`,
          watchAvailability: () => stop,
          handle: async () => "{}",
        },
      }));
      loadRegistry.mockReturnValue(resource);
      const prepared = await prepareNodeHostRuntime({
        config: { nodeHost: { skills: { enabled: false } } },
        env: state.env,
      });
      const client = new GatewayClient({ deviceIdentity: null });
      vi.spyOn(client, "request").mockResolvedValue({});
      const runtime = await prepared.start({ client, onManifestChanged: vi.fn() });
      try {
        await expect(runtime.close()).rejects.toBe(failure);
        expect.soft(firstStop).toHaveBeenCalledOnce();
        expect.soft(secondStop).toHaveBeenCalledOnce();
        expect.soft(resource.db.isOpen).toBe(true);
        blocked = false;
        await expect(runtime.close()).resolves.toBeUndefined();
        expect(firstStop).toHaveBeenCalledTimes(2);
        expect(secondStop).toHaveBeenCalledOnce();
        await drainPluginRegistryResourceDisposals();
        expect(resource.db.isOpen).toBe(false);
      } finally {
        blocked = false;
        await runtime.close().catch(() => {});
      }
    });
  });

  it("keeps failed watcher construction rollback at the existing node host owner", async () => {
    const resource = createResource();
    let blocked = true;
    const rollback = vi.fn(() => {
      readResource(resource, "rollback");
      if (blocked) {
        throw new Error("watcher rollback blocked");
      }
    });
    resource.registry.nodeHostCommands = [
      {
        pluginId: "node-fixture",
        source: "test",
        command: {
          command: "fixture.first",
          watchAvailability: () => rollback,
          handle: async () => "{}",
        },
      },
      {
        pluginId: "node-fixture",
        source: "test",
        command: {
          command: "fixture.second",
          watchAvailability: () => {
            throw new Error("watcher setup failed");
          },
          handle: async () => "{}",
        },
      },
    ];
    loadRegistry.mockReturnValue(resource);
    const host = await ensureNodeHostPluginRegistry(context);
    try {
      expect(() => watchRegisteredNodeHostCommandAvailability(context, () => {})).toThrow();
      expect(rollback).toHaveBeenCalledOnce();
      expect(resource.db.isOpen).toBe(true);
      await expect(host.release()).rejects.toThrow("watcher rollback blocked");
      const failedAttempts = rollback.mock.calls.length;
      blocked = false;
      await host.release();
      expect(rollback).toHaveBeenCalledTimes(failedAttempts + 1);
      await drainPluginRegistryResourceDisposals();
      expect(resource.db.isOpen).toBe(false);
    } finally {
      blocked = false;
      await host.release();
    }
  });

  it("releases the prepared node registry after runtime watcher construction fails", async () => {
    await withOpenClawTestState({ label: "node-runtime-watcher-startup" }, async (state) => {
      const resource = createResource();
      const failure = new Error("watcher setup failed");
      const rollbackFinished = createDeferredCore();
      const rollback = vi.fn(async () => {
        await Promise.resolve();
        readResource(resource, "startup-rollback");
        rollbackFinished.resolve();
      });
      resource.registry.nodeHostCommands = [
        {
          pluginId: "node-fixture",
          source: "test",
          command: {
            command: "fixture.first",
            watchAvailability: () => rollback,
            handle: async () => "{}",
          },
        },
        {
          pluginId: "node-fixture",
          source: "test",
          command: {
            command: "fixture.second",
            watchAvailability: () => {
              throw failure;
            },
            handle: async () => "{}",
          },
        },
      ];
      loadRegistry.mockReturnValue(resource);
      const prepared = await prepareNodeHostRuntime({
        config: { nodeHost: { skills: { enabled: false } } },
        env: state.env,
      });
      const client = new GatewayClient({ deviceIdentity: null });
      vi.spyOn(client, "request").mockResolvedValue({});

      await expect(
        Promise.resolve().then(() => prepared.start({ client, onManifestChanged: vi.fn() })),
      ).rejects.toBe(failure);
      await rollbackFinished.promise;
      await drainPluginRegistryResourceDisposals();
      expect(rollback).toHaveBeenCalledOnce();
      expect(resource.db.isOpen).toBe(false);
    });
  });

  it("waits for registered computer execution close before disposing the node's SQLite", async () => {
    await withOpenClawTestState({ label: "registered-computer-close" }, async (state) => {
      const resource = createResource();
      const closeStarted = createDeferredCore();
      const finishClose = createDeferredCore();
      let physicalCloseFinished = false;
      const physicalClose = vi.fn(async () => {
        expect(resource.db.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
        closeStarted.resolve();
        await finishClose.promise;
        physicalCloseFinished = true;
      });
      registerComputerUseProvider(
        {
          registerNodeHostCommand: (command) =>
            resource.registry.nodeHostCommands.push({
              pluginId: "node-fixture",
              source: "test",
              command,
            }),
        },
        {
          id: "synthetic-computer",
          label: "Synthetic computer",
          isAvailable: () => true,
          capabilities: () => ({
            contractVersion: 2,
            provider: { id: "synthetic-computer", label: "Synthetic computer", generation: "one" },
            actions: ["screenshot"],
            targets: ["screen"],
            deliveryModes: ["foreground"],
            observations: ["image"],
            features: { recording: false, agentCursor: false, multiDisplay: false },
          }),
          openExecution: async () => ({
            snapshot: async () => JSON.stringify({ format: "png", base64: "c3ludGhldGlj" }),
            act: async () => "{}",
            close: physicalClose,
          }),
        },
      );
      loadRegistry.mockReturnValue(resource);
      const prepared = await prepareNodeHostRuntime({
        config: { nodeHost: { skills: { enabled: false } } },
        env: state.env,
      });
      const client = new GatewayClient({ deviceIdentity: null });
      vi.spyOn(client, "request").mockResolvedValue({});
      const runtime = await prepared.start({ client, onManifestChanged: vi.fn() });
      let closing: Promise<void> | undefined;
      try {
        await runtime.invoke({
          id: "open-synthetic-execution",
          nodeId: "synthetic-node",
          command: "screen.snapshot",
          paramsJSON: JSON.stringify({ executionId: "123e4567-e89b-42d3-a456-426614174000" }),
        });
        let nodeClosed = false;
        closing = runtime.close().then(() => {
          nodeClosed = true;
        });
        await Promise.race([closeStarted.promise, closing]);
        // Flush the unblocked close work; the provider's physical-close gate is still held.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect.soft(nodeClosed).toBe(false);
        expect.soft(resource.db.isOpen).toBe(true);
        finishClose.resolve();
        await closing;
        expect(physicalClose).toHaveBeenCalledOnce();
        expect(physicalCloseFinished).toBe(true);
        await drainPluginRegistryResourceDisposals();
        expect(resource.db.isOpen).toBe(false);
      } finally {
        finishClose.resolve();
        await closing;
        await runtime.close();
      }
    });
  });

  it.each(["runtime", "command"] as const)(
    "retains failed registered computer close for %s retry without blocking failed-open recovery",
    async (retry) => {
      await withOpenClawTestState({ label: "registered-computer-close-retry" }, async (state) => {
        const resource = createResource();
        const closeFailure = new Error("synthetic physical close failed");
        const openFailure = new Error("synthetic open failed");
        let blocked = true;
        const physicalClose = vi.fn(async () => {
          if (blocked) {
            throw closeFailure;
          }
          expect(resource.db.prepare("SELECT 42 AS value").get()).toEqual({ value: 42 });
        });
        const openExecution = vi
          .fn(async () => ({
            snapshot: async () => "synthetic-snapshot",
            act: async () => "{}",
            close: physicalClose,
          }))
          .mockRejectedValueOnce(openFailure);
        registerComputerUseProvider(
          {
            registerNodeHostCommand: (command) =>
              resource.registry.nodeHostCommands.push({
                pluginId: "node-fixture",
                source: "test",
                command,
              }),
          },
          {
            id: "synthetic-computer",
            label: "Synthetic computer",
            isAvailable: () => true,
            capabilities: () => ({
              contractVersion: 2,
              provider: {
                id: "synthetic-computer",
                label: "Synthetic computer",
                generation: "one",
              },
              actions: ["screenshot"],
              targets: ["screen"],
              deliveryModes: ["foreground"],
              observations: ["image"],
              features: { recording: false, agentCursor: false, multiDisplay: false },
            }),
            openExecution,
          },
        );
        loadRegistry.mockReturnValue(resource);
        const prepared = await prepareNodeHostRuntime({
          config: { nodeHost: { skills: { enabled: false } } },
          env: state.env,
        });
        const client = new GatewayClient({ deviceIdentity: null });
        const request = vi.spyOn(client, "request").mockResolvedValue({});
        const runtime = await prepared.start({ client, onManifestChanged: vi.fn() });
        const executionId = "123e4567-e89b-42d3-a456-426614174000";
        const snapshot = () =>
          invokeRegisteredNodeHostCommand("screen.snapshot", JSON.stringify({ executionId }));
        try {
          await expect(snapshot()).rejects.toBe(openFailure);
          await expect(snapshot()).resolves.toBe("synthetic-snapshot");
          expect(openExecution).toHaveBeenCalledTimes(2);
          if (retry === "runtime") {
            await expect.soft(runtime.close()).rejects.toBe(closeFailure);
          } else {
            runtime.cancelAll();
            await runtime.invoke({
              id: "blocked-after-cleanup",
              nodeId: "synthetic-node",
              command: "screen.snapshot",
              paramsJSON: JSON.stringify({ executionId }),
            });
            expect(request).toHaveBeenCalledWith("node.invoke.result", {
              id: "blocked-after-cleanup",
              nodeId: "synthetic-node",
              ok: false,
              error: {
                code: "UNAVAILABLE",
                message: "Node plugin cleanup failed. Reconnect the node to retry cleanup.",
              },
            });
          }
          expect.soft(resource.db.isOpen).toBe(true);
          await expect.soft(snapshot()).rejects.toBe(closeFailure);
          expect.soft(openExecution).toHaveBeenCalledTimes(2);
          await expect(
            invokeRegisteredNodeHostCommand(
              "computer.act",
              JSON.stringify({
                executionId: "223e4567-e89b-42d3-a456-426614174000",
                action: "__close_execution",
              }),
            ),
          ).resolves.toBe('{"ok":true}');
          expect(physicalClose).toHaveBeenCalledOnce();
          blocked = false;
          if (retry === "command") {
            await expect(
              invokeRegisteredNodeHostCommand(
                "computer.act",
                JSON.stringify({
                  executionId,
                  action: "__close_execution",
                  reason: "retry",
                }),
              ),
            ).resolves.toBe('{"ok":true}');
          }
          await expect(runtime.close()).resolves.toBeUndefined();
          await drainPluginRegistryResourceDisposals();
          expect(resource.db.isOpen).toBe(false);
          expect(physicalClose).toHaveBeenCalledTimes(2);
        } finally {
          blocked = false;
          await runtime.close().catch(() => {});
        }
      });
    },
  );
});
