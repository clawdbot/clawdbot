import { describe, expect, it } from "vitest";
import {
  validateTasksCancelParams,
  validateTasksListParams,
  validateTasksRecoveryParams,
} from "./validator-registry.js";

describe("task validators", () => {
  it("accepts SDK task ledger filters and order selectors", () => {
    for (const value of [
      {
        status: ["running", "completed"],
        agentId: "main",
        sessionKey: "agent:main:main",
        limit: 50,
        cursor: "100",
        sortBy: "endedAt",
      },
      { sortBy: "updatedAt" },
    ]) {
      expect(validateTasksListParams(value)).toBe(true);
    }
  });

  it("rejects internal task statuses and unknown order selectors", () => {
    expect(validateTasksListParams({ status: "succeeded" })).toBe(false);
    expect(validateTasksListParams({ sortBy: "createdAt" })).toBe(false);
    expect(validateTasksCancelParams({ taskId: "task-1", force: true })).toBe(false);
  });

  it("bounds recovery batches", () => {
    expect(validateTasksRecoveryParams({ taskIds: ["task-1", "task-2"] })).toBe(true);
    expect(validateTasksRecoveryParams({ taskIds: [] })).toBe(false);
    expect(
      validateTasksRecoveryParams({
        taskIds: Array.from({ length: 11 }, (_, index) => `task-${index}`),
      }),
    ).toBe(false);
    expect(validateTasksRecoveryParams({ taskIds: ["task-1"], force: true })).toBe(false);
  });
});
