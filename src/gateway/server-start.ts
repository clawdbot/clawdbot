import { isNixMode } from "../config/paths.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { startGatewayCoreRuntime } from "./server-core-runtime.js";
import { prepareGatewayLifecycle } from "./server-lifecycle.js";
import type { GatewayServer, GatewayServerOptions } from "./server-public.js";
import { prepareGatewayRuntimeState } from "./server-runtime-state-prepare.js";
import { prepareGatewayServerBootstrap } from "./server-startup-bootstrap.js";
import { finishGatewayStartup } from "./server-startup-finish.js";
type LoadGatewayModelCatalog = typeof import("./server-model-catalog.js").loadGatewayModelCatalog;
type LoadGatewayModelCatalogSnapshot =
  typeof import("./server-model-catalog.js").loadGatewayModelCatalogSnapshot;
type ReadPreparedGatewayModelCatalog =
  typeof import("./server-model-catalog.js").readPreparedGatewayModelCatalog;

const loadGatewayModelCatalogModule = createLazyRuntimeModule(
  () => import("./server-model-catalog.js"),
);
const loadWorkerEnvironmentStartupModule = createLazyRuntimeModule(
  () => import("./server-worker-environment-startup.js"),
);
const loadWorkerPlacementStartupModule = createLazyRuntimeModule(
  () => import("./server-worker-placement-startup.js"),
);

export async function resetPreparedModelCatalogForTestCore(): Promise<void> {
  const { resetPreparedModelCatalogStateForTest } = await loadGatewayModelCatalogModule();
  await resetPreparedModelCatalogStateForTest();
}

const loadGatewayStartupEarlyModule = createLazyRuntimeModule(
  () => import("./server-startup-early.js"),
);

const loadGatewayStartupPostAttachModule = createLazyRuntimeModule(
  () => import("./server-startup-post-attach.js"),
);

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
const readPreparedGatewayModelCatalog: ReadPreparedGatewayModelCatalog = async (...args) => {
  const mod = await loadGatewayModelCatalogModule();
  return mod.readPreparedGatewayModelCatalog(...args);
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
const POST_READY_WORK_START_DELAY_MS = 500;

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

export async function startGatewayServerCore(
  port = 18789,
  opts: GatewayServerOptions = {},
): Promise<GatewayServer> {
  ensureOpenClawCliOnPath();
  let releasePostReadyWork: () => void = () => {};
  const postReadyWorkBarrier = new Promise<void>((resolve) => {
    releasePostReadyWork = resolve;
  });
  const bootstrap = await prepareGatewayServerBootstrap({
    port,
    opts,
    log,
    logSecrets,
    loadWorkerEnvironmentStartupModule,
    formatRuntimeGatewayAuthTokenWarning,
  });
  const runtime = await prepareGatewayRuntimeState({
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
  });
  const lifecycleRuntime = await prepareGatewayLifecycle({
    runtime,
    port,
    log,
    logCron,
    diagnosticsEnabled: bootstrap.diagnosticsEnabled,
    loadGatewayCloseModule,
    closeMcpLoopbackServerOnDemand,
    stopTaskRegistryMaintenanceOnDemand,
  });
  const {
    beginClosePrelude,
    clearFallbackGatewayContextForServer,
    closeOnStartupFailure,
    createCloseHandler,
    runClosePrelude,
    stopRegisteredGatewayLifetimeSidecars,
    stopRegisteredPostReadySidecars,
    terminalSessions,
  } = lifecycleRuntime;
  try {
    const coreRuntime = await startGatewayCoreRuntime({
      lifecycleRuntime,
      port,
      log,
      logDiscovery,
      logHealth,
      logChannels,
      loadGatewayStartupEarlyModule,
      loadGatewayPluginBootstrapModule,
      loadGatewayModelCatalog,
      loadGatewayModelCatalogSnapshot,
      readPreparedGatewayModelCatalog,
    });
    await finishGatewayStartup({
      coreRuntime,
      port,
      opts,
      log,
      logHealth,
      logWsControl,
      logHooks,
      logChannels,
      logCron,
      logReload,
      logTailscale,
      loadGatewayStartupPostAttachModule,
      waitForPostReadyWork: () => postReadyWorkBarrier,
    });
  } catch (err) {
    await closeOnStartupFailure();
    throw err;
  }
  // The public server is fully initialized now. Leave a short I/O window before
  // background prewarms and cleanup imports compete for the startup CPU.
  const postReadyWorkTimer = setTimeout(releasePostReadyWork, POST_READY_WORK_START_DELAY_MS);
  postReadyWorkTimer.unref?.();

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
        clearFallbackGatewayContextForServer.get()();
      }
    },
  };
}
