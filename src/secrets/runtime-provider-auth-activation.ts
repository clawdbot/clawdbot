/** Process-local Gateway owner for serialized provider-auth snapshot publication. */
import type { PreparedSecretsRuntimeSnapshot } from "./runtime-state.js";

type ProviderAuthRuntimeSnapshotActivation = (params: {
  snapshot: PreparedSecretsRuntimeSnapshot;
  expectedRevision: number;
  activateSnapshotIfCurrent: () => boolean;
}) => Promise<boolean>;

let activationHandler: ProviderAuthRuntimeSnapshotActivation | null = null;

function registerProviderAuthRuntimeSnapshotActivation(
  handler: ProviderAuthRuntimeSnapshotActivation,
): void {
  activationHandler = handler;
}

export function registerProviderAuthRuntimeSnapshotActivationOwner(owner: {
  runExclusive: (operation: () => Promise<boolean>) => Promise<boolean>;
  isCurrent: (snapshot: PreparedSecretsRuntimeSnapshot, expectedRevision: number) => boolean;
  assertValid: (snapshot: PreparedSecretsRuntimeSnapshot) => void;
  publish: (snapshot: PreparedSecretsRuntimeSnapshot) => Promise<void>;
  onError: (error: unknown, snapshot: PreparedSecretsRuntimeSnapshot) => never;
}): void {
  registerProviderAuthRuntimeSnapshotActivation(
    async (params) =>
      await owner.runExclusive(async () => {
        if (!owner.isCurrent(params.snapshot, params.expectedRevision)) {
          return false;
        }
        try {
          owner.assertValid(params.snapshot);
          if (!params.activateSnapshotIfCurrent()) {
            return false;
          }
          await owner.publish(params.snapshot);
          return true;
        } catch (error) {
          return owner.onError(error, params.snapshot);
        }
      }),
  );
}

export function clearProviderAuthRuntimeSnapshotActivation(): void {
  activationHandler = null;
}

export async function activateProviderAuthRuntimeSnapshot(params: {
  snapshot: PreparedSecretsRuntimeSnapshot;
  expectedRevision: number;
  activateSnapshotIfCurrent: () => boolean;
}): Promise<boolean> {
  return activationHandler ? await activationHandler(params) : params.activateSnapshotIfCurrent();
}
