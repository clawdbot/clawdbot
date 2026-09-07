import { isDeepStrictEqual } from "node:util";
import {
  WorkerProviderError,
  type WorkerExecutionMode,
  type WorkerLease,
  type WorkerProfile,
  type WorkerProvider,
} from "../../plugins/types.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentTransitionPatch,
} from "./environment-record.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";
import {
  createWorkerProjectPreparation,
  readWorkerProjectSnapshot,
} from "./project-preparation.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import type { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import {
  requireProviderOperationTimeoutMs,
  requireWorkerLease,
  resolveWorkerLeaseTransportError,
} from "./service-validation.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

type WorkerProviderProvisioningOptions = Pick<
  WorkerProviderLifecycleOptions,
  | "store"
  | "now"
  | "callProvider"
  | "isStopping"
  | "isServiceError"
  | "projectNamespace"
  | "providerCallTimeoutMs"
  | "prepareInstallation"
  | "move"
  | "saveError"
  | "serviceError"
> & {
  nodeProvisioning: ReturnType<typeof createWorkerNodeProvisioning>;
  requireWorkerProfile: (value: unknown) => WorkerProfile;
  requireCurrentOwner: (record: WorkerEnvironmentRecord) => WorkerEnvironmentRecord;
  installFor: (record: WorkerEnvironmentRecord) => WorkerInstallationArtifact["install"];
  finishBootstrap: (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    installation: WorkerInstallationArtifact,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
  ) => Promise<WorkerEnvironmentRecord>;
  failBootstrap: (
    record: WorkerEnvironmentRecord,
    leaseId: string,
    provider: WorkerProvider,
    error: unknown,
    failureCode?: "bootstrap_failure" | "invalid_profile",
    leasePatch?: WorkerEnvironmentTransitionPatch,
  ) => Promise<never>;
};

/** Owns one provider allocation through project preparation and transport handoff. */
export function createWorkerProviderProvisioner(options: WorkerProviderProvisioningOptions) {
  const {
    store,
    callProvider,
    move,
    saveError,
    serviceError,
    nodeProvisioning,
    requireWorkerProfile,
    requireCurrentOwner,
    installFor,
    finishBootstrap,
    failBootstrap,
  } = options;
  const now = options.now ?? Date.now;

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

  return async (
    initialRecord: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    preparedInstallation?: WorkerInstallationArtifact,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
    beforeProvision?: () => void,
  ) => {
    let record = initialRecord;
    let lease: WorkerLease;
    let executionMode: WorkerExecutionMode | undefined;
    let enrollmentOperation: ReturnType<typeof nodeProvisioning.createEnrollmentOperation>;
    let projectOperation: ReturnType<typeof createWorkerProjectPreparation> | undefined;
    try {
      const profile = requireWorkerProfile(record.profileSnapshot.settings);
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
      const preparation = readWorkerProjectPreparation(record.profileSnapshot.project);
      const machineClass =
        preparation?.target.machineClass ??
        (typeof record.profileSnapshot.machineClass === "string"
          ? record.profileSnapshot.machineClass
          : undefined);
      if (
        preparation &&
        !isDeepStrictEqual(
          provider.resolvePreparationTarget?.(profile, machineClass),
          preparation.target,
        )
      ) {
        throw new Error("Worker preparation allocation target changed");
      }
      enrollmentOperation = nodeProvisioning.createEnrollmentOperation(
        record,
        provider,
        cancellation?.signal,
        preparedInstallation,
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
          ...(preparation
            ? {
                preparation: {
                  key: preparation.key,
                  cacheKey: preparation.cacheKey,
                  purpose: record.preparation ? "reserve" : "session",
                  demandAtMs: record.preparation?.demandAtMs ?? record.createdAtMs,
                  setupRecipe: preparation.setupRecipe,
                },
                // Exact committed recipe approval was frozen at intent admission.
                setupAuthorized: true,
              }
            : {}),
          signal: cancellation?.signal,
          requireCurrent: () => {
            const current = requireCurrentOwner(record);
            if (
              options.isStopping() ||
              current.destroyRequestedAtMs !== null ||
              current.provisionOperationId !== record.provisionOperationId ||
              !isDeepStrictEqual(current.profileSnapshot.project, record.profileSnapshot.project) ||
              (current.preparation?.consumedAtMs === null &&
                current.preparation.expiresAtMs <= now())
            ) {
              throw new Error("Worker project preparation owner is no longer current");
            }
          },
        });
      }
      const provisionOptions =
        machineClass || executionMode || enrollmentOperation || projectOperation || cancellation
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
      const provision = () => {
        // Installation and the provider queue can outlive reserve policy. The pool
        // records invalidation before this owner rereads its durable destroy intent.
        beforeProvision?.();
        const current = requireCurrentOwner(record);
        if (
          current.preparation?.consumedAtMs === null &&
          current.preparation.expiresAtMs <= now()
        ) {
          store.requestDestroy({
            environmentId: current.environmentId,
            state: current.state,
            lastError: "Unused prepared worker expired before allocation",
          });
          throw new DOMException("Prepared worker expired", "AbortError");
        }
        if (options.isStopping() || current.destroyRequestedAtMs !== null) {
          throw new Error("Worker provisioning operation is closed");
        }
        // Only an attempted allocation needs provider reconciliation. Keep rejected
        // fresh requests cancellable without resolving a lease that never existed.
        record = current.state === "requested" ? move(current, "provisioning") : current;
        return provider.provision(profile, record.provisionOperationId, provisionOptions);
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
        return preserveIndeterminateProvisionCleanup(record, error);
      }
      // A cancelled attempt may already own a paid allocation, even when its late
      // provider error looks permanent. Keep it available for canonical teardown.
      cancellation?.assertActive();
      const detail = boundedError(error);
      if (
        error instanceof WorkerProviderError ||
        options.isServiceError(error, "invalid_profile")
      ) {
        move(record, "failed", { lastError: detail });
        throw serviceError("invalid_profile", `Worker provider rejected profile: ${detail}`);
      }
      saveError(record, error);
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
        record,
        lease.leaseId,
        provider,
        leaseModeError,
        "invalid_profile",
        patch,
      );
    }
    if (lease.node) {
      return await nodeProvisioning.finish(
        record,
        lease,
        provider,
        patch,
        preparedInstallation,
        cancellation,
        projectOperation?.getPreparedWorkspace(),
      );
    }
    const bootstrapping = move(record, "bootstrapping", patch);
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
    return finishBootstrap(bootstrapping, provider, installation, cancellation);
  };
}
