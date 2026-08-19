import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { WorkerSessionPlacementRecord } from "./placement-store.js";
import type { WorkerEnvironmentRecord } from "./store.js";

const TERMINAL_ENVIRONMENT_STATES = new Set(["destroyed", "failed", "orphaned"]);
const RECOVERY_BUNDLE_PLACEMENT_STATES = new Set([
  "syncing",
  "starting",
  "active",
  "draining",
  "reconciling",
]);

export function listRetainedWorkerBundleHashes(params: {
  environments: Pick<WorkerEnvironmentRecord, "bootstrapReceipt" | "state">[];
  placements: WorkerSessionPlacementRecord[];
}): string[] {
  return uniqueStrings([
    ...params.environments.flatMap((record) =>
      record.bootstrapReceipt && !TERMINAL_ENVIRONMENT_STATES.has(record.state)
        ? [record.bootstrapReceipt.bundleHash]
        : [],
    ),
    ...params.placements.flatMap((placement) =>
      placement.workerBundleHash && RECOVERY_BUNDLE_PLACEMENT_STATES.has(placement.state)
        ? [placement.workerBundleHash]
        : [],
    ),
  ]);
}
