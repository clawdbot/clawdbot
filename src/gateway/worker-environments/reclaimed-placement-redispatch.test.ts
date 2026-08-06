import { describe, expect, it, vi } from "vitest";
import type { WorkerSessionPlacementRecord } from "./placement-record.js";
import { createReclaimedPlacementRedispatch } from "./reclaimed-placement-redispatch.js";

type ReclaimedWorkerPlacement = Extract<WorkerSessionPlacementRecord, { state: "reclaimed" }>;

const placement = {
  state: "reclaimed",
  sessionId: "session-1",
  sessionKey: "agent:main:cloud-session",
  agentId: "main",
  environmentId: "worker:previous",
} as ReclaimedWorkerPlacement;

describe("createReclaimedPlacementRedispatch", () => {
  it("reuses the previous environment profile for a fresh dispatch", async () => {
    const active = { state: "active" } as Extract<
      WorkerSessionPlacementRecord,
      { state: "active" }
    >;
    const dispatch = vi.fn(async () => active);
    const redispatch = createReclaimedPlacementRedispatch({
      environments: {
        get: () => ({ profileId: "development" }) as never,
      },
      dispatch,
    });

    await expect(redispatch(placement)).resolves.toBe(active);
    expect(dispatch).toHaveBeenCalledWith({
      sessionId: placement.sessionId,
      sessionKey: placement.sessionKey,
      agentId: placement.agentId,
      profileId: "development",
    });
  });

  it("fails closed when the prior environment record is unavailable", async () => {
    const redispatch = createReclaimedPlacementRedispatch({
      environments: { get: () => undefined },
      dispatch: vi.fn(),
    });

    await expect(redispatch(placement)).rejects.toThrow(
      "Reclaimed worker placement has no environment record: worker:previous",
    );
  });
});
