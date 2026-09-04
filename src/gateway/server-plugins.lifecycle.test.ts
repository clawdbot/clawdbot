/**
 * Tests gateway plugin lifecycle loading, startup, and shutdown behavior.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { markGatewaySigusr1RestartHandled } from "../infra/restart.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { getFreePort } from "../test-utils/ports.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const INSTANCE_BINDING_PROBE_KEY = Symbol.for("openclaw.test.gatewayInstanceBindingProbe");
const INSTANCE_BINDING_PROBE_METHOD = "instanceBinding.probe";

type InstanceBindingProbeResult = {
  registryId: number;
  sessionsId: number;
  placementId: number;
};

type InstanceBindingProbeCoordinator = {
  identify: (value: object) => number;
  nextRegistryId: number;
  runtimes: PluginRuntime[];
  serviceStarts: number;
  serviceStops: number;
  serviceStopFailure?: "rejection" | "timeout";
};

function installInstanceBindingProbeCoordinator(options?: {
  serviceStopFailure?: InstanceBindingProbeCoordinator["serviceStopFailure"];
}): InstanceBindingProbeCoordinator {
  const ids = new WeakMap<object, number>();
  let nextId = 1;
  const coordinator: InstanceBindingProbeCoordinator = {
    identify(value) {
      const existing = ids.get(value);
      if (existing !== undefined) {
        return existing;
      }
      const id = nextId++;
      ids.set(value, id);
      return id;
    },
    nextRegistryId: 1,
    runtimes: [],
    serviceStarts: 0,
    serviceStops: 0,
    ...(options?.serviceStopFailure ? { serviceStopFailure: options.serviceStopFailure } : {}),
  };
  (globalThis as Record<PropertyKey, unknown>)[INSTANCE_BINDING_PROBE_KEY] = coordinator;
  return coordinator;
}

async function requireBoundRuntime(
  runtimes: readonly PluginRuntime[],
  label: string,
): Promise<{ runtime: PluginRuntime }> {
  for (const runtime of runtimes) {
    if (await runtime.gateway.isAvailable()) {
      // Plugin runtimes are proxies. Keep the async result non-thenable so
      // Promise assimilation does not materialize the broad runtime graph.
      return { runtime };
    }
  }
  throw new Error(`${label} Gateway did not register an instance-bound plugin runtime`);
}

function requestInstanceBindingProbe(runtime: PluginRuntime) {
  return runtime.gateway.request<InstanceBindingProbeResult>(
    INSTANCE_BINDING_PROBE_METHOD,
    {},
    { scopes: ["operator.read"] },
  );
}

async function writeInstanceBindingProbePlugin(): Promise<{ bundledRoot: string }> {
  const bundledRoot = tempDirs.make("openclaw-instance-binding-");
  const pluginDir = path.join(bundledRoot, "instance-binding-probe");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "package.json"),
    `${JSON.stringify({
      name: "instance-binding-probe",
      type: "commonjs",
      main: "index.js",
      openclaw: { extensions: ["./index.js"] },
      peerDependencies: { openclaw: ">=2026.1.1" },
    })}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "openclaw.plugin.json"),
    `${JSON.stringify({
      id: "instance-binding-probe",
      name: "Startup plugin",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    })}\n`,
  );
  await fs.writeFile(
    path.join(pluginDir, "index.js"),
    `module.exports = {
  id: "instance-binding-probe",
  register(api) {
    const coordinator = globalThis[Symbol.for("openclaw.test.gatewayInstanceBindingProbe")];
    const registryId = coordinator.nextRegistryId++;
    coordinator.runtimes.push(api.runtime);
    if (coordinator.serviceStopFailure) {
      api.registerService({
        id: "instance-binding-service",
        start() {
          coordinator.serviceStarts += 1;
        },
        stop() {
          coordinator.serviceStops += 1;
          if (coordinator.serviceStopFailure === "rejection") {
            return Promise.reject(new Error("instance-binding service cleanup rejected"));
          }
          if (coordinator.serviceStopFailure === "timeout") {
            return new Promise(() => {});
          }
        },
      });
    }
    api.registerGatewayMethod("${INSTANCE_BINDING_PROBE_METHOD}", ({ context, respond }) => {
      respond(true, {
        registryId,
        sessionsId: coordinator.identify(context.sessionCompanion),
        placementId: coordinator.identify(context.workerSessionPlacementService),
      });
    }, { scope: "operator.read" });
  },
};
`,
  );
  return { bundledRoot };
}

async function prepareInstanceBindingTest(options?: {
  serviceStopFailure?: InstanceBindingProbeCoordinator["serviceStopFailure"];
}) {
  const configIo = await import("../config/io.js");
  const actualIo = await vi.importActual<typeof import("../config/io.js")>("../config/io.js");
  // These RPCs await the writer's runtime receipt, which the shared IO mock does not publish.
  const configWriter = vi
    .spyOn(configIo, "writeConfigFile")
    .mockImplementation(actualIo.writeConfigFile);
  onTestFinished(() => configWriter.mockRestore());
  const coordinator = installInstanceBindingProbeCoordinator(options);
  const plugin = await writeInstanceBindingProbePlugin();
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
  delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = plugin.bundledRoot;
  process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("gateway test hooks did not install OPENCLAW_CONFIG_PATH");
  }
  const config = {
    plugins: {
      enabled: true,
      allow: ["instance-binding-probe"],
      entries: { "instance-binding-probe": { enabled: true } },
    },
  };
  const { loadPluginLookUpTable } = await import("../plugins/plugin-lookup-table.js");
  expect(loadPluginLookUpTable({ config, env: process.env }).startup.pluginIds).toContain(
    "instance-binding-probe",
  );
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`);
  return { coordinator, bundledRoot: plugin.bundledRoot };
}

describe("gateway plugin instance bindings", () => {
  const started: Array<Awaited<ReturnType<typeof startTestGatewayServer>>> = [];
  const sockets: Array<Awaited<ReturnType<typeof connectWebchatClient>>> = [];

  afterEach(async () => {
    // Synthetic recovery emits no signal for a run loop to consume. Reopen admission
    // before teardown joins background work that may be waiting behind that fence.
    markGatewaySigusr1RestartHandled();
    for (const socket of sockets.splice(0)) {
      socket.close();
    }
    for (const server of started.splice(0).toReversed()) {
      await server.close({ reason: "instance binding cleanup" });
    }
    delete (globalThis as Record<PropertyKey, unknown>)[INSTANCE_BINDING_PROBE_KEY];
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  });

  it(
    "keeps unscoped plugin work bound to each real Gateway across reverse shutdown",
    { timeout: 600_000 },
    async () => {
      const { coordinator } = await prepareInstanceBindingTest();

      const first = await startTestGatewayServer(await getFreePort(), {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(first);
      await first.startupSettled;
      const sharedMetadata = getGatewayPluginMetadataSnapshot();
      expect(sharedMetadata).toBeDefined();

      await expect(
        startTestGatewayServer(await getFreePort(), {
          bind: "loopback",
          host: "0.0.0.0",
          auth: { mode: "none" },
          controlUiEnabled: false,
          sidecarStartup: "defer",
        }),
      ).rejects.toThrow("gateway bind=loopback resolved to non-loopback host");
      expect(getGatewayPluginMetadataSnapshot()).toBe(sharedMetadata);
      const firstRegistrationCount = coordinator.runtimes.length;
      expect(firstRegistrationCount).toBeGreaterThan(0);
      const { runtime: firstRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(0, firstRegistrationCount),
        "first",
      );

      const second = await startTestGatewayServer(await getFreePort(), {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(second);
      await second.startupSettled;
      expect(getGatewayPluginMetadataSnapshot()).toBe(sharedMetadata);
      expect(coordinator.runtimes.length).toBeGreaterThan(firstRegistrationCount);
      const { runtime: secondRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(firstRegistrationCount),
        "second",
      );

      const firstProbe = await requestInstanceBindingProbe(firstRuntime);
      const secondProbe = await requestInstanceBindingProbe(secondRuntime);
      expect(firstProbe.registryId).not.toBe(secondProbe.registryId);
      expect(firstProbe.sessionsId).not.toBe(secondProbe.sessionsId);
      expect(firstProbe.placementId).not.toBe(secondProbe.placementId);
      await expect(
        firstRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });
      await expect(
        secondRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });

      await second.close({ reason: "close last-started Gateway first" });
      started.pop();
      clearPluginMetadataLifecycleCaches();
      expect(getGatewayPluginMetadataSnapshot()).toBe(sharedMetadata);
      await expect(requestInstanceBindingProbe(secondRuntime)).rejects.toThrow(
        "In-process gateway dispatch requires a gateway request scope or instance binding",
      );
      await expect(requestInstanceBindingProbe(firstRuntime)).resolves.toEqual(firstProbe);
      await expect(
        firstRuntime.subagent.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });
      await first.close({ reason: "close final Gateway metadata owner" });
      started.pop();
      expect(getGatewayPluginMetadataSnapshot()).toBeUndefined();
    },
  );

  it(
    "keeps startup metadata through hot reload and discovers manifest changes after Gateway restart",
    { timeout: 600_000 },
    async () => {
      const { coordinator, bundledRoot } = await prepareInstanceBindingTest();

      const port = await getFreePort();
      const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
      const server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        hotReloadRecovery,
        sidecarStartup: "start",
      });
      started.push(server);
      await server.startupSettled;
      const startupMetadata = getGatewayPluginMetadataSnapshot();
      expect(startupMetadata?.byPluginId.get("instance-binding-probe")?.name).toBe(
        "Startup plugin",
      );
      const manifestPath = path.join(bundledRoot, "instance-binding-probe", "openclaw.plugin.json");
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      await fs.writeFile(manifestPath, JSON.stringify({ ...manifest, name: "Changed plugin" }));
      const initialRegistrationCount = coordinator.runtimes.length;
      expect(initialRegistrationCount).toBeGreaterThan(0);
      const { runtime: initialRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(0, initialRegistrationCount),
        "initial",
      );
      const initialProbe = await requestInstanceBindingProbe(initialRuntime);

      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const currentConfig = await rpcReq<{ hash?: string }>(socket, "config.get", {});
      expect(currentConfig.ok).toBe(true);
      expect(typeof currentConfig.payload?.hash).toBe("string");
      const reload = await rpcReq(socket, "config.patch", {
        raw: JSON.stringify({
          plugins: {
            entries: {
              "instance-binding-probe": {
                subagent: { allowModelOverride: true },
              },
            },
          },
        }),
        baseHash: currentConfig.payload?.hash,
      });
      expect(reload.ok, reload.error?.message).toBe(true);
      await expect
        .poll(() => coordinator.runtimes.length, { timeout: 300_000 })
        .toBeGreaterThan(initialRegistrationCount);
      const { runtime: reloadedRuntime } = await requireBoundRuntime(
        coordinator.runtimes.slice(initialRegistrationCount),
        "hot-reloaded",
      );
      const reloadedProbe = await requestInstanceBindingProbe(reloadedRuntime);

      expect(reloadedProbe.registryId).not.toBe(initialProbe.registryId);
      expect(reloadedProbe.sessionsId).toBe(initialProbe.sessionsId);
      expect(reloadedProbe.placementId).toBe(initialProbe.placementId);
      expect(getGatewayPluginMetadataSnapshot()).toBe(startupMetadata);
      expect(
        getGatewayPluginMetadataSnapshot()?.byPluginId.get("instance-binding-probe")?.name,
      ).toBe("Startup plugin");
      expect(hotReloadRecovery).not.toHaveBeenCalled();
      await expect(requestInstanceBindingProbe(initialRuntime)).rejects.toThrow(
        "In-process gateway dispatch requires a gateway request scope or instance binding",
      );
      await expect(
        reloadedRuntime.subagent.getSessionMessages({
          sessionKey: "agent:main:main",
          limit: 1,
        }),
      ).resolves.toEqual({ messages: [] });

      socket.close();
      sockets.splice(sockets.indexOf(socket), 1);
      await server.close({ reason: "plugin metadata restart" });
      started.splice(started.indexOf(server), 1);
      const restarted = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        sidecarStartup: "start",
      });
      started.push(restarted);
      await restarted.startupSettled;
      expect(
        getGatewayPluginMetadataSnapshot()?.byPluginId.get("instance-binding-probe")?.name,
      ).toBe("Changed plugin");
    },
  );

  it.each(["rejection", "timeout"] as const)(
    "retains the previous registry when real plugin replacement cleanup fails by %s",
    { timeout: 600_000 },
    async (serviceStopFailure) => {
      const { coordinator } = await prepareInstanceBindingTest({ serviceStopFailure });
      const hotReloadRecovery = vi.fn(() => {
        // No run loop consumes this synthetic emission, so release its signal-admission lease.
        markGatewaySigusr1RestartHandled();
        return { status: "emitted" as const };
      });
      const port = await getFreePort();
      const server = await startTestGatewayServer(port, {
        auth: { mode: "none" },
        controlUiEnabled: false,
        hotReloadRecovery,
        sidecarStartup: "start",
      });
      started.push(server);
      await server.startupSettled;

      const initialRegistry = getActivePluginRegistry();
      const initialRuntimeConfig = getActiveSecretsRuntimeConfigSnapshot()?.config;
      const initialRegistrationCount = coordinator.runtimes.length;
      const initialHandler = initialRegistry?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD];
      expect(initialRegistry).toBeDefined();
      expect(initialRuntimeConfig).toBeDefined();
      expect(initialHandler).toBeTypeOf("function");
      expect(coordinator.serviceStarts).toBe(1);

      const socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
      sockets.push(socket);
      const currentConfig = await rpcReq<{ hash?: string }>(socket, "config.get", {});
      expect(currentConfig.ok).toBe(true);
      const reload = await rpcReq(socket, "config.patch", {
        raw: JSON.stringify({
          plugins: {
            entries: {
              "instance-binding-probe": {
                subagent: { allowModelOverride: true },
              },
            },
          },
        }),
        baseHash: currentConfig.payload?.hash,
      });
      expect(reload).toMatchObject({
        ok: false,
        error: {
          code: "UNAVAILABLE",
          message: expect.stringContaining("not applied to the active Gateway (failed)"),
        },
      });

      await expect.poll(() => hotReloadRecovery.mock.calls.length, { timeout: 30_000 }).toBe(1);
      expect(coordinator.serviceStops).toBe(1);
      expect(coordinator.serviceStarts).toBe(1);
      expect(coordinator.runtimes).toHaveLength(initialRegistrationCount);
      expect(getActiveSecretsRuntimeConfigSnapshot()?.config).toBe(initialRuntimeConfig);
      expect(getActivePluginRegistry()).toBe(initialRegistry);
      expect(getActivePluginRegistry()?.gatewayHandlers[INSTANCE_BINDING_PROBE_METHOD]).toBe(
        initialHandler,
      );
    },
  );
});

// A real plugin registry replacement must own accounts before their first route exists.
describe("Gateway plugin replacement channel ownership", () => {
  const channelId = "reload-webhook";
  const channelKey = Symbol.for("openclaw.test.reloadWebhookChannel");
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  let socket: Awaited<ReturnType<typeof connectWebchatClient>> | undefined;
  let releasePending = createDeferredCore();

  afterEach(async () => {
    releasePending.resolve();
    socket?.close();
    await server?.close({ reason: "webhook reload cleanup" });
    delete (globalThis as Record<PropertyKey, unknown>)[channelKey];
    delete (globalThis as Record<PropertyKey, unknown>)[INSTANCE_BINDING_PROBE_KEY];
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
  });

  it.each([
    {
      name: "hands off live and pending webhook accounts while preserving a manual stop",
      teardownFails: false,
    },
    {
      name: "keeps channels fenced while recovery retries failed service teardown",
      teardownFails: true,
    },
  ])("$name", { timeout: 120_000 }, async ({ teardownFails }) => {
    releasePending = createDeferredCore();
    const starts = new Map<string, number>();
    const channel: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: channelId,
        config: {
          listAccountIds: () => ["active", "pending", "parked"],
          resolveAccount: (_cfg, accountId) => ({ accountId }),
          isEnabled: () => true,
          isConfigured: () => true,
        },
      }),
      gateway: {
        async startAccount({ accountId, abortSignal, setStatus }) {
          const generation = (starts.get(accountId) ?? 0) + 1;
          starts.set(accountId, generation);
          const aborted = new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          });
          if (accountId === "pending" && generation === 1) {
            await Promise.race([releasePending.promise, aborted]);
          }
          if (abortSignal.aborted) {
            return;
          }
          const unregister = registerPluginHttpRoute({
            path: `/reload-webhook/${accountId}`,
            auth: "plugin",
            pluginId: channelId,
            accountId,
            throwOnFailure: true,
            handler: (_req, res) => {
              const registry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
              res.setHeader(
                "x-webhook-registry",
                registry === getActivePluginRegistry() ? "current" : "stale",
              );
              res.end(`${accountId}:${generation}`);
            },
          });
          setStatus({ accountId, running: true, connected: true, lifecycle: "ready" });
          try {
            await aborted;
          } finally {
            unregister();
          }
        },
      },
    };
    (globalThis as Record<PropertyKey, unknown>)[channelKey] = channel;
    const coordinator = installInstanceBindingProbeCoordinator(
      teardownFails ? { serviceStopFailure: "rejection" } : undefined,
    );
    const { bundledRoot } = await writeInstanceBindingProbePlugin();
    const pluginDir = path.join(bundledRoot, channelId);
    await fs.mkdir(pluginDir);
    await fs.writeFile(
      path.join(pluginDir, "package.json"),
      JSON.stringify({
        name: channelId,
        type: "commonjs",
        main: "index.js",
        openclaw: { extensions: ["./index.js"] },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: channelId,
        activation: { onStartup: true },
        channels: [channelId],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    await fs.writeFile(
      path.join(pluginDir, "index.js"),
      `module.exports = {
      id: "reload-webhook",
      register(api) { api.registerChannel({ plugin: globalThis[Symbol.for("openclaw.test.reloadWebhookChannel")] }); }
    };`,
    );
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    delete process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS;
    process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;
    process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    delete process.env.OPENCLAW_SKIP_CHANNELS;
    delete process.env.OPENCLAW_SKIP_PROVIDERS;
    const configPath = process.env.OPENCLAW_CONFIG_PATH;
    if (!configPath) {
      throw new Error("Gateway fixture did not set config path");
    }
    const config = loadGatewayTestConfig();
    config.plugins = {
      ...config.plugins,
      enabled: true,
      allow: ["instance-binding-probe", channelId],
      entries: {
        ...config.plugins?.entries,
        "instance-binding-probe": { enabled: true },
        [channelId]: { enabled: true },
      },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    const port = await getFreePort();
    const hotReloadRecovery = vi.fn(() => ({
      status: teardownFails ? ("failed" as const) : ("emitted" as const),
    }));
    // Use the real runtime in Vitest's graph; native loading evaluates its mocked graph again.
    const runtimeModule = await import("../plugins/runtime/index.js");
    const loaderModule = await import("../plugins/loader-module-runtime.js");
    const createLazyRuntime = loaderModule.createLazyPluginRuntime;
    const runtimeLoader = vi
      .spyOn(loaderModule, "createLazyPluginRuntime")
      .mockImplementation((params) =>
        createLazyRuntime({ ...params, loadPluginModule: () => runtimeModule }),
      );
    onTestFinished(() => runtimeLoader.mockRestore());
    server = await startTestGatewayServer(port, {
      auth: { mode: "none" },
      controlUiEnabled: false,
      sidecarStartup: "start",
      hotReloadRecovery,
    });
    await server.startupSettled;
    const probe = async (accountId: string) => {
      const response = await fetch(`http://127.0.0.1:${port}/reload-webhook/${accountId}`, {
        method: "POST",
      });
      return {
        status: response.status,
        body: await response.text(),
        registry: response.headers.get("x-webhook-registry"),
      };
    };
    await expect
      .poll(() => [...starts.keys()].toSorted(), { timeout: 30_000 })
      .toEqual(["active", "parked", "pending"]);
    expect(await probe("active")).toEqual({
      status: 200,
      body: "active:1",
      registry: "current",
    });
    expect((await probe("pending")).status).toBe(404);
    socket = await connectWebchatClient({ port, scopes: ["operator.admin"] });
    const stopped = await rpcReq(socket, "channels.stop", {
      channel: channelId,
      accountId: "parked",
    });
    expect(stopped.ok, stopped.error?.message).toBe(true);
    expect((await probe("parked")).status).toBe(404);

    const initialRegistry = getActivePluginRegistry();
    config.plugins.entries!["instance-binding-probe"] = {
      enabled: true,
      subagent: { allowModelOverride: true },
    };
    await fs.writeFile(configPath, JSON.stringify(config));
    if (teardownFails) {
      await expect
        .poll(() => hotReloadRecovery.mock.calls.length, { timeout: 30_000 })
        .toBeGreaterThan(0);
      expect(coordinator.serviceStops).toBe(1);
      expect(getActivePluginRegistry()).toBe(initialRegistry);
      expect(starts.get("active")).toBe(1);
      const restarted = await rpcReq(socket, "channels.start", {
        channel: channelId,
        accountId: "active",
      });
      expect(restarted.ok).toBe(false);
      expect(restarted.error?.message).toContain("plugins are reloading; retry");
      expect(starts.get("active")).toBe(1);
      expect((await probe("active")).status).toBe(404);
      return;
    }
    await expect
      .poll(() => getActivePluginRegistry() !== initialRegistry, { timeout: 180_000 })
      .toBe(true);
    await expect
      .poll(() => probe("active"), { timeout: 30_000 })
      .toEqual({ status: 200, body: "active:2", registry: "current" });
    await expect
      .poll(() => probe("pending"), { timeout: 30_000 })
      .toEqual({ status: 200, body: "pending:2", registry: "current" });
    releasePending.resolve();
    expect(await probe("pending")).toEqual({
      status: 200,
      body: "pending:2",
      registry: "current",
    });
    expect((await probe("parked")).status).toBe(404);
    expect(starts.get("parked")).toBe(1);
    expect(hotReloadRecovery).not.toHaveBeenCalled();
  });
});
