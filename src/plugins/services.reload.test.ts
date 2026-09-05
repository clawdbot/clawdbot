import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayStartupTrace } from "../gateway/server-startup-trace.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerPluginHttpRoute } from "./http-registry.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { listPluginServiceHealthFailures } from "./service-health.js";
import {
  PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
  startPluginServices,
  type PluginServicesHandle,
} from "./services.js";
import type { OpenClawPluginServiceContext } from "./types.js";

const handles = new Set<PluginServicesHandle>();
afterEach(async () => {
  await Promise.allSettled([...handles].map((handle) => handle.stop()));
  handles.clear();
});

const configFor = (endpoint: string): OpenClawConfig => ({
  diagnostics: { otel: { enabled: true, endpoint } },
});

it("replaces only selected services, retiring their routes and capabilities without losing sibling health", async () => {
  const contexts: OpenClawPluginServiceContext[] = [];
  const siblingContexts: OpenClawPluginServiceContext[] = [];
  const stops: OpenClawConfig[] = [];
  const broadcastPluginEvent = vi.fn();
  const registry = createEmptyPluginRegistry();
  registry.services.push(
    {
      pluginId: "exporter",
      origin: "workspace",
      source: "test",
      service: {
        id: "exporter",
        start(ctx) {
          contexts.push(ctx);
          registerPluginHttpRoute({ path: "/exporter", auth: "plugin", handler: vi.fn() });
        },
        stop(ctx) {
          stops.push(ctx.config);
        },
      },
    },
    {
      pluginId: "sibling",
      origin: "workspace",
      source: "test",
      service: {
        id: "sibling",
        start(ctx) {
          siblingContexts.push(ctx);
          ctx.serviceHealth?.reportFailure(new Error("unrelated service failure"));
        },
      },
    },
  );
  const first = configFor("https://first.example");
  const next = configFor("https://next.example");
  const handle = await startPluginServices({ registry, config: first, broadcastPluginEvent });
  handles.add(handle);
  await handle.reload(next, new Set(["exporter"]));

  expect(contexts.map((ctx) => ctx.config)).toEqual([first, next]);
  expect(stops).toEqual([first]);
  expect(siblingContexts).toHaveLength(1);
  expect(registry.httpRoutes).toHaveLength(1);
  expect(() => contexts[0]?.gatewayEvents?.emit("late", {}, { scope: "operator.read" })).toThrow(
    "no longer active",
  );
  contexts[0]?.serviceHealth?.reportFailure(new Error("retired exporter"));
  expect(listPluginServiceHealthFailures(registry)).toMatchObject([
    { pluginId: "sibling", error: "unrelated service failure" },
  ]);
  siblingContexts[0]?.gatewayEvents?.emit("still_alive", {}, { scope: "operator.read" });
  contexts[1]?.gatewayEvents?.emit("replacement", {}, { scope: "operator.read" });
  expect(broadcastPluginEvent).toHaveBeenCalledTimes(2);

  await handle.stop();
  expect(stops).toEqual([first, next]);
  expect(registry.httpRoutes).toEqual([]);
});

it("does not start a selected successor when Gateway shutdown overtakes its cleanup", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const start = vi.fn();
  const stop = vi.fn(() => {
    entered.resolve();
    return release.promise;
  });
  const registry = createEmptyPluginRegistry();
  registry.services.push({
    pluginId: "exporter",
    origin: "workspace",
    source: "test",
    service: { id: "exporter", start, stop },
  });
  const handle = await startPluginServices({
    registry,
    config: configFor("https://first.example"),
  });
  handles.add(handle);
  let result: Promise<unknown> | undefined;
  try {
    result = handle
      .reload(configFor("https://next.example"), new Set(["exporter"]))
      .catch((error: unknown) => error);
    await entered.promise;
    const stopping = handle.stop();
    release.resolve();
    await Promise.all([result, stopping]);
    expect(start).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    release.resolve();
    await result;
  }
});

it.each(["stop", "start"] as const)(
  "reports selected service %s failure while leaving unrelated services live",
  async (phase) => {
    let starts = 0;
    const siblingStop = vi.fn();
    const registry = createEmptyPluginRegistry();
    registry.services.push(
      {
        pluginId: "exporter",
        origin: "workspace",
        source: "test",
        service: {
          id: "exporter",
          start() {
            if (++starts > 1 && phase === "start") {
              throw new Error("replacement start rejected");
            }
          },
          stop() {
            if (phase === "stop") {
              throw new Error("replacement stop rejected");
            }
          },
        },
      },
      {
        pluginId: "sibling",
        origin: "workspace",
        source: "test",
        service: { id: "sibling", start() {}, stop: siblingStop },
      },
    );
    const handle = await startPluginServices({
      registry,
      config: configFor("https://first.example"),
    });
    handles.add(handle);
    await expect(
      handle.reload(configFor("https://next.example"), new Set(["exporter"])),
    ).rejects.toThrow();
    expect(starts).toBe(phase === "start" ? 2 : 1);
    expect(siblingStop).not.toHaveBeenCalled();
  },
);

