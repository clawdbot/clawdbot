import { describe, expect, it } from "vitest";
import type { WorkerSessionPlacementRecord } from "./placement-store.js";
import type { WorkerEnvironmentRecord } from "./store.js";
import { listRetainedWorkerBundleHashes } from "./worker-bundle-retention.js";

const hash = (value: string) => value.repeat(64);

function environment(state: WorkerEnvironmentRecord["state"], bundleHash: string) {
  return {
    state,
    bootstrapReceipt: {
      bundleHash,
      openclawVersion: "1.2.3",
      protocolFeatures: [],
    },
  } as Pick<WorkerEnvironmentRecord, "bootstrapReceipt" | "state">;
}

function placement(state: WorkerSessionPlacementRecord["state"], bundleHash: string | null) {
  return { state, workerBundleHash: bundleHash } as WorkerSessionPlacementRecord;
}

describe("worker bundle retention", () => {
  it("retains only operational environment and placement bundle hashes", () => {
    expect(
      listRetainedWorkerBundleHashes({
        environments: [
          environment("attached", hash("0")),
          environment("destroyed", hash("1")),
          environment("failed", hash("2")),
          environment("orphaned", hash("3")),
        ],
        placements: [
          placement("syncing", hash("4")),
          placement("starting", hash("5")),
          placement("active", hash("6")),
          placement("draining", hash("7")),
          placement("reconciling", hash("8")),
          placement("reclaimed", hash("9")),
          placement("failed", hash("a")),
          placement("local", null),
        ],
      }),
    ).toEqual([hash("0"), hash("4"), hash("5"), hash("6"), hash("7"), hash("8")]);
  });
});
