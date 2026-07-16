import { describe, expect, it } from "vitest";
import {
  jsonToolResult,
  toolExecutionErrorResult,
  unknownToolActionResult,
} from "./tool-result.js";

describe("jsonToolResult", () => {
  it("formats tool result with text content and details", () => {
    const payload = { ok: true, id: "abc" };
    expect(jsonToolResult(payload)).toEqual({
      content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      details: payload,
    });
  });

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
