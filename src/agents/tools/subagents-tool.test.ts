import { describe, expect, it } from "vitest";
import { createSubagentsTool } from "./subagents-tool.js";

describe("subagents tool", () => {
  it("does not advertise sessions_yield as unconditionally available", () => {
    const tool = createSubagentsTool();

    expect(tool.description).toContain("If sessions_yield is available");
    expect(tool.description).not.toContain("Use sessions_yield to wait");
  });
});
