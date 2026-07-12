import type { IncomingMessage, ServerResponse } from "node:http";
// Gateway server implementation builds runtime state, method registries, HTTP
// and WebSocket surfaces, config reload hooks, and graceful restart/shutdown.
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { WORKER_PROTOCOL_FEATURES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { getActiveBackgroundExecSessionCount } from "../agents/bash-process-registry.js";
import {
  getActiveEmbeddedRunCount,
  resolveActiveEmbeddedRunSessionId,
} from "../agents/embedded-agent-runner/run-state.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import {
  getLoadedChannelPluginEntryById,
  listLoadedChannelPlugins,
} from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { createDefaultDeps } from "../cli/deps.js";
import { isRestartEnabled } from "../config/commands.flags.js";
import {
  getRuntimeConfig,
  promoteConfigSnapshotToLastKnownGood,
  readConfigFileSnapshot,
  registerConfigWriteListener,
  setRuntimeConfigSnapshot,
  type ReadConfigFileSnapshotWithPluginMetadataResult,
} from "../config/io.js";
import { isNixMode, normalizeStateDirEnv } from "../config/paths.js";
import { applyConfigOverrides } from "../config/runtime-overrides.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getActiveCronJobCount } from "../cron/active-jobs.js";
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
import { readGatewayRestartHandoffSync } from "../infra/restart-handoff.js";
import { setGatewaySigusr1RestartPolicy, setPreRestartDeferralCheck } from "../infra/restart.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { upsertPresence } from "../infra/system-presence.js";
import type { VoiceWakeRoutingConfig } from "../infra/voicewake-routing.js";
import { withDiagnosticPhase } from "../logging/diagnostic-phase.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "../plugins/installed-plugin-index-records.js";
import { cleanupRetainedManagedNpmInstallGenerations } from "../plugins/managed-npm-retention.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  pinActivePluginSessionExtensionRegistry,
} from "../plugins/runtime.js";
import { resolveWorkerProvider } from "../plugins/worker-provider-registry.js";
import { getTotalQueueSize, isGatewayDraining } from "../process/command-queue.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeEnv,
  getActiveSecretsRuntimeConfigSnapshot,
} from "../secrets/runtime-state.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import { recordRemoteNodeInfo, removeRemoteNodeInfo } from "../skills/runtime/remote.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { resolveGatewayAuth } from "./auth.js";
import type { RestartRecoveryCandidate } from "./chat-abort.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import {
  STARTUP_UNAVAILABLE_GATEWAY_METHODS,
  listCoreGatewayMethodNames,
} from "./methods/core-descriptors.js";
import {
  createCoreGatewayMethodDescriptors,
  createGatewayMethodDescriptorsFromHandlers,
  createGatewayMethodRegistry,
  createPluginGatewayMethodDescriptors,
  isCoreGatewayMethodClassified,
  type GatewayMethodRegistry,
} from "./methods/registry.js";
import { isLoopbackHost } from "./net.js";
import { createNodeReapprovalCoordinator } from "./node-reapproval-coordinator.js";
import { resolveGatewayStartupPluginActivationConfig } from "./plugin-activation-runtime-config.js";
import {
  listChannelPluginConfigTargetIds,
  pluginConfigTargetsChanged,
} from "./plugin-channel-reload-targets.js";
import {
  collectGatewayProcessMemoryUsageMb,
  finishGatewayRestartTrace,
  recordGatewayRestartTraceDetail,
  recordGatewayRestartTraceSpan,
  resumeGatewayRestartTraceFromEnv,
  resumeGatewayRestartTraceFromHandoff,
} from "./restart-trace.js";
import { resolveGatewayPluginConfig } from "./runtime-plugin-config.js";
import type { ChannelAutostartSuppression } from "./server-channels.js";
import { resolveGatewayControlUiRootState } from "./server-control-ui-root.js";
import { createLazyGatewayCronState } from "./server-cron-lazy.js";
import { createGatewayCronReconciliation } from "./server-cron-reconciled.js";
import { applyGatewayLaneConcurrency } from "./server-lanes.js";
import { createGatewayServerLiveState, type GatewayServerLiveState } from "./server-live-state.js";
import { GATEWAY_EVENTS } from "./server-methods-list.js";
import { clearNodeWakeState } from "./server-methods/nodes-wake-state.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./server-methods/types.js";
import { setFallbackGatewayContextResolver } from "./server-plugins.js";
import type { GatewayPluginReloadResult } from "./server-reload-handlers.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import {
  enforceSharedGatewaySessionGenerationForConfigWrite,
  getRequiredSharedGatewaySessionGeneration,
  type SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import type { GatewaySidecarStartupMode } from "./server-sidecar-startup-mode.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";
