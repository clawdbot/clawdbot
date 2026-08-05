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
import { queuePluginSessionsChanged, subscribePluginSessionsChanged } from "./gateway-events.js";
import { registerPluginHttpRoute } from "./http-registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { startPluginServices } from "./services.js";

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

  it("logs start/stop failures and continues", async () => {
    const stopOk = vi.fn();
    const stopThrows = vi.fn(() => {
      throw new Error("stop failed");
    });

    const handle = await startTrackingServices({
      services: [
        createTrackingService("service-start-fail", {
          failOnStart: true,
          stopSpy: vi.fn(),
        }),
        createTrackingService("service-ok", { stopSpy: stopOk }),
        createTrackingService("service-stop-fail", { stopSpy: stopThrows }),
      ],
    });

    await handle.stop();

    expect(mockedLogger.error.mock.calls).toEqual([
      [
        "plugin service failed (service-start-fail, plugin=plugin:test, root=/plugins/test-plugin): start failed",
      ],
    ]);
    expect(requireLoggerErrorMessage()).not.toContain("\n");
    expect(mockedLogger.warn.mock.calls).toEqual([
      ["plugin service stop failed (service-stop-fail): Error: stop failed"],
    ]);
    expect(stopOk).toHaveBeenCalledOnce();
    expect(stopThrows).toHaveBeenCalledOnce();
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
  });
});
