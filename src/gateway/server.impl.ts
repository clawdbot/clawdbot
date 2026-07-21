import type { IncomingMessage, ServerResponse } from "node:http";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getActiveBackgroundExecSessionCount } from "../agents/bash-process-registry.js";
import {
  getActiveEmbeddedRunCount,
  resolveActiveEmbeddedRunSessionId,
} from "../agents/embedded-agent-runner/run-state.js";
import { clearSessionSuspensionTimers } from "../agents/session-suspension.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { isCoreCanvasHostEnabled } from "../canvas/config.js";
import { withCoreCanvasNodeCapability } from "../canvas/constants.js";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import {
  getLoadedChannelPluginEntryById,
  listLoadedChannelPlugins,
} from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { createDefaultDeps } from "../cli/deps.js";
import { isRestartEnabled } from "../config/commands.flags.js";
import {
  collectConfigRuntimeEnvOwnership,
  initializePublishedConfigRuntimeEnv,
  prepareConfigRuntimeEnv,
} from "../config/config-env-vars.js";
import { assertGatewayConfigEnvSelectionUnchanged } from "../config/gateway-env-selection.js";
import {
  getRuntimeConfig,
  getRuntimeConfigSourceSnapshot,
  promoteConfigSnapshotToLastKnownGood,
  readConfigFileSnapshot,
  readConfigFileSnapshotForRuntimeTransaction,
  registerConfigWriteListener,
  setAppliedRuntimeConfigSnapshot,
  type ReadConfigFileSnapshotWithPluginMetadataResult,
} from "../config/io.js";
import { isNixMode, normalizeStateDirEnv } from "../config/paths.js";
import { captureConfigOverrideApplier } from "../config/runtime-overrides.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef } from "../config/types.secrets.js";
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
import {
  type GatewayRestartEmitter,
  setGatewaySigusr1RestartPolicy,
  setPreRestartDeferralCheck,
} from "../infra/restart.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { upsertPresence } from "../infra/system-presence.js";
import { withDiagnosticPhase } from "../logging/diagnostic-phase.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat } from "../logging/diagnostic.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { setCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import type { PluginHookGatewayCronService } from "../plugins/hook-types.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  pinActivePluginChannelRegistry,
  pinActivePluginHttpRouteRegistry,
  pinActivePluginSessionExtensionRegistry,
} from "../plugins/runtime.js";
import { getTotalQueueSize, isGatewayDraining } from "../process/command-queue.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  clearSecretsRuntimeSnapshot,
  getActiveSecretsRuntimeConfigSnapshot,
} from "../secrets/runtime-state.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import {
  recordRemoteNodeInfo,
  removeRemoteNodeInfo,
  removeRemoteNodeInfoForConnection,
} from "../skills/runtime/remote.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { resolveGatewayAuth } from "./auth.js";
import type { RestartRecoveryCandidate } from "./chat-abort.js";
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import { revokeAttachGrantsForSession } from "./mcp-grant-store.js";
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
import { disposeNodeConnectionNotifications } from "./node-connection-notifications.js";
import { createNodeReapprovalCoordinator } from "./node-reapproval-coordinator.js";
import { clearNodeWakeState } from "./node-wake-state.js";
import {
  mergeActivationSectionsIntoRuntimeConfig,
  resolveGatewayReloadPluginActivationCandidate,
  resolveGatewayStartupPluginActivationConfig,
} from "./plugin-activation-runtime-config.js";
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
import type { GatewayInstanceRuntime } from "./server-instance-runtime.types.js";
import { applyGatewayLaneConcurrency, resolveGatewayLaneConcurrency } from "./server-lanes.js";
import { createGatewayServerLiveState, type GatewayServerLiveState } from "./server-live-state.js";
import { GATEWAY_EVENTS } from "./server-methods-list.js";
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
import { mergeGatewayAuthConfig, mergeGatewayTailscaleConfig } from "./startup-auth.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";
type LoadGatewayModelCatalog = typeof import("./server-model-catalog.js").loadGatewayModelCatalog;
type LoadGatewayModelCatalogSnapshot =
  typeof import("./server-model-catalog.js").loadGatewayModelCatalogSnapshot;

const loadGatewayModelCatalogModule = createLazyRuntimeModule(
  () => import("./server-model-catalog.js"),
);
const loadWorkerEnvironmentStartupModule = createLazyRuntimeModule(
  () => import("./server-worker-environment-startup.js"),
);
const loadWorkerPlacementStartupModule = createLazyRuntimeModule(
  () => import("./server-worker-placement-startup.js"),
);

export async function resetPreparedModelCatalogForTest(): Promise<void> {
  const { resetPreparedModelCatalogForTest: resetPreparedModelCatalogForTestLocal } =
    await loadGatewayModelCatalogModule();
  await resetPreparedModelCatalogForTestLocal();
}

ensureOpenClawCliOnPath();

const MAX_MEDIA_TTL_HOURS = 24 * 7;
const POST_READY_MAINTENANCE_DELAY_MS = 250;
const RETAINED_PLUGIN_CLEANUP_DELAY_MS = 30_000;

