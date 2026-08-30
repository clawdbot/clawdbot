import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerLease, WorkerNodeEnrollment, WorkerProvider } from "../../plugins/types.js";
import type { WorkerCredentialBroker } from "./credential-broker.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentTransitionPatch } from "./store.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

type NodeLease = Extract<WorkerLease, { node: { deviceId: string } }>;

type WorkerNodeProvisioningOptions = Pick<
  WorkerProviderLifecycleOptions,
  | "store"
  | "isStopping"
  | "prepareNodeBootstrap"
  | "prepareNodeEnrollment"
  | "closeNodeEnrollment"
  | "ensureNodeWorkerBundle"
  | "move"
  | "serviceError"
> & {
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
  const prepare = async (record: WorkerEnvironmentRecord, provider: WorkerProvider) => {
    if (
      record.state !== "requested" ||
      !provider.requiresNodeEnrollment ||
      !options.prepareNodeBootstrap
    ) {
      return;
    }
    // Preparing the immutable runtime must finish before a fresh paid allocation.
    try {
      await options.prepareNodeBootstrap(record);
    } catch (error) {
      const current = options.store.get(record.environmentId);
      if (
        current?.state === "requested" &&
        current.provisionOperationId === record.provisionOperationId
      ) {
        options.move(current, "failed", { lastError: boundedError(error) });
      }
      throw options.serviceError(
        "bootstrap_failure",
        `Worker node bootstrap preparation failed: ${boundedError(error)}`,
      );
    }
    const current = options.store.get(record.environmentId);
    if (
      options.isStopping() ||
      !current ||
      current.state !== record.state ||
      current.provisionOperationId !== record.provisionOperationId ||
      current.destroyRequestedAtMs !== null
    ) {
      throw options.serviceError(
        "invalid_state",
        "Worker provisioning changed during bootstrap preparation",
      );
    }
  };

  const createEnrollmentOperation = (record: WorkerEnvironmentRecord, provider: WorkerProvider) => {
    if (provider.requiresNodeEnrollment !== true) {
      return undefined;
    }
    const prepareNodeEnrollment = options.prepareNodeEnrollment;
    if (!prepareNodeEnrollment) {
      throw new Error("Worker node enrollment runtime is unavailable");
    }
    let open = true;
    let enrollment: WorkerNodeEnrollment | undefined;
    let pending: Promise<WorkerNodeEnrollment> | undefined;
    return {
      begin: async () => {
        if (!open || options.isStopping()) {
          throw new Error("Worker provisioning operation is closed");
        }
        pending ??= prepareNodeEnrollment(record).then((prepared) => {
          // A provider timeout can close this operation during artifact preparation.
          if (!open || options.isStopping()) {
            options.closeNodeEnrollment?.(prepared);
            throw new Error("Worker provisioning operation is closed");
          }
          enrollment = prepared;
          return prepared;
        });
        return await pending;
      },
      close: () => {
        open = false;
        if (enrollment) {
          options.closeNodeEnrollment?.(enrollment);
        }
      },
    };
  };

  const finish = async (
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

  return { prepare, createEnrollmentOperation, finish };
}
