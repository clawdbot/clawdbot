import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import {
  formatPropagatedDiagnosticTraceparent,
  resetDiagnosticTracePropagationForTest,
} from "../infra/diagnostic-trace-propagation.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  type DiagnosticExporterHealthUpdate,
} from "../logging/diagnostic-stability.js";
import { createDeferredCore } from "../shared/deferred.js";
import { queuePluginSessionsChanged } from "./gateway-events.js";
import { registerPluginHttpRoute, withPluginHttpRouteRegistry } from "./http-registry.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { resetPluginRuntimeStateForTest } from "./runtime.js";
import { listPluginServiceHealthFailures } from "./service-health.js";
import {
  PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
  startPluginServices,
  type PluginServicesHandle,
} from "./services.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "./types.js";

const mockedLogger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(() => mockedLogger),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => mockedLogger,
}));

function createRegistry(
  services: OpenClawPluginService[],
  pluginId = "plugin:test",
  origin: PluginOrigin = "workspace",
) {
  const registry = createEmptyPluginRegistry();
  registry.services = services.map((service) => ({
    pluginId,
    service,
    source: "test",
    origin,
    rootDir: "/plugins/test-plugin",
  })) as typeof registry.services;
  return registry;
}

const createServiceConfig = () => ({}) as Parameters<typeof startPluginServices>[0]["config"];

