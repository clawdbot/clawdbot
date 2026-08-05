import type { IncomingMessage, ServerResponse } from "node:http";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { listLoadedChannelPlugins } from "../channels/plugins/registry-loaded.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import { createDefaultDeps } from "../cli/deps.js";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNodeModeReadinessEvidenceResolver } from "../hosting/node-mode.js";
import {
  advisoryCriteriaForHostingProfile,
  buildHostingProfileSubjects,
  buildHostingProfileConditions,
  isReadinessCriterionSelectedByHostingProfile,
  requiredCriteriaForHostingProfile,
  resolveHostingProfileSelection,
} from "../hosting/profiles.js";
import { HOSTING_PROFILE_CONTRACT_VERSION } from "../hosting/types.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { runtimeForLogger } from "../logging/subsystem.js";
import {
  listActiveDegradedPlugins,
  toPublicPluginVerificationDiagnostic,
} from "../plugins/runtime-degraded-state.js";
import { isGatewayDraining } from "../process/command-queue.js";
import {
  isReadinessCriterionSelected,
  MODEL_ROUTE_READY_CRITERION_ID,
} from "../readiness/activation.js";
import { buildRuntimeReadiness, type PluginReadinessInput } from "../readiness/conditions.js";
import { captureExecutionCapabilityReadinessSnapshot } from "../readiness/execution-capabilities.js";
import { createSelectedReadinessResolver } from "../readiness/selection.js";
import { createGatewayReadinessIdentity } from "../readiness/subjects.js";
import type { RuntimeEnv } from "../runtime.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../secrets/runtime-state.js";
import { createAuthRateLimiter, type AuthRateLimiter } from "./auth-rate-limit.js";
import { resolveGatewayAuth } from "./auth.js";
import { isLoopbackHost } from "./net.js";
import { createNodeReapprovalCoordinator } from "./node-reapproval-coordinator.js";
import type { NodeSession } from "./node-registry.js";
import { resolveGatewayPluginConfig } from "./runtime-plugin-config.js";
import { createGatewayControlUiRootLifecycle } from "./server-control-ui-root.js";
import type { GatewayInstanceRuntime } from "./server-instance-runtime.types.js";
import type { GatewayServerLiveState } from "./server-live-state.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createGatewayRuntimeState } from "./server-runtime-state.js";
import type { SharedGatewaySessionGenerationState } from "./server-shared-auth-generation.js";
import type { prepareGatewayServerBootstrap } from "./server-startup-bootstrap.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";
import { createGatewayEventLoopHealthMonitor } from "./server/event-loop-health.js";
import { resolveHookClientIpConfig } from "./server/hook-client-ip-config.js";
import {
  createReadinessChecker,
  evaluateConfiguredGatewayReadiness,
  type CanonicalGatewayReadinessResult,
} from "./server/readiness.js";
import { loadGatewayTlsRuntime } from "./server/tls.js";
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

