import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerLease, WorkerProvider } from "../../plugins/types.js";
import type { WorkerCredentialBroker } from "./credential-broker.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentTransitionPatch } from "./store.js";

type NodeLease = Extract<WorkerLease, { node: { deviceId: string } }>;

type WorkerNodeProvisioningOptions = {
  ensureNodeWorkerBundle?: (deviceId: string) => Promise<WorkerAdmissionHandshake>;
  commitReady: WorkerCredentialBroker["commitReady"];
  failBootstrap: (
    record: WorkerEnvironmentRecord,
    leaseId: string,
    provider: WorkerProvider,
    error: unknown,
    patch: WorkerEnvironmentTransitionPatch,
  ) => Promise<never>;
};

export function createWorkerNodeProvisioning(options: WorkerNodeProvisioningOptions) {
  return async (
    record: WorkerEnvironmentRecord,
    lease: NodeLease,
    provider: WorkerProvider,
    patch: { leaseId: string; sharedHost: boolean; desktop: WorkerLease["desktop"] | null },
  ): Promise<WorkerEnvironmentRecord> => {
    const nodePatch = {
      ...patch,
      nodeDeviceId: lease.node.deviceId,
      sshEndpoint: null,
    };
    let nodeBuild: WorkerAdmissionHandshake;
    try {
      if (!options.ensureNodeWorkerBundle) {
        throw new Error("Device worker bundle installer is unavailable");
      }
      nodeBuild = await options.ensureNodeWorkerBundle(lease.node.deviceId);
    } catch (error) {
      return await options.failBootstrap(record, lease.leaseId, provider, error, nodePatch);
    }
    return options.commitReady(record, { ...nodeBuild, installKind: "bundle" }, nodePatch);
  };
}
