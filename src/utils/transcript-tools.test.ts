// Transcript tool tests cover transcript utility parsing and formatting.
import { describe, expect, it } from "vitest";
import { countToolResults, extractToolCallNames, hasToolCall } from "./transcript-tools.js";

describe("transcript-tools", () => {
  describe("extractToolCallNames", () => {
    it("extracts tool name from message.toolName/tool_name", () => {
      expect(extractToolCallNames({ toolName: " weather " })).toEqual(["weather"]);
      expect(extractToolCallNames({ tool_name: "notes" })).toEqual(["notes"]);
    });

    it("extracts tool call names from content blocks (tool_use/toolcall/tool_call)", () => {
      const names = extractToolCallNames({
        content: [
          { type: "text", text: "hi" },
          { type: "tool_use", name: "read" },
          { type: "toolcall", name: "exec" },
          { type: "tool_call", name: "write" },
        ],
      });
      expect(new Set(names)).toEqual(new Set(["read", "exec", "write"]));
    });

    it("normalizes type and trims names; de-dupes", () => {
      const names = extractToolCallNames({
        content: [
          { type: " TOOL_CALL ", name: "  read " },
          { type: "tool_call", name: "read" },
          { type: "tool_call", name: "" },
        ],
        toolName: "read",
      });
      expect(names).toEqual(["read"]);
    });
  });

  describe("hasToolCall", () => {
    it("returns true when tool call names exist", () => {
      expect(hasToolCall({ toolName: "weather" })).toBe(true);
      expect(hasToolCall({ content: [{ type: "tool_use", name: "read" }] })).toBe(true);
    });

    it("returns false when no tool calls exist", () => {
      expect(hasToolCall({})).toBe(false);
      expect(hasToolCall({ content: [{ type: "text", text: "hi" }] })).toBe(false);
    });
  });

  describe("countToolResults", () => {
    it("counts tool_result blocks and tool_result_error blocks; tracks errors via is_error", () => {
      expect(
        countToolResults({
          content: [
            { type: "tool_result" },
            { type: "tool_result", is_error: true },
            { type: "tool_result_error" },
            { type: "text", text: "ignore" },
          ],
        }),
      ).toEqual({ total: 3, errors: 1 });
    });

    it("handles non-array content", () => {
      expect(countToolResults({ content: "nope" })).toEqual({ total: 0, errors: 0 });
    });
  });
});
