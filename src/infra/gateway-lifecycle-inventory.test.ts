import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createGatewayActiveWorkSnapshot } from "./gateway-active-work.js";
import {
  ARXI_LIFECYCLE_REVIEWED_UPSTREAM_COMMIT,
  GATEWAY_LIFECYCLE_ACTIVE_PRODUCERS,
  GATEWAY_LIFECYCLE_TIME_BASED_PRODUCERS,
} from "./gateway-lifecycle-inventory.js";

describe("Arxi lifecycle upgrade inventory", () => {
  it("covers every canonical active-work count", () => {
    const countKeys = Object.keys(createGatewayActiveWorkSnapshot().counts)
      .filter((key) => key !== "totalActive")
      .toSorted();
    const inventoried = GATEWAY_LIFECYCLE_ACTIVE_PRODUCERS.map(
      (entry) => entry.countKey,
    ).toSorted();
    expect(inventoried).toEqual(countKeys);
  });

  it("keeps every reviewed time producer in the wake contract", () => {
    expect(GATEWAY_LIFECYCLE_TIME_BASED_PRODUCERS).toEqual([
      { id: "cron", wakeSource: "CronService.getSuspendWakeSnapshot" },
    ]);
  });

  it("fails an upstream upgrade until the producer inventory is reviewed", () => {
    const reviewedParents = execFileSync(
      "git",
      ["log", "--first-parent", "--merges", "--grep=Merge pinned upstream", "--format=%P", "-1"],
      { encoding: "utf8" },
    ).trim();
    const reviewedUpstreamCommit = reviewedParents.split(/\s+/u)[1];
    expect(reviewedUpstreamCommit).toBe(ARXI_LIFECYCLE_REVIEWED_UPSTREAM_COMMIT);
  });
});
