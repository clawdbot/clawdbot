import { randomUUID } from "node:crypto";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { withCoreCanvasNodeCapability } from "../canvas/constants.js";
import { validateConfiguredBindings } from "../channels/plugins/configured-binding-registry.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { getRuntimeConfig } from "../config/io.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { listAmbientOnlyConfiguredChannelIds } from "../plugins/channel-presence-policy.js";
import { prepareGatewayPluginMetadataSnapshotPublication } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import { createHookRunner } from "../plugins/hooks.js";
import { withPluginHttpRouteRegistry } from "../plugins/http-registry.js";
import { getPluginRuntimeGeneration, PluginRuntimeApplicationError } from "../plugins/lifecycle.js";
import { PluginLoadFailureError } from "../plugins/loader-shared.js";
import {
  createPluginCache,
  getProcessPluginCache,
  retirePluginCache,
  transferPluginCacheSetupModules,
  withPluginCache,
} from "../plugins/plugin-cache.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { loadPluginLookUpTable } from "../plugins/plugin-lookup-table.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { withPluginRegistryPreparationScope } from "../plugins/registry-lifecycle.js";
import {
  disposePluginRegistryInstances,
  waitForPluginRegistryRetirement,
} from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import {
  startPluginServices,
  PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
  type PluginServicesHandle,
} from "../plugins/services.js";
import { isGatewayWorkAdmissionClosed } from "../process/gateway-work-admission.js";
import { resolveGatewayStartupPluginActivationConfig } from "./plugin-activation-runtime-config.js";
import {
  indexPluginNodeCapabilitySurfaces,
  prepareClientPluginNodeCapabilities,
  reconcileClientPluginNodeCapabilities,
} from "./plugin-node-capability.js";
import type { prepareGatewayLifecycle } from "./server-lifecycle.js";
import type { prepareGatewayPluginLoad } from "./server-plugin-bootstrap.js";
import {
  GatewayConfigReloadSupersededError,
  type GatewayReloadHandlerParams,
} from "./server-reload-contracts.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-post-attach.js";
import { listPluginNodeCapabilities } from "./server/plugins-http/route-capability.js";

