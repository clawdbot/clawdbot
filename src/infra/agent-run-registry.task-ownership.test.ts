import { beforeEach, describe, expect, test } from "vitest";
import {
  bindAgentRunCronReceipt,
  bindAgentRunTaskRunId,
  claimAgentRunContext,
  getAgentRunCronReceipt,
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

  test("binds exact cron receipts to active claims and rejects ambiguous owners", () => {
    const firstClaim = claimAgentRunContext(
      "shared-cron-run",
      { sessionKey: "agent:main:cron:job:run:session" },
      { trackOwner: true, ownsContext: true },
    );
    const secondClaim = claimAgentRunContext(
      "shared-cron-run",
      {},
      { trackOwner: true, ownsContext: true },
    );
    expect(firstClaim).toBeTruthy();
    expect(secondClaim).toBeTruthy();
    if (!firstClaim || !secondClaim) {
      throw new Error("expected tracked agent run claims");
    }

    const firstReceipt = {
      receiptId: "receipt-a",
      storeKey: "store-a",
      jobId: "job-a",
      configRevision: "revision-a",
      agentId: "main",
      ownerPid: 100,
      ownerStartTime: 200,
      startedAtMs: 300,
    };
    const secondReceipt = { ...firstReceipt, receiptId: "receipt-b" };

    expect(bindAgentRunCronReceipt("shared-cron-run", "missing-claim", firstReceipt)).toBe(false);
    expect(bindAgentRunCronReceipt("shared-cron-run", firstClaim, firstReceipt)).toBe(true);
    expect(getAgentRunCronReceipt("shared-cron-run")).toEqual(firstReceipt);

    expect(bindAgentRunCronReceipt("shared-cron-run", secondClaim, secondReceipt)).toBe(true);
    expect(getAgentRunCronReceipt("shared-cron-run")).toBeUndefined();

    releaseAgentRunContext("shared-cron-run", secondClaim);
    expect(getAgentRunCronReceipt("shared-cron-run")).toEqual(firstReceipt);
    releaseAgentRunContext("shared-cron-run", firstClaim);
    expect(getAgentRunCronReceipt("shared-cron-run")).toBeUndefined();
  });
});
