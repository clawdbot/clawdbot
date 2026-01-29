import { describe, it, expect } from "vitest";
import { isOrphanToolResultError } from "./pi-embedded-helpers.js";

describe("isOrphanToolResultError", () => {
  it("detects 'unexpected tool_use_id' error message", () => {
    const error =
      "LLM request rejected: messages.60.content.1: unexpected tool_use_id found in tool_result blocks: toolu_01KTTwhMaCYW8oiwZMxx6WDt. Each tool_result block must have a corresponding tool_use block in the previous message.";
    expect(isOrphanToolResultError(error)).toBe(true);
  });

  it("detects tool_use_id with tool_result in message", () => {
    const error = "Invalid request: tool_use_id in tool_result does not match any tool_use";
    expect(isOrphanToolResultError(error)).toBe(true);
  });

  it("detects 'tool_result does not have corresponding tool_use' pattern", () => {
    const error =
      "Error: tool_result block does not have a corresponding tool_use block in previous message";
    expect(isOrphanToolResultError(error)).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(isOrphanToolResultError("rate limit exceeded")).toBe(false);
    expect(isOrphanToolResultError("authentication failed")).toBe(false);
    expect(isOrphanToolResultError("context window exceeded")).toBe(false);
  });

  it("returns false for empty or null input", () => {
    expect(isOrphanToolResultError("")).toBe(false);
    expect(isOrphanToolResultError(null as unknown as string)).toBe(false);
    expect(isOrphanToolResultError(undefined as unknown as string)).toBe(false);
  });

  it("is case-insensitive", () => {
    const error = "UNEXPECTED TOOL_USE_ID found in TOOL_RESULT blocks";
    expect(isOrphanToolResultError(error)).toBe(true);
  });
});
