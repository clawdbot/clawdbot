import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAgentRunUsage,
  recordAgentRunOutputTokens,
  resetAgentRunUsageForTest,
} from "./agent-run-usage.js";

describe("agent run usage", () => {
  beforeEach(() => resetAgentRunUsageForTest());

  it("does not commit usage when run ownership rejects the event", () => {
    const rejected = recordAgentRunOutputTokens({
      runId: "stale-run",
      lifecycleGeneration: "old-generation",
      outputTokens: 12,
      emit: () => false,
    });
    const accepted = recordAgentRunOutputTokens({
      runId: "stale-run",
      lifecycleGeneration: "old-generation",
      outputTokens: 3,
      emit: () => true,
    });

    expect(rejected).toBeUndefined();
    expect(accepted?.outputTokens).toBe(3);
  });

  it("clears only the targeted lifecycle generation", () => {
    const record = (lifecycleGeneration: string, outputTokens: number) =>
      recordAgentRunOutputTokens({
        runId: "shared-run",
        lifecycleGeneration,
        outputTokens,
        emit: () => true,
      });

    expect(record("old-generation", 12)?.outputTokens).toBe(12);
    expect(record("new-generation", 7)?.outputTokens).toBe(7);

    clearAgentRunUsage("shared-run", "old-generation");

    expect(record("new-generation", 3)?.outputTokens).toBe(10);
    expect(record("old-generation", 2)?.outputTokens).toBe(2);
  });
});
