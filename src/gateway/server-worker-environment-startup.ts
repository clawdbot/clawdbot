import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getRuntimeConfig } from "../config/config.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { loadOrCreateProcessDeviceIdentity } from "../infra/device-identity.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import { NODE_WORKER_WORKSPACE_PREPARE_COMMAND } from "../infra/node-commands.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { getGatewayPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-state.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import type { WorkerExecutionMode, WorkerProfile } from "../plugins/types.js";
import {
  getActiveSecretsRuntimeConfigSnapshot,
  getActiveSecretsRuntimeEnvState,
} from "../secrets/runtime-state.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveRuntimeServiceBuildId } from "../version.js";
import {
  NODE_WORKER_WORKSPACE_COMMAND_TIMEOUT_MS,
  NODE_WORKER_WORKSPACE_RESULT_GRACE_MS,
} from "../worker/node-workspace-deadlines.js";
import {
  parseNodeWorkerPreparedWorkspaceResult,
  type NodeWorkerPreparedWorkspaceInput,
} from "../worker/node-workspace-prepared-protocol.js";
import type { NodeDesktopStreamBroker } from "./desktop/node-stream-broker.js";
import type { DesktopSessionRegistry } from "./desktop/session-registry.js";
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
  getPluginRegistry: () => PluginRegistry;
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
    { maintainConfiguredWorkerProviders },
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
    import("../plugins/worker-provider-maintenance.js"),
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
    transfer: nodeWorkerBundleTransfer,
  });
  const prepareNodeArtifact = async (profileSnapshot: WorkerProfile, signal?: AbortSignal) => {
    const mode = profileSnapshot.executionMode === "remote-exec" ? "remote-exec" : "worker-turn";
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
    const artifact = await generation.producer.prepare(signal);
    return {
      artifact,
      assertCurrent: () => {
        if (
          bootstrapProducers.get(mode) !== generation ||
          params.getPluginRegistry() !== generation.registry ||
          getGatewayPluginMetadataSnapshot() !== generation.metadata
        ) {
          throw new Error("Worker preparation artifact generation changed");
        }
      },
    };
  };
  const nodeEnrollment = createWorkerNodeEnrollmentManager({
    store: params.startup.store,
    getConfig: getRuntimeConfig,
    getLocalTlsFingerprint: () => params.resolveGatewayContext()?.gatewayTlsFingerprint,
    resolveAvailability: deviceRuntime.resolveAvailability,
    transfer: nodeBootstrapTransfer,
    prepareArtifact: async (record, signal) =>
      (await prepareNodeArtifact(record.profileSnapshot, signal)).artifact,
  });
  let executeSessionTool: WorkerSessionToolExecutor = async () => {
    throw new Error("Worker session tools are unavailable");
  };
  let dispatchChild: WorkerPlacementDispatchContract["dispatch"] = async () => {
    throw new Error("Worker session dispatch is unavailable");
  };
  const computers = createWorkerComputerService({
    store: params.startup.store,
    placements: params.startup.placementStore,
    resolveGatewayContext: params.resolveGatewayContext,
    getNodeTransport: () => deviceRuntime.getNodeTransport(),
    warn: (message) => workerEnvironmentLog.warn(message),
  });
  const invokePreparedWorkspace = async (request: {
    deviceId: string;
    input: NodeWorkerPreparedWorkspaceInput;
    expiresAtMs?: number;
    signal?: AbortSignal;
    assertCurrent: () => void;
  }) => {
    const { input, signal, assertCurrent } = request;
    assertCurrent();
    const transport = deviceRuntime.getNodeTransport();
    if (!transport) {
      throw new Error("Prepared workspace node transport is unavailable");
    }
    const node = (await racePromiseWithAbortSignal(transport.listCurrentNodes(), signal)).find(
      (candidate) => candidate.nodeId === request.deviceId,
    );
    assertCurrent();
    if (!node || !transport.isCurrent(node)) {
      throw new Error("Prepared workspace node protocol is unavailable");
    }
    // Registration hashes the project with the existing workspace command budget.
    // An unused reserve's lifetime still bounds that work; binding only updates its owner.
    const timeoutMs =
      input.action === "register"
        ? Math.max(
            1,
            Math.min(
              NODE_WORKER_WORKSPACE_COMMAND_TIMEOUT_MS + NODE_WORKER_WORKSPACE_RESULT_GRACE_MS,
              request.expiresAtMs === undefined ? Infinity : request.expiresAtMs - Date.now(),
            ),
          )
        : 30_000;
    const result = await transport.invoke({
      node,
      command: NODE_WORKER_WORKSPACE_PREPARE_COMMAND,
      params: input,
      signal,
      timeoutMs,
      idempotencyKey: `${input.environmentId}:${input.preparationKey}:${input.action}`,
      isDispatchAuthorized: () => {
        assertCurrent();
        return transport.isCurrent(node);
      },
    });
    assertCurrent();
    if (!result.ok) {
      throw new Error(
        `Prepared workspace ${input.action} failed${result.error?.message ? `: ${result.error.message}` : ""}`,
      );
    }
    const payload = result.payloadJSON
      ? (JSON.parse(result.payloadJSON) as unknown)
      : result.payload;
    const registered = parseNodeWorkerPreparedWorkspaceResult(payload);
    if (
      !registered ||
      registered.gatewayNamespace !== input.gatewayNamespace ||
      registered.environmentId !== input.environmentId ||
      registered.preparationKey !== input.preparationKey ||
      registered.cacheKey !== input.cacheKey ||
      (input.action === "register" &&
        (registered.workspaceDir !== input.workspaceDir ||
          registered.homeDir !== input.homeDir ||
          registered.sourceManifestRef !== input.sourceManifestRef))
    ) {
      throw new Error("Node did not acknowledge the exact prepared workspace");
    }
  };
  const workerEnvironmentServiceBase = createWorkerEnvironmentService({
    projectNamespace: nodeWorkerGatewayNamespace,
    prepareComputer: computers.prepare,
    executeComputer: computers.execute,
    closeComputers: computers.close,
    store: params.startup.store,
    getConfig: getRuntimeConfig,
    maintainProviders: (signal) =>
      maintainConfiguredWorkerProviders({
        getRegistry: params.getPluginRegistry,
        getConfig: getRuntimeConfig,
        signal,
        warn: (message) => workerEnvironmentLog.warn(message),
      }),
    // Plugin reload replaces the registry object; resolve against the live binding.
    resolveProvider: (providerId) =>
      providerId === DEVICE_WORKER_PROVIDER_ID
        ? deviceRuntime.provider
        : resolveWorkerProvider(params.getPluginRegistry(), providerId),
    prepareInstallation,
    ensureNodeWorkerBundle,
    prepareNodeBootstrap: nodeEnrollment.prepare,
    prepareNodeArtifacts: async (profileSnapshot, signal) => {
      const pin = new AbortController();
      try {
        const preparedBootstrap = await prepareNodeArtifact(
          profileSnapshot,
          signal ? AbortSignal.any([signal, pin.signal]) : pin.signal,
        );
        signal?.throwIfAborted();
        const bootstrap = preparedBootstrap.artifact;
        preparedBootstrap.assertCurrent();
        const bundle = await racePromiseWithAbortSignal(prepareInstallation("bundle"), signal);
        signal?.throwIfAborted();
        if (bundle.install !== "bundle") {
          throw new Error("Worker preparation requires a bundle artifact");
        }
        return {
          artifacts: {
            nodeBootstrapSha256: bootstrap.tarballSha256,
            enabledPluginIds: [...bootstrap.enabledPluginIds],
            workerBundleHash: bundle.bundleHash,
            workerArchiveSha256: bundle.tarballSha256,
            openclawVersion: bundle.openclawVersion,
            protocolFeatures: [...bundle.protocolFeatures],
          },
          assertCurrent: preparedBootstrap.assertCurrent,
        };
      } finally {
        pin.abort();
      }
    },
    registerPreparedWorkspace: ({ record, deviceId, workspace, assertCurrent, signal }) =>
      invokePreparedWorkspace({
        deviceId,
        assertCurrent,
        signal,
        ...(record.preparation?.consumedAtMs === null
          ? { expiresAtMs: record.preparation.expiresAtMs }
          : {}),
        input: {
          action: "register",
          gatewayNamespace: nodeWorkerGatewayNamespace,
          environmentId: record.environmentId,
          ...workspace,
        },
      }),
    bindPreparedWorkspace: async ({ assertCurrent, signal, ...binding }) => {
      assertCurrent();
      const record = params.startup.store.get(binding.environmentId);
      if (!record?.nodeDeviceId || record.sharedHost !== false) {
        throw new Error("Prepared workspace requires its dedicated node");
      }
      await invokePreparedWorkspace({
        deviceId: record.nodeDeviceId,
        assertCurrent,
        signal,
        input: { action: "bind", gatewayNamespace: nodeWorkerGatewayNamespace, ...binding },
      });
    },
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
          dispatchChild: (...args) => dispatchChild(...args),
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
