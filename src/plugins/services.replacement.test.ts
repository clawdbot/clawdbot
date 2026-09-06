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

  it.each([
    { phase: "ready", selection: "all", rejects: false },
    { phase: "ready", selection: "selected", rejects: false },
    { phase: "starting", selection: "selected", rejects: false },
    { phase: "ready", selection: "selected", rejects: true },
  ] as const)(
    "owns a requested $selection stop across $phase handoff (rejects: $rejects)",
    async ({ phase, selection, rejects }) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const failure = new Error("selected cleanup rejected");
      const contexts = new Map<string, OpenClawPluginServiceContext[]>();
      const stopped = { selected: vi.fn(), sibling: vi.fn() };
      stopped.selected.mockImplementation(() => {
        if (rejects) {
          throw failure;
        }
      });
      const makeService = (id: "selected" | "sibling"): OpenClawPluginService => ({
        id,
        start: (context) => {
          const issued = contexts.get(id) ?? [];
          issued.push(context);
          contexts.set(id, issued);
          if (id === "selected" && phase === "starting" && issued.length === 1) {
            entered.resolve();
            return release.promise;
          }
          return undefined;
        },
        stop: stopped[id],
      });
      const registry = createRegistry([makeService("selected")], "selected");
      registry.services.push(...createRegistry([makeService("sibling")], "sibling").services);
      const handles: PluginServicesHandle[] = [];
      let previous!: PluginServicesHandle;
      const starting = startPluginServices({
        registry,
        config: createServiceConfig(),
        getCronService: () => undefined,
        onHandle: (handle) => {
          previous = handle;
          handles.push(handle);
        },
      });
      let stopOutcome: Promise<unknown> | undefined;
      try {
        if (phase === "starting") {
          await entered.promise;
        } else {
          await starting;
        }
        const oldContext = contexts.get("selected")![0]!;
        stopOutcome = previous
          .stop(
            selection === "selected"
              ? { strict: true, deadlineAtMs: Date.now() + 5_000, pluginIds: new Set(["selected"]) }
              : undefined,
          )
          .catch((error: unknown) => error);
        expect(() => oldContext.getCron?.()).toThrow("stopping");
        const successor = await startPluginServices({
          registry,
          config: createServiceConfig(),
          getCronService: () => undefined,
          previous,
          onHandle: (handle) => handles.push(handle),
        });
        release.resolve();
        await starting;
        const outcome = await stopOutcome;
        expect(stopped.selected).toHaveBeenCalledOnce();
        expect(() => oldContext.getCron?.()).toThrow("no longer active");
        expect(stopped.sibling).toHaveBeenCalledTimes(selection === "all" ? 1 : 0);
        expect(contexts.get("selected")).toHaveLength(1);
        expect(contexts.get("sibling")).toHaveLength(1);
        if (rejects) {
          expect(outcome).toBeInstanceOf(AggregateError);
          await expect(
            successor.stop({
              strict: true,
              deadlineAtMs: Date.now() + 5_000,
              pluginIds: new Set(["selected"]),
            }),
          ).rejects.toThrow("plugin service replacement cleanup failed");
          expect(stopped.selected).toHaveBeenCalledOnce();
        } else {
          expect(outcome).toBeUndefined();
          await startPluginServices({
            registry,
            config: createServiceConfig(),
            getCronService: () => undefined,
            previous: successor,
            onHandle: (handle) => handles.push(handle),
          });
          expect(contexts.get("selected")).toHaveLength(2);
          expect(() => contexts.get("selected")![1]!.getCron?.()).not.toThrow();
          expect(contexts.get("sibling")).toHaveLength(selection === "all" ? 2 : 1);
        }
      } finally {
        release.resolve();
        await starting;
        await stopOutcome;
        for (const handle of handles.toReversed()) {
          await handle.stop();
        }
      }
    },
  );

  it("transfers an unchanged service without restarting it and stops only the replaced owner", async () => {
    const first = { id: "first", start: vi.fn(), stop: vi.fn() };
    const sibling = { id: "sibling", start: vi.fn(), stop: vi.fn() };
    const replacement = { id: "first", start: vi.fn(), stop: vi.fn() };
    const oldRegistry = createRegistry([first], "first");
    const siblingRegistration = createRegistry([sibling], "sibling").services[0]!;
    oldRegistry.services.push(siblingRegistration);
    const previous = await startPluginServices({
      registry: oldRegistry,
      config: createServiceConfig(),
    });
    await previous.stop({
      strict: true,
      deadlineAtMs: Date.now() + 5_000,
      pluginIds: new Set(["first"]),
    });
    const nextRegistry = createRegistry([replacement], "first");
    nextRegistry.services.push(siblingRegistration);
    let current: PluginServicesHandle | undefined;
    try {
      await startPluginServices({
        registry: nextRegistry,
        config: createServiceConfig(),
        previous,
        onHandle: (handle) => {
          current = handle;
        },
        throwOnStartError: true,
      });
      expect(first.stop).toHaveBeenCalledOnce();
      expect(replacement.start).toHaveBeenCalledOnce();
      expect(sibling.start).toHaveBeenCalledOnce();
      expect(sibling.stop).not.toHaveBeenCalled();
    } finally {
      await current?.stop();
      await previous.stop();
    }
    expect(sibling.stop).toHaveBeenCalledOnce();
    expect(replacement.stop).toHaveBeenCalledOnce();
  });

  it.each(["queued registration", "failed retained startup"] as const)(
    "keeps one service owner after handoff with %s",
    async (outcome) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const ready = { id: "ready", start: vi.fn(), stop: vi.fn() };
      let attempts = 0;
      const blocked = {
        id: "blocked",
        start: vi.fn(async () => {
          const attempt = ++attempts;
          entered.resolve();
          await release.promise;
          if (outcome === "failed retained startup" && attempt === 1) {
            throw new Error("retained startup rejected");
          }
        }),
        stop: vi.fn(),
      };
      const queued = { id: "queued", start: vi.fn(), stop: vi.fn() };
      const previousRegistry = createRegistry([
        ready,
        blocked,
        ...(outcome === "queued registration" ? [queued] : []),
      ]);
      let previous!: PluginServicesHandle;
      let successor: PluginServicesHandle | undefined;
      const starting = startPluginServices({
        registry: previousRegistry,
        config: createServiceConfig(),
        onHandle: (handle) => {
          previous = handle;
        },
      });
      try {
        await entered.promise;
        const registry = createEmptyPluginRegistry();
        registry.services.push(...previousRegistry.services);
        successor = await startPluginServices({
          registry,
          config: createServiceConfig(),
          previous,
        });
        release.resolve();
        await starting;
        expect(ready.start).toHaveBeenCalledOnce();
        expect(blocked.start).toHaveBeenCalledOnce();
        expect(queued.start).toHaveBeenCalledTimes(outcome === "queued registration" ? 1 : 0);
        expect(blocked.stop).toHaveBeenCalledTimes(outcome === "failed retained startup" ? 1 : 0);
        const transferred = successor;
        successor = await startPluginServices({
          registry,
          config: createServiceConfig(),
          previous: transferred,
        });
        await transferred.stop();
        await previous.stop();
        expect(blocked.start).toHaveBeenCalledTimes(outcome === "failed retained startup" ? 2 : 1);
        expect(ready.start).toHaveBeenCalledOnce();
        expect(ready.stop).not.toHaveBeenCalled();
        expect(queued.stop).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await starting;
        await previous.stop();
        await successor?.stop();
      }
      expect(ready.stop).toHaveBeenCalledOnce();
      expect(blocked.stop).toHaveBeenCalledTimes(outcome === "failed retained startup" ? 2 : 1);
      expect(queued.stop).toHaveBeenCalledTimes(outcome === "queued registration" ? 1 : 0);
    },
  );

  it("keeps unchanged services with the issued handle when a candidate cannot start", async () => {
    const sibling = { id: "sibling", start: vi.fn(), stop: vi.fn() };
    const oldRegistry = createRegistry([sibling], "sibling");
    const previous = await startPluginServices({
      registry: oldRegistry,
      config: createServiceConfig(),
    });
    const broken = {
      id: "broken",
      start: () => {
        throw new Error("candidate failed");
      },
      stop: vi.fn(),
    };
    const nextRegistry = createRegistry([broken], "broken");
    nextRegistry.services.push(...oldRegistry.services);
    let issued: PluginServicesHandle | undefined;
    try {
      await expect(
        startPluginServices({
          registry: nextRegistry,
          config: createServiceConfig(),
          previous,
          onHandle: (handle) => {
            issued = handle;
          },
          throwOnStartError: true,
        }),
      ).rejects.toThrow("plugin services failed to start");
      expect(issued).toBeDefined();
      expect(broken.stop).toHaveBeenCalledOnce();
      expect(sibling.start).toHaveBeenCalledOnce();
      expect(sibling.stop).not.toHaveBeenCalled();
      await previous.stop();
      expect(sibling.stop).not.toHaveBeenCalled();
      await issued?.stop();
      expect(sibling.stop).toHaveBeenCalledOnce();
    } finally {
      await issued?.stop();
      await previous.stop();
    }
  });

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
      const health = listPluginServiceHealthFailures(registry);
      expect(health).toEqual([
        expect.objectContaining({
          pluginId: "plugin:test",
          serviceId: "blocked-cleanup",
          error: expect.stringContaining("stop timed out"),
        }),
      ]);

      releaseCleanup?.();
      await Promise.resolve();
      await Promise.resolve();
      queuePluginSessionsChanged({ sessionKey: "agent:main:main" });
      await Promise.resolve();

      expect(lateFailures).toHaveLength(4);
      expect(received).not.toHaveBeenCalled();
      expect(broadcastPluginEvent).not.toHaveBeenCalled();
      expect(listPluginServiceHealthFailures(registry)).toEqual(health);
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

  it.each(["ready", "starting"] as const)(
    "selectively stops the %s service without revoking its sibling",
    async (selected) => {
      vi.useFakeTimers();
      const entered = createDeferredCore();
      const release = createDeferredCore();
      const contexts = new Map<string, OpenClawPluginServiceContext>();
      const stops = { ready: vi.fn(), starting: vi.fn() };
      const registry = createRegistry(
        [
          {
            id: "ready",
            start: (ctx) => {
              contexts.set("ready", ctx);
            },
            stop: stops.ready,
          },
        ],
        "ready",
      );
      registry.services.push(
        ...createRegistry(
          [
            {
              id: "starting",
              start: async (ctx) => {
                contexts.set("starting", ctx);
                entered.resolve();
                await release.promise;
              },
              stop: stops.starting,
            },
          ],
          "starting",
        ).services,
      );
      const broadcastPluginEvent = vi.fn();
      let handle!: PluginServicesHandle;
      const starting = startPluginServices({
        registry,
        config: createServiceConfig(),
        broadcastPluginEvent,
        onHandle: (issued) => {
          handle = issued;
        },
      });
      let stopping: Promise<unknown> | undefined;
      try {
        await entered.promise;
        stopping = handle
          .stop({ strict: true, deadlineAtMs: Date.now() + 5_000, pluginIds: new Set([selected]) })
          .catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await stopping;
        if (selected === "ready") {
          expect(result).toBeUndefined();
        } else {
          expect(result).toBeInstanceOf(AggregateError);
          expect((result as AggregateError).errors[0]).toMatchObject({
            message: expect.stringContaining("plugin service startup settlement timed out"),
          });
        }
        const sibling = selected === "ready" ? "starting" : "ready";
        expect(stops[selected]).toHaveBeenCalledOnce();
        expect(stops[sibling]).not.toHaveBeenCalled();
        expect(() =>
          contexts
            .get(sibling)!
            .gatewayEvents!.emit("still-active", {}, { scope: "operator.read" }),
        ).not.toThrow();
        expect(broadcastPluginEvent).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await starting;
        await stopping;
        await handle.stop();
        vi.useRealTimers();
      }
      expect(stops.ready).toHaveBeenCalledOnce();
      expect(stops.starting).toHaveBeenCalledOnce();
    },
  );

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

  it.each(["fulfilled", "rejected", "pending", "fulfilled-promise", "rejected-promise"] as const)(
    "does not repeat %s cleanup when startup fails after replacement settles",
    async (cleanupState) => {
      vi.useFakeTimers();
      const startup = createDeferredCore();
      const cleanup = createDeferredCore();
      const cleanupError = new Error("cleanup rejected");
      const order: string[] = [];
      const stop = vi.fn(() => {
        order.push("stop");
        if (cleanupState === "rejected") {
          throw cleanupError;
        }
        if (cleanupState === "rejected-promise") {
          return Promise.reject(cleanupError);
        }
        if (cleanupState === "fulfilled-promise") {
          return Promise.resolve();
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
        const errors = (failure as AggregateError).errors;
        expect(errors[0]).toMatchObject({
          message: expect.stringContaining("plugin service startup settlement timed out"),
        });
        expect(errors).toHaveLength(
          cleanupState === "fulfilled" || cleanupState === "fulfilled-promise" ? 1 : 2,
        );
        if (cleanupState === "rejected" || cleanupState === "rejected-promise") {
          expect(errors[1]).toHaveProperty("cause", cleanupError);
        }
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
