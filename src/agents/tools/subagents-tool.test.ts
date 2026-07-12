// Subagents tool tests cover requester-scoped listing guidance and numeric
// status-window validation.
import { describe, expect, it } from "vitest";
import { createSubagentsTool } from "./subagents-tool.js";

describe("subagents tool", () => {
  it("does not advertise sessions_yield as unconditionally available", () => {
    // sessions_yield is context-dependent; the model-facing description should
    // not promise it exists in every runtime.
    const tool = createSubagentsTool();

    expect(tool.description).toBe(
      "List requester-session active/recent subagents. If available, wait via sessions_yield; never poll-loop.",
    );
  });

  it.each([0, 1.5])("rejects invalid recentMinutes value %s", async (recentMinutes) => {
    const tool = createSubagentsTool();

    await expect(
      tool.execute("call-1", {
        action: "list",
        recentMinutes,
      }),
    ).rejects.toThrow("recentMinutes must be a positive integer");
  });
});
