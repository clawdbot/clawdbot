import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { getRuntimeConfig } from "../config/config.js";
import { getPairedDevice } from "../infra/device-pairing.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import {
  getActiveSecretsRuntimeConfigSnapshot,
  getActiveSecretsRuntimeEnvState,
} from "../secrets/runtime-state.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { DesktopSessionRegistry } from "./desktop/session-registry.js";
import type { NodeWorkerSupervisorTransport } from "./node-registry-private.js";
import type { WorkerBundleProducer, WorkerNpmArtifact } from "./worker-environments/bundle.js";
import {
  bindDeviceWorkerAvailability,
  createDeviceWorkerRuntime,
  DEVICE_WORKER_PROVIDER_ID,
} from "./worker-environments/device-provider.js";
import type { WorkerLiveEventReceiver } from "./worker-environments/live-events.js";
import type { WorkerSessionPlacementStore } from "./worker-environments/placement-store.js";
import type { WorkerPlacementDispatchContract } from "./worker-environments/service-contract.js";
import type { WorkerEnvironmentService } from "./worker-environments/service.js";
import type { WorkerTunnelManager } from "./worker-environments/tunnel.js";

type WorkerEnvironmentStore = ReturnType<
  typeof import("./worker-environments/store.js").createWorkerEnvironmentStore
>;
type WorkerEnvironmentRecord = ReturnType<WorkerEnvironmentStore["list"]>[number];
type WorkerGatewayEndpoint = { host: "127.0.0.1" | "::1"; port: number } | undefined;
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
  bindWorkerSessionDispatch?: (dispatch: WorkerPlacementDispatchContract["dispatch"]) => void;
  bindDeviceNodeControl?: (transport: NodeWorkerSupervisorTransport) => void;
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
  resolveWorkerGateway: () => WorkerGatewayEndpoint;
  desktopSessionRegistry: DesktopSessionRegistry;
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
    { createWorkerSessionToolExecutor },
    { resolveWorkerProvider },
  ] = await Promise.all([
    import("./worker-environments/service.js"),
    import("./worker-environments/live-events.js"),
    import("./worker-environments/placement-worker-gate.js"),
    import("./worker-environments/transcript-commit.js"),
    import("./worker-environments/tunnel.js"),
    import("./worker-environments/worker-session-tool-executor.js"),
    import("../plugins/worker-provider-registry.js"),
  ]);
  // The Gateway state-directory lock proves that executors from the previous
  // process are gone. Resolve their ambiguous effects before placement
  // reconciliation attempts to release the owning worker claims.
  params.startup.placementStore.recoverWorkerSessionToolOperationsAfterRestart();
  // A crashed gateway can leak local turn claims; drop them before workers re-admit turns.
  params.startup.placementStore.clearLocalTurnClaimsAfterRestart();
  const placementGate = createWorkerSessionPlacementGate(params.startup.placementStore);
  let workerBundleProducer: WorkerBundleProducer | undefined;
  let workerNpmArtifact: Promise<WorkerNpmArtifact> | undefined;
  const prepareInstallation = async (install: "bundle" | "npm") => {
    const [workerRuntime, { WORKER_PROTOCOL_FEATURES }] = await Promise.all([
      loadWorkerEnvironmentRuntimeModule(),
      import("../../packages/gateway-protocol/src/schema/worker-admission.js"),
    ]);
    workerBundleProducer ??= workerRuntime.createWorkerBundleProducer({
      protocolFeatures: WORKER_PROTOCOL_FEATURES,
    });
    const bundle = await workerBundleProducer.prepare();
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
  let executeSessionTool: ReturnType<typeof createWorkerSessionToolExecutor> = async () => {
    throw new Error("Worker session tools are unavailable");
  };
  let dispatchChild: WorkerPlacementDispatchContract["dispatch"] = async () => {
    throw new Error("Worker session dispatch is unavailable");
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
    resolveNodeWorkerBuild: async (deviceId) => {
      const build = await deviceRuntime.resolveWorkerBuild(deviceId);
      return build ? structuredClone(build) : undefined;
    },
    tunnelManager: workerTunnelManager,
    resolveWorkerGateway: params.resolveWorkerGateway,
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
    logger: params.log.child("worker-environments"),
  });
  const workerEnvironmentService = workerEnvironmentServiceBase;
  bindDeviceWorkerAvailability(workerEnvironmentService, deviceRuntime.isAvailable);
  executeSessionTool = createWorkerSessionToolExecutor({
    placements: params.startup.placementStore,
    environments: workerEnvironmentService,
    dispatchChild: (request) => dispatchChild(request),
  });
  return {
    workerEnvironmentService,
    workerLiveEvents,
    workerTunnelManager,
    bindWorkerSessionDispatch: (dispatch) => {
      dispatchChild = dispatch;
    },
    bindDeviceNodeControl: deviceRuntime.bindNodeTransport,
  };
}
