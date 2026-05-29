import { describe, expect, it } from "vitest";
import { createSubagentsTool } from "./subagents-tool.js";

describe("subagents tool", () => {
  it("does not advertise sessions_yield as unconditionally available", () => {
    const tool = createSubagentsTool();

    expect(tool.description).toBe(
      "List active and recent subagents for the requester session. If sessions_yield exists, use it for completion; do not poll wait loops.",
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
