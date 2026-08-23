import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerLease, WorkerProvider } from "../../plugins/types.js";
import type { WorkerCredentialBroker } from "./credential-broker.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";
import type { WorkerTunnelManager } from "./tunnel.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

type NodeLease = Extract<WorkerLease, { node: { deviceId: string } }>;

type WorkerNodeProvisioningOptions = {
  store: WorkerEnvironmentStore;
  tunnels?: Pick<WorkerTunnelManager, "stop">;
  ensureNodeWorkerBundle?: (deviceId: string) => Promise<WorkerAdmissionHandshake>;
  commitReady: WorkerCredentialBroker["commitReady"];
  move: (
    record: WorkerEnvironmentRecord,
    to: "draining" | "destroying",
    patch?: Parameters<WorkerEnvironmentStore["transition"]>[0]["patch"],
  ) => WorkerEnvironmentRecord;
  destroyProviderLease: (
    record: WorkerEnvironmentRecord,
    leaseId: string,
    provider: WorkerProvider<"internal">,
  ) => Promise<void>;
  finishProvenDestroy: (record: WorkerEnvironmentRecord) => Promise<WorkerEnvironmentRecord>;
  saveError: (record: WorkerEnvironmentRecord, error: unknown) => WorkerEnvironmentRecord;
  serviceError: (code: "bootstrap_failure", message: string) => Error;
};

export function createWorkerNodeProvisioning(options: WorkerNodeProvisioningOptions) {
  const fail = async (
    record: WorkerEnvironmentRecord,
    lease: NodeLease,
    provider: WorkerProvider<"internal">,
    error: unknown,
  ): Promise<never> => {
    const detail = boundedError(error);
    const requested = options.store.requestDestroy({
      environmentId: record.environmentId,
      state: record.state,
      terminalState: "failed",
      lastError: detail,
    });
    const draining = options.move(requested, "draining", {
      leaseId: lease.leaseId,
      nodeDeviceId: lease.node.deviceId,
      sshEndpoint: null,
      sharedHost: lease.sharedHost === true,
      desktop: lease.desktop ?? null,
      lastError: detail,
    });
    await options.tunnels?.stop(record.environmentId);
    const destroying = options.move(draining, "destroying", { lastError: detail });
    try {
      await options.destroyProviderLease(record, lease.leaseId, provider);
    } catch (cleanupError: unknown) {
      options.saveError(
        destroying,
        new Error(`${detail}; provider teardown pending: ${boundedError(cleanupError)}`),
      );
      throw options.serviceError(
        "bootstrap_failure",
        `Worker node bootstrap failed; teardown is pending: ${detail}`,
      );
    }
    await options.finishProvenDestroy(destroying);
    throw options.serviceError("bootstrap_failure", `Worker node bootstrap failed: ${detail}`);
  };

  return async (
    record: WorkerEnvironmentRecord,
    lease: NodeLease,
    provider: WorkerProvider<"internal">,
    patch: { leaseId: string; sharedHost: boolean; desktop: WorkerLease["desktop"] | null },
  ): Promise<WorkerEnvironmentRecord> => {
    let nodeBuild: WorkerAdmissionHandshake;
    try {
      if (!options.ensureNodeWorkerBundle) {
        throw new Error("Device worker bundle installer is unavailable");
      }
      nodeBuild = await options.ensureNodeWorkerBundle(lease.node.deviceId);
    } catch (error) {
      return await fail(record, lease, provider, error);
    }
    return options.commitReady(
      record,
      { ...nodeBuild, installKind: "bundle" },
      {
        ...patch,
        nodeDeviceId: lease.node.deviceId,
        sshEndpoint: null,
      },
    );
  };
}
