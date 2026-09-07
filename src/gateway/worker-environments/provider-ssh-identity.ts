import type { SecretRef } from "../../config/types.secrets.js";
import type { WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import type { WorkerEnvironmentRecord } from "./store.js";

export function createWorkerSshIdentityResolver(options: {
  assertCurrent: (record: WorkerEnvironmentRecord) => void;
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
      const assertAuthorized = () => {
        options.assertCurrent(record);
        authorize?.();
      };
      return await options.callProvider(record.environmentId, async () => {
        assertAuthorized();
        const identity = await resolveSshIdentity({
          provider,
          leaseId,
          profile,
          keyRef,
          assertAuthorized,
        });
        assertAuthorized();
        return identity;
      });
    };
  };
}
