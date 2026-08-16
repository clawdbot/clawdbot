import type {
  WorkerAdmissionHandshake,
  WorkerSessionsSendParams,
  WorkerSessionsSpawnParams,
  WorkerSessionToolResult,
  WorkerTranscriptCommitErrorReason,
  WorkerTranscriptCommitParams,
  WorkerTranscriptCommitResult,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { onSessionIdentityMutation } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { SecretRef } from "../../config/types.secrets.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type {
  WorkerProfile,
  WorkerProvider,
  WorkerSshEndpoint,
  WorkerSshIdentity,
} from "../../plugins/types.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import type { WorkerConnectionIdentity } from "./admission.js";
import { workerBootstrapOperationTimeoutMs } from "./bootstrap.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import { createWorkerCredentialBroker } from "./credential-broker.js";
import { createWorkerEnvironmentAccess } from "./environment-access.js";
import {
  registerWorkerInferenceSessionDrain,
  type WorkerInferenceSessionDrain,
} from "./inference-control-internal.js";
import type { WorkerInferenceStore } from "./inference-store.js";
import { createWorkerInferenceManager, type WorkerInferenceExecutor } from "./inference.js";
import type { WorkerLiveEventReceiver } from "./live-events.js";
import type { NodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import type { WorkerSessionPlacementGate } from "./placement-worker-gate.js";
import { createWorkerProviderLifecycle } from "./provider-lifecycle.js";
import type {
  WorkerEnvironmentTeardownAuthorization,
  WorkerProviderFactReconciliation,
} from "./provider-lifecycle.js";
import type { WorkerEnvironmentState } from "./state.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentStore,
  WorkerEnvironmentTransitionPatch as TransitionPatch,
} from "./store.js";
import type { WorkerTunnelManager } from "./tunnel.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";
import { createWorkerTurnRpc } from "./worker-turn-rpc.js";

type WorkerEnvironmentServiceErrorCode =
  | "profile_not_found"
  | "provider_not_found"
  | "environment_not_found"
  | "invalid_profile"
  | "invalid_state"
  | "desktop_app_not_found"
  | "unsupported_platform"
  | "launcher_failure"
  | "provider_failure"
  | "bootstrap_failure"
  | "worker_build_mismatch";

class WorkerEnvironmentServiceError extends Error {
  constructor(
    readonly code: WorkerEnvironmentServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const serviceError = (code: WorkerEnvironmentServiceErrorCode, message: string) =>
  new WorkerEnvironmentServiceError(code, message);

const isServiceError = (error: unknown, code: WorkerEnvironmentServiceErrorCode): boolean =>
  error instanceof WorkerEnvironmentServiceError && error.code === code;

type WorkerEnvironmentServiceOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  resolveProvider: (providerId: string) => WorkerProvider | undefined;
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
  ) => Promise<WorkerInstallationArtifact>;
  bootstrapWorker: (params: {
    operationId: string;
    sshEndpoint: WorkerSshEndpoint;
    installation: WorkerInstallationArtifact;
    resolveIdentity: (keyRef: SecretRef) => Promise<WorkerSshIdentity>;
    signal: AbortSignal;
  }) => Promise<WorkerAdmissionHandshake>;
  resolveSshIdentity?: (params: {
    provider: WorkerProvider;
    leaseId: string;
    profile: WorkerProfile;
    keyRef: SecretRef;
  }) => Promise<WorkerSshIdentity>;
  ensureNodeWorkerBundle?: (deviceId: string) => Promise<WorkerAdmissionHandshake>;
  tunnelManager?: WorkerTunnelManager;
  nodeTunnelManager?: NodeWorkerTunnelManager;
  stopNodeWorkerBundleTransfers?: () => void;
  reconcileIntervalMs?: number;
  providerCallTimeoutMs?: number;
  bootstrapCallTimeoutMs?: number;
  workerCredentialTtlMs?: number;
  generateWorkerCredential?: (bytes: number) => string;
  resolveWorkerGateway?: () => { host: "127.0.0.1" | "::1"; port: number } | undefined;
  now?: () => number;
  logger?: { warn: (message: string) => void };
  applyTranscriptCommit?: (params: {
    identity: WorkerConnectionIdentity;
    request: WorkerTranscriptCommitParams;
  }) => Promise<
    | { ok: true; result: WorkerTranscriptCommitResult }
    | { ok: false; reason: WorkerTranscriptCommitErrorReason }
  >;
  liveEvents?: Pick<
    WorkerLiveEventReceiver,
    "apply" | "bindSession" | "clear" | "clearEnvironment" | "rotateCredential" | "start"
  >;
  executeInference: WorkerInferenceExecutor;
  inferenceStore?: WorkerInferenceStore;
  placementStore?: WorkerSessionPlacementGate;
  executeSessionTool?: (
    params:
      | {
          identity: WorkerConnectionIdentity;
          toolName: "sessions_spawn";
          request: WorkerSessionsSpawnParams;
          signal?: AbortSignal;
        }
      | {
          identity: WorkerConnectionIdentity;
          toolName: "sessions_send";
          request: WorkerSessionsSendParams;
          signal?: AbortSignal;
        },
  ) => Promise<WorkerSessionToolResult>;
};

