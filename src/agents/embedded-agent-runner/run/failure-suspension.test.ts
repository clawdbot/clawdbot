// Embedded failure suspensions must reach the owning agent's session store.
import { describe, expect, it } from "vitest";
import { buildEmbeddedFailureSuspension } from "./failure-suspension.js";

const baseSuspension = {
  cfg: undefined,
  sessionId: "session-1",
  reason: "quota_exhausted",
  failedProvider: "anthropic",
  failedModel: "claude-opus-4-6",
} as const;

describe("buildEmbeddedFailureSuspension", () => {
  it("fills the run's agent id when the failure caller only knows agentDir", () => {
    // Assistant/prompt failures pass agentDir only; an unregistered or shared
    // directory resolves no owner and would suspend the default agent instead.
    const suspension = buildEmbeddedFailureSuspension({
      suspension: { ...baseSuspension, agentDir: "/state/agents/work/agent" },
      runAgentId: "work",
      laneId: "main",
    });

    expect(suspension.agentId).toBe("work");
    expect(suspension.agentDir).toBe("/state/agents/work/agent");
    expect(suspension.laneId).toBe("main");
  });

  it("keeps an explicit caller agent id and tolerates a run without one", () => {
    expect(
      buildEmbeddedFailureSuspension({
        suspension: { ...baseSuspension, agentId: "explicit" },
        runAgentId: "run-owner",
        laneId: "main",
      }).agentId,
    ).toBe("explicit");

    expect(
      buildEmbeddedFailureSuspension({
        suspension: baseSuspension,
        runAgentId: undefined,
        laneId: "main",
      }).agentId,
    ).toBeUndefined();
  });
});
