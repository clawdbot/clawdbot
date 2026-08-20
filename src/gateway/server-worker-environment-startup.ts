import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getRuntimeConfig } from "../config/config.js";
import { loadOrCreateProcessDeviceIdentity } from "../infra/device-identity.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  getActiveSecretsRuntimeConfigSnapshot,
  getActiveSecretsRuntimeEnvState,
} from "../secrets/runtime-state.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { NodeDesktopStreamBroker } from "./desktop/node-stream-broker.js";
import type { DesktopSessionRegistry } from "./desktop/session-registry.js";
import type { GitHubPublicationCoordinator } from "./github-publication.js";
import type { NodeWorkerSupervisorTransport } from "./node-registry-private.js";
import type { WorkerBundleProducer, WorkerNpmArtifact } from "./worker-environments/bundle.js";
import {
  bindDeviceWorkerAvailability,
  bindDeviceWorkerReconciliation,
  createDeviceWorkerRuntime,
  DEVICE_WORKER_PROVIDER_ID,
} from "./worker-environments/device-provider.js";
import type { WorkerLiveEventReceiver } from "./worker-environments/live-events.js";
import { createWorkerNodeEnrollmentManager } from "./worker-environments/node-enrollment.js";
import type { NodeWorkerBundleTransferHttpCallback } from "./worker-environments/node-worker-bundle-transfer-http.js";
import { nodeWorkerGatewayNamespace as resolveNodeWorkerGatewayNamespace } from "./worker-environments/node-worker-gateway-namespace.js";
import type { NodeWorkerWorkspaceBindingResolver } from "./worker-environments/node-worker-tunnel.js";
import type { NodeWorkspaceTransferHttpCallback } from "./worker-environments/node-workspace-transfer-http-contract.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerPlacementDispatchContract } from "./worker-environments/service-contract.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";
import type { WorkerTunnelManager } from "./worker-environments/tunnel.js";
import { listRetainedWorkerBundleHashes } from "./worker-environments/worker-bundle-retention.js";

type WorkerEnvironmentStore = ReturnType<
  typeof import("./worker-environments/store.js").createWorkerEnvironmentStore
>;
type WorkerEnvironmentRecord = ReturnType<WorkerEnvironmentStore["list"]>[number];
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
  handleNodeWorkspaceTransferRequest?: NodeWorkspaceTransferHttpCallback;
};

const loadWorkerEnvironmentRuntimeModule = createLazyRuntimeModule(
  () => import("./worker-environments/runtime.js"),
);
const loadWorkerInferenceRuntimeModule = createLazyRuntimeModule(
  () => import("./worker-environments/inference-runtime.js"),
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
  getPluginRegistry: () => Pick<PluginRegistry, "workerProviders">;
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
    { createWorkerSessionToolExecutor },
    { createWorkerNodeDesktopCarrier },
    { resolveWorkerProvider },
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
    import("./worker-environments/worker-session-tool-executor.js"),
    import("./worker-environments/node-desktop-carrier.js"),
    import("../plugins/worker-provider-registry.js"),
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
  const workerNodeDesktopStreamBroker = params.nodeDesktopStreamBroker;
  const workerNodeDesktopCarrier = workerNodeDesktopStreamBroker
    ? createWorkerNodeDesktopCarrier({
        store: params.startup.store,
        desktopRegistry: params.desktopSessionRegistry,
      })
    : undefined;
  const nodeWorkerBundleTransfer = createNodeWorkerBundleTransferService();
  const nodeWorkspaceTransfer = createNodeWorkspaceTransferService({
    getOwner: (environmentId) => params.startup.store.getTransferOwner(environmentId),
  });
  await nodeWorkspaceTransfer.initialize();
  const gatewayDeviceId = loadOrCreateProcessDeviceIdentity().deviceId;
  const nodeWorkerGatewayNamespace = resolveNodeWorkerGatewayNamespace(gatewayDeviceId);
  const nodeWorkerTunnelManager = createNodeWorkerTunnelManager({
    gatewayDeviceId,
    getEnvironment: (environmentId) => params.startup.store.get(environmentId),
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
    resolveAvailability: deviceRuntime.resolveAvailability,
  });
  let executeSessionTool: ReturnType<typeof createWorkerSessionToolExecutor> = async () => {
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
  const workerEnvironmentServiceBase = createWorkerEnvironmentService({
    store: params.startup.store,
    getConfig: getRuntimeConfig,
    // Plugin reload replaces the registry object; resolve against the live binding.
    resolveProvider: (providerId) =>
      providerId === DEVICE_WORKER_PROVIDER_ID
        ? deviceRuntime.provider
        : resolveWorkerProvider(params.getPluginRegistry(), providerId),
    prepareInstallation,
    ensureNodeWorkerBundle: async (deviceId) => await ensureNodeWorkerBundle({ deviceId }),
    prepareNodeEnrollment: nodeEnrollment.begin,
    retireNodeEnrollment: nodeEnrollment.retire,
    tunnelManager: workerTunnelManager,
    nodeTunnelManager: nodeWorkerTunnelManager,
    nodeDesktopCarrier: workerNodeDesktopCarrier,
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
  executeSessionTool = createWorkerSessionToolExecutor({
    placements: params.startup.placementStore,
    environments: workerEnvironmentService,
    dispatchChild: (request) => dispatchChild(request),
    githubPublication: {
      requestForClaim: (request) => githubPublication.requestForClaim(request),
    },
  });
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
    bindDeviceNodeControl: deviceRuntime.bindNodeTransport,
    ...(bindWorkerNodeDesktopControl ? { bindWorkerNodeDesktopControl } : {}),
    bindNodeWorkspaceBindingResolver: (resolver) =>
      nodeWorkerTunnelManager.bindWorkspaceBindingResolver(resolver),
    handleNodeWorkerBundleTransferRequest:
      createNodeWorkerBundleTransferHttpCallback(nodeWorkerBundleTransfer),
    handleNodeWorkspaceTransferRequest:
      createNodeWorkspaceTransferHttpCallback(nodeWorkspaceTransfer),
  };
}
