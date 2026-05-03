import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { getActiveEmbeddedRunCount } from "../agents/pi-embedded-runner/run-state.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import type { CanvasHostServer } from "../canvas-host/server.js";
import type { ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
import { type ChannelId, listChannelPlugins } from "../channels/plugins/index.js";
import { getLoadedChannelPluginEntryById } from "../channels/plugins/registry-loaded.js";
import { createDefaultDeps } from "../cli/deps.js";
import { isRestartEnabled } from "../config/commands.flags.js";
import {
  getRuntimeConfig,
  promoteConfigSnapshotToLastKnownGood,
  readConfigFileSnapshot,
  recoverConfigFromLastKnownGood,
  registerConfigWriteListener,
  setRuntimeConfigSnapshot,
  type ReadConfigFileSnapshotWithPluginMetadataResult,
} from "../config/io.js";
import { replaceConfigFile } from "../config/mutate.js";
import { isNixMode } from "../config/paths.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext } from "../infra/agent-events.js";
import {
  isDiagnosticsEnabled,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import {
  emitDiagnosticsTimelineEvent,
  isDiagnosticsTimelineEnabled,
} from "../infra/diagnostics-timeline.js";
import { isTruthyEnvValue, isVitestRuntimeEnv, logAcceptedEnvOption } from "../infra/env.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { setGatewaySigusr1RestartPolicy, setPreRestartDeferralCheck } from "../infra/restart.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import type { VoiceWakeRoutingConfig } from "../infra/voicewake-routing.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../plugins/current-plugin-metadata-snapshot.js";
import { runGlobalGatewayStopSafely } from "../plugins/hook-runner-global.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
} from "../plugins/runtime.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeSnapshot,
} from "../secrets/runtime.js";
import {
  getInspectableTaskRegistrySummary,
  stopTaskRegistryMaintenance,
} from "../tasks/task-registry.maintenance.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { resolveGatewayAuth } from "./auth.js";
import {
  listChannelPluginConfigTargetIds,
  pluginConfigTargetsChanged,
} from "./plugin-channel-reload-targets.js";
import { createGatewayAuxHandlers } from "./server-aux-handlers.js";
import { createChannelManager } from "./server-channels.js";
import { resolveGatewayControlUiRootState } from "./server-control-ui-root.js";
import { buildGatewayCronService } from "./server-cron.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { createGatewayServerLiveState, type GatewayServerLiveState } from "./server-live-state.js";
import { GATEWAY_EVENTS } from "./server-methods-list.js";
import { loadGatewayModelCatalog } from "./server-model-catalog.js";
import { bootstrapGatewayNetworkRuntime } from "./server-network-runtime.js";
import { createGatewayNodeSessionRuntime } from "./server-node-session-runtime.js";
import { setFallbackGatewayContextResolver } from "./server-plugins.js";
import type { GatewayPluginReloadResult } from "./server-reload-handlers.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { resolveGatewayRuntimeConfig } from "./server-runtime-config.js";
import {
  activateGatewayScheduledServices,
  startGatewayRuntimeServices,
} from "./server-runtime-services.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import { startGatewayEventSubscriptions } from "./server-runtime-subscriptions.js";
import { resolveSessionKeyForRun } from "./server-session-key.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  getRequiredSharedGatewaySessionGeneration,
  type SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import {
  createRuntimeSecretsActivator,
  loadGatewayStartupConfigSnapshot,
  prepareGatewayStartupConfig,
} from "./server-startup-config.js";
import {
  loadGatewayStartupPluginRuntime,
  prepareGatewayPluginBootstrap,
} from "./server-startup-plugins.js";
import { STARTUP_UNAVAILABLE_GATEWAY_METHODS } from "./server-startup-unavailable-methods.js";
import {
  startGatewayEarlyRuntime,
  startGatewayPluginDiscovery,
  startGatewayPostAttachRuntime,
} from "./server-startup.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";
import { attachGatewayWsHandlers } from "./server-ws-runtime.js";
import { createGatewayEventLoopHealthMonitor } from "./server/event-loop-health.js";
import {
  getHealthCache,
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "./server/health-state.js";
import { resolveHookClientIpConfig } from "./server/hook-client-ip-config.js";
import { createReadinessChecker } from "./server/readiness.js";
import { loadGatewayTlsRuntime } from "./server/tls.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

export { __resetModelCatalogCacheForTest } from "./server-model-catalog.js";

ensureOpenClawCliOnPath();

const MAX_MEDIA_TTL_HOURS = 24 * 7;

function resolveMediaCleanupTtlMs(ttlHoursRaw: number): number {
  const ttlHours = Math.min(Math.max(ttlHoursRaw, 1), MAX_MEDIA_TTL_HOURS);
  const ttlMs = ttlHours * 60 * 60_000;
  if (!Number.isFinite(ttlMs) || !Number.isSafeInteger(ttlMs)) {
    throw new Error(`Invalid media.ttlHours: ${String(ttlHoursRaw)}`);
  }
  return ttlMs;
}

const log = createSubsystemLogger("gateway");
const logCanvas = log.child("canvas");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");

let cachedChannelRuntimePromise: Promise<PluginRuntime["channel"]> | null = null;
let cachedStartupChannelRuntimePromise: Promise<ChannelRuntimeSurface> | null = null;

function getChannelRuntime() {
  cachedChannelRuntimePromise ??= import("../plugins/runtime/runtime-channel.js").then(
    ({ createRuntimeChannel }) => createRuntimeChannel(),
  );
  return cachedChannelRuntimePromise;
}

function getStartupChannelRuntime() {
  cachedStartupChannelRuntimePromise ??=
    import("../plugins/runtime/channel-runtime-contexts.js").then(
      ({ createChannelRuntimeContextRegistry }) => ({
        runtimeContexts: createChannelRuntimeContextRegistry(),
      }),
    );
  return cachedStartupChannelRuntimePromise;
}

async function closeMcpLoopbackServerOnDemand(): Promise<void> {
  const { closeMcpLoopbackServer } = await import("./mcp-http.js");
  await closeMcpLoopbackServer();
}

let gatewayCloseModulePromise: Promise<typeof import("./server-close.js")> | null = null;

function loadGatewayCloseModule(): Promise<typeof import("./server-close.js")> {
  gatewayCloseModulePromise ??= import("./server-close.js");
  return gatewayCloseModulePromise;
}

const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logPlugins = log.child("plugins");
const logWsControl = log.child("ws");
const logSecrets = log.child("secrets");
const gatewayRuntime = runtimeForLogger(log);
const canvasRuntime = runtimeForLogger(logCanvas);

function createGatewayStartupTrace() {
  const logEnabled = isTruthyEnvValue(process.env.OPENCLAW_GATEWAY_STARTUP_TRACE);
  let timelineConfig: OpenClawConfig | undefined;
  let eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> | undefined;
  const timelineOptions = () => ({
    ...(timelineConfig ? { config: timelineConfig } : {}),
    env: process.env,
  });
  const eventLoopTimelineEnabled = () =>
    isDiagnosticsTimelineEnabled(timelineOptions()) &&
    isTruthyEnvValue(process.env.OPENCLAW_DIAGNOSTICS_EVENT_LOOP);
  const ensureEventLoopDelay = () => {
    if (eventLoopDelay || (!logEnabled && !eventLoopTimelineEnabled())) {
      return;
    }
    eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
    eventLoopDelay.enable();
  };
  ensureEventLoopDelay();
  const started = performance.now();
  let last = started;
  let spanSequence = 0;
  const formatMetric = (key: string, value: number | string) =>
    `${key}=${typeof value === "number" ? value.toFixed(1) : value}`;
  const mapTimelineName = (name: string) => {
    switch (name) {
      case "config.snapshot":
        return "config.load";
      case "config.auth":
      case "config.final-snapshot":
      case "runtime.config":
        return "config.normalize";
      case "plugins.bootstrap":
        return "plugins.load";
      case "runtime.post-attach":
      case "ready":
        return "gateway.ready";
      default:
        return name;
    }
  };
  const takeEventLoopSample = () => {
    if (!eventLoopDelay) {
      return undefined;
    }
    const sample = {
      p50Ms: eventLoopDelay.percentile(50) / 1_000_000,
      p95Ms: eventLoopDelay.percentile(95) / 1_000_000,
      p99Ms: eventLoopDelay.percentile(99) / 1_000_000,
      maxMs: eventLoopDelay.max / 1_000_000,
    };
    eventLoopDelay.reset();
    return sample;
  };
  const emitEventLoopTimelineSample = (
    activeSpanName: string,
    sample: ReturnType<typeof takeEventLoopSample>,
  ) => {
    if (!eventLoopTimelineEnabled()) {
      return;
    }
    if (!sample) {
      return;
    }
    emitDiagnosticsTimelineEvent(
      {
        type: "eventLoop.sample",
        name: "eventLoop",
        phase: "startup",
        activeSpanName: mapTimelineName(activeSpanName),
        attributes:
          activeSpanName === mapTimelineName(activeSpanName)
            ? undefined
            : { traceName: activeSpanName },
        ...sample,
      },
      timelineOptions(),
    );
  };
  const emit = (
    name: string,
    durationMs: number,
    totalMs: number,
    eventLoopSample: ReturnType<typeof takeEventLoopSample>,
    extras: ReadonlyArray<readonly [string, number | string]> = [],
  ) => {
    if (logEnabled) {
      const metrics = [
        `eventLoopMax=${(eventLoopSample?.maxMs ?? 0).toFixed(1)}ms`,
        ...extras.map(([key, value]) => formatMetric(key, value)),
      ].join(" ");
      log.info(
        `startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms ${metrics}`,
      );
    }
  };
  return {
    setConfig(config: OpenClawConfig) {
      timelineConfig = config;
      ensureEventLoopDelay();
    },
    mark(name: string) {
      const now = performance.now();
      const eventLoopSample = takeEventLoopSample();
      emit(name, now - last, now - started, eventLoopSample);
      emitDiagnosticsTimelineEvent(
        {
          type: "mark",
          name: mapTimelineName(name),
          phase: "startup",
          durationMs: now - started,
          attributes: name === mapTimelineName(name) ? undefined : { traceName: name },
        },
        timelineOptions(),
      );
      emitEventLoopTimelineSample(name, eventLoopSample);
      last = now;
      if (name === "ready") {
        eventLoopDelay?.disable();
      }
    },
    detail(name: string, metrics: ReadonlyArray<readonly [string, number | string]>) {
      const attributes = Object.fromEntries(metrics);
      if (logEnabled) {
        log.info(
          `startup trace: ${name} ${metrics.map(([key, value]) => formatMetric(key, value)).join(" ")}`,
        );
      }
      emitDiagnosticsTimelineEvent(
        {
          type: "mark",
          name: mapTimelineName(name),
          phase: "startup",
          attributes: {
            traceName: name,
            ...attributes,
          },
        },
        timelineOptions(),
      );
    },
    async measure<T>(name: string, run: () => Promise<T> | T): Promise<T> {
      const before = performance.now();
      const spanId = `gateway-startup-${++spanSequence}`;
      emitDiagnosticsTimelineEvent(
        {
          type: "span.start",
          name: mapTimelineName(name),
          phase: "startup",
          spanId,
          attributes: name === mapTimelineName(name) ? undefined : { traceName: name },
        },
        timelineOptions(),
      );
      try {
        const result = await run();
        const now = performance.now();
        emitDiagnosticsTimelineEvent(
          {
            type: "span.end",
            name: mapTimelineName(name),
            phase: "startup",
            spanId,
            durationMs: now - before,
            attributes: name === mapTimelineName(name) ? undefined : { traceName: name },
          },
          timelineOptions(),
        );
        return result;
      } catch (error) {
        const now = performance.now();
        emitDiagnosticsTimelineEvent(
          {
            type: "span.error",
            name: mapTimelineName(name),
            phase: "startup",
            spanId,
            durationMs: now - before,
            attributes: name === mapTimelineName(name) ? undefined : { traceName: name },
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
          },
          timelineOptions(),
        );
        throw error;
      } finally {
        const now = performance.now();
        const eventLoopSample = takeEventLoopSample();
        emit(name, now - before, now - started, eventLoopSample);
        emitEventLoopTimelineSample(name, eventLoopSample);
        last = now;
      }
    },
  };
}

type AuthRateLimitConfig = Parameters<typeof createAuthRateLimiter>[0];

function createGatewayAuthRateLimiters(rateLimitConfig: AuthRateLimitConfig | undefined): {
  rateLimiter?: AuthRateLimiter;
  browserRateLimiter: AuthRateLimiter;
} {
  const rateLimiter = rateLimitConfig ? createAuthRateLimiter(rateLimitConfig) : undefined;
  // Browser-origin WS auth attempts always use loopback-non-exempt throttling.
  const browserRateLimiter = createAuthRateLimiter({
    ...rateLimitConfig,
    exemptLoopback: false,
  });
  return { rateLimiter, browserRateLimiter };
}

export type GatewayServer = {
  close: (opts?: { reason?: string; restartExpectedMs?: number | null }) => Promise<void>;
};

export type GatewayServerOptions = {
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind only to the Tailscale IPv4 address (100.64.0.0/10)
   * - auto: prefer loopback, else LAN
   */
  bind?: import("../config/config.js").GatewayBindMode;
  /**
   * Advanced override for the bind host, bypassing bind resolution.
   * Prefer `bind` unless you really need a specific address.
   */
  host?: string;
  /**
   * If false, do not serve the browser Control UI.
   * Default: config `gateway.controlUi.enabled` (or true when absent).
   */
  controlUiEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/chat/completions`.
   * Default: config `gateway.http.endpoints.chatCompletions.enabled` (or false when absent).
   */
  openAiChatCompletionsEnabled?: boolean;
  /**
   * If false, do not serve `POST /v1/responses` (OpenResponses API).
   * Default: config `gateway.http.endpoints.responses.enabled` (or false when absent).
   */
  openResponsesEnabled?: boolean;
  /**
   * Override gateway auth configuration (merges with config).
   */
  auth?: import("../config/config.js").GatewayAuthConfig;
  /**
   * Override gateway Tailscale exposure configuration (merges with config).
   */
  tailscale?: import("../config/config.js").GatewayTailscaleConfig;
  /**
   * Test-only: allow canvas host startup even when NODE_ENV/VITEST would disable it.
   */
  allowCanvasHostInTests?: boolean;
  /**
   * Test-only: override the setup wizard runner.
   */
  wizardRunner?: (
    opts: import("../commands/onboard-types.js").OnboardOptions,
    runtime: import("../runtime.js").RuntimeEnv,
    prompter: import("../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
  /**
   * Let post-listen sidecars (channels, plugin services) finish in the background.
   * Defaults to false so gateway startup waits until sidecars are ready.
   */
  deferStartupSidecars?: boolean;
  /**
   * Optional startup timestamp used for concise readiness logging.
   */
  startupStartedAt?: number;
  /**
   * Config snapshot already read by the CLI gateway preflight. Passing it avoids
   * reparsing openclaw.json during server startup.
   */
  startupConfigSnapshotRead?: ReadConfigFileSnapshotWithPluginMetadataResult;
};

type SetupWizardRunner = NonNullable<GatewayServerOptions["wizardRunner"]>;

const runDefaultSetupWizard: SetupWizardRunner = async (...args) => {
  const { runSetupWizard } = await import("../wizard/setup.js");
  return runSetupWizard(...args);
};

export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  bootstrapGatewayNetworkRuntime();

  const minimalTestGateway =
    isVitestRuntimeEnv() && process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1";

  // Ensure all default port derivations (browser/canvas) see the actual runtime port.
  process.env.OPENCLAW_GATEWAY_PORT = String(port);
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM",
    description: "raw stream logging enabled",
  });
  logAcceptedEnvOption({
    key: "OPENCLAW_RAW_STREAM_PATH",
    description: "raw stream log path override",
  });
  const startupTrace = createGatewayStartupTrace();

  const startupConfigLoad = await startupTrace.measure("config.snapshot", () =>
    loadGatewayStartupConfigSnapshot({
      minimalTestGateway,
      log,
      measure: (name, run) => startupTrace.measure(name, run),
      ...(opts.startupConfigSnapshotRead
        ? { initialSnapshotRead: opts.startupConfigSnapshotRead }
        : {}),
    }),
  );
  const configSnapshot = startupConfigLoad.snapshot;

  const emitSecretsStateEvent = (
    code: "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED",
    message: string,
    cfg: OpenClawConfig,
  ) => {
    enqueueSystemEvent(`[${code}] ${message}`, {
      sessionKey: resolveMainSessionKey(cfg),
      contextKey: code,
      trusted: false,
    });
  };
  const activateRuntimeSecrets = createRuntimeSecretsActivator({
    logSecrets,
    emitStateEvent: emitSecretsStateEvent,
  });

  let cfgAtStart: OpenClawConfig;
  let startupInternalWriteHash: string | null = null;
  let startupLastGoodSnapshot = configSnapshot;
  const startupActivationSourceConfig = configSnapshot.sourceConfig;
  const startupRuntimeConfig = applyConfigOverrides(configSnapshot.config);
  startupTrace.setConfig(startupRuntimeConfig);
  const authBootstrap = await startupTrace.measure("config.auth", () =>
    prepareGatewayStartupConfig({
      configSnapshot,
      authOverride: opts.auth,
      tailscaleOverride: opts.tailscale,
      activateRuntimeSecrets,
      persistStartupAuth: startupConfigLoad.degradedProviderApi !== true,
    }),
  );
  cfgAtStart = authBootstrap.cfg;
  startupTrace.setConfig(cfgAtStart);
  if (authBootstrap.generatedToken) {
    if (authBootstrap.persistedGeneratedToken) {
      log.info(
        "Gateway auth token was missing. Generated a new token and saved it to config (gateway.auth.token).",
      );
    } else {
      log.warn(
        "Gateway auth token was missing. Generated a runtime token for this startup without changing config; restart will generate a different token. Persist one with `openclaw config set gateway.auth.mode token` and `openclaw config set gateway.auth.token <token>`.",
      );
    }
  }
  const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
  setDiagnosticsEnabledForProcess(diagnosticsEnabled);
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat(undefined, { getConfig: getRuntimeConfig });
  }
  setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(cfgAtStart) });
  setPreRestartDeferralCheck(
    () =>
      getTotalQueueSize() +
      getTotalPendingReplies() +
      getActiveEmbeddedRunCount() +
      getInspectableTaskRegistrySummary().active,
  );
  // Unconditional startup migration: seed gateway.controlUi.allowedOrigins for existing
  // non-loopback installs that upgraded to v2026.2.26+ without required origins.
  const controlUiSeed = minimalTestGateway
    ? { config: cfgAtStart, persistedAllowedOriginsSeed: false }
    : await startupTrace.measure("control-ui.seed", () =>
        maybeSeedControlUiAllowedOriginsAtStartup({
          config: cfgAtStart,
          writeConfig: async (nextConfig) => {
            await replaceConfigFile({
              nextConfig,
              afterWrite: { mode: "auto" },
            });
          },
          log,
          runtimeBind: opts.bind,
          runtimePort: port,
        }),
      );
  cfgAtStart = controlUiSeed.config;
  // Capture the final config hash only after startup writes (plugin auto-enable,
  // auth token generation, control-UI origin seeding) so the config reloader can
  // suppress its own persistence events without rereading config on every boot.
  if (
    startupConfigLoad.wroteConfig ||
    authBootstrap.persistedGeneratedToken ||
    controlUiSeed.persistedAllowedOriginsSeed
  ) {
    const startupSnapshot = await startupTrace.measure("config.final-snapshot", () =>
      readConfigFileSnapshot(),
    );
    startupInternalWriteHash = startupSnapshot.hash ?? null;
    startupLastGoodSnapshot = startupSnapshot;
  }
  setRuntimeConfigSnapshot(cfgAtStart, startupLastGoodSnapshot.sourceConfig);
  const pluginBootstrap = await startupTrace.measure("plugins.bootstrap", () =>
    prepareGatewayPluginBootstrap({
      cfgAtStart,
      activationSourceConfig: startupActivationSourceConfig,
      startupRuntimeConfig,
      pluginMetadataSnapshot: startupConfigLoad.pluginMetadataSnapshot,
      minimalTestGateway,
      log,
      loadRuntimePlugins: false,
    }),
  );
  const {
    gatewayPluginConfigAtStart,
    defaultWorkspaceDir,
    deferredConfiguredChannelPluginIds,
    startupPluginIds,
    pluginLookUpTable,
    baseMethods,
    runtimePluginsLoaded,
  } = pluginBootstrap;
  setCurrentPluginMetadataSnapshot(pluginLookUpTable, { config: gatewayPluginConfigAtStart });
  if (pluginLookUpTable) {
    const metrics = pluginLookUpTable.metrics;
    startupTrace.detail("plugins.lookup-table", [
      ["registrySnapshotMs", metrics.registrySnapshotMs],
      ["manifestRegistryMs", metrics.manifestRegistryMs],
      ["startupPlanMs", metrics.startupPlanMs],
      ["ownerMapsMs", metrics.ownerMapsMs],
      ["totalMs", metrics.totalMs],
      ["indexPlugins", String(metrics.indexPluginCount)],
      ["manifestPlugins", String(metrics.manifestPluginCount)],
      ["startupPlugins", String(metrics.startupPluginCount)],
      ["deferredChannelPlugins", String(metrics.deferredChannelPluginCount)],
    ]);
  }
  let { pluginRegistry, baseGatewayMethods } = pluginBootstrap;
  const channelLogs = Object.fromEntries(
    listChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]),
  ) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
  const channelRuntimeEnvs = Object.fromEntries(
    Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]),
  ) as unknown as Record<ChannelId, RuntimeEnv>;
  const listActiveGatewayMethods = (nextBaseGatewayMethods: string[]) =>
    Array.from(
      new Set([
        ...nextBaseGatewayMethods,
        ...listChannelPlugins().flatMap((plugin) => plugin.gatewayMethods ?? []),
      ]),
    );
  const runtimeConfig = await startupTrace.measure("runtime.config", () =>
    resolveGatewayRuntimeConfig({
      cfg: cfgAtStart,
      port,
      bind: opts.bind,
      host: opts.host,
      controlUiEnabled: opts.controlUiEnabled,
      openAiChatCompletionsEnabled: opts.openAiChatCompletionsEnabled,
      openResponsesEnabled: opts.openResponsesEnabled,
      auth: opts.auth,
      tailscale: opts.tailscale,
    }),
  );
  const {
    bindHost,
    controlUiEnabled,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    controlUiBasePath,
    controlUiRoot: controlUiRootOverride,
    resolvedAuth,
    tailscaleConfig,
    tailscaleMode,
  } = runtimeConfig;
  const getResolvedAuth = () =>
    resolveGatewayAuth({
      authConfig:
        getActiveSecretsRuntimeSnapshot()?.config.gateway?.auth ?? getRuntimeConfig().gateway?.auth,
      authOverride: opts.auth,
      env: process.env,
      tailscaleMode,
    });
  const resolveSharedGatewaySessionGenerationForConfig = (config: OpenClawConfig) =>
    resolveSharedGatewaySessionGeneration(
      resolveGatewayAuth({
        authConfig: config.gateway?.auth,
        authOverride: opts.auth,
        env: process.env,
        tailscaleMode,
      }),
    );
  const resolveCurrentSharedGatewaySessionGeneration = () =>
    resolveSharedGatewaySessionGeneration(getResolvedAuth());
  const resolveSharedGatewaySessionGenerationForRuntimeSnapshot = () =>
    resolveSharedGatewaySessionGeneration(
      resolveGatewayAuth({
        authConfig: getRuntimeConfig().gateway?.auth,
        authOverride: opts.auth,
        env: process.env,
        tailscaleMode,
      }),
    );
  const sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState = {
    current: resolveCurrentSharedGatewaySessionGeneration(),
    required: null,
  };
  const preauthHandshakeTimeoutMs =
    cfgAtStart.gateway?.handshakeTimeoutMs ?? getRuntimeConfig().gateway?.handshakeTimeoutMs;
  const initialHooksConfig = runtimeConfig.hooksConfig;
  const initialHookClientIpConfig = resolveHookClientIpConfig(cfgAtStart);
  const canvasHostEnabled = runtimeConfig.canvasHostEnabled;

  // Create auth rate limiters used by connect/auth flows.
  const rateLimitConfig = cfgAtStart.gateway?.auth?.rateLimit;
  const { rateLimiter: authRateLimiter, browserRateLimiter: browserAuthRateLimiter } =
    createGatewayAuthRateLimiters(rateLimitConfig);

  const controlUiRootState = await startupTrace.measure("control-ui.root", () =>
    resolveGatewayControlUiRootState({
      controlUiRootOverride,
      controlUiEnabled,
      gatewayRuntime,
      log,
    }),
  );

  const wizardRunner = opts.wizardRunner ?? runDefaultSetupWizard;
  const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();

  const deps = createDefaultDeps();
  let runtimeState: GatewayServerLiveState | null = null;
  let canvasHostServer: CanvasHostServer | null = null;
  const gatewayTls = await startupTrace.measure("tls.runtime", () =>
    loadGatewayTlsRuntime(cfgAtStart.gateway?.tls, log.child("tls")),
  );
  if (cfgAtStart.gateway?.tls?.enabled && !gatewayTls.enabled) {
    throw new Error(gatewayTls.error ?? "gateway tls: failed to enable");
  }
  const serverStartedAt = Date.now();
  const readinessEventLoopHealth = createGatewayEventLoopHealthMonitor();
  let startupSidecarsReady = minimalTestGateway;
  let startupPendingReason = "startup-sidecars";
  const channelManager = createChannelManager({
    getRuntimeConfig: () =>
      applyPluginAutoEnable({
        config: getRuntimeConfig(),
        env: process.env,
      }).config,
    channelLogs,
    channelRuntimeEnvs,
    resolveChannelRuntime: getChannelRuntime,
    resolveStartupChannelRuntime: getStartupChannelRuntime,
    startupTrace,
  });
  const getReadiness = createReadinessChecker({
    channelManager,
    startedAt: serverStartedAt,
    getStartupPending: () => !startupSidecarsReady,
    getStartupPendingReason: () => startupPendingReason,
    getEventLoopHealth: readinessEventLoopHealth.snapshot,
    shouldSkipChannelReadiness: () =>
      isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
      isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS),
  });
  log.info("starting HTTP server...");
  const {
    canvasHost,
    releasePluginRouteRegistry,
    httpServer,
    httpServers,
    httpBindHosts,
    startListening,
    wss,
    preauthConnectionBudget,
    clients,
    broadcast,
    broadcastToConnIds,
    agentRunSeq,
    dedupe,
    chatRunState,
    chatRunBuffers,
    chatDeltaSentAt,
    chatDeltaLastBroadcastLen,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    toolEventRecipients,
  } = await startupTrace.measure("runtime.state", () =>
    createGatewayRuntimeState({
      cfg: cfgAtStart,
      bindHost,
      port,
      controlUiEnabled,
      controlUiBasePath,
      controlUiRoot: controlUiRootState,
      openAiChatCompletionsEnabled,
      openAiChatCompletionsConfig,
      openResponsesEnabled,
      openResponsesConfig,
      strictTransportSecurityHeader,
      resolvedAuth,
      rateLimiter: authRateLimiter,
      gatewayTls,
      getResolvedAuth,
      hooksConfig: () => runtimeState?.hooksConfig ?? initialHooksConfig,
      getHookClientIpConfig: () => runtimeState?.hookClientIpConfig ?? initialHookClientIpConfig,
      pluginRegistry,
      pinChannelRegistry: !minimalTestGateway,
      deps,
      canvasRuntime,
      canvasHostEnabled,
      allowCanvasHostInTests: opts.allowCanvasHostInTests,
      logCanvas,
      log,
      logHooks,
      logPlugins,
      getReadiness,
    }),
  );
  const {
    nodeRegistry,
    nodePresenceTimers,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe,
    nodeUnsubscribe,
    nodeUnsubscribeAll,
    broadcastVoiceWakeChanged,
    hasMobileNodeConnected,
  } = createGatewayNodeSessionRuntime({ broadcast });
  applyGatewayLaneConcurrency(cfgAtStart);

  runtimeState = createGatewayServerLiveState({
    hooksConfig: initialHooksConfig,
    hookClientIpConfig: initialHookClientIpConfig,
    cronState: buildGatewayCronService({
      cfg: cfgAtStart,
      deps,
      broadcast,
    }),
    gatewayMethods: listActiveGatewayMethods(baseGatewayMethods),
  });
  deps.cron = runtimeState.cronState.cron;

  let closePreludeStarted = false;
  const runClosePrelude = async () => {
    closePreludeStarted = true;
    clearCurrentPluginMetadataSnapshot();
    const { runGatewayClosePrelude } = await loadGatewayCloseModule();
    await runGatewayClosePrelude({
      ...(diagnosticsEnabled ? { stopDiagnostics: stopDiagnosticHeartbeat } : {}),
      clearSkillsRefreshTimer: () => {
        if (!runtimeState?.skillsRefreshTimer) {
          return;
        }
        clearTimeout(runtimeState.skillsRefreshTimer);
        runtimeState.skillsRefreshTimer = null;
      },
      skillsChangeUnsub: runtimeState.skillsChangeUnsub,
      ...(authRateLimiter ? { disposeAuthRateLimiter: () => authRateLimiter.dispose() } : {}),
      disposeBrowserAuthRateLimiter: () => browserAuthRateLimiter.dispose(),
      stopModelPricingRefresh: runtimeState.stopModelPricingRefresh,
      stopChannelHealthMonitor: () => runtimeState?.channelHealthMonitor?.stop(),
      stopReadinessEventLoopHealth: readinessEventLoopHealth.stop,
      clearSecretsRuntimeSnapshot,
      closeMcpServer: closeMcpLoopbackServerOnDemand,
    });
  };
  const { getRuntimeSnapshot, startChannels, startChannel, stopChannel, markChannelLoggedOut } =
    channelManager;
  const refreshGatewayHealthSnapshotWithRuntime: typeof refreshGatewayHealthSnapshot = (opts) =>
    refreshGatewayHealthSnapshot({
      ...opts,
      getRuntimeSnapshot,
      getEventLoopHealth: readinessEventLoopHealth.snapshot,
    });
  const createCloseHandler =
    () => async (opts?: { reason?: string; restartExpectedMs?: number | null }) => {
      const { createGatewayCloseHandler } = await loadGatewayCloseModule();
      await createGatewayCloseHandler({
        bonjourStop: runtimeState.bonjourStop,
        tailscaleCleanup: runtimeState.tailscaleCleanup,
        canvasHost,
        canvasHostServer,
        releasePluginRouteRegistry,
        stopChannel,
        pluginServices: runtimeState.pluginServices,
        cron: runtimeState.cronState.cron,
        heartbeatRunner: runtimeState.heartbeatRunner,
        updateCheckStop: runtimeState.stopGatewayUpdateCheck,
        stopTaskRegistryMaintenance,
        nodePresenceTimers,
        broadcast,
        tickInterval: runtimeState.tickInterval,
        healthInterval: runtimeState.healthInterval,
        dedupeCleanup: runtimeState.dedupeCleanup,
        mediaCleanup: runtimeState.mediaCleanup,
        agentUnsub: runtimeState.agentUnsub,
        heartbeatUnsub: runtimeState.heartbeatUnsub,
        transcriptUnsub: runtimeState.transcriptUnsub,
        lifecycleUnsub: runtimeState.lifecycleUnsub,
        chatRunState,
        clients,
        configReloader: runtimeState.configReloader,
        wss,
        httpServer,
        httpServers,
      })(opts);
    };
  let clearFallbackGatewayContextForServer = () => {};
  const closeOnStartupFailure = async () => {
    try {
      await runClosePrelude();
      await createCloseHandler()({ reason: "gateway startup failed" });
    } finally {
      clearFallbackGatewayContextForServer();
    }
  };
  const broadcastVoiceWakeRoutingChanged = (config: VoiceWakeRoutingConfig) => {
    broadcast("voicewake.routing.changed", { config }, { dropIfSlow: true });
  };

  try {
    const earlyRuntime = await startupTrace.measure("runtime.early", () =>
      startGatewayEarlyRuntime({
        minimalTestGateway,
        cfgAtStart,
        port,
        gatewayTls,
        tailscaleMode,
        log,
        logDiscovery,
        nodeRegistry,
        pluginRegistry,
        broadcast,
        nodeSendToAllSubscribed,
        getPresenceVersion,
        getHealthVersion,
        refreshGatewayHealthSnapshot: refreshGatewayHealthSnapshotWithRuntime,
        logHealth,
        dedupe,
        chatAbortControllers,
        chatRunState,
        chatRunBuffers,
        chatDeltaSentAt,
        chatDeltaLastBroadcastLen,
        removeChatRun,
        agentRunSeq,
        nodeSendToSession,
        ...(typeof cfgAtStart.media?.ttlHours === "number"
          ? { mediaCleanupTtlMs: resolveMediaCleanupTtlMs(cfgAtStart.media.ttlHours) }
          : {}),
        skillsRefreshDelayMs: runtimeState.skillsRefreshDelayMs,
        getSkillsRefreshTimer: () => runtimeState.skillsRefreshTimer,
        setSkillsRefreshTimer: (timer) => {
          runtimeState.skillsRefreshTimer = timer;
        },
        getRuntimeConfig,
      }),
    );
    runtimeState.bonjourStop = earlyRuntime.bonjourStop;
    runtimeState.skillsChangeUnsub = earlyRuntime.skillsChangeUnsub;
    if (earlyRuntime.maintenance) {
      runtimeState.tickInterval = earlyRuntime.maintenance.tickInterval;
      runtimeState.healthInterval = earlyRuntime.maintenance.healthInterval;
      runtimeState.dedupeCleanup = earlyRuntime.maintenance.dedupeCleanup;
      runtimeState.mediaCleanup = earlyRuntime.maintenance.mediaCleanup;
    }

    Object.assign(
      runtimeState,
      startGatewayEventSubscriptions({
        broadcast,
        broadcastToConnIds,
        nodeSendToSession,
        agentRunSeq,
        chatRunState,
        resolveSessionKeyForRun,
        clearAgentRunContext,
        toolEventRecipients,
        sessionEventSubscribers,
        sessionMessageSubscribers,
        chatAbortControllers,
      }),
    );

    Object.assign(
      runtimeState,
      startGatewayRuntimeServices({
        minimalTestGateway,
        cfgAtStart,
        channelManager,
        log,
      }),
    );

    const { execApprovalManager, pluginApprovalManager, extraHandlers } = createGatewayAuxHandlers({
      log,
      activateRuntimeSecrets,
      sharedGatewaySessionGenerationState,
      resolveSharedGatewaySessionGenerationForConfig,
      clients,
      startChannel,
      stopChannel,
      logChannels,
    });
    const attachedGatewayExtraHandlers = {
      ...pluginRegistry.gatewayHandlers,
      ...extraHandlers,
    };
    let attachedPluginGatewayHandlerKeys = new Set(Object.keys(pluginRegistry.gatewayHandlers));
    const replaceAttachedPluginRuntime = (loaded: {
      pluginRegistry: typeof pluginRegistry;
      gatewayMethods: string[];
    }) => {
      pluginRegistry = loaded.pluginRegistry;
      baseGatewayMethods = loaded.gatewayMethods;
      runtimeState.gatewayMethods.splice(
        0,
        runtimeState.gatewayMethods.length,
        ...listActiveGatewayMethods(baseGatewayMethods),
      );
      for (const key of attachedPluginGatewayHandlerKeys) {
        delete attachedGatewayExtraHandlers[key];
      }
      Object.assign(attachedGatewayExtraHandlers, pluginRegistry.gatewayHandlers);
      attachedPluginGatewayHandlerKeys = new Set(Object.keys(pluginRegistry.gatewayHandlers));
      pinActivePluginHttpRouteRegistry(pluginRegistry);
      pinActivePluginChannelRegistry(pluginRegistry);
    };
    const refreshAttachedGatewayDiscovery = async (nextPluginRegistry: typeof pluginRegistry) => {
      if (minimalTestGateway) {
        return;
      }
      try {
        const stopPreviousDiscovery = runtimeState.bonjourStop;
        runtimeState.bonjourStop = null;
        if (stopPreviousDiscovery) {
          try {
            await stopPreviousDiscovery();
          } catch (err) {
            logDiscovery.warn(
              `gateway discovery stop failed before plugin refresh: ${String(err)}`,
            );
          }
        }
        runtimeState.bonjourStop = await startGatewayPluginDiscovery({
          minimalTestGateway,
          cfgAtStart,
          port,
          gatewayTls,
          tailscaleMode,
          logDiscovery,
          pluginRegistry: nextPluginRegistry,
        });
      } catch (err) {
        logDiscovery.warn(`gateway discovery refresh failed after plugin load: ${String(err)}`);
      }
    };
    const listAttachedChannelConfigTargets = () =>
      new Map(
        listChannelPlugins().map((plugin) => [
          plugin.id,
          listChannelPluginConfigTargetIds({
            channelId: plugin.id,
            pluginId: getLoadedChannelPluginEntryById(plugin.id)?.pluginId,
            aliases: plugin.meta.aliases,
          }),
        ]),
      );
    const reloadAttachedGatewayPlugins = async (params: {
      nextConfig: OpenClawConfig;
      changedPaths: readonly string[];
      beforeReplace: (channels: ReadonlySet<ChannelId>) => Promise<void>;
    }): Promise<GatewayPluginReloadResult> => {
      const beforeChannelTargets = listAttachedChannelConfigTargets();
      const beforeChannelIds = new Set(beforeChannelTargets.keys());
      const [{ loadPluginLookUpTable }, { prepareGatewayPluginLoad }, { startPluginServices }] =
        await Promise.all([
          import("../plugins/plugin-lookup-table.js"),
          import("./server-plugin-bootstrap.js"),
          import("../plugins/services.js"),
        ]);
      const nextPluginLookUpTable = loadPluginLookUpTable({
        config: params.nextConfig,
        workspaceDir: defaultWorkspaceDir,
        env: process.env,
        activationSourceConfig: params.nextConfig,
      });
      const nextStartupPluginIds = new Set(nextPluginLookUpTable.startup.pluginIds);
      const nextStartupChannelIds = new Set<ChannelId>();
      for (const plugin of nextPluginLookUpTable.manifestRegistry.plugins) {
        if (!nextStartupPluginIds.has(plugin.id)) {
          continue;
        }
        if (plugin.channels.length === 0) {
          nextStartupChannelIds.add(plugin.id);
          continue;
        }
        for (const channelId of plugin.channels) {
          nextStartupChannelIds.add(channelId);
        }
      }
      const channelsToStopBeforeReplace = new Set<ChannelId>();
      for (const channelId of beforeChannelIds) {
        const targetIds = beforeChannelTargets.get(channelId) ?? new Set([channelId]);
        if (
          !nextStartupChannelIds.has(channelId) ||
          pluginConfigTargetsChanged(targetIds, params.changedPaths)
        ) {
          channelsToStopBeforeReplace.add(channelId);
        }
      }
      await params.beforeReplace(channelsToStopBeforeReplace);
      setCurrentPluginMetadataSnapshot(nextPluginLookUpTable, { config: params.nextConfig });
      const loaded = prepareGatewayPluginLoad({
        cfg: params.nextConfig,
        workspaceDir: defaultWorkspaceDir,
        log,
        coreGatewayMethodNames: baseMethods,
        baseMethods,
        pluginLookUpTable: nextPluginLookUpTable,
      });
      const previousPluginServices = runtimeState.pluginServices;
      runtimeState.pluginServices = null;
      if (previousPluginServices) {
        await previousPluginServices.stop().catch((err) => {
          log.warn(`plugin services stop failed during reload: ${String(err)}`);
        });
      }
      replaceAttachedPluginRuntime(loaded);
      await refreshAttachedGatewayDiscovery(loaded.pluginRegistry);
      try {
        runtimeState.pluginServices = await startPluginServices({
          registry: loaded.pluginRegistry,
          config: params.nextConfig,
          workspaceDir: defaultWorkspaceDir,
        });
      } catch (err) {
        log.warn(`plugin services failed to start after reload: ${String(err)}`);
      }
      const afterChannelTargets = listAttachedChannelConfigTargets();
      const afterChannelIds = new Set(afterChannelTargets.keys());
      const restartChannels = new Set<ChannelId>();
      for (const channelId of new Set([...beforeChannelIds, ...afterChannelIds])) {
        const targetIds =
          afterChannelTargets.get(channelId) ??
          beforeChannelTargets.get(channelId) ??
          new Set([channelId]);
        if (
          afterChannelIds.has(channelId) &&
          (beforeChannelIds.has(channelId) !== afterChannelIds.has(channelId) ||
            pluginConfigTargetsChanged(targetIds, params.changedPaths))
        ) {
          restartChannels.add(channelId);
        }
      }
      return {
        restartChannels,
        activeChannels: afterChannelIds,
      };
    };

    const canvasHostServerPort = (canvasHostServer as CanvasHostServer | null)?.port;

    const unavailableGatewayMethods = new Set<string>(
      minimalTestGateway ? [] : STARTUP_UNAVAILABLE_GATEWAY_METHODS,
    );
    const gatewayRequestContext = createGatewayRequestContext({
      deps,
      runtimeState,
      getRuntimeConfig,
      execApprovalManager,
      pluginApprovalManager,
      loadGatewayModelCatalog,
      getHealthCache,
      refreshHealthSnapshot: refreshGatewayHealthSnapshotWithRuntime,
      logHealth,
      logGateway: log,
      incrementPresenceVersion,
      getHealthVersion,
      broadcast,
      broadcastToConnIds,
      nodeSendToSession,
      nodeSendToAllSubscribed,
      nodeSubscribe,
      nodeUnsubscribe,
      nodeUnsubscribeAll,
      hasConnectedMobileNode: hasMobileNodeConnected,
      clients,
      enforceSharedGatewayAuthGenerationForConfigWrite: (nextConfig: OpenClawConfig) => {
        enforceSharedGatewaySessionGenerationForConfigWrite({
          state: sharedGatewaySessionGenerationState,
          nextConfig,
          resolveRuntimeSnapshotGeneration: resolveSharedGatewaySessionGenerationForRuntimeSnapshot,
          clients,
        });
      },
      nodeRegistry,
      agentRunSeq,
      chatAbortControllers,
      chatAbortedRuns: chatRunState.abortedRuns,
      chatRunBuffers: chatRunState.buffers,
      chatDeltaSentAt: chatRunState.deltaSentAt,
      chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
      addChatRun,
      removeChatRun,
      subscribeSessionEvents: sessionEventSubscribers.subscribe,
      unsubscribeSessionEvents: sessionEventSubscribers.unsubscribe,
      subscribeSessionMessageEvents: sessionMessageSubscribers.subscribe,
      unsubscribeSessionMessageEvents: sessionMessageSubscribers.unsubscribe,
      unsubscribeAllSessionEvents: (connId: string) => {
        sessionEventSubscribers.unsubscribe(connId);
        sessionMessageSubscribers.unsubscribeAll(connId);
      },
      getSessionEventSubscriberConnIds: sessionEventSubscribers.getAll,
      registerToolEventRecipient: toolEventRecipients.add,
      dedupe,
      wizardSessions,
      findRunningWizard,
      purgeWizardSession,
      getRuntimeSnapshot,
      getEventLoopHealth: readinessEventLoopHealth.snapshot,
      startChannel,
      stopChannel,
      markChannelLoggedOut,
      wizardRunner,
      broadcastVoiceWakeChanged,
      unavailableGatewayMethods,
      broadcastVoiceWakeRoutingChanged,
    });

    const fallbackGatewayContextCleanup: unknown = setFallbackGatewayContextResolver(
      () => gatewayRequestContext,
    );
    clearFallbackGatewayContextForServer =
      typeof fallbackGatewayContextCleanup === "function"
        ? () => {
            fallbackGatewayContextCleanup();
          }
        : () => {};

    if (!minimalTestGateway) {
      if (runtimePluginsLoaded && deferredConfiguredChannelPluginIds.length > 0) {
        const { reloadDeferredGatewayPlugins } = await import("./server-plugin-bootstrap.js");
        const loaded = reloadDeferredGatewayPlugins({
          cfg: gatewayPluginConfigAtStart,
          activationSourceConfig: startupActivationSourceConfig,
          workspaceDir: defaultWorkspaceDir,
          log,
          coreGatewayMethodNames: baseMethods,
          baseMethods,
          pluginIds: startupPluginIds,
          pluginLookUpTable,
          logDiagnostics: false,
        });
        replaceAttachedPluginRuntime(loaded);
        await refreshAttachedGatewayDiscovery(loaded.pluginRegistry);
      }
    }

    attachGatewayWsHandlers({
      wss,
      clients,
      preauthConnectionBudget,
      port,
      gatewayHost: bindHost ?? undefined,
      canvasHostEnabled: Boolean(canvasHost),
      canvasHostServerPort,
      resolvedAuth,
      getResolvedAuth,
      getRequiredSharedGatewaySessionGeneration: () =>
        getRequiredSharedGatewaySessionGeneration(sharedGatewaySessionGenerationState),
      rateLimiter: authRateLimiter,
      browserRateLimiter: browserAuthRateLimiter,
      preauthHandshakeTimeoutMs,
      isStartupPending: () => !startupSidecarsReady,
      gatewayMethods: runtimeState.gatewayMethods,
      events: GATEWAY_EVENTS,
      logGateway: log,
      logHealth,
      logWsControl,
      extraHandlers: attachedGatewayExtraHandlers,
      broadcast,
      context: gatewayRequestContext,
    });
    await startListening();
    startupTrace.mark("http.bound");
    const sessionDeliveryRecoveryMaxEnqueuedAt = Date.now();
    let postAttachRuntimeReturned = false;
    let scheduledServicesActivated = false;
    const activateScheduledServicesWhenReady = () => {
      if (
        closePreludeStarted ||
        !postAttachRuntimeReturned ||
        !startupSidecarsReady ||
        scheduledServicesActivated
      ) {
        return;
      }
      const activated = activateGatewayScheduledServices({
        minimalTestGateway,
        cfgAtStart,
        deps,
        sessionDeliveryRecoveryMaxEnqueuedAt,
        cron: runtimeState.cronState.cron,
        logCron,
        log,
        pluginLookUpTable,
      });
      scheduledServicesActivated = true;
      runtimeState.heartbeatRunner = activated.heartbeatRunner;
      runtimeState.stopModelPricingRefresh = activated.stopModelPricingRefresh;
    };
    ({
      stopGatewayUpdateCheck: runtimeState.stopGatewayUpdateCheck,
      tailscaleCleanup: runtimeState.tailscaleCleanup,
      pluginServices: runtimeState.pluginServices,
    } = await startupTrace.measure("runtime.post-attach", () =>
      startGatewayPostAttachRuntime({
        minimalTestGateway,
        cfgAtStart,
        bindHost,
        bindHosts: httpBindHosts,
        port,
        tlsEnabled: gatewayTls.enabled,
        log,
        isNixMode,
        startupStartedAt: opts.startupStartedAt,
        broadcast,
        tailscaleMode,
        resetOnExit: tailscaleConfig.resetOnExit ?? false,
        controlUiBasePath,
        logTailscale,
        gatewayPluginConfigAtStart,
        pluginRegistry,
        defaultWorkspaceDir,
        deps,
        startChannels,
        logHooks,
        logChannels,
        unavailableGatewayMethods,
        loadStartupPlugins: runtimePluginsLoaded
          ? undefined
          : () =>
              loadGatewayStartupPluginRuntime({
                cfg: gatewayPluginConfigAtStart,
                activationSourceConfig: startupActivationSourceConfig,
                workspaceDir: defaultWorkspaceDir,
                log,
                baseMethods,
                startupPluginIds,
                pluginLookUpTable,
              }),
        onStartupPluginsLoading: () => {
          startupPendingReason = "startup-sidecars";
        },
        onStartupPluginsLoaded: async (loaded) => {
          replaceAttachedPluginRuntime(loaded);
          startupPendingReason = "startup-sidecars";
          await refreshAttachedGatewayDiscovery(loaded.pluginRegistry);
        },
        getCronService: () =>
          runtimeState?.cronState.cron as PluginHookGatewayCronService | undefined,
        onPluginServices: (pluginServices) => {
          runtimeState.pluginServices = pluginServices;
        },
        onSidecarsReady: () => {
          startupSidecarsReady = true;
          activateScheduledServicesWhenReady();
        },
        startupTrace,
        deferSidecars: opts.deferStartupSidecars === true,
      }),
    ));
    startupTrace.mark("ready");
    postAttachRuntimeReturned = true;
    activateScheduledServicesWhenReady();

    const { startManagedGatewayConfigReloader } = await import("./server-reload-handlers.js");
    runtimeState.configReloader = startManagedGatewayConfigReloader({
      minimalTestGateway,
      initialConfig: cfgAtStart,
      initialCompareConfig: startupLastGoodSnapshot.sourceConfig,
      initialInternalWriteHash: startupInternalWriteHash,
      watchPath: configSnapshot.path,
      readSnapshot: readConfigFileSnapshot,
      recoverSnapshot: recoverConfigFromLastKnownGood,
      promoteSnapshot: promoteConfigSnapshotToLastKnownGood,
      subscribeToWrites: registerConfigWriteListener,
      deps,
      broadcast,
      getState: () => ({
        hooksConfig: runtimeState.hooksConfig,
        hookClientIpConfig: runtimeState.hookClientIpConfig,
        heartbeatRunner: runtimeState.heartbeatRunner,
        cronState: runtimeState.cronState,
        channelHealthMonitor: runtimeState.channelHealthMonitor,
      }),
      setState: (nextState) => {
        runtimeState.hooksConfig = nextState.hooksConfig;
        runtimeState.hookClientIpConfig = nextState.hookClientIpConfig;
        runtimeState.heartbeatRunner = nextState.heartbeatRunner;
        runtimeState.cronState = nextState.cronState;
        deps.cron = runtimeState.cronState.cron;
        runtimeState.channelHealthMonitor = nextState.channelHealthMonitor;
      },
      startChannel,
      stopChannel,
      reloadPlugins: reloadAttachedGatewayPlugins,
      logHooks,
      logChannels,
      logCron,
      logReload,
      channelManager,
      activateRuntimeSecrets,
      resolveSharedGatewaySessionGenerationForConfig,
      sharedGatewaySessionGenerationState,
      clients,
    });
    await promoteConfigSnapshotToLastKnownGood(startupLastGoodSnapshot).catch((err) => {
      log.warn(`gateway: failed to promote config last-known-good backup: ${String(err)}`);
    });
  } catch (err) {
    await closeOnStartupFailure();
    throw err;
  }

  const close = createCloseHandler();

  return {
    close: async (opts) => {
      try {
        // Run gateway_stop plugin hook before shutdown
        await runGlobalGatewayStopSafely({
          event: { reason: opts?.reason ?? "gateway stopping" },
          ctx: { port },
          onError: (err) => log.warn(`gateway_stop hook failed: ${String(err)}`),
        });
        await runClosePrelude();
        await close(opts);
      } finally {
        clearFallbackGatewayContextForServer();
      }
    },
  };
}