describe("plugin service replacement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDiagnosticEventsForTest();
    resetDiagnosticTracePropagationForTest();
    resetDiagnosticStabilityRecorderForTest();
    resetPluginRuntimeStateForTest();
  });

  it.each(["initial", "reload"] as const)("retries a failed %s service start", async (phase) => {
    let attempts = 0;
    let ready = false;
    const order: string[] = [];
    const failAt = phase === "initial" ? 1 : 2;
    const failure = new Error("transient service start failure");
    const start = vi.fn(() => {
      order.push("dependency");
      if (++attempts === failAt) {
        throw failure;
      }
      ready = true;
    });
    const stop = vi.fn(() => {
      ready = false;
    });
    const siblingStart = vi.fn(() => {
      order.push("dependent");
      if (!ready) {
        throw new Error("dependency service is not running");
      }
    });
    const registry = createRegistry([
      { id: "retry-service", start, stop },
      { id: "sibling", start: siblingStart, stop: () => {} },
    ]);
    const serviceIds = new Set(["retry-service", "sibling"]);
    const config = createServiceConfig();
    const handle = await startPluginServices({ registry, config });
    try {
      if (phase === "reload") {
        await expect(handle.reload(config, serviceIds)).rejects.toThrow();
      }
      expect(listPluginServiceHealthFailures(registry)).toContainEqual(
        expect.objectContaining({ serviceId: "retry-service", error: failure.message }),
      );
      await handle.reload(config, serviceIds);
      expect(order.slice(-2)).toEqual(["dependency", "dependent"]);
      expect(start).toHaveBeenCalledTimes(failAt + 1);
      expect(siblingStart).toHaveBeenCalledTimes(2);
      expect(listPluginServiceHealthFailures(registry)).toEqual([]);
    } finally {
      await handle.stop();
    }
  });

  it.each(["initial", "reload"] as const)(
    "cleans resources acquired after strict stop times out during %s startup",
    async (phase) => {
      vi.useFakeTimers();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const event = `service-late-start-${phase}`;
      const listener = () => {};
      const listenerCount = process.listenerCount(event);
      const order: string[] = [];
      const stop = vi.fn(() => {
        order.push("producer-stop");
        process.off(event, listener);
      });
      const exporterStop = vi.fn(() => {
        order.push("exporter-stop");
      });
      let attempts = 0;
      const blockedAttempt = phase === "initial" ? 1 : 2;
      const registry = createRegistry([
        {
          id: "late-resource",
          start: async () => {
            if (++attempts === blockedAttempt) {
              entered.resolve();
              await release.promise;
            }
            process.on(event, listener);
          },
          stop,
        },
      ]);
      registry.services.unshift(
        ...createRegistry(
          [{ id: "diagnostics-otel", start: () => {}, stop: exporterStop }],
          "diagnostics-otel",
          "bundled",
        ).services,
      );
      let handle!: PluginServicesHandle;
      const config = createServiceConfig();
      const starting = startPluginServices({
        registry,
        config,
        onHandle: (value) => {
          handle = value;
        },
      });
      let transition: Promise<unknown> = starting;
      let stopping: Promise<unknown> | undefined;
      try {
        if (phase === "reload") {
          await starting;
          transition = handle.reload(config, new Set(["late-resource"]));
        }
        await entered.promise;
        stopping = handle
          .stop({ strict: true, deadlineAtMs: Date.now() + 100 })
          .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(100);
        expect(await stopping).toBeInstanceOf(AggregateError);
        const earlyStops = stop.mock.calls.length;
        const earlyExporterStops = exporterStop.mock.calls.length;
        release.resolve();
        await transition;
        await handle.stop();
        expect(process.listenerCount(event)).toBe(listenerCount);
        expect(earlyStops).toBe(blockedAttempt - 1);
        expect(earlyExporterStops).toBe(0);
        expect(stop).toHaveBeenCalledTimes(blockedAttempt);
        expect(exporterStop).toHaveBeenCalledOnce();
        expect(order.slice(-2)).toEqual(["producer-stop", "exporter-stop"]);
      } finally {
        release.resolve();
        await Promise.allSettled([starting, transition, stopping]);
        await handle.stop();
        process.off(event, listener);
        vi.useRealTimers();
      }
    },
  );

  it("cleans a started sibling while another startup remains unsettled", async () => {
    vi.useFakeTimers();
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const event = "service-started-sibling";
    const listener = () => {};
    const before = process.listenerCount(event);
    let handle!: PluginServicesHandle;
    const starting = startPluginServices({
      registry: createRegistry([
        {
          id: "started-sibling",
          start: () => {
            process.on(event, listener);
          },
          stop: () => {
            process.off(event, listener);
          },
        },
        {
          id: "pending-start",
          start: () => {
            entered.resolve();
            return release.promise;
          },
        },
      ]),
      config: createServiceConfig(),
      onHandle: (value) => {
        handle = value;
      },
    });
    let stopping: Promise<unknown> | undefined;
    try {
      await entered.promise;
      stopping = handle
        .stop({ strict: true, deadlineAtMs: Date.now() + 100 })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(100);
      expect(await stopping).toBeInstanceOf(AggregateError);
      expect(process.listenerCount(event)).toBe(before);
    } finally {
      release.resolve();
      await starting;
      await stopping;
      await handle.stop();
      process.off(event, listener);
      vi.useRealTimers();
    }
  });

  it.each(["ordinary", "strict-first", "strict-last"] as const)(
    "shares cleanup while preserving concurrent %s shutdown deadlines",
    async (mode) => {
      vi.useFakeTimers();
      const cleanup = createDeferredCore();
      const stop = vi.fn(() => cleanup.promise);
      const handle = await startPluginServices({
        registry: createRegistry([{ id: "service", start: () => {}, stop }]),
        config: createServiceConfig(),
      });
      const strict = { strict: true as const, deadlineAtMs: Date.now() + 100 };
      const outcomes: unknown[] = [];
      const observers = [
        handle.stop(mode === "strict-first" ? strict : undefined),
        handle.stop(mode === "strict-last" ? strict : undefined),
      ].map((promise, index) =>
        promise.then(
          () => {
            outcomes[index] = "settled";
          },
          (error: unknown) => {
            outcomes[index] = error;
          },
        ),
      );

      try {
        await vi.advanceTimersByTimeAsync(100);
        if (mode !== "ordinary") {
          const strictIndex = mode === "strict-first" ? 0 : 1;
          expect(outcomes[strictIndex]).toBeInstanceOf(AggregateError);
          expect(outcomes[1 - strictIndex]).toBeUndefined();
        }
        cleanup.resolve();
        await Promise.all(observers);
        if (mode === "ordinary") {
          expect(outcomes).toEqual(["settled", "settled"]);
        } else {
          expect(outcomes[mode === "strict-first" ? 1 : 0]).toBe("settled");
        }
        expect(stop).toHaveBeenCalledOnce();

        await handle.stop();
        expect(stop).toHaveBeenCalledOnce();
      } finally {
        cleanup.resolve();
        await Promise.all(observers);
        vi.useRealTimers();
      }
    },
  );

  it("strictly aggregates ordinary and exporter failures while draining producers first", async () => {
    const order: string[] = [];
    const ordinaryFailure = new Error("ordinary cleanup rejected");
    const exporterFailure = new Error("exporter cleanup rejected");
    const registry = createRegistry([
      {
        id: "ordinary-first",
        start: () => {},
        stop: () => {
          order.push("ordinary-first");
          emitTrustedDiagnosticEvent({
            type: "log.record",
            level: "INFO",
            message: "queued before exporter shutdown",
          });
          throw ordinaryFailure;
        },
      },
      {
        id: "ordinary-second",
        start: () => {},
        stop: () => {
          order.push("ordinary-second");
        },
      },
    ]);
    registry.services.push(
      ...createRegistry(
        [
          {
            id: "diagnostics-prometheus",
            start: () => {},
            stop: () => {
              order.push("prometheus");
            },
          },
        ],
        "diagnostics-prometheus",
        "bundled",
      ).services,
      ...createRegistry(
        [
          {
            id: "diagnostics-otel",
            start: (ctx) => {
              ctx.internalDiagnostics?.onEvent((event) => {
                if (event.type === "log.record") {
                  order.push("drained");
                }
              });
            },
            stop: () => {
              order.push("otel");
              throw exporterFailure;
            },
          },
        ],
        "diagnostics-otel",
        "bundled",
      ).services,
    );
    const handle = await startPluginServices({ registry, config: createServiceConfig() });
    const failure = await handle
      .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([
      expect.objectContaining({
        cause: ordinaryFailure,
        message: expect.stringContaining("plugin=plugin:test, service=ordinary-first"),
      }),
      expect.objectContaining({
        cause: exporterFailure,
        message: expect.stringContaining("plugin=diagnostics-otel, service=diagnostics-otel"),
      }),
    ]);
    expect(order).toEqual(["ordinary-second", "ordinary-first", "drained", "otel", "prometheus"]);
  });

  it("bounds strict cleanup and fences timed-out service routes, events, and health", async () => {
    vi.useFakeTimers();
    let releaseCleanup: (() => void) | undefined;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const received = vi.fn();
    const siblingStop = vi.fn();
    const broadcastPluginEvent = vi.fn();
    const lateFailures: unknown[] = [];
    const nestedRegistry = createEmptyPluginRegistry();
    let context: OpenClawPluginServiceContext | undefined;
    const registry = createRegistry([
      { id: "sibling", start: () => {}, stop: siblingStop },
      {
        id: "blocked-cleanup",
        start: (ctx) => {
          context = ctx;
          ctx.gatewayEvents?.onSessionsChanged(received);
          registerPluginHttpRoute({ path: "/owned-route", auth: "plugin", handler: vi.fn() });
        },
        stop: async (ctx) => {
          await cleanupReleased;
          ctx.serviceHealth?.reportFailure(new Error("late stale failure"));
          for (const run of [
            () => ctx.gatewayEvents?.emit("late", {}, { scope: "operator.read" }),
            () =>
              registerPluginHttpRoute({
                path: "/late-anonymous-route",
                auth: "plugin",
                handler: vi.fn(),
                throwOnFailure: true,
              }),
            () =>
              withPluginHttpRouteRegistry(nestedRegistry, () =>
                registerPluginHttpRoute({
                  path: "/late-nested-route",
                  auth: "plugin",
                  handler: vi.fn(),
                  throwOnFailure: true,
                }),
              ),
            () =>
              withPluginHttpRouteRegistry(
                nestedRegistry,
                () =>
                  registerPluginHttpRoute({
                    path: "/late-replacement-lease-route",
                    auth: "plugin",
                    handler: vi.fn(),
                    throwOnFailure: true,
                  }),
                { isActive: () => true, retain: (cleanup) => cleanup },
              ),
          ]) {
            try {
              run();
            } catch (error) {
              lateFailures.push(error);
            }
          }
        },
      },
    ]);
    let stopping: Promise<void> | undefined;

    try {
      const handle = await startPluginServices({
        registry,
        config: createServiceConfig(),
        broadcastPluginEvent,
      });
      let failure: unknown;
      stopping = handle
        .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
        .catch((error: unknown) => {
          failure = error;
        });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([
        expect.objectContaining({
          message: expect.stringMatching(/plugin=plugin:test, service=blocked-cleanup.*timed out/),
        }),
      ]);
      expect(siblingStop).toHaveBeenCalledOnce();
      expect(registry.httpRoutes).toEqual([]);
      expect(() => context?.gatewayEvents?.onSessionsChanged(received)).toThrow("no longer active");

      releaseCleanup?.();
      await Promise.resolve();
      await Promise.resolve();
      queuePluginSessionsChanged({ sessionKey: "agent:main:main" });
      await Promise.resolve();

      expect(lateFailures).toHaveLength(4);
      expect(received).not.toHaveBeenCalled();
      expect(broadcastPluginEvent).not.toHaveBeenCalled();
      expect(listPluginServiceHealthFailures(registry)).toEqual([]);
      expect(registry.httpRoutes).toEqual([]);
      expect(nestedRegistry.httpRoutes).toEqual([]);
    } finally {
      releaseCleanup?.();
      await stopping;
      vi.useRealTimers();
    }
  });

  it("bounds failed-start cleanup and retains it for final shutdown", async () => {
    vi.useFakeTimers();
    const cleanup = createDeferredCore();
    const stop = vi.fn(() => cleanup.promise);
    const broadcastPluginEvent = vi.fn();
    const siblingStart = vi.fn();
    let context: OpenClawPluginServiceContext | undefined;
    const registry = createRegistry([
      {
        id: "failed-start-hung-stop",
        start: (ctx) => {
          context = ctx;
          throw new Error("startup rejected");
        },
        stop,
      },
      { id: "sibling", start: siblingStart },
    ]);
    let starting: Promise<PluginServicesHandle> | undefined;
    let stopping: Promise<void> | undefined;
    let settled = false;

    try {
      starting = startPluginServices({
        registry,
        config: createServiceConfig(),
        broadcastPluginEvent,
      }).then((handle) => {
        settled = true;
        return handle;
      });
      await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);

      expect(settled).toBe(true);
      const handle = await starting;
      expect(siblingStart).toHaveBeenCalledOnce();
      expect(mockedLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("plugin service failed (failed-start-hung-stop"),
      );
      expect(mockedLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("plugin service stop failed (failed-start-hung-stop)"),
      );
      expect(() => context?.gatewayEvents?.emit("late", {}, { scope: "operator.read" })).toThrow(
        "no longer active",
      );
      expect(broadcastPluginEvent).not.toHaveBeenCalled();
      let cleanupSettled = false;
      stopping = handle.stop().then(() => {
        cleanupSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanupSettled).toBe(false);
      expect(stop).toHaveBeenCalledOnce();
      cleanup.resolve();
      await stopping;
    } finally {
      cleanup.resolve();
      await Promise.allSettled([starting, stopping]);
      vi.useRealTimers();
    }
  });

  it("honors a replacement deadline inherited after ownership consumed most of its budget", async () => {
    vi.useFakeTimers();
    const broadcastPluginEvent = vi.fn();
    let releaseCleanup: (() => void) | undefined;
    const cleanupReleased = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let context: OpenClawPluginServiceContext | undefined;
    const registry = createRegistry([
      {
        id: "late-owner",
        start: (serviceContext) => {
          context = serviceContext;
          registerPluginHttpRoute({ path: "/deadline-route", auth: "plugin", handler: vi.fn() });
        },
        stop: async (serviceContext) => {
          await cleanupReleased;
          serviceContext.gatewayEvents?.emit("late", {}, { scope: "operator.read" });
        },
      },
    ]);
    let stopping: Promise<void> | undefined;

    try {
      const handle = await startPluginServices({
        registry,
        config: createServiceConfig(),
        broadcastPluginEvent,
      });
      const deadlineAtMs = Date.now() + 100;
      let failure: unknown;
      stopping = handle.stop({ strict: true, deadlineAtMs }).catch((error: unknown) => {
        failure = error;
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(failure).toBeUndefined();
      expect(registry.httpRoutes).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(registry.httpRoutes).toEqual([]);
      expect(() => context?.gatewayEvents?.emit("late", {}, { scope: "operator.read" })).toThrow(
        "no longer active",
      );
      expect(broadcastPluginEvent).not.toHaveBeenCalled();
    } finally {
      releaseCleanup?.();
      await stopping;
      vi.useRealTimers();
    }
  });

  it("bounds strict shutdown while startup is unsettled and revokes its late continuation", async () => {
    vi.useFakeTimers();
    let releaseStartup: (() => void) | undefined;
    const startupReleased = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const broadcastPluginEvent = vi.fn();
    const lateFailures: unknown[] = [];
    let lifecycleHandle: PluginServicesHandle | undefined;
    const registry = createRegistry([
      {
        id: "blocked-startup",
        start: async (ctx) => {
          await startupReleased;
          ctx.serviceHealth?.reportFailure(new Error("late startup failure"));
          for (const run of [
            () => ctx.gatewayEvents?.emit("late", {}, { scope: "operator.read" }),
            () =>
              registerPluginHttpRoute({
                path: "/late-startup-route",
                auth: "plugin",
                handler: vi.fn(),
                throwOnFailure: true,
              }),
          ]) {
            try {
              run();
            } catch (error) {
              lateFailures.push(error);
            }
          }
        },
      },
    ]);
    const starting = startPluginServices({
      registry,
      config: createServiceConfig(),
      broadcastPluginEvent,
      onHandle: (handle) => {
        lifecycleHandle = handle;
      },
    });
    let stopping: Promise<void> | undefined;

    try {
      let failure: unknown;
      stopping = lifecycleHandle!
        .stop({ strict: true, deadlineAtMs: Date.now() + 5_000 })
        .catch((error: unknown) => {
          failure = error;
        });
      await vi.advanceTimersByTimeAsync(5_000);

      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors[0]).toMatchObject({
        message: expect.stringContaining("plugin service startup settlement timed out"),
      });

      releaseStartup?.();
      await starting;
      await stopping;
      expect(lateFailures).toHaveLength(2);
      expect(broadcastPluginEvent).not.toHaveBeenCalled();
      expect(listPluginServiceHealthFailures(registry)).toEqual([]);
      expect(registry.httpRoutes).toEqual([]);
    } finally {
      releaseStartup?.();
      await starting;
      await stopping;
      vi.useRealTimers();
    }
  });

  it.each(["fulfilled", "rejected", "pending"] as const)(
    "does not repeat %s cleanup when startup fails after replacement settles",
    async (cleanupState) => {
      vi.useFakeTimers();
      const startup = createDeferredCore();
      const cleanup = createDeferredCore();
      const order: string[] = [];
      const stop = vi.fn(() => {
        order.push("stop");
        if (cleanupState === "rejected") {
          throw new Error("cleanup rejected");
        }
        return cleanupState === "pending" ? cleanup.promise : undefined;
      });
      let lifecycleHandle!: PluginServicesHandle;
      const starting = startPluginServices({
        registry: createRegistry([
          {
            id: "interrupted-startup",
            start: () => {
              order.push("start");
              return startup.promise;
            },
            stop,
          },
        ]),
        config: createServiceConfig(),
        onHandle: (handle) => {
          lifecycleHandle = handle;
        },
      });
      const stopping = lifecycleHandle.stop({
        strict: true,
        deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
      });
      const stopped = stopping.catch((error: unknown) => error);

      try {
        await vi.advanceTimersByTimeAsync(PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS);
        const failure = await stopped;
        expect(failure).toBeInstanceOf(AggregateError);
        expect((failure as AggregateError).errors[0]).toMatchObject({
          message: expect.stringContaining("plugin service startup settlement timed out"),
        });
        order.push("replacement-settled");
        startup.reject(new Error("startup failed after replacement"));
        await vi.advanceTimersByTimeAsync(0);

        expect(stop).toHaveBeenCalledOnce();
        expect(order).toEqual(["start", "replacement-settled", "stop"]);
        cleanup.resolve();
        await starting;
        await expect(lifecycleHandle.stop()).resolves.toBeUndefined();
        expect(stop).toHaveBeenCalledOnce();
      } finally {
        startup.reject(new Error("startup test cleanup"));
        cleanup.resolve();
        await starting;
        await stopped;
        vi.useRealTimers();
      }
    },
  );

  it("revokes trusted diagnostics listeners, emitters, bridges, and exporter health with their service", async () => {
    const listener = vi.fn();
    const lateListener = vi.fn();
    const traceContext = {
      traceId: "1234567890abcdef1234567890abcdef",
      spanId: "1234567890abcdef",
    };
    let context: OpenClawPluginServiceContext | undefined;
    const registry = createRegistry(
      [
        {
          id: "diagnostics-otel",
          start: (ctx) => {
            context = ctx;
            ctx.internalDiagnostics?.onEvent(listener);
            ctx.internalDiagnostics?.registerTracePropagationBridge?.({
              resolveTraceContext: () => undefined,
            });
            registerPluginHttpRoute({ path: "/exporter-route", auth: "plugin", handler: vi.fn() });
          },
        },
      ],
      "diagnostics-otel",
      "bundled",
    );
    const handle = await startPluginServices({ registry, config: createServiceConfig() });

    expect(formatPropagatedDiagnosticTraceparent(traceContext)).toBeUndefined();
    await handle.stop();

    expect(() =>
      context?.internalDiagnostics?.emit({ type: "log.record", level: "INFO", message: "late" }),
    ).toThrow("no longer active");
    expect(() => context?.internalDiagnostics?.onEvent(lateListener)).toThrow("no longer active");
    expect(() =>
      context?.internalDiagnostics?.registerTracePropagationBridge?.({
        resolveTraceContext: () => undefined,
      }),
    ).toThrow("no longer active");
    (
      context?.internalDiagnostics as
        | (NonNullable<OpenClawPluginServiceContext["internalDiagnostics"]> & {
            reportExporterHealth?: (update: DiagnosticExporterHealthUpdate) => void;
          })
        | undefined
    )?.reportExporterHealth?.({
      signal: "traces",
      transport: "otlp-http-protobuf",
      status: "failure",
      reason: "export_failed",
    });
    emitTrustedDiagnosticEvent({ type: "log.record", level: "INFO", message: "still active" });

    expect(listener).not.toHaveBeenCalled();
    expect(lateListener).not.toHaveBeenCalled();
    expect(formatPropagatedDiagnosticTraceparent(traceContext)).toBe(
      "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
    );
    expect(
      getDiagnosticStabilitySnapshot({ type: "telemetry.exporter", limit: 1000 }).events,
    ).toEqual([]);
    expect(registry.httpRoutes).toEqual([]);
  });
});
