import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { loadGetReplyFromConfigRuntime } from "../auto-reply/reply/dispatch-from-config.runtime-loaders.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredInternalHooks } from "../hooks/configured.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { GatewayActiveWorkInspectors } from "../infra/gateway-active-work.js";
import { hasRestartSentinel } from "../infra/restart-sentinel.js";
import type {
  initializeGatewayUpdateStatus,
  scheduleGatewayUpdateCheck,
} from "../infra/update-startup.js";
import type { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { getPluginModuleLoaderStats } from "../plugins/plugin-module-loader-cache.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import {
  isGatewayRestartDrainError,
  runWithGatewayIndependentRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { sweepSessionStateWatchNotices } from "../sessions/session-state-events.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  canReadDetailedUpdateMetadata,
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  projectUpdateAvailable,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type { GatewayControlUiRootLifecycle } from "./server-control-ui-root.js";
import type { GatewayRecoveryRuntime } from "./server-instance-runtime.types.js";
import type { GatewayClient, GatewayContextResolver } from "./server-methods/shared-types.js";
import type { GatewayPluginRuntimeClaim } from "./server-plugin-runtime-generation.js";
import type { refreshLatestUpdateRestartSentinel } from "./server-restart-sentinel.js";
import type { GatewaySidecarStartupMode } from "./server-sidecar-startup-mode.js";
import { scheduleContextCachePrewarm } from "./server-startup-context-cache-prewarm.js";
import { scheduleGatewayHandlerPrewarm } from "./server-startup-handler-prewarm.js";
import type { logGatewayStartup } from "./server-startup-log.js";
import {
  createGatewayStartupOutcomeRecorder,
  formatGatewayStartupOutcomes,
  type GatewayStartupOutcomeRecorder,
} from "./server-startup-outcomes.js";
import { measureStartup, type GatewayStartupTrace } from "./server-startup-trace.js";
import {
  beginMacOSSystemCaWarmupOnce,
  type warmMacOSSystemCaOffMainThread,
} from "./system-ca-warmup.js";
const ACP_BACKEND_READY_TIMEOUT_MS = 5_000;
const ACP_BACKEND_READY_POLL_MS = 50;
const PROVIDER_AUTH_PREWARM_START_DELAY_MS = 5_000;
const PROVIDER_AUTH_REWARM_DELAY_MS = 1_000;
const DEFERRED_SIDECAR_START_DELAY_MS = 100;
const SKIP_STARTUP_MODEL_PREWARM_ENV = "OPENCLAW_SKIP_STARTUP_MODEL_PREWARM";
type Awaitable<T> = T | Promise<T>;

const loadMainSessionRestartRecoveryModule = createLazyRuntimeModule(
  () => import("../agents/main-session-recovery/main-session-restart-recovery.js"),
);
// Startup only needs orphan marking; keep resume and delivery runtime out of the pre-channel path.
const loadMainSessionRestartRecoveryMarkingModule = createLazyRuntimeModule(
  () => import("../agents/main-session-recovery/main-session-restart-recovery-marking.js"),
);

const loadAgentDefaultsModule = createLazyRuntimeModule(() => import("../agents/defaults.js"));

const loadAgentModelSelectionModule = createLazyRuntimeModule(
  () => import("../agents/model-selection.js"),
);

const loadInternalHooksModule = createLazyRuntimeModule(() => import("../hooks/internal-hooks.js"));

const loadGatewayRestartSentinelModule = createLazyRuntimeModule(
  () => import("./server-restart-sentinel.js"),
);

export type GatewayPostReadySidecarHandle = { stop: () => Awaitable<void> };

/** Measure provider-auth warming without letting event-loop stalls hide in wall time. */
async function measureProviderAuthWarm(run: () => Promise<void>): Promise<{
  elapsedMs: number;
  eventLoopMaxMs: number;
}> {
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
  eventLoopDelay.enable();
  const startMs = performance.now();
  try {
    await run();
  } finally {
    eventLoopDelay.disable();
  }
  return {
    elapsedMs: performance.now() - startMs,
    eventLoopMaxMs: eventLoopDelay.max / 1_000_000,
  };
}

function formatProviderAuthWarmMetrics(metrics: {
  elapsedMs: number;
  eventLoopMaxMs: number;
}): string {
  return `in ${metrics.elapsedMs.toFixed(0)}ms eventLoopMax=${metrics.eventLoopMaxMs.toFixed(1)}ms`;
}

function shouldCheckRestartSentinel(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.VITEST && env.NODE_ENV !== "test";
}

function shouldSkipStartupModelPrewarm(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvValue(env[SKIP_STARTUP_MODEL_PREWARM_ENV]);
}

function schedulePostAttachUpdateSentinelRefresh(params: {
  startupTrace?: GatewayStartupTrace;
  log: { warn: (msg: string) => void };
  refreshLatestUpdateRestartSentinel: () => Awaitable<
    ReturnType<typeof refreshLatestUpdateRestartSentinel>
  >;
}): void {
  const handle = setImmediate(() => {
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      await measureStartup(params.startupTrace, "post-attach.update-sentinel", async () => {
        await params.refreshLatestUpdateRestartSentinel();
      });
    }).catch((err: unknown) => {
      params.log.warn(`restart sentinel refresh failed: ${String(err)}`);
    });
  });
  handle.unref?.();
}

function scheduleProviderAuthStatePrewarm(params: {
  getConfig: () => OpenClawConfig;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  delayMs?: number;
  startupWarmEnabled: boolean;
}): GatewayPostReadySidecarHandle {
  let stopped = false;
  let startupTimer: ReturnType<typeof setTimeout> | undefined;
  let rewarmTimer: ReturnType<typeof setTimeout> | undefined;
  let rewarmInFlight = false;
  let pendingRewarmReason: string | undefined;
  const isStopped = () => stopped;
  const delayMs = params.delayMs ?? PROVIDER_AUTH_PREWARM_START_DELAY_MS;
  const logProviderAuthWarmFailure = (operation: string, error: unknown) => {
    if (!isGatewayRestartDrainError(error)) {
      params.log.warn(`provider auth state ${operation} failed: ${String(error)}`);
    }
  };
  void runWithGatewayIndependentRootWorkAdmission(async () => {
    const [{ setAuthProfileFailureHook }, { clearCurrentProviderAuthState }] = await Promise.all([
      import("../agents/auth-profiles/failure-hook.js"),
      import("../agents/model-provider-auth-state.js"),
    ]);
    const loadProviderAuthWarmModule = () => import("../agents/model-provider-auth.js");
    const runRewarm = async (reason: string) => {
      await runWithGatewayIndependentRootWorkAdmission(async () => {
        if (isStopped()) {
          return;
        }
        const cfg = params.getConfig();
        rewarmInFlight = true;
        try {
          const { warmCurrentProviderAuthStateOffMainThread } = await loadProviderAuthWarmModule();
          const metrics = await measureProviderAuthWarm(() =>
            warmCurrentProviderAuthStateOffMainThread(cfg, { isCancelled: isStopped }),
          );
          if (isStopped()) {
            return;
          }
          params.log.info(
            `provider auth state re-warmed (${reason}) ${formatProviderAuthWarmMetrics(metrics)}`,
          );
        } catch (err) {
          logProviderAuthWarmFailure("rewarm", err);
        } finally {
          rewarmInFlight = false;
          const nextReason = pendingRewarmReason;
          pendingRewarmReason = undefined;
          if (nextReason && !isStopped()) {
            scheduleAuthMapRewarm(nextReason);
          }
        }
      });
    };
    const scheduleAuthMapRewarm = (reason: string) => {
      // Collapse repeated auth-profile failures into one rewarm turn while a
      // previous rewarm is queued or running.
      if (isStopped()) {
        return;
      }
      pendingRewarmReason = reason;
      if (rewarmTimer || rewarmInFlight) {
        return;
      }
      rewarmTimer = setTimeout(() => {
        rewarmTimer = undefined;
        const nextReason = pendingRewarmReason ?? reason;
        pendingRewarmReason = undefined;
        void runRewarm(nextReason).catch((error: unknown) =>
          logProviderAuthWarmFailure("rewarm", error),
        );
      }, PROVIDER_AUTH_REWARM_DELAY_MS);
      rewarmTimer.unref?.();
    };
    if (isStopped()) {
      return;
    }
    setAuthProfileFailureHook(() => {
      if (isStopped()) {
        return;
      }
      clearCurrentProviderAuthState();
      scheduleAuthMapRewarm("auth-profile-failure");
    });
    // Keep the broad provider sweep explicit; default startup only retains
    // failure-triggered repair so discovery cannot starve gateway work.
    if (!params.startupWarmEnabled) {
      return;
    }
    startupTimer = setTimeout(
      () => {
        void runWithGatewayIndependentRootWorkAdmission(async () => {
          if (isStopped()) {
            return;
          }
          const cfg = params.getConfig();
          const { warmCurrentProviderAuthStateOffMainThread } = await loadProviderAuthWarmModule();
          const metrics = await measureProviderAuthWarm(() =>
            warmCurrentProviderAuthStateOffMainThread(cfg, { isCancelled: isStopped }),
          );
          if (isStopped()) {
            return;
          }
          params.log.info(
            `provider auth state pre-warmed ${formatProviderAuthWarmMetrics(metrics)}`,
          );
        }).catch((error: unknown) => logProviderAuthWarmFailure("pre-warm", error));
      },
      Math.max(0, delayMs),
    );
    startupTimer.unref?.();
  }).catch((error: unknown) => logProviderAuthWarmFailure("pre-warm setup", error));
  return {
    stop: () => {
      stopped = true;
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = undefined;
      }
      if (rewarmTimer) {
        clearTimeout(rewarmTimer);
        rewarmTimer = undefined;
      }
    },
  };
}