function buildGatewayPluginReadinessInput(
  registry: GatewayBootstrap["pluginBootstrap"]["pluginRegistry"],
): PluginReadinessInput {
  const errors = registry.plugins
    .filter((plugin) => plugin.status === "error")
    .map((plugin): PluginReadinessInput["errors"][number] => {
      const error: PluginReadinessInput["errors"][number] = {
        id: plugin.id,
        activated: plugin.activated === true,
        error: plugin.error ?? "unknown plugin load error",
      };
      if (plugin.activationSource) {
        error.activationSource = plugin.activationSource;
      }
      return error;
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const unavailable = listActiveDegradedPlugins()
    .map((plugin) => ({
      id: plugin.pluginId,
      diagnostic: toPublicPluginVerificationDiagnostic(plugin.diagnostic),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  return { errors, unavailable };
}

export async function prepareGatewayRuntimeState(params: {
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
  } = bootstrap;
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
  const makeState = (config: OpenClawConfig, registry: typeof pluginBootstrap.pluginRegistry) => {
    const profile = resolveHostingProfileSelection({
      config,
      env: process.env,
      override: opts.hostingProfileOverride,
    })?.profile;
    const profileCriteria = profile
      ? [
          ...requiredCriteriaForHostingProfile(profile),
          ...advisoryCriteriaForHostingProfile(profile),
        ]
      : [];
    return {
      config,
      registry,
      auth: getResolvedAuth(),
      executionCapabilities: captureExecutionCapabilityReadinessSnapshot(
        config,
        undefined,
        profileCriteria,
      ),
    };
  };
  const pluginRuntime = {
    registry: pluginBootstrap.pluginRegistry,
    baseGatewayMethods: pluginBootstrap.baseGatewayMethods,
    makeState,
    modelRouteReadinessStartupOptions: (config: OpenClawConfig) => {
      const profile = resolveHostingProfileSelection({
        config,
        env: process.env,
        override: opts.hostingProfileOverride,
      })?.profile;
      return isReadinessCriterionSelected(config, MODEL_ROUTE_READY_CRITERION_ID) ||
        (profile &&
          isReadinessCriterionSelectedByHostingProfile(profile, MODEL_ROUTE_READY_CRITERION_ID))
        ? { enabled: true as const }
        : {};
    },
    readinessSnapshot: makeState(cfgAtStart, pluginBootstrap.pluginRegistry),
  };
  // Unconfigured clean installs get no service; durable rows still need list/status projection.
  const hasConfiguredWorkerProfiles =
    Object.keys(gatewayPluginConfigAtStart.cloudWorkers?.profiles ?? {}).length > 0;
  const shouldStartWorkerEnvironmentService =
    hasConfiguredWorkerProfiles ||
    Boolean(workerEnvironmentStartup?.records.length) ||
    Boolean(workerEnvironmentStartup?.hasNonlocalPlacementRecords);
  const workerGatewayEndpoint = {
    resolve: (() => undefined) as () => { host: "127.0.0.1" | "::1"; port: number } | undefined,
  };
  const workerEnvironmentRuntime =
    workerEnvironmentStartup && shouldStartWorkerEnvironmentService
      ? await startupTrace.measure("worker-environments.runtime-imports", async () => {
          const workerModule = await loadWorkerEnvironmentStartupModule();
          return await workerModule.createGatewayWorkerEnvironmentRuntime({
            getPluginRegistry: () => pluginRuntime.registry,
            resolveWorkerGateway: () => workerGatewayEndpoint.resolve(),
            startup: workerEnvironmentStartup,
            log,
          });
        })
      : {};
  const { workerEnvironmentService, workerLiveEvents, workerTunnelManager } =
    workerEnvironmentRuntime;
  // Assigned once approval managers exist; placement dispatch must not run before then.
  const workerDispatchAuthority = {
    revoke: (_params: { sessionId: string; sessionKeys: readonly string[] }): void => {
      throw new Error("Worker dispatch authority revocation is not ready");
    },
  };
  const workerPlacementRuntime =
    workerEnvironmentService && workerEnvironmentStartup
      ? await startupTrace.measure("worker-environments.placement-runtime", async () => {
          const placementModule = await loadWorkerPlacementStartupModule();
          return placementModule.createGatewayWorkerPlacementRuntime({
            placements: workerEnvironmentStartup.placementStore,
            environments: workerEnvironmentService,
            admitNewPlacements: hasConfiguredWorkerProfiles,
            revokeSessionAuthority: (request) => workerDispatchAuthority.revoke(request),
            warn: (message) => log.warn(message),
          });
        })
      : undefined;
  // Without configured profiles, existing placements still reconcile but new dispatches stay off.
  const workerPlacementControlAvailable = workerPlacementRuntime?.dispatchService;
  const workerPlacementDispatchAvailable = hasConfiguredWorkerProfiles
    ? workerPlacementControlAvailable
    : undefined;
  const workerDesktopObserveAvailable =
    Boolean(workerEnvironmentService) && gatewayPluginConfigAtStart.cloudWorkers?.desktop === true;
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
        (workerPlacementControlAvailable || method !== "sessions.reclaim") &&
        (workerDesktopObserveAvailable || method !== "worker.desktop.observe"),
    );
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
  if (cfgAtStart.gateway?.tls?.enabled && !gatewayTls.enabled) {
    throw new Error(gatewayTls.error ?? "gateway tls: failed to enable");
  }
  const serverStartedAt = Date.now();
  const readinessEventLoopHealth = createGatewayEventLoopHealthMonitor();
  const startupState = {
    sidecarsReady: minimalTestGateway,
    pendingReason: "startup-sidecars",
    dispatchReady: false,
  };
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
  const isGatewayStartupPending = () => !startupState.sidecarsReady && sidecarStartup === "start";
  const getGatewayReadiness = createReadinessChecker({
    channelManager,
    startedAt: serverStartedAt,
    getStartupPending: isGatewayStartupPending,
    getStartupPendingReason: () => startupState.pendingReason,
    getGatewayDraining: isGatewayDraining,
    getEventLoopHealth: readinessEventLoopHealth.snapshot,
    shouldSkipChannelReadiness: () =>
      isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
      isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS),
  });
  const readinessIdentity = createGatewayReadinessIdentity();
  const resolveSelectedReadiness = createSelectedReadinessResolver();
  const resolveNodeModeReadiness = createNodeModeReadinessEvidenceResolver();
  const nodeReadiness = {
    listConnected: (): NodeSession[] => [],
  };
  const evaluateRuntimeReadiness = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const snapshot = pluginRuntime.readinessSnapshot;
      const profileSelection = resolveHostingProfileSelection({
        config: snapshot.config,
        env: process.env,
        override: opts.hostingProfileOverride,
      });
      const profile = profileSelection?.profile;
      const auth = snapshot.auth;
      const [nodeMode, contribution] = await Promise.all([
        profile === "node-mode"
          ? resolveNodeModeReadiness({
              config: snapshot.config,
              connectedNodes: nodeReadiness.listConnected(),
            })
          : Promise.resolve(undefined),
        resolveSelectedReadiness({
          config: snapshot.config,
          registry: snapshot.registry,
          executionCapabilities: snapshot.executionCapabilities,
          env: process.env,
          stateServices: {
            scheduler: runtimeStateRef.current?.cronState.cron.getReadinessSnapshot(),
          },
          additionalAdvisoryCriteria: profile ? advisoryCriteriaForHostingProfile(profile) : [],
          additionalRequiredCriteria: profile ? requiredCriteriaForHostingProfile(profile) : [],
        }),
      ]);
      const profileConditions = profile
        ? buildHostingProfileConditions(
            profile,
            {
              bind: opts.bind ?? snapshot.config.gateway?.bind ?? "loopback",
              bindHost,
              port,
              authMode: auth.mode,
              trustedProxyUserHeader: auth.trustedProxy?.userHeader,
              trustedProxySources: snapshot.config.gateway?.trustedProxies ?? [],
              trustedProxyAllowLoopback: auth.trustedProxy?.allowLoopback === true,
            },
            nodeMode,
          )
        : [];
      const profileSubjects = profileSelection
        ? buildHostingProfileSubjects(profileSelection, nodeMode)
        : [];
      if (snapshot !== pluginRuntime.readinessSnapshot) {
        continue;
      }
      return buildRuntimeReadiness({
        identity: readinessIdentity,
        configLoaded: true,
        gateway: "responding",
        plugins: buildGatewayPluginReadinessInput(snapshot.registry),
        pluginsRequired:
          profile !== undefined &&
          requiredCriteriaForHostingProfile(profile).includes("openclaw.plugins-loaded"),
        additionalConditions: [...profileConditions, ...contribution.conditions],
        additionalSubjects: [...profileSubjects, ...contribution.subjects],
      });
    }
    throw new Error("Readiness runtime changed while it was being evaluated.");
  };
  const getReadiness = (): Promise<CanonicalGatewayReadinessResult> => {
    const snapshot = pluginRuntime.readinessSnapshot;
    const profileSelection = resolveHostingProfileSelection({
      config: snapshot.config,
      env: process.env,
      override: opts.hostingProfileOverride,
    });
    const failureContext = profileSelection
      ? {
          conditions: buildHostingProfileConditions(profileSelection.profile, {
            bind: opts.bind ?? snapshot.config.gateway?.bind ?? "loopback",
            bindHost,
            port,
            authMode: snapshot.auth.mode,
            trustedProxyUserHeader: snapshot.auth.trustedProxy?.userHeader,
            trustedProxySources: snapshot.config.gateway?.trustedProxies ?? [],
            trustedProxyAllowLoopback: snapshot.auth.trustedProxy?.allowLoopback === true,
          }).filter((condition) => condition.type === "ProfileSelected"),
          subjects: buildHostingProfileSubjects(profileSelection),
        }
      : undefined;
    return evaluateConfiguredGatewayReadiness({
      config: snapshot.config,
      identity: readinessIdentity,
      canonicalEvaluationEnabled: profileSelection !== undefined,
      failureContext,
      profileMetadata: profileSelection
        ? {
            profileContractVersion: HOSTING_PROFILE_CONTRACT_VERSION,
            profile: profileSelection.profile,
            profileSource: profileSelection.source,
          }
        : undefined,
      evaluateGateway: getGatewayReadiness,
      evaluateRuntime: evaluateRuntimeReadiness,
    });
  };
  log.info("starting HTTP server...");
  const pluginGatewayContext: { current: GatewayRequestContext | undefined } = {
    current: undefined,
  };
  const watchNodeRequestHandler: {
    current?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
  } = {};
  const {
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
      controlUiRoot: controlUiRootLifecycle.state,
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
      handleWatchNodeRequest: async (req, res) =>
        (await watchNodeRequestHandler.current?.(req, res)) ?? false,
      workerIngressEnabled: Boolean(workerEnvironmentService),
      workerDesktopTunnels: workerTunnelManager?.desktop,
    }),
  );

  return {
    ...bootstrap,
    pluginRuntime,
    nodeReadiness,
    hasConfiguredWorkerProfiles,
    workerEnvironmentService,
    workerLiveEvents,
    workerDispatchAuthority,
    workerPlacementRuntime,
    workerPlacementControlAvailable,
    workerPlacementDispatchAvailable,
    workerDesktopObserveAvailable,
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
    releaseStartupAccountStarts,
    gatewayInstanceRuntimeRef,
    channelManager,
    sidecarStartup,
    isGatewayStartupPending,
    getReadiness,
    pluginGatewayContext,
    watchNodeRequestHandler,
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
    workerGatewayEndpoint,
  };
}
