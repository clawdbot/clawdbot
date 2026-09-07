// One-shot diagnostics exporter start/flush lifecycle for embedded CLI runs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import type { PluginServicesHandle } from "./services.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "./types.js";

const loadOpenClawPlugins = vi.hoisted(() => vi.fn());
const startPluginServices = vi.hoisted(() => vi.fn());
const waitForDiagnosticEventsDrained = vi.hoisted(() => vi.fn(async () => {}));
const warn = vi.hoisted(() => vi.fn());

vi.mock("./loader.js", () => ({ loadOpenClawPlugins }));
vi.mock("./services.js", () => ({ startPluginServices }));
vi.mock("../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("../infra/diagnostic-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/diagnostic-events.js")>()),
  waitForDiagnosticEventsDrained,
}));

import { startOneShotDiagnosticsExporters } from "./one-shot-diagnostics.js";

const otelEnabledConfig = {
  diagnostics: { otel: { enabled: true, endpoint: "http://127.0.0.1:4318" } },
} as OpenClawConfig;

function mockRegistryWithServices(serviceIds: string[]) {
  const registry = {
    services: serviceIds.map((id) => ({
      pluginId: id,
      pluginName: id,
      service: { id },
      source: "test",
      origin: "bundled",
    })),
  };
  loadOpenClawPlugins.mockReturnValue(registry);
  return registry;
}

async function mockRealExporter(service: OpenClawPluginService, origin: "bundled" | "workspace") {
  const { startPluginServices: startRealServices } =
    await vi.importActual<typeof import("./services.js")>("./services.js");
  const registry = createEmptyPluginRegistry();
  registry.services.push({ pluginId: "diagnostics-otel", service, source: "test", origin });
  loadOpenClawPlugins.mockReturnValue(registry);
  let servicesHandle: PluginServicesHandle | undefined;
  startPluginServices.mockImplementationOnce(
    async (params: Parameters<typeof startRealServices>[0]) => {
      servicesHandle = await startRealServices(params);
      return servicesHandle;
    },
  );
  return { stop: () => servicesHandle?.stop() };
}

beforeEach(() => {
  vi.clearAllMocks();
  waitForDiagnosticEventsDrained.mockResolvedValue(undefined);
});

