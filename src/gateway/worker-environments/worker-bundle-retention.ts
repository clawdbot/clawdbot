import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { WorkerEnvironmentRecord } from "./environment-record.js";
import type { WorkerSessionPlacementRecord } from "./placement-store.js";
import { readWorkerProjectPreparation } from "./preparation-identity.js";

const TERMINAL_ENVIRONMENT_STATES = new Set(["destroyed", "failed", "orphaned"]);
const RECOVERY_BUNDLE_PLACEMENT_STATES = new Set([
  "syncing",
  "starting",
  "active",
  "draining",
  "reconciling",
]);

export function listRetainedWorkerBundleHashes(params: {
  environments: Pick<WorkerEnvironmentRecord, "bootstrapReceipt" | "profileSnapshot" | "state">[];
  placements: WorkerSessionPlacementRecord[];
}): string[] {
  return uniqueStrings([
    ...params.environments.flatMap((record) => {
      if (TERMINAL_ENVIRONMENT_STATES.has(record.state)) {
        return [];
      }
      // Registration can span several sweeps after installation. The admitted preparation
      // owns these bytes until readiness commits its receipt or provisioning terminates.
      const bundleHash =
        record.bootstrapReceipt?.bundleHash ??
        (record.state === "provisioning"
          ? readWorkerProjectPreparation(record.profileSnapshot.project)?.artifacts.workerBundleHash
          : undefined);
      return bundleHash ? [bundleHash] : [];
    }),
    ...params.placements.flatMap((placement) =>
      placement.workerBundleHash && RECOVERY_BUNDLE_PLACEMENT_STATES.has(placement.state)
        ? [placement.workerBundleHash]
        : [],
    ),
  ]);
}