function approvalRequestTargetsSession(
  request: unknown,
  sessionKeys: ReadonlySet<string>,
  sessionId: string,
): boolean {
  if (typeof request !== "object" || request === null) {
    return false;
  }
  const record = request as { sessionKey?: unknown; sessionId?: unknown };
  return (
    (typeof record.sessionId === "string" && record.sessionId === sessionId) ||
    (typeof record.sessionKey === "string" && sessionKeys.has(record.sessionKey))
  );
}

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
  /** Test-only: override the setup wizard runner. */
  wizardRunner?: import("./server-methods/wizard.js").SetupWizardRunner;
  /** Test-only: override the channel-setup wizard runner (wizard.start flow "channels"). */
  channelWizardRunner?: import("./server-methods/wizard.js").ChannelSetupWizardRunner;
  sidecarStartup?: GatewaySidecarStartupMode;
  channelAutostartSuppression?: ChannelAutostartSuppression;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  /**
   * Optional startup timestamp used for concise readiness logging.
   */
  startupStartedAt?: number;
  /**
   * Config snapshot already read by the CLI gateway preflight. Passing it avoids
   * reparsing openclaw.json during server startup.
   */
  startupConfigSnapshotRead?: ReadConfigFileSnapshotWithPluginMetadataResult;
  /** Restart request override; direct servers fail closed on restart-required reloads. */
  hotReloadRecovery?: GatewayRestartEmitter;
};

