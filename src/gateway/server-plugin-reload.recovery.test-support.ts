import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger, type SubsystemLogger } from "../logging/subsystem.js";
import { adoptPluginHttpRouteHandoffs, registerPluginHttpRoute } from "../plugins/http-registry.js";
import { activatePluginRegistry } from "../plugins/loader-shared.js";
import {
  createPluginCommandRuntime,
  type PluginCommandCatalogDecision,
} from "../plugins/plugin-command-runtime.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createPluginRegistry } from "../plugins/registry.js";
import {
  createPluginRegistryOwner,
  disposePluginRegistryInstances,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { startPluginServices, type PluginServicesHandle } from "../plugins/services.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { OpenClawPluginApi } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";
import { createChannelManager } from "./server-channels.js";
import { reloadGatewayPlugins } from "./server-plugin-reload.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";

export async function createPluginReloadRecoveryFixture(
  {
    cleanups,
    logMocks,
  }: {
    cleanups: Array<() => Promise<void>>;
    logMocks: Pick<SubsystemLogger, "info" | "warn" | "error" | "debug">;
  },
  options: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    register?: (api: OpenClawPluginApi, owner: "first" | "sibling") => void;
    abortOnCandidateStart?: boolean;
    prepareAttached?: () => Promise<void>;
    initialStop?: () => Promise<void>;
    beforePublish?: () => Promise<void>;
    afterPublish?: () => Promise<void>;
    assertInvokerOwned?: () => void;
    candidateStart?: () => void;
    candidateStop?: () => Promise<void>;
    recoveryStart?: () => Promise<void>;
    recoveryStop?: () => Promise<void>;
  } = {},
) {
  let config: OpenClawConfig = options.config ?? {
    plugins: { allow: ["first", "sibling"] },
  };
  setRuntimeConfigSnapshot(config);
  const log = { ...createSubsystemLogger("gateway/plugins"), ...logMocks };
  const createBuilder = () =>
    createPluginRegistry({
      logger: log,
      runtime: {} as PluginRuntime,
      activateGlobalSideEffects: false,
    });
  const previous = createBuilder();
  let firstStarts = 0;
  let aborted = false;
  const firstStart = vi.fn(async () => {
    firstStarts += 1;
    if (firstStarts > 1) {
      await options.recoveryStart?.();
    }
  });
  const firstStop = vi.fn(async () => {
    if (firstStarts > 1) {
      await options.recoveryStop?.();
    } else {
      await options.initialStop?.();
    }
  });
  const firstRecord = createPluginRecord({ id: "first" });
  previous.registry.plugins.push(firstRecord);
  const firstApi = previous.createApi(firstRecord, { config });
  options.register?.(firstApi, "first");
  firstApi.registerService({
    id: "first",
    start: firstStart,
    stop: firstStop,
  });
  const siblingStart = vi.fn();
  const siblingStop = vi.fn();
  const siblingRecord = createPluginRecord({ id: "sibling" });
  previous.registry.plugins.push(siblingRecord);
  const siblingApi = previous.createApi(siblingRecord, { config });
  options.register?.(siblingApi, "sibling");
  siblingApi.registerService({
    id: "sibling",
    start: siblingStart,
    stop: siblingStop,
  });
  setActivePluginRegistry(previous.registry);
  const registryOwner = createPluginRegistryOwner(previous.registry);
  const initial = await startPluginServices({ registry: previous.registry, config });
  let currentServices: PluginServicesHandle | null = initial;
  const owner = createGatewayPluginRuntimeGeneration({
    getServices: () => currentServices,
    setServices: (handle) => {
      currentServices = handle;
    },
  });
  const candidateStop = vi.fn(async () => await options.candidateStop?.());
  const candidates: ReturnType<typeof createBuilder>[] = [];
  const preparePlugins = ({ cfg }: { cfg: OpenClawConfig }) => {
    const candidate = createBuilder();
    candidates.push(candidate);
    if (cfg.plugins?.entries?.first?.enabled !== false) {
      const record = createPluginRecord({ id: "first" });
      candidate.registry.plugins.push(record);
      const api = candidate.createApi(record, { config: cfg });
      options.register?.(api, "first");
      api.registerService({
        id: "first",
        start: () => {
          aborted = options.abortOnCandidateStart !== false;
          options.candidateStart?.();
        },
        stop: async () => await candidateStop(),
      });
    }
    candidate.registry.plugins.push(siblingRecord);
    candidate.registry.channels.push(
      ...previous.registry.channels.filter((entry) => entry.pluginId === "sibling"),
    );
    candidate.registry.transcriptSourceProviders.push(
      ...previous.registry.transcriptSourceProviders.filter(
        (entry) => entry.pluginId === "sibling",
      ),
    );
    candidate.registry.services.push(
      ...previous.registry.services.filter((entry) => entry.pluginId === "sibling"),
    );
    candidate.registry.gatewayDiscoveryServices.push(
      ...previous.registry.gatewayDiscoveryServices.filter((entry) => entry.pluginId === "sibling"),
    );
    return {
      pluginRegistry: candidate.registry,
      resolvedConfig: cfg,
      gatewayMethods: [],
      retireGatewayRuntimeBindings: vi.fn(),
    };
  };
  const runtime = {
    pluginRuntime: registryOwner,
    kernel: { pluginRuntimeGeneration: owner },
    runtimeState: { cronState: {}, gatewayLifetimeSidecars: [], postReadySidecars: [] },
    ambientEnvTriggers: "suppress",
    coreGatewayMethodNames: [],
    baseMethods: [],
    channelManager: {
      pauseChannelStarts: () => () => {},
      releaseChannelRouteHandoffs: vi.fn(),
      setAmbientAutostartSuppressedChannelIds: vi.fn(),
    },
    clients: new Set(),
    broadcast: vi.fn(),
  } as unknown as Parameters<typeof reloadGatewayPlugins>[0]["runtime"];
  cleanups.push(async () => {
    await currentServices?.stop().catch(() => {});
    await initial.stop().catch(() => {});
    await registryOwner.close();
    for (const candidate of candidates) {
      await disposePluginRegistryInstances(candidate.registry, previous.registry);
    }
  });
  const reload = (nextConfig = config) => {
    aborted = false;
    return withPluginRuntimeRegistryScope(registryOwner.registry, () =>
      reloadGatewayPlugins(
        {
          runtime,
          port: 0,
          log,
          loadGatewayPluginBootstrapModule: async () => ({
            prepareGatewayPluginLoad: preparePlugins,
          }),
          prepareAttachedPluginRuntime: async (candidate) => {
            await options.prepareAttached?.();
            return {
              publish: () => {
                adoptPluginHttpRouteHandoffs(registryOwner.registry, candidate.pluginRegistry);
                activatePluginRegistry(
                  candidate.pluginRegistry,
                  null,
                  "gateway-bindable",
                  undefined,
                  registryOwner.registry,
                );
                registryOwner.publish(candidate.pluginRegistry);
              },
              afterCommit: vi.fn(),
            };
          },
        },
        {
          nextConfig,
          sourceConfig: nextConfig,
          changedPaths: [],
          pluginLifecycle: {
            reason: "reload",
            operationId: "service-recovery",
            pluginIds: ["first"],
          },
          commitRuntime: async (publication) => {
            await options.beforePublish?.();
            publication?.publish();
            config = nextConfig;
            setRuntimeConfigSnapshot(config);
            publication?.afterCommit?.();
            await options.afterPublish?.();
          },
          env: options.env ?? {},
          isAborted: () => aborted,
          assertInvokerOwned: options.assertInvokerOwned,
        },
      ),
    );
  };
  return {
    runtime,
    getConfig: () => config,
    owner,
    registryOwner,
    previousRegistry: previous.registry,
    reload,
    firstStart,
    firstStop,
    siblingStart,
    siblingStop,
    candidateStop,
  };
}

