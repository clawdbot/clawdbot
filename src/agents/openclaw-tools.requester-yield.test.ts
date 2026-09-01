import { describe, expect, it } from "vitest";
import { createRequesterYieldCallback } from "./openclaw-tools.requester-yield.js";

describe("createRequesterYieldCallback", () => {
  it("rejects yield for a cron requester before any intent is recorded", () => {
    const claim = createRequesterYieldCallback({
      requesterSessionKey: "agent:main:cron:isolated",
      requesterAgentId: "main",
      requesterTurnRunId: "run-1",
      claimYieldCompletion: () => true,
    });

    expect(claim).toBeUndefined();
  });

  it("returns a claim for a non-cron requester", () => {
    const claim = createRequesterYieldCallback({
      requesterSessionKey: "agent:main:main",
      requesterAgentId: "main",
      requesterTurnRunId: "run-1",
    });

    expect(claim).toBeTypeOf("function");
  });
});
