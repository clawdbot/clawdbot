import { isDeepStrictEqual } from "node:util";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { SecretRef } from "../../config/types.secrets.js";
import {
  WorkerProviderError,
  type WorkerExecutionMode,
  type WorkerLease,
  type WorkerProvider,
  type WorkerSshIdentity,
} from "../../plugins/types.js";
import { verifyWorkerAdmissionHandshake } from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import {
  createWorkerProjectPreparation,
  readWorkerProjectSnapshot,
} from "./project-preparation.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import {
  requestStaleWorkerDestroy,
  retireMismatchedWorkerLease,
} from "./provider-persisted-lease.js";
import { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import { createWorkerSshIdentityResolver } from "./provider-ssh-identity.js";
import {
  normalizeWorkerMachineOptions,
  requireProviderOperationTimeoutMs,
  requireWorkerInstall,
  requireWorkerLease,
  requireWorkerLeaseStatus,
  requireWorkerProfile,
  resolveWorkerLeaseTransportError,
} from "./service-validation.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentTransitionPatch as TransitionPatch,
} from "./store.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

const ORPHANED_LEASE_ERROR = "Worker provider no longer recognizes the lease";

export function createWorkerProviderLifecycle(options: WorkerProviderLifecycleOptions) {
  const { store, callBootstrap, callProvider, inState, move, saveError, serviceError } = options;
  const { commitReady, ensurePendingCredential } = options.credentialBroker;

  const checkedProfile = (value: unknown) => requireWorkerProfile(value, serviceError);

  const providerFor = (providerId: string): WorkerProvider => {
    const provider = options.resolveProvider(providerId);
    if (provider) {
      return provider;
    }
    throw serviceError("provider_not_found", `Worker provider is unavailable: ${providerId}`);
  };

  const {
    requireCurrentOwner,
    stopOwner,
    destroyLease,
    beginDrain,
    finishProvenDestroy,
    lifecycleLease,
    finishDestroy,
    destroy,
  } = createWorkerProviderOwnerLifecycle({
    ...options,
    providerFor,
    requireWorkerProfile: checkedProfile,
  });

  const identityResolverFor = createWorkerSshIdentityResolver({
    assertCurrent: (record) => {
      const current = requireCurrentOwner(record);
      if (options.isStopping() || current.destroyRequestedAtMs !== null) {
        throw new Error("Worker SSH identity owner is no longer current");
      }
    },
    callProvider,
    requireWorkerProfile: checkedProfile,
    resolveSshIdentity: options.resolveSshIdentity,
  });

  const listMachineOptions = async (profileId: string) => {
    const profile = options.getConfig().cloudWorkers?.profiles?.[profileId];
    if (!profile) {
      return undefined;
    }
    const provider = options.resolveProvider(profile.provider);
    return normalizeWorkerMachineOptions(
      await provider?.listMachineOptions?.(checkedProfile(profile.settings ?? {})),
    );
  };

  const installFor = (record: WorkerEnvironmentRecord): WorkerInstallationArtifact["install"] =>
    requireWorkerInstall(record.profileSnapshot.install, serviceError);

  const failBootstrap = async (
    record: WorkerEnvironmentRecord,
    leaseId: string,
    provider: WorkerProvider,
    error: unknown,
    failureCode: "bootstrap_failure" | "invalid_profile" = "bootstrap_failure",
    leasePatch?: TransitionPatch,
  ): Promise<never> => {
    const detail = boundedError(error);
    const failureLabel =
      failureCode === "invalid_profile"
        ? "Worker provider returned an incompatible lease"
        : leasePatch?.nodeDeviceId
          ? "Worker node bootstrap failed"
          : "Worker bootstrap failed";
    const requested = store.requestDestroy({
      environmentId: record.environmentId,
      state: record.state,
      terminalState: "failed",
      lastError: detail,
    });
    const stopped = await stopOwner(requested);
    const draining = move(stopped, "draining", { ...leasePatch, lastError: detail });
    const destroying = move(draining, "destroying", { lastError: detail });
    try {
      await destroyLease(destroying, provider, lifecycleLease(destroying, leaseId));
    } catch (cleanupError: unknown) {
      // An indeterminate destroy must remain retryable; never hide a possibly-live paid lease
      // behind terminal failed state.
      saveError(
        destroying,
        new Error(`${detail}; provider teardown pending: ${boundedError(cleanupError)}`),
      );
      throw serviceError(failureCode, `${failureLabel}; teardown is pending: ${detail}`);
    }
    await finishProvenDestroy(destroying);
    throw serviceError(failureCode, `${failureLabel}: ${detail}`);
  };

  const preserveIndeterminateProvisionCleanup = (
    record: WorkerEnvironmentRecord,
    error: ReturnType<typeof WorkerProviderError.cleanupIndeterminate>,
  ): never => {
    // Split the durable diagnostic budget so neither the allocation failure nor its cleanup
    // failure can erase the other before restart reconciliation.
    const provisionDetail = boundedError(error.provisionError, 480);
    const cleanupDetail = boundedError(error.cleanupError, 480);
    const detail = `${provisionDetail}; provider teardown pending: ${cleanupDetail}`;
    store.adoptProvisionCleanupFailure({
      environmentId: record.environmentId,
      leaseId: error.leaseId,
      lastError: detail,
    });
    throw serviceError(
      "provider_failure",
      `Worker provider operation failed; teardown is pending: ${detail}`,
    );
  };

  const nodeProvisioning = createWorkerNodeProvisioning({
    ...options,
    commitReady,
    failBootstrap: async (record, leaseId, provider, error, patch) =>
      await failBootstrap(record, leaseId, provider, error, "bootstrap_failure", patch),
  });

  const bootstrapWorker = options.bootstrapWorker;
  const finishBootstrap = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    installation: WorkerInstallationArtifact,
    resolveIdentity: (keyRef: SecretRef) => Promise<WorkerSshIdentity>,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
    authorize?: () => void,
  ): Promise<WorkerEnvironmentRecord> => {
    if (record.state !== "bootstrapping" || !record.leaseId || !record.sshEndpoint) {
      throw serviceError("invalid_state", "Worker bootstrap requires a provisioned SSH lease");
    }
    const leaseId = record.leaseId;
    const sshEndpoint = record.sshEndpoint;
    let receipt: WorkerAdmissionHandshake;
    try {
      authorize?.();
      receipt = await callBootstrap(installation, (signal) => {
        authorize?.();
        return bootstrapWorker({
          operationId: record.provisionOperationId,
          sshEndpoint,
          installation,
          resolveIdentity,
          signal: cancellation ? AbortSignal.any([signal, cancellation.signal]) : signal,
          authorize,
        });
      });
      cancellation?.assertActive();
      if (!verifyWorkerAdmissionHandshake(receipt, installation)) {
        throw new Error("Worker bootstrap receipt does not match the expected build identity");
      }
      authorize?.();
    } catch (error) {
      return await failBootstrap(record, leaseId, provider, error);
    }
    return commitReady(record, { ...receipt, installKind: "bundle" });
  };

  const finishProvision = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    preparedInstallation?: WorkerInstallationArtifact,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
    authorize?: () => void,
  ) => {
    let lease: WorkerLease;
    let executionMode: WorkerExecutionMode | undefined;
    let enrollmentOperation: ReturnType<typeof nodeProvisioning.createEnrollmentOperation>;
    let projectOperation: ReturnType<typeof createWorkerProjectPreparation> | undefined;
    let provisioning = record;
    try {
      const profile = checkedProfile(record.profileSnapshot.settings);
      const requestedExecutionMode = record.profileSnapshot.executionMode;
      if (
        requestedExecutionMode !== undefined &&
        requestedExecutionMode !== "worker-turn" &&
        requestedExecutionMode !== "remote-exec"
      ) {
        throw new WorkerProviderError("Worker environment has an invalid placement execution mode");
      }
      executionMode = requestedExecutionMode;
      if (executionMode && !provider.supportedExecutionModes?.includes(executionMode)) {
        // Current provider metadata cannot disprove allocation by an earlier attempt.
        throw new Error(
          `Worker provider ${provider.id} does not support ${executionMode} placement`,
        );
      }
      const providerTimeoutMs =
        options.providerCallTimeoutMs === undefined
          ? requireProviderOperationTimeoutMs(
              "provision",
              provider.resolveProvisionTimeoutMs?.(profile),
            )
          : undefined;
      const machineClass =
        typeof record.profileSnapshot.machineClass === "string"
          ? record.profileSnapshot.machineClass
          : undefined;
      enrollmentOperation = nodeProvisioning.createEnrollmentOperation(
        record,
        provider,
        cancellation?.signal,
        preparedInstallation,
        authorize,
      );
      const project = readWorkerProjectSnapshot(record.profileSnapshot.project);
      if (project) {
        if (
          !provider.supportsProjectPreparation?.(profile, machineClass) ||
          !options.projectNamespace
        ) {
          throw new Error("Worker provider cannot resume its prepared project contract");
        }
        projectOperation = createWorkerProjectPreparation({
          project,
          namespace: options.projectNamespace,
          signal: cancellation?.signal,
          requireCurrent: () => {
            authorize?.();
            const current = requireCurrentOwner(provisioning);
            if (
              options.isStopping() ||
              current.destroyRequestedAtMs !== null ||
              current.provisionOperationId !== provisioning.provisionOperationId ||
              !isDeepStrictEqual(current.profileSnapshot.project, project)
            ) {
              throw new Error("Worker project preparation owner is no longer current");
            }
          },
        });
      }
      const provisionOptions =
        machineClass ||
        executionMode ||
        authorize ||
        enrollmentOperation ||
        projectOperation ||
        cancellation
          ? {
              ...(machineClass ? { machineClass } : {}),
              ...(executionMode ? { executionMode } : {}),
              ...(enrollmentOperation
                ? {
                    beginNodeEnrollment: enrollmentOperation.begin,
                    prepareNodeRuntime: enrollmentOperation.prepareRuntime,
                  }
                : {}),
              ...(cancellation ? { signal: cancellation.signal } : {}),
              ...(projectOperation ? { project: projectOperation.project } : {}),
            }
          : undefined;
      cancellation?.assertActive();
      if (authorize && !provider.provisionDelegated) {
        throw serviceError(
          "invalid_profile",
          `Worker provider ${provider.id} does not support delegated provisioning`,
        );
      }
      const provision = () => {
        const current = requireCurrentOwner(record);
        if (options.isStopping() || current.destroyRequestedAtMs !== null) {
          throw new Error("Worker provisioning operation is closed");
        }
        authorize?.();
        if (provisioning.state === "requested") {
          provisioning = move(provisioning, "provisioning");
        }
        return authorize
          ? provider.provisionDelegated!(profile, provisioning.provisionOperationId, {
              ...provisionOptions,
              assertAuthorized: authorize,
            })
          : provider.provision(profile, provisioning.provisionOperationId, provisionOptions);
      };
      lease = requireWorkerLease(
        await callProvider(
          record.environmentId,
          cancellation ? cancellation.retainProvider(provision) : provision,
          providerTimeoutMs,
        ),
      );
    } catch (error) {
      if (WorkerProviderError.isCleanupIndeterminate(error)) {
        return preserveIndeterminateProvisionCleanup(provisioning, error);
      }
      // A cancelled attempt may already own a paid allocation, even when its late
      // provider error looks permanent. Keep it available for canonical teardown.
      cancellation?.assertActive();
      const detail = boundedError(error);
      if (
        error instanceof WorkerProviderError ||
        options.isServiceError(error, "invalid_profile")
      ) {
        move(provisioning, "failed", { lastError: detail });
        throw serviceError("invalid_profile", `Worker provider rejected profile: ${detail}`);
      }
      if (WorkerProviderError.takeCleanupComplete(error)) {
        move(provisioning, "failed", { lastError: detail });
      } else {
        saveError(provisioning, error);
      }
      throw serviceError("provider_failure", `Worker provider operation failed: ${detail}`);
    } finally {
      projectOperation?.close();
      enrollmentOperation?.close();
    }
    // A timeout can happen after allocation; retain the same operation id for safe replay.
    const patch = {
      leaseId: lease.leaseId,
      sharedHost: lease.sharedHost === true,
      desktop: lease.desktop ?? null,
      ...(lease.node
        ? { nodeDeviceId: lease.node.deviceId, sshEndpoint: null }
        : { nodeDeviceId: null, sshEndpoint: lease.ssh }),
    };
    if (cancellation?.signal.aborted) {
      move(requireCurrentOwner(record), "draining", patch);
      cancellation.assertActive();
    }
    const leaseModeError = resolveWorkerLeaseTransportError(
      provider,
      lease.node ? "node" : "ssh",
      executionMode,
    );
    if (leaseModeError) {
      return await failBootstrap(
        provisioning,
        lease.leaseId,
        provider,
        leaseModeError,
        "invalid_profile",
        patch,
      );
    }
    if (lease.node) {
      return await nodeProvisioning.finish(
        provisioning,
        lease,
        provider,
        patch,
        preparedInstallation,
        cancellation,
        authorize,
      );
    }
    const bootstrapping = move(provisioning, "bootstrapping", patch);
    let installation = preparedInstallation;
    if (!installation) {
      try {
        // A persisted provisioning row can represent an allocation whose response was lost.
        // Replay the idempotent provider operation before packaging can terminalize that lease.
        installation = await options.prepareInstallation(
          installFor(bootstrapping),
          cancellation?.signal,
        );
        cancellation?.assertActive();
      } catch (error) {
        return await failBootstrap(bootstrapping, lease.leaseId, provider, error);
      }
    }
    return finishBootstrap(
      bootstrapping,
      provider,
      installation,
      identityResolverFor(bootstrapping, provider, lease.leaseId, authorize),
      cancellation,
      authorize,
    );
  };

  const resumeProvision = async (
    record: WorkerEnvironmentRecord,
    provider = providerFor(record.providerId),
    signal?: AbortSignal,
    retainProviderSettlement?: (settled: Promise<void>) => void,
    authorize?: () => void,
  ) => {
    const cancellation = signal
      ? createWorkerProvisionCancellation(store, record, signal)
      : undefined;
    if (cancellation) {
      retainProviderSettlement?.(cancellation.settled);
    }
    try {
      let installation: WorkerInstallationArtifact | undefined;
      await nodeProvisioning.prepare(record, provider, signal, authorize);
      cancellation?.assertActive();
      if (
        record.state === "requested" &&
        record.destroyRequestedAtMs === null &&
        provider.provisionBeforeInstallation !== true
      ) {
        try {
          // Fresh requests package before allocation. Once provisioning is durable, provider replay
          // must happen first because the previous response may have been lost after allocation.
          installation = await options.prepareInstallation(installFor(record), signal);
        } catch (error) {
          cancellation?.assertActive();
          const detail = boundedError(error);
          move(record, "failed", { lastError: detail });
          throw serviceError(
            "bootstrap_failure",
            `Worker installation preparation failed: ${detail}`,
          );
        }
        cancellation?.assertActive();
      }
      // Fresh requests stay cancelable through preparation and provider-queue admission;
      // finishProvision transitions them only inside the authorized provider callback.
      return await finishProvision(record, provider, installation, cancellation, authorize);
    } finally {
      cancellation?.close();
    }
  };

  const reconcileRecord = async (
    initialRecord: WorkerEnvironmentRecord,
    signal?: AbortSignal,
    retainProviderSettlement?: (settled: Promise<void>) => void,
    authorize?: () => void,
  ): Promise<void> => {
    let record = initialRecord;
    if (record.state === "requested" && record.destroyRequestedAtMs !== null) {
      return void (await finishDestroy(record));
    }
    let currentBundle: WorkerInstallationArtifact | undefined;
    if (record.destroyRequestedAtMs === null && inState(record, "ready", "idle", "attached")) {
      try {
        currentBundle = await options.prepareInstallation("bundle", signal);
        if (record.bootstrapReceipt) {
          if (verifyWorkerAdmissionHandshake(record.bootstrapReceipt, currentBundle)) {
            const sessionId = record.state === "attached" ? record.attachedSessionIds[0] : null;
            if (record.state !== "attached" || sessionId) {
              ensurePendingCredential(record, sessionId ?? null);
              record = store.get(record.environmentId) ?? record;
            }
          }
        }
      } catch {
        signal?.throwIfAborted();
        // Provider inspection and the state-specific path below retain their existing retry policy.
      }
    }
    let provider: WorkerProvider;
    try {
      provider = providerFor(record.providerId);
    } catch (error) {
      saveError(record, error);
      return;
    }
    const leaseId = record.leaseId;
    if (!leaseId) {
      if (
        record.destroyRequestedAtMs === null &&
        record.profileSnapshot.executionMode !== undefined &&
        !authorize
      ) {
        const requested = store.requestDestroy({
          environmentId: record.environmentId,
          state: record.state,
          terminalState: "failed",
          lastError: "Worker placement provisioning authority is unavailable after restart",
        });
        await finishDestroy(requested, provider).catch(() => undefined);
        return;
      }
      await (
        record.destroyRequestedAtMs !== null
          ? finishDestroy(record, provider)
          : resumeProvision(record, provider, signal, retainProviderSettlement, authorize)
      ).catch(() => undefined);
      return;
    }
    if (await retireMismatchedWorkerLease(record, provider, store, finishDestroy)) {
      return;
    }
    const inspection = await callProvider(record.environmentId, () =>
      provider.inspect(lifecycleLease(record, leaseId)),
    )
      .then(requireWorkerLeaseStatus)
      .catch((error: unknown) => {
        saveError(record, error);
        return undefined;
      });
    if (!inspection) {
      return;
    }
    const { status } = inspection;
    const teardownExpected = record.destroyRequestedAtMs !== null || record.state === "destroying";
    if (status === "destroyed") {
      requireCurrentOwner(record);
      const requested =
        record.destroyRequestedAtMs === null
          ? store.requestDestroy({
              environmentId: record.environmentId,
              state: record.state,
              ...(!teardownExpected
                ? {
                    terminalState: "failed",
                    lastError: "Worker environment disappeared before teardown was requested",
                  }
                : {}),
            })
          : record;
      const stopped = await stopOwner(requested, "provider-destroyed");
      const draining = beginDrain(stopped);
      await finishProvenDestroy(draining).catch((error: unknown) => {
        saveError(draining, error);
      });
      return;
    }
    if (status === "unknown") {
      requireCurrentOwner(record);
      // Provider loss fences placement authority before remote cleanup, which may remain
      // unreachable after node revocation. Preserve its exact attachment until stop is proven.
      const requested = teardownExpected
        ? record
        : store.requestDestroy({
            environmentId: record.environmentId,
            state: record.state,
            terminalState: "failed",
            lastError: ORPHANED_LEASE_ERROR,
          });
      await finishDestroy(requested, provider).catch(() => undefined);
      return;
    }
    if (status === "dormant") {
      if (teardownExpected) {
        await finishDestroy(record, provider).catch(() => undefined);
      }
      // A paired device may be offline without losing its lease. Keep that authoritative
      // holding state out of the unknown/orphan path until pairing itself is removed.
      return;
    }
    const inspectedSharedHost = inspection.sharedHost === true;
    if (record.sharedHost !== null && record.sharedHost !== inspectedSharedHost) {
      // Workspace actions capture isolation at tunnel creation. Fence the old actions before
      // committing a provider-owned change so no reconciliation can use stale host scope.
      record = await stopOwner(record);
    }
    record = store.reconcileSharedHost({
      environmentId: record.environmentId,
      state: record.state,
      leaseId,
      sharedHost: inspectedSharedHost,
    });
    if (record.destroyRequestedAtMs !== null) {
      await finishDestroy(record, provider).catch(() => undefined);
      return;
    }
    if (!record.sshEndpoint || record.state === "attached") {
      if (
        currentBundle &&
        (!record.bootstrapReceipt ||
          !verifyWorkerAdmissionHandshake(record.bootstrapReceipt, currentBundle))
      ) {
        // Attached and node-backed environments bind placement authority to the admitted build.
        // Retire stale owners; only unattached SSH leases can bootstrap a replacement in place.
        await finishDestroy(requestStaleWorkerDestroy(record, store), provider).catch(
          () => undefined,
        );
      }
      return;
    }
    if (record.state === "draining" && record.destroyRequestedAtMs === null) {
      // Draining without destroy intent is durable provider-loss cleanup.
      record = await stopOwner(record);
      move(record, "orphaned", { lastError: record.lastError ?? ORPHANED_LEASE_ERROR });
      return;
    }
    if (inState(record, "bootstrapping", "ready", "idle")) {
      let cancellation = signal
        ? createWorkerProvisionCancellation(store, record, signal)
        : undefined;
      if (cancellation) {
        retainProviderSettlement?.(cancellation.settled);
      }
      try {
        cancellation?.assertActive();
        let installation = currentBundle;
        try {
          // Bundle identity is local and canonical for both install channels. A matching admitted
          // receipt must not depend on npm registry availability during routine reconciliation.
          installation ??= await options.prepareInstallation("bundle", signal);
        } catch (error) {
          if (record.bootstrapReceipt && inState(record, "ready", "idle")) {
            saveError(record, error);
            return;
          }
          await failBootstrap(record, leaseId, provider, error).catch(() => undefined);
          return;
        }
        if (
          record.bootstrapReceipt &&
          verifyWorkerAdmissionHandshake(record.bootstrapReceipt, installation)
        ) {
          ensurePendingCredential(record, null);
          return;
        }
        if (installFor(record) === "npm") {
          try {
            installation = await options.prepareInstallation("npm", signal);
          } catch (error) {
            await failBootstrap(record, leaseId, provider, error).catch(() => undefined);
            return;
          }
        }
        record = await stopOwner(record);
        cancellation?.assertActive();
        const bootstrapping =
          record.state === "bootstrapping" ? record : move(record, "bootstrapping");
        if (cancellation && bootstrapping.ownerEpoch !== record.ownerEpoch) {
          // Rebootstrap retires the admitted owner. Transfer cancellation synchronously
          // to the committed epoch before a child can run under that new authority.
          cancellation.close();
          cancellation = createWorkerProvisionCancellation(
            store,
            bootstrapping,
            cancellation.signal,
          );
          retainProviderSettlement?.(cancellation.settled);
          cancellation.assertActive();
        }
        await finishBootstrap(
          bootstrapping,
          provider,
          installation,
          identityResolverFor(bootstrapping, provider, leaseId, authorize),
          cancellation,
          authorize,
        ).catch(() => undefined);
        return;
      } finally {
        cancellation?.close();
      }
    }
    if (inState(record, "draining", "destroying")) {
      await finishDestroy(record, provider).catch(() => undefined);
    }
  };

  const createWithProfile = createWorkerProviderIntent({
    ...options,
    providerFor,
    requireWorkerProfile: checkedProfile,
    resumeProvision,
  });

  return {
    createWithProfile,
    destroy,
    identityResolverFor,
    listMachineOptions,
    providerFor,
    reconcileRecord,
  };
}