type RecoveryFixtureFactory = (
  options?: Parameters<typeof createPluginReloadRecoveryFixture>[1],
) => ReturnType<typeof createPluginReloadRecoveryFixture>;

export async function verifyGatewayCleanupRetry(
  createRecoveryFixture: RecoveryFixtureFactory,
  withChannels: boolean,
) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const hookStart = vi.fn();
  const hookStop = vi.fn(async () => {
    entered.resolve();
    await release.promise;
  });
  const channelIds = { first: "cleanup-first", sibling: "cleanup-sibling" } as const;
  const signals = { first: [] as AbortSignal[], sibling: [] as AbortSignal[] };
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    register: (api, owner) => {
      if (owner === "first") {
        api.on("gateway_start", hookStart);
        api.on("gateway_stop", hookStop);
      }
      if (withChannels) {
        api.registerChannel({
          plugin: {
            ...createChannelTestPluginBase({ id: channelIds[owner] }),
            gateway: {
              startAccount: async ({ abortSignal }) => {
                signals[owner].push(abortSignal);
                await new Promise<void>((resolve) => {
                  abortSignal.addEventListener("abort", () => resolve(), { once: true });
                });
              },
            },
          },
        });
      }
    },
  });
  const manager = createChannelManager({
    getRuntimeConfig: fixture.getConfig,
    channelLogs: {},
    channelRuntimeEnvs: {},
    getPluginRegistry: () => fixture.registryOwner.registry,
  });
  if (withChannels) {
    fixture.runtime.channelManager = manager;
    await manager.startChannel(channelIds.first);
    await manager.startChannel(channelIds.sibling);
    await vi.waitFor(() => {
      expect(signals.first).toHaveLength(1);
      expect(signals.sibling).toHaveLength(1);
    });
  }
  const instance = getPluginInstance(fixture.previousRegistry.plugins[0]!);
  assert(instance);
  vi.useFakeTimers();
  let retry: Promise<unknown> | undefined;
  const reloading = fixture.reload().catch((error: unknown) => error);
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await reloading).toMatchObject({ details: { phase: "drain", committed: false } });
    expect(hookStart).not.toHaveBeenCalled();
    expect(() => instance.run(() => "closed")).toThrow("reloaded or disabled");
    if (withChannels) {
      expect(signals.first[0]?.aborted).toBe(false);
      expect(signals.sibling[0]?.aborted).toBe(false);
    }
    retry = fixture.reload();
    await vi.advanceTimersByTimeAsync(0);
    expect(hookStop).toHaveBeenCalledOnce();
    if (withChannels) {
      expect(signals.first[0]?.aborted).toBe(true);
      expect(signals.sibling[0]?.aborted).toBe(false);
    }
    expect(() => instance.run(() => "still closed")).toThrow("reloaded or disabled");
    release.resolve();
    await retry;
    expect(hookStop).toHaveBeenCalledTimes(2);
    expect(hookStart).toHaveBeenCalledOnce();
    if (withChannels) {
      expect(signals.first).toHaveLength(2);
      expect(signals.first[1]?.aborted).toBe(false);
      expect(signals.sibling).toHaveLength(1);
      expect(signals.sibling[0]?.aborted).toBe(false);
    }
  } finally {
    release.resolve();
    if (withChannels) {
      // Also release the original deadlock on the pre-fix RED path before joining it.
      await manager.stopChannel(channelIds.first);
    }
    await Promise.allSettled([reloading, retry]);
    if (withChannels) {
      await manager.stopChannel(channelIds.first);
      await manager.stopChannel(channelIds.sibling);
    }
    vi.useRealTimers();
  }
}