function schedulePostReadySidecarTask(params: {
  startupTrace?: GatewayStartupTrace;
  name: string;
  log: { warn: (msg: string) => void };
  run: (isStopped: () => boolean, signal: AbortSignal) => Awaitable<void>;
  stop?: () => Awaitable<void>;
  waitForPostReadyWork?: () => Promise<void>;
}): GatewayPostReadySidecarHandle {
  let stopped = false;
  const abortController = new AbortController();
  const isStopped = () => stopped;
  const handle = setImmediate(() => {
    void (async () => {
      await params.waitForPostReadyWork?.();
      if (isStopped()) {
        return;
      }
      await runWithGatewayIndependentRootWorkAdmission(async () => {
        await measureStartup(params.startupTrace, params.name, () =>
          params.run(isStopped, abortController.signal),
        );
      });
    })().catch((err: unknown) => {
      params.log.warn(`${params.name} failed after gateway ready: ${String(err)}`);
    });
  });
  handle.unref?.();
  return {
    stop: async () => {
      // Sidecars get both a synchronous stopped predicate and an AbortSignal so
      // lazy imports and long-running watchers can cooperate with shutdown.
      stopped = true;
      abortController.abort();
      clearImmediate(handle);
      await params.stop?.();
    },
  };
}

function scheduleGatewayGenerationTimer(params: {
  delayMs: number;
  run: (isStopped: () => boolean) => Awaitable<void>;
  onError: (err: unknown) => void;
}): GatewayPostReadySidecarHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const isStopped = () => stopped;
  timer = setTimeout(() => {
    timer = undefined;
    if (isStopped()) {
      return;
    }
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      await params.run(isStopped);
    }).catch((err: unknown) => {
      if (!isStopped()) {
        params.onError(err);
      }
    });
  }, params.delayMs);
  timer.unref?.();
  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}

function scheduleRestartSentinelWakeAfterReady(params: {
  deps: CliDeps;
  log: { warn: (msg: string) => void };
}): GatewayPostReadySidecarHandle {
  return scheduleGatewayGenerationTimer({
    delayMs: 750,
    run: async (isStopped) => {
      const { scheduleRestartSentinelWake } = await loadGatewayRestartSentinelModule();
      if (isStopped()) {
        return;
      }
      await scheduleRestartSentinelWake({ deps: params.deps });
    },
    onError: (err) => params.log.warn(`restart sentinel wake failed to schedule: ${String(err)}`),
  });
}

function scheduleTranscriptsAutoStartSidecar(params: {
  cfg: OpenClawConfig;
  startupTrace?: GatewayStartupTrace;
  log: { warn: (msg: string) => void };
  waitForPostReadyWork?: () => Promise<void>;
}): GatewayPostReadySidecarHandle {
  let stopTranscriptsAutoStart: (() => Promise<void>) | undefined;
  return schedulePostReadySidecarTask({
    startupTrace: params.startupTrace,
    name: "sidecars.transcripts-auto-start",
    log: params.log,
    waitForPostReadyWork: params.waitForPostReadyWork,
    run: async (isStopped) => {
      const { createTranscriptsAutoStartService } =
        await import("../agents/tools/transcripts-tool.js");
      if (isStopped()) {
        return;
      }
      const service = createTranscriptsAutoStartService({
        config: params.cfg,
        stateDir: resolveStateDir(),
        logger: params.log,
      });
      stopTranscriptsAutoStart = () => service.stop();
      service.start();
    },
    stop: async () => {
      await stopTranscriptsAutoStart?.();
    },
  });
}

async function hasRestartSentinelFast(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return await hasRestartSentinel(env);
}

async function refreshLatestUpdateRestartSentinelIfPresent(): Promise<Awaited<
  ReturnType<typeof refreshLatestUpdateRestartSentinel>
> | null> {
  if (!(await hasRestartSentinelFast())) {
    return null;
  }
  return await (await loadGatewayRestartSentinelModule()).refreshLatestUpdateRestartSentinel();
}

function hasGatewayStartHooks(pluginRegistry: ReturnType<typeof loadOpenClawPlugins>): boolean {
  return pluginRegistry.typedHooks.some((hook) => hook.hookName === "gateway_start");
}

async function hasGatewayStartupInternalHookListeners(): Promise<boolean> {
  const { hasInternalHookListeners } = await loadInternalHooksModule();
  return hasInternalHookListeners("gateway", "startup");
}

