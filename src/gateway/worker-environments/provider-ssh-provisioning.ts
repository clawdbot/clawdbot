import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { SecretRef } from "../../config/types.secrets.js";
import type { WorkerProfile, WorkerProvider, WorkerSshIdentity } from "../../plugins/types.js";
import { verifyWorkerAdmissionHandshake } from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { WorkerCredentialBroker } from "./credential-broker.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import type { WorkerEnvironmentRecord } from "./store.js";

type WorkerSshProvisioningOptions = Pick<
  WorkerProviderLifecycleOptions,
  "bootstrapWorker" | "callBootstrap" | "serviceError"
> & {
  commitReady: WorkerCredentialBroker["commitReady"];
  failBootstrap: (
    record: WorkerEnvironmentRecord,
    leaseId: string,
    provider: WorkerProvider,
    error: unknown,
  ) => Promise<never>;
};

export function createWorkerSshIdentityResolver(options: {
  callProvider: WorkerProviderLifecycleOptions["callProvider"];
  requireWorkerProfile: (value: unknown) => WorkerProfile;
  resolveSshIdentity: WorkerProviderLifecycleOptions["resolveSshIdentity"];
}) {
  return (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    leaseId: string,
    authorize?: () => void,
  ) => {
    const profile = options.requireWorkerProfile(record.profileSnapshot.settings);
    return async (keyRef: SecretRef) => {
      const resolveSshIdentity = options.resolveSshIdentity;
      if (!resolveSshIdentity) {
        throw new Error("Worker SSH identity resolution is unavailable");
      }
      return await options.callProvider(record.environmentId, () => {
        authorize?.();
        return resolveSshIdentity({ provider, leaseId, profile, keyRef });
      });
    };
  };
}

export function createWorkerSshProvisioning(options: WorkerSshProvisioningOptions) {
  return async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    installation: WorkerInstallationArtifact,
    resolveIdentity: (keyRef: SecretRef) => Promise<WorkerSshIdentity>,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
    authorize?: () => void,
  ): Promise<WorkerEnvironmentRecord> => {
    if (record.state !== "bootstrapping" || !record.leaseId || !record.sshEndpoint) {
      throw options.serviceError(
        "invalid_state",
        "Worker bootstrap requires a provisioned SSH lease",
      );
    }
    const leaseId = record.leaseId;
    const sshEndpoint = record.sshEndpoint;
    let receipt: WorkerAdmissionHandshake;
    try {
      authorize?.();
      receipt = await options.callBootstrap(installation, (signal) => {
        authorize?.();
        return options.bootstrapWorker({
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
      return await options.failBootstrap(record, leaseId, provider, error);
    }
    return options.commitReady(record, { ...receipt, installKind: "bundle" });
  };
}
