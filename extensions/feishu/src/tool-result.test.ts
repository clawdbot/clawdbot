// Feishu tests cover tool result plugin behavior.
import { describe, expect, it } from "vitest";
import { toolExecutionErrorResult, unknownToolActionResult } from "./tool-result.js";

describe("tool result errors", () => {
  it("formats unknown action errors", () => {
    expect(unknownToolActionResult("create")).toEqual({
      content: [
        { type: "text", text: JSON.stringify({ error: "Unknown action: create" }, null, 2) },
      ],
      details: { error: "Unknown action: create" },
    });
  });

  it("formats execution errors", () => {
    expect(toolExecutionErrorResult(new Error("boom"))).toEqual({
      content: [{ type: "text", text: JSON.stringify({ error: "boom" }, null, 2) }],
      details: { error: "boom" },
    });
  });
});
