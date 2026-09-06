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
        expect(order).toEqual(["start", "stop", "replacement-settled"]);
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