it.each(["exporter", "sibling"] as const)(
  "preserves a selective %s stop requested before queued reload admission",
  async (stoppedPlugin) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const contexts = {
      exporter: [] as OpenClawPluginServiceContext[],
      sibling: [] as OpenClawPluginServiceContext[],
    };
    const registry = createEmptyPluginRegistry();
    for (const id of ["exporter", "sibling"] as const) {
      registry.services.push({
        pluginId: id,
        origin: "workspace",
        source: "test",
        service: {
          id,
          start: (ctx) => {
            contexts[id].push(ctx);
          },
          stop: async () => {
            entered.resolve();
            await release.promise;
          },
        },
      });
    }
    const broadcastPluginEvent = vi.fn();
    const handle = await startPluginServices({ registry, config: {}, broadcastPluginEvent });
    handles.add(handle);
    // Stop owns admission synchronously, before the queued reload gets its first microtask.
    const reloading = handle.reload(configFor("https://next.example"), new Set(["exporter"])).then(
      () => undefined,
      (error: unknown) => error,
    );
    const stopping = handle.stop({
      strict: true,
      deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
      pluginIds: new Set([stoppedPlugin]),
    });
    try {
      await entered.promise;
      release.resolve();
      await stopping;
      const result = await reloading;
      if (stoppedPlugin === "exporter") {
        expect(result).toMatchObject({ message: expect.stringContaining("stopping") });
        expect(contexts.exporter).toHaveLength(1);
        contexts.sibling[0]?.gatewayEvents?.emit("alive", {}, { scope: "operator.read" });
      } else {
        expect(result).toBeUndefined();
        expect(contexts.exporter).toHaveLength(2);
        contexts.exporter[1]?.gatewayEvents?.emit("alive", {}, { scope: "operator.read" });
      }
      expect(contexts.sibling).toHaveLength(1);
      expect(() =>
        contexts[stoppedPlugin][0]?.gatewayEvents?.emit("stale", {}, { scope: "operator.read" }),
      ).toThrow("no longer active");
      expect(broadcastPluginEvent).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([reloading, stopping]);
    }
  },
);

it("applies each queued service reload to the current service instance", async () => {
  const configs: OpenClawConfig[] = [];
  const stop = vi.fn();
  const registry = createEmptyPluginRegistry();
  registry.services.push({
    pluginId: "exporter",
    source: "test",
    origin: "workspace",
    service: {
      id: "exporter",
      start: (ctx) => {
        configs.push(ctx.config);
      },
      stop,
    },
  });
  const initial = configFor("https://initial.example");
  const first = configFor("https://first.example");
  const second = configFor("https://second.example");
  const handle = await startPluginServices({ registry, config: initial });
  handles.add(handle);
  await Promise.all([
    handle.reload(first, new Set(["exporter"])),
    handle.reload(second, new Set(["exporter"])),
  ]);
  expect(configs).toEqual([initial, first, second]);
  expect(stop).toHaveBeenCalledTimes(2);
});

it("reports retained failed cleanup on a later reload instead of silently skipping its owner", async () => {
  const start = vi.fn();
  const stop = vi.fn(() => {
    throw new Error("cleanup refused");
  });
  const registry = createEmptyPluginRegistry();
  registry.services.push({
    pluginId: "exporter",
    origin: "workspace",
    source: "test",
    service: { id: "exporter", start, stop },
  });
  const handle = await startPluginServices({ registry, config: {} });
  handles.add(handle);
  await expect(handle.reload({}, new Set(["exporter"]))).rejects.toThrow();
  await expect(handle.reload({}, new Set(["exporter"]))).rejects.toThrow();
  expect(start).toHaveBeenCalledOnce();
  expect(stop).toHaveBeenCalledOnce();
});

