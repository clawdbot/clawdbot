// One-shot diagnostics exporter start/flush lifecycle for embedded CLI runs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

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
    mockRegistryWithServices(["diagnostics-otel"]);
    const servicesStop = vi.fn(async () => {});
    startPluginServices.mockResolvedValue({ stop: servicesStop });
    let releaseDrain = () => {};
    waitForDiagnosticEventsDrained.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          releaseDrain = resolve;
        }),
    );

    const handle = await startOneShotDiagnosticsExporters({ config: otelEnabledConfig });
    const stopPromise = handle?.stop();
    await Promise.resolve();

    expect(waitForDiagnosticEventsDrained).toHaveBeenCalledTimes(1);
    expect(servicesStop).not.toHaveBeenCalled();

    releaseDrain();
    await stopPromise;

    expect(servicesStop).toHaveBeenCalledTimes(1);
  });

  it("swallows service stop failures", async () => {
    mockRegistryWithServices(["diagnostics-otel"]);
    startPluginServices.mockResolvedValue({
      stop: vi.fn(async () => {
        throw new Error("exporter shutdown failed");
      }),
    });

    const handle = await startOneShotDiagnosticsExporters({ config: otelEnabledConfig });

    await expect(handle?.stop()).resolves.toBeUndefined();
  });

  it("still flushes the exporter when the diagnostic-event drain hangs", async () => {
    vi.useFakeTimers();
    try {
      mockRegistryWithServices(["diagnostics-otel"]);
      const servicesStop = vi.fn(async () => {});
      startPluginServices.mockResolvedValue({ stop: servicesStop });
      waitForDiagnosticEventsDrained.mockImplementation(() => new Promise<void>(() => {}));

      const handle = await startOneShotDiagnosticsExporters({ config: otelEnabledConfig });
      const stopPromise = handle?.stop();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(stopPromise).resolves.toBeUndefined();
      // A stalled drain must not consume the flush window: telemetry already
      // buffered still has to reach the collector.
      expect(servicesStop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns when otel is configured but the diagnostics-otel plugin is absent", async () => {
    mockRegistryWithServices(["other-service"]);

    const handle = await startOneShotDiagnosticsExporters({ config: otelEnabledConfig });

    expect(handle).toBeNull();
    expect(startPluginServices).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("diagnostics-otel plugin is not"));
  });

  it("bounds the flush with a timeout so a hung exporter cannot block exit", async () => {
    vi.useFakeTimers();
    try {
      mockRegistryWithServices(["diagnostics-otel"]);
      const servicesStop = vi.fn(() => new Promise<void>(() => {}));
      startPluginServices.mockResolvedValue({ stop: servicesStop });

      const handle = await startOneShotDiagnosticsExporters({ config: otelEnabledConfig });
      const stopPromise = handle?.stop();
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(stopPromise).resolves.toBeUndefined();
      expect(servicesStop).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
