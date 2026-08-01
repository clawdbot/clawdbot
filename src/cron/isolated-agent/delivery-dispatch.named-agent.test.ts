// Named-agent delivery dispatch tests cover routing cron delivery to named agents.
import { describe, expect, it, vi } from "vitest";

// Mock the announce flow dependencies to test the fallback behavior.
vi.mock("../../agents/subagent-announce.js", () => ({
  runSubagentAnnounceFlow: vi.fn(),
}));
vi.mock("../../agents/subagent-registry-read.js", () => ({
  countActiveDescendantRuns: vi.fn().mockReturnValue(0),
}));

describe("resolveCronDeliveryBestEffort", () => {
  // Import dynamically to avoid top-level side effects
  it("returns false by default (no bestEffort set)", async () => {
    const { resolveCronDeliveryBestEffort } = await import("./delivery-dispatch.js");
    const job = { delivery: {}, payload: { kind: "agentTurn" } } as never;
    expect(resolveCronDeliveryBestEffort(job)).toBe(false);
  });

  it("returns true when delivery.bestEffort is true", async () => {
    const { resolveCronDeliveryBestEffort } = await import("./delivery-dispatch.js");
    const job = { delivery: { bestEffort: true }, payload: { kind: "agentTurn" } } as never;
    expect(resolveCronDeliveryBestEffort(job)).toBe(true);
  });
});
