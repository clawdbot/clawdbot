import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerPluginHttpRoute } from "./http-registry.js";
import { createEmptyPluginRegistry } from "./registry.js";
import { listPluginServiceHealthFailures } from "./service-health.js";
import { startPluginServices, type PluginServicesHandle } from "./services.js";
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
