import type { IncomingMessage, ServerResponse } from "node:http";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { createDefaultDeps } from "../cli/deps.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { loadGatewayTlsRuntime } from "../infra/tls/gateway.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { runtimeForLogger } from "../logging/subsystem.js";
import { isGatewayDraining } from "../process/command-queue.js";
import type { RuntimeEnv } from "../runtime.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { NODE_DESKTOP_STREAM_COMMAND } from "../shared/node-desktop-stream.js";
import { openClawStateDatabaseCache } from "../state/openclaw-state-db-cache.js";
import { resolveDatabasePath } from "../state/openclaw-state-db-maintenance.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { resolveGatewayAuth } from "./auth.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import { isLoopbackHost } from "./net.js";
import { createNodeReapprovalCoordinator } from "./node-reapproval-coordinator.js";
import { resolveGatewayPluginConfig } from "./runtime-plugin-config.js";
import { createGatewayConnectionState } from "./server-connection-state.js";
import { createGatewayControlUiRootLifecycle } from "./server-control-ui-root.js";
import type { GatewayInstanceRuntime } from "./server-instance-runtime.types.js";
import type { GatewayServerLiveState } from "./server-live-state.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import type { prepareGatewayServerBootstrap } from "./server-startup-bootstrap.js";
import { createGatewayTransportBridge } from "./server-transport-bridge.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";
import { createGatewayEventLoopHealthMonitor } from "./server/event-loop-health.js";
import { resolveHookClientIpConfig } from "./server/hook-client-ip-config.js";
import { createReadinessChecker, createStartupChecker } from "./server/readiness.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

type GatewayBootstrap = Awaited<ReturnType<typeof prepareGatewayServerBootstrap>>;
type GatewayLogger = ReturnType<typeof createSubsystemLogger>;
type ChannelRuntime = ReturnType<
  (typeof import("../plugins/runtime/runtime-channel.js"))["createRuntimeChannel"]
>;

type AuthRateLimitConfig = Parameters<typeof createAuthRateLimiter>[0];

function createGatewayAuthRateLimiters(rateLimitConfig: AuthRateLimitConfig | undefined): {
  rateLimiter: AuthRateLimiter;
  browserRateLimiter: AuthRateLimiter;
} {
  // Remote non-browser and HTTP attempts keep the normal loopback exemption.
  const rateLimiter = createAuthRateLimiter(rateLimitConfig ?? {});
  // Browser-origin WebSocket attempts are always throttled, including loopback.
  const browserRateLimiter = createAuthRateLimiter({ ...rateLimitConfig, exemptLoopback: false });
  return { rateLimiter, browserRateLimiter };
}

type GatewayStartupChannelPlugin = {
  id: ChannelId;
  gatewayMethods?: readonly string[];
  gatewayMethodDescriptors?: readonly { name: string }[];
  meta: { aliases?: readonly string[] };
};

function listGatewayStartupChannelPlugins(): GatewayStartupChannelPlugin[] {
  return listLoadedChannelPlugins() as GatewayStartupChannelPlugin[];
}

