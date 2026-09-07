import type { ManagedServiceNativeHandoff } from "../../infra/update-managed-service-native-control.js";
import type { createUpdateRecoveryPackageHooks } from "../../infra/update-run-recovery-package.js";
import type { createUpdateRecoveryCheckpointReplay } from "../../infra/update-run-recovery-replay.js";
import type { OpenClawStateLeaseContext } from "../../state/openclaw-state-lease-context.js";
/** Live executor context only. Never serialize it into worker options or a descriptor. */
export type UpdateCommandRecovery = Parameters<typeof createUpdateRecoveryPackageHooks>[0] & {
  /** Rechecks final lifecycle readiness, not merely stored proof or a claim ID. */
  assertReady: () => void;
  /** Same-process transport admitted before recovery creation; never serialize. */
  managedNativeHandoff?: ManagedServiceNativeHandoff;
  /**
   * Executor-owned PUBLICATION interval with live lease rebinding, not capture
   * exclusion. No default: the capture-only owner must never be adapted here.
   * Runtime callbacks and the interval fence are supplied only while held.
   */
  checkpointReplay?: {
    withDatabaseFilePublication: NonNullable<
      OpenClawStateLeaseContext["withDatabaseFilePublication"]
    >;
    /** Runtime/resource owners remain responsible for these live assertions. */
    access: Omit<
      Parameters<typeof createUpdateRecoveryCheckpointReplay>[0],
      "expected" | "database" | "fence" | "bindPublishedRecord"
    >;
  };
};
