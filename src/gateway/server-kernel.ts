import { isNixMode } from "../config/paths.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { ensureOpenClawCliOnPath } from "../infra/path-env.js";
import { createSubsystemLogger, runtimeForLogger } from "../logging/subsystem.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  clearActivePluginRegistry,
  getActivePluginRegistry,
  getActivePluginRegistryKey,
  getActivePluginRegistryWorkspaceDir,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { clearSecretsRuntimeSnapshotState } from "../secrets/runtime-state.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { startGatewayCoreRuntime } from "./server-core-runtime.js";
import { prepareGatewayKernelRequestRuntime } from "./server-kernel-request-runtime.js";
import { prepareGatewayLifecycle } from "./server-lifecycle.js";
import { registerGatewayModelCatalogPrivateAccess } from "./server-model-catalog-auth.js";
import type { GatewayServerOptions } from "./server-public.js";
import { prepareGatewayKernelState } from "./server-runtime-state-prepare.js";
import { prepareGatewayServerBootstrap } from "./server-startup-bootstrap.js";

type LoadGatewayModelCatalog = typeof import("./server-model-catalog.js").loadGatewayModelCatalog;
type LoadGatewayModelCatalogSnapshot =
  typeof import("./server-model-catalog.js").loadGatewayModelCatalogSnapshot;
type ReadPreparedGatewayModelCatalog =
  typeof import("./server-model-catalog.js").readPreparedGatewayModelCatalog;
type LoadPreparedGatewayModelCatalogSnapshot =
  typeof import("./server-model-catalog.js").loadPreparedGatewayModelCatalogSnapshot;
type ReadPreparedGatewayModelCatalogOwnerSnapshot =
  typeof import("./server-model-catalog.js").readPreparedGatewayModelCatalogOwnerSnapshot;

const loadGatewayModelCatalogModule = createLazyRuntimeModule(
  () => import("./server-model-catalog.js"),
);
const loadWorkerEnvironmentStartupModule = createLazyRuntimeModule(
  () => import("./server-worker-environment-startup.js"),
);
const loadWorkerPlacementStartupModule = createLazyRuntimeModule(
  () => import("./server-worker-placement-startup.js"),
);
const loadGatewayStartupEarlyModule = createLazyRuntimeModule(
  () => import("./server-startup-early.js"),
);
const loadGatewayPluginBootstrapModule = createLazyRuntimeModule(
  () => import("./server-plugin-bootstrap.js"),
);
const loadGatewayShutdownModule = createLazyRuntimeModule(
  () => import("./server-shutdown.runtime.js"),
);

const log = createSubsystemLogger("gateway");
const logDiscovery = log.child("discovery");
const logTailscale = log.child("tailscale");
const logChannels = log.child("channels");
const logHealth = log.child("health");
const logCron = log.child("cron");
const logReload = log.child("reload");
const logHooks = log.child("hooks");
const logPlugins = log.child("plugins");
const logWsControl = log.child("ws");
const logSecrets = log.child("secrets");

export const gatewayKernelLogs = {
  log,
  logTailscale,
  logChannels,
  logHealth,
  logCron,
  logReload,
  logHooks,
  logWsControl,
};

const gatewayRuntime = runtimeForLogger(log);
const getChannelRuntime = createLazyRuntimeModule(() =>
  import("../plugins/runtime/runtime-channel.js").then(({ createRuntimeChannel }) =>
    createRuntimeChannel(),
  ),
);

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
const loadPreparedGatewayModelCatalogSnapshot: LoadPreparedGatewayModelCatalogSnapshot = async (
  ...args
) => {
  const mod = await loadGatewayModelCatalogModule();
  return mod.loadPreparedGatewayModelCatalogSnapshot(...args);
};
const readPreparedGatewayModelCatalogOwnerSnapshot: ReadPreparedGatewayModelCatalogOwnerSnapshot =
  async (...args) => {
    const mod = await loadGatewayModelCatalogModule();
    return mod.readPreparedGatewayModelCatalogOwnerSnapshot(...args);
  };

registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
  loadDeferred: (params) => loadPreparedGatewayModelCatalogSnapshot(params),
  readPrepared: readPreparedGatewayModelCatalogOwnerSnapshot,
});

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

export async function resetPreparedModelCatalogForTestCore(): Promise<void> {
  const { resetPreparedModelCatalogStateForTest } = await loadGatewayModelCatalogModule();
  await resetPreparedModelCatalogStateForTest();
}

/** Builds the Gateway kernel and internal dispatch surface without creating HTTP servers. */
export async function createGatewayKernel(port = 18789, opts: GatewayServerOptions = {}) {
  ensureOpenClawCliOnPath();
  let lifecycleRuntime: Awaited<ReturnType<typeof prepareGatewayLifecycle>> | undefined;
  // Pre-lifecycle failure cleanup is scoped to state THIS attempt published: an embedded
  // process can already run a Gateway whose registry and config snapshot these globals hold,
  // and a second kernel attempt failing during preflight must not strip them from it.
  const priorRegistry = getActivePluginRegistry();
  const priorRegistryKey = getActivePluginRegistryKey();
  const priorRegistryWorkspaceDir = getActivePluginRegistryWorkspaceDir();
  const priorSnapshot = getRuntimeConfigSnapshot();
  const priorSourceSnapshot = getRuntimeConfigSourceSnapshot();
  try {
    const bootstrap = await prepareGatewayServerBootstrap({
      port,
      opts,
      log,
      logSecrets,
      loadWorkerEnvironmentStartupModule,
      formatRuntimeGatewayAuthTokenWarning,
    });
    const runtime = await prepareGatewayKernelState({
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
    // An in-place update may replace every hashed chunk before SIGTERM arrives.
    // Resolve and retain the complete shutdown graph while the install is healthy.
    const shutdownRuntime = await runtime.startupTrace.measure(
      "gateway.shutdown-runtime-import",
      async () => (await loadGatewayShutdownModule()).prepareGatewayShutdownRuntime(),
    );
    lifecycleRuntime = await prepareGatewayLifecycle({
      runtime,
      port,
      log,
      logCron,
      diagnosticsEnabled: bootstrap.diagnosticsEnabled,
      shutdownRuntime,
    });
    if (bootstrap.cfgAtStart.gateway?.tls?.enabled && !runtime.gatewayTls.enabled) {
      throw new Error(runtime.gatewayTls.error ?? "gateway tls: failed to enable");
    }
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
    return await prepareGatewayKernelRequestRuntime({ coreRuntime, log, logHealth });
  } catch (error) {
    if (lifecycleRuntime) {
      await lifecycleRuntime.closeOnStartupFailure();
    } else {
      // Kernel state prep activates the process-global plugin registry and pins the runtime
      // config snapshot BEFORE the lifecycle exists. A pre-lifecycle failure must clear what
      // THIS attempt published — or later validation (and a same-process retry) treats
      // registrations from a Gateway that never started as LANDED channel owners — while a
      // still-running embedded Gateway's state is preserved or restored. The registry retires
      // FIRST — plugin-host cleanup still reads the runtime config and secrets snapshots,
      // exactly as normal shutdown orders it — and the snapshots scrub afterwards even when
      // that cleanup throws.
      try {
        if (getActivePluginRegistry() !== priorRegistry) {
          await clearActivePluginRegistry();
          if (priorRegistry) {
            setActivePluginRegistry(
              priorRegistry,
              priorRegistryKey ?? undefined,
              "default",
              priorRegistryWorkspaceDir,
            );
          }
        }
      } finally {
        clearSecretsRuntimeSnapshotState();
        clearPluginMetadataLifecycleCaches();
        if (getRuntimeConfigSnapshot() !== priorSnapshot) {
          clearRuntimeConfigSnapshot();
          if (priorSnapshot) {
            setRuntimeConfigSnapshot(priorSnapshot, priorSourceSnapshot ?? undefined);
          }
        }
      }
    }
    throw error;
  }
}