export async function startGatewayServer(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  normalizeStateDirEnv(process.env);
  const [
    {
      OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
      OpenClawDatabaseSchemaPreflightError,
      preflightOpenClawDatabaseSchemas,
    },
    agentDatabase,
    stateDatabase,
  ] = await Promise.all([
    import("../state/openclaw-database-preflight.js"),
    import("../state/openclaw-agent-db.js"),
    import("../state/openclaw-state-db.js"),
  ]);
  const databaseSchemas = preflightOpenClawDatabaseSchemas({
    env: process.env,
    supportedVersions: {
      state: stateDatabase.OPENCLAW_STATE_SCHEMA_VERSION,
      agent: agentDatabase.OPENCLAW_AGENT_SCHEMA_VERSION,
    },
  });
  if (databaseSchemas.incompatible.length > 0) {
    for (const database of databaseSchemas.incompatible) {
      log.error("database schema preflight rejected newer schema", {
        kind: database.kind,
        path: database.path,
        ...(database.agentId ? { agentId: database.agentId } : {}),
        foundVersion: database.foundVersion,
        supportedVersion: database.supportedVersion,
        writerAppVersion: database.writerAppVersion ?? "unknown",
        docsUrl: OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
      });
    }
    throw new OpenClawDatabaseSchemaPreflightError(databaseSchemas.incompatible);
  }
  for (const database of databaseSchemas.indeterminate) {
    log.warn("database schema preflight could not inspect database; continuing to real open", {
      kind: database.kind,
      path: database.path,
      reason: database.reason,
      docsUrl: OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
    });
  }
  const { bootstrapGatewayNetworkRuntime } = await import("./server-network-runtime.js");
  bootstrapGatewayNetworkRuntime();

  const minimalTestGateway =
    isVitestRuntimeEnv() && process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1";
  const ambientEnvTriggers = opts.ambientEnvTriggers ?? "allow";

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

  const envBeforeStartupConfigLoad = { ...process.env };
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
  const startupAuthOverride = opts.auth ? structuredClone(opts.auth) : undefined;
  const startupTailscaleOverride = opts.tailscale ? structuredClone(opts.tailscale) : undefined;
  // Seed before secrets activation so every active/rollback snapshot carries
  // the same runtime-only browser origin baseline.
  const controlUiSeed = minimalTestGateway
    ? { config: configSnapshot.config, seededAllowedOrigins: false }
    : await startupTrace.measure("control-ui.seed", () =>
        maybeSeedControlUiAllowedOriginsAtStartup({
          config: configSnapshot.config,
          log,
          runtimeBind: opts.bind,
          runtimePort: port,
        }),
      );
  const startupConfigSnapshot = controlUiSeed.seededAllowedOrigins
    ? {
        ...configSnapshot,
        runtimeConfig: controlUiSeed.config,
        config: controlUiSeed.config,
      }
    : configSnapshot;

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
    channelAutostartSuppression: opts.channelAutostartSuppression,
    ...(startupConfigLoad.pluginMetadataSnapshot
      ? { pluginMetadataSnapshot: startupConfigLoad.pluginMetadataSnapshot }
      : {}),
  });
  let startupInternalWriteHash: string | null = null;
  let startupLastGoodSnapshot = configSnapshot;
  const startupActivationSourceConfig = configSnapshot.sourceConfig;
  const startupRuntimeConfig = captureConfigOverrideApplier()(startupConfigSnapshot.config);
  startupTrace.setConfig(startupRuntimeConfig);
  const { prepareGatewayStartupConfig } = await startupConfigModulePromise;
  const authBootstrap = await startupTrace.measure(
    "config.auth",
    () =>
      prepareGatewayStartupConfig({
        configSnapshot: startupConfigSnapshot,
        authOverride: startupAuthOverride,
        tailscaleOverride: startupTailscaleOverride,
        activateRuntimeSecrets,
        log,
        measure: (name, run, measureOptions) => startupTrace.measure(name, run, measureOptions),
      }),
    { omitErrorMessage: true },
  );
  const cfgAtStart = authBootstrap.cfg;
  startupTrace.setConfig(cfgAtStart);
  if (authBootstrap.generatedToken) {
    log.warn(formatRuntimeGatewayAuthTokenWarning());
  }
  // prepareGatewayStartupConfig has already applied startupAuthOverride to cfgAtStart,
  // so this warning follows the effective auth mode rather than dormant file config.
  const trustedProxyDeviceAutoApprove = cfgAtStart.gateway?.auth?.trustedProxy?.deviceAutoApprove;
  if (
    cfgAtStart.gateway?.auth?.mode === "trusted-proxy" &&
    trustedProxyDeviceAutoApprove?.enabled === true &&
    trustedProxyDeviceAutoApprove.scopes?.some((scope) => scope.trim() === ADMIN_SCOPE)
  ) {
    log.warn(
      "SECURITY WARNING: gateway.auth.trustedProxy.deviceAutoApprove.scopes includes operator.admin; every proxy-authenticated user can auto-approve a new browser device with full admin, and requests without scopes receive full admin automatically. Remove operator.admin to require manual approval until per-identity roles are available.",
    );
  }
  const resolvedStartupAuthOverride = startupAuthOverride
    ? (Object.fromEntries(
        (
          [
            "mode",
            "token",
            "password",
            "allowTailscale",
            "rateLimit",
            "trustedProxy",
          ] as const satisfies readonly (keyof GatewayAuthConfig)[]
        ).flatMap((key) => {
          if (startupAuthOverride[key] === undefined) {
            return [];
          }
          if ((key === "token" || key === "password") && isSecretRef(startupAuthOverride[key])) {
            return [];
          }
          const resolvedValue = cfgAtStart.gateway?.auth?.[key];
          return resolvedValue === undefined ? [] : [[key, structuredClone(resolvedValue)]];
        }),
      ) as GatewayAuthConfig)
    : undefined;
  const startupAuthSecretRefOverride = startupAuthOverride
    ? {
        ...(isSecretRef(startupAuthOverride.token)
          ? { token: structuredClone(startupAuthOverride.token) }
          : {}),
        ...(isSecretRef(startupAuthOverride.password)
          ? { password: structuredClone(startupAuthOverride.password) }
          : {}),
      }
    : undefined;
  const reloadAuthOverride = authBootstrap.generatedToken
    ? mergeGatewayAuthConfig(resolvedStartupAuthOverride, { token: authBootstrap.generatedToken })
    : resolvedStartupAuthOverride;
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
      getActiveGatewayRootWorkCount({ excludeCurrent: true }) +
      getActiveTaskCount(),
  );
  const seededControlUiAllowedOrigins = controlUiSeed.seededAllowedOrigins
    ? cfgAtStart.gateway?.controlUi?.allowedOrigins
    : undefined;
  const applyFixedGatewayOverlays = (config: OpenClawConfig): OpenClawConfig => {
    let runtimeConfig = config;
    if (reloadAuthOverride || startupTailscaleOverride) {
      runtimeConfig = {
        ...runtimeConfig,
        gateway: {
          ...runtimeConfig.gateway,
          ...(reloadAuthOverride
            ? { auth: mergeGatewayAuthConfig(runtimeConfig.gateway?.auth, reloadAuthOverride) }
            : {}),
          ...(startupTailscaleOverride
            ? {
                tailscale: mergeGatewayTailscaleConfig(
                  runtimeConfig.gateway?.tailscale,
                  startupTailscaleOverride,
                ),
              }
            : {}),
        },
      };
    }
    if (
      seededControlUiAllowedOrigins &&
      runtimeConfig.gateway?.controlUi?.allowedOrigins === undefined
    ) {
      runtimeConfig = {
        ...runtimeConfig,
        gateway: {
          ...runtimeConfig.gateway,
          controlUi: {
            ...runtimeConfig.gateway?.controlUi,
            allowedOrigins: seededControlUiAllowedOrigins,
          },
        },
      };
    }
    return runtimeConfig;
  };
  const applyReloadableGatewayAuthRefs = (config: OpenClawConfig): OpenClawConfig => {
    if (!startupAuthSecretRefOverride?.token && !startupAuthSecretRefOverride?.password) {
      return config;
    }
    return {
      ...config,
      gateway: {
        ...config.gateway,
        auth: mergeGatewayAuthConfig(config.gateway?.auth, startupAuthSecretRefOverride),
      },
    };
  };
  const prepareReloadCandidate = (params: {
    runtimeConfig: OpenClawConfig;
    sourceConfig: OpenClawConfig;
    previousSourceConfig?: OpenClawConfig;
  }) => {
    const previousSourceConfig =
      params.previousSourceConfig ??
      getRuntimeConfigSourceSnapshot() ??
      startupLastGoodSnapshot.sourceConfig;
    assertGatewayConfigEnvSelectionUnchanged(previousSourceConfig, params.sourceConfig);
    const runtimeEnv = prepareConfigRuntimeEnv({
      previousConfig: previousSourceConfig,
      nextConfig: params.sourceConfig,
    });
    const metadata = startupConfigLoad.pluginMetadataSnapshot;
    const pluginCandidate = minimalTestGateway
      ? { runtimeConfig: params.runtimeConfig, compareConfig: params.sourceConfig }
      : resolveGatewayReloadPluginActivationCandidate({
          ...params,
          env: runtimeEnv.env,
          ...(metadata?.manifestRegistry ? { manifestRegistry: metadata.manifestRegistry } : {}),
          discovery: metadata?.discovery,
          ambientEnvTriggers,
        });
    const applyCandidateOverrides = captureConfigOverrideApplier();
    const reapplyCompareOverlays = (config: OpenClawConfig): OpenClawConfig =>
      applyCandidateOverrides(
        mergeActivationSectionsIntoRuntimeConfig({
          runtimeConfig: config,
          activationConfig: pluginCandidate.compareConfig,
        }),
      );
    const reapplyRuntimeOverlays = (config: OpenClawConfig): OpenClawConfig =>
      applyFixedGatewayOverlays(applyReloadableGatewayAuthRefs(reapplyCompareOverlays(config)));
    return {
      runtimeConfig: reapplyRuntimeOverlays(params.runtimeConfig),
      compareConfig: reapplyCompareOverlays(params.sourceConfig),
      runtimeEnv,
      reapplyRuntimeOverlays,
      reapplyCompareOverlays,
    };
  };
  // Keep the old startup-write suppression path intact for compatibility with
  // callers that may still report a write, but startup itself no longer mutates config.
  if (startupConfigLoad.wroteConfig || authBootstrap.persistedGeneratedToken) {
    const startupSnapshot = await startupTrace.measure("config.final-snapshot", () =>
      readConfigFileSnapshot(),
    );
    startupInternalWriteHash = startupSnapshot.hash ?? null;
    startupLastGoodSnapshot = startupSnapshot;
  }
  setAppliedRuntimeConfigSnapshot(cfgAtStart, startupLastGoodSnapshot.sourceConfig);
  initializePublishedConfigRuntimeEnv(startupLastGoodSnapshot.sourceConfig, {
    ownedEnv: collectConfigRuntimeEnvOwnership(
      startupLastGoodSnapshot.sourceConfig,
      envBeforeStartupConfigLoad,
      process.env,
    ),
    preserveExistingOwnership: true,
  });
  const workerEnvironmentStartup = minimalTestGateway
    ? undefined
    : await startupTrace.measure("worker-environments.store-import", async () => {
        const workerModule = await loadWorkerEnvironmentStartupModule();
        return await workerModule.loadGatewayWorkerEnvironmentStartupState();
      });
  const { prepareGatewayPluginBootstrap } = await loadStartupPluginsModule();
  const pluginBootstrap = await startupTrace.measure("plugins.bootstrap", () =>
    prepareGatewayPluginBootstrap({
      cfgAtStart,
      activationSourceConfig: startupActivationSourceConfig,
      startupRuntimeConfig,
      pluginMetadataSnapshot: startupConfigLoad.pluginMetadataSnapshot,
      workerProviderIds: workerEnvironmentStartup?.durableProviderIds ?? [],
      minimalTestGateway,
      ambientEnvTriggers,
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
    ambientAutostartSuppressedChannelIds,
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
  const hasConfiguredWorkerProfiles =
    Object.keys(gatewayPluginConfigAtStart.cloudWorkers?.profiles ?? {}).length > 0;
  const shouldStartWorkerEnvironmentService =
    hasConfiguredWorkerProfiles ||
    Boolean(workerEnvironmentStartup?.records.length) ||
    Boolean(workerEnvironmentStartup?.hasNonlocalPlacementRecords);
  let resolveWorkerGatewayEndpoint: () =>
    | { host: "127.0.0.1" | "::1"; port: number }
    | undefined = () => undefined;
  const workerEnvironmentRuntime =
    workerEnvironmentStartup && shouldStartWorkerEnvironmentService
      ? await startupTrace.measure("worker-environments.runtime-imports", async () => {
          const workerModule = await loadWorkerEnvironmentStartupModule();
          return await workerModule.createGatewayWorkerEnvironmentRuntime({
            getPluginRegistry: () => pluginRegistry,
            resolveWorkerGateway: () => resolveWorkerGatewayEndpoint(),
            startup: workerEnvironmentStartup,
            log,
          });
        })
      : {};
  const { workerEnvironmentService, workerLiveEvents } = workerEnvironmentRuntime;
  // Assigned once approval managers exist; placement dispatch must not run before then.
  let revokeWorkerDispatchSessionAuthority = (_params: {
    sessionId: string;
    sessionKeys: readonly string[];
  }): void => {
    throw new Error("Worker dispatch authority revocation is not ready");
  };
  const workerPlacementRuntime =
    workerEnvironmentService && workerEnvironmentStartup
      ? await startupTrace.measure("worker-environments.placement-runtime", async () => {
          const placementModule = await loadWorkerPlacementStartupModule();
          return placementModule.createGatewayWorkerPlacementRuntime({
            placements: workerEnvironmentStartup.placementStore,
            environments: workerEnvironmentService,
            admitNewPlacements: hasConfiguredWorkerProfiles,
            revokeSessionAuthority: (request) => revokeWorkerDispatchSessionAuthority(request),
            warn: (message) => log.warn(message),
          });
        })
      : undefined;
  // Without configured profiles, existing placements still reconcile but new dispatches stay off.
  const workerPlacementControlAvailable = workerPlacementRuntime?.dispatchService;
  const workerPlacementDispatchAvailable = hasConfiguredWorkerProfiles
    ? workerPlacementControlAvailable
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
    uniqueStrings([...nextBaseGatewayMethods, ...listStartupChannelGatewayMethods()]).filter(
      (method) =>
        (workerPlacementDispatchAvailable || method !== "sessions.dispatch") &&
        (workerPlacementControlAvailable || method !== "sessions.reclaim"),
    );
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
      auth: resolvedStartupAuthOverride,
      tailscale: startupTailscaleOverride,
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
      authOverride: resolvedStartupAuthOverride,
      env: process.env,
      tailscaleMode,
    });
  const resolveSharedGatewaySessionGenerationForConfig = (config: OpenClawConfig) =>
    resolveSharedGatewaySessionGeneration(
      resolveGatewayAuth({
        authConfig: config.gateway?.auth,
        authOverride: resolvedStartupAuthOverride,
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
        authOverride: resolvedStartupAuthOverride,
        env: process.env,
        tailscaleMode,
      }),
      getRuntimeConfig().gateway?.trustedProxies,
    );
  const sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState = {
    current: resolveCurrentSharedGatewaySessionGeneration(),
    required: null,
  };
  const preauthHandshakeTimeoutMs = undefined;
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

  const { runDefaultChannelSetupWizard, runDefaultSetupWizard } =
    await import("./server-methods/wizard.js");
  const wizardRunner = opts.wizardRunner ?? runDefaultSetupWizard;
  const channelWizardRunner = opts.channelWizardRunner ?? runDefaultChannelSetupWizard;
  const { wizardSessions, findRunningWizard, purgeWizardSession } = createWizardSessionTracker();
  const systemAgentSessions: GatewayRequestContext["systemAgentSessions"] = new Map();

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
  let gatewayInstanceRuntime: GatewayInstanceRuntime | undefined;
  // Internal principals belong to this server generation and become usable only after bind.
  // Closing flips this first so delayed recovery/channel work cannot enter a retired context.
  let gatewayInstanceDispatchReady = false;
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
    getNativeApprovalRuntime: () => gatewayInstanceRuntime?.nativeApprovals,
    ambientAutostartSuppressedChannelIds,
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
    broadcastPluginEvent,
    getBufferedAmount,
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
    sessionEventSubscribers,
    sessionMessageSubscribers,
    getWorkerIngressEndpoint,
    getMcpAppSandboxPort,
    ensureSandboxHostPort,
  } = await startupTrace.measure("runtime.state", () =>
    createGatewayRuntimeState({
      cfg: cfgAtStart,
      getRuntimeConfig,
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
  const presenceWatchedSessions = (connId: string): string[] => {
    // Presence snapshots stay small even if a long-lived client accumulates
    // subscriptions. Keep only the 32 most recently subscribed session keys.
    return [...sessionMessageSubscribers.getForConnection(connId)].slice(-32).toSorted();
  };
  const updateWatchedSessionsPresence = (connId: string, previous: readonly string[]) => {
    const watchedSessions = presenceWatchedSessions(connId);
    if (
      watchedSessions.length === previous.length &&
      watchedSessions.every((key, index) => key === previous[index])
    ) {
      return;
    }
    const client = [...clients].find((candidate) => candidate.connId === connId);
    if (!client?.presenceKey) {
      return;
    }
    upsertPresence(client.presenceKey, {
      watchedSessions: watchedSessions.length > 0 ? watchedSessions : undefined,
    });
    broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion });
  };
  const subscribeSessionMessageEvents: GatewayRequestContext["subscribeSessionMessageEvents"] = (
    connId,
    sessionKey,
    options,
  ) => {
    const previous = presenceWatchedSessions(connId);
    const rollback = sessionMessageSubscribers.subscribe(connId, sessionKey, options);
    updateWatchedSessionsPresence(connId, previous);
    if (!rollback) {
      return undefined;
    }
    const rollbackPresence = (() => {
      const rollbackPrevious = presenceWatchedSessions(connId);
      rollback();
      updateWatchedSessionsPresence(connId, rollbackPrevious);
    }) as NonNullable<ReturnType<GatewayRequestContext["subscribeSessionMessageEvents"]>>;
    rollbackPresence.commit = () => rollback.commit();
    return rollbackPresence;
  };
  const unsubscribeSessionMessageEvents: GatewayRequestContext["unsubscribeSessionMessageEvents"] =
    (connId, sessionKey) => {
      const previous = presenceWatchedSessions(connId);
      sessionMessageSubscribers.unsubscribe(connId, sessionKey);
      updateWatchedSessionsPresence(connId, previous);
    };
  const restartRecoveryCandidates = new Map<string, RestartRecoveryCandidate>();
  const { createGatewayNodeSessionRuntime } = await import("./server-node-session-runtime.js");
  const {
    nodeRegistry,
    nodePresenceTimers,
    nodeSendToSession,
    nodeSendToAllSubscribed,
    nodeSubscribe,
    nodeUnsubscribe,
    nodeUnsubscribeAll,
    broadcastVoiceWakeChanged,
    broadcastVoiceWakeRoutingChanged,
    hasTalkNodeConnected,
  } = createGatewayNodeSessionRuntime({
    broadcast,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    listRegisteredNodePluginToolCommands: () => pluginRegistry.nodeHostCommands,
    nodePluginToolsEnabled: cfgAtStart.gateway?.nodes?.pluginTools?.enabled !== false,
    nodeSkillsEnabled: cfgAtStart.gateway?.nodes?.skills?.enabled !== false,
    onPairingInvalidated: ({ nodeId, connId }) => {
      upsertPresence(nodeId, { reason: "disconnect" });
      broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion });
      removeRemoteNodeInfoForConnection(nodeId, connId);
    },
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
        pairingGeneration: session.pairingGeneration,
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
  const { createTerminalSessionTransport } = await import("./terminal/gateway-transport.js");
  const terminalSessions = new TerminalSessionManager({
    ...createTerminalSessionTransport(broadcastToConnIds, getBufferedAmount),
    detachGraceMs:
      (cfgAtStart.gateway?.terminal?.detachedSessionTimeoutSeconds ??
        DEFAULT_TERMINAL_DETACH_SECONDS) * 1000,
  });
  applyGatewayLaneConcurrency(resolveGatewayLaneConcurrency(cfgAtStart), { gatewayStart: true });

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
  let retainedPluginCleanupHandle: { stop: () => void } | null = null;
  const clearPostReadyMaintenanceTimer = () => {
    if (!postReadyMaintenanceTimer) {
      return;
    }
    clearTimeout(postReadyMaintenanceTimer);
    postReadyMaintenanceTimer = null;
  };
  const markClosePreludeStarted = () => {
    closePreludeStarted = true;
    gatewayInstanceDispatchReady = false;
    gatewayInstanceRuntime?.close();
    cronReconciliation.invalidate();
    clearPostReadyMaintenanceTimer();
    retainedPluginCleanupHandle?.stop();
    retainedPluginCleanupHandle = null;
  };
  let configReloaderStopPromise: Promise<void> | null = null;
  const stopConfigReloaderForClose = () => {
    configReloaderStopPromise ??= runtimeState.configReloader.stop();
    return configReloaderStopPromise;
  };
  const beginClosePrelude = async () => {
    clearSessionSuspensionTimers();
    markClosePreludeStarted();
    // Join the last reload before any owner it can publish into is torn down.
    // The close handler re-awaits this same promise to retain warning reporting.
    await stopConfigReloaderForClose().catch(() => {});
  };
  const runClosePrelude = async () => {
    await beginClosePrelude();
    disposeNodeConnectionNotifications(nodeRegistry);
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
      stopChannelHealthMonitor: async () => {
        const monitor = runtimeState?.channelHealthMonitor;
        monitor?.shutdown();
        await monitor?.waitForIdle();
      },
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
      configReloader: { stop: stopConfigReloaderForClose },
      wss,
      httpServer,
      httpServers,
      drainActiveSessionsForShutdown,
    })(optsValue);
  };
  let clearFallbackGatewayContextForServer = () => {};
  const closeOnStartupFailure = async () => {
    try {
      await beginClosePrelude();
      await stopRegisteredGatewayLifetimeSidecars();
      await stopRegisteredPostReadySidecars();
      await runClosePrelude();
      await createCloseHandler()({ reason: "gateway startup failed" });
    } finally {
      clearFallbackGatewayContextForServer();
    }
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

    const { createOperatorApprovalSessionEventRuntime } =
      await import("./operator-approval-session-events.js");
    // Managers publish through this runtime, while replay routes durable
    // expiry back through the owning manager to release its parked waiter once.
    const approvalManagersForReplay = new Map<
      string,
      Pick<ExecApprovalManager, "reconcileDurableTerminal">
    >();
    const approvalSessionEvents = createOperatorApprovalSessionEventRuntime({
      clients,
      sessionMessageSubscribers,
      broadcastToConnIds,
      controlUiBasePath,
      reconcileTerminal: (record) => {
        const manager = approvalManagersForReplay.get(record.kind);
        return manager?.reconcileDurableTerminal(record) ?? false;
      },
    });

    const {
      execApprovalManager,
      cancelRunBoundApprovals,
      forwardPluginApprovalRequest,
      pluginApprovalIosPushDelivery,
      pluginApprovalManager,
      systemAgentApprovalManager,
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
          onApprovalLifecycle: approvalSessionEvents.publish,
        }),
        coreGatewayHandlers: coreGatewayHandlersLocal,
      };
    });
    approvalManagersForReplay.set("exec", execApprovalManager);
    approvalManagersForReplay.set("plugin", pluginApprovalManager);
    approvalManagersForReplay.set("system-agent", systemAgentApprovalManager);
    revokeWorkerDispatchSessionAuthority = ({ sessionId, sessionKeys }) => {
      const keys = new Set(sessionKeys);
      for (const sessionKey of keys) {
        revokeAttachGrantsForSession(sessionKey);
      }
      for (const record of execApprovalManager.listPendingRecords()) {
        if (approvalRequestTargetsSession(record.request, keys, sessionId)) {
          execApprovalManager.expire(record.id, "worker-dispatch");
        }
      }
      for (const record of pluginApprovalManager.listPendingRecords()) {
        if (approvalRequestTargetsSession(record.request, keys, sessionId)) {
          pluginApprovalManager.expire(record.id, "worker-dispatch");
        }
      }
    };
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
          (workerEnvironmentService ||
            (descriptor.name !== "environments.create" &&
              descriptor.name !== "environments.destroy")) &&
          (workerPlacementDispatchAvailable || descriptor.name !== "sessions.dispatch") &&
          (workerPlacementControlAvailable || descriptor.name !== "sessions.reclaim"),
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
      commitRuntime: () => Promise<void>;
      env: NodeJS.ProcessEnv;
      isAborted?: () => boolean;
    }): Promise<GatewayPluginReloadResult> => {
      const beforeChannelTargets = listAttachedChannelConfigTargets();
      const beforeChannelIds = new Set(beforeChannelTargets.keys());
      const [
        { loadPluginLookUpTable },
        { listAmbientOnlyConfiguredChannelIds },
        { prepareGatewayPluginLoad },
        { startPluginServices },
      ] = await Promise.all([
        import("../plugins/plugin-lookup-table.js"),
        import("../plugins/channel-presence-policy.js"),
        loadGatewayPluginBootstrapModule(),
        import("../plugins/services.js"),
      ]);
      const nextPluginActivationConfig = resolveGatewayStartupPluginActivationConfig({
        runtimeConfig: params.nextConfig,
        activationSourceConfig: params.nextConfig,
        env: params.env,
        ambientEnvTriggers,
      });
      const nextPluginLookUpTable = loadPluginLookUpTable({
        config: nextPluginActivationConfig,
        workspaceDir: defaultWorkspaceDir,
        env: params.env,
        activationSourceConfig: params.nextConfig,
        // Workers can be created after startup; reload planning needs the live durable set.
        workerProviderIds: workerEnvironmentStartup?.listDurableProviderIds() ?? [],
        ambientEnvTriggers,
      });
      const nextAmbientAutostartSuppressedChannelIds =
        ambientEnvTriggers === "suppress"
          ? new Set(
              listAmbientOnlyConfiguredChannelIds({
                config: params.nextConfig,
                activationSourceConfig: params.nextConfig,
                env: params.env,
                includePersistedAuthState: false,
                manifestRecords: nextPluginLookUpTable.manifestRegistry.plugins,
              }),
            )
          : new Set<string>();
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
      const previousPluginServices = runtimeState.pluginServices;
      await params.commitRuntime();
      channelManager.setAmbientAutostartSuppressedChannelIds(
        nextAmbientAutostartSuppressedChannelIds,
      );
      const loaded = prepareGatewayPluginLoad({
        cfg: params.nextConfig,
        workspaceDir: defaultWorkspaceDir,
        log,
        coreGatewayMethodNames,
        hostServices: pluginHostServices,
        baseMethods,
        pluginLookUpTable: nextPluginLookUpTable,
        ambientEnvTriggers,
      });
      setCurrentPluginMetadataSnapshot(nextPluginLookUpTable, {
        config: params.nextConfig,
        env: params.env,
        workspaceDir: defaultWorkspaceDir,
      });
      replaceAttachedPluginRuntime(loaded);
      runtimeState.pluginServices = null;
      if (previousPluginServices) {
        await previousPluginServices.stop();
      }
      await refreshAttachedGatewayDiscovery(loaded.pluginRegistry);
      runtimeState.pluginServices = await startPluginServices({
        registry: loaded.pluginRegistry,
        config: params.nextConfig,
        workspaceDir: defaultWorkspaceDir,
        broadcastPluginEvent,
      });
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
          ensureSandboxHostPort,
          resolveTerminalLaunchPolicy: terminalLaunchPolicy.resolve,
          isTerminalEnabled: terminalLaunchPolicy.isEnabled,
          execApprovalManager,
          cancelRunBoundApprovals,
          forwardPluginApprovalRequest,
          pluginApprovalIosPushDelivery,
          pluginApprovalManager,
          systemAgentApprovalManager,
          listSessionPendingApprovals: approvalSessionEvents.replay,
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
          ...(workerPlacementRuntime
            ? { workerSessionPlacementService: workerPlacementRuntime.placements }
            : {}),
          ...(workerPlacementControlAvailable
            ? { workerPlacementDispatchService: workerPlacementControlAvailable }
            : {}),
          terminalSessions,
          agentRunSeq,
          chatAbortControllers,
          chatQueuedTurns,
          chatAbortedRuns: chatRunState.abortedRuns,
          chatRunBuffers: chatRunState.buffers,
          chatRunPlanSnapshots: chatRunState.planSnapshots,
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
          subscribeSessionMessageEvents,
          unsubscribeSessionMessageEvents,
          unsubscribeAllSessionEvents: (connId: string) => {
            sessionEventSubscribers.unsubscribe(connId);
            sessionMessageSubscribers.unsubscribeAll(connId);
          },
          getSessionEventSubscriberConnIds: sessionEventSubscribers.getAll,
          registerToolEventRecipient: toolEventRecipients.add,
          dedupe,
          wizardSessions,
          systemAgentSessions,
          findRunningWizard,
          purgeWizardSession,
          getRuntimeSnapshot,
          getEventLoopHealth: readinessEventLoopHealth.snapshot,
          startChannel,
          stopChannel,
          markChannelLoggedOut,
          wizardRunner,
          channelWizardRunner,
          broadcastVoiceWakeChanged,
          unavailableGatewayMethods,
          broadcastVoiceWakeRoutingChanged,
        });
      },
    );
    currentPluginRegistryGatewayContext = gatewayRequestContext;
    const { createGatewayInstanceRuntime } = await import("./server-instance-runtime.js");
    const gatewayInstanceRuntimeLocal = createGatewayInstanceRuntime({
      getContext: () => gatewayRequestContext,
      getMethodRegistry: () => attachedGatewayMethodRegistry,
      isDispatchAvailable: () => gatewayInstanceDispatchReady && !closePreludeStarted,
      logError: (message) => log.error(message),
    });
    gatewayInstanceRuntime = gatewayInstanceRuntimeLocal;
    gatewayRequestContext.approvalEvents = gatewayInstanceRuntimeLocal.approvalEvents;
    gatewayRequestContext.recoveryRuntime = gatewayInstanceRuntimeLocal.recovery;

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
            ambientEnvTriggers,
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
        getPluginNodeCapabilities: () =>
          withCoreCanvasNodeCapability(
            listPluginNodeCapabilities(pluginRegistry),
            isCoreCanvasHostEnabled(getRuntimeConfig()),
          ),
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
    gatewayInstanceDispatchReady = true;
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
            broadcastPluginEvent,
            tailscaleMode,
            resetOnExit: tailscaleConfig.resetOnExit ?? false,
            serviceName: tailscaleConfig.serviceName,
            preserveFunnel: tailscaleConfig.preserveFunnel ?? false,
            controlUiBasePath,
            logTailscale,
            gatewayPluginConfigAtStart,
            activationSourceConfig: startupActivationSourceConfig,
            ambientEnvTriggers,
            pluginRegistry,
            defaultWorkspaceDir,
            deps,
            startChannels,
            recoveryRuntime: gatewayInstanceRuntimeLocal.recovery,
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
                    ambientEnvTriggers,
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
            ...(workerPlacementRuntime
              ? {
                  startWorkerEnvironmentRuntime: async () => {
                    if (closePreludeStarted) {
                      return null;
                    }
                    return await workerPlacementRuntime.startRuntime({
                      isClosePreludeStarted: () => closePreludeStarted,
                      // Close must see the drain handle before reconciliation can yield.
                      registerSidecar: (sidecar) => {
                        runtimeState.gatewayLifetimeSidecars.push(sidecar);
                      },
                    });
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
    if (!minimalTestGateway) {
      const { startOpenClawDatabaseIntegrityVerifier } =
        await import("../state/openclaw-database-verify.js");
      runtimeState.gatewayLifetimeSidecars.push(
        startOpenClawDatabaseIntegrityVerifier({ env: process.env }),
      );
    }
    postAttachRuntimeReturned = true;
    activateScheduledServicesWhenReady();

    const { startManagedGatewayConfigReloader } = await import("./server-reload-handlers.js");
    runtimeState.configReloader = startManagedGatewayConfigReloader({
      minimalTestGateway,
      initialConfig: cfgAtStart,
      initialCompareConfig: startupLastGoodSnapshot.sourceConfig,
      initialSnapshotRawHash: startupLastGoodSnapshot.exists
        ? (startupLastGoodSnapshot.hash ?? null)
        : null,
      initialAuthoredConfig: startupLastGoodSnapshot.parsed,
      initialIncludedPaths: startupLastGoodSnapshot.includedPaths ?? [],
      initialSnapshotValid: startupLastGoodSnapshot.valid,
      initialSnapshotIssues: startupLastGoodSnapshot.issues,
      initialInternalWriteHash: startupInternalWriteHash,
      watchPath: configSnapshot.path,
      readSnapshot: readConfigFileSnapshotForRuntimeTransaction,
      promoteSnapshot: promoteConfigSnapshotToLastKnownGood,
      subscribeToWrites: (listener) =>
        registerConfigWriteListener(listener, {
          ownsRuntimeActivationFor: configSnapshot.path,
          preCommitRuntimePreflight: async (sourceConfig, runtimeRefresh) => {
            const candidate = prepareReloadCandidate({
              runtimeConfig: sourceConfig,
              sourceConfig,
            });
            await activateRuntimeSecrets(candidate.runtimeConfig, {
              reason: "reload",
              activate: false,
              env: candidate.runtimeEnv.env,
              includeAuthStoreRefs: runtimeRefresh?.includeAuthStoreRefs,
            });
            return candidate;
          },
        }),
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
      prepareTerminalConfig: (plan, nextConfig) => {
        terminalLaunchPolicy.prepareConfig(nextConfig, { restartPending: plan.restartGateway });
      },
      reconcileTerminalSessions: () => {
        terminalSessions.closeDisallowedAgents(
          (agentId) => terminalLaunchPolicy.resolve(agentId).ok,
        );
      },
      commitTerminalConfig: (nextConfig) => {
        terminalLaunchPolicy.commitConfig();
        workerLiveEvents?.rebindAll(nextConfig);
      },
      acceptTerminalConfig: terminalLaunchPolicy.acceptConfig,
      channelManager,
      activateRuntimeSecrets,
      prepareConfigCandidate: prepareReloadCandidate,
      applyRuntimeConfigOverrides: applyFixedGatewayOverlays,
      resolveSharedGatewaySessionGenerationForConfig,
      sharedGatewaySessionGenerationState,
      clients,
      ...(opts.hotReloadRecovery ? { requestRecoveryRestart: opts.hotReloadRecovery } : {}),
      restartRecoveryAvailable: opts.hotReloadRecovery !== undefined,
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
      // The loop closes the previous server before this generation starts, so retired
      // plugin installs are safe to remove. Wait for an idle window and resolve current
      // install paths at execution time so cleanup cannot remove active code or delay a turn.
      retainedPluginCleanupHandle = gatewayRuntimeServices.scheduleGatewayIdleTask({
        delayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
        retryDelayMs: RETAINED_PLUGIN_CLEANUP_DELAY_MS,
        isClosing: () => closePreludeStarted,
        isBusy: () => getActiveGatewayRootWorkCount({ excludeCurrent: true }) > 0,
        run: async () => {
          const { cleanupRetainedPluginInstallGenerations } =
            await import("./server-retained-plugin-cleanup.js");
          await cleanupRetainedPluginInstallGenerations({ log });
        },
        log,
        errorMessage: "retained npm generation cleanup failed",
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
        await beginClosePrelude();
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
