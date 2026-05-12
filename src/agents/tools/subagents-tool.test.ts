import { describe, expect, it } from "vitest";
import { createSubagentsTool } from "./subagents-tool.js";

describe("subagents tool", () => {
  it("does not advertise sessions_yield as unconditionally available", () => {
    const tool = createSubagentsTool();

    expect(tool.description).toBe(
      "On-demand list, kill, or steer spawned sub-agents for this requester session. If sessions_yield is available, use it to wait for completion events; do not poll this tool in wait loops.",
    );
  });
});
