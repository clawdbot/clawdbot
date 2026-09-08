import { describe, expect, it, vi } from "vitest";
import type { ProviderUsageMetricsListener } from "../infra/provider-usage-metrics.types.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { startPluginServices } from "./services.js";
import type { OpenClawPluginService, OpenClawPluginServiceContext } from "./types.js";

function createRegistry(pluginId: string, service: OpenClawPluginService) {
  const registry = createEmptyPluginRegistry();
  registry.services = [
    {
      pluginId,
      service,
      source: "test",
      origin: "bundled",
      rootDir: "/plugins/test-plugin",
    },
  ];
  return registry;
}

function captureContext(
  id: string,
  contexts: OpenClawPluginServiceContext[],
): OpenClawPluginService {
  return {
    id,
    start: (ctx) => {
      contexts.push(ctx);
    },
  };
}

function providerUsageCapability(ctx: OpenClawPluginServiceContext | undefined) {
  return (
    ctx?.internalDiagnostics as
      | (NonNullable<OpenClawPluginServiceContext["internalDiagnostics"]> & {
          observeProviderUsage?: (listener: ProviderUsageMetricsListener) => Promise<() => void>;
        })
      | undefined
  )?.observeProviderUsage;
}

describe("provider usage diagnostics capability", () => {
  it("grants the capability only to the official Prometheus exporter and releases it on stop", async () => {
    const release = vi.fn();
    const observeProviderUsage = vi.fn(async () => release);
    const otelContexts: OpenClawPluginServiceContext[] = [];
    await startPluginServices({
      registry: createRegistry(
        "diagnostics-otel",
        captureContext("diagnostics-otel", otelContexts),
      ),
      config: {},
      observeProviderUsage,
    });
    expect(providerUsageCapability(otelContexts[0])).toBeUndefined();

    const prometheusContexts: OpenClawPluginServiceContext[] = [];
    const handle = await startPluginServices({
      registry: createRegistry(
        "diagnostics-prometheus",
        captureContext("diagnostics-prometheus", prometheusContexts),
      ),
      config: {},
      observeProviderUsage,
    });
    const capability = providerUsageCapability(prometheusContexts[0]);
    expect(capability).toBeTypeOf("function");
    await capability?.(() => {});
    expect(observeProviderUsage).toHaveBeenCalledOnce();
    await handle.stop();
    expect(release).toHaveBeenCalledOnce();
  });

  it("carries lease revocation through asynchronous observer acquisition", async () => {
    const acquired = vi.fn();
    const gate = Promise.withResolvers<void>();
    const observeProviderUsage = vi.fn(async ({ isActive }: { isActive: () => boolean }) => {
      await gate.promise;
      if (!isActive()) {
        throw new Error("provider usage observer lease is no longer active");
      }
      acquired();
      return vi.fn();
    });
    const contexts: OpenClawPluginServiceContext[] = [];
    const handle = await startPluginServices({
      registry: createRegistry(
        "diagnostics-prometheus",
        captureContext("diagnostics-prometheus", contexts),
      ),
      config: {},
      observeProviderUsage,
    });
    const pending = providerUsageCapability(contexts[0])?.(() => {});
    await handle.stop();
    gate.resolve();

    await expect(pending).rejects.toThrow("no longer active");
    expect(acquired).not.toHaveBeenCalled();
  });
});