export async function verifyPendingServiceCleanupRetry(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const hookEntered = createDeferredCore();
  const hookRelease = createDeferredCore();
  const startupEntered = createDeferredCore();
  const startupRelease = createDeferredCore();
  let starts = 0;
  const serviceStop = vi.fn(() => {
    if (starts === 2) {
      startupRelease.resolve();
    }
  });
  const hookStop = vi.fn(async () => {
    hookEntered.resolve();
    await hookRelease.promise;
  });
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    register: (api, owner) => {
      if (owner === "first") {
        api.on("gateway_stop", hookStop);
        api.registerService({
          id: "pending-startup",
          start: () => {
            if (++starts === 2) {
              startupEntered.resolve();
              return startupRelease.promise;
            }
            return undefined;
          },
          stop: serviceStop,
        });
      }
    },
  });
  await fixture.owner.currentServices()?.stop();
  // Startup publishes its issued handle before awaiting the service promise.
  const startup = startPluginServices({
    registry: fixture.previousRegistry,
    config: fixture.getConfig(),
    onHandle: (handle) => {
      expect(fixture.owner.publishServices(fixture.owner.currentClaim(), handle)).toBe(true);
    },
  });
  await startupEntered.promise;
  const instance = getPluginInstance(fixture.previousRegistry.plugins[0]!);
  assert(instance);
  vi.useFakeTimers();
  let retry: Promise<unknown> | undefined;
  const first = fixture.reload().catch((error: unknown) => error);
  try {
    await hookEntered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await first).toMatchObject({ details: { phase: "drain", committed: false } });
    expect(serviceStop).toHaveBeenCalledOnce();
    hookRelease.resolve();
    retry = fixture.reload().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_000);
    const failedRetry = await retry;
    expect(serviceStop).toHaveBeenCalledTimes(2);
    expect(failedRetry).toMatchObject({ details: { phase: "drain", committed: false } });
    await startup;
    expect(() => instance.run(() => "still fenced")).toThrow("reloaded or disabled");
    await expect(fixture.reload()).resolves.toMatchObject({ runtime: { pluginIds: ["first"] } });
    expect(starts).toBe(3);
    expect(hookStop).toHaveBeenCalledTimes(2);
  } finally {
    hookRelease.resolve();
    startupRelease.resolve();
    await Promise.allSettled([first, retry, startup]);
    vi.useRealTimers();
  }
}

