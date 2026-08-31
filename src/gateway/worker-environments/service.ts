import type {
  WorkerGitHubPublishParams,
  WorkerPortalParams,
  WorkerSessionsSendParams,
  WorkerSessionsSpawnParams,
  WorkerSessionToolResult,
  WorkerTranscriptCommitErrorReason,
  WorkerTranscriptCommitParams,
  WorkerTranscriptCommitResult,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { onSessionIdentityMutation } from "../../config/sessions/session-accessor.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { isSqliteLockError } from "../../infra/sqlite-transaction.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type { WorkerExecutionMode, WorkerProfile } from "../../plugins/types.js";
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
import type { WorkerNodeDesktopCarrier } from "./node-desktop-carrier.js";
import type { NodeWorkerTunnelManager } from "./node-worker-tunnel.js";
import type { WorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerNodePortalCarrier } from "./portal-node-carrier.js";
import { createWorkerProviderLifecycle } from "./provider-lifecycle.js";
import type { WorkerProviderLifecycleInputOptions } from "./provider-lifecycle.types.js";
import type { WorkerEnvironmentState } from "./state.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentTransitionPatch as TransitionPatch,
} from "./store.js";
import type { WorkerTunnelStopReason } from "./tunnel-contract.js";
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
  | "bootstrap_failure";

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

type WorkerEnvironmentServiceOptions = WorkerProviderLifecycleInputOptions & {
  prepareComputer?: (
    claim: import("./placement-store.js").WorkerSessionTurnClaim,
  ) => Promise<import("./computer-transport.js").PreparedWorkerComputer | undefined>;
  executeComputer?: import("./worker-turn-computer-rpc.js").WorkerComputerExecutor;
  closeComputers?: () => Promise<void>;
  tunnelManager?: WorkerTunnelManager;
  nodeTunnelManager?: NodeWorkerTunnelManager;
  nodeDesktopCarrier?: WorkerNodeDesktopCarrier;
  nodePortalCarrier?: WorkerNodePortalCarrier;
  closeWorkerPortals?: (environmentId: string, ownerEpoch?: number) => Promise<void>;
  stopNodeEnrollmentWaits?: () => void;
  closeNodeBootstrapArtifacts?: () => Promise<void>;
  stopNodeWorkerBundleTransfers?: () => void;
  maintainProviders?: (signal: AbortSignal) => Promise<void>;
  reconcileIntervalMs?: number;
  bootstrapCallTimeoutMs?: number;
  workerCredentialTtlMs?: number;
  generateWorkerCredential?: (bytes: number) => string;
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
        }
      | {
          identity: WorkerConnectionIdentity;
          toolName: "github_publish";
          request: WorkerGitHubPublishParams;
          signal?: AbortSignal;
        }
      | {
          identity: WorkerConnectionIdentity;
          toolName: "portal";
          request: WorkerPortalParams;
          signal?: AbortSignal;
        },
  ) => Promise<WorkerSessionToolResult>;
};

export type WorkerEnvironmentReconcileCore = () => Promise<void>;
type WorkerEnvironmentReconcileGuard = (
  environmentId: string,
  reconcileCore: WorkerEnvironmentReconcileCore,
) => Promise<void>;

