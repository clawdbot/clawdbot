import { performance } from "node:perf_hooks";
import { getActiveBackgroundExecSessionCount } from "../agents/bash-process-registry.js";
import { getActiveEmbeddedRunCount } from "../agents/embedded-agent-runner/active-run-projections.js";
import { getTotalPendingReplies } from "../auto-reply/reply/dispatcher-registry.js";
import { isRestartEnabled } from "../config/commands.flags.js";
import {
  collectConfigRuntimeEnvOwnership,
  initializePublishedConfigRuntimeEnv,
  prepareConfigRuntimeEnv,
} from "../config/config-env-vars.js";
import { assertGatewayConfigEnvSelectionUnchanged } from "../config/gateway-env-selection.js";
import {
  getRuntimeConfigSourceSnapshot,
  readConfigFileSnapshot,
  setAppliedRuntimeConfigSnapshot,
} from "../config/io.js";
import { normalizeStateDirEnv } from "../config/paths.js";
import {
  copyConfigResolutionFacts,
  copyConfigResolutionFactsExcept,
} from "../config/resolution-facts.js";
import { captureConfigOverrideApplier } from "../config/runtime-overrides.js";
import { resolveSystemMainSessionTarget } from "../config/sessions.js";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef } from "../config/types.secrets.js";
import { getActiveCronJobCount } from "../cron/active-jobs.js";
import {
  isDiagnosticsEnabled,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { isVitestRuntimeEnv, logAcceptedEnvOption } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { prepareGatewayAgentCliShim } from "../infra/openclaw-cli-shim.js";
import { readGatewayRestartHandoffSync } from "../infra/restart-handoff.js";
import { setGatewaySigusr1RestartPolicy, setPreRestartDeferralCheck } from "../infra/restart.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { applyLoggingConfig } from "../logging/logger.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { setGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import { getTotalQueueSize } from "../process/command-queue.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { createLazyPromise } from "../shared/lazy-runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../state/openclaw-state-ownership.js";
import { ADMIN_SCOPE } from "./method-scopes.js";
import { listCoreGatewayMethodNames } from "./methods/core-descriptors.js";
import {
  mergeActivationSectionsIntoRuntimeConfig,
  resolveGatewayReloadPluginActivationCandidate,
} from "./plugin-activation-runtime-config.js";
import {
  resumeGatewayRestartTraceFromEnv,
  resumeGatewayRestartTraceFromHandoff,
} from "./restart-trace.js";
import type { GatewayServerOptions } from "./server-public.js";
import { createGatewayStartupTrace } from "./server-startup-trace.js";
import { mergeGatewayAuthConfig, mergeGatewayTailscaleConfig } from "./startup-auth.js";
import { maybeSeedControlUiAllowedOriginsAtStartup } from "./startup-control-ui-origins.js";

type GatewayLogger = ReturnType<typeof createSubsystemLogger>;
type WorkerEnvironmentStartupLoader = () => Promise<
  typeof import("./server-worker-environment-startup.js")
>;

function publishGatewayPluginRuntimeConfigAtStartup(params: {
  runtimeConfig: OpenClawConfig;
  sourceConfig: OpenClawConfig;
}): void {
  setAppliedRuntimeConfigSnapshot(params.runtimeConfig, params.sourceConfig);
}

export async function prepareGatewayServerBootstrap(input: {
  port: number;
  opts: GatewayServerOptions;
  log: GatewayLogger;
  logSecrets: GatewayLogger;
  loadWorkerEnvironmentStartupModule: WorkerEnvironmentStartupLoader;
  formatRuntimeGatewayAuthTokenWarning: () => string;
}) {
  const { port, opts, log, logSecrets, loadWorkerEnvironmentStartupModule } = input;
  const formatRuntimeGatewayAuthTokenWarning = input.formatRuntimeGatewayAuthTokenWarning;
  const traceOriginAt = opts.processStartedAt ?? opts.startupStartedAt;
  const startupElapsedMs =
    typeof traceOriginAt === "number" ? Math.max(0, Date.now() - traceOriginAt) : 0;
  const startupTrace = createGatewayStartupTrace(log, performance.now() - startupElapsedMs);
  if (startupElapsedMs > 0) {
    startupTrace.mark("process.bootstrap");
  }
  await startupTrace.measure("state.ownership", async () => {
    normalizeStateDirEnv(process.env);
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
      env: process.env,
    });
  });
  const [
    {
      OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
      OpenClawDatabaseSchemaPreflightError,
      preflightOpenClawDatabaseSchemas,
    },
    agentDatabase,
    stateDatabase,
  ] = await startupTrace.measure("state.runtime-imports", () =>
    Promise.all([
      import("../state/openclaw-database-preflight.js"),
      import("../state/openclaw-agent-db.js"),
      import("../state/openclaw-state-db-contract.js"),
    ]),
  );
  const databaseSchemas = await startupTrace.measure("state.schema-preflight", () =>
    preflightOpenClawDatabaseSchemas({
      env: process.env,
      supportedVersions: {
        state: stateDatabase.OPENCLAW_STATE_SCHEMA_VERSION,
        agent: agentDatabase.OPENCLAW_AGENT_SCHEMA_VERSION,
      },
    }),
  );
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
  const { bootstrapGatewayNetworkRuntime } = await startupTrace.measure(
    "runtime.network-imports",
    () => import("./server-network-runtime.js"),
  );
  await startupTrace.measure("runtime.network-bootstrap", () => bootstrapGatewayNetworkRuntime());

  const minimalTestGateway =
    isVitestRuntimeEnv() && process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1";
  const ambientEnvTriggers = opts.ambientEnvTriggers ?? "suppress";

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
  if (!minimalTestGateway) {
    await startupTrace.measure("runtime.agent-cli", () => prepareGatewayAgentCliShim());
  }
  const startupConfigModulePromise = startupTrace.measure(
    "config.runtime-imports",
    () => import("./server-startup-config.js"),
  );
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
  if (controlUiSeed.seededAllowedOrigins) {
    copyConfigResolutionFacts(configSnapshot.config, controlUiSeed.config);
  }
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
    const text = `[${code}] ${message}`;
    try {
      const target = resolveSystemMainSessionTarget(cfg);
      enqueueSystemEvent(
        text,
        withSystemEventOwner({ sessionKey: target.sessionKey, contextKey: code }, target.agentId),
      );
    } catch (error) {
      logSecrets.warn(`${text} not delivered: ${formatErrorMessage(error)}`);
    }
  };
  const { createRuntimeSecretsActivator } = await startupConfigModulePromise;
  const activateRuntimeSecrets = createRuntimeSecretsActivator({
    logSecrets,
    emitStateEvent: emitSecretsStateEvent,
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
  try {
    const cleanup = await startupTrace.measure("agents.github-profile-cleanup", async () => {
      const { cleanupRetiredManagedGitHubProfiles } =
        await import("../agents/github-tool-profile-cleanup.js");
      return await cleanupRetiredManagedGitHubProfiles({
        config: cfgAtStart,
        env: process.env,
      });
    });
    for (const warning of cleanup.warnings) {
      log.warn(`managed GitHub profile cleanup: ${warning}`);
    }
  } catch (error) {
    log.warn(`managed GitHub profile cleanup failed: ${formatErrorMessage(error)}`);
  }
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
      "SECURITY WARNING: gateway.auth.trustedProxy.deviceAutoApprove.scopes includes operator.admin; every proxy-authenticated user can auto-approve a new browser device with full admin, and requests without scopes receive full admin automatically. Remove operator.admin and grant admin per identity via gateway.auth.identityScopes instead.",
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
  setDiagnosticsEnabledForProcess(isDiagnosticsEnabled(cfgAtStart));
  setGatewaySigusr1RestartPolicy({ allowExternal: isRestartEnabled(cfgAtStart) });
  const activeTaskCount = { get: () => 0 };
  setPreRestartDeferralCheck(
    () =>
      getTotalQueueSize() +
      getTotalPendingReplies() +
      getActiveEmbeddedRunCount() +
      getActiveCronJobCount() +
      getActiveBackgroundExecSessionCount() +
      getActiveGatewayRootWorkCount({ excludeCurrent: true }) +
      activeTaskCount.get(),
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
    copyConfigResolutionFactsExcept(config, runtimeConfig, [
      ...(reloadAuthOverride?.token !== undefined ? ["gateway.auth.token"] : []),
      ...(reloadAuthOverride?.password !== undefined ? ["gateway.auth.password"] : []),
    ]);
    return runtimeConfig;
  };
  const applyReloadableGatewayAuthRefs = (config: OpenClawConfig): OpenClawConfig => {
    if (!startupAuthSecretRefOverride?.token && !startupAuthSecretRefOverride?.password) {
      return config;
    }
    const next = {
      ...config,
      gateway: {
        ...config.gateway,
        auth: mergeGatewayAuthConfig(config.gateway?.auth, startupAuthSecretRefOverride),
      },
    };
    copyConfigResolutionFactsExcept(config, next, [
      ...(startupAuthSecretRefOverride.token !== undefined ? ["gateway.auth.token"] : []),
      ...(startupAuthSecretRefOverride.password !== undefined ? ["gateway.auth.password"] : []),
    ]);
    return next;
  };
  const { assertConfiguredWorkspaceStateReady } = await import("../agents/workspace-state-dirs.js");
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
    const reapplyCompareOverlays = (config: OpenClawConfig): OpenClawConfig => {
      const applied = applyCandidateOverrides(
        mergeActivationSectionsIntoRuntimeConfig({
          runtimeConfig: config,
          activationConfig: pluginCandidate.compareConfig,
        }),
      );
      copyConfigResolutionFacts(config, applied);
      return applied;
    };
    const reapplyRuntimeOverlays = (config: OpenClawConfig): OpenClawConfig =>
      applyFixedGatewayOverlays(applyReloadableGatewayAuthRefs(reapplyCompareOverlays(config)));
    const runtimeConfig = reapplyRuntimeOverlays(params.runtimeConfig);
    // Both managed writes and watcher reloads must reject unmigrated workspaces
    // before persistence or publication, using the candidate's final config and env.
    assertConfiguredWorkspaceStateReady({ cfg: runtimeConfig, env: runtimeEnv.env });
    return {
      runtimeConfig,
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
  applyLoggingConfig(cfgAtStart.logging);
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
  const { prepareGatewayPluginBootstrap, runGatewayStartupMaintenance } =
    await startupTrace.measure("plugins.bootstrap-imports", loadStartupPluginsModule);
  const pluginGatewayContext: {
    current: import("./server-methods/types.js").GatewayRequestContext | undefined;
  } = { current: undefined };
  const resolvePluginGatewayContext = () => pluginGatewayContext.current;
  await startupTrace.measure("startup.maintenance", () =>
    runGatewayStartupMaintenance({
      cfgAtStart,
      startupRuntimeConfig,
      minimalTestGateway,
      log,
    }),
  );
  const pluginBootstrap = await startupTrace.measure("plugins.bootstrap", () =>
    prepareGatewayPluginBootstrap({
      cfgAtStart,
      activationSourceConfig: startupActivationSourceConfig,
      pluginMetadataSnapshot: startupConfigLoad.pluginMetadataSnapshot,
      workerProviderIds: workerEnvironmentStartup?.durableProviderIds ?? [],
      minimalTestGateway,
      ambientEnvTriggers,
      log,
    }),
  );
  const {
    gatewayPluginConfigAtStart,
    defaultWorkspaceDir,
    pluginWorkspaceDir,
    startupPluginIds,
    pluginManifestRecords,
    pluginMetadataSnapshot,
    pluginLookUpTable,
    baseMethods,
    ambientAutostartSuppressedChannelIds,
  } = pluginBootstrap;
  // Plugin activation can return a new runtime config object. Publish that exact object before
  // prepared owners are created so request-time exact-owner lookups cannot see the pre-activation
  // snapshot and reject the Gateway's own model catalog.
  copyConfigResolutionFacts(cfgAtStart, gatewayPluginConfigAtStart);
  publishGatewayPluginRuntimeConfigAtStartup({
    runtimeConfig: gatewayPluginConfigAtStart,
    sourceConfig: startupLastGoodSnapshot.sourceConfig,
  });
  const coreGatewayMethodNames = listCoreGatewayMethodNames();
  const existingPluginMetadataSnapshot = getGatewayPluginMetadataSnapshot();
  const currentPluginMetadataSnapshot = existingPluginMetadataSnapshot ?? pluginMetadataSnapshot;
  if (!existingPluginMetadataSnapshot) {
    setGatewayPluginMetadataSnapshot(currentPluginMetadataSnapshot, {
      config: startupActivationSourceConfig,
      compatibleConfigs: [startupRuntimeConfig, cfgAtStart, gatewayPluginConfigAtStart],
      env: process.env,
      workspaceDir: pluginWorkspaceDir,
    });
  }
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
    ]);
  }

  return {
    opts,
    minimalTestGateway,
    ambientEnvTriggers,
    startupTrace,
    loadStartupPluginsModule,
    configSnapshot,
    startupConfigLoad,
    startupActivationSourceConfig,
    startupRuntimeConfig,
    cfgAtStart,
    generatedStartupAuthToken: authBootstrap.generatedToken !== undefined,
    resolvedStartupAuthOverride,
    startupTailscaleOverride,
    activeTaskCount,
    applyFixedGatewayOverlays,
    prepareReloadCandidate,
    startupInternalWriteHash,
    startupLastGoodSnapshot,
    workerEnvironmentStartup,
    pluginGatewayContext,
    resolvePluginGatewayContext,
    pluginBootstrap,
    gatewayPluginConfigAtStart,
    defaultWorkspaceDir,
    pluginWorkspaceDir,
    startupPluginIds,
    pluginManifestRecords,
    pluginMetadataSnapshot: currentPluginMetadataSnapshot,
    pluginLookUpTable,
    baseMethods,
    ambientAutostartSuppressedChannelIds,
    coreGatewayMethodNames,
    activateRuntimeSecrets,
  };
}

export const testing = {
  publishGatewayPluginRuntimeConfigAtStartup,
};
