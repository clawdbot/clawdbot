// Gateway post-attach startup sidecars.
// Schedules warmups, sentinels, update checks, memory backend, and plugin services.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import type { CliDeps } from "../cli/deps.types.js";
import { resolveStateDir } from "../config/paths.js";
import type { GatewayTailscaleMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredInternalHooks } from "../hooks/configured.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { hasRestartSentinel } from "../infra/restart-sentinel.js";
import type { scheduleGatewayUpdateCheck } from "../infra/update-startup.js";
import type { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import { getPluginModuleLoaderStats } from "../plugins/plugin-module-loader-cache.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./methods/core-descriptors.js";
import type { refreshLatestUpdateRestartSentinel } from "./server-restart-sentinel.js";
import type { GatewaySidecarStartupMode } from "./server-sidecar-startup-mode.js";
import type { logGatewayStartup } from "./server-startup-log.js";
import type { startGatewayTailscaleExposure } from "./server-tailscale.js";

const ACP_BACKEND_READY_TIMEOUT_MS = 5_000;
const ACP_BACKEND_READY_POLL_MS = 50;
const PRIMARY_MODEL_PREWARM_TIMEOUT_MS = 5_000;
const STARTUP_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;
const PROVIDER_AUTH_PREWARM_START_DELAY_MS = 5_000;
const PROVIDER_AUTH_REWARM_DELAY_MS = 1_000;
const AGENT_RUNTIME_PLUGIN_PREWARM_START_DELAY_MS = 10_000;
const DEFERRED_SIDECAR_START_DELAY_MS = 100;
const SESSION_LOCK_CLEANUP_CONCURRENCY = 4;
const SKIP_STARTUP_MODEL_PREWARM_ENV = "OPENCLAW_SKIP_STARTUP_MODEL_PREWARM";
const QMD_STARTUP_IDLE_DELAY_MS = 120_000;

type Awaitable<T> = T | Promise<T>;

type GatewayStartupTrace = {
  detail: (name: string, metrics: ReadonlyArray<readonly [string, number | string]>) => void;
  mark: (name: string) => void;
  measure: <T>(name: string, run: () => Awaitable<T>) => Promise<T>;
};

type GatewayMemoryStartupPolicy =
  | { mode: "off" }
  | { mode: "immediate" }
  | { mode: "idle"; delayMs: number };

const loadMainSessionRestartRecoveryModule = createLazyRuntimeModule(
  () => import("../agents/main-session-restart-recovery.js"),
);

const loadAgentDefaultsModule = createLazyRuntimeModule(() => import("../agents/defaults.js"));

const loadAgentModelSelectionModule = createLazyRuntimeModule(
  () => import("../agents/model-selection.js"),
);

const loadInternalHooksModule = createLazyRuntimeModule(() => import("../hooks/internal-hooks.js"));

const loadGatewayRestartSentinelModule = createLazyRuntimeModule(
  () => import("./server-restart-sentinel.js"),
);

export type GatewayPostReadySidecarHandle = {
  stop: () => Awaitable<void>;
};

/** Stop sidecars immediately when shutdown has already started before they are reported. */
export function stopPostReadySidecarsAfterCloseStarted(params: {
  postReadySidecars: readonly GatewayPostReadySidecarHandle[];
  closeStarted: boolean;
}): void {
  if (!params.closeStarted) {
    return;
  }
  for (const postReadySidecar of params.postReadySidecars) {
    void postReadySidecar.stop();
  }
}

/** Measure a post-attach startup step when tracing is active. */
async function measureStartup<T>(
  startupTrace: GatewayStartupTrace | undefined,
  name: string,
  run: () => Awaitable<T>,
): Promise<T> {
  return startupTrace ? startupTrace.measure(name, run) : await run();
}

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
  const raw = env[SKIP_STARTUP_MODEL_PREWARM_ENV]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function resolveGatewayMemoryStartupPolicy(cfg: OpenClawConfig): GatewayMemoryStartupPolicy {
  if (cfg.memory?.backend !== "qmd") {
    return { mode: "off" };
  }
  const startup = cfg.memory.qmd?.update?.startup;
  if (startup === "immediate") {
    return { mode: "immediate" };
  }
  if (startup === "idle") {
    const rawDelayMs = cfg.memory.qmd?.update?.startupDelayMs;
    const delayMs =
      typeof rawDelayMs === "number" && Number.isFinite(rawDelayMs) && rawDelayMs >= 0
        ? Math.floor(rawDelayMs)
        : QMD_STARTUP_IDLE_DELAY_MS;
    return { mode: "idle", delayMs };
  }
  return { mode: "off" };
}

function scheduleGatewayMemoryBackend(params: {
  cfg: OpenClawConfig;
  log: { warn: (msg: string) => void };
  policy: GatewayMemoryStartupPolicy;
}): void {
  if (params.policy.mode === "off") {
    return;
  }
  const start = () => {
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      const { startGatewayMemoryBackend } = await import("./server-startup-memory.js");
      await startGatewayMemoryBackend({ cfg: params.cfg, log: params.log });
    }).catch((err: unknown) => {
      params.log.warn(`qmd memory startup initialization failed: ${String(err)}`);
    });
  };
  if (params.policy.mode === "immediate") {
    setImmediate(start);
    return;
  }
  const timer = setTimeout(start, params.policy.delayMs);
  timer.unref?.();
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
          params.log.warn(`provider auth state rewarm failed: ${String(err)}`);
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
        void runRewarm(nextReason);
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
        }).catch((err: unknown) => {
          params.log.warn(`provider auth state pre-warm failed: ${String(err)}`);
        });
      },
      Math.max(0, delayMs),
    );
    startupTimer.unref?.();
  }).catch((err: unknown) => {
    params.log.warn(`provider auth state pre-warm setup failed: ${String(err)}`);
  });
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