import { createGatewayEventLoopHealthMonitor } from "./server/event-loop-health.js";
import {
  getHealthCache,
  getHealthVersion,
  getPresenceVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "./server/health-state.js";
import { resolveHookClientIpConfig } from "./server/hook-client-ip-config.js";
import { broadcastPresenceSnapshot } from "./server/presence-events.js";
import { createReadinessChecker } from "./server/readiness.js";
import { loadGatewayTlsRuntime } from "./server/tls.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";
import type { WorkerBundleProducer, WorkerNpmArtifact } from "./worker-environments/bundle.js";
import { createWorkerEnvironmentService } from "./worker-environments/service.js";
import { createWorkerEnvironmentStore } from "./worker-environments/store.js";
import { createWorkerTranscriptCommitter } from "./worker-environments/transcript-commit.js";

type LoadGatewayModelCatalog = typeof import("./server-model-catalog.js").loadGatewayModelCatalog;
type LoadGatewayModelCatalogSnapshot =
  typeof import("./server-model-catalog.js").loadGatewayModelCatalogSnapshot;

const loadGatewayModelCatalogModule = createLazyRuntimeModule(
  () => import("./server-model-catalog.js"),
);
const loadWorkerEnvironmentRuntimeModule = createLazyRuntimeModule(
  () => import("./worker-environments/runtime.js"),
);
const loadWorkerTunnelRuntimeModule = createLazyRuntimeModule(
  () => import("./worker-environments/tunnel.js"),
);

export async function resetModelCatalogCacheForTest(): Promise<void> {
  const { resetModelCatalogCacheForTest: resetModelCatalogCacheForTestLocal } =
    await loadGatewayModelCatalogModule();
  await resetModelCatalogCacheForTestLocal();
}

ensureOpenClawCliOnPath();

const MAX_MEDIA_TTL_HOURS = 24 * 7;
const POST_READY_MAINTENANCE_DELAY_MS = 250;

type GatewayStartupChannelPlugin = {
  id: ChannelId;
  gatewayMethods?: readonly string[];
  gatewayMethodDescriptors?: readonly { name: string }[];
  meta: {
    aliases?: readonly string[];
  };
};

const loadGatewayStartupEarlyModule = createLazyRuntimeModule(
  () => import("./server-startup-early.js"),
);

const loadGatewayStartupPostAttachModule = createLazyRuntimeModule(
  () => import("./server-startup-post-attach.js"),
);

function listGatewayStartupChannelPlugins(): GatewayStartupChannelPlugin[] {
  return listLoadedChannelPlugins() as GatewayStartupChannelPlugin[];
}

function resolveMediaCleanupTtlMs(ttlHoursRaw: number): number {
  const ttlHours = Math.min(Math.max(ttlHoursRaw, 1), MAX_MEDIA_TTL_HOURS);
  const ttlMs = ttlHours * 60 * 60_000;
  if (!Number.isFinite(ttlMs) || !Number.isSafeInteger(ttlMs)) {
    throw new Error(`Invalid media.ttlHours: ${String(ttlHoursRaw)}`);
  }
  return ttlMs;
}

const log = createSubsystemLogger("gateway");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");

const getChannelRuntime = createLazyRuntimeModule(() =>
  import("../plugins/runtime/runtime-channel.js").then(({ createRuntimeChannel }) =>
    createRuntimeChannel(),
  ),
);

async function closeMcpLoopbackServerOnDemand(): Promise<void> {
  const { closeMcpLoopbackServer } = await import("./mcp-http.js");
  await closeMcpLoopbackServer();
}

const loadGatewayCloseModule = createLazyRuntimeModule(() => import("./server-close.runtime.js"));

const loadGatewayModelCatalog: LoadGatewayModelCatalog = async (...args) => {
  const mod = await loadGatewayModelCatalogModule();
  return mod.loadGatewayModelCatalog(...args);
};
const loadGatewayModelCatalogSnapshot: LoadGatewayModelCatalogSnapshot = async (...args) => {
  const mod = await loadGatewayModelCatalogModule();
  return mod.loadGatewayModelCatalogSnapshot(...args);
};

const loadGatewayPluginBootstrapModule = createLazyRuntimeModule(
  () => import("./server-plugin-bootstrap.js"),
);

const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logPlugins = log.child("plugins");
const logWsControl = log.child("ws");
const logSecrets = log.child("secrets");
const gatewayRuntime = runtimeForLogger(log);

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
    const metrics = [
      ["eventLoopMax", `${(eventLoopSample?.maxMs ?? 0).toFixed(1)}ms`] as const,
      ...extras,
    ];
    recordGatewayRestartTraceSpan(`restart.ready.${name}`, durationMs, totalMs, metrics);
    if (logEnabled) {
      log.info(
        `startup trace: ${name} ${durationMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms ${metrics.map(([key, value]) => formatMetric(key, value)).join(" ")}`,
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
      recordGatewayRestartTraceDetail(`restart.ready.${name}`, metrics);
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
    async measure<T>(
      name: string,
      run: () => Promise<T> | T,
      options: { omitErrorMessage?: boolean } = {},
    ): Promise<T> {
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
        const result = await withDiagnosticPhase(mapTimelineName(name), run, { traceName: name });
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
            ...(options.omitErrorMessage
              ? {}
              : { errorMessage: error instanceof Error ? error.message : String(error) }),
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

function formatRuntimeGatewayAuthTokenWarning(): string {
  const base =
    "Gateway auth token was missing. Generated a runtime token for this startup without changing config; restart will generate a different token.";
  if (!isNixMode) {
    return `${base} Persist one with \`openclaw config set gateway.auth.mode token\` and \`openclaw config set gateway.auth.token <token>\`.`;
  }
  return [
    base,
    "In Nix mode, set gateway.auth.token in your Nix-managed OpenClaw config and rebuild.",
    "For the first-party Nix flow, see https://github.com/openclaw/nix-openclaw#quick-start and https://docs.openclaw.ai/install/nix.",
  ].join(" ");
}

async function stopTaskRegistryMaintenanceOnDemand(): Promise<void> {
  const { stopTaskRegistryMaintenance } = await import("../tasks/task-registry.maintenance.js");
  stopTaskRegistryMaintenance();
}

type AuthRateLimitConfig = Parameters<typeof createAuthRateLimiter>[0];

function createGatewayAuthRateLimiters(rateLimitConfig: AuthRateLimitConfig | undefined): {
  rateLimiter: AuthRateLimiter;
  browserRateLimiter: AuthRateLimiter;
} {
  // Keep remote non-browser and HTTP auth attempts throttled by default while
  // preserving the normal loopback exemption unless operators configure otherwise.
  const rateLimiter = createAuthRateLimiter(rateLimitConfig ?? {});
  // Browser-origin WS auth attempts always use loopback-non-exempt throttling.
  const browserRateLimiter = createAuthRateLimiter({
    ...rateLimitConfig,
    exemptLoopback: false,
  });
  return { rateLimiter, browserRateLimiter };
}

export type GatewayCloseOptions = {
  reason?: string;
  restartExpectedMs?: number | null;
  drainTimeoutMs?: number | null;
};

export type GatewayServer = {
  close: (opts?: GatewayCloseOptions) => Promise<void>;
};

export type GatewayServerOptions = {
  /**
   * Bind address policy for the Gateway WebSocket/HTTP server.
   * - loopback: 127.0.0.1
   * - lan: 0.0.0.0
   * - tailnet: bind to the Tailscale IPv4 address (100.64.0.0/10) and local 127.0.0.1
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
   * Test-only: override the setup wizard runner.
   */
  wizardRunner?: (
    opts: import("../commands/onboard-types.js").OnboardOptions,
    runtime: import("../runtime.js").RuntimeEnv,
    prompter: import("../wizard/prompts.js").WizardPrompter,
  ) => Promise<void>;
  sidecarStartup?: GatewaySidecarStartupMode;
  channelAutostartSuppression?: ChannelAutostartSuppression;
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
  normalizeStateDirEnv(process.env);
  // runGatewayLoop calls this after closing the previous server on both fresh
  // and in-process restarts, making retired plugin generations safe to remove.
  try {
    const installRecords = loadInstalledPluginIndexInstallRecordsSync();
    const removedGenerations = await cleanupRetainedManagedNpmInstallGenerations({
      activeInstallPaths: Object.values(installRecords).flatMap((record) =>
        record.installPath ? [record.installPath] : [],
      ),
      onError: (error, projectRoot) =>
        log.warn(`failed to clean retained npm generation ${projectRoot}: ${String(error)}`),
    });
    if (removedGenerations > 0) {
      log.info(`cleaned ${removedGenerations} retained npm plugin generation(s)`);
    }
  } catch (error) {
    log.warn(`retained npm generation cleanup unavailable: ${String(error)}`);
  }
  const { bootstrapGatewayNetworkRuntime } = await import("./server-network-runtime.js");
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
  if (!resumeGatewayRestartTraceFromEnv(process.env, [["source", "env"]])) {
    const restartHandoff = readGatewayRestartHandoffSync();
    resumeGatewayRestartTraceFromHandoff(restartHandoff?.restartTrace, [
      ["source", restartHandoff?.source],
      ["restartKind", restartHandoff?.restartKind],
      ["supervisorMode", restartHandoff?.supervisorMode],
    ]);
  }
  const startupTrace = createGatewayStartupTrace();
  const startupConfigModulePromise = import("./server-startup-config.js");
  const loadStartupPluginsModule = createLazyPromise(() => import("./server-startup-plugins.js"), {
    cacheRejections: true,
  });
  const { loadGatewayStartupConfigSnapshot } = await startupConfigModulePromise;

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
    });
  };
  const { createRuntimeSecretsActivator } = await startupConfigModulePromise;
  const activateRuntimeSecrets = createRuntimeSecretsActivator({
    logSecrets,
    emitStateEvent: emitSecretsStateEvent,
    ...(startupConfigLoad.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: startupConfigLoad.pluginMetadataSnapshot }
      : {}),
  });

  let cfgAtStart: OpenClawConfig;
  let startupInternalWriteHash: string | null = null;
  let startupLastGoodSnapshot = configSnapshot;
  const startupActivationSourceConfig = configSnapshot.sourceConfig;
  const startupRuntimeConfig = applyConfigOverrides(configSnapshot.config);
  startupTrace.setConfig(startupRuntimeConfig);
  const { prepareGatewayStartupConfig } = await startupConfigModulePromise;
  const authBootstrap = await startupTrace.measure(
    "config.auth",
    () =>
      prepareGatewayStartupConfig({
        configSnapshot,
        authOverride: opts.auth,
        tailscaleOverride: opts.tailscale,
        activateRuntimeSecrets,
        log,
        measure: (name, run, measureOptions) => startupTrace.measure(name, run, measureOptions),
      }),
    { omitErrorMessage: true },
  );
  cfgAtStart = authBootstrap.cfg;
  startupTrace.setConfig(cfgAtStart);
  if (authBootstrap.generatedToken) {
    log.warn(formatRuntimeGatewayAuthTokenWarning());
  }
  const diagnosticsEnabled = isDiagnosticsEnabled(cfgAtStart);
  setDiagnosticsEnabledForProcess(diagnosticsEnabled);
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat(undefined, {
      getConfig: getRuntimeConfig,
      startupGraceMs: 60_000,
    });
  }
  setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(cfgAtStart) });
  let getActiveTaskCount = () => 0;
  setPreRestartDeferralCheck(
    () =>
      getTotalQueueSize() +
      getTotalPendingReplies() +
      getActiveEmbeddedRunCount() +
      getActiveCronJobCount() +
      getActiveBackgroundExecSessionCount() +
      getActiveGatewayRootWorkCount() +
      getActiveTaskCount(),
  );
  // Unconditional startup migration: seed gateway.controlUi.allowedOrigins for existing
  // non-loopback installs that upgraded to v2026.2.26+ without required origins.
  const controlUiSeed = minimalTestGateway
    ? { config: cfgAtStart, seededAllowedOrigins: false }
    : await startupTrace.measure("control-ui.seed", () =>
        maybeSeedControlUiAllowedOriginsAtStartup({
          config: cfgAtStart,
          log,
          runtimeBind: opts.bind,
          runtimePort: port,
        }),
      );
  cfgAtStart = controlUiSeed.config;
  // Keep the old startup-write suppression path intact for compatibility with
  // callers that may still report a write, but startup itself no longer mutates config.
  if (startupConfigLoad.wroteConfig || authBootstrap.persistedGeneratedToken) {
    const startupSnapshot = await startupTrace.measure("config.final-snapshot", () =>
      readConfigFileSnapshot(),
    );
    startupInternalWriteHash = startupSnapshot.hash ?? null;
    startupLastGoodSnapshot = startupSnapshot;
  }
  setRuntimeConfigSnapshot(cfgAtStart, startupLastGoodSnapshot.sourceConfig);
  const workerEnvironmentStore = minimalTestGateway ? undefined : createWorkerEnvironmentStore();
  const hasWorkerEnvironmentRecords = (workerEnvironmentStore?.list().length ?? 0) > 0;
  // Durable rows can outlive profiles. Startup planning still enforces plugin trust/disable gates.
  const listDurableWorkerProviderIds = () =>
    uniqueStrings(
      workerEnvironmentStore?.listForReconcile().map((record) => record.providerId) ?? [],
    );
  const { prepareGatewayPluginBootstrap } = await loadStartupPluginsModule();
  const pluginBootstrap = await startupTrace.measure("plugins.bootstrap", () =>
    prepareGatewayPluginBootstrap({
      cfgAtStart,
      activationSourceConfig: startupActivationSourceConfig,
      startupRuntimeConfig,
      pluginMetadataSnapshot: startupConfigLoad.pluginMetadataSnapshot,
      workerProviderIds: listDurableWorkerProviderIds(),
      minimalTestGateway,
      log,
      loadRuntimePlugins: false,
      loadSetupRuntimePlugins: true,
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
  const coreGatewayMethodNames = listCoreGatewayMethodNames();
  setCurrentPluginMetadataSnapshot(pluginLookUpTable, {
    config: startupActivationSourceConfig,
    compatibleConfigs: [startupRuntimeConfig, cfgAtStart, gatewayPluginConfigAtStart],
    env: process.env,
    workspaceDir: defaultWorkspaceDir,
  });
  if (pluginLookUpTable) {
    const metrics = pluginLookUpTable.metrics;
    startupTrace.detail("plugins.lookup-table", [
      ["registrySnapshotMs", metrics.registrySnapshotMs],
      ["manifestRegistryMs", metrics.manifestRegistryMs],
      ["startupPlanMs", metrics.startupPlanMs],
      ["ownerMapsMs", metrics.ownerMapsMs],
      ["totalMs", metrics.totalMs],
      ["indexPlugins", String(metrics.indexPluginCount)],
      ["indexPluginCount", metrics.indexPluginCount],
      ["manifestPlugins", String(metrics.manifestPluginCount)],
      ["manifestPluginCount", metrics.manifestPluginCount],
      ["startupPlugins", String(metrics.startupPluginCount)],
      ["startupPluginCount", metrics.startupPluginCount],
      ["deferredChannelPlugins", String(metrics.deferredChannelPluginCount)],
      ["deferredChannelPluginCount", metrics.deferredChannelPluginCount],
    ]);
  }
  let { pluginRegistry, baseGatewayMethods } = pluginBootstrap;
  // Unconfigured clean installs get no service; durable rows still need list/status projection.
  const shouldStartWorkerEnvironmentService =
    Object.keys(gatewayPluginConfigAtStart.cloudWorkers?.profiles ?? {}).length > 0 ||
    hasWorkerEnvironmentRecords;
  let workerBundleProducer: WorkerBundleProducer | undefined;
  let workerNpmArtifact: Promise<WorkerNpmArtifact> | undefined;
  let resolveWorkerGatewayEndpoint: () =>
    | { host: "127.0.0.1" | "::1"; port: number }
    | undefined = () => undefined;
  const prepareWorkerInstallation = async (install: "bundle" | "npm") => {
    const workerEnvironmentRuntime = await loadWorkerEnvironmentRuntimeModule();
    workerBundleProducer ??= workerEnvironmentRuntime.createWorkerBundleProducer({
      protocolFeatures: WORKER_PROTOCOL_FEATURES,
    });
    const bundle = await workerBundleProducer.prepare();
    if (install === "bundle") {
      return bundle;
    }
    workerNpmArtifact ??= workerEnvironmentRuntime
      .resolveWorkerNpmInstallationArtifact({ bundle })
      .catch((error: unknown) => {
        workerNpmArtifact = undefined;
        throw error;
      });
    return await workerNpmArtifact;
  };
  const workerTunnelManager =
    workerEnvironmentStore && shouldStartWorkerEnvironmentService
      ? (await loadWorkerTunnelRuntimeModule()).createWorkerTunnelManager()
      : undefined;
  const workerEnvironmentService =
    workerEnvironmentStore && shouldStartWorkerEnvironmentService
      ? createWorkerEnvironmentService({
          store: workerEnvironmentStore,
          getConfig: getRuntimeConfig,
          resolveProvider: (providerId) => resolveWorkerProvider(pluginRegistry, providerId),
          prepareInstallation: prepareWorkerInstallation,
          tunnelManager: workerTunnelManager,
          resolveWorkerGateway: () => resolveWorkerGatewayEndpoint(),
          applyTranscriptCommit: createWorkerTranscriptCommitter({
            getConfig: getRuntimeConfig,
          }).commit,
          resolveSshIdentity: async ({ provider, leaseId, profile, keyRef }) => {
            const workerEnvironmentRuntime = await loadWorkerEnvironmentRuntimeModule();
            return await workerEnvironmentRuntime.resolveWorkerSshIdentity({
              provider,
              leaseId,
              profile,
              keyRef,
              resolveGeneric: async (genericKeyRef) => ({
                kind: "material",
                contents: await workerEnvironmentRuntime.resolveSecretRefString(genericKeyRef, {
                  config:
                    getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? getRuntimeConfig(),
                  env: getActiveSecretsRuntimeEnv(),
                }),
              }),
            });
          },
          bootstrapWorker: async ({ sshEndpoint, installation, resolveIdentity, signal }) => {
            const workerEnvironmentRuntime = await loadWorkerEnvironmentRuntimeModule();
            return await workerEnvironmentRuntime.bootstrapWorker(
              {
                ssh: sshEndpoint,
                artifact: installation,
                pinnedHostKey: sshEndpoint.hostKey,
              },
              {
                signal,
                resolveIdentity,
              },
            );
          },
          logger: log.child("worker-environments"),
        })
      : undefined;
  const channelLogs = Object.fromEntries(
    listGatewayStartupChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]),
  ) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
  const channelRuntimeEnvs = Object.fromEntries(
    Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]),
  ) as unknown as Record<ChannelId, RuntimeEnv>;
  const listStartupChannelGatewayMethods = () => {
    const methods: string[] = [];
    for (const plugin of listGatewayStartupChannelPlugins()) {
      methods.push(...(plugin.gatewayMethods ?? []));
      for (const descriptor of plugin.gatewayMethodDescriptors ?? []) {
        methods.push(descriptor.name);
      }
    }
    return methods;
  };
  const listActiveGatewayMethods = (nextBaseGatewayMethods: string[]) =>
    uniqueStrings([...nextBaseGatewayMethods, ...listStartupChannelGatewayMethods()]);
  const runtimeConfig = await startupTrace.measure("runtime.config", async () => {
    const { resolveGatewayRuntimeConfig } = await import("./server-runtime-config.js");
    return resolveGatewayRuntimeConfig({
      cfg: cfgAtStart,
      port,
      bind: opts.bind,
      host: opts.host,
      controlUiEnabled: opts.controlUiEnabled,
      openAiChatCompletionsEnabled: opts.openAiChatCompletionsEnabled,
      openResponsesEnabled: opts.openResponsesEnabled,
      auth: opts.auth,
      tailscale: opts.tailscale,
    });
  });
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
        getActiveSecretsRuntimeConfigSnapshot()?.config.gateway?.auth ??
        getRuntimeConfig().gateway?.auth,
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
      config.gateway?.trustedProxies,
    );
  const resolveCurrentSharedGatewaySessionGeneration = () =>
    resolveSharedGatewaySessionGeneration(
      getResolvedAuth(),
      getRuntimeConfig().gateway?.trustedProxies,
    );
  const resolveSharedGatewaySessionGenerationForRuntimeSnapshot = () =>
    resolveSharedGatewaySessionGeneration(
      resolveGatewayAuth({
        authConfig: getRuntimeConfig().gateway?.auth,
        authOverride: opts.auth,
        env: process.env,
        tailscaleMode,
      }),
      getRuntimeConfig().gateway?.trustedProxies,
    );
  const sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState = {
    current: resolveCurrentSharedGatewaySessionGeneration(),
    required: null,
  };
  const preauthHandshakeTimeoutMs =
    cfgAtStart.gateway?.handshakeTimeoutMs ?? getRuntimeConfig().gateway?.handshakeTimeoutMs;
  const initialHooksConfig = runtimeConfig.hooksConfig;
  const initialHookClientIpConfig = resolveHookClientIpConfig(cfgAtStart);

  // Create auth rate limiters used by connect/auth flows.
  const rateLimitConfig = cfgAtStart.gateway?.auth?.rateLimit;
  const { rateLimiter: authRateLimiter, browserRateLimiter: browserAuthRateLimiter } =
    createGatewayAuthRateLimiters(rateLimitConfig);
  const nodeReapprovalCoordinator = createNodeReapprovalCoordinator(rateLimitConfig);

  const controlUiRootState = await startupTrace.measure("control-ui.root", () =>
    resolveGatewayControlUiRootState({
      controlUiRootOverride,
      controlUiEnabled,
      gatewayRuntime,
      log,
    }),
  );
  const { createTerminalLaunchPolicy } = await import("./terminal/launch.js");
  const terminalLaunchPolicy = createTerminalLaunchPolicy(cfgAtStart);

  const wizardRunner = opts.wizardRunner ?? runDefaultSetupWizard;
  const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();
  const crestodianSessions: GatewayRequestContext["crestodianSessions"] = new Map();

  const deps = createDefaultDeps();
  let runtimeState: GatewayServerLiveState | null = null;
  let gatewayCronStartHandled = false;
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
  let releaseStartupAccountStarts = () => {};
  const startupAccountStartsReady = new Promise<void>((resolve) => {
    releaseStartupAccountStarts = resolve;
  });
  const { createChannelManager } = await import("./server-channels.js");
  const channelManager = createChannelManager({
    getRuntimeConfig: () => {
      const runtimeConfigLocal = getRuntimeConfig();
      return resolveGatewayPluginConfig({
        config: runtimeConfigLocal,
      });
    },
    channelLogs,
    channelRuntimeEnvs,
    resolveChannelRuntime: getChannelRuntime,
    getPluginHttpRouteRegistry: () => pluginRegistry,
    startupTrace,
    deferStartupAccountStartsUntil: startupAccountStartsReady,
  });
  channelManager.setAutostartSuppression(opts.channelAutostartSuppression ?? null);
  const sidecarStartup = opts.sidecarStartup ?? "start";
  const isGatewayStartupPending = () => !startupSidecarsReady && sidecarStartup === "start";
  const getReadiness = createReadinessChecker({
    channelManager,
    startedAt: serverStartedAt,
    getStartupPending: isGatewayStartupPending,
    getStartupPendingReason: () => startupPendingReason,
    getGatewayDraining: isGatewayDraining,
    getEventLoopHealth: readinessEventLoopHealth.snapshot,
    shouldSkipChannelReadiness: () =>
      isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
      isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS),
  });
  log.info("starting HTTP server...");
  let currentPluginRegistryGatewayContext: GatewayRequestContext | undefined;
  const watchNodeRequestHandler: {
    current?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  } = {};
  const {
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
    chatQueuedTurns,
    toolEventRecipients,
    getWorkerIngressEndpoint,
    getMcpAppSandboxPort,
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
      isTerminalEnabled: terminalLaunchPolicy.isEnabled,
      gatewayTls,
      getResolvedAuth,
      hooksConfig: () => runtimeState?.hooksConfig ?? initialHooksConfig,
      getHookClientIpConfig: () => runtimeState?.hookClientIpConfig ?? initialHookClientIpConfig,
      pluginRegistry,
      getPluginRouteRegistry: () => pluginRegistry,
      getGatewayRequestContext: () => currentPluginRegistryGatewayContext,
      pinChannelRegistry: !minimalTestGateway,
      deps,
      log,
      logHooks,
      logPlugins,
      getReadiness,
      handleWatchNodeRequest: async (req, res) =>
        (await watchNodeRequestHandler.current?.(req, res)) ?? false,
      workerIngressEnabled: Boolean(workerEnvironmentService),
    }),
  );
  resolveWorkerGatewayEndpoint = getWorkerIngressEndpoint;
  const restartRecoveryCandidates = new Map<string, RestartRecoveryCandidate>();
  const { createGatewayNodeSessionRuntime } = await import("./server-node-session-runtime.js");
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
    hasTalkNodeConnected,
  } = createGatewayNodeSessionRuntime({
    broadcast,
    listRegisteredNodePluginToolCommands: () => pluginRegistry.nodeHostCommands,
    nodePluginToolsEnabled: cfgAtStart.gateway?.nodes?.pluginTools?.enabled !== false,
    nodeSkillsEnabled: cfgAtStart.gateway?.nodes?.skills?.enabled !== false,
  });
  const { createWatchNodeHttpRuntime } = await import("./watch-node-http.js");
  const watchNodeHttpRuntime = createWatchNodeHttpRuntime({
    nodeRegistry,
    getConfig: getRuntimeConfig,
    broadcast,
    rateLimiter: authRateLimiter,
    nodeReapprovalCoordinator,
    onNodeConnected: (session) => {
      upsertPresence(session.nodeId, {
        host: session.displayName ?? session.clientId ?? session.nodeId,
        ip: session.remoteIp,
        version: session.version,
        platform: session.platform,
        deviceFamily: session.deviceFamily,
        modelIdentifier: session.modelIdentifier,
        mode: session.clientMode,
        deviceId: session.nodeId,
        roles: ["node"],
        scopes: [],
        instanceId: session.nodeId,
        reason: "connect",
      });
      incrementPresenceVersion();
      recordRemoteNodeInfo({
        nodeId: session.nodeId,
        connId: session.connId,
        displayName: session.displayName,
        platform: session.platform,
        deviceFamily: session.deviceFamily,
        commands: session.commands,
        remoteIp: session.remoteIp,
      });
    },
    onNodeDisconnected: (nodeId) => {
      upsertPresence(nodeId, { reason: "disconnect" });
      broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion });
      removeRemoteNodeInfo(nodeId);
      nodeUnsubscribeAll(nodeId);
      clearNodeWakeState(nodeId);
    },
    onError: (message, error) => log.warn(`${message}: ${String(error)}`),
  });
  watchNodeRequestHandler.current = watchNodeHttpRuntime.handleRequest;
  const { TerminalSessionManager, DEFAULT_TERMINAL_DETACH_SECONDS } =
    await import("./terminal/session-manager.js");
  // One PTY store per gateway. Emits each session's bytes only to the owning
  // connection so terminals stay private to the operator that opened them.
  // Startup config is enough here: gateway.terminal.* changes restart the
  // gateway (config-reload-plan), so the grace period never drifts at runtime.
  const terminalSessions = new TerminalSessionManager({
    emit: (connId, event, payload) => broadcastToConnIds(event, payload, new Set([connId])),
    detachGraceMs:
      (cfgAtStart.gateway?.terminal?.detachedSessionTimeoutSeconds ??
        DEFAULT_TERMINAL_DETACH_SECONDS) * 1000,
  });
  applyGatewayLaneConcurrency(cfgAtStart);

  runtimeState = createGatewayServerLiveState({
    hooksConfig: initialHooksConfig,
    hookClientIpConfig: initialHookClientIpConfig,
    cronState: createLazyGatewayCronState({
      cfg: cfgAtStart,
      deps,
      broadcast,
    }),
    gatewayMethods: listActiveGatewayMethods(baseGatewayMethods),
  });
  deps.cron = runtimeState.cronState.cron;
  const pluginHostServices = {
    get cron() {
      return runtimeState.cronState.cron;
    },
  };

  let closePreludeStarted = false;
  const cronReconciliation = createGatewayCronReconciliation({
    port,
    workspaceDir: defaultWorkspaceDir,
    isClosing: () => closePreludeStarted,
    runHook: async (event, ctx) => {
      try {
        const hookRunner = (await import("../plugins/hook-runner-global.js")).getGlobalHookRunner();
        if (hookRunner?.hasHooks("cron_reconciled")) {
          await hookRunner.runCronReconciled(event, ctx);
        }
      } catch (err) {
        logCron.error(`cron_reconciled hook failed: ${String(err)}`);
      }
    },
  });
  let postReadyMaintenanceTimer: ReturnType<typeof setTimeout> | null = null;
  const clearPostReadyMaintenanceTimer = () => {
    if (!postReadyMaintenanceTimer) {
      return;
    }
    clearTimeout(postReadyMaintenanceTimer);
    postReadyMaintenanceTimer = null;
  };
  const markClosePreludeStarted = () => {
    closePreludeStarted = true;
    cronReconciliation.invalidate();
    clearPostReadyMaintenanceTimer();
  };
  const runClosePrelude = async () => {
    markClosePreludeStarted();
    watchNodeHttpRuntime.close();
    clearPluginMetadataLifecycleCaches();
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
      disposeAuthRateLimiter: () => {
        authRateLimiter.dispose();
        nodeReapprovalCoordinator.dispose();
      },
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
  const refreshGatewayHealthSnapshotWithRuntime: typeof refreshGatewayHealthSnapshot = (
    optsResult,
  ) =>
    refreshGatewayHealthSnapshot({
      ...optsResult,
      getRuntimeSnapshot,
      getEventLoopHealth: readinessEventLoopHealth.snapshot,
      getConfigReloaderHotReloadStatus: () => runtimeState?.configReloader.hotReloadStatus?.(),
    });
  const stopRegisteredPostReadySidecars = async () => {
    const postReadySidecars = runtimeState.postReadySidecars;
    runtimeState.postReadySidecars = [];
    for (const postReadySidecar of postReadySidecars) {
      await postReadySidecar.stop();
    }
  };
  const stopRegisteredGatewayLifetimeSidecars = async () => {
    const gatewayLifetimeSidecars = runtimeState.gatewayLifetimeSidecars;
    runtimeState.gatewayLifetimeSidecars = [];
    for (const gatewayLifetimeSidecar of gatewayLifetimeSidecars) {
      await gatewayLifetimeSidecar.stop();
    }
  };
  const createCloseHandler = () => async (optsValue?: GatewayCloseOptions) => {
    const channelIds = listLoadedChannelPlugins().map((plugin) => plugin.id as ChannelId);
    const { createGatewayCloseHandler, drainActiveSessionsForShutdown } =
      await loadGatewayCloseModule();
    await createGatewayCloseHandler({
      bonjourStop: runtimeState.bonjourStop,
      tailscaleCleanup: runtimeState.tailscaleCleanup,
      releasePluginRouteRegistry,
      channelIds,
      stopChannel,
      pluginServices: runtimeState.pluginServices,
      postReadySidecars: runtimeState.postReadySidecars,
      cron: runtimeState.cronState.cron,
      heartbeatRunner: runtimeState.heartbeatRunner,
      updateCheckStop: runtimeState.stopGatewayUpdateCheck,
      stopTaskRegistryMaintenance: stopTaskRegistryMaintenanceOnDemand,
      nodePresenceTimers,
      broadcast,
      tickInterval: runtimeState.tickInterval,
      healthInterval: runtimeState.healthInterval,
      dedupeCleanup: runtimeState.dedupeCleanup,
      mediaCleanup: runtimeState.mediaCleanup,
      worktreeCleanup: runtimeState.worktreeCleanup,
      skillCuratorCleanup: runtimeState.skillCuratorCleanup,
      agentUnsub: runtimeState.agentUnsub,
      heartbeatUnsub: runtimeState.heartbeatUnsub,
      transcriptUnsub: runtimeState.transcriptUnsub,
      lifecycleUnsub: runtimeState.lifecycleUnsub,
      taskUnsub: runtimeState.taskUnsub,
      chatRunState,
      chatAbortControllers,
      chatQueuedTurns,
      restartRecoveryCandidates,
      removeChatRun,
      agentRunSeq,
      nodeSendToSession,
      resolveActiveSessionIdForKey: resolveActiveEmbeddedRunSessionId,
      markMainSessionsAbortedForRestart: async ({
        sessionKeys,
        sessionIds,
        activeRuns,
        reason,
        isActiveRun,
      }) => {
        if (sessionKeys.size === 0 && sessionIds.size === 0) {
          return;
        }
        const { markRestartAbortedMainSessions } =
          await import("../agents/main-session-restart-recovery.js");
        await markRestartAbortedMainSessions({
          cfg: getRuntimeConfig(),
          sessionKeys,
          sessionIds,
          activeRuns,
          isActiveRun,
          reason,
        });
      },
      getPendingReplyCount: getTotalPendingReplies,
      clients,
      configReloader: runtimeState.configReloader,
      wss,
      httpServer,
      httpServers,
      drainActiveSessionsForShutdown,
    })(optsValue);
  };
  let clearFallbackGatewayContextForServer = () => {};
  const closeOnStartupFailure = async () => {
    try {
      await stopRegisteredGatewayLifetimeSidecars();
      await stopRegisteredPostReadySidecars();
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
      loadGatewayStartupEarlyModule().then(({ startGatewayEarlyRuntime }) =>
        startGatewayEarlyRuntime({
          minimalTestGateway,
          cfgAtStart,
          port,
          gatewayTls,
          gatewayDirectReachable: !isLoopbackHost(bindHost),
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
          chatQueuedTurns,
          restartRecoveryCandidates,
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
          startupTrace,
        }),
      ),
    );
    runtimeState.bonjourStop = earlyRuntime.bonjourStop;
    getActiveTaskCount = earlyRuntime.getActiveTaskCount;
    runtimeState.skillsChangeUnsub = earlyRuntime.skillsChangeUnsub;

    const [{ startGatewayEventSubscriptions }, { startGatewayRuntimeServices }] =
      await startupTrace.measure("runtime.post-early-imports", () =>
        Promise.all([
          import("./server-runtime-subscriptions.js"),
          import("./server-runtime-startup-services.js"),
        ]),
      );
    const runtimeSubscriptions = await startupTrace.measure("runtime.subscriptions", () =>
      startGatewayEventSubscriptions({
        log,
        broadcast,
        broadcastToConnIds,
        nodeSendToSession,
        agentRunSeq,
        chatRunState,
        toolEventRecipients,
        sessionEventSubscribers,
        sessionMessageSubscribers,
        chatAbortControllers,
        restartRecoveryCandidates,
      }),
    );
    Object.assign(runtimeState, runtimeSubscriptions);

    const runtimeServices = await startupTrace.measure("runtime.services", () =>
      startGatewayRuntimeServices({
        minimalTestGateway,
        cfgAtStart,
        channelManager,
        log,
      }),
    );
    Object.assign(runtimeState, runtimeServices);

    const {
      execApprovalManager,
      forwardPluginApprovalRequest,
      pluginApprovalManager,
      extraHandlers,
      coreGatewayHandlers,
    } = await startupTrace.measure("gateway.handlers", async () => {
      const [{ createGatewayAuxHandlers }, { coreGatewayHandlers: coreGatewayHandlersLocal }] =
        await Promise.all([import("./server-aux-handlers.js"), import("./server-methods.js")]);
      return {
        ...createGatewayAuxHandlers({
          log,
          activateRuntimeSecrets,
          sharedGatewaySessionGenerationState,
          resolveSharedGatewaySessionGenerationForConfig,
          clients,
          startChannel,
          stopChannel,
          getChannelAutostartSuppression: channelManager.getAutostartSuppression,
          logChannels,
        }),
        coreGatewayHandlers: coreGatewayHandlersLocal,
      };
    });
    const attachedGatewayExtraHandlers: GatewayRequestHandlers = {
      ...pluginRegistry.gatewayHandlers,
      ...extraHandlers,
    };
    let attachedPluginGatewayHandlerKeys = new Set(Object.keys(pluginRegistry.gatewayHandlers));
    const buildAttachedGatewayMethodRegistry = (
      nextPluginRegistry: typeof pluginRegistry,
    ): GatewayMethodRegistry => {
      const coreDescriptorHandlers: GatewayRequestHandlers = { ...coreGatewayHandlers };
      const auxHandlers: GatewayRequestHandlers = {};
      for (const [method, handler] of Object.entries(extraHandlers)) {
        if (isCoreGatewayMethodClassified(method)) {
          coreDescriptorHandlers[method] = handler;
        } else {
          auxHandlers[method] = handler;
        }
      }
      const coreDescriptors = createCoreGatewayMethodDescriptors(coreDescriptorHandlers).filter(
        (descriptor) =>
          workerEnvironmentService ||
          (descriptor.name !== "environments.create" && descriptor.name !== "environments.destroy"),
      );
      return createGatewayMethodRegistry([
        ...coreDescriptors,
        ...createPluginGatewayMethodDescriptors(nextPluginRegistry),
        ...createGatewayMethodDescriptorsFromHandlers({
          handlers: auxHandlers,
          owner: { kind: "aux", area: "gateway-extra" },
          defaultScope: ADMIN_SCOPE,
        }),
      ]);
    };
    let attachedGatewayMethodRegistry = buildAttachedGatewayMethodRegistry(pluginRegistry);
    const listAttachedGatewayMethods = () => {
      const methods = attachedGatewayMethodRegistry.listAdvertisedMethods();
      methods.push(...listStartupChannelGatewayMethods());
      return uniqueStrings(methods);
    };
    runtimeState.gatewayMethods.splice(
      0,
      runtimeState.gatewayMethods.length,
      ...listAttachedGatewayMethods(),
    );
    const replaceAttachedPluginRuntime = (loaded: {
      pluginRegistry: typeof pluginRegistry;
      gatewayMethods: string[];
    }) => {
      pluginRegistry = loaded.pluginRegistry;
      baseGatewayMethods = loaded.gatewayMethods;
      for (const key of attachedPluginGatewayHandlerKeys) {
        delete attachedGatewayExtraHandlers[key];
      }
      Object.assign(attachedGatewayExtraHandlers, pluginRegistry.gatewayHandlers);
      attachedPluginGatewayHandlerKeys = new Set(Object.keys(pluginRegistry.gatewayHandlers));
      attachedGatewayMethodRegistry = buildAttachedGatewayMethodRegistry(pluginRegistry);
      runtimeState.gatewayMethods.splice(
        0,
        runtimeState.gatewayMethods.length,
        ...listAttachedGatewayMethods(),
      );
      pinActivePluginHttpRouteRegistry(pluginRegistry);
      pinActivePluginSessionExtensionRegistry(pluginRegistry);
      pinActivePluginChannelRegistry(pluginRegistry);
      nodeRegistry.refreshNodePluginTools();
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
        const { startGatewayPluginDiscovery } = await loadGatewayStartupEarlyModule();
        runtimeState.bonjourStop = await startGatewayPluginDiscovery({
          minimalTestGateway,
          cfgAtStart,
          port,
          gatewayTls,
          gatewayDirectReachable: !isLoopbackHost(bindHost),
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
        listGatewayStartupChannelPlugins().map((plugin) => [
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
      isAborted?: () => boolean;
    }): Promise<GatewayPluginReloadResult> => {
      const beforeChannelTargets = listAttachedChannelConfigTargets();
      const beforeChannelIds = new Set(beforeChannelTargets.keys());
      const [{ loadPluginLookUpTable }, { prepareGatewayPluginLoad }, { startPluginServices }] =
        await Promise.all([
          import("../plugins/plugin-lookup-table.js"),
          loadGatewayPluginBootstrapModule(),
          import("../plugins/services.js"),
        ]);
      const nextPluginActivationConfig = resolveGatewayStartupPluginActivationConfig({
        runtimeConfig: params.nextConfig,
        activationSourceConfig: params.nextConfig,
        env: process.env,
      });
      const nextPluginLookUpTable = loadPluginLookUpTable({
        config: nextPluginActivationConfig,
        workspaceDir: defaultWorkspaceDir,
        env: process.env,
        activationSourceConfig: params.nextConfig,
        workerProviderIds: listDurableWorkerProviderIds(),
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
      // If an in-process restart signalled abort during beforeReplace,
      // stop before any plugin metadata/runtime side effects continue.
      if (params.isAborted?.()) {
        return {
          restartChannels: new Set(),
          activeChannels: new Set(beforeChannelIds),
          cancelled: true,
        };
      }
      setCurrentPluginMetadataSnapshot(nextPluginLookUpTable, {
        config: params.nextConfig,
        env: process.env,
        workspaceDir: defaultWorkspaceDir,
      });
      const loaded = prepareGatewayPluginLoad({
        cfg: params.nextConfig,
        workspaceDir: defaultWorkspaceDir,
        log,
        coreGatewayMethodNames,
        hostServices: pluginHostServices,
        baseMethods,
        pluginLookUpTable: nextPluginLookUpTable,
      });
      const previousPluginServices = runtimeState.pluginServices;
      runtimeState.pluginServices = null;
      if (previousPluginServices) {
        await previousPluginServices.stop().catch((err: unknown) => {
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

    const unavailableGatewayMethods = new Set<string>(
      minimalTestGateway ? [] : STARTUP_UNAVAILABLE_GATEWAY_METHODS,
    );
    const gatewayRequestContext = await startupTrace.measure(
      "gateway.request-context",
      async () => {
        const { createGatewayRequestContext } = await import("./server-request-context.js");
        return createGatewayRequestContext({
          deps,
          runtimeState,
          getRuntimeConfig,
          getMcpAppSandboxPort,
          resolveTerminalLaunchPolicy: terminalLaunchPolicy.resolve,
          isTerminalEnabled: terminalLaunchPolicy.isEnabled,
          execApprovalManager,
          forwardPluginApprovalRequest,
          pluginApprovalManager,
          loadGatewayModelCatalog,
          loadGatewayModelCatalogSnapshot,
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
          hasConnectedTalkNode: hasTalkNodeConnected,
          clients,
          invalidateDeviceTransports: watchNodeHttpRuntime.invalidateSessionsForDevice,
          disconnectDeviceTransports: watchNodeHttpRuntime.disconnectSessionsForDevice,
          enforceSharedGatewayAuthGenerationForConfigWrite: (nextConfig: OpenClawConfig) => {
            enforceSharedGatewaySessionGenerationForConfigWrite({
              state: sharedGatewaySessionGenerationState,
              nextConfig,
              resolveRuntimeSnapshotGeneration:
                resolveSharedGatewaySessionGenerationForRuntimeSnapshot,
              clients,
            });
          },
          nodeRegistry,
          ...(workerEnvironmentService ? { workerEnvironmentService } : {}),
          terminalSessions,
          agentRunSeq,
          chatAbortControllers,
          chatQueuedTurns,
          chatAbortedRuns: chatRunState.abortedRuns,
          chatRunBuffers: chatRunState.buffers,
          chatDeltaSentAt: chatRunState.deltaSentAt,
          chatDeltaLastBroadcastLen: chatRunState.deltaLastBroadcastLen,
          chatDeltaLastBroadcastText: chatRunState.deltaLastBroadcastText,
          agentDeltaSentAt: chatRunState.agentDeltaSentAt,
          bufferedAgentEvents: chatRunState.bufferedAgentEvents,
          clearChatRunState: chatRunState.clearRun,
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
          crestodianSessions,
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
      },
    );
    currentPluginRegistryGatewayContext = gatewayRequestContext;

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
        const { reloadDeferredGatewayPlugins } = await loadGatewayPluginBootstrapModule();
        const loaded = await startupTrace.measure("gateway.deferred-plugins", () =>
          reloadDeferredGatewayPlugins({
            cfg: gatewayPluginConfigAtStart,
            activationSourceConfig: startupActivationSourceConfig,
            workspaceDir: defaultWorkspaceDir,
            log,
            coreGatewayMethodNames,
            hostServices: pluginHostServices,
            baseMethods,
            pluginIds: startupPluginIds,
            pluginLookUpTable,
            logDiagnostics: false,
          }),
        );
        replaceAttachedPluginRuntime(loaded);
        await refreshAttachedGatewayDiscovery(loaded.pluginRegistry);
      }
    }

    const [{ attachGatewayWsHandlers }, { listPluginNodeCapabilities }] =
      await startupTrace.measure("gateway.ws-imports", () =>
        Promise.all([
          import("./server-ws-runtime.js"),
          import("./server/plugins-http/route-capability.js"),
        ]),
      );
    const pluginSurfaceScheme = gatewayTls.enabled ? "https" : "http";
    await startupTrace.measure("gateway.ws-attach", () =>
      attachGatewayWsHandlers({
        wss,
        clients,
        preauthConnectionBudget,
        port,
        gatewayHost: bindHost ?? undefined,
        pluginSurfaceScheme,
        getPluginNodeCapabilities: () => listPluginNodeCapabilities(pluginRegistry),
        resolvedAuth,
        getResolvedAuth,
        getRequiredSharedGatewaySessionGeneration: () =>
          getRequiredSharedGatewaySessionGeneration(sharedGatewaySessionGenerationState),
        rateLimiter: authRateLimiter,
        browserRateLimiter: browserAuthRateLimiter,
        nodeReapprovalCoordinator,
        preauthHandshakeTimeoutMs,
        isStartupPending: isGatewayStartupPending,
        gatewayMethods: runtimeState.gatewayMethods,
        events: GATEWAY_EVENTS,
        logGateway: log,
        logHealth,
        logWsControl,
        extraHandlers: attachedGatewayExtraHandlers,
        getMethodRegistry: () => attachedGatewayMethodRegistry,
        ...(workerEnvironmentService ? { workerConnectionService: workerEnvironmentService } : {}),
        broadcast,
        context: gatewayRequestContext,
      }),
    );
    await startupTrace.measure("http.listen", () => startListening());
    startupTrace.mark("http.bound");
    const sessionDeliveryRecoveryMaxEnqueuedAt = Date.now();
    let postAttachRuntimeReturned = false;
    let scheduledServicesActivated = false;
    const loadScheduledServicesModule = createLazyPromise(
      () => import("./server-runtime-services.js"),
      { cacheRejections: true },
    );
    const activateScheduledServicesWhenReady = () => {
      if (
        closePreludeStarted ||
        !postAttachRuntimeReturned ||
        !startupSidecarsReady ||
        scheduledServicesActivated
      ) {
        return;
      }
      scheduledServicesActivated = true;
      void loadScheduledServicesModule().then((gatewayRuntimeServices) => {
        if (closePreludeStarted) {
          return;
        }
        const activated = gatewayRuntimeServices.activateGatewayScheduledServices({
          minimalTestGateway,
          cfgAtStart,
          deps,
          sessionDeliveryRecoveryMaxEnqueuedAt,
          cronState: runtimeState.cronState,
          cronReconciliation,
          startCron: false,
          logCron,
          log,
          pluginLookUpTable,
        });
        runtimeState.heartbeatRunner = activated.heartbeatRunner;
        runtimeState.stopModelPricingRefresh = activated.stopModelPricingRefresh;
      });
    };
    ({
      stopGatewayUpdateCheck: runtimeState.stopGatewayUpdateCheck,
      tailscaleCleanup: runtimeState.tailscaleCleanup,
      pluginServices: runtimeState.pluginServices,
    } = await startupTrace.measure("runtime.post-attach", () =>
      loadGatewayStartupPostAttachModule().then(
        ({ startGatewayPostAttachRuntime, stopPostReadySidecarsAfterCloseStarted }) =>
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
            serviceName: tailscaleConfig.serviceName,
            preserveFunnel: tailscaleConfig.preserveFunnel ?? false,
            controlUiBasePath,
            logTailscale,
            gatewayPluginConfigAtStart,
            activationSourceConfig: startupActivationSourceConfig,
            pluginRegistry,
            defaultWorkspaceDir,
            deps,
            startChannels,
            logHooks,
            logChannels,
            unavailableGatewayMethods,
            loadStartupPlugins: runtimePluginsLoaded
              ? undefined
              : async () => {
                  const { loadGatewayStartupPluginRuntime } = await loadStartupPluginsModule();
                  return loadGatewayStartupPluginRuntime({
                    cfg: gatewayPluginConfigAtStart,
                    activationSourceConfig: startupActivationSourceConfig,
                    workspaceDir: defaultWorkspaceDir,
                    log,
                    baseMethods,
                    coreGatewayMethodNames,
                    hostServices: pluginHostServices,
                    startupPluginIds,
                    pluginLookUpTable,
                    startupTrace,
                  });
                },
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
            onChannelsStarted: () => {
              releaseStartupAccountStarts();
            },
            onPluginServices: (pluginServices) => {
              runtimeState.pluginServices = pluginServices;
            },
            onPostReadySidecars: (postReadySidecars) => {
              runtimeState.postReadySidecars = postReadySidecars;
              stopPostReadySidecarsAfterCloseStarted({
                postReadySidecars,
                closeStarted: closePreludeStarted,
              });
              if (closePreludeStarted) {
                runtimeState.postReadySidecars = [];
              }
            },
            onGatewayLifetimeSidecars: (gatewayLifetimeSidecars) => {
              runtimeState.gatewayLifetimeSidecars = gatewayLifetimeSidecars;
              stopPostReadySidecarsAfterCloseStarted({
                postReadySidecars: gatewayLifetimeSidecars,
                closeStarted: closePreludeStarted,
              });
              if (closePreludeStarted) {
                runtimeState.gatewayLifetimeSidecars = [];
              }
            },
            ...(workerEnvironmentService
              ? {
                  startWorkerEnvironmentRuntime: () => {
                    if (closePreludeStarted) {
                      return null;
                    }
                    const sidecar = { stop: () => workerEnvironmentService.stop() };
                    // Close must see the drain handle before reconciliation can yield.
                    runtimeState.gatewayLifetimeSidecars.push(sidecar);
                    workerEnvironmentService.start();
                    return sidecar;
                  },
                }
              : {}),
            onSidecarsReady: () => {
              startupSidecarsReady = true;
              activateScheduledServicesWhenReady();
            },
            isClosing: () => closePreludeStarted,
            startupTrace,
            sidecarStartup,
            providerAuthPrewarm: {
              getConfig: getRuntimeConfig,
            },
          }),
      ),
    ));
    startupTrace.detail("memory.ready", collectGatewayProcessMemoryUsageMb());
    startupTrace.mark("ready");
    if (sidecarStartup === "defer") {
      log.info("gateway ready");
    }
    finishGatewayRestartTrace("restart.ready", collectGatewayProcessMemoryUsageMb());
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
        const cronStateChanged = nextState.cronState !== runtimeState.cronState;
        runtimeState.hooksConfig = nextState.hooksConfig;
        runtimeState.hookClientIpConfig = nextState.hookClientIpConfig;
        runtimeState.heartbeatRunner = nextState.heartbeatRunner;
        runtimeState.cronState = nextState.cronState;
        deps.cron = runtimeState.cronState.cron;
        runtimeState.channelHealthMonitor = nextState.channelHealthMonitor;
        if (cronStateChanged) {
          gatewayCronStartHandled = true;
        }
      },
      startChannel,
      stopChannel,
      getChannelAutostartSuppression: channelManager.getAutostartSuppression,
      stopPostReadySidecars: stopRegisteredPostReadySidecars,
      reloadPlugins: reloadAttachedGatewayPlugins,
      logHooks,
      logChannels,
      logCron,
      logReload,
      cronReconciliation,
      onCronRestart: () => {
        gatewayCronStartHandled = true;
      },
      reconcileTerminalSessions: (plan, nextConfig) => {
        terminalLaunchPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
        terminalSessions.closeDisallowedAgents(
          (agentId) => terminalLaunchPolicy.resolve(agentId).ok,
        );
      },
      commitTerminalConfig: terminalLaunchPolicy.commitConfig,
      channelManager,
      activateRuntimeSecrets,
      resolveSharedGatewaySessionGenerationForConfig,
      sharedGatewaySessionGenerationState,
      clients,
    });
    await promoteConfigSnapshotToLastKnownGood(startupLastGoodSnapshot).catch((err: unknown) => {
      log.warn(`gateway: failed to promote config last-known-good backup: ${String(err)}`);
    });
    if (!minimalTestGateway) {
      const gatewayRuntimeServices = await loadScheduledServicesModule();
      postReadyMaintenanceTimer = gatewayRuntimeServices.scheduleGatewayPostReadyMaintenance({
        delayMs: POST_READY_MAINTENANCE_DELAY_MS,
        isClosing: () => closePreludeStarted,
        onStarted: () => {
          postReadyMaintenanceTimer = null;
        },
        startMaintenance: async () => {
          if (closePreludeStarted) {
            return null;
          }
          return earlyRuntime.startMaintenance();
        },
        applyMaintenance: (maintenance) => {
          if (closePreludeStarted) {
            clearInterval(maintenance.tickInterval);
            clearInterval(maintenance.healthInterval);
            clearInterval(maintenance.dedupeCleanup);
            if (maintenance.mediaCleanup) {
              clearInterval(maintenance.mediaCleanup);
            }
            clearInterval(maintenance.worktreeCleanup);
            maintenance.skillCuratorCleanup();
            return;
          }
          runtimeState.tickInterval = maintenance.tickInterval;
          runtimeState.healthInterval = maintenance.healthInterval;
          runtimeState.dedupeCleanup = maintenance.dedupeCleanup;
          runtimeState.mediaCleanup = maintenance.mediaCleanup;
          runtimeState.worktreeCleanup = maintenance.worktreeCleanup;
          runtimeState.skillCuratorCleanup = maintenance.skillCuratorCleanup;
        },
        shouldStartCron: () => !closePreludeStarted && !gatewayCronStartHandled,
        markCronStartHandled: () => {
          gatewayCronStartHandled = true;
        },
        cronState: runtimeState.cronState,
        cronReconciliation,
        cronConfig: cfgAtStart,
        logCron,
        log,
        recordPostReadyMemory: () => {
          startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
        },
      });
    } else {
      startupTrace.detail("memory.post-ready", collectGatewayProcessMemoryUsageMb());
    }
  } catch (err) {
    await closeOnStartupFailure();
    throw err;
  }

  const close = createCloseHandler();

  return {
    close: async (optsLocal) => {
      try {
        markClosePreludeStarted();
        // Kill any live operator shells before the socket layer tears down.
        terminalSessions.disposeAll();
        await stopRegisteredGatewayLifetimeSidecars();
        await stopRegisteredPostReadySidecars();
        // Run gateway_stop plugin hook before shutdown
        const { runGlobalGatewayStopSafely } = await import("../plugins/hook-runner-global.js");
        await runGlobalGatewayStopSafely({
          event: { reason: optsLocal?.reason ?? "gateway stopping" },
          ctx: { port },
          onError: (err) => log.warn(`gateway_stop hook failed: ${String(err)}`),
        });
        await runClosePrelude();
        await close(optsLocal);
      } finally {
        clearFallbackGatewayContextForServer();
      }
    },
  };
}