export function createWorkerEnvironmentService(options: WorkerEnvironmentServiceOptions) {
  const { store } = options;
  const warn = (message: string) => options.logger?.warn(message);
  const operations = new KeyedAsyncQueue();
  const providerOperations = new KeyedAsyncQueue();
  const activeOperations = new Set<Promise<unknown>>();
  const now = options.now ?? Date.now;
  const tunnelLifecycle =
    options.tunnelManager || options.nodeTunnelManager
      ? {
          stop: async (environmentId: string, ownerEpoch?: number) => {
            await Promise.all([
              options.tunnelManager?.stop(environmentId, ownerEpoch),
              options.nodeTunnelManager?.stop(environmentId, ownerEpoch),
            ]);
          },
        }
      : undefined;
  const inference = createWorkerInferenceManager({
    execute: options.executeInference,
    getConfig: options.getConfig,
    now,
    ...(options.inferenceStore ? { store: options.inferenceStore } : {}),
  });
  const inferenceWithDrain = inference as typeof inference & {
    beginSessionDrain(sessionId: string): WorkerInferenceSessionDrain;
  };
  let reconcileInFlight: Promise<WorkerProviderFactReconciliation[]> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let unsubscribeSessionIdentityMutation: (() => void) | undefined;
  let stopping = false;

  const inState = (record: WorkerEnvironmentRecord, ...states: WorkerEnvironmentState[]) =>
    states.includes(record.state);

  const trackOperation = <T>(operation: Promise<T>) => {
    activeOperations.add(operation);
    const release = () => activeOperations.delete(operation);
    void operation.then(release, release);
    return operation;
  };

  const withLock = <T>(environmentId: string, task: () => Promise<T>) =>
    trackOperation(operations.enqueue(environmentId, task));

  const callProvider = async <T>(
    environmentId: string,
    run: () => Promise<T>,
    timeoutMs?: number,
  ): Promise<T> => {
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    const operation = trackOperation(
      providerOperations.enqueue(environmentId, async () => {
        signalStarted();
        return await run();
      }),
    );
    await started;
    // Timeout completion must not release provider ownership or permit replay/destroy overlap.
    return await withTimeout(
      operation,
      options.providerCallTimeoutMs ?? timeoutMs ?? 300_000,
      "Worker provider operation",
    );
  };

  const callBootstrap = async <T>(
    installation: WorkerInstallationArtifact,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    const operation = Promise.resolve().then(() => run(controller.signal));
    try {
      return await withTimeout(
        operation,
        options.bootstrapCallTimeoutMs ?? workerBootstrapOperationTimeoutMs(installation),
        "Worker bootstrap operation",
      );
    } catch (error) {
      // The production runner force-kills SSH on abort and settles after child close. Await that
      // contract: provider teardown must never race a child still mutating the lease.
      controller.abort();
      await operation.catch(() => undefined);
      throw error;
    }
  };

  const move = (
    record: WorkerEnvironmentRecord,
    to: WorkerEnvironmentState,
    patch?: TransitionPatch,
  ) => {
    const next = store.transition({
      environmentId: record.environmentId,
      from: record.state,
      to,
      patch,
    });
    if (to !== "ready" && to !== "idle" && to !== "attached") {
      credentialBroker.clearEnvironment(record.environmentId);
    }
    if (to !== "attached") {
      inference.cancelEnvironment(record.environmentId);
      options.liveEvents?.clearEnvironment(record.environmentId);
    }
    return next;
  };

  const saveError = (record: WorkerEnvironmentRecord, error: unknown) => {
    // Once bootstrap failure owns the terminal outcome, preserve that causal error across
    // transient provider/inspection failures so the final failed row stays actionable.
    if (record.teardownTerminalState === "failed" && record.lastError) {
      return record;
    }
    return store.recordError({
      environmentId: record.environmentId,
      state: record.state,
      error: boundedError(error),
    });
  };

  const credentialBroker = createWorkerCredentialBroker({
    store,
    prepareInstallation: options.prepareInstallation,
    tunnelManager: tunnelLifecycle,
    workerCredentialTtlMs: options.workerCredentialTtlMs,
    generateWorkerCredential: options.generateWorkerCredential,
    liveEvents: options.liveEvents,
    placementStore: options.placementStore,
    now,
    isStopping: () => stopping,
    cancelInferenceEnvironment: (environmentId) => inference.cancelEnvironment(environmentId),
    inState,
    move,
    serviceError,
    withLock,
  });

  const providerLifecycle = createWorkerProviderLifecycle({
    store,
    getConfig: options.getConfig,
    resolveProvider: options.resolveProvider,
    prepareInstallation: options.prepareInstallation,
    bootstrapWorker: options.bootstrapWorker,
    resolveSshIdentity: options.resolveSshIdentity,
    ensureNodeWorkerBundle: options.ensureNodeWorkerBundle,
    providerCallTimeoutMs: options.providerCallTimeoutMs,
    tunnelManager: tunnelLifecycle,
    placementStore: options.placementStore,
    credentialBroker,
    callBootstrap,
    callProvider,
    inState,
    isServiceError,
    isStopping: () => stopping,
    move,
    saveError,
    serviceError,
    withLock,
  });

  const environmentAccess = createWorkerEnvironmentAccess({
    store,
    getConfig: options.getConfig,
    prepareCurrentBundle: async () => await options.prepareInstallation("bundle"),
    tunnelManager: options.tunnelManager,
    nodeTunnelManager: options.nodeTunnelManager,
    resolveWorkerGateway: options.resolveWorkerGateway,
    now,
    identityResolverFor: providerLifecycle.identityResolverFor,
    inState,
    isStopping: () => stopping,
    providerFor: providerLifecycle.providerFor,
    serviceError,
    withLock,
  });

  const turnRpc = createWorkerTurnRpc({
    store,
    prepareInstallation: options.prepareInstallation,
    applyTranscriptCommit: options.applyTranscriptCommit,
    liveEvents: options.liveEvents,
    placementStore: options.placementStore,
    executeSessionTool: options.executeSessionTool,
    inference,
    isStopping: () => stopping,
    now,
    withLock,
  });

  const unavailableProviderFacts = (environmentId: string): WorkerProviderFactReconciliation => ({
    environmentId,
    hostIsolation: "unavailable",
  });

  const reconcileEnvironment = async (
    environmentId: string,
  ): Promise<WorkerProviderFactReconciliation> => {
    if (stopping) {
      return unavailableProviderFacts(environmentId);
    }
    return await withLock(environmentId, async () => {
      const current = store.get(environmentId);
      if (!current || inState(current, "destroyed", "failed", "orphaned")) {
        return unavailableProviderFacts(environmentId);
      }
      return await providerLifecycle.reconcileRecord(current);
    });
  };

  const reconcilePass = async () => {
    const tasks = store.listForReconcile().map(
      (candidate) => async () =>
        await reconcileEnvironment(candidate.environmentId).catch(() => {
          warn(
            `Worker environment reconcile failed (${candidate.environmentId}, ${candidate.providerId})`,
          );
          return unavailableProviderFacts(candidate.environmentId);
        }),
    );
    const { results } = await runTasksWithConcurrency({ tasks, limit: 8 });
    store.pruneTerminalEnvironments();
    return results;
  };

  const reconcileOnce = () => {
    if (stopping) {
      return Promise.resolve([]);
    }
    return (reconcileInFlight ??= reconcilePass().finally(() => {
      reconcileInFlight = undefined;
    }));
  };

  const start = () => {
    if (interval || stopping) {
      return;
    }
    unsubscribeSessionIdentityMutation = onSessionIdentityMutation((mutation) => {
      const currentSessionId = "current" in mutation ? mutation.current.sessionId : undefined;
      if (mutation.previous.sessionId && mutation.previous.sessionId !== currentSessionId) {
        inference.cancelSession(mutation.previous.sessionId);
      }
    });
    options.liveEvents?.start();
    interval = setInterval(
      () => void reconcileOnce().catch(() => warn("Worker environment reconcile sweep failed")),
      options.reconcileIntervalMs ?? 60_000,
    );
    interval.unref?.();
    void reconcileOnce().catch(() => warn("Worker environment startup reconcile failed"));
  };

  const stop = async () => {
    stopping = true;
    clearInterval(interval);
    interval = undefined;
    unsubscribeSessionIdentityMutation?.();
    unsubscribeSessionIdentityMutation = undefined;
    await inference.stop();
    credentialBroker.clear();
    options.liveEvents?.clear();
    options.stopNodeWorkerBundleTransfers?.();
    await environmentAccess.stopAllTunnels();
    const reconciliation = reconcileInFlight;
    if (reconciliation) {
      await Promise.allSettled([reconciliation]);
    }
    while (activeOperations.size > 0) {
      await Promise.allSettled(activeOperations);
    }
    credentialBroker.clear();
    turnRpc.clear();
    options.liveEvents?.clear();
  };

  const service = {
    list: environmentAccess.list,
    get: environmentAccess.get,
    create: async (profileId: string, idempotencyKey: string) =>
      environmentAccess.project(
        await providerLifecycle.createWithProfile(profileId, idempotencyKey),
      ),
    createFromProfileSnapshot: async (
      profile: { profileId: string; providerId: string; profileSnapshot: WorkerProfile },
      idempotencyKey: string,
    ) =>
      environmentAccess.project(
        await providerLifecycle.createWithProfile(profile.profileId, idempotencyKey, {
          providerId: profile.providerId,
          profileSnapshot: profile.profileSnapshot,
        }),
      ),
    destroy: async (environmentId: string) =>
      environmentAccess.project(await providerLifecycle.destroy(environmentId)),
    destroyOwned: async (
      environmentId: string,
      authorizeTeardown: WorkerEnvironmentTeardownAuthorization,
    ) =>
      environmentAccess.project(
        await providerLifecycle.destroy(environmentId, { authorizeTeardown }),
      ),
    destroyUnattached: async (environmentId: string) =>
      environmentAccess.project(
        await providerLifecycle.destroy(environmentId, { requireUnattached: true }),
      ),
    observeDesktop: environmentAccess.observeDesktop,
    launchDesktopApp: environmentAccess.launchDesktopApp,
    admitWorker: turnRpc.admitWorker,
    validateWorkerConnection: turnRpc.validateWorkerConnection,
    commitTranscript: turnRpc.commitTranscript,
    pushLiveEvent: turnRpc.pushLiveEvent,
    executeSessionTool: turnRpc.executeSessionTool,
    startInference: turnRpc.startInference,
    cancelInference: turnRpc.cancelInference,
    cancelInferenceForSession: turnRpc.cancelInferenceForSession,
    hasInferenceForSession: turnRpc.hasInferenceForSession,
    resolveInferenceSessionForRunId: turnRpc.resolveInferenceSessionForRunId,
    resolveSshIdentity: async (environmentId: string) => {
      const record = store.get(environmentId);
      if (!record) {
        throw serviceError("environment_not_found", `Unknown worker environment: ${environmentId}`);
      }
      if (!record.leaseId || !record.sshEndpoint) {
        throw serviceError(
          "invalid_state",
          `Worker environment ${environmentId} has no active SSH endpoint`,
        );
      }
      const provider = providerLifecycle.providerFor(record.providerId);
      return await providerLifecycle.identityResolverFor(
        record,
        provider,
        record.leaseId,
      )(record.sshEndpoint.keyRef);
    },
    attachSession: credentialBroker.attachSession,
    takeMintedCredential: credentialBroker.takeMintedCredential,
    acquireTurnCredential: credentialBroker.acquireTurnCredential,
    acknowledgeCredentialDelivery: credentialBroker.acknowledgeCredentialDelivery,
    isWorkerBuildMismatchError: (error: unknown) => isServiceError(error, "worker_build_mismatch"),
    startTunnel: environmentAccess.startTunnel,
    stopTunnel: environmentAccess.stopTunnel,
    reconcileEnvironment,
    reconcileOnce,
    start,
    stop,
  };
  registerWorkerInferenceSessionDrain(service, (sessionId) =>
    inferenceWithDrain.beginSessionDrain(sessionId),
  );
  return service;
}

export type WorkerEnvironmentService = ReturnType<typeof createWorkerEnvironmentService>;
