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