describe("startOneShotDiagnosticsExporters", () => {
  it.each([
    ["no diagnostics config", {}],
    ["no otel config", { diagnostics: {} }],
    ["diagnostics disabled", { diagnostics: { enabled: false, otel: { enabled: true } } }],
    ["otel disabled", { diagnostics: { otel: { enabled: false } } }],
  ])("skips plugin loading when otel export is not configured (%s)", async (_label, config) => {
    const handle = await startOneShotDiagnosticsExporters({ config: config as OpenClawConfig });

    expect(handle).toBeNull();
    expect(loadOpenClawPlugins).not.toHaveBeenCalled();
    expect(startPluginServices).not.toHaveBeenCalled();
  });

  it("starts only the diagnostics-otel service from a scoped non-activating load", async () => {
    mockRegistryWithServices(["diagnostics-otel", "other-service"]);
    startPluginServices.mockResolvedValue({ stop: vi.fn(async () => {}) });

    const handle = await startOneShotDiagnosticsExporters({ config: otelEnabledConfig });

    expect(handle).not.toBeNull();
    expect(loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: otelEnabledConfig,
        onlyPluginIds: ["diagnostics-otel"],
        activate: false,
        preferBuiltPluginArtifacts: true,
      }),
    );
    expect(startPluginServices).toHaveBeenCalledTimes(1);
    const startParams = startPluginServices.mock.calls[0]?.[0] as {
      registry: { services: Array<{ service: { id: string } }> };
      config: OpenClawConfig;
    };
    expect(startParams.config).toBe(otelEnabledConfig);
    expect(startParams.registry.services.map((entry) => entry.service.id)).toEqual([
      "diagnostics-otel",
    ]);
  });

  it("keeps OTLP logs but suppresses stdout JSONL logs when requested", async () => {
    const config = {
      diagnostics: { otel: { enabled: true, logs: true, logsExporter: "both" } },
    } as OpenClawConfig;
    mockRegistryWithServices(["diagnostics-otel"]);
    startPluginServices.mockResolvedValue({ stop: vi.fn(async () => {}) });

    const handle = await startOneShotDiagnosticsExporters({
      config,
      suppressStdoutDiagnosticLogs: true,
    });

    expect(handle).not.toBeNull();
    const startParams = startPluginServices.mock.calls[0]?.[0] as {
      config: OpenClawConfig;
    };
    expect(startParams.config.diagnostics?.otel?.logs).toBe(true);
    expect(startParams.config.diagnostics?.otel?.logsExporter).toBe("otlp");
    expect(config.diagnostics?.otel?.logsExporter).toBe("both");
  });

  it("disables stdout-only JSONL logs when requested", async () => {
    const config = {
      diagnostics: { otel: { enabled: true, logs: true, logsExporter: "stdout" } },
    } as OpenClawConfig;
    mockRegistryWithServices(["diagnostics-otel"]);
    startPluginServices.mockResolvedValue({ stop: vi.fn(async () => {}) });

    const handle = await startOneShotDiagnosticsExporters({
      config,
      suppressStdoutDiagnosticLogs: true,
    });

    expect(handle).not.toBeNull();
    const startParams = startPluginServices.mock.calls[0]?.[0] as {
      config: OpenClawConfig;
    };
    expect(startParams.config.diagnostics?.otel?.logs).toBe(false);
    expect(startParams.config.diagnostics?.otel?.logsExporter).toBe("otlp");
    expect(config.diagnostics?.otel?.logsExporter).toBe("stdout");
  });

  it("returns null when the scoped load registers no exporter service", async () => {
    mockRegistryWithServices(["other-service"]);

    const handle = await startOneShotDiagnosticsExporters({ config: otelEnabledConfig });

    expect(handle).toBeNull();
    expect(startPluginServices).not.toHaveBeenCalled();
  });

  it("drains queued diagnostic events before stopping services on flush", async () => {
    const exporterStop = vi.fn();
    const services = await mockRealExporter(
      { id: "diagnostics-otel", start: () => {}, stop: exporterStop },
      "bundled",
    );
    const drain = createDeferredCore();
    const draining = createDeferredCore();
    waitForDiagnosticEventsDrained.mockImplementation(() => {
      draining.resolve();
      return drain.promise;
    });
    let stopping: Promise<void> | undefined;
    try {
      const handle = await startOneShotDiagnosticsExporters({ config: otelEnabledConfig });
      stopping = handle?.stop();
      await draining.promise;
      expect(exporterStop).not.toHaveBeenCalled();
      drain.resolve();
      await stopping;
      expect(exporterStop).toHaveBeenCalledOnce();
    } finally {
      drain.resolve();
      await stopping;
      await services.stop();
    }
  });

  it("reports drain and exporter failures without failing the CLI shutdown", async () => {
    const exporterStop = vi.fn(() => {
      throw new Error("exporter shutdown failed");
    });
    const services = await mockRealExporter(
      { id: "diagnostics-otel", start: () => {}, stop: exporterStop },
      "bundled",
    );
    waitForDiagnosticEventsDrained.mockRejectedValue(new Error("event drain failed"));
    try {
      const handle = await startOneShotDiagnosticsExporters({ config: otelEnabledConfig });
      await expect(handle?.stop()).resolves.toBeUndefined();
      expect(exporterStop).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/one-shot diagnostics .*event drain failed/),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/one-shot diagnostics .*exporter shutdown failed/),
      );
    } finally {
      await Promise.allSettled([services.stop()]);
    }
  });

  it.each([
    { drainOutcome: "immediate completion", drainWaitMs: 0, origin: "bundled" },
    { drainOutcome: "early completion", drainWaitMs: 2_000, origin: "bundled" },
    { drainOutcome: "timeout", drainWaitMs: 5_000, origin: "bundled" },
    { drainOutcome: "timeout", drainWaitMs: 5_000, origin: "workspace" },
  ] as const)(
    "gives the $origin exporter a separate flush window after drain $drainOutcome",
    async ({ drainWaitMs, origin }) => {
      const drain = createDeferredCore();
      const flush = createDeferredCore();
      const exporterStop = vi.fn(() => flush.promise);
      let internalDiagnostics: OpenClawPluginServiceContext["internalDiagnostics"];
      const services = await mockRealExporter(
        {
          id: "diagnostics-otel",
          start: (context) => {
            internalDiagnostics = context.internalDiagnostics;
          },
          stop: exporterStop,
        },
        origin,
      );
      waitForDiagnosticEventsDrained.mockImplementation(() => drain.promise);
      let stopping: Promise<void> | undefined;
      let stopped = false;
      vi.useFakeTimers();
      try {
        const handle = await startOneShotDiagnosticsExporters({ config: otelEnabledConfig });
        expect(handle).not.toBeNull();
        expect(Boolean(internalDiagnostics)).toBe(origin === "bundled");
        stopping = handle?.stop().then(() => {
          stopped = true;
        });
        if (drainWaitMs > 0) {
          await vi.advanceTimersByTimeAsync(drainWaitMs - 1);
          expect(exporterStop).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(1);
        }
        if (drainWaitMs < 5_000) {
          drain.resolve();
          await vi.advanceTimersByTimeAsync(0);
        }

        // Observe the exporter itself: a service-manager stop can still be waiting on another drain.
        expect(exporterStop).toHaveBeenCalledOnce();
        expect(stopped).toBe(false);
        await vi.advanceTimersByTimeAsync(9_999);
        expect(stopped).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await stopping;
        expect(stopped).toBe(true);
        if (internalDiagnostics) {
          expect(internalDiagnostics.getRuntimeIdentity).toThrow("no longer active");
        }
      } finally {
        drain.resolve();
        flush.resolve();
        try {
          await vi.advanceTimersByTimeAsync(0);
          await stopping;
          await services.stop();
        } finally {
          vi.useRealTimers();
        }
      }
    },
  );

  it("warns when otel is configured but the diagnostics-otel plugin is absent", async () => {
    mockRegistryWithServices(["other-service"]);

    const handle = await startOneShotDiagnosticsExporters({ config: otelEnabledConfig });

    expect(handle).toBeNull();
    expect(startPluginServices).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("diagnostics-otel plugin is not"));
  });
});
