import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getRuntimeConfig } from "../config/config.js";
import { loadOrCreateProcessDeviceIdentity } from "../infra/device-identity.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { WorkerExecutionMode } from "../plugins/types.js";
import {
  getActiveSecretsRuntimeConfigSnapshot,
  getActiveSecretsRuntimeEnvState,
} from "../secrets/runtime-state.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveRuntimeServiceBuildId } from "../version.js";
import type { NodeDesktopStreamBroker } from "./desktop/node-stream-broker.js";
import type { DesktopSessionRegistry } from "./desktop/session-registry.js";
import type { GitHubPublicationCoordinator } from "./github-publication.js";
import type { NodeWorkerSupervisorTransport } from "./node-registry-private.js";
import type { GatewayContextResolver, GatewayRequestContext } from "./server-methods/types.js";
import type { WorkerBundleProducer, WorkerNpmArtifact } from "./worker-environments/bundle.js";
import {
  bindDeviceWorkerAvailability,
  bindDeviceWorkerReconciliation,
  createDeviceWorkerRuntime,
  DEVICE_WORKER_PROVIDER_ID,
} from "./worker-environments/device-provider.js";
import type { WorkerLiveEventReceiver } from "./worker-environments/live-events.js";
import type { createNodeBootstrapArtifactProvider } from "./worker-environments/node-bootstrap-artifact.js";
import { createWorkerNodeEnrollmentManager } from "./worker-environments/node-enrollment.js";
import type { NodeWorkerBundleTransferHttpCallback } from "./worker-environments/node-worker-bundle-transfer-http.js";
import { nodeWorkerGatewayNamespace as resolveNodeWorkerGatewayNamespace } from "./worker-environments/node-worker-gateway-namespace.js";
import type { NodeWorkerWorkspaceBindingResolver } from "./worker-environments/node-worker-tunnel.js";
import type { NodeWorkspaceTransferHttpCallback } from "./worker-environments/node-workspace-transfer-http-contract.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerPlacementDispatchContract } from "./worker-environments/service-contract.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";
import type { WorkerTunnelManager } from "./worker-environments/tunnel.js";
import type { WorkerBootstrapArtifactTransferHttpCallback } from "./worker-environments/worker-bootstrap-artifact-transfer-http.js";
import { listRetainedWorkerBundleHashes } from "./worker-environments/worker-bundle-retention.js";

type WorkerEnvironmentStore = ReturnType<
  typeof import("./worker-environments/store.js").createWorkerEnvironmentStore
>;
type WorkerEnvironmentRecord = ReturnType<WorkerEnvironmentStore["list"]>[number];
type WorkerSessionToolExecutor = ReturnType<
  typeof import("./worker-environments/worker-session-tool-executor.js").createWorkerSessionToolExecutor
>;
type WorkerEnvironmentLogger = {
  child: (name: string) => { warn: (message: string) => void };
};

export type GatewayWorkerEnvironmentStartupState = {
  durableProviderIds: string[];
  listDurableProviderIds: () => string[];
  records: WorkerEnvironmentRecord[];
  store: WorkerEnvironmentStore;
  placementStore: WorkerSessionPlacementStore;
  hasNonlocalPlacementRecords: boolean;
};

export type GatewayWorkerEnvironmentRuntime = {
  workerEnvironmentService?: WorkerEnvironmentService;
  workerLiveEvents?: WorkerLiveEventReceiver;
  workerTunnelManager?: WorkerTunnelManager;
  nodeWorkerGatewayNamespace?: string;
  bindWorkerSessionDispatch?: (dispatch: WorkerPlacementDispatchContract["dispatch"]) => void;
  bindGitHubPublication?: (coordinator: GitHubPublicationCoordinator) => void;
  bindDeviceNodeControl?: (transport: NodeWorkerSupervisorTransport) => void;
  bindWorkerNodeDesktopControl?: (transport: NodeWorkerSupervisorTransport) => void;
  bindNodeWorkspaceBindingResolver?: (resolver: NodeWorkerWorkspaceBindingResolver) => void;
  handleNodeWorkerBundleTransferRequest?: NodeWorkerBundleTransferHttpCallback;
  handleWorkerBootstrapArtifactTransferRequest?: WorkerBootstrapArtifactTransferHttpCallback;
  handleNodeWorkspaceTransferRequest?: NodeWorkspaceTransferHttpCallback;
};

