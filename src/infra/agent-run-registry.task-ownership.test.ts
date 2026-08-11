import { beforeEach, describe, expect, test } from "vitest";
import {
  bindAgentRunTaskRunId,
  claimAgentRunContext,
  getAgentRunContext,
  getAgentRunTaskRunId,
  releaseAgentRunContext,
  resetAgentRunRegistryForTest,
} from "./agent-run-registry.js";

describe("agent run task ownership", () => {
  beforeEach(() => {
    resetAgentRunRegistryForTest();
  });

  test("binds detached task ids to exact active claims", () => {
    const firstClaim = claimAgentRunContext(
      "shared-task-run",
      { sessionKey: "agent:main:cron-task-session" },
      { trackOwner: true, ownsContext: true },
    );
    const secondClaim = claimAgentRunContext(
      "shared-task-run",
      {},
      { trackOwner: true, ownsContext: true },
    );
    expect(firstClaim).toBeTruthy();
    expect(secondClaim).toBeTruthy();
    if (!firstClaim || !secondClaim) {
      throw new Error("expected tracked agent run claims");
    }

    expect(bindAgentRunTaskRunId("shared-task-run", "missing-claim", "task-a")).toBe(false);
    expect(bindAgentRunTaskRunId("shared-task-run", firstClaim, "  task-a  ")).toBe(true);
    expect(bindAgentRunTaskRunId("shared-task-run", secondClaim, "   ")).toBe(false);
    expect(getAgentRunTaskRunId("shared-task-run")).toBe("task-a");

    expect(bindAgentRunTaskRunId("shared-task-run", secondClaim, "task-b")).toBe(true);
    expect(getAgentRunTaskRunId("shared-task-run")).toBeUndefined();

    releaseAgentRunContext("shared-task-run", secondClaim);
    expect(getAgentRunTaskRunId("shared-task-run")).toBe("task-a");
    releaseAgentRunContext("shared-task-run", firstClaim);
    expect(getAgentRunTaskRunId("shared-task-run")).toBeUndefined();
    expect(getAgentRunContext("shared-task-run")).toBeUndefined();
  });
});
