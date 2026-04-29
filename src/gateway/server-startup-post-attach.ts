import { setTimeout as sleep } from "node:timers/promises";
import type { CliDeps } from "../cli/deps.types.js";
import type { GatewayTailscaleMode } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasConfiguredInternalHooks } from "../hooks/configured.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { scheduleGatewayUpdateCheck } from "../infra/update-startup.js";
import type { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import type { loadOpenClawPlugins } from "../plugins/loader.js";
import type { PluginServicesHandle } from "../plugins/services.js";
import {
  GATEWAY_EVENT_UPDATE_AVAILABLE,
  type GatewayUpdateAvailableEventPayload,
} from "./events.js";
import type { refreshLatestUpdateRestartSentinel } from "./server-restart-sentinel.js";
import type { logGatewayStartup } from "./server-startup-log.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./server-startup-unavailable-methods.js";
import type { startGatewayTailscaleExposure } from "./server-tailscale.js";

const SESSION_LOCK_STALE_MS = 30 * 60 * 1000;
const ACP_BACKEND_READY_TIMEOUT_MS = 5_000;
const ACP_BACKEND_READY_POLL_MS = 50;
const PRIMARY_MODEL_PREWARM_TIMEOUT_MS = 5_000;
const STARTUP_PROVIDER_DISCOVERY_TIMEOUT_MS = 5_000;
const SKIP_STARTUP_MODEL_PREWARM_ENV = "OPENCLAW_SKIP_STARTUP_MODEL_PREWARM";
const QMD_STARTUP_IDLE_DELAY_MS = 120_000;

type Awaitable<T> = T | Promise<T>;

type GatewayStartupTrace = {
  mark: (name: string) => void;
  measure: <T>(name: string, run: () => Awaitable<T>) => Promise<T>;
};

type GatewayMemoryStartupPolicy =
  | { mode: "off" }
  | { mode: "immediate" }
  | { mode: "idle"; delayMs: number };

async function measureStartup<T>(
  startupTrace: GatewayStartupTrace | undefined,
  name: string,
  run: () => Awaitable<T>,
): Promise<T> {
  return startupTrace ? startupTrace.measure(name, run) : await run();
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
  if (cfg.memory.qmd?.update?.onBoot === false) {
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
    void import("./server-startup-memory.js")
      .then(({ startGatewayMemoryBackend }) =>
        startGatewayMemoryBackend({ cfg: params.cfg, log: params.log }),
      )
      .catch((err) => {
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
  const { hasInternalHookListeners } = await import("../hooks/internal-hooks.js");
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
  const { normalizeProviderId } = await import("../agents/provider-id.js");
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
    { resolveOpenClawAgentDir },
    { resolveAgentWorkspaceDir, resolveDefaultAgentId },
    { DEFAULT_MODEL, DEFAULT_PROVIDER },
    { isCliProvider, resolveConfiguredModelRef },
    { resolveEmbeddedAgentRuntime },
  ] = await Promise.all([
    import("../agents/agent-paths.js"),
    import("../agents/agent-scope.js"),
    import("../agents/defaults.js"),
    import("../agents/model-selection.js"),
    import("../agents/pi-embedded-runner/runtime.js"),
  ]);
  const { provider, model } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  if (isCliProvider(provider, params.cfg)) {
    return;
  }
  const runtime = resolveEmbeddedAgentRuntime();
  if (runtime !== "auto" && runtime !== "pi") {
    return;
  }
  // Keep startup prewarm metadata-only; resolving models can import provider runtimes and block readiness.
  const { ensureOpenClawModelsJson } = await import("../agents/models-config.js");
  const agentDir = resolveOpenClawAgentDir();
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
    .catch((err) => {
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
  ).catch((err) => {
    params.log.warn(`startup model warmup failed: ${String(err)}`);
  });
}

export async function startGatewaySidecars(params: {
  cfg: OpenClawConfig;
  pluginRegistry: ReturnType<typeof loadOpenClawPlugins>;
  defaultWorkspaceDir: string;
  deps: CliDeps;
  startChannels: () => Promise<void>;
  prewarmPrimaryModel?: typeof prewarmConfiguredPrimaryModel;
  log: { warn: (msg: string) => void };
  logHooks: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  logChannels: { info: (msg: string) => void; error: (msg: string) => void };
  startupTrace?: GatewayStartupTrace;
}) {
  await measureStartup(params.startupTrace, "sidecars.session-locks", async () => {
    try {
      const [{ resolveStateDir }, { resolveAgentSessionDirs }, { cleanStaleLockFiles }] =
        await Promise.all([
          import("../config/paths.js"),
          import("../agents/session-dirs.js"),
          import("../agents/session-write-lock.js"),
        ]);
      const stateDir = resolveStateDir(process.env);
      const sessionDirs = await resolveAgentSessionDirs(stateDir);
      for (const sessionsDir of sessionDirs) {
        const result = await cleanStaleLockFiles({
          sessionsDir,
          staleMs: SESSION_LOCK_STALE_MS,
          removeStale: true,
          log: { warn: (message) => params.log.warn(message) },
        });
        if (result.cleaned.length > 0) {
          const { markRestartAbortedMainSessionsFromLocks } =
            await import("../agents/main-session-restart-recovery.js");
          await markRestartAbortedMainSessionsFromLocks({
            sessionsDir,
            cleanedLocks: result.cleaned,
          });
        }
      }
    } catch (err) {
      params.log.warn(`session lock cleanup failed on startup: ${String(err)}`);
    }
  });

  await measureStartup(params.startupTrace, "sidecars.gmail-watch", async () => {
    if (params.cfg.hooks?.enabled && params.cfg.hooks.gmail?.account) {
      const { startGmailWatcherWithLogs } = await import("../hooks/gmail-watcher-lifecycle.js");
      await startGmailWatcherWithLogs({
        cfg: params.cfg,
        log: params.logHooks,
      });
    }
  });

  await measureStartup(params.startupTrace, "sidecars.gmail-model", async () => {
    if (params.cfg.hooks?.gmail?.model) {
      const [
        { DEFAULT_MODEL, DEFAULT_PROVIDER },
        { loadModelCatalog },
        { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel },
      ] = await Promise.all([
        import("../agents/defaults.js"),
        import("../agents/model-catalog.js"),
        import("../agents/model-selection.js"),
      ]);
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
    }
  });

  const internalHooksConfigured = hasConfiguredInternalHooks(params.cfg);
  await measureStartup(params.startupTrace, "sidecars.internal-hooks", async () => {
    try {
      if (internalHooksConfigured) {
        const [{ setInternalHooksEnabled }, { loadInternalHooks }] = await Promise.all([
          import("../hooks/internal-hooks.js"),
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
      params.logChannels.info(
        "skipping channel start (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
      );
    }
  });

  const shouldDispatchGatewayStartupInternalHook =
    internalHooksConfigured || (await hasGatewayStartupInternalHookListeners());
  if (shouldDispatchGatewayStartupInternalHook) {
    setTimeout(() => {
      void import("../hooks/internal-hooks.js").then(
        ({ createInternalHookEvent, triggerInternalHook }) => {
          const hookEvent = createInternalHookEvent("gateway", "startup", "gateway:startup", {
            cfg: params.cfg,
            deps: params.deps,
            workspaceDir: params.defaultWorkspaceDir,
          });
          void triggerInternalHook(hookEvent);
        },
      );
    }, 250);
  }

  let pluginServices: PluginServicesHandle | null = null;
  await measureStartup(params.startupTrace, "sidecars.plugin-services", async () => {
    try {
      const { startPluginServices } = await import("../plugins/services.js");
      pluginServices = await startPluginServices({
        registry: params.pluginRegistry,
        config: params.cfg,
        workspaceDir: params.defaultWorkspaceDir,
      });
    } catch (err) {
      params.log.warn(`plugin services failed to start: ${String(err)}`);
    }
  });

  if (params.cfg.acp?.enabled) {
    void (async () => {
      await waitForAcpRuntimeBackendReady({ backendId: params.cfg.acp?.backend });
      const [{ getAcpSessionManager }, { ACP_SESSION_IDENTITY_RENDERER_VERSION }] =
        await Promise.all([
          import("../acp/control-plane/manager.js"),
          import("../acp/runtime/session-identifiers.js"),
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
    })().catch((err) => {
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

  await measureStartup(params.startupTrace, "sidecars.restart-sentinel", async () => {
    if (!shouldCheckRestartSentinel()) {
      return;
    }
    const { hasRestartSentinel } = await import("../infra/restart-sentinel.js");
    if (!(await hasRestartSentinel())) {
      return;
    }
    setTimeout(() => {
      void import("./server-restart-sentinel.js")
        .then(({ scheduleRestartSentinelWake }) =>
          scheduleRestartSentinelWake({ deps: params.deps }),
        )
        .catch((err) => {
          params.log.warn(`restart sentinel wake failed to schedule: ${String(err)}`);
        });
    }, 750);
  });

  await measureStartup(params.startupTrace, "sidecars.subagent-recovery", async () => {
    const { scheduleSubagentOrphanRecovery } = await import("../agents/subagent-registry.js");
    scheduleSubagentOrphanRecovery();
  });

  await measureStartup(params.startupTrace, "sidecars.main-session-recovery", async () => {
    const { scheduleRestartAbortedMainSessionRecovery } =
      await import("../agents/main-session-restart-recovery.js");
    scheduleRestartAbortedMainSessionRecovery();
  });

  return { pluginServices };
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
  refreshLatestUpdateRestartSentinel: async () =>
    (await import("./server-restart-sentinel.js")).refreshLatestUpdateRestartSentinel(),
  scheduleGatewayUpdateCheck: async (...args) =>
    (await import("../infra/update-startup.js")).scheduleGatewayUpdateCheck(...args),
  startGatewaySidecars,
  startGatewayTailscaleExposure: async (...args) =>
    (await import("./server-tailscale.js")).startGatewayTailscaleExposure(...args),
};

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
    controlUiBasePath: string;
    logTailscale: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
      debug?: (msg: string) => void;
    };
    gatewayPluginConfigAtStart: OpenClawConfig;
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
    getCronService?: () => PluginHookGatewayCronService | null | undefined;
    onPluginServices?: (pluginServices: PluginServicesHandle | null) => void;
    onSidecarsReady?: () => void;
    startupTrace?: GatewayStartupTrace;
    deferSidecars?: boolean;
  },
  runtimeDeps: GatewayPostAttachRuntimeDeps = defaultGatewayPostAttachRuntimeDeps,
) {
  await measureStartup(params.startupTrace, "post-attach.update-sentinel", async () => {
    try {
      await runtimeDeps.refreshLatestUpdateRestartSentinel();
    } catch (err) {
      params.log.warn(`restart sentinel refresh failed: ${String(err)}`);
    }
  });

  await measureStartup(params.startupTrace, "post-attach.log", () =>
    runtimeDeps.logGatewayStartup({
      cfg: params.cfgAtStart,
      bindHost: params.bindHost,
      bindHosts: params.bindHosts,
      port: params.port,
      tlsEnabled: params.tlsEnabled,
      loadedPluginIds: params.pluginRegistry.plugins
        .filter((plugin) => plugin.status === "loaded")
        .map((plugin) => plugin.id),
      log: params.log,
      isNixMode: params.isNixMode,
      startupStartedAt: params.startupStartedAt,
    }),
  );

  const stopGatewayUpdateCheckPromise = params.minimalTestGateway
    ? Promise.resolve(() => {})
    : measureStartup(params.startupTrace, "post-attach.update-check", () =>
        runtimeDeps.scheduleGatewayUpdateCheck({
          cfg: params.cfgAtStart,
          log: params.log,
          isNixMode: params.isNixMode,
          onUpdateAvailableChange: (updateAvailable) => {
            const payload: GatewayUpdateAvailableEventPayload = { updateAvailable };
            params.broadcast(GATEWAY_EVENT_UPDATE_AVAILABLE, payload, { dropIfSlow: true });
          },
        }),
      );

  const tailscaleCleanupPromise = params.minimalTestGateway
    ? Promise.resolve(null)
    : params.tailscaleMode === "off" && !params.resetOnExit
      ? Promise.resolve(null)
      : measureStartup(params.startupTrace, "post-attach.tailscale", () =>
          runtimeDeps.startGatewayTailscaleExposure({
            tailscaleMode: params.tailscaleMode,
            resetOnExit: params.resetOnExit,
            port: params.port,
            controlUiBasePath: params.controlUiBasePath,
            logTailscale: params.logTailscale,
          }),
        );

  const sidecarsPromise = params.minimalTestGateway
    ? Promise.resolve({ pluginServices: null })
    : new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
        params.log.info("starting channels and sidecars...");
        const result = await measureStartup(params.startupTrace, "sidecars.total", () =>
          runtimeDeps.startGatewaySidecars({
            cfg: params.gatewayPluginConfigAtStart,
            pluginRegistry: params.pluginRegistry,
            defaultWorkspaceDir: params.defaultWorkspaceDir,
            deps: params.deps,
            startChannels: params.startChannels,
            log: params.log,
            logHooks: params.logHooks,
            logChannels: params.logChannels,
            startupTrace: params.startupTrace,
          }),
        );
        for (const method of STARTUP_UNAVAILABLE_GATEWAY_METHODS) {
          params.unavailableGatewayMethods.delete(method);
        }
        params.onPluginServices?.(result.pluginServices);
        params.onSidecarsReady?.();
        params.startupTrace?.mark("sidecars.ready");
        params.log.info("gateway ready");
        return result;
      });

  void sidecarsPromise
    .then(async () => {
      if (params.minimalTestGateway) {
        return;
      }
      if (!hasGatewayStartHooks(params.pluginRegistry)) {
        return;
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      const hookRunner = await runtimeDeps.getGlobalHookRunner();
      if (hookRunner?.hasHooks("gateway_start")) {
        void hookRunner
          .runGatewayStart(
            { port: params.port },
            {
              port: params.port,
              config: params.gatewayPluginConfigAtStart,
              workspaceDir: params.defaultWorkspaceDir,
              getCron: () =>
                params.getCronService?.() ??
                (params.deps.cron as PluginHookGatewayCronService | undefined),
            },
          )
          .catch((err) => {
            params.log.warn(`gateway_start hook failed: ${String(err)}`);
          });
      }
    })
    .catch((err) => {
      params.log.warn(`gateway sidecars failed to start: ${String(err)}`);
    });

  if (params.deferSidecars !== true) {
    const [stopGatewayUpdateCheck, tailscaleCleanup, sidecarsResult] = await Promise.all([
      stopGatewayUpdateCheckPromise,
      tailscaleCleanupPromise,
      sidecarsPromise,
    ]);
    return {
      stopGatewayUpdateCheck,
      tailscaleCleanup,
      pluginServices: sidecarsResult.pluginServices,
    };
  }

  const [stopGatewayUpdateCheck, tailscaleCleanup] = await Promise.all([
    stopGatewayUpdateCheckPromise,
    tailscaleCleanupPromise,
  ]);

  return { stopGatewayUpdateCheck, tailscaleCleanup, pluginServices: null };
}

export const __testing = {
  prewarmConfiguredPrimaryModel,
  prewarmConfiguredPrimaryModelWithTimeout,
  resolveGatewayMemoryStartupPolicy,
  schedulePrimaryModelPrewarm,
  shouldSkipStartupModelPrewarm,
};
