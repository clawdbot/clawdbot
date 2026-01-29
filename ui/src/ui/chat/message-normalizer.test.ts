import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  normalizeMessage,
  normalizeRoleForGrouping,
  isToolResultMessage,
  splitSystemPreface,
} from "./message-normalizer";

describe("message-normalizer", () => {
  describe("normalizeMessage", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("normalizes message with string content", () => {
      const result = normalizeMessage({
        role: "user",
        content: "Hello world",
        timestamp: 1000,
        id: "msg-1",
      });

      expect(result).toEqual({
        role: "user",
        content: [{ type: "text", text: "Hello world" }],
        timestamp: 1000,
        id: "msg-1",
      });
    });

    it("normalizes message with array content", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: [
          { type: "text", text: "Here is the result" },
          { type: "tool_use", name: "bash", args: { command: "ls" } },
        ],
        timestamp: 2000,
      });

      expect(result.role).toBe("assistant");
      expect(result.content).toHaveLength(2);
      expect(result.content[0]).toEqual({ type: "text", text: "Here is the result", name: undefined, args: undefined });
      expect(result.content[1]).toEqual({ type: "tool_use", text: undefined, name: "bash", args: { command: "ls" } });
    });

    it("normalizes message with text field (alternative format)", () => {
      const result = normalizeMessage({
        role: "user",
        text: "Alternative format",
      });

      expect(result.content).toEqual([{ type: "text", text: "Alternative format" }]);
    });

    it("detects tool result by toolCallId", () => {
      const result = normalizeMessage({
        role: "assistant",
        toolCallId: "call-123",
        content: "Tool output",
      });

      expect(result.role).toBe("toolResult");
    });

    it("detects tool result by tool_call_id (snake_case)", () => {
      const result = normalizeMessage({
        role: "assistant",
        tool_call_id: "call-456",
        content: "Tool output",
      });

      expect(result.role).toBe("toolResult");
    });

    it("handles missing role", () => {
      const result = normalizeMessage({ content: "No role" });
      expect(result.role).toBe("unknown");
    });

    it("handles missing content", () => {
      const result = normalizeMessage({ role: "user" });
      expect(result.content).toEqual([]);
    });

    it("uses current timestamp when not provided", () => {
      const result = normalizeMessage({ role: "user", content: "Test" });
      expect(result.timestamp).toBe(Date.now());
    });

    it("handles arguments field (alternative to args)", () => {
      const result = normalizeMessage({
        role: "assistant",
        content: [{ type: "tool_use", name: "test", arguments: { foo: "bar" } }],
      });

      expect(result.content[0].args).toEqual({ foo: "bar" });
    });
  });

  describe("normalizeRoleForGrouping", () => {
    it("returns tool for toolresult", () => {
      expect(normalizeRoleForGrouping("toolresult")).toBe("tool");
      expect(normalizeRoleForGrouping("toolResult")).toBe("tool");
      expect(normalizeRoleForGrouping("TOOLRESULT")).toBe("tool");
    });

    it("returns tool for tool_result", () => {
      expect(normalizeRoleForGrouping("tool_result")).toBe("tool");
      expect(normalizeRoleForGrouping("TOOL_RESULT")).toBe("tool");
    });

    it("returns tool for tool", () => {
      expect(normalizeRoleForGrouping("tool")).toBe("tool");
      expect(normalizeRoleForGrouping("Tool")).toBe("tool");
    });

    it("returns tool for function", () => {
      expect(normalizeRoleForGrouping("function")).toBe("tool");
      expect(normalizeRoleForGrouping("Function")).toBe("tool");
    });

    it("preserves user role", () => {
      expect(normalizeRoleForGrouping("user")).toBe("user");
      expect(normalizeRoleForGrouping("User")).toBe("User");
    });

    it("preserves assistant role", () => {
      expect(normalizeRoleForGrouping("assistant")).toBe("assistant");
    });

    it("preserves system role", () => {
      expect(normalizeRoleForGrouping("system")).toBe("system");
    });
  });

  describe("splitSystemPreface", () => {
    it("splits leading system block into system message", () => {
      const normalized = normalizeMessage({
        role: "user",
        content: "System: [2026-01-26 10:00:00 UTC] Exec finished\n\nRun complete",
        timestamp: 123,
      });
      const result = splitSystemPreface(normalized);
      expect(result.systemMessage?.role).toBe("system");
      expect(result.systemMessage?.content).toEqual([
        { type: "text", text: expect.stringContaining("Exec finished") },
      ]);
      expect(result.message.content).toEqual([
        { type: "text", text: "Run complete" },
      ]);
    });

    it("keeps user message when no system prefix", () => {
      const normalized = normalizeMessage({
        role: "user",
        content: "Hello",
        timestamp: 123,
      });
      const result = splitSystemPreface(normalized);
      expect(result.systemMessage).toBeNull();
      expect(result.message.content).toEqual([{ type: "text", text: "Hello" }]);
    });

    it("creates system message even when remainder is empty", () => {
      const normalized = normalizeMessage({
        role: "user",
        content: "System: [2026-01-26 10:00:00 UTC] Gateway restart",
        timestamp: 123,
      });
      const result = splitSystemPreface(normalized);
      expect(result.systemMessage?.content).toEqual([
        { type: "text", text: expect.stringContaining("Gateway restart") },
      ]);
      expect(result.message.content).toEqual([]);
    });
  });

  describe("isToolResultMessage", () => {
    it("returns true for toolresult role", () => {
      expect(isToolResultMessage({ role: "toolresult" })).toBe(true);
      expect(isToolResultMessage({ role: "toolResult" })).toBe(true);
      expect(isToolResultMessage({ role: "TOOLRESULT" })).toBe(true);
    });

    it("returns true for tool_result role", () => {
      expect(isToolResultMessage({ role: "tool_result" })).toBe(true);
      expect(isToolResultMessage({ role: "TOOL_RESULT" })).toBe(true);
    });

    it("returns false for other roles", () => {
      expect(isToolResultMessage({ role: "user" })).toBe(false);
      expect(isToolResultMessage({ role: "assistant" })).toBe(false);
      expect(isToolResultMessage({ role: "tool" })).toBe(false);
    });

    it("returns false for missing role", () => {
      expect(isToolResultMessage({})).toBe(false);
      expect(isToolResultMessage({ content: "test" })).toBe(false);
    });

    it("returns false for non-string role", () => {
      expect(isToolResultMessage({ role: 123 })).toBe(false);
      expect(isToolResultMessage({ role: null })).toBe(false);
    });
  });
});