export function createWorkerEnvironmentService(options: WorkerEnvironmentServiceOptions) {
  const { store } = options;
  const warn = (message: string) => options.logger?.warn(message);
  const operations = new KeyedAsyncQueue();
  const providerOperations = new KeyedAsyncQueue();
  const activeOperations = new Set<Promise<unknown>>();
  const now = options.now ?? Date.now;
  const tunnelLifecycle =
    options.tunnelManager ||
    options.nodeTunnelManager ||
    options.nodeDesktopCarrier ||
    options.nodePortalCarrier
      ? {
          stop: async (
            environmentId: string,
            ownerEpoch?: number,
            reason?: WorkerTunnelStopReason,
          ) => {
            await Promise.all([
              options.tunnelManager?.stop(environmentId, ownerEpoch),
              options.nodeTunnelManager?.stop(environmentId, ownerEpoch, reason),
              options.nodeDesktopCarrier?.stop(environmentId, ownerEpoch),
              options.nodePortalCarrier?.stop(environmentId, ownerEpoch),
              options.closeWorkerPortals?.(environmentId, ownerEpoch),
            ]);
          },
        }
      : undefined;
  const inference = createWorkerInferenceManager({
    execute: options.executeInference,
    getConfig: options.getConfig,
    ...(options.inferenceStore ? { store: options.inferenceStore } : {}),
  });
  const inferenceWithDrain = inference as typeof inference & {
    beginSessionDrain(sessionId: string): WorkerInferenceSessionDrain;
  };
  let reconcileInFlight: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let unsubscribeSessionIdentityMutation: (() => void) | undefined;
  let unsubscribeTurnClaimClosed = options.placementStore?.registerTurnClaimClosedHandler((claim) =>
    inference.cancelClaim(claim),
  );
  let reconcileEnvironmentGuard: WorkerEnvironmentReconcileGuard | undefined;
  let reconcileEnvironmentGuardClosing = false;
  // Coalesce the whole guarded closure. Serializing only provider work would still let a
  // losing recovery pass attach or sync after the winner advances the placement.
  const guardedReconcileInFlight = new Map<string, Promise<void>>();
  let stopping = false;
  const maintenanceAbort = new AbortController();
  let maintenanceInFlight: Promise<void> | undefined;

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
      expectedOwnerEpoch: record.ownerEpoch,
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
    prepareNodeBootstrap: options.prepareNodeBootstrap,
    projectNamespace: options.projectNamespace,
    prepareNodeRuntime: options.prepareNodeRuntime,
    closeNodeRuntime: options.closeNodeRuntime,
    prepareNodeEnrollment: options.prepareNodeEnrollment,
    closeNodeEnrollment: options.closeNodeEnrollment,
    retireNodeEnrollment: options.retireNodeEnrollment,
    placementStore: options.placementStore,
    providerCallTimeoutMs: options.providerCallTimeoutMs,
    tunnelManager: tunnelLifecycle,
    credentialBroker,
    callBootstrap,
    callProvider,
    inState,
    isServiceError: (error, code) =>
      error instanceof WorkerEnvironmentServiceError && error.code === code,
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
    nodeDesktopCarrier: options.nodeDesktopCarrier,
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
    executeComputer: options.executeComputer,
    inference,
    isStopping: () => stopping,
    now,
    withLock,
  });

  const reconcileEnvironmentCore = async (environmentId: string) => {
    if (stopping) {
      return;
    }
    await withLock(environmentId, async () => {
      const current = store.get(environmentId);
      if (!current || inState(current, "destroyed", "failed", "orphaned")) {
        return;
      }
      await providerLifecycle.reconcileRecord(current);
    });
  };

  const reconcileEnvironment = async (environmentId: string) => {
    if (stopping) {
      return;
    }
    const guard = reconcileEnvironmentGuard;
    if (!guard) {
      await reconcileEnvironmentCore(environmentId);
      return;
    }
    if (reconcileEnvironmentGuardClosing) {
      return;
    }
    const active = guardedReconcileInFlight.get(environmentId);
    if (active) {
      await active;
      return;
    }
    const operation = guard(environmentId, async () => {
      await reconcileEnvironmentCore(environmentId);
    });
    guardedReconcileInFlight.set(environmentId, operation);
    try {
      await operation;
    } finally {
      if (guardedReconcileInFlight.get(environmentId) === operation) {
        guardedReconcileInFlight.delete(environmentId);
      }
    }
  };

  const closeReconcileEnvironmentGuard = async (expected?: WorkerEnvironmentReconcileGuard) => {
    const guard = reconcileEnvironmentGuard;
    if (!guard || (expected && guard !== expected)) {
      return;
    }
    reconcileEnvironmentGuardClosing = true;
    while (guardedReconcileInFlight.size > 0) {
      await Promise.allSettled(guardedReconcileInFlight.values());
    }
    if (reconcileEnvironmentGuard === guard) {
      reconcileEnvironmentGuard = undefined;
      reconcileEnvironmentGuardClosing = false;
    }
  };

  const installReconcileEnvironmentGuard = (guard: WorkerEnvironmentReconcileGuard) => {
    if (reconcileEnvironmentGuard) {
      throw new Error("Worker environment reconciliation guard is already installed");
    }
    reconcileEnvironmentGuard = guard;
    reconcileEnvironmentGuardClosing = false;
    return async () => await closeReconcileEnvironmentGuard(guard);
  };

  const reconcilePass = async () => {
    const tasks = store
      .listForReconcile()
      .map(
        (candidate) => () =>
          reconcileEnvironment(candidate.environmentId).catch(() =>
            warn(
              `Worker environment reconcile failed (${candidate.environmentId}, ${candidate.providerId})`,
            ),
          ),
      );
    await runTasksWithConcurrency({ tasks, limit: 8 });
    try {
      store.pruneTerminalEnvironments();
    } catch (error) {
      // Pruning is opportunistic and retries on the next sweep; lock contention must not
      // turn a healthy worker reconciliation into a startup or periodic-reconcile failure.
      if (!isSqliteLockError(error)) {
        throw error;
      }
    }
  };

  const reconcileOnce = () => {
    if (stopping) {
      return Promise.resolve();
    }
    if (options.maintainProviders && !maintenanceInFlight) {
      // Keep cleanup off the placement/reconcile wait path, but retain the actual promise
      // until shutdown has aborted and drained every provider-owned command.
      maintenanceInFlight = trackOperation(
        Promise.resolve()
          .then(() => {
            maintenanceAbort.signal.throwIfAborted();
            return options.maintainProviders!(maintenanceAbort.signal);
          })
          .catch(() => {
            if (!stopping) {
              warn("Worker provider maintenance sweep failed; cleanup will retry");
            }
          })
          .finally(() => {
            maintenanceInFlight = undefined;
          }),
      );
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
    maintenanceAbort.abort();
    options.stopNodeEnrollmentWaits?.();
    clearInterval(interval);
    interval = undefined;
    unsubscribeSessionIdentityMutation?.();
    unsubscribeSessionIdentityMutation = undefined;
    unsubscribeTurnClaimClosed?.();
    unsubscribeTurnClaimClosed = undefined;
    // Shutdown owns the guard handoff: stop new admission and drain admitted recovery before
    // inference or tunnel teardown can invalidate its closure-bound placement authority.
    await closeReconcileEnvironmentGuard();
    await options
      .closeComputers?.()
      .catch(() => warn("Session computer cleanup failed during Gateway shutdown"));
    await inference.stop();
    credentialBroker.clear();
    options.liveEvents?.clear();
    options.stopNodeWorkerBundleTransfers?.();
    try {
      await Promise.all([environmentAccess.stopAllTunnels(), options.nodePortalCarrier?.stopAll()]);
    } finally {
      // Tunnel failures cannot release shutdown before admitted owner-bound operations drain.
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
      await options.closeNodeBootstrapArtifacts?.();
    }
  };

  const providerSupportsExecutionMode = (providerId: string, mode: WorkerExecutionMode) =>
    options.resolveProvider(providerId)?.supportedExecutionModes?.includes(mode) === true;
  const requireProviderExecutionMode = (providerId: string, mode?: WorkerExecutionMode) => {
    if (!mode) {
      return;
    }
    const provider = options.resolveProvider(providerId);
    if (!provider) {
      throw serviceError("provider_not_found", `Unknown worker provider: ${providerId}`);
    }
    if (!provider.supportedExecutionModes?.includes(mode)) {
      throw serviceError(
        "invalid_profile",
        `Worker provider ${providerId} does not support ${mode} placement`,
      );
    }
  };
  const configuredProfileProviderId = (profileId: string) => {
    const profile = options.getConfig().cloudWorkers?.profiles?.[profileId];
    if (!profile) {
      throw serviceError("profile_not_found", `Unknown worker profile: ${profileId}`);
    }
    return profile.provider;
  };

  const service = {
    list: environmentAccess.list,
    supportsProviderExecutionMode: providerSupportsExecutionMode,
    supportsExecutionMode: (profileId: string, mode: WorkerExecutionMode) => {
      const profile = options.getConfig().cloudWorkers?.profiles?.[profileId];
      return profile ? providerSupportsExecutionMode(profile.provider, mode) : false;
    },
    requiresNodeEnrollment: (profileId: string, providerId?: string) => {
      const id = providerId ?? options.getConfig().cloudWorkers?.profiles?.[profileId]?.provider;
      return id ? options.resolveProvider(id)?.requiresNodeEnrollment === true : false;
    },
    get: environmentAccess.get,
    inventoryVersion: store.inventoryVersion,
    supportsNodePortal: async (environmentId: string, ownerEpoch: number) =>
      (await options.nodePortalCarrier?.supports(environmentId, ownerEpoch)) === true,
    hasPendingNodeEnrollmentSetup: (setupId: string, deviceId: string) =>
      store.hasPendingNodeEnrollmentSetup(setupId, deviceId),
    listMachineOptions: async (profileId: string) =>
      providerLifecycle.listMachineOptions(profileId),
    create: async (
      profileId: string,
      idempotencyKey: string,
      machineClass?: string,
      executionMode?: WorkerExecutionMode,
      projectPath?: string,
    ) => {
      if (executionMode) {
        requireProviderExecutionMode(configuredProfileProviderId(profileId), executionMode);
      }
      return environmentAccess.project(
        await providerLifecycle.createWithProfile(profileId, idempotencyKey, {
          machineClass,
          executionMode,
          projectPath,
        }),
      );
    },
    createFromProfileSnapshot: async (
      profile: { profileId: string; providerId: string; profileSnapshot: WorkerProfile },
      idempotencyKey: string,
      machineClass?: string,
      executionMode?: WorkerExecutionMode,
      projectPath?: string,
    ) => {
      requireProviderExecutionMode(profile.providerId, executionMode);
      return environmentAccess.project(
        await providerLifecycle.createWithProfile(profile.profileId, idempotencyKey, {
          inherited: {
            providerId: profile.providerId,
            profileSnapshot: profile.profileSnapshot,
          },
          machineClass,
          executionMode,
          projectPath,
        }),
      );
    },
    destroy: async (environmentId: string) =>
      environmentAccess.project(await providerLifecycle.destroy(environmentId)),
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
    executeComputer: turnRpc.executeComputer,
    prepareComputer: options.prepareComputer,
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
    startTunnel: environmentAccess.startTunnel,
    stopTunnel: async (environmentId: string, ownerEpoch?: number) => {
      await Promise.all([
        environmentAccess.stopTunnel(environmentId, ownerEpoch),
        options.nodePortalCarrier?.stop(environmentId, ownerEpoch),
        options.closeWorkerPortals?.(environmentId, ownerEpoch),
      ]);
    },
    stopNodeEnrollmentWaits: options.stopNodeEnrollmentWaits,
    installReconcileEnvironmentGuard,
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