export async function reloadGatewayPlugins(
  {
    runtime,
    port,
    log,
    loadGatewayPluginBootstrapModule,
    prepareAttachedPluginRuntime,
  }: {
    runtime: Awaited<ReturnType<typeof prepareGatewayLifecycle>>;
    port: number;
    log: ReturnType<typeof createSubsystemLogger>;
    loadGatewayPluginBootstrapModule: () => Promise<typeof import("./server-plugin-bootstrap.js")>;
    prepareAttachedPluginRuntime: (loaded: ReturnType<typeof prepareGatewayPluginLoad>) => Promise<{
      publish: () => void;
      afterCommit: () => void;
    }>;
  },
  params: Parameters<GatewayReloadHandlerParams["reloadPlugins"]>[0],
): ReturnType<GatewayReloadHandlerParams["reloadPlugins"]> {
  const { prepareGatewayPluginLoad: preparePlugins } = await loadGatewayPluginBootstrapModule();
  const {
    pluginRuntime,
    kernel,
    pluginWorkspaceDir,
    runtimeState,
    ambientEnvTriggers,
    workerEnvironmentStartup,
    coreGatewayMethodNames,
    pluginHostServices,
    baseMethods,
    resolvePluginGatewayContext,
    channelManager,
    broadcastPluginEvent,
    clients,
    broadcast,
  } = runtime;
  const previousRegistry = pluginRuntime.registry;
  const previousConfig = getRuntimeConfig();
  const previousServices = kernel.pluginRuntimeGeneration.currentServices();
  const previousCache = getProcessPluginCache();
  const cache = createPluginCache();
  const operationId = params.pluginLifecycle?.operationId ?? randomUUID();
  const requestedIds = new Set(params.pluginLifecycle?.pluginIds ?? []);
  const replacePluginIds = new Set(requestedIds);
  for (const record of previousRegistry.plugins) {
    if (
      params.changedPaths.some(
        (key) =>
          key === `plugins.entries.${record.id}` ||
          key.startsWith(`plugins.entries.${record.id}.`) ||
          key === `plugins.installs.${record.id}` ||
          key.startsWith(`plugins.installs.${record.id}.`),
      )
    ) {
      replacePluginIds.add(record.id);
    }
  }
  let phase: "prepare" | "drain" | "activate" | "dispose" = "prepare";
  let committed = false;
  let candidateServices: PluginServicesHandle | undefined;
  let cleanupFailed = false;
  let loaded: ReturnType<typeof prepareGatewayPluginLoad> | undefined;
  let candidateRegistry: typeof previousRegistry | undefined;
  let changedPluginIds = new Set(requestedIds);
  let sidecarReplacements: ReturnType<
    NonNullable<GatewayPostReadySidecarHandle["preparePluginReload"]>
  >[] = [];
  let releaseChannelStarts: ReturnType<typeof channelManager.pauseChannelStarts> | undefined;
  const channelTargets = new Set<ChannelId>();
  const quiescedInstances: PluginInstanceHandle[] = [];
  const skipChannels =
    isTruthyEnvValue(params.env?.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(params.env?.OPENCLAW_SKIP_PROVIDERS);
  const stopReplacedChannels = async () => {
    for (const { plugin } of previousRegistry.channels) {
      if (!channelTargets.has(plugin.id)) {
        continue;
      }
      await channelManager.stopChannel(plugin.id, undefined, {
        manual: false,
        strict: true,
        routeHandoff: true,
      });
    }
  };
  const stopReplacedServices = async (services: PluginServicesHandle | null | undefined) => {
    await services?.stop({
      strict: true,
      deadlineAtMs: Date.now() + PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
      pluginIds: changedPluginIds,
    });
  };
  const runLifecycleHooks = async (
    registry: typeof previousRegistry,
    start: boolean,
    config: typeof previousConfig,
  ) => {
    const hooks = createHookRunner(
      {
        ...registry,
        typedHooks: registry.typedHooks.filter((hook) => changedPluginIds.has(hook.pluginId)),
      },
      {
        logger: log,
        catchErrors: false,
        voidHookTimeoutMsByHook: {
          gateway_start: PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
          gateway_stop: PLUGIN_SERVICE_REPLACEMENT_STOP_TIMEOUT_MS,
        },
      },
    );
    const context = {
      port,
      config,
      workspaceDir: pluginWorkspaceDir,
      // SAFETY: Gateway cron implements the SDK hook surface, which erases core-only job fields.
      getCron: () => runtimeState.cronState.cron as PluginHookGatewayCronService,
    };
    await withPluginHttpRouteRegistry(registry, () =>
      start
        ? hooks.runGatewayStart({ port }, context)
        : hooks.runGatewayStop({ reason: "plugin replacement" }, context),
    );
  };
  const replacement = kernel.pluginRuntimeGeneration.reserve();
  const assertCurrent = () => {
    params.assertInvokerOwned?.();
    if (params.isAborted?.()) {
      throw new GatewayConfigReloadSupersededError();
    }
  };
  try {
    assertCurrent();
    // Refresh this operation's cache while retaining the durable ledger of installed package roots.
    const nextMetadata = withPluginCache(cache, () =>
      loadPluginMetadataSnapshot({
        config: params.sourceConfig,
        workspaceDir: pluginWorkspaceDir,
        env: params.env,
        allowCurrent: false,
      }),
    );
    const activationConfig = resolveGatewayStartupPluginActivationConfig({
      runtimeConfig: params.nextConfig,
      activationSourceConfig: params.sourceConfig,
      env: params.env,
      manifestRegistry: nextMetadata.manifestRegistry,
      discovery: nextMetadata.discovery,
      ambientEnvTriggers,
    });
    const lookup = withPluginCache(cache, () =>
      loadPluginLookUpTable({
        config: activationConfig,
        workspaceDir: pluginWorkspaceDir,
        env: params.env,
        activationSourceConfig: params.sourceConfig,
        metadataSnapshot: nextMetadata,
        workerProviderIds: workerEnvironmentStartup?.listDurableProviderIds() ?? [],
        ambientEnvTriggers,
      }),
    );
    loaded = withPluginCache(cache, () =>
      preparePlugins({
        cfg: params.nextConfig,
        activationSourceConfig: params.sourceConfig,
        workspaceDir: pluginWorkspaceDir,
        log,
        coreGatewayMethodNames,
        hostServices: pluginHostServices,
        baseMethods,
        pluginLookUpTable: lookup,
        pluginMetadataSnapshot: nextMetadata,
        ambientEnvTriggers,
        resolveGatewayContext: resolvePluginGatewayContext,
        loadIntent: "replacement",
        previousRegistry,
        replacePluginIds,
        env: params.env,
      }),
    );
    const { pluginRegistry: nextRegistry, resolvedConfig } = loaded;
    candidateRegistry = nextRegistry;
    const attached = await prepareAttachedPluginRuntime(loaded);
    const publishMetadata = prepareGatewayPluginMetadataSnapshotPublication(nextMetadata, {
      config: params.nextConfig,
      compatibleConfigs: [params.sourceConfig, activationConfig],
      env: params.env,
      workspaceDir: pluginWorkspaceDir,
    });
    const surfaces = withCoreCanvasNodeCapability(
      listPluginNodeCapabilities(nextRegistry),
      isCoreCanvasHostEnabled(params.nextConfig),
    );
    const indexedSurfaces = indexPluginNodeCapabilitySurfaces(surfaces);
    await withPluginRegistryPreparationScope(nextRegistry, () =>
      withPluginRuntimeRegistryScope(nextRegistry, () =>
        validateConfiguredBindings(resolvedConfig),
      ),
    );
    const retainedRecords = new Set(nextRegistry.plugins);
    changedPluginIds = new Set([
      ...requestedIds,
      ...previousRegistry.plugins
        .filter((record) => !retainedRecords.has(record))
        .map((record) => record.id),
      ...nextRegistry.plugins
        .filter((record) => !previousRegistry.plugins.includes(record))
        .map((record) => record.id),
    ]);
    if (
      previousRegistry.commands.some((entry) => !nextRegistry.commands.includes(entry)) ||
      nextRegistry.commands.some((entry) => !previousRegistry.commands.includes(entry))
    ) {
      // Pending starts can retain commands before their first catalog read.
      for (const channel of previousRegistry.channels) {
        channelTargets.add(channel.plugin.id);
      }
    }
    for (const channel of [...previousRegistry.channels, ...nextRegistry.channels]) {
      if (changedPluginIds.has(channel.pluginId)) {
        channelTargets.add(channel.plugin.id);
      }
    }
    assertCurrent();
    releaseChannelStarts = channelManager.pauseChannelStarts(channelTargets);
    phase = "drain";
    sidecarReplacements = runtimeState.gatewayLifetimeSidecars.flatMap((sidecar) =>
      sidecar.preparePluginReload
        ? [
            sidecar.preparePluginReload({
              previousRegistry,
              nextRegistry,
              changedPluginIds,
              nextConfig: params.nextConfig,
            }),
          ]
        : [],
    );
    try {
      // Consumers must release their handles while the producing instance is callable.
      for (const sidecar of sidecarReplacements) {
        await sidecar.drain();
      }
      await runtimeState.discovery?.update({
        gatewayDiscoveryServices: previousRegistry.gatewayDiscoveryServices.filter(
          (entry) => !changedPluginIds.has(entry.pluginId),
        ),
      });
      for (const record of previousRegistry.plugins) {
        if (!changedPluginIds.has(record.id)) {
          continue;
        }
        const instance = getPluginInstance(record);
        if (instance?.quiesce()) {
          quiescedInstances.push(instance);
        } else if (instance) {
          // Failed cleanup stays fenced. Release channel and service lifetimes
          // before joining the instance, or the retry waits on work it must stop.
          await stopReplacedChannels();
          await stopReplacedServices(previousServices);
          await instance.drain();
        }
      }
      await runLifecycleHooks(previousRegistry, false, previousConfig);
      await stopReplacedChannels();
      await stopReplacedServices(previousServices);
    } catch (error) {
      cleanupFailed = true;
      throw error;
    }
    for (const record of previousRegistry.plugins) {
      if (changedPluginIds.has(record.id)) {
        await getPluginInstance(record)?.drain();
      }
    }
    assertCurrent();
    phase = "activate";
    const startedServices = await withPluginRegistryPreparationScope(nextRegistry, () =>
      startPluginServices({
        registry: nextRegistry,
        config: params.nextConfig,
        workspaceDir: pluginWorkspaceDir,
        broadcastPluginEvent,
        getCronService: () => runtimeState.cronState.cron,
        previous: previousServices,
        onHandle: (handle) => {
          candidateServices = handle;
        },
        throwOnStartError: true,
      }),
    );
    assertCurrent();
    try {
      await params.commitRuntime({
        publish: () => {
          assertCurrent();
          // Capture current connections without an await before selection. Credential
          // preparation may reject; after activation only prepared state is published.
          const publishCapabilities = [...clients].map((client) =>
            prepareClientPluginNodeCapabilities({
              client,
              surfaces,
              changedPluginIds,
              ...(client.connect.role === "node"
                ? { allowedSurfaces: new Set(client.connect.caps ?? []) }
                : {}),
            }),
          );
          attached.publish();
          transferPluginCacheSetupModules(previousCache, cache, changedPluginIds);
          publishMetadata();
          runtime.pluginMetadataSnapshot = nextMetadata;
          replacement.commit();
          kernel.pluginRuntimeGeneration.publishServices(replacement.claim, startedServices);
          // Compare handshake descriptors before the prepared credentials replace them.
          // Changed nodes stay invalidated while their connections close.
          for (const client of clients) {
            reconcileClientPluginNodeCapabilities(client, indexedSurfaces);
          }
          for (const publish of publishCapabilities) {
            publish();
          }
          committed = true;
          releaseChannelStarts?.("published");
        },
        afterCommit: () => {
          broadcast(
            "plugins.changed",
            { generation: getPluginRuntimeGeneration() },
            { dropIfSlow: true },
          );
          attached.afterCommit();
        },
      });
    } finally {
      if (committed) {
        for (const sidecar of sidecarReplacements) {
          sidecar.resume(params.nextConfig);
        }
        await runtimeState.discovery?.update(
          { gatewayDiscoveryServices: nextRegistry.gatewayDiscoveryServices },
          replacement.claim,
        );
      }
    }
    await runLifecycleHooks(nextRegistry, true, params.nextConfig);
    channelManager.setAmbientAutostartSuppressedChannelIds(
      ambientEnvTriggers === "suppress"
        ? new Set(
            listAmbientOnlyConfiguredChannelIds({
              config: params.nextConfig,
              activationSourceConfig: params.sourceConfig,
              env: params.env,
              includePersistedAuthState: false,
              manifestRecords: nextMetadata.manifestRegistry.plugins,
            }),
          )
        : new Set(),
    );
    for (const channel of nextRegistry.channels) {
      if (!skipChannels && channelTargets.has(channel.plugin.id)) {
        // Whole-channel targets include preparation that had not reserved an account at drain.
        const result = await channelManager.startChannel(channel.plugin.id, undefined, {
          manual: false,
          preserveManualStop: true,
        });
        const failures = [...result].filter(([, outcome]) => outcome.status === "retry");
        if (failures.length) {
          throw new Error(
            `Plugin channel ${channel.plugin.id} could not start: ${failures.map(([id]) => id).join(", ")}`,
          );
        }
      }
    }
    for (const channelId of channelTargets) {
      if (skipChannels || !nextRegistry.channels.some((entry) => entry.plugin.id === channelId)) {
        channelManager.releaseChannelRouteHandoffs(channelId);
      }
    }
    phase = "dispose";
    await waitForPluginRegistryRetirement(previousRegistry);
    await retirePluginCache(previousCache);
    const sourceDigests = Object.fromEntries(
      nextRegistry.plugins.flatMap((record) => {
        const digest = getPluginInstance(record)?.sourceDigest;
        return digest && changedPluginIds.has(record.id) ? [[record.id, digest]] : [];
      }),
    );
    const receipt = {
      operationId,
      generation: getPluginRuntimeGeneration(),
      pluginIds: [...changedPluginIds].toSorted(),
      sourceDigests,
    };
    return {
      restartChannels: channelTargets,
      activeChannels: new Set(nextRegistry.channels.map((entry) => entry.plugin.id)),
      runtime: receipt,
    };
  } catch (error) {
    let failure = error;
    const onCleanupFailure = (message: string) => (cleanupError: unknown) => {
      cleanupFailed = true;
      failure = new AggregateError([failure, cleanupError], message);
    };
    replacement.reject();
    if (!committed) {
      candidateRegistry ??= error instanceof PluginLoadFailureError ? error.registry : undefined;
      if (candidateServices) {
        // Retained services already moved here; shutdown must own them even if recovery is skipped.
        kernel.pluginRuntimeGeneration.publishServices(
          kernel.pluginRuntimeGeneration.currentClaim(),
          candidateServices,
        );
        await stopReplacedServices(candidateServices).catch(
          onCleanupFailure("Plugin candidate service cleanup failed"),
        );
      }
      loaded?.retireGatewayRuntimeBindings?.();
      if (candidateRegistry) {
        await disposePluginRegistryInstances(candidateRegistry, previousRegistry).catch(
          onCleanupFailure("Plugin candidate cleanup failed"),
        );
      }
      await retirePluginCache(cache).catch(
        onCleanupFailure("Plugin candidate cache cleanup failed"),
      );
      if (phase !== "prepare" && !isGatewayWorkAdmissionClosed()) {
        try {
          if (cleanupFailed) {
            throw new Error(
              "Previous services were not restarted because plugin cleanup did not complete.",
              { cause: error },
            );
          }
          for (const instance of quiescedInstances) {
            instance.resume();
          }
          await startPluginServices({
            registry: previousRegistry,
            config: previousConfig,
            workspaceDir: pluginWorkspaceDir,
            broadcastPluginEvent,
            getCronService: () => runtimeState.cronState.cron,
            previous: kernel.pluginRuntimeGeneration.currentServices(),
            onHandle: (handle) => {
              kernel.pluginRuntimeGeneration.publishServices(
                kernel.pluginRuntimeGeneration.currentClaim(),
                handle,
              );
            },
            throwOnStartError: true,
          });
          for (const sidecar of sidecarReplacements) {
            sidecar.resume(previousConfig);
          }
          await runtimeState.discovery?.update(
            { gatewayDiscoveryServices: previousRegistry.gatewayDiscoveryServices },
            kernel.pluginRuntimeGeneration.currentClaim(),
          );
          await runLifecycleHooks(previousRegistry, true, previousConfig);
          releaseChannelStarts?.("rollback");
          // A fence can cancel preparation before an account exists to record as stopped.
          for (const { plugin } of previousRegistry.channels) {
            if (!skipChannels && channelTargets.has(plugin.id)) {
              await channelManager.startChannel(plugin.id, undefined, {
                manual: false,
                preserveManualStop: true,
              });
            }
          }
        } catch (recoveryError) {
          // Failed cleanup keeps starts fenced; ingress stays retryable until retry or stop.
          if (!cleanupFailed) {
            for (const channelId of channelTargets) {
              channelManager.releaseChannelRouteHandoffs(channelId);
            }
          }
          failure = new AggregateError(
            [failure, recoveryError],
            "Plugin replacement failed and its previous instance could not be restored.",
          );
        }
      }
    } else {
      await retirePluginCache(previousCache).catch(
        onCleanupFailure("Previous plugin cache cleanup failed"),
      );
    }
    throw new PluginRuntimeApplicationError(
      `Plugin operation failed during ${phase}: ${failure instanceof Error ? failure.message : String(failure)}`,
      {
        operationId,
        generation: getPluginRuntimeGeneration(),
        pluginIds: [...replacePluginIds].toSorted(),
        phase,
        committed,
      },
      { cause: failure },
    );
  }
}
