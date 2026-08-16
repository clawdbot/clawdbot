// Covers plugin service registration and lookup behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginOrigin } from "./plugin-origin.types.js";
import { createEmptyPluginRegistry } from "./registry.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "./types.js";

const mockedLogger = vi.hoisted(() => ({
  info: vi.fn<(msg: string) => void>(),
  warn: vi.fn<(msg: string) => void>(),
  error: vi.fn<(msg: string) => void>(),
  debug: vi.fn<(msg: string) => void>(),
  child: vi.fn(() => mockedLogger),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => mockedLogger,
}));

import { STATE_DIR } from "../config/paths.js";
import {
  emitTrustedDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
} from "../infra/diagnostic-events.js";
import { markHostPluginUsageDiagnosticEvent } from "../infra/diagnostic-plugin-usage-provenance.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  type DiagnosticExporterHealthUpdate,
} from "../logging/diagnostic-stability.js";
import { queuePluginSessionsChanged, subscribePluginSessionsChanged } from "./gateway-events.js";
import { registerPluginHttpRoute } from "./http-registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { startPluginServices, type PluginServicesHandle } from "./services.js";

type TrustedExporterInternalDiagnostics = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth?: (update: DiagnosticExporterHealthUpdate) => void;
};

function createRegistry(
  services: OpenClawPluginService[],
  pluginId = "plugin:test",
  origin: PluginOrigin = "workspace",
  trustedOfficialInstall = false,
) {
  const registry = createEmptyPluginRegistry();
  registry.services = services.map((service) => ({
    pluginId,
    service,
    source: "test",
    origin,
    ...(trustedOfficialInstall ? { trustedOfficialInstall } : {}),
    rootDir: "/plugins/test-plugin",
  })) as typeof registry.services;
  return registry;
}

function createServiceConfig() {
  return {} as Parameters<typeof startPluginServices>[0]["config"];
}

function expectServiceContext(
  ctx: OpenClawPluginServiceContext,
  config: Parameters<typeof startPluginServices>[0]["config"],
) {
  expect(ctx.config).toBe(config);
  expect(ctx.workspaceDir).toBe("/tmp/workspace");
  expect(ctx.stateDir).toBe(STATE_DIR);
  expectServiceLogger(ctx);
}

function expectServiceLogger(ctx: OpenClawPluginServiceContext) {
  expect(typeof ctx.logger.info).toBe("function");
  expect(typeof ctx.logger.warn).toBe("function");
  expect(typeof ctx.logger.error).toBe("function");
}

function expectServiceContexts(
  contexts: OpenClawPluginServiceContext[],
  config: Parameters<typeof startPluginServices>[0]["config"],
) {
  expect(contexts).not.toHaveLength(0);
  contexts.forEach((ctx) => {
    expectServiceContext(ctx, config);
  });
}

function expectServiceLifecycleState(params: {
  starts: string[];
  stops: string[];
  contexts: OpenClawPluginServiceContext[];
  config: Parameters<typeof startPluginServices>[0]["config"];
}) {
  expect(params.starts).toEqual(["a", "b", "c"]);
  expect(params.stops).toEqual(["c", "a"]);
  expect(params.contexts).toHaveLength(3);
  expectServiceContexts(params.contexts, params.config);
}

function requireLoggerErrorMessage(index = 0): string {
  const call = mockedLogger.error.mock.calls[index];
  if (!call) {
    throw new Error(`expected logger error call ${index}`);
  }
  return call[0];
}

async function startTrackingServices(params: {
  services: OpenClawPluginService[];
  config?: Parameters<typeof startPluginServices>[0]["config"];
  workspaceDir?: string;
  startupTrace?: Parameters<typeof startPluginServices>[0]["startupTrace"];
}) {
  return startPluginServices({
    registry: createRegistry(params.services),
    config: params.config ?? createServiceConfig(),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.startupTrace ? { startupTrace: params.startupTrace } : {}),
  });
}

