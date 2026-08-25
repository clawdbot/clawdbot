import { beforeEach, describe, expect, test } from "vitest";
import {
  bindAgentRunContextTaskRunId,
  bindAgentRunTaskRunId,
  claimAgentRunContext,
  getAgentRunContext,
  getAgentRunLifecycleGeneration,
  getAgentRunTaskRunId,
  registerAgentRunContext,
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

  test("binds and clears event task ownership only on the current run context", () => {
    const lifecycleGeneration = getAgentRunLifecycleGeneration();
    registerAgentRunContext("subagent-replacement", {
      lifecycleGeneration,
      sessionKey: "agent:main:subagent:replacement",
    });

    expect(
      bindAgentRunContextTaskRunId(
        "subagent-replacement",
        lifecycleGeneration,
        "  original-task  ",
      ),
    ).toBe(true);
    expect(getAgentRunContext("subagent-replacement")?.taskRunId).toBe("original-task");

    expect(
      bindAgentRunContextTaskRunId("subagent-replacement", "stale-generation", "other-task"),
    ).toBe(false);
    expect(getAgentRunContext("subagent-replacement")?.taskRunId).toBe("original-task");

    expect(
      bindAgentRunContextTaskRunId("subagent-replacement", lifecycleGeneration, undefined),
    ).toBe(true);
    expect(getAgentRunContext("subagent-replacement")?.taskRunId).toBeUndefined();
    expect(bindAgentRunContextTaskRunId("missing-run", lifecycleGeneration, "task")).toBe(false);
  });
});
