import { describe, expect, it } from "vitest";
import { createSubagentsTool } from "./subagents-tool.js";

describe("subagents tool", () => {
  it("does not advertise sessions_yield as unconditionally available", () => {
    const tool = createSubagentsTool();

    expect(tool.description).toBe(
      "List/kill/steer spawned subagents for requester session. If sessions_yield exists, use it for completion; do not poll wait loops.",
    );
  });
});