export async function prepareGatewayKernelState(params: {
  bootstrap: GatewayBootstrap;
  port: number;
  opts: GatewayBootstrap["opts"];
  log: GatewayLogger;
  logChannels: GatewayLogger;
  logHooks: GatewayLogger;
  logPlugins: GatewayLogger;
  gatewayRuntime: ReturnType<typeof import("../logging/subsystem.js").runtimeForLogger>;
  resolveChannelRuntime: () => Promise<ChannelRuntime>;
  loadWorkerEnvironmentStartupModule: () => Promise<
    typeof import("./server-worker-environment-startup.js")
  >;
  loadWorkerPlacementStartupModule: () => Promise<
    typeof import("./server-worker-placement-startup.js")
  >;
}) {
  const {
    bootstrap,
    port,
    opts,
    log,
    logChannels,
    logHooks,
    logPlugins,
    gatewayRuntime,
    resolveChannelRuntime: getChannelRuntime,
    loadWorkerEnvironmentStartupModule,
    loadWorkerPlacementStartupModule,
  } = params;
  const {
    pluginBootstrap,
    gatewayPluginConfigAtStart,
    workerEnvironmentStartup,
    startupTrace,
    cfgAtStart,
    resolvedStartupAuthOverride,
    startupTailscaleOverride,
    ambientAutostartSuppressedChannelIds,
    minimalTestGateway,
    pluginGatewayContext,
  } = bootstrap;
  const pluginRuntime = {
    registry: pluginBootstrap.pluginRegistry,
    baseGatewayMethods: pluginBootstrap.baseGatewayMethods,
  };
  // The core device provider is configuration-free, so every full Gateway owns the
  // worker service even when no plugin-backed cloud profile has been configured.
  const shouldStartWorkerEnvironmentService = Boolean(workerEnvironmentStartup);
  const hostDesktopConfig = gatewayPluginConfigAtStart.desktop?.host;
  const hostDesktopEnabled = hostDesktopConfig?.enabled === true;
  const nodeCommandConfig = gatewayPluginConfigAtStart.gateway?.nodes?.commands;
  const nodeDesktopObserveAvailable =
    (nodeCommandConfig?.allow ?? []).some(
      (command) => command.trim() === NODE_DESKTOP_STREAM_COMMAND,
    ) &&
    !(nodeCommandConfig?.deny ?? []).some(
      (command) => command.trim() === NODE_DESKTOP_STREAM_COMMAND,
    );
  const workerDesktopObserveAvailable =
    shouldStartWorkerEnvironmentService &&
    gatewayPluginConfigAtStart.cloudWorkers?.desktop === true;
  const desktopSessionRegistry =
    shouldStartWorkerEnvironmentService || hostDesktopEnabled || nodeDesktopObserveAvailable
      ? createDesktopSessionRegistry()
      : undefined;
  const nodeDesktopStreamBroker =
    nodeDesktopObserveAvailable || shouldStartWorkerEnvironmentService
      ? (
          await startupTrace.measure(
            "node-desktop.runtime-import",
            () => import("./desktop/node-stream-broker.js"),
          )
        ).createNodeDesktopStreamBroker()
      : undefined;
  const hostDesktopService =
    hostDesktopConfig && hostDesktopEnabled && desktopSessionRegistry
      ? (
          await startupTrace.measure(
            "host-desktop.runtime-import",
            () => import("./desktop/host-source.js"),
          )
        ).createHostDesktopService({
          config: hostDesktopConfig,
          registry: desktopSessionRegistry,
        })
      : undefined;
  const workerEnvironmentRuntime =
    workerEnvironmentStartup && desktopSessionRegistry
      ? await startupTrace.measure("worker-environments.runtime-imports", async () => {
          const workerModule = await loadWorkerEnvironmentStartupModule();
          return await workerModule.createGatewayWorkerEnvironmentRuntime({
            getPluginRegistry: () => pluginRuntime.registry,
            getPortalRuntime: () => pluginGatewayContext.current,
            resolveGatewayContext: () => pluginGatewayContext.current,
            desktopSessionRegistry,
            ...(nodeDesktopStreamBroker ? { nodeDesktopStreamBroker } : {}),
            startup: workerEnvironmentStartup,
            log,
          });
        })
      : {};
  const {
    workerEnvironmentService,
    workerLiveEvents,
    nodeWorkerGatewayNamespace,
    bindDeviceNodeControl,
    bindWorkerNodeDesktopControl,
    bindNodeWorkspaceBindingResolver,
    bindGitHubPublication,
    handleNodeWorkerBundleTransferRequest,
    handleWorkerBootstrapArtifactTransferRequest,
    handleNodeWorkspaceTransferRequest,
  } = workerEnvironmentRuntime;
  // Assigned once approval managers exist; placement dispatch must not run before then.
  const workerDispatchAuthority = {
    revoke: (_params: { sessionId: string; sessionKeys: readonly string[] }): void => {
      throw new Error("Worker dispatch authority revocation is not ready");
    },
  };
  const workerPlacementModule = workerEnvironmentStartup
    ? await startupTrace.measure(
        "worker-environments.placement-module",
        loadWorkerPlacementStartupModule,
      )
    : undefined;
  const githubPublicationRuntime =
    workerEnvironmentStartup && workerPlacementModule
      ? workerPlacementModule.createGatewayGitHubPublicationRuntime({
          placements: workerEnvironmentStartup.placementStore,
          warn: (message) => log.warn(message),
        })
      : undefined;
  const workerPlacementRuntime =
    workerEnvironmentService &&
    workerEnvironmentStartup &&
    nodeWorkerGatewayNamespace &&
    workerPlacementModule
      ? await startupTrace.measure("worker-environments.placement-runtime", async () =>
          workerPlacementModule.createGatewayWorkerPlacementRuntime({
            placements: workerEnvironmentStartup.placementStore,
            environments: workerEnvironmentService,
            gatewayNamespace: nodeWorkerGatewayNamespace,
            getSessionChangeContext: () => pluginGatewayContext.current,
            persistAbandonedPartial: async ({ sessionId, sessionKey, agentId, runId }) => {
              // Placement runtime starts before chat state exists; moves invoke this only after startup.
              const text = connectionState.chatRunState.resolveBuffer(runId, { final: true }).text;
              if (!text.trim()) {
                return;
              }
              const { persistAbortedPartials } =
                await import("./server-methods/chat-abort-runtime.js");
              await persistAbortedPartials({
                context: { logGateway: log },
                sessionKey,
                snapshots: [{ sessionId, agentId, runId, text, abortOrigin: "placement-abandon" }],
              });
            },
            cancelSessionWork: async (request) => {
              const context = pluginGatewayContext.current;
              if (!context) {
                throw new Error("Worker session cancellation is not ready");
              }
              const { cancelGatewayWorkerSessionWork } =
                await import("./server-worker-placement-cancel.js");
              await cancelGatewayWorkerSessionWork(context, request);
            },
            revokeSessionAuthority: (request) => workerDispatchAuthority.revoke(request),
            info: (message) => log.info(message),
            warn: (message) => log.warn(message),
            ...(githubPublicationRuntime ? { githubPublicationRuntime } : {}),
          }),
        )
      : undefined;
  if (workerPlacementRuntime) {
    bindNodeWorkspaceBindingResolver?.(workerPlacementRuntime.resolveNodeWorkspaceBinding);
    workerEnvironmentRuntime.bindWorkerSessionDispatch?.(
      workerPlacementRuntime.dispatchService.dispatch,
    );
  }
  if (githubPublicationRuntime) {
    bindGitHubPublication?.(githubPublicationRuntime.coordinator);
  }
  const bindDeviceNodeRuntime = bindDeviceNodeControl
    ? (transport: Parameters<NonNullable<typeof bindDeviceNodeControl>>[0]) => {
        bindDeviceNodeControl(transport);
        workerPlacementRuntime?.bindNodeWorkerSupervisorTransport(transport);
      }
    : undefined;
  const workerPlacementControlAvailable = workerPlacementRuntime?.dispatchService;
  const workerPlacementDispatchAvailable = workerPlacementControlAvailable;
  const desktopObserveAvailable =
    workerDesktopObserveAvailable || nodeDesktopObserveAvailable || Boolean(hostDesktopService);
  const channelLogs = Object.fromEntries(
    listGatewayStartupChannelPlugins().map((plugin) => [plugin.id, logChannels.child(plugin.id)]),
  ) as Record<ChannelId, ReturnType<typeof createSubsystemLogger>>;
  const channelRuntimeEnvs: Partial<Record<ChannelId, RuntimeEnv>> = Object.fromEntries(
    Object.entries(channelLogs).map(([id, logger]) => [id, runtimeForLogger(logger)]),
  );
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
        (workerPlacementControlAvailable ||
          (method !== "sessions.reclaim" && method !== "sessions.move")) &&
        (desktopObserveAvailable || method !== "desktop.observe") &&
        (workerDesktopObserveAvailable ||
          (method !== "desktop.launch" &&
            method !== "worker.desktop.observe" &&
            method !== "worker.desktop.launch")),
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
  if (bootstrap.generatedStartupAuthToken && isLoopbackHost(bindHost)) {
    const { ensureStartupLocalCliPairing } = await import("./startup-local-cli-pairing.js");
    const pairingResult = await startupTrace.measure("runtime.local-cli-pairing", () =>
      ensureStartupLocalCliPairing(),
    );
    if (pairingResult === "created") {
      log.info("runtime-only gateway auth paired the local CLI device before readiness");
    } else if (pairingResult === "unavailable") {
      log.warn(
        "runtime-only gateway auth could not prepare local CLI device credentials; configure gateway.auth.token or gateway.auth.password for CLI access",
      );
    }
  }
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

  const controlUiRootLifecycle = await startupTrace.measure("control-ui.root", () =>
    createGatewayControlUiRootLifecycle({
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
  const runtimeStateRef: { current: GatewayServerLiveState | null } = { current: null };
  const cronStartState = { handled: false };
  const gatewayTls = await startupTrace.measure("tls.runtime", () =>
    loadGatewayTlsRuntime(cfgAtStart.gateway?.tls, log.child("tls")),
  );
  const serverStartedAt = Date.now();
  const readinessEventLoopHealth = createGatewayEventLoopHealthMonitor();
  const startupState = {
    sidecarsReady: minimalTestGateway,
    pendingReason: "startup-sidecars",
    dispatchReady: false,
  };
  const lifecycle = { closePreludeStarted: false };
  let releaseStartupAccountStarts = () => {};
  const startupAccountStartsReady = new Promise<void>((resolve) => {
    releaseStartupAccountStarts = resolve;
  });
  const gatewayInstanceRuntimeRef: { current: GatewayInstanceRuntime | undefined } = {
    current: undefined,
  };
  // Internal principals belong to this server generation and become usable only after bind.
  // Closing flips this first so delayed recovery/channel work cannot enter a retired context.

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
    getPluginHttpRouteRegistry: () => pluginRuntime.registry,
    startupTrace,
    deferStartupAccountStartsUntil: startupAccountStartsReady,
    getNativeApprovalRuntime: () => gatewayInstanceRuntimeRef.current?.nativeApprovals,
    ambientAutostartSuppressedChannelIds,
    ...(opts.tryRecoverChannelAutostartSuppression
      ? { tryRecoverAutostartSuppression: opts.tryRecoverChannelAutostartSuppression }
      : {}),
  });
  channelManager.setAutostartSuppression(opts.channelAutostartSuppression ?? null);
  const sidecarStartup = opts.sidecarStartup ?? "start";
  const isGatewayStartupPending = () =>
    !startupState.sidecarsReady && !lifecycle.closePreludeStarted;
  const startupCheckerDeps = {
    startedAt: serverStartedAt,
    getStartupPending: isGatewayStartupPending,
    getStartupPendingReason: () => startupState.pendingReason,
    getGatewayDraining: () => lifecycle.closePreludeStarted || isGatewayDraining(),
  };
  const getStartup = createStartupChecker(startupCheckerDeps);
  const getReadiness = createReadinessChecker({
    channelManager,
    ...startupCheckerDeps,
    getEventLoopHealth: readinessEventLoopHealth.snapshot,
    getStateDatabaseFailure: () =>
      openClawStateDatabaseCache.getOpenClawStateDatabaseRuntimeFailure(resolveDatabasePath()),
    shouldSkipChannelReadiness: () =>
      isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
      isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS),
  });
  const watchNodeRequestHandler: {
    current?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  } = {};
  // Preserve the operator-visible startup log order even though transport binds later.
  log.info("starting HTTP server...");
  const connectionState = await startupTrace.measure("runtime.state", () =>
    createGatewayConnectionState({
      cfg: cfgAtStart,
      getRuntimeConfig,
    }),
  );
  const transportBridge = createGatewayTransportBridge();
  const createHttpTransportOptions = () => ({
    cfg: cfgAtStart,
    getRuntimeConfig,
    bindHost,
    port,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot: controlUiRootLifecycle.state,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    resolvedAuth,
    rateLimiter: authRateLimiter,
    joinRateLimiter: browserAuthRateLimiter,
    isTerminalEnabled: terminalLaunchPolicy.isEnabled,
    gatewayTls,
    getResolvedAuth,
    hooksConfig: () => runtimeStateRef.current?.hooksConfig ?? initialHooksConfig,
    getHookClientIpConfig: () =>
      runtimeStateRef.current?.hookClientIpConfig ?? initialHookClientIpConfig,
    pluginRegistry: pluginRuntime.registry,
    getPluginRouteRegistry: () => pluginRuntime.registry,
    isStartupPluginRuntimeReady: () => startupState.sidecarsReady,
    getGatewayRequestContext: () => pluginGatewayContext.current,
    deps,
    log,
    logHooks,
    logPlugins,
    getReadiness,
    getStartup,
    isStartupPending: isGatewayStartupPending,
    handleWatchNodeRequest: async (req: IncomingMessage, res: ServerResponse) =>
      (await watchNodeRequestHandler.current?.(req, res)) ?? false,
    handleNodeWorkerBundleTransferRequest,
    handleWorkerBootstrapArtifactTransferRequest,
    handleNodeWorkspaceTransferRequest,
    workerIngressEnabled: Boolean(workerEnvironmentService),
    desktopSessionRegistry,
    nodeDesktopStreamBroker,
    clients: connectionState.clients,
    tailscaleMode,
  });
  const {
    clients,
    broadcast,
    broadcastToConnIds,
    broadcastPluginEvent,
    getBufferedAmount,
    agentRunSeq,
    dedupe,
    chatRunState,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    chatQueuedTurns,
    toolEventRecipients,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    isConnectionActive,
  } = connectionState;

  return {
    ...bootstrap,
    pluginRuntime,
    workerEnvironmentService,
    workerLiveEvents,
    bindDeviceNodeControl: bindDeviceNodeRuntime,
    bindWorkerNodeDesktopControl,
    workerDispatchAuthority,
    workerPlacementRuntime,
    githubPublicationRuntime,
    githubPublicationService: githubPublicationRuntime?.coordinator,
    workerPlacementControlAvailable,
    workerPlacementDispatchAvailable,
    workerDesktopObserveAvailable,
    desktopObserveAvailable,
    desktopSessionRegistry,
    nodeDesktopObserveAvailable,
    nodeDesktopStreamBroker,
    hostDesktopService,
    channelLogs,
    channelRuntimeEnvs,
    listStartupChannelGatewayMethods,
    listActiveGatewayMethods,
    bindHost,
    controlUiEnabled,
    controlUiRootLifecycle,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    controlUiBasePath,
    resolvedAuth,
    tailscaleConfig,
    tailscaleMode,
    getResolvedAuth,
    resolveSharedGatewaySessionGenerationForConfig,
    resolveSharedGatewaySessionGenerationForRuntimeSnapshot,
    sharedGatewaySessionGenerationState,
    preauthHandshakeTimeoutMs,
    initialHooksConfig,
    initialHookClientIpConfig,
    authRateLimiter,
    browserAuthRateLimiter,
    nodeReapprovalCoordinator,
    terminalLaunchPolicy,
    wizardRunner,
    channelWizardRunner,
    wizardSessions,
    findRunningWizard,
    purgeWizardSession,
    systemAgentSessions,
    deps,
    runtimeStateRef,
    cronStartState,
    gatewayTls,
    readinessEventLoopHealth,
    startupState,
    lifecycle,
    releaseStartupAccountStarts,
    gatewayInstanceRuntimeRef,
    channelManager,
    sidecarStartup,
    isGatewayStartupPending,
    pluginGatewayContext,
    watchNodeRequestHandler,
    createHttpTransportOptions,
    transportBridge,
    clients,
    broadcast,
    broadcastToConnIds,
    broadcastPluginEvent,
    getBufferedAmount,
    agentRunSeq,
    dedupe,
    chatRunState,
    addChatRun,
    removeChatRun,
    chatAbortControllers,
    chatQueuedTurns,
    toolEventRecipients,
    sessionEventSubscribers,
    sessionMessageSubscribers,
    isConnectionActive,
    getTailscaleIngressEndpoint: transportBridge.getTailscaleIngressEndpoint,
    getMcpAppSandboxPort: transportBridge.getMcpAppSandboxPort,
    ensureSandboxHostPort: transportBridge.ensureSandboxHostPort,
    getPortalService: transportBridge.getPortalService,
  };
}