const loadWorkerEnvironmentRuntimeModule = createLazyRuntimeModule(
  () => import("./worker-environments/runtime.js"),
);
const loadWorkerInferenceRuntimeModule = createLazyRuntimeModule(
  () => import("./worker-environments/inference-runtime.js"),
);
const loadWorkerSessionToolExecutorModule = createLazyRuntimeModule(
  () => import("./worker-environments/worker-session-tool-executor.js"),
);

export async function loadGatewayWorkerEnvironmentStartupState(): Promise<GatewayWorkerEnvironmentStartupState> {
  const [{ createWorkerEnvironmentStore }, { createWorkerSessionPlacementStore }] =
    await Promise.all([
      import("./worker-environments/store.js"),
      import("./worker-environments/placement-store.js"),
    ]);
  const store = createWorkerEnvironmentStore();
  const placementStore = createWorkerSessionPlacementStore();
  const records = store.list();
  const durableProviderIds = uniqueStrings(
    records.flatMap((record) =>
      record.state === "destroyed" || record.state === "failed" || record.state === "orphaned"
        ? []
        : record.providerId === DEVICE_WORKER_PROVIDER_ID
          ? []
          : [record.providerId],
    ),
  );
  const listDurableProviderIds = () =>
    uniqueStrings(
      store
        .listForReconcile()
        .filter((record) => record.providerId !== DEVICE_WORKER_PROVIDER_ID)
        .map((record) => record.providerId),
    );
  return {
    durableProviderIds,
    listDurableProviderIds,
    records,
    store,
    placementStore,
    // Non-local placements must revive the worker service even without configured profiles.
    hasNonlocalPlacementRecords: placementStore.listForReconcile().length > 0,
  };
}