function createTrackingService(
  id: string,
  params: {
    starts?: string[];
    stops?: string[];
    contexts?: OpenClawPluginServiceContext[];
    failOnStart?: boolean;
    failOnStop?: boolean;
    stopSpy?: () => void;
  } = {},
): OpenClawPluginService {
  return {
    id,
    start: (ctx) => {
      if (params.failOnStart) {
        throw new Error("start failed");
      }
      params.starts?.push(id.at(-1) ?? id);
      params.contexts?.push(ctx);
    },
    stop: params.stopSpy
      ? () => {
          params.stopSpy?.();
        }
      : params.stops || params.failOnStop
        ? () => {
            if (params.failOnStop) {
              throw new Error("stop failed");
            }
            params.stops?.push(id.at(-1) ?? id);
          }
        : undefined,
  };
}

describe("startPluginServices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
    resetPluginRuntimeStateForTest();
  });

  it("starts services and stops them in reverse order", async () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const contexts: OpenClawPluginServiceContext[] = [];

    const config = createServiceConfig();
    const handle = await startTrackingServices({
      services: [
        createTrackingService("service-a", { starts, stops, contexts }),
        createTrackingService("service-b", { starts, contexts }),
        createTrackingService("service-c", { starts, stops, contexts }),
      ],
      config,
      workspaceDir: "/tmp/workspace",
    });
    await handle.stop();

    expectServiceLifecycleState({ starts, stops, contexts, config });
  });

  it("publishes cleanup ownership before service startup can yield", async () => {
    let releaseStart: (() => void) | undefined;
    const serviceStarted = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const stopService = vi.fn();
    const siblingStart = vi.fn();
    let lifecycleHandle: PluginServicesHandle | undefined;

    const starting = startPluginServices({
      registry: createRegistry([
        { id: "blocking", start: () => serviceStarted, stop: stopService },
        { id: "sibling", start: siblingStart },
      ]),
      config: createServiceConfig(),
      onHandle: (handle) => {
        lifecycleHandle = handle;
      },
    });

    expect(lifecycleHandle).toBeDefined();
    let stopSettled = false;
    const stopping = lifecycleHandle!.stop().then(() => {
      stopSettled = true;
    });
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(stopService).not.toHaveBeenCalled();

    releaseStart?.();
    await starting;
    await stopping;

    expect(stopService).toHaveBeenCalledOnce();
    expect(siblingStart).not.toHaveBeenCalled();
  });

  it("drains producer diagnostics before exporters stop and propagates exporter failures", async () => {
    const order: string[] = [];
    const producerError = new Error("producer stop failed");
    const exporterError = new Error("exporter stop failed");
    let unsubscribe: () => void = () => undefined;
    const registry = createRegistry(
      [
        {
          id: "producer",
          start: () => undefined,
          stop: () => {
            order.push("producer");
            emitTrustedDiagnosticEvent({
              type: "log.record",
              level: "INFO",
              message: "queued during producer shutdown",
            });
            throw producerError;
          },
        },
      ],
      "plugin:test",
      "workspace",
    );
    registry.services.push(
      ...createRegistry(
        [
          {
            id: "diagnostics-prometheus",
            start: () => undefined,
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
              unsubscribe = ctx.internalDiagnostics!.onEvent((event) => {
                if (event.type === "log.record") {
                  order.push("event");
                }
              });
            },
            stop: () => {
              order.push("otel");
              unsubscribe();
              throw exporterError;
            },
          },
        ],
        "diagnostics-otel",
        "bundled",
      ).services,
    );

    const handle = await startPluginServices({
      registry,
      config: createServiceConfig(),
    });

    await expect(handle.stop()).rejects.toBe(exporterError);
    await waitForDiagnosticEventsDrained();

    expect(order).toEqual(["producer", "event", "otel", "prometheus"]);
    expect(mockedLogger.warn.mock.calls).toEqual([
      ["plugin service stop failed (producer): Error: producer stop failed"],
      ["plugin service stop failed (diagnostics-otel): Error: exporter stop failed"],
    ]);
  });

  it("rolls back partially started services before starting their siblings", async () => {
    const acquired = new Set<string>();
    const received = vi.fn();
    const siblingStart = vi.fn();
    const rollback = vi.fn((ctx: OpenClawPluginServiceContext) => {
      acquired.delete("failed-service");
      ctx.gatewayEvents?.emit("rolled-back", {}, { scope: "operator.read" });
    });
    const broadcastPluginEvent = vi.fn();

    const handle = await startPluginServices({
      registry: createRegistry([
        {
          id: "failed-service",
          start: (ctx) => {
            acquired.add("failed-service");
            ctx.gatewayEvents?.onSessionsChanged(received);
            throw new Error("start failed after acquiring resources");
          },
          stop: rollback,
        },
        { id: "sibling-service", start: siblingStart },
      ]),
      config: createServiceConfig(),
      broadcastPluginEvent,
    });

    expect(rollback).toHaveBeenCalledOnce();
    expect(acquired.size).toBe(0);
    expect(siblingStart).toHaveBeenCalledOnce();
    expect(broadcastPluginEvent).toHaveBeenCalledWith(
      "plugin.plugin:test.rolled-back",
      {},
      "operator.read",
    );

    queuePluginSessionsChanged({ sessionKey: "agent:main:main" });
    await Promise.resolve();
    expect(received).not.toHaveBeenCalled();

    await handle.stop();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("runs concurrent and repeated shutdowns through one cleanup operation", async () => {
    let releaseStop: (() => void) | undefined;
    const stopping = new Promise<void>((resolve) => {
      releaseStop = resolve;
    });
    const stop = vi.fn(() => stopping);
    const handle = await startTrackingServices({
      services: [{ id: "service", start: () => {}, stop }],
    });

    const firstStop = handle.stop();
    const secondStop = handle.stop();
    releaseStop?.();
    await Promise.all([firstStop, secondStop]);

    expect(firstStop).toBe(secondStop);
    expect(stop).toHaveBeenCalledOnce();

    await handle.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("binds gateway events to the owning plugin namespace and scope", async () => {
    const broadcastPluginEvent = vi.fn();
    await startPluginServices({
      registry: createRegistry(
        [
          {
            id: "events",
            start: (ctx) => {
              ctx.gatewayEvents?.emit("changed", { revision: 1 }, { scope: "operator.read" });
            },
          },
        ],
        "workboard",
      ),
      config: createServiceConfig(),
      broadcastPluginEvent,
    });

    expect(broadcastPluginEvent).toHaveBeenCalledWith(
      "plugin.workboard.changed",
      { revision: 1 },
      "operator.read",
    );
  });

  it("omits gateway events entirely when no broadcaster exists", async () => {
    let context: OpenClawPluginServiceContext | undefined;
    const handle = await startPluginServices({
      registry: createRegistry([
        {
          id: "events",
          start: (ctx) => {
            context = ctx;
          },
        },
      ]),
      config: createServiceConfig(),
    });

    // Presence of ctx.gatewayEvents is the capability signal plugins
    // feature-detect; a facade with a dropping emit would defeat fallbacks.
    expect(context?.gatewayEvents).toBeUndefined();
    await handle.stop();
  });

  it("subscribes services to sessions.changed and revokes them on stop", async () => {
    const received = vi.fn();
    let context: OpenClawPluginServiceContext | undefined;
    const handle = await startPluginServices({
      registry: createRegistry([
        {
          id: "events",
          start: (ctx) => {
            context = ctx;
            ctx.gatewayEvents?.onSessionsChanged(received);
          },
        },
      ]),
      config: createServiceConfig(),
      broadcastPluginEvent: vi.fn(),
    });

    queuePluginSessionsChanged({ sessionKey: "agent:main:main", reason: "rename", ignored: 1 });
    await Promise.resolve();
    expect(received).toHaveBeenCalledWith({
      sessionKey: "agent:main:main",
      reason: "rename",
    });
    expect(() =>
      context?.gatewayEvents?.emit("changed", {}, { scope: "operator.read" }),
    ).not.toThrow();

    await handle.stop();
    queuePluginSessionsChanged({ sessionKey: "agent:main:main", reason: "archive" });
    await Promise.resolve();
    expect(received).toHaveBeenCalledOnce();
  });

  it("keeps duplicate handler subscriptions independent", async () => {
    const received = vi.fn();
    const unsubscribeFirst = subscribePluginSessionsChanged(received);
    const unsubscribeSecond = subscribePluginSessionsChanged(received);

    unsubscribeFirst();
    queuePluginSessionsChanged({ sessionKey: "agent:main:main" });
    await Promise.resolve();

    expect(received).toHaveBeenCalledOnce();
    unsubscribeSecond();
  });

  it("uses a stable sessions.changed subscription snapshot", async () => {
    const received = vi.fn();
    let unsubscribe: () => void = () => undefined;
    const handler = () => {
      received();
      unsubscribe();
      unsubscribe = subscribePluginSessionsChanged(handler);
    };
    unsubscribe = subscribePluginSessionsChanged(handler);

    queuePluginSessionsChanged({ sessionKey: "agent:main:main" });
    await Promise.resolve();

    expect(received).toHaveBeenCalledOnce();
    unsubscribe();
  });

  it("logs a throwing sessions.changed handler without blocking siblings", async () => {
    const received = vi.fn();
    const rejectingHandler = (() =>
      Promise.reject(new Error("async handler failed"))) as () => void;
    const handle = await startPluginServices({
      registry: createRegistry([
        {
          id: "events",
          start: (ctx) => {
            ctx.gatewayEvents?.onSessionsChanged(() => {
              throw new Error("handler failed");
            });
            ctx.gatewayEvents?.onSessionsChanged(rejectingHandler);
            ctx.gatewayEvents?.onSessionsChanged(received);
          },
        },
      ]),
      config: createServiceConfig(),
      broadcastPluginEvent: vi.fn(),
    });

    queuePluginSessionsChanged({ sessionKey: "agent:main:main", phase: "message" });
    await Promise.resolve();
    await Promise.resolve();

    expect(received).toHaveBeenCalledOnce();
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "plugin sessions.changed handler failed: Error: handler failed",
    );
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "plugin sessions.changed handler failed: Error: async handler failed",
    );
    await handle.stop();
  });

  it("rejects unsafe event names, scopes, and payloads", async () => {
    let context: OpenClawPluginServiceContext | undefined;
    const broadcastPluginEvent = vi.fn();
    await startPluginServices({
      registry: createRegistry([
        {
          id: "events",
          start: (ctx) => {
            context = ctx;
          },
        },
      ]),
      config: createServiceConfig(),
      broadcastPluginEvent,
    });
    const emit = context?.gatewayEvents?.emit as unknown as (
      event: string,
      payload: unknown,
      opts: { scope: string },
    ) => void;

    expect(() => emit("other.changed", {}, { scope: "operator.read" })).toThrow(
      "invalid plugin gateway event name",
    );
    expect(() => emit("changed", { value: Number.NaN }, { scope: "operator.read" })).toThrow(
      "bounded JSON",
    );
    expect(() => emit("changed", {}, { scope: "operator.approvals" })).toThrow("operator scope");
    expect(broadcastPluginEvent).not.toHaveBeenCalled();
  });

  it("revokes gateway event emitters after failed start and stop", async () => {
    const contexts: OpenClawPluginServiceContext[] = [];
    const broadcastPluginEvent = vi.fn();
    const handle = await startPluginServices({
      registry: createRegistry([
        {
          id: "events",
          start: (ctx) => {
            contexts.push(ctx);
          },
          stop: (ctx) => {
            ctx.gatewayEvents?.emit("stopping", {}, { scope: "operator.read" });
          },
        },
        {
          id: "failed-events",
          start: (ctx) => {
            contexts.push(ctx);
            throw new Error("start failed");
          },
        },
      ]),
      config: createServiceConfig(),
      broadcastPluginEvent,
    });

    expect(() =>
      contexts[1]?.gatewayEvents?.emit("changed", {}, { scope: "operator.read" }),
    ).toThrow("no longer active");
    await handle.stop();
    expect(() =>
      contexts[0]?.gatewayEvents?.emit("changed", {}, { scope: "operator.read" }),
    ).toThrow("no longer active");
    expect(broadcastPluginEvent).toHaveBeenCalledOnce();
    expect(broadcastPluginEvent).toHaveBeenCalledWith(
      "plugin.plugin:test.stopping",
      {},
      "operator.read",
    );
  });

  it("registers dynamic HTTP routes into the service registry scope", async () => {
    const serviceRegistry = createRegistry([
      {
        id: "route-service",
        start: () => {
          registerPluginHttpRoute({
            path: "/service-route",
            auth: "plugin",
            handler: vi.fn(),
          });
        },
      },
    ]);
    const pinnedRegistry = createEmptyPluginRegistry();

    setActivePluginRegistry(pinnedRegistry);

    const handle = await startPluginServices({
      registry: serviceRegistry,
      config: createServiceConfig(),
    });

    expect(serviceRegistry.httpRoutes.map((route) => route.path)).toEqual(["/service-route"]);
    expect(pinnedRegistry.httpRoutes).toHaveLength(0);

    await handle.stop();
  });

  it("attempts every ordinary service stop and preserves warn-and-continue failures", async () => {
    const stopOk = vi.fn();
    const firstError = new Error("first stop failed");
    const secondError = new Error("second stop failed");
    const stopFirst = vi.fn(() => {
      throw firstError;
    });
    const stopSecond = vi.fn(() => {
      throw secondError;
    });

    const handle = await startTrackingServices({
      services: [
        createTrackingService("service-start-fail", {
          failOnStart: true,
          stopSpy: vi.fn(),
        }),
        createTrackingService("service-stop-first", { stopSpy: stopFirst }),
        createTrackingService("service-ok", { stopSpy: stopOk }),
        createTrackingService("service-stop-second", { stopSpy: stopSecond }),
      ],
    });

    await expect(handle.stop()).resolves.toBeUndefined();

    expect(mockedLogger.error.mock.calls).toEqual([
      [
        "plugin service failed (service-start-fail, plugin=plugin:test, root=/plugins/test-plugin): start failed",
      ],
    ]);
    expect(requireLoggerErrorMessage()).not.toContain("\n");
    expect(mockedLogger.warn.mock.calls).toEqual([
      ["plugin service stop failed (service-stop-second): Error: second stop failed"],
      ["plugin service stop failed (service-stop-first): Error: first stop failed"],
    ]);
    expect(stopOk).toHaveBeenCalledOnce();
    expect(stopFirst).toHaveBeenCalledOnce();
    expect(stopSecond).toHaveBeenCalledOnce();
  });

  it("continues starting siblings when rollback also fails", async () => {
    const rollback = vi.fn(() => {
      throw new Error("rollback failed");
    });
    const siblingStart = vi.fn();

    const handle = await startTrackingServices({
      services: [
        {
          id: "failed-service",
          start: () => {
            throw new Error("start failed");
          },
          stop: rollback,
        },
        { id: "sibling-service", start: siblingStart },
      ],
    });

    expect(rollback).toHaveBeenCalledOnce();
    expect(siblingStart).toHaveBeenCalledOnce();
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      "plugin service stop failed (failed-service): Error: rollback failed",
    );

    await handle.stop();
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("keeps diagnostics rollback detail visible beside the host startup failure", async () => {
    const startupError = new Error("SDK startup failed");
    const rollbackError = new Error("SDK rollback failed");

    await startPluginServices({
      registry: createRegistry(
        [
          {
            id: "diagnostics-otel",
            start: (ctx) => {
              ctx.logger.error(
                "diagnostics-otel: SDK startup rollback cleanup failed: Error: SDK rollback failed",
              );
              throw new AggregateError(
                [startupError, rollbackError],
                "diagnostics-otel startup failed and rollback cleanup failed",
                { cause: startupError },
              );
            },
          },
        ],
        "diagnostics-otel",
        "bundled",
      ),
      config: createServiceConfig(),
    });

    expect(mockedLogger.error.mock.calls).toEqual([
      ["diagnostics-otel: SDK startup rollback cleanup failed: Error: SDK rollback failed"],
      [
        "plugin service failed (diagnostics-otel, plugin=diagnostics-otel, root=/plugins/test-plugin): diagnostics-otel startup failed and rollback cleanup failed",
      ],
    ]);
  });

  it("retains trusted exporter startup health after host rollback", async () => {
    const rollback = vi.fn();
    const handle = await startPluginServices({
      registry: createRegistry(
        [
          {
            id: "diagnostics-otel",
            start: (ctx) => {
              const reportExporterHealth = (
                ctx.internalDiagnostics as TrustedExporterInternalDiagnostics | undefined
              )?.reportExporterHealth;
              if (!reportExporterHealth) {
                throw new Error("expected trusted exporter health reporter");
              }
              reportExporterHealth({
                signal: "traces",
                transport: "otlp-http-protobuf",
                endpointMode: "configured",
                status: "failure",
                reason: "start_failed",
                errorCategory: "TypeError",
              });
              throw new TypeError("SDK startup failed");
            },
            stop: rollback,
          },
        ],
        "diagnostics-otel",
        "bundled",
      ),
      config: createServiceConfig(),
    });

    expect(rollback).toHaveBeenCalledOnce();
    await handle.stop();
    expect(rollback).toHaveBeenCalledOnce();
    expect(
      getDiagnosticStabilitySnapshot({
        type: "telemetry.exporter",
        limit: 1000,
      }).events,
    ).toEqual([
      expect.objectContaining({
        source: "diagnostics-otel",
        target: "traces",
        transport: "otlp-http-protobuf",
        outcome: "failure",
        reason: "start_failed",
        errorCategory: "TypeError",
      }),
    ]);
  });

  it("emits per-service startup trace spans and summary", async () => {
    const measured: string[] = [];
    const details: Array<{
      name: string;
      metrics: ReadonlyArray<readonly [string, number | string]>;
    }> = [];
    const startupTrace: NonNullable<Parameters<typeof startPluginServices>[0]["startupTrace"]> = {
      measure: async (name, run) => {
        measured.push(name);
        return await run();
      },
      detail: (name, metrics) => {
        details.push({ name, metrics });
      },
    };

    await startTrackingServices({
      services: [
        createTrackingService("service-a"),
        createTrackingService("service-fail", { failOnStart: true }),
      ],
      startupTrace,
    });

    expect(measured).toEqual([
      "sidecars.plugin-services.plugin~003Atest.service-a",
      "sidecars.plugin-services.plugin~003Atest.service-fail",
    ]);
    expect(details).toEqual([
      {
        name: "sidecars.plugin-services.summary",
        metrics: [
          ["serviceCount", 2],
          ["startedCount", 1],
          ["failedCount", 1],
        ],
      },
    ]);
  });

  it("passes a scoped startup trace through service context for owned subspans", async () => {
    const contexts: OpenClawPluginServiceContext[] = [];
    const measured: string[] = [];
    const details: Array<{
      name: string;
      metrics: ReadonlyArray<readonly [string, number | string]>;
    }> = [];
    const startupTrace: NonNullable<Parameters<typeof startPluginServices>[0]["startupTrace"]> = {
      measure: async (name, run) => {
        measured.push(name);
        return await run();
      },
      detail: (name, metrics) => {
        details.push({ name, metrics });
      },
    };

    await startTrackingServices({
      services: [
        {
          id: "service-a",
          start: async (ctx) => {
            contexts.push(ctx);
            ctx.startupTrace?.detail?.("probe.result", [["healthyCount", 1]]);
            await ctx.startupTrace?.measure("config:resolve", async () => {});
          },
        },
      ],
      startupTrace,
    });

    expect(contexts[0]?.startupTrace).not.toBe(startupTrace);
    expect(measured).toEqual([
      "sidecars.plugin-services.plugin~003Atest.service-a",
      "sidecars.plugin-services.plugin~003Atest.service-a.config~003Aresolve",
    ]);
    expect(details).toEqual([
      {
        name: "sidecars.plugin-services.plugin~003Atest.service-a.probe.result",
        metrics: [["healthyCount", 1]],
      },
      {
        name: "sidecars.plugin-services.summary",
        metrics: [
          ["serviceCount", 1],
          ["startedCount", 1],
          ["failedCount", 0],
        ],
      },
    ]);
  });

  it("keeps distinct service trace ownership keys non-colliding", async () => {
    const measured: string[] = [];
    const startupTrace: NonNullable<Parameters<typeof startPluginServices>[0]["startupTrace"]> = {
      measure: async (name, run) => {
        measured.push(name);
        return await run();
      },
    };

    await startPluginServices({
      registry: createRegistry(
        [createTrackingService("service:a"), createTrackingService("service_a")],
        "plugin:test",
      ),
      config: createServiceConfig(),
      startupTrace,
    });

    expect(measured).toEqual([
      "sidecars.plugin-services.plugin~003Atest.service~003Aa",
      "sidecars.plugin-services.plugin~003Atest.service_a",
    ]);
    expect(new Set(measured).size).toBe(measured.length);
  });

  it("grants internal diagnostics only to trusted diagnostics exporter services", async () => {
    const contexts: OpenClawPluginServiceContext[] = [];
    const diagnosticsService = createTrackingService("diagnostics-otel", { contexts });
    await startPluginServices({
      registry: createRegistry([diagnosticsService], "diagnostics-otel", "bundled"),
      config: createServiceConfig(),
    });

    expect(contexts[0]?.internalDiagnostics?.onEvent).toBeTypeOf("function");
    expect(contexts[0]?.internalDiagnostics?.emit).toBeTypeOf("function");
    expect(contexts[0]?.internalDiagnostics?.registerTracePropagationBridge).toBeTypeOf("function");
    expect(
      (contexts[0]?.internalDiagnostics as TrustedExporterInternalDiagnostics | undefined)
        ?.reportExporterHealth,
    ).toBeTypeOf("function");

    const prometheusContexts: OpenClawPluginServiceContext[] = [];
    const prometheusService = createTrackingService("diagnostics-prometheus", {
      contexts: prometheusContexts,
    });
    await startPluginServices({
      registry: createRegistry([prometheusService], "diagnostics-prometheus", "bundled"),
      config: createServiceConfig(),
    });

    expect(prometheusContexts[0]?.internalDiagnostics?.onEvent).toBeTypeOf("function");
    expect(prometheusContexts[0]?.internalDiagnostics?.emit).toBeTypeOf("function");
    expect(prometheusContexts[0]?.internalDiagnostics?.registerTracePropagationBridge).toBeTypeOf(
      "function",
    );
    expect(
      (prometheusContexts[0]?.internalDiagnostics as TrustedExporterInternalDiagnostics | undefined)
        ?.reportExporterHealth,
    ).toBeTypeOf("function");

    const officialDiagnosticsOtelContexts: OpenClawPluginServiceContext[] = [];
    const officialDiagnosticsOtelService = createTrackingService("diagnostics-otel", {
      contexts: officialDiagnosticsOtelContexts,
    });
    await startPluginServices({
      registry: createRegistry(
        [officialDiagnosticsOtelService],
        "diagnostics-otel",
        "config",
        true,
      ),
      config: createServiceConfig(),
    });

    expect(officialDiagnosticsOtelContexts[0]?.internalDiagnostics?.onEvent).toBeTypeOf("function");
    expect(officialDiagnosticsOtelContexts[0]?.internalDiagnostics?.emit).toBeTypeOf("function");
    expect(
      officialDiagnosticsOtelContexts[0]?.internalDiagnostics?.registerTracePropagationBridge,
    ).toBeTypeOf("function");
    expect(
      (
        officialDiagnosticsOtelContexts[0]?.internalDiagnostics as
          | TrustedExporterInternalDiagnostics
          | undefined
      )?.reportExporterHealth,
    ).toBeTypeOf("function");

    const officialInstallContexts: OpenClawPluginServiceContext[] = [];
    const officialInstallService = createTrackingService("diagnostics-prometheus", {
      contexts: officialInstallContexts,
    });
    await startPluginServices({
      registry: createRegistry([officialInstallService], "diagnostics-prometheus", "global", true),
      config: createServiceConfig(),
    });

    expect(officialInstallContexts[0]?.internalDiagnostics?.onEvent).toBeTypeOf("function");
    expect(officialInstallContexts[0]?.internalDiagnostics?.emit).toBeTypeOf("function");
    expect(
      officialInstallContexts[0]?.internalDiagnostics?.registerTracePropagationBridge,
    ).toBeTypeOf("function");
    expect(
      (
        officialInstallContexts[0]?.internalDiagnostics as
          | TrustedExporterInternalDiagnostics
          | undefined
      )?.reportExporterHealth,
    ).toBeTypeOf("function");

    const untrustedContexts: OpenClawPluginServiceContext[] = [];
    const untrustedService = createTrackingService("diagnostics-otel", {
      contexts: untrustedContexts,
    });
    await startPluginServices({
      registry: createRegistry([untrustedService], "diagnostics-otel", "workspace"),
      config: createServiceConfig(),
    });

    expect(untrustedContexts[0]?.internalDiagnostics).toBeUndefined();

    const spoofedContexts: OpenClawPluginServiceContext[] = [];
    const spoofedService = createTrackingService("diagnostics-prometheus", {
      contexts: spoofedContexts,
    });
    await startPluginServices({
      registry: createRegistry([spoofedService], "not-diagnostics-prometheus", "global", true),
      config: createServiceConfig(),
    });

    expect(spoofedContexts[0]?.internalDiagnostics).toBeUndefined();

    (
      contexts[0]?.internalDiagnostics as TrustedExporterInternalDiagnostics | undefined
    )?.reportExporterHealth?.({
      signal: "traces",
      transport: "otlp-http-protobuf",
      status: "recovered",
      reason: "export_failed",
    });
    expect(
      getDiagnosticStabilitySnapshot({ type: "telemetry.exporter", limit: 1000 }).events,
    ).toEqual([
      expect.objectContaining({
        source: "diagnostics-otel",
        target: "traces",
        transport: "otlp-http-protobuf",
        outcome: "recovered",
        reason: "export_failed",
      }),
    ]);
  });

  it("delivers host plugin attribution only to the trusted OTel listener lane", async () => {
    const observed: Array<{
      exporter: string;
      hostPluginId?: string;
      privateHostPluginId?: unknown;
    }> = [];
    const createDiagnosticsService = (id: "diagnostics-otel" | "diagnostics-prometheus") => ({
      id,
      start(ctx: OpenClawPluginServiceContext) {
        ctx.internalDiagnostics?.onEvent((event, _metadata, privateData) => {
          if (event.type === "model.usage") {
            observed.push({
              exporter: id,
              hostPluginId: (privateData as { hostPluginId?: string }).hostPluginId,
              privateHostPluginId: (privateData as { hostPluginId?: unknown }).hostPluginId,
            });
          }
        });
      },
    });
    const registry = createRegistry(
      [createDiagnosticsService("diagnostics-otel")],
      "diagnostics-otel",
      "bundled",
    );
    registry.services.push(
      ...createRegistry(
        [createDiagnosticsService("diagnostics-prometheus")],
        "diagnostics-prometheus",
        "bundled",
      ).services,
    );
    await startPluginServices({ registry, config: createServiceConfig() });

    emitTrustedDiagnosticEvent(
      markHostPluginUsageDiagnosticEvent({ type: "model.usage", usage: { input: 1 } }, "llm-task"),
    );

    expect(observed).toEqual([
      {
        exporter: "diagnostics-otel",
        hostPluginId: "llm-task",
        privateHostPluginId: "llm-task",
      },
      {
        exporter: "diagnostics-prometheus",
        hostPluginId: undefined,
        privateHostPluginId: undefined,
      },
    ]);
  });
});