export async function verifyChannelReplacementContracts(
  createRecoveryFixture: RecoveryFixtureFactory,
) {
  const channelId = "reload-contract";
  const dispatches: PluginCommandCatalogDecision[] = [];
  const starts: number[] = [];
  const stops: number[] = [];
  const commands: Array<ReturnType<typeof vi.fn>> = [];
  let registrations = 0;
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    beforePublish: async () => {
      const route = fixture.previousRegistry.httpRoutes[0];
      assert(route);
      const request = new IncomingMessage(new Socket());
      const response = new ServerResponse(request);
      const end = vi.spyOn(response, "end").mockReturnValue(response);
      try {
        await route.handler(request, response);
        expect(response.statusCode).toBe(503);
        expect(response.getHeader("Retry-After")).toBe("1");
        expect(end).toHaveBeenCalledWith("plugin route is restarting; retry");
        expect(starts).toEqual([1]);
        expect(stops).toEqual([1]);
      } finally {
        request.destroy();
        response.destroy();
      }
    },
    register(api, owner) {
      if (owner !== "first") {
        return;
      }
      const generation = ++registrations;
      const handler = vi.fn(async () => ({ text: `generation ${generation}` }));
      commands.push(handler);
      api.registerCommand({
        name: "refresh",
        description: "Refresh",
        channels: [channelId],
        handler,
      });
      api.registerChannel({
        plugin: {
          ...createChannelTestPluginBase({ id: channelId }),
          gateway: {
            startAccount: async ({ abortSignal }) => {
              starts.push(generation);
              const command = createPluginCommandRuntime().listNativeCandidates(channelId)[0];
              assert(command);
              dispatches.push(command.prepareDispatch());
              const unregister = registerPluginHttpRoute({
                path: "/reload-contract",
                auth: "plugin",
                pluginId: "first",
                source: "account",
                throwOnFailure: true,
                handler: (_req, res) => {
                  res.end(`generation ${generation}`);
                },
              });
              try {
                await new Promise<void>((resolve) => {
                  if (abortSignal.aborted) {
                    resolve();
                    return;
                  }
                  abortSignal.addEventListener("abort", () => resolve(), { once: true });
                });
              } finally {
                unregister();
              }
            },
            stopAccount: async () => {
              stops.push(generation);
            },
          },
        },
      });
    },
  });
  const manager = createChannelManager({
    getRuntimeConfig: fixture.getConfig,
    getPluginRegistry: () => fixture.registryOwner.registry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  fixture.runtime.channelManager = manager;
  try {
    await manager.startChannel(channelId);
    expect(starts).toEqual([1]);
    expect(fixture.previousRegistry.httpRoutes).toHaveLength(1);
    await fixture.reload();
    expect(starts).toEqual([1, 2]);
    expect(stops).toEqual([1]);
    expect(fixture.registryOwner.registry.httpRoutes).toHaveLength(1);
    expect(fixture.registryOwner.registry.httpRoutes[0]?.handoff).not.toBe(true);
    const [stale, current] = dispatches;
    assert(stale?.kind === "plugin" && current?.kind === "plugin");
    const context = {
      channel: channelId,
      isAuthorizedSender: true,
      commandBody: "/refresh",
      config: {},
    };
    await expect(stale.execute(context)).resolves.toMatchObject({
      text: expect.stringContaining("registry changed"),
    });
    await expect(current.execute(context)).resolves.toEqual({ text: "generation 2" });
    expect(commands[0]).not.toHaveBeenCalled();
    expect(commands[1]).toHaveBeenCalledOnce();
  } finally {
    await manager.stopChannel(channelId);
  }
  expect(stops).toEqual([1, 2]);
  expect(fixture.registryOwner.registry.httpRoutes).toEqual([]);
}

export async function verifyChannelCleanupFailureFence(
  createRecoveryFixture: RecoveryFixtureFactory,
  failure: "rejection" | "timeout",
) {
  const stopEntered = createDeferredCore();
  const releaseStop = createDeferredCore();
  const gatewayStart = vi.fn();
  const signals = { first: [] as AbortSignal[], sibling: [] as AbortSignal[] };
  let cleanupAllowed = false;
  const stopAccount = vi.fn(async () => {
    stopEntered.resolve();
    if (!cleanupAllowed) {
      if (failure === "rejection") {
        throw new Error("channel cleanup refused");
      }
      await releaseStop.promise;
    }
  });
  const fixture = await createRecoveryFixture({
    abortOnCandidateStart: false,
    register(api, owner) {
      if (owner === "first") {
        api.on("gateway_start", gatewayStart);
      }
      api.registerChannel({
        plugin: {
          ...createChannelTestPluginBase({ id: `cleanup-${owner}` }),
          gateway: {
            startAccount: async ({ abortSignal }) => {
              signals[owner].push(abortSignal);
              await new Promise<void>((resolve) => {
                if (abortSignal.aborted) {
                  resolve();
                  return;
                }
                abortSignal.addEventListener("abort", () => resolve(), { once: true });
              });
            },
            ...(owner === "first" ? { stopAccount } : {}),
          },
        },
      });
    },
  });
  const manager = createChannelManager({
    getRuntimeConfig: fixture.getConfig,
    getPluginRegistry: () => fixture.registryOwner.registry,
    channelLogs: {},
    channelRuntimeEnvs: {},
  });
  fixture.runtime.channelManager = manager;
  await manager.startChannel("cleanup-first");
  await manager.startChannel("cleanup-sibling");
  await vi.waitFor(() => {
    expect(signals.first).toHaveLength(1);
    expect(signals.sibling).toHaveLength(1);
  });
  const first = getPluginInstance(fixture.previousRegistry.plugins[0]!);
  const sibling = getPluginInstance(fixture.previousRegistry.plugins[1]!);
  assert(first && sibling);
  vi.useFakeTimers();
  const reloading = fixture.reload().catch((error: unknown) => error);
  try {
    await stopEntered.promise;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await reloading).toMatchObject({ details: { phase: "drain", committed: false } });
    expect(fixture.registryOwner.registry).toBe(fixture.previousRegistry);
    expect(() => first.run(() => "must remain fenced")).toThrow("reloaded or disabled");
    expect(gatewayStart).not.toHaveBeenCalled();
    expect(fixture.firstStart).toHaveBeenCalledOnce();
    await expect(manager.startChannel("cleanup-first")).rejects.toThrow("plugins are reloading");
    expect(sibling.run(() => "still live")).toBe("still live");
    expect(signals.sibling).toHaveLength(1);
    expect(signals.sibling[0]?.aborted).toBe(false);

    cleanupAllowed = true;
    releaseStop.resolve();
    await fixture.reload();
    expect(stopAccount).toHaveBeenCalledTimes(2);
    expect(gatewayStart).toHaveBeenCalledOnce();
    expect(signals.first).toHaveLength(2);
    expect(signals.first[1]?.aborted).toBe(false);
    expect(signals.sibling).toHaveLength(1);
    expect(signals.sibling[0]?.aborted).toBe(false);
  } finally {
    cleanupAllowed = true;
    releaseStop.resolve();
    await reloading;
    await manager.stopChannel("cleanup-first");
    await manager.stopChannel("cleanup-sibling");
    vi.useRealTimers();
  }
}
