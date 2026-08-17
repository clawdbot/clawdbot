import {
  WorkerProviderError,
  type WorkerExecutionMode,
  type WorkerLease,
  type WorkerProvider,
} from "../../plugins/types.js";
import type { WorkerEnvironmentTransitionPatch } from "./store.js";

type WorkerLeaseModeMismatch = {
  error: WorkerProviderError;
  patch: WorkerEnvironmentTransitionPatch;
};

export function resolveWorkerLeaseModeMismatch(
  provider: WorkerProvider,
  lease: WorkerLease,
): WorkerLeaseModeMismatch | undefined {
  const modes = provider.supportedExecutionModes;
  const executionMode: WorkerExecutionMode | undefined = modes?.length === 1 ? modes[0] : undefined;
  const leaseMode: WorkerExecutionMode = lease.node ? "worker-turn" : "remote-exec";
  if (!executionMode || executionMode === leaseMode) {
    return undefined;
  }

  return {
    error: new WorkerProviderError(
      `${executionMode} providers must return a ${executionMode === "worker-turn" ? "node" : "SSH"} lease`,
    ),
    patch: {
      leaseId: lease.leaseId,
      sharedHost: lease.sharedHost === true,
      desktop: lease.desktop ?? null,
      ...(lease.node
        ? { nodeDeviceId: lease.node.deviceId, sshEndpoint: null }
        : { nodeDeviceId: null, sshEndpoint: lease.ssh }),
    },
  };
}
