/** Real Gateway channel ownership across plugin replacement and failed cleanup. */
import fs from "node:fs/promises";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  clearInstanceBindingProbeCoordinators,
  installInstanceBindingProbeCoordinator,
  writeInstanceBindingProbePlugin,
} from "./server-plugins.lifecycle.test-fixtures.js";
import { installInstanceBindingConfigIo } from "./server-plugins.lifecycle.test-support.js";
import { loadGatewayTestConfig } from "./test-helpers.config-runtime.js";
import {
  connectWebchatClient,
  installGatewayTestHooks,
  rpcReq,
  startTestGatewayServer,
} from "./test-helpers.server.js";

// Fixtures must register real plugins after the shared helpers install their mocks.
vi.doUnmock("../plugins/loader.js");
installGatewayTestHooks({ scope: "suite" });
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
installInstanceBindingConfigIo();

// A real plugin registry replacement must own accounts before their first route exists.
describe("Gateway plugin replacement channel ownership", () => {
  const channelId = "reload-webhook";
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;
  let socket: Awaited<ReturnType<typeof connectWebchatClient>> | undefined;
  let releasePending = createDeferredCore();

  afterEach(async () => {
    releasePending.resolve();
    socket?.close();
    try {
      await server?.close({ reason: "webhook reload cleanup" });
    } finally {
      clearInstanceBindingProbeCoordinators();
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
      server = undefined;
      socket = undefined;
    }
  });

  it.each([
    {
      name: "hands off live and pending webhook accounts while preserving a manual stop",
      teardownFails: false,
    },
    {
      name: "keeps changed channels fenced after failed service teardown",
      teardownFails: true,
    },
  ])("$name", { timeout: 120_000 }, async ({ teardownFails }) => {
    releasePending = createDeferredCore();
    const starts = new Map<string, number>();
    const channelPlugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: channelId,
        config: {
          listAccountIds: () => ["active", "pending", "parked"],
          defaultAccountId: () => "pending",
          inspectAccount: (_cfg, accountId) => ({
            accountId: `${accountId}-display`,
            enabled: true,
            configured: true,
          }),
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
            pluginId: "instance-binding-probe",
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
    const coordinator = installInstanceBindingProbeCoordinator(
      teardownFails ? { serviceStopFailure: "rejection" } : undefined,
    );
    coordinator.channel = channelPlugin;
    const bundledRoot = tempDirs.make("openclaw-instance-binding-");
    await writeInstanceBindingProbePlugin(bundledRoot, coordinator.channelName, channelId);
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
      allow: ["instance-binding-probe"],
      entries: {
        ...config.plugins?.entries,
        "instance-binding-probe": { enabled: true },
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
    const reload = await rpcReq(socket, "plugins.reload", {
      pluginId: "instance-binding-probe",
    });
    if (teardownFails) {
      expect(reload).toMatchObject({
        ok: false,
        error: { details: { runtime: { phase: "drain", committed: false } } },
      });
      expect(hotReloadRecovery).not.toHaveBeenCalled();
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
      expect(await probe("active")).toEqual({
        status: 503,
        body: "plugin route is restarting; retry",
        registry: null,
      });
      expect((await probe("parked")).status).toBe(404);
      const defaultStart = await rpcReq(socket, "channels.start", { channel: channelId });
      expect(defaultStart.ok).toBe(false);
      expect(defaultStart.error?.message).toContain("plugins are reloading; retry");
      const defaultStop = await rpcReq(socket, "channels.stop", { channel: channelId });
      expect(defaultStop, defaultStop.error?.message).toMatchObject({
        ok: true,
        payload: { accountId: "pending", stopped: true },
      });
      for (const stop of [false, true]) {
        if (stop) {
          const stoppedAfterFailure = await rpcReq(socket, "channels.stop", {
            channel: channelId,
            accountId: "active",
          });
          expect(stoppedAfterFailure.ok, stoppedAfterFailure.error?.message).toBe(true);
          expect(stoppedAfterFailure.payload).toMatchObject({ stopped: true });
          expect((await probe("active")).status).toBe(404);
        }
        const status = await rpcReq(socket, "channels.status", { channel: channelId, probe: true });
        expect(status, status.error?.message).toMatchObject({
          ok: true,
          payload: {
            partial: true,
            channelDefaultAccountId: { [channelId]: "pending" },
            channelAccounts: {
              [channelId]: ["active", "pending", "parked"].map((accountId) => ({
                accountId: `${accountId}-display`,
                running: false,
              })),
            },
          },
        });
      }
      return;
    }
    expect(reload.ok, reload.error?.message).toBe(true);
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
