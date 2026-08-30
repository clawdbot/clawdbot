import { isDeepStrictEqual } from "node:util";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import type { WorkerTunnelStopReason } from "./tunnel-contract.js";

export function createWorkerProviderOwnerLifecycle(
  options: Pick<WorkerProviderLifecycleOptions, "store" | "tunnelManager" | "serviceError">,
) {
  const { store, serviceError } = options;
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

  return { requireCurrentOwner, stopOwner };
}
