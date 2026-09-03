import { isDeepStrictEqual } from "node:util";
import type { WorkerProvider } from "../../plugins/types.js";
import { DEVICE_WORKER_PROVIDER_ID } from "./device-provider-identity.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { requireProviderOperationTimeoutMs } from "./service-validation.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import type { WorkerTunnelStopReason } from "./tunnel-contract.js";

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
  >,
) {
  const { store, serviceError, move, inState } = options;
  const tunnels = options.tunnelManager;

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
    // Shared hosts require an exact stop acknowledgement unless the operator explicitly
    // abandons a paired device; only dedicated leases have provider-owned physical teardown.
    const abandon =
      reason === "operator-abandon" && record.providerId === DEVICE_WORKER_PROVIDER_ID;
    await tunnels?.stop(
      record.environmentId,
      record.ownerEpoch,
      abandon || (record.nodeDeviceId !== null && record.sharedHost === false) ? reason : undefined,
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

  return {
    requireCurrentOwner,
    stopOwner,
    destroyLease,
    beginDrain,
    beginDestroy,
    finishProvenDestroy,
  };
}