export async function createGatewayWorkerEnvironmentRuntime(params: {
  getPluginRegistry: () => Pick<
    PluginRegistry,
    "workerProviders" | "plugins" | "agentHarnesses" | "nodeHostCommands"
  >;
  getPortalRuntime: () => Pick<GatewayRequestContext, "portalService" | "broadcast"> | undefined;
  resolveGatewayContext: GatewayContextResolver;
  desktopSessionRegistry: DesktopSessionRegistry;
  nodeDesktopStreamBroker?: NodeDesktopStreamBroker;
  startup: GatewayWorkerEnvironmentStartupState;
  log: WorkerEnvironmentLogger;
}): Promise<GatewayWorkerEnvironmentRuntime> {
  const deviceRuntime = createDeviceWorkerRuntime({ getPairedDevice });
  const [
    { createWorkerEnvironmentService },
    { createWorkerLiveEventReceiver },
    { createWorkerSessionPlacementGate },
    { createWorkerTranscriptCommitter },
    { createWorkerTunnelManager },
    { createNodeWorkerTunnelManager },
    { createGatewayNodeWorkerBundleInstaller },
    { createNodeWorkerBundleTransferService },
    { createNodeWorkerBundleTransferHttpCallback },
    { createNodeWorkspaceTransferService },
    { createNodeWorkspaceTransferHttpCallback },
    { createWorkerNodeDesktopCarrier },
    { createWorkerNodePortalCarrier },
    { createWorkerComputerService },
    { resolveWorkerProvider },
    { createWorkerBootstrapArtifactTransferService },
    { createWorkerBootstrapArtifactTransferHttpCallback },
  ] = await Promise.all([
    import("./worker-environments/service.js"),
    import("./worker-environments/live-events.js"),
    import("./worker-environments/placement-worker-gate.js"),
    import("./worker-environments/transcript-commit.js"),
    import("./worker-environments/tunnel.js"),
    import("./worker-environments/node-worker-tunnel.js"),
    import("./worker-environments/node-worker-bundle-installer.js"),
    import("./worker-environments/node-worker-bundle-transfer-service.js"),
    import("./worker-environments/node-worker-bundle-transfer-http.js"),
    import("./worker-environments/node-workspace-transfer-service.js"),
    import("./worker-environments/node-workspace-transfer-http.js"),
    import("./worker-environments/node-desktop-carrier.js"),
    import("./worker-environments/portal-node-carrier.js"),
    import("./worker-environments/computer-transport.js"),
    import("../plugins/worker-provider-registry.js"),
    import("./worker-environments/worker-bootstrap-artifact-transfer-service.js"),
    import("./worker-environments/worker-bootstrap-artifact-transfer-http.js"),
  ]);
  // The Gateway state-directory lock proves that executors from the previous
  // process are gone. Resolve their ambiguous effects before placement
  // reconciliation attempts to release the owning worker claims.
  params.startup.placementStore.recoverWorkerSessionToolOperationsAfterRestart();
  // A crashed gateway can leak local turn claims; drop them before workers re-admit turns.
  params.startup.placementStore.clearLocalTurnClaimsAfterRestart();
  const placementGate = createWorkerSessionPlacementGate(params.startup.placementStore, {
    // Claims loaded before this Gateway acquired the state lock remain usable only by
    // workspace recovery. Worker authority is minted from claims created in this lifecycle.
    rejectExistingWorkerClaims: true,
  });
  const workerEnvironmentLog = params.log.child("worker-environments");
  const listRetainedBundleHashes = () =>
    listRetainedWorkerBundleHashes({
      environments: params.startup.store.list(),
      placements: params.startup.placementStore.list(),
    });
  let workerBundleProducer: WorkerBundleProducer | undefined;
  let workerNpmArtifact: Promise<WorkerNpmArtifact> | undefined;
  const prepareInstallation = async (install: "bundle" | "npm") => {
    const [workerRuntime, { WORKER_PROTOCOL_FEATURES }] = await Promise.all([
      loadWorkerEnvironmentRuntimeModule(),
      import("../../packages/gateway-protocol/src/schema/worker-admission.js"),
    ]);
    const producer = (workerBundleProducer ??= workerRuntime.createWorkerBundleProducer({
      protocolFeatures: WORKER_PROTOCOL_FEATURES,
      cacheOwnership: "exclusive",
      onCacheCleanupError: (error) => {
        workerEnvironmentLog.warn(`Worker bundle cache cleanup failed: ${String(error)}`);
      },
    }));
    const bundle = await producer.prepare();
    await producer.prune(listRetainedBundleHashes());
    if (install === "bundle") {
      return bundle;
    }
    workerNpmArtifact ??= workerRuntime
      .resolveWorkerNpmInstallationArtifact({ bundle })
      .catch((error: unknown) => {
        workerNpmArtifact = undefined;
        throw error;
      });
    return await workerNpmArtifact;
  };
  const startupBindings = params.startup.records.flatMap((record) =>
    record.state === "attached" && record.attachedSessionIds.length === 1
      ? [
          {
            environmentId: record.environmentId,
            runEpoch: record.ownerEpoch,
            sessionId: record.attachedSessionIds[0]!,
          },
        ]
      : [],
  );
  const workerLiveEvents = createWorkerLiveEventReceiver({
    getConfig: getRuntimeConfig,
    startupBindings,
    startupOwners: new Map(
      startupBindings.map((binding) => [binding.environmentId, binding.runEpoch] as const),
    ),
  });
  const workerTunnelManager = createWorkerTunnelManager({
    desktopSessionRegistry: params.desktopSessionRegistry,
  });
  const notifyPortalChange = () => {
    const runtime = params.getPortalRuntime();
    const service = runtime?.portalService;
    if (!service) {
      return;
    }
    runtime.broadcast(
      "portal.changed",
      {
        portals: service.list().map(({ tokenQuery: _tokenQuery, url: _url, ...portal }) => portal),
      },
      { dropIfSlow: true },
    );
  };
  const workerNodeDesktopStreamBroker = params.nodeDesktopStreamBroker;
  const workerNodePortalCarrier = createWorkerNodePortalCarrier({ store: params.startup.store });
  const workerNodeDesktopCarrier = workerNodeDesktopStreamBroker
    ? createWorkerNodeDesktopCarrier({
        store: params.startup.store,
        desktopRegistry: params.desktopSessionRegistry,
      })
    : undefined;
  const nodeWorkerBundleTransfer = createNodeWorkerBundleTransferService();
  const nodeBootstrapTransfer = createWorkerBootstrapArtifactTransferService();
  const bootstrapProducers = new Map<
    WorkerExecutionMode,
    {
      registry: ReturnType<typeof params.getPluginRegistry>;
      metadata: ReturnType<typeof getGatewayPluginMetadataSnapshot>;
      producer: ReturnType<typeof createNodeBootstrapArtifactProvider>;
    }
  >();
  const retiringBootstrapProducers = new Set<Promise<void>>();
  const retireBootstrapProducer = (
    producer: ReturnType<typeof createNodeBootstrapArtifactProvider>,
  ) => {
    const retirement = producer
      .close()
      .catch((error: unknown) => {
        workerEnvironmentLog.warn(`Cloud node artifact cleanup failed: ${String(error)}`);
      })
      .finally(() => retiringBootstrapProducers.delete(retirement));
    retiringBootstrapProducers.add(retirement);
  };
  const nodeWorkspaceTransfer = createNodeWorkspaceTransferService({
    getOwner: (environmentId) => params.startup.store.getTransferOwner(environmentId),
  });
  await nodeWorkspaceTransfer.initialize();
  const gatewayDeviceId = loadOrCreateProcessDeviceIdentity().deviceId;
  const nodeWorkerGatewayNamespace = resolveNodeWorkerGatewayNamespace(gatewayDeviceId);
  const nodeWorkerTunnelManager = createNodeWorkerTunnelManager({
    gatewayDeviceId,
    getEnvironment: (environmentId) => params.startup.store.get(environmentId),
    listEnvironments: () => params.startup.store.list(),
    getTransport: () => deviceRuntime.getNodeTransport(),
    launchNodeWorker: async (request) => await deviceRuntime.launchNodeWorker(request),
    validateWorkerTurn: (binding) => placementGate.validateWorkerTurn(binding),
    workspaceTransfer: nodeWorkspaceTransfer,
  });
  const ensureNodeWorkerBundle = createGatewayNodeWorkerBundleInstaller({
    gatewayNamespace: nodeWorkerGatewayNamespace,
    getTransport: () => deviceRuntime.getNodeTransport(),
    prepareBundle: async () => {
      const artifact = await prepareInstallation("bundle");
      if (artifact.install !== "bundle") {
        throw new Error("Worker bundle preparation returned the wrong install channel");
      }
      return artifact;
    },
    transfer: nodeWorkerBundleTransfer,
  });
  const nodeEnrollment = createWorkerNodeEnrollmentManager({
    store: params.startup.store,
    getConfig: getRuntimeConfig,
    getLocalTlsFingerprint: () => params.resolveGatewayContext()?.gatewayTlsFingerprint,
    resolveAvailability: deviceRuntime.resolveAvailability,
    transfer: nodeBootstrapTransfer,
    prepareArtifact: async (record, signal) => {
      const mode =
        record.profileSnapshot.executionMode === "remote-exec" ? "remote-exec" : "worker-turn";
      let registry = params.getPluginRegistry();
      let metadata = getGatewayPluginMetadataSnapshot();
      let generation = bootstrapProducers.get(mode);
      if (!generation || generation.registry !== registry || generation.metadata !== metadata) {
        const [{ createNodeBootstrapArtifactProvider }, { resolveNodeBootstrapPlugins }] =
          await Promise.all([
            import("./worker-environments/node-bootstrap-artifact.js"),
            import("./worker-environments/node-bootstrap-plugins.js"),
          ]);
        signal?.throwIfAborted();
        registry = params.getPluginRegistry();
        metadata = getGatewayPluginMetadataSnapshot();
        generation = bootstrapProducers.get(mode);
        if (!generation || generation.registry !== registry || generation.metadata !== metadata) {
          const packageRoot = resolveOpenClawPackageRootSync({
            moduleUrl: import.meta.url,
            argv1: process.argv[1],
            cwd: process.cwd(),
          });
          const runningBuildId = resolveRuntimeServiceBuildId();
          if (!metadata || !packageRoot || !runningBuildId) {
            throw new Error(
              "Cloud node bootstrap requires the running build and plugin inventory; build OpenClaw and restart the Gateway",
            );
          }
          const producer = createNodeBootstrapArtifactProvider({
            packageRoot,
            runningBuildId,
            plugins: resolveNodeBootstrapPlugins({
              registry,
              metadata,
              executionMode: mode,
            }),
          });
          // Reload owns a new inventory; active enrollments pin their old artifact until closure.
          if (generation) {
            retireBootstrapProducer(generation.producer);
          }
          generation = { registry, metadata, producer };
          bootstrapProducers.set(mode, generation);
        }
      }
      return await generation.producer.prepare(signal);
    },
  });
  let executeSessionTool: WorkerSessionToolExecutor = async () => {
    throw new Error("Worker session tools are unavailable");
  };
  let dispatchChild: WorkerPlacementDispatchContract["dispatch"] = async () => {
    throw new Error("Worker session dispatch is unavailable");
  };
  let githubPublication: Pick<GitHubPublicationCoordinator, "requestForClaim"> = {
    requestForClaim: async () => {
      throw new Error("GitHub publication is unavailable");
    },
  };
  const computers = createWorkerComputerService({
    store: params.startup.store,
    placements: params.startup.placementStore,
    resolveGatewayContext: params.resolveGatewayContext,
    getNodeTransport: () => deviceRuntime.getNodeTransport(),
    warn: (message) => workerEnvironmentLog.warn(message),
  });
  const workerEnvironmentServiceBase = createWorkerEnvironmentService({
    projectNamespace: nodeWorkerGatewayNamespace,
    prepareComputer: computers.prepare,
    executeComputer: computers.execute,
    closeComputers: computers.close,
    store: params.startup.store,
    getConfig: getRuntimeConfig,
    // Plugin reload replaces the registry object; resolve against the live binding.
    resolveProvider: (providerId) =>
      providerId === DEVICE_WORKER_PROVIDER_ID
        ? deviceRuntime.provider
        : resolveWorkerProvider(params.getPluginRegistry(), providerId),
    prepareInstallation,
    ensureNodeWorkerBundle: async (deviceId) => await ensureNodeWorkerBundle({ deviceId }),
    prepareNodeBootstrap: nodeEnrollment.prepare,
    prepareNodeEnrollment: nodeEnrollment.begin,
    prepareNodeRuntime: nodeEnrollment.prepareRuntime,
    closeNodeRuntime: nodeEnrollment.closeRuntime,
    closeNodeEnrollment: nodeEnrollment.close,
    retireNodeEnrollment: nodeEnrollment.retire,
    stopNodeEnrollmentWaits: nodeEnrollment.stop,
    closeNodeBootstrapArtifacts: async () => {
      await Promise.all([
        ...[...bootstrapProducers.values()].map(({ producer }) => producer.close()),
        ...retiringBootstrapProducers,
      ]);
      bootstrapProducers.clear();
    },
    tunnelManager: workerTunnelManager,
    nodeTunnelManager: nodeWorkerTunnelManager,
    nodeDesktopCarrier: workerNodeDesktopCarrier,
    nodePortalCarrier: workerNodePortalCarrier,
    closeWorkerPortals: async (environmentId, ownerEpoch) => {
      const service = params.getPortalRuntime()?.portalService;
      if (!service) {
        return;
      }
      await service.closeWorkerPortals(environmentId, ownerEpoch);
      notifyPortalChange();
    },
    stopNodeWorkerBundleTransfers: () => nodeWorkerBundleTransfer.closeAll(),
    applyTranscriptCommit: createWorkerTranscriptCommitter({
      getConfig: getRuntimeConfig,
    }).commit,
    executeInference: async (inferenceParams) => {
      const workerInferenceRuntime = await loadWorkerInferenceRuntimeModule();
      return await workerInferenceRuntime.executeWorkerInference(inferenceParams);
    },
    placementStore: placementGate,
    executeSessionTool: (request) => executeSessionTool(request),
    liveEvents: workerLiveEvents,
    resolveSshIdentity: async ({ provider, leaseId, profile, keyRef }) => {
      const workerRuntime = await loadWorkerEnvironmentRuntimeModule();
      return await workerRuntime.resolveWorkerSshIdentity({
        provider,
        leaseId,
        profile,
        keyRef,
        resolveGeneric: async (genericKeyRef) => ({
          kind: "material",
          contents: await workerRuntime.resolveSecretRefString(genericKeyRef, {
            config: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig ?? getRuntimeConfig(),
            env: getActiveSecretsRuntimeEnvState(),
          }),
        }),
      });
    },
    bootstrapWorker: async ({
      operationId,
      sshEndpoint,
      installation,
      resolveIdentity,
      signal,
    }) => {
      const workerRuntime = await loadWorkerEnvironmentRuntimeModule();
      return await workerRuntime.bootstrapWorker(
        {
          operationId,
          ssh: sshEndpoint,
          artifact: installation,
          pinnedHostKey: sshEndpoint.hostKey,
        },
        { signal, resolveIdentity },
      );
    },
    logger: workerEnvironmentLog,
  });
  const workerEnvironmentService = workerEnvironmentServiceBase;
  bindDeviceWorkerAvailability(workerEnvironmentService, deviceRuntime.resolveAvailability);
  bindDeviceWorkerReconciliation(workerEnvironmentService, async (deviceId) => {
    const environmentIds = params.startup.store
      .listForReconcile()
      .filter((record) => {
        const settings = record.profileSnapshot.settings;
        const profileDeviceId = isRecord(settings) ? settings.device : undefined;
        return (
          record.providerId === DEVICE_WORKER_PROVIDER_ID &&
          typeof profileDeviceId === "string" &&
          profileDeviceId.trim() === deviceId
        );
      })
      .map((record) => record.environmentId);
    for (const environmentId of environmentIds) {
      params.startup.store.revokeEnvironmentCredential(environmentId);
    }
    await Promise.all(
      environmentIds.map(async (environmentId) => {
        await workerEnvironmentService.reconcileEnvironment(environmentId).catch(() => {
          workerEnvironmentLog.warn(
            `Device worker reconcile failed (${deviceId}, ${environmentId}); periodic cleanup will retry`,
          );
        });
      }),
    );
    return environmentIds;
  });
  let workerSessionToolExecutor: Promise<WorkerSessionToolExecutor> | undefined;
  executeSessionTool = async (request) => {
    const executor = await (workerSessionToolExecutor ??=
      loadWorkerSessionToolExecutorModule().then(({ createWorkerSessionToolExecutor }) =>
        createWorkerSessionToolExecutor({
          resolveGatewayContext: params.resolveGatewayContext,
          placements: params.startup.placementStore,
          environments: workerEnvironmentService,
          dispatchChild: (childRequest) => dispatchChild(childRequest),
          githubPublication: {
            requestForClaim: (publicationRequest) =>
              githubPublication.requestForClaim(publicationRequest),
          },
          portals: {
            getService: () => params.getPortalRuntime()?.portalService,
            carrier: workerNodePortalCarrier,
            onChanged: notifyPortalChange,
          },
        }),
      ));
    return await executor(request);
  };
  const bindWorkerNodeDesktopControl =
    workerNodeDesktopCarrier && workerNodeDesktopStreamBroker
      ? (transport: NodeWorkerSupervisorTransport) =>
          workerNodeDesktopCarrier.bindRuntime({
            transport,
            streamBroker: workerNodeDesktopStreamBroker,
          })
      : undefined;
  return {
    workerEnvironmentService,
    workerLiveEvents,
    workerTunnelManager,
    nodeWorkerGatewayNamespace,
    bindWorkerSessionDispatch: (dispatch) => {
      dispatchChild = dispatch;
    },
    bindGitHubPublication: (coordinator) => {
      githubPublication = coordinator;
    },
    bindDeviceNodeControl: (transport) => {
      deviceRuntime.bindNodeTransport(transport);
      if (workerNodeDesktopStreamBroker) {
        workerNodePortalCarrier.bindRuntime({
          transport,
          streamBroker: workerNodeDesktopStreamBroker,
        });
      }
    },
    ...(bindWorkerNodeDesktopControl ? { bindWorkerNodeDesktopControl } : {}),
    bindNodeWorkspaceBindingResolver: (resolver) =>
      nodeWorkerTunnelManager.bindWorkspaceBindingResolver(resolver),
    handleNodeWorkerBundleTransferRequest:
      createNodeWorkerBundleTransferHttpCallback(nodeWorkerBundleTransfer),
    handleWorkerBootstrapArtifactTransferRequest:
      createWorkerBootstrapArtifactTransferHttpCallback(nodeBootstrapTransfer),
    handleNodeWorkspaceTransferRequest:
      createNodeWorkspaceTransferHttpCallback(nodeWorkspaceTransfer),
  };
}