it.each(["strict startup", "reload"] as const)(
  "keeps the five-second service start deadline with real startup tracing during %s",
  async (phase) => {
    vi.useFakeTimers();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const contexts: OpenClawPluginServiceContext[] = [];
    const stop = vi.fn();
    const registry = createEmptyPluginRegistry();
    registry.services.push({
      pluginId: "exporter",
      origin: "workspace",
      source: "test",
      service: {
        id: "exporter",
        start: async (context) => {
          contexts.push(context);
          registerPluginHttpRoute({ path: "/traced-service", auth: "plugin", handler: vi.fn() });
          if (phase === "strict startup" || contexts.length > 1) {
            entered.resolve();
            await release.promise;
          }
        },
        stop,
      },
    });
    const startupTrace = createGatewayStartupTrace(createSubsystemLogger("test/service-startup"));
    const measure = vi.spyOn(startupTrace, "measure");
    const broadcastPluginEvent = vi.fn();
    let outcome: unknown;
    let operation: Promise<unknown> | undefined;
    try {
      if (phase === "strict startup") {
        operation = startPluginServices({
          registry,
          config: {},
          startupTrace,
          broadcastPluginEvent,
          throwOnStartError: true,
          onHandle: (handle) => handles.add(handle),
        });
      } else {
        const handle = await startPluginServices({
          registry,
          config: {},
          startupTrace,
          broadcastPluginEvent,
        });
        handles.add(handle);
        operation = handle.reload({}, new Set(["exporter"]));
      }
      operation = operation.then(
        () => {
          outcome = "completed";
        },
        (error: unknown) => {
          outcome = error;
        },
      );
      await entered.promise;
      await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
      expect(outcome).toBeInstanceOf(AggregateError);
      expect(outcome).toMatchObject({
        errors: expect.arrayContaining([
          expect.objectContaining({
            message: expect.stringContaining("plugin service startup timed out"),
          }),
        ]),
      });
      expect(stop).toHaveBeenCalledTimes(phase === "strict startup" ? 1 : 2);
      expect(measure).toHaveBeenCalledTimes(phase === "strict startup" ? 1 : 2);
      expect(registry.httpRoutes).toEqual([]);
      expect(() =>
        contexts.at(-1)?.gatewayEvents?.emit("late", {}, { scope: "operator.read" }),
      ).toThrow("no longer active");
      expect(broadcastPluginEvent).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await operation;
      await Promise.allSettled([...handles].map((handle) => handle.stop()));
      vi.useRealTimers();
    }
  },
);

it.each([false, true])(
  "transfers an admitted reload restart with its handle (successor stopped=%s)",
  async (stopSuccessor) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const contexts: OpenClawPluginServiceContext[] = [];
    const service = {
      id: "reloading",
      start: vi.fn((context: OpenClawPluginServiceContext) => {
        contexts.push(context);
      }),
      stop: vi.fn(async () => {
        entered.resolve();
        await release.promise;
      }),
    };
    const sibling = { id: "sibling", start: vi.fn(), stop: vi.fn() };
    const registry = createEmptyPluginRegistry();
    for (const entry of [service, sibling]) {
      registry.services.push({
        pluginId: "plugin:test",
        service: entry,
        source: "test",
        origin: "workspace",
        rootDir: "/plugins/test-plugin",
      });
    }
    const initialConfig: OpenClawConfig = {};
    const reloadConfig: OpenClawConfig = {};
    const successorConfig: OpenClawConfig = {};
    const previous = await startPluginServices({
      registry,
      config: initialConfig,
      getCronService: () => undefined,
    });
    const reloading = previous.reload(reloadConfig, new Set([service.id]));
    let successor: PluginServicesHandle | undefined;
    let starting: Promise<PluginServicesHandle> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      await entered.promise;
      const nextRegistry = createEmptyPluginRegistry();
      nextRegistry.services.push(...registry.services);
      starting = startPluginServices({
        registry: nextRegistry,
        config: successorConfig,
        getCronService: () => undefined,
        previous,
        onHandle: (handle) => {
          successor = handle;
        },
      });
      if (stopSuccessor) {
        stopping = successor!.stop();
      }
      expect(service.start).toHaveBeenCalledOnce();
      release.resolve();
      await Promise.all([reloading, starting, stopping]);
      expect(service.start).toHaveBeenCalledTimes(stopSuccessor ? 1 : 2);
      expect(service.stop).toHaveBeenCalledOnce();
      expect(() => contexts[0]!.getCron?.()).toThrow("no longer active");
      expect(sibling.start).toHaveBeenCalledOnce();
      expect(sibling.stop).toHaveBeenCalledTimes(stopSuccessor ? 1 : 0);
      await previous.stop();
      if (!stopSuccessor) {
        expect(contexts[1]!.config).toBe(successorConfig);
        expect(() => contexts[1]!.getCron?.()).not.toThrow();
      }
    } finally {
      release.resolve();
      await Promise.allSettled([reloading, starting, stopping]);
      await successor?.stop();
      await previous.stop();
    }
    expect(service.stop).toHaveBeenCalledTimes(stopSuccessor ? 1 : 2);
  },
);