function scheduleAgentRuntimePluginPrewarm(params: {
  getConfig: () => OpenClawConfig;
  workspaceDir: string;
  startupTrace?: GatewayStartupTrace;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
  };
  delayMs?: number;
}): GatewayPostReadySidecarHandle {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const isStopped = () => stopped;
  timer = setTimeout(
    () => {
      timer = undefined;
      void runWithGatewayIndependentRootWorkAdmission(async () => {
        await measureStartup(params.startupTrace, "post-ready.agent-runtime-plugins", async () => {
          if (isStopped()) {
            return;
          }
          const started = performance.now();
          const { ensureRuntimePluginsLoaded } = await import("../agents/runtime-plugins.js");
          const cfg = params.getConfig();
          if (isStopped()) {
            return;
          }
          ensureRuntimePluginsLoaded({
            config: cfg,
            workspaceDir: params.workspaceDir,
            allowGatewaySubagentBinding: true,
          });
          if (!isStopped()) {
            params.log.info(
              `agent runtime plugins pre-warmed in ${(performance.now() - started).toFixed(0)}ms`,
            );
          }
        });
      }).catch((err: unknown) => {
        params.log.warn(`agent runtime plugin pre-warm failed: ${String(err)}`);
      });
    },
    Math.max(0, params.delayMs ?? AGENT_RUNTIME_PLUGIN_PREWARM_START_DELAY_MS),
  );
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

function schedulePostReadySidecarTask(params: {
  startupTrace?: GatewayStartupTrace;
  name: string;
  log: { warn: (msg: string) => void };
  run: (isStopped: () => boolean, signal: AbortSignal) => Awaitable<void>;
  stop?: () => Awaitable<void>;
}): GatewayPostReadySidecarHandle {
  let stopped = false;
  const abortController = new AbortController();
  const isStopped = () => stopped;
  const handle = setImmediate(() => {
    if (isStopped()) {
      return;
    }
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      await measureStartup(params.startupTrace, params.name, () =>
        params.run(isStopped, abortController.signal),
      );
    }).catch((err: unknown) => {
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

function scheduleRestartSentinelWakeAfterReady(params: {
  deps: CliDeps;
  log: { warn: (msg: string) => void };
}): void {
  setTimeout(() => {
    void runWithGatewayIndependentRootWorkAdmission(async () => {
      const { scheduleRestartSentinelWake } = await loadGatewayRestartSentinelModule();
      await scheduleRestartSentinelWake({ deps: params.deps });
    }).catch((err: unknown) => {
      params.log.warn(`restart sentinel wake failed to schedule: ${String(err)}`);
    });
  }, 750);
}

type CleanStaleLockFiles = typeof import("../agents/session-write-lock.js").cleanStaleLockFiles;
type MarkRestartAbortedMainSessionsFromLocks =
  typeof import("../agents/main-session-restart-recovery.js").markRestartAbortedMainSessionsFromLocks;

async function cleanupStaleSessionLocks(params: {
  sessionDirs: readonly string[];
  cfg: OpenClawConfig;
  log: { warn: (msg: string) => void };
  isStopped: () => boolean;
  cleanStaleLockFiles: CleanStaleLockFiles;
  markRestartAbortedMainSessionsFromLocks?: MarkRestartAbortedMainSessionsFromLocks;
  concurrency?: number;
}): Promise<void> {
  const concurrency = Math.max(
    1,
    Math.min(
      params.sessionDirs.length,
      Math.floor(params.concurrency ?? SESSION_LOCK_CLEANUP_CONCURRENCY),
    ),
  );
  let nextIndex = 0;
  let markRestartAbortedMainSessionsFromLocks =
    params.markRestartAbortedMainSessionsFromLocks ?? null;
  const getMarker = async () => {
    markRestartAbortedMainSessionsFromLocks ??= (await loadMainSessionRestartRecoveryModule())
      .markRestartAbortedMainSessionsFromLocks;
    return markRestartAbortedMainSessionsFromLocks;
  };
  const worker = async () => {
    while (!params.isStopped()) {
      const sessionsDir = params.sessionDirs[nextIndex];
      nextIndex += 1;
      if (!sessionsDir) {
        return;
      }
      const result = await params.cleanStaleLockFiles({
        sessionsDir,
        config: params.cfg,
        removeStale: true,
        log: { warn: (message) => params.log.warn(message) },
      });
      if (result.cleaned.length === 0) {
        continue;
      }
      const markRestartAbortedMainSessionsFromLocksLocal = await getMarker();
      await markRestartAbortedMainSessionsFromLocksLocal({
        sessionsDir,
        cleanedLocks: result.cleaned,
      });
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

function scheduleTranscriptsAutoStartSidecar(params: {
  cfg: OpenClawConfig;
  startupTrace?: GatewayStartupTrace;
  log: { warn: (msg: string) => void };
}): GatewayPostReadySidecarHandle {
  let stopTranscriptsAutoStart: (() => Promise<void>) | undefined;
  return schedulePostReadySidecarTask({
    startupTrace: params.startupTrace,
    name: "sidecars.transcripts-auto-start",
    log: params.log,
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

function isConfiguredCliBackendPrimary(params: {
  cfg: OpenClawConfig;
  explicitPrimary: string;
  normalizeProviderId: (provider: string) => string;
}): boolean {
  const slashIndex = params.explicitPrimary.indexOf("/");
  if (slashIndex <= 0) {
    return false;
  }
  const provider = params.normalizeProviderId(params.explicitPrimary.slice(0, slashIndex));
  return Object.keys(params.cfg.agents?.defaults?.cliBackends ?? {}).some(
    (backend) => params.normalizeProviderId(backend) === provider,
  );
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
  workspaceDir?: string;
  log: { warn: (msg: string) => void };
}): Promise<void> {
  const { resolveAgentModelPrimaryValue } = await import("../config/model-input.js");
  const explicitPrimary = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model)?.trim();
  if (!explicitPrimary) {
    return;
  }
  const { normalizeProviderId } = await import("@openclaw/model-catalog-core/provider-id");
  if (
    isConfiguredCliBackendPrimary({
      cfg: params.cfg,
      explicitPrimary,
      normalizeProviderId,
    })
  ) {
    return;
  }
  const [
    { resolveAgentWorkspaceDir, resolveDefaultAgentDir, resolveDefaultAgentId },
    { DEFAULT_MODEL, DEFAULT_PROVIDER },
    { isCliProvider, resolveConfiguredModelRef },
  ] = await Promise.all([
    import("../agents/agent-scope.js"),
    loadAgentDefaultsModule(),
    loadAgentModelSelectionModule(),
  ]);
  const { provider, model } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  if (isCliProvider(provider, params.cfg)) {
    return;
  }
  // Keep startup prewarm metadata-only; resolving models can import provider runtimes and block readiness.
  const { ensureOpenClawModelsJson } = await import("../agents/models-config.js");
  const agentDir = resolveDefaultAgentDir(params.cfg);
  const workspaceDir =
    params.workspaceDir ?? resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg));
  try {
    await ensureOpenClawModelsJson(params.cfg, agentDir, {
      workspaceDir,
      providerDiscoveryProviderIds: [provider],
      providerDiscoveryTimeoutMs: STARTUP_PROVIDER_DISCOVERY_TIMEOUT_MS,
      providerDiscoveryEntriesOnly: true,
    });
  } catch (err) {
    params.log.warn(`startup model warmup failed for ${provider}/${model}: ${String(err)}`);
  }
}

async function prewarmConfiguredPrimaryModelWithTimeout(
  params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    log: { warn: (msg: string) => void };
    timeoutMs?: number;
  },
  prewarm: typeof prewarmConfiguredPrimaryModel = prewarmConfiguredPrimaryModel,
): Promise<void> {
  let settled = false;
  const warmup = prewarm(params)
    .catch((err: unknown) => {
      params.log.warn(`startup model warmup failed: ${String(err)}`);
    })
    .finally(() => {
      settled = true;
    });
  const timeout = sleep(params.timeoutMs ?? PRIMARY_MODEL_PREWARM_TIMEOUT_MS, undefined, {
    ref: false,
  }).then(() => {
    if (!settled) {
      params.log.warn(
        `startup model warmup timed out after ${params.timeoutMs ?? PRIMARY_MODEL_PREWARM_TIMEOUT_MS}ms; continuing without waiting`,
      );
    }
  });
  await Promise.race([warmup, timeout]);
}

function schedulePrimaryModelPrewarm(
  params: {
    cfg: OpenClawConfig;
    workspaceDir?: string;
    log: { warn: (msg: string) => void };
    startupTrace?: GatewayStartupTrace;
  },
  prewarm: typeof prewarmConfiguredPrimaryModel = prewarmConfiguredPrimaryModel,
): void {
  if (shouldSkipStartupModelPrewarm()) {
    return;
  }
  void measureStartup(params.startupTrace, "sidecars.model-prewarm", () =>
    prewarmConfiguredPrimaryModelWithTimeout(
      {
        cfg: params.cfg,
        ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
        log: params.log,
      },
      prewarm,
    ),
  ).catch((err: unknown) => {
    params.log.warn(`startup model warmup failed: ${String(err)}`);
  });
}

/** Start post-ready sidecars such as channels, hooks, plugin services, and cleanup tasks. */
export async function startGatewaySidecars(params: {
  cfg: OpenClawConfig;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  onChannelsStarted?: () => Awaitable<void>;
  prewarmPrimaryModel?: typeof prewarmConfiguredPrimaryModel;
  onPluginServices?: (pluginServices: PluginServicesHandle | null) => void;
  shouldStartPluginServices?: () => boolean;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  startupTrace?: GatewayStartupTrace;
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
          params.logHooks.info(
            `loaded ${loadedCount} internal hook handler${loadedCount > 1 ? "s" : ""}`,
          );
        }
      }
    } catch (err) {
      params.logHooks.error(`failed to load hooks: ${String(err)}`);
    }
  });

  const skipChannels =
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
    isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS);
  await measureStartup(params.startupTrace, "sidecars.main-session-recovery", async () => {
    try {
      const { markStartupOrphanedMainSessionsForRecovery } =
        await loadMainSessionRestartRecoveryModule();
      await markStartupOrphanedMainSessionsForRecovery({ cfg: params.cfg });
    } catch (err) {
      params.log.warn(
        `main-session startup orphan marking failed before channel startup: ${String(err)}`,
      );
    }
  });
  await measureStartup(params.startupTrace, "sidecars.channels", async () => {
    if (!skipChannels) {
      try {
        schedulePrimaryModelPrewarm(
          {
            cfg: params.cfg,
            workspaceDir: params.defaultWorkspaceDir,
            log: params.log,
            startupTrace: params.startupTrace,
          },
          params.prewarmPrimaryModel,
        );
        await measureStartup(params.startupTrace, "sidecars.channel-start", () =>
          params.startChannels(),
        );
      } catch (err) {
        params.logChannels.error(`channel startup failed: ${String(err)}`);
      }
    } else {
      await measureStartup(params.startupTrace, "sidecars.channel-skip", () =>
        params.logChannels.info(
          "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
        ),
      );
    }
  });
  await params.onChannelsStarted?.();

  let pluginServices =
    params.shouldStartPluginServices?.() === false
      ? null
      : await measureStartup(params.startupTrace, "sidecars.plugin-services", async () => {
          try {
            const { startPluginServices } = await import("../plugins/services.js");
            return await startPluginServices({
              registry: params.pluginRegistry,
              config: params.cfg,
              workspaceDir: params.defaultWorkspaceDir,
              startupTrace: params.startupTrace,
            });
          } catch (err) {
            params.log.warn(`plugin services failed to start: ${String(err)}`);
            return null;
          }
        });
  if (pluginServices && params.shouldStartPluginServices?.() === false) {
    await pluginServices.stop().catch((err: unknown) => {
      params.log.warn(`plugin services stop after close failed: ${String(err)}`);
    });
    pluginServices = null;
  }
  params.onPluginServices?.(pluginServices);

  const shouldDispatchGatewayStartupInternalHook =
    internalHooksConfigured || (await hasGatewayStartupInternalHookListeners());
  if (shouldDispatchGatewayStartupInternalHook) {
    // Run startup hooks after sidecar startup has yielded once so gateway bind
    // and channel startup are not delayed by hook handlers.
    setTimeout(() => {
      void runWithGatewayIndependentRootWorkAdmission(async () => {
        const { createInternalHookEvent, triggerInternalHook } = await loadInternalHooksModule();
        const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: params.cfg,
          deps: params.deps,
          workspaceDir: params.defaultWorkspaceDir,
        });
        await triggerInternalHook(hookEvent);
      }).catch((err: unknown) => {
        params.logHooks.warn(`gateway startup hook failed: ${String(err)}`);
      });
    }, 250);
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

  await measureStartup(params.startupTrace, "sidecars.memory", async () => {
    const policy = resolveGatewayMemoryStartupPolicy(params.cfg);
    if (policy.mode === "off") {
      return;
    }
    scheduleGatewayMemoryBackend({ cfg: params.cfg, log: params.log, policy });
  });

  schedulePostReadySidecarTask({
    startupTrace: params.startupTrace,
    name: "sidecars.session-locks",
    log: params.log,
    run: async (isStopped) => {
      try {
        const [{ resolveAgentSessionDirs }, { cleanStaleLockFiles }] = await Promise.all([
          import("../agents/session-dirs.js"),
          import("../agents/session-write-lock.js"),
        ]);
        const stateDir = resolveStateDir(process.env);
        const sessionDirs = await resolveAgentSessionDirs(stateDir);
        await cleanupStaleSessionLocks({
          sessionDirs,
          cfg: params.cfg,
          log: params.log,
          isStopped,
          cleanStaleLockFiles,
        });
      } catch (err) {
        params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
      }
    },
  });

  schedulePostReadySidecarTask({
    startupTrace: params.startupTrace,
    name: "sidecars.restart-sentinel",
    log: params.log,
    run: async () => {
      if (!shouldCheckRestartSentinel()) {
        return;
      }
      if (!(await hasRestartSentinelFast())) {
        return;
      }
      scheduleRestartSentinelWakeAfterReady({ deps: params.deps, log: params.log });
    },
  });

  schedulePostReadySidecarTask({
    startupTrace: params.startupTrace,
    name: "sidecars.subagent-recovery",
    log: params.log,
    run: async () => {
      const { scheduleSubagentOrphanRecovery } = await import("../agents/subagent-registry.js");
      scheduleSubagentOrphanRecovery();
    },
  });

  if (params.cfg.hooks?.enabled && params.cfg.hooks.gmail?.account) {
    postReadySidecars.push(
      schedulePostReadySidecarTask({
        startupTrace: params.startupTrace,
        name: "sidecars.gmail-watch",
        log: params.log,
        run: async (isStopped, signal) => {
          const { startGmailWatcherWithLogs } = await import("../hooks/gmail-watcher-lifecycle.js");
          if (isStopped()) {
            return;
          }
          await startGmailWatcherWithLogs({
            cfg: params.cfg,
            log: params.logHooks,
            isCancelled: isStopped,
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
        run: async (isStopped) => {
          const [
            { DEFAULT_MODEL, DEFAULT_PROVIDER },
            { loadModelCatalog },
            { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel },
          ] = await Promise.all([
            loadAgentDefaultsModule(),
            import("../agents/model-catalog.js"),
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
            const catalog = await loadModelCatalog({ config: params.cfg });
            const status = getModelRefStatus({
              cfg: params.cfg,
              catalog,
              ref: hooksModelRef,
              defaultProvider: resolvedDefaultProvider,
              defaultModel,
            });
            if (!status.allowed) {
              params.logHooks.warn(
                `hooks.gmail.model "${status.key}" not in agents.defaults.models allowlist (will use primary instead)`,
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

  return { pluginServices, postReadySidecars };
}

type GatewayPostAttachRuntimeDeps = {
  getGlobalHookRunner: () => Awaitable<ReturnType<typeof getGlobalHookRunner>>;
  logGatewayStartup: (params: Parameters<typeof logGatewayStartup>[0]) => Awaitable<void>;
  refreshLatestUpdateRestartSentinel: () => Awaitable<
    ReturnType<typeof refreshLatestUpdateRestartSentinel>
  >;
  scheduleGatewayUpdateCheck: (
    ...args: Parameters<typeof scheduleGatewayUpdateCheck>
  ) => Awaitable<ReturnType<typeof scheduleGatewayUpdateCheck>>;
  startGatewaySidecars: typeof startGatewaySidecars;
  startGatewayTailscaleExposure: (
    ...args: Parameters<typeof startGatewayTailscaleExposure>
  ) => ReturnType<typeof startGatewayTailscaleExposure>;
};

const defaultGatewayPostAttachRuntimeDeps: GatewayPostAttachRuntimeDeps = {
  getGlobalHookRunner: async () =>
    (await import("../plugins/hook-runner-global.js")).getGlobalHookRunner(),
  logGatewayStartup: async (params) =>
    (await import("./server-startup-log.js")).logGatewayStartup(params),
  refreshLatestUpdateRestartSentinel: refreshLatestUpdateRestartSentinelIfPresent,
  scheduleGatewayUpdateCheck: async (...args) =>
    (await import("../infra/update-startup.js")).scheduleGatewayUpdateCheck(...args),
  startGatewaySidecars,
  startGatewayTailscaleExposure: async (...args) =>
    (await import("./server-tailscale.js")).startGatewayTailscaleExposure(...args),
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
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
}): { start: () => void; stop: () => void } {
  let started = false;
  let stopped = false;
  let stopUpdateCheck: (() => void) | null = null;

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
    // Update checks are intentionally post-attach so startup logging, sidecars,
    // and Tailscale exposure are not serialized behind network I/O.
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
              onUpdateAvailableChange: (updateAvailable) => {
                const payload: GatewayUpdateAvailableEventPayload = { updateAvailable };
                params.broadcast(GATEWAY_EVENT_UPDATE_AVAILABLE, payload, { dropIfSlow: true });
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
  };

  return { start, stop };
}

/** Start work that depends on the HTTP server being attached and visible. */
export async function startGatewayPostAttachRuntime(
  params: {
    minimalTestGateway: boolean;
    cfgAtStart: OpenClawConfig;
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
    broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
    tailscaleMode: GatewayTailscaleMode;
    resetOnExit: boolean;
    serviceName?: string;
    preserveFunnel: boolean;
    controlUiBasePath: string;
    logTailscale: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    };
    gatewayPluginConfigAtStart: OpenClawConfig;
    activationSourceConfig: OpenClawConfig;
    pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
    defaultWorkspaceDir: string;
    deps: CliDeps;
    startChannels: () => Promise<void>;
    logHooks: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    };
    logChannels: { info: (msg: string) => void; error: (msg: string) => void };
    unavailableGatewayMethods: Set<string>;
    loadStartupPlugins?: () => Awaitable<{
      pluginRegistry: PluginRegistry;
      gatewayMethods: string[];
    }>;
    onStartupPluginsLoading?: () => void;
    onStartupPluginsLoaded?: (result: {
      pluginRegistry: PluginRegistry;
      gatewayMethods: string[];
    }) => Awaitable<void>;
    getCronService?: () => PluginHookGatewayCronService | null | undefined;
    onChannelsStarted?: () => Awaitable<void>;
    onPluginServices?: (pluginServices: PluginServicesHandle | null) => void;
    onPostReadySidecars?: (postReadySidecars: GatewayPostReadySidecarHandle[]) => void;
    onGatewayLifetimeSidecars?: (sidecars: GatewayPostReadySidecarHandle[]) => void;
    onSidecarsReady?: () => void;
    isClosing?: () => boolean;
    startupTrace?: GatewayStartupTrace;
    sidecarStartup?: GatewaySidecarStartupMode;
    providerAuthPrewarm?: {
      enabled?: boolean;
      delayMs?: number;
      getConfig?: () => OpenClawConfig;
    };
    agentRuntimePluginPrewarm?: {
      enabled?: boolean;
      delayMs?: number;
      getConfig?: () => OpenClawConfig;
    };
  },
  runtimeDeps: GatewayPostAttachRuntimeDeps = defaultGatewayPostAttachRuntimeDeps,
) {
  let pluginRegistry = params.pluginRegistry;
  let startupPluginsLoaded = false;
  let startupPluginsLoadPromise: Promise<{
    pluginRegistry: PluginRegistry;
    gatewayMethods: string[];
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
      pluginRegistry = loaded.pluginRegistry;
      startupPluginsLoaded = true;
      params.startupTrace?.detail("plugins.runtime-post-bind", [
        [
          "loadedPluginCount",
          pluginRegistry.plugins.filter((plugin) => plugin.status === "loaded").length,
        ],
        ["gatewayMethodCount", loaded.gatewayMethods.length],
      ]);
      await params.onStartupPluginsLoaded?.(loaded);
      return loaded;
    })();
    return await startupPluginsLoadPromise;
  };
  await loadStartupPluginsIfNeeded();

  const startupLogPromise = measureStartup(params.startupTrace, "post-attach.log", () =>
    runtimeDeps.logGatewayStartup({
      cfg: params.cfgAtStart,
      activationSourceConfig: params.activationSourceConfig,
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

  const updateCheck = params.minimalTestGateway
    ? { start: () => {}, stop: () => {} }
    : createDeferredGatewayUpdateCheck({
        startupTrace: params.startupTrace,
        runtimeDeps,
        cfg: params.cfgAtStart,
        log: params.log,
        isNixMode: params.isNixMode,
        broadcast: params.broadcast,
      });

  const tailscaleCleanupPromise = params.minimalTestGateway
    ? Promise.resolve(null)
    : params.tailscaleMode === "off" && !params.resetOnExit
      ? Promise.resolve(null)
      : measureStartup(params.startupTrace, "post-attach.tailscale", () =>
          runtimeDeps.startGatewayTailscaleExposure({
            tailscaleMode: params.tailscaleMode,
            resetOnExit: params.resetOnExit,
            serviceName: params.serviceName,
            preserveFunnel: params.preserveFunnel,
            port: params.port,
            controlUiBasePath: params.controlUiBasePath,
            logTailscale: params.logTailscale,
          }),
        );

  let pluginServicesReported = false;
  let reportedPluginServices: PluginServicesHandle | null = null;
  const reportPluginServices = (pluginServices: PluginServicesHandle | null) => {
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

  const sidecarsPromise = params.minimalTestGateway
    ? Promise.resolve({ pluginServices: null, pluginRegistry, postReadySidecars: [] })
    : waitForSidecarStartTurn().then(async () => {
        await loadStartupPluginsIfNeeded();
        params.log.info("starting channels and sidecars...");
        const loaderStatsBefore = getPluginModuleLoaderStats();
        const result = await measureStartup(params.startupTrace, "sidecars.total", () =>
          runtimeDeps.startGatewaySidecars({
            cfg: params.gatewayPluginConfigAtStart,
            pluginRegistry,
            defaultWorkspaceDir: params.defaultWorkspaceDir,
            deps: params.deps,
            startChannels: params.startChannels,
            log: params.log,
            logHooks: params.logHooks,
            logChannels: params.logChannels,
            startupTrace: params.startupTrace,
            onChannelsStarted: params.onChannelsStarted,
            onPluginServices: reportPluginServices,
            shouldStartPluginServices: () => params.isClosing?.() !== true,
          }),
        );
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
            loaderStatsAfter.sourceTransformFallbacks - loaderStatsBefore.sourceTransformFallbacks,
          ],
        ]);
        try {
          const { scheduleRestartAbortedMainSessionRecovery } =
            await loadMainSessionRestartRecoveryModule();
          scheduleRestartAbortedMainSessionRecovery({ cfg: params.cfgAtStart });
        } catch (err) {
          params.log.warn(`main-session restart recovery failed to schedule: ${String(err)}`);
        }
        // Capture the orphan-recovery cutoff before new startup-gated agent
        // work can create sessions that the recovery scan must leave alone.
        for (const method of STARTUP_UNAVAILABLE_GATEWAY_METHODS) {
          params.unavailableGatewayMethods.delete(method);
        }
        if (!pluginServicesReported) {
          reportPluginServices(result.pluginServices);
        }
        const postReadySidecars = [...result.postReadySidecars];
        const gatewayLifetimeSidecars: GatewayPostReadySidecarHandle[] = [];
        if (params.agentRuntimePluginPrewarm?.enabled !== false) {
          gatewayLifetimeSidecars.push(
            scheduleAgentRuntimePluginPrewarm({
              getConfig:
                params.agentRuntimePluginPrewarm?.getConfig ??
                params.providerAuthPrewarm?.getConfig ??
                (() => params.gatewayPluginConfigAtStart),
              workspaceDir: params.defaultWorkspaceDir,
              startupTrace: params.startupTrace,
              log: params.log,
              delayMs: params.agentRuntimePluginPrewarm?.delayMs,
            }),
          );
        }
        if (params.providerAuthPrewarm && params.providerAuthPrewarm.enabled !== false) {
          gatewayLifetimeSidecars.push(
            scheduleProviderAuthStatePrewarm({
              getConfig: params.providerAuthPrewarm.getConfig ?? (() => params.cfgAtStart),
              log: params.log,
              delayMs: params.providerAuthPrewarm.delayMs,
              startupWarmEnabled: params.providerAuthPrewarm.enabled === true,
            }),
          );
        }
        if (params.gatewayPluginConfigAtStart.transcripts?.autoStart?.length) {
          gatewayLifetimeSidecars.push(
            scheduleTranscriptsAutoStartSidecar({
              cfg: params.gatewayPluginConfigAtStart,
              startupTrace: params.startupTrace,
              log: params.log,
            }),
          );
        }
        params.onPostReadySidecars?.(postReadySidecars);
        params.onGatewayLifetimeSidecars?.(gatewayLifetimeSidecars);
        params.onSidecarsReady?.();
        params.startupTrace?.detail("sidecars.ready", [
          [
            "loadedPluginCount",
            pluginRegistry.plugins.filter((plugin) => plugin.status === "loaded").length,
          ],
          ["postReadySidecarCount", postReadySidecars.length + gatewayLifetimeSidecars.length],
        ]);
        params.startupTrace?.mark("sidecars.ready");
        if (params.sidecarStartup !== "defer") {
          params.log.info("gateway ready");
        }
        return { ...result, postReadySidecars, gatewayLifetimeSidecars, pluginRegistry };
      });

  void sidecarsPromise
    .then(async (sidecarsResult) => {
      if (params.minimalTestGateway) {
        return;
      }
      schedulePostAttachUpdateSentinelRefresh({
        startupTrace: params.startupTrace,
        log: params.log,
        refreshLatestUpdateRestartSentinel: runtimeDeps.refreshLatestUpdateRestartSentinel,
      });
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
    const [, tailscaleCleanup, sidecarsResult] = await Promise.all([
      startupLogPromise,
      tailscaleCleanupPromise,
      sidecarsPromise,
    ]);
    updateCheck.start();
    return {
      stopGatewayUpdateCheck: updateCheck.stop,
      tailscaleCleanup,
      pluginServices: sidecarsResult.pluginServices,
    };
  }

  const [, tailscaleCleanup] = await Promise.all([startupLogPromise, tailscaleCleanupPromise]);
  updateCheck.start();

  return {
    stopGatewayUpdateCheck: updateCheck.stop,
    tailscaleCleanup,
    pluginServices: reportedPluginServices,
  };
}

export const testing = {
  providerAuthPrewarmStartDelayMs: PROVIDER_AUTH_PREWARM_START_DELAY_MS,
  hasRestartSentinelFast,
  prewarmConfiguredPrimaryModel,
  prewarmConfiguredPrimaryModelWithTimeout,
  refreshLatestUpdateRestartSentinelIfPresent,
  resolveGatewayMemoryStartupPolicy,
  cleanupStaleSessionLocks,
  scheduleProviderAuthStatePrewarm,
  schedulePrimaryModelPrewarm,
  scheduleRestartSentinelWakeAfterReady,
  shouldSkipStartupModelPrewarm,
  stopPostReadySidecarsAfterCloseStarted,
};
export { testing as __testing };