async function waitForAcpRuntimeBackendReady(params: {
  backendId?: string;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<boolean> {
  const { getAcpRuntimeBackend } = await import("../acp/runtime/registry.js");
  const timeoutMs = params.timeoutMs ?? ACP_BACKEND_READY_TIMEOUT_MS;
  const pollMs = params.pollMs ?? ACP_BACKEND_READY_POLL_MS;
  const deadline = Date.now() + timeoutMs;

  do {
    const backend = getAcpRuntimeBackend(params.backendId);
    if (backend) {
      try {
        if (!backend.healthy || backend.healthy()) {
          return true;
        }
      } catch {
        // Treat transient backend health probe errors like "not ready yet".
      }
    }
    await sleep(pollMs, undefined, { ref: false });
  } while (Date.now() < deadline);

  return false;
}

async function prewarmConfiguredPrimaryModel(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig | Promise<OpenClawConfig>;
  isCurrent?: () => boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir?: string;
  log: { warn: (msg: string) => void };
  startupTrace?: GatewayStartupTrace;
}): Promise<void> {
  await publishConfiguredModelRuntimeSnapshots(params);
}

type StartupExternalAuthHydrationDeps = {
  listAgentIds: (cfg: OpenClawConfig) => string[];
  resolveAgentDir: (cfg: OpenClawConfig, agentId: string) => string;
  collectConfiguredRefs: (cfg: OpenClawConfig, agentId: string) => readonly { value: string }[];
  hydrate: (cfg: OpenClawConfig, agentDir: string, providers: readonly string[]) => void;
};

async function hydrateConfiguredExternalCliAuth(params: {
  getConfig: () => OpenClawConfig;
  log: { warn: (msg: string) => void };
  deps?: StartupExternalAuthHydrationDeps | Promise<StartupExternalAuthHydrationDeps>;
}): Promise<OpenClawConfig> {
  const deps: StartupExternalAuthHydrationDeps =
    (await params.deps) ??
    (await Promise.all([
      import("../agents/agent-scope.js"),
      import("../agents/prepared-model-runtime.configured.js"),
      import("../agents/auth-profiles/store.js"),
      import("../agents/auth-profiles/external-cli-discovery.js"),
    ]).then(([scope, configured, store, external]) => ({
      listAgentIds: scope.listAgentIds,
      resolveAgentDir: scope.resolveAgentDir,
      collectConfiguredRefs: configured.collectPreparedModelRuntimeConfiguredRefs,
      hydrate: (cfg: OpenClawConfig, agentDir: string, providers: readonly string[]) => {
        const discovery = external.externalCliDiscoveryForProviders({ cfg, providers });
        if (discovery.mode === "none") {
          return;
        }
        store.ensureAuthProfileStore(agentDir, {
          config: cfg,
          externalCli: discovery,
          allowKeychainPrompt: false,
          readOnly: true,
          syncExternalCli: false,
        });
      },
    })));
  const cfg = params.getConfig();
  const hydratedDirs = new Set<string>();
  for (const agentId of deps.listAgentIds(cfg)) {
    const providers = deps.collectConfiguredRefs(cfg, agentId).flatMap(({ value }) => {
      const separator = value.indexOf("/");
      return separator > 0 ? [value.slice(0, separator)] : [];
    });
    const agentDir = deps.resolveAgentDir(cfg, agentId);
    if (providers.length === 0 || hydratedDirs.has(agentDir)) {
      continue;
    }
    hydratedDirs.add(agentDir);
    try {
      deps.hydrate(cfg, agentDir, providers);
    } catch (error) {
      params.log.warn(
        `startup external CLI auth hydration failed for agent ${agentId}: ${String(error)}`,
      );
    }
  }
  return cfg;
}

async function publishConfiguredModelRuntimeSnapshots(params: {
  cfg: OpenClawConfig;
  getConfig?: () => OpenClawConfig | Promise<OpenClawConfig>;
  isCurrent?: () => boolean;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir?: string;
  log: { warn: (msg: string) => void };
  startupTrace?: GatewayStartupTrace;
}): Promise<void> {
  const { refreshPreparedModelRuntimeSnapshots } =
    await import("../agents/prepared-model-runtime.js");
  if (params.isCurrent?.() === false) {
    return;
  }
  await refreshPreparedModelRuntimeSnapshots(params.getConfig ?? params.cfg, {
    gatewayLifecycle: true,
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
    ...(params.isCurrent ? { isPublicationCurrent: params.isCurrent } : {}),
    ...(params.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
      : {}),
    ...(params.workspaceDir ? { defaultWorkspaceDir: params.workspaceDir } : {}),
    ...(params.startupTrace
      ? {
          onBuildStats: (stats) =>
            params.startupTrace?.detail("sidecars.model-runtime-build", [
              ["agentCount", stats.agentCount],
              ["workspaceGroupCount", stats.workspaceGroupCount],
              ["configuredFactsGroupCount", stats.configuredFactsGroupCount],
              ["catalogSourceCount", stats.catalogSourceCount],
              ["credentialGroupCount", stats.credentialGroupCount],
              ["catalogGroupCount", stats.catalogGroupCount],
              ["runtimeRegistryCount", stats.runtimeRegistryCount],
              ["configuredRuntimeModelCount", stats.configuredRuntimeModelCount],
              ["generatedCatalogPluginCount", stats.generatedCatalogPluginCount],
              ["generatedCatalogReadCount", stats.generatedCatalogReadCount],
              ["workspaceFactsMs", stats.workspaceFactsMs],
              ["runtimePluginMs", stats.runtimePluginMs],
              ["pluginMetadataMs", stats.pluginMetadataMs],
              ["staticProviderCatalogMs", stats.staticProviderCatalogMs],
              ["ambientCredentialsMs", stats.ambientCredentialsMs],
              ["agentFactsMs", stats.agentFactsMs],
              ["configuredProjectionMs", stats.configuredProjectionMs],
              ["catalogSourceMs", stats.catalogSourceMs],
              ["registryMs", stats.registryMs],
              ["sourceConcurrencyLimitCount", stats.sourceConcurrencyLimit],
              ["fullCatalogConcurrencyLimitCount", stats.fullCatalogConcurrencyLimit],
            ]),
        }
      : {}),
  });
}

async function publishStartupModelRuntime(
  params: {
    cfg: OpenClawConfig;
    getConfig?: () => OpenClawConfig | Promise<OpenClawConfig>;
    isCurrent?: () => boolean;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    workspaceDir?: string;
    log: { warn: (msg: string) => void };
    startupTrace?: GatewayStartupTrace;
  },
  prewarm: typeof prewarmConfiguredPrimaryModel = prewarmConfiguredPrimaryModel,
): Promise<void> {
  const publication = shouldSkipStartupModelPrewarm()
    ? publishConfiguredModelRuntimeSnapshots
    : prewarm;
  await publication(params);
}

/** Start post-ready sidecars such as channels, hooks, plugin services, and cleanup tasks. */
export async function startGatewaySidecars(params: {
  cfg: OpenClawConfig;
  getModelRuntimeConfig?: () => OpenClawConfig;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  shouldStartChannels?: () => boolean;
  refreshChatMetadata?: () => Promise<void>;
  onChannelsStarted?: () => Awaitable<void>;
  prewarmPrimaryModel?: typeof prewarmConfiguredPrimaryModel;
  onPluginServices?: (pluginServices: PluginServicesHandle | null) => void;
  onPostReadySidecars?: (sidecars: GatewayPostReadySidecarHandle[]) => void;
  shouldCreatePostReadySidecars?: () => boolean;
  shouldStartPluginServices?: () => boolean;
  pluginRuntimeClaim?: GatewayPluginRuntimeClaim;
  broadcastPluginEvent?: import("./server-broadcast-types.js").GatewayPluginEventBroadcastFn;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  startupTrace?: GatewayStartupTrace;
  startupOutcomes?: GatewayStartupOutcomeRecorder;
  mainSessionRecoveryStartupCheckedStorePaths?: Set<string>;
  waitForPostReadyWork?: () => Promise<void>;
}) {
  const postReadySidecars: GatewayPostReadySidecarHandle[] = [];

  const internalHooksConfigured = hasConfiguredInternalHooks(params.cfg);
  await measureStartup(params.startupTrace, "sidecars.internal-hooks", async () => {
    try {
      if (internalHooksConfigured) {
        const [{ setInternalHooksEnabled }, { loadInternalHooks }] = await Promise.all([
          loadInternalHooksModule(),
          import("../hooks/loader.js"),
        ]);
        setInternalHooksEnabled(params.cfg.hooks?.internal?.enabled !== false);
        const loadedCount = await loadInternalHooks(params.cfg, params.defaultWorkspaceDir);
        if (loadedCount > 0) {
          params.startupOutcomes?.record({ subsystem: "internal-hooks", status: "loaded" });
          params.logHooks.info(
            `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
          );
        } else {
          params.startupOutcomes?.record({
            subsystem: "internal-hooks",
            status: "skipped",
            reason: "no-handlers-loaded",
          });
        }
      }
    } catch (err) {
      params.startupOutcomes?.record({
        subsystem: "internal-hooks",
        status: "failed",
        reason: "see earlier log",
      });
      params.logHooks.error(`failed to load hooks: ${String(err)}`);
    }
  });

  const mainSessionRecoveryStartupCheckedStorePaths =
    params.mainSessionRecoveryStartupCheckedStorePaths ?? new Set<string>();
  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  // These runs were orphaned by the previous Gateway lifecycle. Record that fact
  // even if this process later fails model preparation and never starts channels.
  await measureStartup(params.startupTrace, "sidecars.main-session-recovery", async () => {
    try {
      const { markStartupOrphanedMainSessionsForRecovery } = await measureStartup(
        params.startupTrace,
        "sidecars.main-session-recovery-load",
        loadMainSessionRestartRecoveryMarkingModule,
      );
      await measureStartup(params.startupTrace, "sidecars.main-session-recovery-scan", () =>
        markStartupOrphanedMainSessionsForRecovery({
          cfg: params.cfg,
          startupCheckedStorePaths: mainSessionRecoveryStartupCheckedStorePaths,
        }),
      );
    } catch (err) {
      params.log.warn(
        `main-session startup orphan marking failed before channel startup: ${String(err)}`,
      );
    }
  });
  const getModelRuntimeConfig = params.getModelRuntimeConfig ?? (() => params.cfg);
  // Agent RPC remains available when transports are disabled. Publish configured/static facts before
  // accepting work; live provider catalogs stay advisory and never enter the Gateway lifecycle.
  if ((await params.pluginRuntimeClaim?.waitForUnblocked()) !== false) {
    await measureStartup(params.startupTrace, "sidecars.model-runtime", () =>
      withPluginRuntimeRegistryScope(params.pluginRegistry, () =>
        publishStartupModelRuntime(
          {
            cfg: params.cfg,
            getConfig: async () =>
              await measureStartup(params.startupTrace, "sidecars.model-auth", () =>
                hydrateConfiguredExternalCliAuth({
                  getConfig: getModelRuntimeConfig,
                  log: params.log,
                }),
              ),
            isCurrent: params.pluginRuntimeClaim?.isCurrent,
            ...(params.pluginMetadataSnapshot
              ? { pluginMetadataSnapshot: params.pluginMetadataSnapshot }
              : {}),
            workspaceDir: params.defaultWorkspaceDir,
            log: params.log,
            startupTrace: params.startupTrace,
          },
          params.prewarmPrimaryModel,
        ),
      ),
    );
  }
  // Gateway readiness owns process-stable reply module activation so the first operator turn
  // does not become the module loader under contention.
  await measureStartup(params.startupTrace, "sidecars.reply-runtime", async () => {
    const { prewarmConfigDrivenReplyRuntime } = await loadGetReplyFromConfigRuntime();
    await prewarmConfigDrivenReplyRuntime();
  });
  await measureStartup(params.startupTrace, "sidecars.chat-metadata", async () => {
    await params.refreshChatMetadata?.();
  });
  const shouldStartChannels = params.shouldStartChannels?.() !== false;
  await measureStartup(params.startupTrace, "sidecars.channels", async () => {
    const channelStart = skipChannels
      ? measureStartup(params.startupTrace, "sidecars.channel-skip", () =>
          params.logChannels.info(
            "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
          ),
        )
      : shouldStartChannels
        ? measureStartup(params.startupTrace, "sidecars.channel-start", params.startChannels).catch(
            (err: unknown) => params.logChannels.error(`channel startup failed: ${String(err)}`),
          )
        : Promise.resolve();
    // Account tasks can depend on this generation gate, so release it after
    // their handoff is prepared but before waiting for that handoff to settle.
    const accountStartGateRelease = shouldStartChannels ? params.onChannelsStarted?.() : undefined;
    await Promise.all([accountStartGateRelease, channelStart]);
  });

  await params.pluginRuntimeClaim?.waitForUnblocked();
  const shouldStartPluginServices =
    params.pluginRuntimeClaim?.isCurrent() !== false &&
    params.shouldStartPluginServices?.() !== false;
  let pluginServicesOwner: PluginServicesHandle | null = null;
  let pluginServicesStopRequested = false;
  let resolvePluginServicesOwner: ((handle: PluginServicesHandle | null) => void) | undefined;
  if (shouldStartPluginServices) {
    const ownedPluginServices = createDeferredCore<PluginServicesHandle | null>();
    let stopPromise: Promise<void> | undefined;
    pluginServicesOwner = {
      stop: (options) => {
        pluginServicesStopRequested = true;
        stopPromise ??= ownedPluginServices.promise.then(async (handle) => {
          await handle?.stop(options);
        });
        if (!options?.strict) {
          return stopPromise;
        }
        return new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => {
              reject(
                new AggregateError(
                  [new Error("Gateway plugin service startup did not settle before replacement")],
                  "Gateway plugin service replacement cleanup failed",
                ),
              );
            },
            Math.max(0, options.deadlineAtMs - Date.now()),
          );
          void stopPromise?.then(
            () => {
              clearTimeout(timer);
              resolve();
            },
            (error: unknown) => {
              clearTimeout(timer);
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          );
        });
      },
    };
    resolvePluginServicesOwner = ownedPluginServices.resolve;
    params.onPluginServices?.(pluginServicesOwner);
  }
  let pluginServices = shouldStartPluginServices
    ? await measureStartup(params.startupTrace, "sidecars.plugin-services", async () => {
        try {
          const { startPluginServices } = await import("../plugins/services.js");
          if (pluginServicesStopRequested || params.shouldStartPluginServices?.() === false) {
            resolvePluginServicesOwner?.(null);
            return null;
          }
          const startedPluginServices = await startPluginServices({
            registry: params.pluginRegistry,
            config: params.cfg,
            workspaceDir: params.defaultWorkspaceDir,
            startupTrace: params.startupTrace,
            broadcastPluginEvent: params.broadcastPluginEvent,
            onHandle: resolvePluginServicesOwner,
          });
          resolvePluginServicesOwner?.(startedPluginServices);
          return startedPluginServices;
        } catch (err) {
          resolvePluginServicesOwner?.(null);
          params.log.warn(`plugin services failed to start: ${String(err)}`);
          return null;
        }
      })
    : null;
  if (!shouldStartPluginServices) {
    params.onPluginServices?.(null);
  }
  if (
    pluginServicesOwner &&
    (pluginServicesStopRequested || params.shouldStartPluginServices?.() === false)
  ) {
    await pluginServicesOwner.stop().catch((err: unknown) => {
      params.log.warn(`plugin services stop after close failed: ${String(err)}`);
    });
    pluginServices = null;
    params.onPluginServices?.(null);
  }

  const shouldDispatchGatewayStartupInternalHook =
    internalHooksConfigured || (await hasGatewayStartupInternalHookListeners());
  if (params.shouldCreatePostReadySidecars?.() === false) {
    return { pluginServices, postReadySidecars };
  }
  if (shouldDispatchGatewayStartupInternalHook) {
    params.startupOutcomes?.record({
      subsystem: "internal-startup-hook",
      status: "scheduled",
    });
    // Run startup hooks after sidecar startup has yielded once so gateway bind
    // and channel startup are not delayed by hook handlers.
    // This timer belongs to the current gateway generation; registration lets
    // close cancel it before a replacement generation starts in the same process.
    postReadySidecars.push(
      scheduleGatewayGenerationTimer({
        delayMs: 250,
        run: async (isStopped) => {
          const { createInternalHookEvent, triggerInternalHook } = await loadInternalHooksModule();
          if (isStopped()) {
            return;
          }
          const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
            cfg: params.cfg,
            deps: params.deps,
            workspaceDir: params.defaultWorkspaceDir,
          });
          await triggerInternalHook(hookEvent);
        },
        onError: (err) => params.logHooks.warn(`gateway startup hook failed: ${String(err)}`),
      }),
    );
  }

  if (params.cfg.acp?.enabled) {
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      const ready = await measureStartup(params.startupTrace, "sidecars.acp.runtime-ready", () =>
        waitForAcpRuntimeBackendReady({ backendId: params.cfg.acp?.backend }),
      );
      params.startupTrace?.detail("sidecars.acp.runtime-ready", [
        ["readyCount", ready ? 1 : 0],
        ["backend", params.cfg.acp?.backend ?? "default"],
      ]);
      await measureStartup(params.startupTrace, "sidecars.acp.identity-reconcile", async () => {
        const [{ getAcpSessionManager }, { ACP_SESSION_IDENTITY_RENDERER_VERSION }] =
          await Promise.all([
            import("../acp/control-plane/manager.js"),
            import("@openclaw/acp-core/runtime/session-identifiers"),
          ]);
        const result = await getAcpSessionManager().reconcilePendingSessionIdentities({
          cfg: params.cfg,
        });
        if (result.checked === 0) {
          return;
        }
        params.log.warn(
          `acp startup identity reconcile (renderer=${ACP_SESSION_IDENTITY_RENDERER_VERSION}): checked=${result.checked} resolved=${result.resolved} failed=${result.failed}`,
        );
      });
    }).catch((err: unknown) => {
      params.log.warn(`acp startup identity reconcile failed: ${String(err)}`);
    });
  }

  let restartSentinelWake: GatewayPostReadySidecarHandle | undefined;
  postReadySidecars.push(
    schedulePostReadySidecarTask({
      startupTrace: params.startupTrace,
      name: "sidecars.restart-sentinel",
      log: params.log,
      waitForPostReadyWork: params.waitForPostReadyWork,
      run: async (isStopped) => {
        if (!shouldCheckRestartSentinel() || isStopped()) {
          return;
        }
        if (!(await hasRestartSentinelFast()) || isStopped()) {
          return;
        }
        restartSentinelWake = scheduleRestartSentinelWakeAfterReady({
          deps: params.deps,
          log: params.log,
        });
      },
      stop: async () => {
        await restartSentinelWake?.stop();
      },
    }),
  );

  if (params.cfg.hooks?.enabled && params.cfg.hooks.gmail?.account) {
    postReadySidecars.push(
      schedulePostReadySidecarTask({
        startupTrace: params.startupTrace,
        name: "sidecars.gmail-watch",
        log: params.log,
        waitForPostReadyWork: params.waitForPostReadyWork,
        run: async (isStopped, signal) => {
          const { startGmailWatcherWithLogs } = await import("../hooks/gmail-watcher-lifecycle.js");
          if (isStopped()) {
            return;
          }
          await startGmailWatcherWithLogs({
            cfg: params.cfg,
            log: params.logHooks,
            signal,
          });
        },
      }),
    );
  }

  if (params.cfg.hooks?.gmail?.model) {
    postReadySidecars.push(
      schedulePostReadySidecarTask({
        startupTrace: params.startupTrace,
        name: "sidecars.gmail-model",
        log: params.log,
        waitForPostReadyWork: params.waitForPostReadyWork,
        run: async (isStopped) => {
          const [
            { DEFAULT_MODEL, DEFAULT_PROVIDER },
            { loadPreparedModelCatalog },
            { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel },
          ] = await Promise.all([
            loadAgentDefaultsModule(),
            import("../agents/prepared-model-catalog.js"),
            loadAgentModelSelectionModule(),
          ]);
          if (isStopped()) {
            return;
          }
          const hooksModelRef = resolveHooksGmailModel({
            cfg: params.cfg,
            defaultProvider: DEFAULT_PROVIDER,
          });
          if (hooksModelRef) {
            const { provider: resolvedDefaultProvider, model: defaultModel } =
              resolveConfiguredModelRef({
                cfg: params.cfg,
                defaultProvider: DEFAULT_PROVIDER,
                defaultModel: DEFAULT_MODEL,
              });
            const catalog = await loadPreparedModelCatalog({
              config: params.cfg,
              readOnly: true,
              providerDiscoveryProviderIds: [hooksModelRef.provider],
              scopedLiveProviderDiscovery: true,
            });
            const status = getModelRefStatus({
              cfg: params.cfg,
              catalog,
              ref: hooksModelRef,
              defaultProvider: resolvedDefaultProvider,
              defaultModel,
            });
            if (!status.allowed) {
              params.logHooks.warn(
                `hooks.gmail.model "${status.key}" not allowed by agents.defaults.modelPolicy.allow (will use primary instead)`,
              );
            }
            if (!status.inCatalog) {
              params.logHooks.warn(
                `hooks.gmail.model "${status.key}" not in the model catalog (may fail at runtime)`,
              );
            }
          }
        },
      }),
    );
  }

  // These handles schedule later tasks but do not yield after creation. Transfer
  // ownership in the same turn so close cannot seal between creation and publication.
  params.onPostReadySidecars?.(postReadySidecars);
  return { pluginServices, postReadySidecars };
}

type GatewayPostAttachRuntimeDeps = {
  getGlobalHookRunner: () => Awaitable<ReturnType<typeof getGlobalHookRunner>>;
  logGatewayStartup: (params: Parameters<typeof logGatewayStartup>[0]) => Awaitable<void>;
  refreshLatestUpdateRestartSentinel: () => Awaitable<
    ReturnType<typeof refreshLatestUpdateRestartSentinel>
  >;
  initializeGatewayUpdateStatus: () => ReturnType<typeof initializeGatewayUpdateStatus>;
  scheduleGatewayUpdateCheck: (
    ...args: Parameters<typeof scheduleGatewayUpdateCheck>
  ) => Awaitable<ReturnType<typeof scheduleGatewayUpdateCheck>>;
  startGatewaySidecars: typeof startGatewaySidecars;
  warmSystemCa: typeof warmMacOSSystemCaOffMainThread;
  loadSubagentRegistryActivation: () => Awaitable<
    (resolveGatewayContext: GatewayContextResolver) => void
  >;
};

const defaultGatewayPostAttachRuntimeDeps: GatewayPostAttachRuntimeDeps = {
  getGlobalHookRunner: async () =>
    (await import("../plugins/hook-runner-global.js")).getGlobalHookRunner(),
  logGatewayStartup: async (params) =>
    (await import("./server-startup-log.js")).logGatewayStartup(params),
  refreshLatestUpdateRestartSentinel: refreshLatestUpdateRestartSentinelIfPresent,
  initializeGatewayUpdateStatus: async () =>
    (await import("../infra/update-startup.js")).initializeGatewayUpdateStatus(),
  scheduleGatewayUpdateCheck: async (...args) =>
    (await import("../infra/update-startup.js")).scheduleGatewayUpdateCheck(...args),
  startGatewaySidecars,
  warmSystemCa: beginMacOSSystemCaWarmupOnce,
  loadSubagentRegistryActivation: async () =>
    (await import("../agents/subagents/registry/subagent-registry.js")).activateSubagentRegistry,
};

function createDeferredGatewayUpdateCheck(params: {
  startupTrace?: GatewayStartupTrace;
  runtimeDeps: GatewayPostAttachRuntimeDeps;
  cfg: OpenClawConfig;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  isNixMode: boolean;
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  getClientConnIds: (filter?: (client: GatewayClient) => boolean) => ReadonlySet<string>;
  waitForPostReadyWork?: () => Promise<void>;
  activeWorkInspectors?: Partial<GatewayActiveWorkInspectors>;
}): { start: () => void; stop: () => void } {
  let started = false;
  let stopped = false;
  let stopUpdateCheck: (() => void) | null = null;
  let latestUpdateAvailable: GatewayUpdateAvailableEventPayload["updateAvailable"] = null;
  let latestSchedule: GatewayUpdateAvailableEventPayload["schedule"];

  const broadcastUpdateAvailable = (payload: GatewayUpdateAvailableEventPayload) => {
    const detailedConnIds = params.getClientConnIds((client) =>
      canReadDetailedUpdateMetadata(client.connect.role ?? "operator", client.connect.scopes ?? []),
    );
    const legacyConnIds = new Set(params.getClientConnIds());
    for (const connId of detailedConnIds) {
      legacyConnIds.delete(connId);
    }
    params.broadcastToConnIds(GATEWAY_EVENT_UPDATE_AVAILABLE, payload, detailedConnIds, {
      dropIfSlow: true,
    });
    params.broadcastToConnIds(
      GATEWAY_EVENT_UPDATE_AVAILABLE,
      { updateAvailable: projectUpdateAvailable(payload.updateAvailable, false) ?? null },
      legacyConnIds,
      { dropIfSlow: true },
    );
  };

  const stop = () => {
    stopped = true;
    stopUpdateCheck?.();
    stopUpdateCheck = null;
  };

  const start = () => {
    if (started || stopped) {
      return;
    }
    started = true;
    // Install identity is process-stable and must be ready before clients can
    // select a channel; registry and upstream discovery stay post-ready.
    void params.runtimeDeps.initializeGatewayUpdateStatus().catch((err: unknown) => {
      if (!stopped) {
        params.log.warn(`gateway update status failed to initialize: ${String(err)}`);
      }
    });
    // Update checks are intentionally post-attach so startup logging, sidecars,
    // and Tailscale exposure are not serialized behind network I/O.
    void (async () => {
      await params.waitForPostReadyWork?.();
      if (stopped) {
        return;
      }
      setImmediate(() => {
        if (stopped) {
          return;
        }
        void runWithGatewayIndependentRootWorkAdmission(
          async () =>
            await measureStartup(params.startupTrace, "post-attach.update-check", () =>
              params.runtimeDeps.scheduleGatewayUpdateCheck({
                cfg: params.cfg,
                log: params.log,
                isNixMode: params.isNixMode,
                ...(params.activeWorkInspectors
                  ? { activeWorkInspectors: params.activeWorkInspectors }
                  : {}),
                onUpdateAvailableChange: (updateAvailable) => {
                  latestUpdateAvailable = updateAvailable;
                  const payload: GatewayUpdateAvailableEventPayload = {
                    updateAvailable,
                    ...(latestSchedule ? { schedule: latestSchedule } : {}),
                  };
                  broadcastUpdateAvailable(payload);
                },
                onUpdateScheduleChange: (schedule) => {
                  latestSchedule = schedule;
                  const payload: GatewayUpdateAvailableEventPayload = {
                    updateAvailable: latestUpdateAvailable,
                    schedule,
                  };
                  broadcastUpdateAvailable(payload);
                },
              }),
            ),
        )
          .then((nextStop) => {
            if (stopped) {
              nextStop();
              return;
            }
            stopUpdateCheck = nextStop;
          })
          .catch((err: unknown) => {
            if (stopped) {
              return;
            }
            params.log.warn(`gateway update check failed to start: ${String(err)}`);
          });
      });
    })().catch((err: unknown) => {
      if (!stopped) {
        params.log.warn(`gateway update check readiness wait failed: ${String(err)}`);
      }
    });
  };

  return { start, stop };
}

/** Start work that depends on the HTTP server being attached and visible. */
export async function startGatewayPostAttachRuntime(
  params: {
    minimalTestGateway: boolean;
    cfgAtStart: OpenClawConfig;
    getConfig: () => OpenClawConfig;
    bindHost: string;
    bindHosts: string[];
    port: number;
    tlsEnabled: boolean;
    log: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
    };
    isNixMode: boolean;
    startupStartedAt?: number;
    broadcastToConnIds: GatewayBroadcastToConnIdsFn;
    getClientConnIds: (filter?: (client: GatewayClient) => boolean) => ReadonlySet<string>;
    broadcastPluginEvent?: import("./server-broadcast-types.js").GatewayPluginEventBroadcastFn;
    controlUiBasePath: string;
    controlUiRootLifecycle?: GatewayControlUiRootLifecycle;
    gatewayPluginConfigAtStart: OpenClawConfig;
    activationSourceConfig: OpenClawConfig;
    pluginManifestRecords: readonly PluginManifestRecord[];
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    ambientEnvTriggers?: AmbientEnvTriggerPolicy;
    pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
    defaultWorkspaceDir: string;
    deps: CliDeps;
    startChannels: () => Promise<void>;
    refreshChatMetadata?: () => Promise<void>;
    recoveryRuntime: GatewayRecoveryRuntime;
    resolveGatewayContext: GatewayContextResolver;
    logHooks: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    };
    logChannels: { info: (msg: string) => void; error: (msg: string) => void };
    unlockStartupMethods: () => void;
    loadStartupPlugins?: () => Awaitable<{
      pluginRegistry: PluginRegistry;
      gatewayMethods: string[];
      retireGatewayRuntimeBindings?: () => void;
    }>;
    onStartupPluginsLoading?: () => void;
    onStartupPluginsLoaded?: (result: {
      pluginRegistry: PluginRegistry;
      gatewayMethods: string[];
      retireGatewayRuntimeBindings?: () => void;
    }) => Awaitable<void>;
    pluginRuntimeClaim?: GatewayPluginRuntimeClaim;
    getCurrentPluginRegistry?: () => PluginRegistry;
    getCurrentPluginMetadataSnapshot?: () => PluginMetadataSnapshot | undefined;
    getCronService?: () => PluginHookGatewayCronService | null | undefined;
    onChannelsStarted?: () => Awaitable<void>;
    onPluginServices?: (pluginServices: PluginServicesHandle | null) => void;
    onPostReadySidecars?: (postReadySidecars: GatewayPostReadySidecarHandle[]) => void;
    onGatewayLifetimeSidecars?: (sidecars: GatewayPostReadySidecarHandle[]) => void;
    stopRegisteredPostReadySidecars: () => Promise<void>;
    stopRegisteredGatewayLifetimeSidecars: () => Promise<void>;
    unregisterGatewayLifetimeSidecar: (sidecar: GatewayPostReadySidecarHandle) => void;
    startWorkerEnvironmentRuntime?: () => Awaitable<GatewayPostReadySidecarHandle | null>;
    onSidecarsReady?: () => void;
    isClosing?: () => boolean;
    startupTrace?: GatewayStartupTrace;
    sidecarStartup?: GatewaySidecarStartupMode;
    providerAuthPrewarm?: {
      enabled?: boolean;
      delayMs?: number;
      getConfig?: () => OpenClawConfig;
    };
    waitForPostReadyWork?: () => Promise<void>;
    activeWorkInspectors?: Partial<GatewayActiveWorkInspectors>;
  },
  runtimeDeps: GatewayPostAttachRuntimeDeps = defaultGatewayPostAttachRuntimeDeps,
) {
  const controlUiRootLifecycle = params.controlUiRootLifecycle;
  const mainSessionRecoveryStartupCheckedStorePaths = new Set<string>();
  const shouldStartControlUiAssets =
    !params.minimalTestGateway &&
    (controlUiRootLifecycle?.state?.kind === "preparing" ||
      controlUiRootLifecycle?.state?.kind === "bundled");
  const controlUiAssetsSidecar =
    shouldStartControlUiAssets && controlUiRootLifecycle
      ? schedulePostReadySidecarTask({
          name: "sidecars.control-ui-assets",
          startupTrace: params.startupTrace,
          log: params.log,
          run: controlUiRootLifecycle.start,
          stop: controlUiRootLifecycle.stop,
        })
      : undefined;
  if (controlUiAssetsSidecar) {
    // Publish before the first await: slow CA/plugin startup must not strand
    // the dashboard or hide its running builder from Gateway shutdown.
    params.onGatewayLifetimeSidecars?.([controlUiAssetsSidecar]);
  }

  if (!params.minimalTestGateway) {
    // The HTTP server is already attached, so keep health probes responsive while the worker
    // resolves Node's effective default CA set before any plugin or worker provider can use TLS.
    await measureStartup(params.startupTrace, "post-attach.system-ca", () =>
      runtimeDeps.warmSystemCa({ log: params.log }),
    );
  }

  let pluginRegistry = params.pluginRegistry;
  let startupPluginsLoaded = false;
  let startupPluginsLoadPromise: Promise<{
    pluginRegistry: PluginRegistry;
    gatewayMethods: string[];
    retireGatewayRuntimeBindings?: () => void;
  }> | null = null;
  const loadStartupPluginsIfNeeded = async () => {
    if (params.minimalTestGateway || !params.loadStartupPlugins) {
      return { pluginRegistry, gatewayMethods: [] };
    }
    if (startupPluginsLoaded) {
      return { pluginRegistry, gatewayMethods: [] };
    }
    startupPluginsLoadPromise ??= (async () => {
      params.onStartupPluginsLoading?.();
      const loaded = await measureStartup(params.startupTrace, "plugins.runtime-post-bind", () =>
        params.loadStartupPlugins!(),
      );
      await params.pluginRuntimeClaim?.waitForUnblocked();
      if (params.pluginRuntimeClaim?.isCurrent() === false) {
        loaded.retireGatewayRuntimeBindings?.();
        pluginRegistry = params.getCurrentPluginRegistry?.() ?? pluginRegistry;
        startupPluginsLoaded = true;
        return { pluginRegistry, gatewayMethods: [] };
      }
      pluginRegistry = loaded.pluginRegistry;
      startupPluginsLoaded = true;
      params.startupTrace?.detail("plugins.runtime-post-bind", [
        [
          "loadedPluginCount",
          pluginRegistry.plugins.filter((plugin) => plugin.status === "loaded").length,
        ],
        ["gatewayMethodCount", loaded.gatewayMethods.length],
      ]);
      if (params.isClosing?.() !== true) {
        await params.onStartupPluginsLoaded?.(loaded);
      }
      return loaded;
    })();
    return await startupPluginsLoadPromise;
  };
  let startupLogPromise: Promise<void> | undefined;
  const startupLogSettled = createDeferredCore();
  // Tailscale and sidecar work can delay the public readiness handle past log failure.
  void startupLogSettled.promise.catch(() => {});
  let startupLogOwnerAssigned = false;
  const assignStartupLogOwner = (owner: Promise<void>) => {
    if (params.sidecarStartup !== "defer" || startupLogOwnerAssigned) {
      return;
    }
    startupLogOwnerAssigned = true;
    void owner.then(startupLogSettled.resolve, startupLogSettled.reject);
  };
  const startStartupLog = () => {
    if (startupLogPromise) {
      return startupLogPromise;
    }
    startupLogPromise = measureStartup(params.startupTrace, "post-attach.log", () =>
      runtimeDeps.logGatewayStartup({
        cfg: params.cfgAtStart,
        activationSourceConfig: params.activationSourceConfig,
        env: process.env,
        manifestRecords: params.pluginManifestRecords,
        ...(params.ambientEnvTriggers ? { ambientEnvTriggers: params.ambientEnvTriggers } : {}),
        bindHost: params.bindHost,
        bindHosts: params.bindHosts,
        port: params.port,
        tlsEnabled: params.tlsEnabled,
        loadedPluginIds: pluginRegistry.plugins
          .filter((plugin) => plugin.status === "loaded")
          .map((plugin) => plugin.id),
        log: params.log,
        isNixMode: params.isNixMode,
        startupStartedAt: params.startupStartedAt,
      }),
    );
    void startupLogPromise.catch(() => {});
    assignStartupLogOwner(startupLogPromise);
    return startupLogPromise;
  };
  const skipStartupLog = () => assignStartupLogOwner(Promise.resolve());

  const updateCheck = params.minimalTestGateway
    ? { start: () => {}, stop: () => {} }
    : createDeferredGatewayUpdateCheck({
        startupTrace: params.startupTrace,
        runtimeDeps,
        cfg: params.cfgAtStart,
        log: params.log,
        isNixMode: params.isNixMode,
        broadcastToConnIds: params.broadcastToConnIds,
        getClientConnIds: params.getClientConnIds,
        waitForPostReadyWork: params.waitForPostReadyWork,
        activeWorkInspectors: params.activeWorkInspectors,
      });

  let pluginServicesReported = false;
  let reportedPluginServices: PluginServicesHandle | null = null;
  const reportPluginServices = (pluginServices: PluginServicesHandle | null) => {
    if (params.pluginRuntimeClaim?.isCurrent() === false) {
      return;
    }
    pluginServicesReported = true;
    reportedPluginServices = pluginServices;
    params.onPluginServices?.(pluginServices);
  };
  const waitForSidecarStartTurn = () =>
    new Promise<void>((resolve) => {
      if (params.sidecarStartup === "defer") {
        // Give startup logging and bind observers a deterministic head start
        // when tests or callers request deferred sidecar startup.
        const timer = setTimeout(resolve, DEFERRED_SIDECAR_START_DELAY_MS);
        timer.unref?.();
        return;
      }
      setImmediate(resolve);
    });

  const emptySidecarResult = () => ({
    pluginServices: null,
    pluginRegistry,
    postReadySidecars: [],
    gatewayLifetimeSidecars: [],
  });
  const startSidecars = () =>
    params.minimalTestGateway
      ? startStartupLog().then(() => ({
          pluginServices: null,
          pluginRegistry,
          postReadySidecars: [],
          gatewayLifetimeSidecars: [],
        }))
      : waitForSidecarStartTurn().then(async () => {
          if (params.isClosing?.()) {
            skipStartupLog();
            return emptySidecarResult();
          }
          await loadStartupPluginsIfNeeded();
          if (params.isClosing?.()) {
            skipStartupLog();
            return emptySidecarResult();
          }
          const startupLog = startStartupLog();
          const startupOutcomes = createGatewayStartupOutcomeRecorder({
            cfg: params.gatewayPluginConfigAtStart,
            gatewayStartHooks: hasGatewayStartHooks(pluginRegistry),
          });
          const workerEnvironmentSidecar = params.isClosing?.()
            ? null
            : ((await params.startWorkerEnvironmentRuntime?.()) ?? null);
          if (params.isClosing?.()) {
            return emptySidecarResult();
          }
          params.log.info("starting channels and sidecars...");
          const loaderStatsBefore = getPluginModuleLoaderStats();
          const result = await (async () => {
            try {
              const startupRuntimeCurrent = params.pluginRuntimeClaim?.isCurrent() !== false;
              const pluginMetadataSnapshot = startupRuntimeCurrent
                ? params.pluginMetadataSnapshot
                : params.getCurrentPluginMetadataSnapshot?.();
              return await measureStartup(params.startupTrace, "sidecars.total", () =>
                runtimeDeps.startGatewaySidecars({
                  cfg: startupRuntimeCurrent
                    ? params.gatewayPluginConfigAtStart
                    : params.getConfig(),
                  getModelRuntimeConfig: params.getConfig,
                  ...(pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}),
                  pluginRegistry,
                  defaultWorkspaceDir: params.defaultWorkspaceDir,
                  deps: params.deps,
                  startChannels: params.startChannels,
                  shouldStartChannels: () => params.isClosing?.() !== true,
                  refreshChatMetadata: params.refreshChatMetadata,
                  log: params.log,
                  logHooks: params.logHooks,
                  logChannels: params.logChannels,
                  startupTrace: params.startupTrace,
                  onChannelsStarted: params.onChannelsStarted,
                  onPluginServices: reportPluginServices,
                  onPostReadySidecars: (sidecars) => {
                    params.onPostReadySidecars?.(sidecars);
                  },
                  shouldCreatePostReadySidecars: () => params.isClosing?.() !== true,
                  shouldStartPluginServices: () =>
                    params.isClosing?.() !== true &&
                    params.pluginRuntimeClaim?.isCurrent() !== false,
                  ...(params.pluginRuntimeClaim
                    ? { pluginRuntimeClaim: params.pluginRuntimeClaim }
                    : {}),
                  broadcastPluginEvent: params.broadcastPluginEvent,
                  startupOutcomes,
                  mainSessionRecoveryStartupCheckedStorePaths,
                  waitForPostReadyWork: params.waitForPostReadyWork,
                }),
              );
            } catch (error) {
              try {
                await workerEnvironmentSidecar?.stop();
                if (workerEnvironmentSidecar) {
                  params.unregisterGatewayLifetimeSidecar(workerEnvironmentSidecar);
                }
              } catch (cleanupError) {
                params.log.warn(
                  `worker environment cleanup after sidecar startup failure failed: ${String(cleanupError)}`,
                );
              }
              throw error;
            }
          })();
          const stopStartupSidecars = async (
            mainSessionRecoverySidecar?: GatewayPostReadySidecarHandle,
          ) => {
            if (mainSessionRecoverySidecar) {
              params.onGatewayLifetimeSidecars?.([mainSessionRecoverySidecar]);
            }
            const cleanupResults = await Promise.allSettled(
              [
                params.stopRegisteredGatewayLifetimeSidecars,
                () => result.pluginServices?.stop(),
                params.stopRegisteredPostReadySidecars,
              ].map(async (stop) => await stop()),
            );
            if (result.pluginServices && cleanupResults[1]?.status === "fulfilled") {
              reportPluginServices(null);
            }
            const cleanupFailure = cleanupResults.find(
              (cleanupResult): cleanupResult is PromiseRejectedResult =>
                cleanupResult.status === "rejected",
            );
            if (cleanupFailure) {
              throw cleanupFailure.reason;
            }
            return emptySidecarResult();
          };
          if (params.isClosing?.()) {
            return await stopStartupSidecars();
          }
          const loaderStatsAfter = getPluginModuleLoaderStats();
          params.startupTrace?.detail("sidecars.plugin-loader", [
            ["callsCount", loaderStatsAfter.calls - loaderStatsBefore.calls],
            ["nativeHitsCount", loaderStatsAfter.nativeHits - loaderStatsBefore.nativeHits],
            ["nativeMissesCount", loaderStatsAfter.nativeMisses - loaderStatsBefore.nativeMisses],
            [
              "sourceTransformForcedCount",
              loaderStatsAfter.sourceTransformForced - loaderStatsBefore.sourceTransformForced,
            ],
            [
              "sourceTransformFallbacksCount",
              loaderStatsAfter.sourceTransformFallbacks -
                loaderStatsBefore.sourceTransformFallbacks,
            ],
          ]);
          let mainSessionRecoverySidecar: GatewayPostReadySidecarHandle | undefined;
          try {
            await startupLog;
          } catch (error) {
            try {
              await stopStartupSidecars(mainSessionRecoverySidecar);
            } catch (cleanupError) {
              params.log.warn(
                `sidecar cleanup after startup logging failure failed: ${String(cleanupError)}`,
              );
            }
            throw error;
          }
          if (params.isClosing?.()) {
            return await stopStartupSidecars(mainSessionRecoverySidecar);
          }
          try {
            const { scheduleRestartAbortedMainSessionRecovery } =
              await loadMainSessionRestartRecoveryModule();
            if (params.isClosing?.() !== true) {
              mainSessionRecoverySidecar = scheduleRestartAbortedMainSessionRecovery({
                delayMs: 0,
                getConfig: params.getConfig,
                shouldContinue: () => params.isClosing?.() !== true,
                startupCheckedStorePaths: mainSessionRecoveryStartupCheckedStorePaths,
                waitForStart: params.waitForPostReadyWork,
                gatewayRuntime: params.recoveryRuntime,
              });
            }
          } catch (err) {
            params.log.warn(`main-session restart recovery failed to schedule: ${String(err)}`);
          }
          if (params.isClosing?.()) {
            return await stopStartupSidecars(mainSessionRecoverySidecar);
          }
          // Capture the orphan-recovery cutoff before new startup-gated agent
          // work can create sessions that the recovery scan must leave alone.
          params.unlockStartupMethods();
          if (!pluginServicesReported) {
            reportPluginServices(result.pluginServices);
          }
          const postReadySidecars = [...result.postReadySidecars];
          const newGatewayLifetimeSidecars = [
            scheduleContextCachePrewarm(params),
            scheduleGatewayHandlerPrewarm(params),
            ...(mainSessionRecoverySidecar ? [mainSessionRecoverySidecar] : []),
          ];
          if (params.providerAuthPrewarm && params.providerAuthPrewarm.enabled !== false) {
            newGatewayLifetimeSidecars.push(
              scheduleProviderAuthStatePrewarm({
                getConfig: params.providerAuthPrewarm.getConfig ?? (() => params.cfgAtStart),
                log: params.log,
                delayMs: params.providerAuthPrewarm.delayMs,
                startupWarmEnabled: params.providerAuthPrewarm.enabled === true,
              }),
            );
          }
          if (params.gatewayPluginConfigAtStart.transcripts?.autoStart?.length) {
            newGatewayLifetimeSidecars.push(
              scheduleTranscriptsAutoStartSidecar({
                cfg: params.gatewayPluginConfigAtStart,
                startupTrace: params.startupTrace,
                log: params.log,
                waitForPostReadyWork: params.waitForPostReadyWork,
              }),
            );
          }
          params.onGatewayLifetimeSidecars?.(newGatewayLifetimeSidecars);
          const gatewayLifetimeSidecars = [
            ...(controlUiAssetsSidecar ? [controlUiAssetsSidecar] : []),
            ...(workerEnvironmentSidecar ? [workerEnvironmentSidecar] : []),
            ...newGatewayLifetimeSidecars,
          ];
          params.log.info(formatGatewayStartupOutcomes(startupOutcomes.snapshot()));
          params.onSidecarsReady?.();
          try {
            const activateSubagentRegistry = await runtimeDeps.loadSubagentRegistryActivation();
            if (params.isClosing?.() !== true) {
              activateSubagentRegistry(params.resolveGatewayContext);
            }
          } catch (err) {
            params.log.warn(`subagent restart recovery failed to activate: ${String(err)}`);
          }
          if (params.isClosing?.()) {
            return await stopStartupSidecars(mainSessionRecoverySidecar);
          }
          params.startupTrace?.detail("sidecars.ready", [
            [
              "loadedPluginCount",
              pluginRegistry.plugins.filter((plugin) => plugin.status === "loaded").length,
            ],
            ["postReadySidecarCount", postReadySidecars.length + gatewayLifetimeSidecars.length],
          ]);
          params.startupTrace?.mark("sidecars.ready");
          params.log.info("gateway ready");
          return { ...result, postReadySidecars, gatewayLifetimeSidecars, pluginRegistry };
        });
  const sidecarsPromise = startSidecars();

  void sidecarsPromise
    .then(async (sidecarsResult) => {
      if (params.minimalTestGateway) {
        return;
      }
      await params.waitForPostReadyWork?.();
      if (params.isClosing?.()) {
        return;
      }
      schedulePostAttachUpdateSentinelRefresh({
        startupTrace: params.startupTrace,
        log: params.log,
        refreshLatestUpdateRestartSentinel: runtimeDeps.refreshLatestUpdateRestartSentinel,
      });
      const sessionStateSweepHandle = setImmediate(() => {
        sweepSessionStateWatchNotices();
      });
      sessionStateSweepHandle.unref?.();
      if (!hasGatewayStartHooks(sidecarsResult.pluginRegistry)) {
        return;
      }
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const hookRunner = await runtimeDeps.getGlobalHookRunner();
      if (hookRunner?.hasHooks("gateway_start")) {
        const { withPluginHttpRouteRegistry } = await import("../plugins/http-registry.js");
        void runWithGatewayIndependentRootWorkAdmission(async () => {
          await withPluginHttpRouteRegistry(sidecarsResult.pluginRegistry, () =>
            hookRunner.runGatewayStart(
              { port: params.port },
              {
                port: params.port,
                config: params.gatewayPluginConfigAtStart,
                workspaceDir: params.defaultWorkspaceDir,
                getCron: () =>
                  params.getCronService?.() ??
                  (params.deps.cron as PluginHookGatewayCronService | undefined),
              },
            ),
          );
        }).catch((err: unknown) => {
          params.log.warn(`gateway_start hook failed: ${String(err)}`);
        });
      }
    })
    .catch((err: unknown) => {
      params.log.warn(`gateway sidecars failed to start: ${String(err)}`);
    });

  if (params.sidecarStartup !== "defer") {
    const sidecarsResult = await sidecarsPromise;
    updateCheck.start();
    return {
      stopGatewayUpdateCheck: updateCheck.stop,
      pluginServices: sidecarsResult.pluginServices,
      startupSettled: Promise.resolve(),
    };
  }

  updateCheck.start();
  const startupSettled = Promise.all([sidecarsPromise, startupLogSettled.promise]).then(
    () => undefined,
  );
  // Direct callers may ignore this handle; only the managed run loop observes it.
  // Pre-handle so an ignored deferred sidecar failure never becomes an unhandled rejection.
  void startupSettled.catch(() => {});

  return {
    stopGatewayUpdateCheck: updateCheck.stop,
    pluginServices: reportedPluginServices,
    startupSettled,
  };
}

export const testing = {
  providerAuthPrewarmStartDelayMs: PROVIDER_AUTH_PREWARM_START_DELAY_MS,
  hasRestartSentinelFast,
  prewarmConfiguredPrimaryModel,
  hydrateConfiguredExternalCliAuth,
  publishConfiguredModelRuntimeSnapshots,
  publishStartupModelRuntime,
  refreshLatestUpdateRestartSentinelIfPresent,
  scheduleProviderAuthStatePrewarm,
  scheduleRestartSentinelWakeAfterReady,
  shouldSkipStartupModelPrewarm,
};
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
