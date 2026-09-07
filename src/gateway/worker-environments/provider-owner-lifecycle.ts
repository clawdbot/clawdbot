import { isDeepStrictEqual } from "node:util";
import type { WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import { FORCED_WORKER_ABANDONMENT_ERROR } from "./placement-record.js";
import type {
  WorkerEnvironmentAbandonment,
  WorkerProviderLifecycleOptions,
} from "./provider-lifecycle.types.js";
import {
  requireProviderOperationTimeoutMs,
  requireWorkerAllocation,
} from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import {
  WorkerTunnelOwnerDisconnectedError,
  type WorkerTunnelStopReason,
} from "./tunnel-contract.js";
import { boundedWorkerError } from "./worker-error.js";

export function createWorkerProviderOwnerLifecycle(
  options: Pick<
    WorkerProviderLifecycleOptions,
    | "store"
    | "tunnelManager"
    | "serviceError"
    | "callProvider"
    | "providerCallTimeoutMs"
    | "placementStore"
    | "move"
    | "inState"
    | "retireNodeEnrollment"
    | "saveError"
    | "withLock"
    | "isStopping"
  > & {
    providerFor: (providerId: string) => WorkerProvider;
    requireWorkerProfile: (value: unknown) => WorkerProfile;
  },
) {
  const {
    store,
    serviceError,
    move,
    inState,
    callProvider,
    saveError,
    withLock,
    providerFor,
    requireWorkerProfile,
  } = options;
  const tunnels = options.tunnelManager;

  const lifecycleLease = (record: WorkerEnvironmentRecord, leaseId: string) => ({
    leaseId,
    profile: requireWorkerProfile(record.profileSnapshot.settings),
  });

  const requireCurrentOwner = (record: WorkerEnvironmentRecord): WorkerEnvironmentRecord => {
    const current = store.get(record.environmentId);
    if (
      !current ||
      current.ownerEpoch !== record.ownerEpoch ||
      current.state !== record.state ||
      current.leaseId !== record.leaseId ||
      current.nodeDeviceId !== record.nodeDeviceId ||
      current.sharedHost !== record.sharedHost ||
      !isDeepStrictEqual(current.attachedSessionIds, record.attachedSessionIds)
    ) {
      throw serviceError("invalid_state", "Worker environment owner changed during teardown");
    }
    return current;
  };

  const stopOwner = async (
    record: WorkerEnvironmentRecord,
    reason?: WorkerTunnelStopReason,
  ): Promise<WorkerEnvironmentRecord> => {
    requireCurrentOwner(record);
    const sessionId = record.attachedSessionIds.length === 1 ? record.attachedSessionIds[0] : null;
    if (sessionId) {
      // Transfer an exact pending-result owner before credential revocation makes its
      // same-lifecycle worker permanently unreachable to recovery.
      options.placementStore?.prepareWorkspaceResultOwnerRevocation(
        { sessionId, environmentId: record.environmentId, ownerEpoch: record.ownerEpoch },
        new Error(record.lastError ?? "Cloud worker owner revoked before workspace recovery"),
      );
    }
    // Fence admission without erasing the attachment needed to stop a retained node worker.
    // A crash or failed stop leaves the exact scope available for teardown replay.
    store.revokeEnvironmentCredential(record.environmentId);
    // Only a dedicated node lease makes provider teardown proof of worker termination.
    // Shared or unknown host isolation still requires the exact worker's stop acknowledgement.
    await tunnels?.stop(
      record.environmentId,
      record.ownerEpoch,
      record.nodeDeviceId !== null && record.sharedHost === false ? reason : undefined,
    );
    return requireCurrentOwner(record);
  };

  const destroyLease = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    lease: Parameters<WorkerProvider["destroy"]>[0],
  ) => {
    requireCurrentOwner(record);
    const timeoutMs =
      options.providerCallTimeoutMs === undefined
        ? requireProviderOperationTimeoutMs(
            "destroy",
            provider.resolveDestroyTimeoutMs?.(lease.profile),
          )
        : undefined;
    await options.callProvider(
      record.environmentId,
      () => {
        // An earlier timed-out operation can keep this call queued across owner changes.
        requireCurrentOwner(record);
        return provider.destroy(lease);
      },
      timeoutMs,
    );
  };

  const beginDrain = (record: WorkerEnvironmentRecord) => {
    const failurePatch =
      record.teardownTerminalState === "failed" ? { lastError: record.lastError } : undefined;
    return inState(record, "bootstrapping", "ready", "attached", "idle")
      ? move(record, "draining", failurePatch)
      : record;
  };

  const beginDestroy = (record: WorkerEnvironmentRecord) => {
    const failurePatch =
      record.teardownTerminalState === "failed" ? { lastError: record.lastError } : undefined;
    const draining = beginDrain(record);
    if (draining.state === "draining") {
      return move(draining, "destroying", failurePatch);
    }
    if (draining.state === "destroying") {
      return draining;
    }
    throw serviceError("invalid_state", `Cannot destroy worker in state: ${record.state}`);
  };

  const finishProvenDestroy = async (record: WorkerEnvironmentRecord) => {
    const destroying = beginDestroy(requireCurrentOwner(record));
    if (destroying.nodeSetupId) {
      await options.retireNodeEnrollment?.(destroying);
    }
    requireCurrentOwner(destroying);
    if (destroying.teardownTerminalState !== "failed") {
      return move(destroying, "destroyed");
    }
    return move(destroying, "failed", {
      leaseId: null,
      nodeDeviceId: null,
      sshEndpoint: null,
      sharedHost: false,
      lastError: destroying.lastError ?? "Worker bootstrap failed after provider teardown",
    });
  };

  const cancelRequested = (record: WorkerEnvironmentRecord) =>
    move(record, "failed", { lastError: "Provisioning canceled before provider allocation" });

  const finishDestroy = async (record: WorkerEnvironmentRecord, provider?: WorkerProvider) => {
    let r = record;
    if (r.state === "requested") {
      return cancelRequested(requireCurrentOwner(r));
    }
    // Fence local authority even when the provider is unavailable. stopOwner preserves
    // shared/unknown-host stop acknowledgements before releasing their attachments.
    r = await stopOwner(r, "provider-destroying");
    r = r.nodeDeviceId !== null && r.sharedHost === false ? r : beginDrain(r);
    const owningProvider = provider ?? providerFor(r.providerId);
    let leaseId = r.leaseId;
    if (!leaseId) {
      let allocation: Awaited<ReturnType<WorkerProvider["resolveAllocation"]>>;
      try {
        allocation = requireWorkerAllocation(
          await callProvider(r.environmentId, () => {
            requireCurrentOwner(r);
            return owningProvider.resolveAllocation(
              requireWorkerProfile(r.profileSnapshot.settings),
              r.provisionOperationId,
            );
          }),
        );
      } catch (error) {
        saveError(requireCurrentOwner(r), error);
        throw serviceError("provider_failure", boundedWorkerError(error));
      }
      // Publish only the cleanup identity, never a fabricated transport or admission receipt.
      r = move(requireCurrentOwner(r), "draining", { ...allocation, lastError: r.lastError });
      leaseId = allocation.leaseId;
    }
    // A dedicated provider's destroy result proves physical teardown even if its node is
    // offline. Shared hosts retain the machine, so they still require the exact worker stop.
    const providerOwnsMachine = r.nodeDeviceId !== null && r.sharedHost === false;
    const destroying = providerOwnsMachine ? r : beginDestroy(r);
    try {
      await destroyLease(destroying, owningProvider, lifecycleLease(destroying, leaseId));
    } catch (error) {
      saveError(requireCurrentOwner(destroying), error);
      throw serviceError("provider_failure", boundedWorkerError(error));
    }
    return await finishProvenDestroy(
      providerOwnsMachine ? await stopOwner(destroying, "provider-destroyed") : destroying,
    );
  };

  const destroy = async (
    environmentId: string,
    destroyOptions: {
      requireUnattached?: boolean;
      abandonment?: WorkerEnvironmentAbandonment;
      retryRequested?: boolean;
    } = {},
  ) => {
    const stopping = options.isStopping();
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    return withLock(environmentId, async () => {
      const abandonment = destroyOptions.abandonment;
      abandonment?.authorize?.();
      let record = store.get(environmentId);
      if (!record) {
        throw serviceError("environment_not_found", `Unknown worker environment: ${environmentId}`);
      }
      if (
        inState(record, "destroyed", "failed", "orphaned") &&
        (!abandonment ||
          record.state === "destroyed" ||
          (record.state === "failed" && !record.leaseId))
      ) {
        return record;
      }
      if (
        abandonment &&
        (record.providerId !== DEVICE_WORKER_PROVIDER_ID ||
          record.ownerEpoch !== abandonment.ownerEpoch ||
          !record.nodeDeviceId ||
          record.sharedHost === false ||
          record.attachedSessionIds.length !== 1 ||
          record.attachedSessionIds[0] !== abandonment.sessionId)
      ) {
        throw serviceError(
          "invalid_state",
          "Abandoned device worker owner changed before retirement",
        );
      }
      if (destroyOptions.requireUnattached && record.attachedSessionIds.length > 0) {
        throw serviceError(
          "invalid_state",
          "Attached cloud workers must be stopped through sessions.reclaim",
        );
      }
      // Environment reconciliation owns retries of accepted cleanup. A background
      // placement projection must not replay its failed provider call or claim success.
      if (destroyOptions.retryRequested === false && record.destroyRequestedAtMs !== null) {
        throw serviceError(
          "invalid_state",
          `Worker environment cleanup is still pending: ${record.lastError ?? record.state}`,
        );
      }
      record = store.requestDestroy({
        environmentId,
        state: record.state,
        ...(abandonment
          ? { terminalState: "failed", lastError: FORCED_WORKER_ABANDONMENT_ERROR }
          : {}),
      });
      try {
        const destroyed = await finishDestroy(record);
        abandonment?.authorize?.();
        return destroyed;
      } catch (error) {
        if (!abandonment || !(error instanceof WorkerTunnelOwnerDisconnectedError)) {
          throw error;
        }
        abandonment.authorize?.();
        const current = requireCurrentOwner(record);
        if (current.destroyRequestedAtMs === null || store.getCredential(environmentId)) {
          throw serviceError("invalid_state", "Abandoned device worker authority is not fenced");
        }
        // Local cleanup has joined. Keep the exact old attachment for a physical stop on
        // reconnect; explicit abandonment releases only the session's local owner.
        return saveError(current, error);
      }
    });
  };

  return {
    requireCurrentOwner,
    stopOwner,
    destroyLease,
    beginDrain,
    finishProvenDestroy,
    lifecycleLease,
    finishDestroy,
    destroy,
  };
}
