import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock logger before importing the module
vi.mock("../../logger.js", () => ({
  logDebug: vi.fn(),
  logWarn: vi.fn(),
}));

import { prepareSessionManagerForRun } from "./session-manager-init.js";
import { logWarn } from "../../logger.js";

describe("prepareSessionManagerForRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("tool use/result repair on load", () => {
    it("should inject synthetic tool results for unpaired tool calls", async () => {
      const sessionManager = {
        sessionId: "test-session",
        flushed: true,
        fileEntries: [
          { type: "session", id: "test-session", cwd: "/test" },
          {
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "Hello" }],
            },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "Let me check that" },
                {
                  type: "toolCall",
                  id: "tool-123",
                  name: "exec",
                  arguments: { command: "find /Users -name '*.txt'" },
                },
              ],
            },
          },
          // Missing toolResult for tool-123!
        ],
        byId: new Map(),
        labelsById: new Map(),
        leafId: null,
      };

      await prepareSessionManagerForRun({
        sessionManager,
        sessionFile: "/tmp/test-session.jsonl",
        hadSessionFile: true,
        sessionId: "test-session",
        cwd: "/test",
      });

      // Should have added a synthetic tool result
      const messages = sessionManager.fileEntries
        .filter((e: any) => e.type === "message")
        .map((e: any) => e.message);

      const toolResults = messages.filter((m: any) => m.role === "toolResult");
      expect(toolResults.length).toBe(1);
      expect(toolResults[0].toolCallId).toBe("tool-123");
      expect(toolResults[0].isError).toBe(true);
      expect(toolResults[0].content[0].text).toContain("missing tool result");

      // Should have logged a warning
      expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("Repaired session transcript"));

      // Should mark session as unflushed so repairs are persisted
      expect(sessionManager.flushed).toBe(false);
    });

    it("should not modify session if all tool calls have results", async () => {
      const sessionManager = {
        sessionId: "test-session",
        flushed: true,
        fileEntries: [
          { type: "session", id: "test-session", cwd: "/test" },
          {
            type: "message",
            message: {
              role: "user",
              content: [{ type: "text", text: "Hello" }],
            },
          },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "tool-123",
                  name: "exec",
                  arguments: { command: "ls" },
                },
              ],
            },
          },
          {
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "tool-123",
              toolName: "exec",
              content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
              isError: false,
            },
          },
        ],
        byId: new Map(),
        labelsById: new Map(),
        leafId: null,
      };

      await prepareSessionManagerForRun({
        sessionManager,
        sessionFile: "/tmp/test-session.jsonl",
        hadSessionFile: true,
        sessionId: "test-session",
        cwd: "/test",
      });

      // Should not have logged a warning
      expect(logWarn).not.toHaveBeenCalled();

      // Session should remain flushed
      expect(sessionManager.flushed).toBe(true);
    });

    it("should handle multiple unpaired tool calls", async () => {
      const sessionManager = {
        sessionId: "test-session",
        flushed: true,
        fileEntries: [
          { type: "session", id: "test-session", cwd: "/test" },
          {
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", id: "tool-1", name: "exec" },
                { type: "toolCall", id: "tool-2", name: "read" },
              ],
            },
          },
          // Missing both tool results!
        ],
        byId: new Map(),
        labelsById: new Map(),
        leafId: null,
      };

      await prepareSessionManagerForRun({
        sessionManager,
        sessionFile: "/tmp/test-session.jsonl",
        hadSessionFile: true,
        sessionId: "test-session",
        cwd: "/test",
      });

      const messages = sessionManager.fileEntries
        .filter((e: any) => e.type === "message")
        .map((e: any) => e.message);

      const toolResults = messages.filter((m: any) => m.role === "toolResult");
      expect(toolResults.length).toBe(2);

      const ids = toolResults.map((r: any) => r.toolCallId);
      expect(ids).toContain("tool-1");
      expect(ids).toContain("tool-2");
    });

    it("should not repair new sessions without existing files", async () => {
      const sessionManager = {
        sessionId: "test-session",
        flushed: false,
        fileEntries: [{ type: "session", id: undefined, cwd: undefined }],
        byId: new Map(),
        labelsById: new Map(),
        leafId: null,
      };

      await prepareSessionManagerForRun({
        sessionManager,
        sessionFile: "/tmp/new-session.jsonl",
        hadSessionFile: false,
        sessionId: "new-session",
        cwd: "/test",
      });

      // Should not have logged anything
      expect(logWarn).not.toHaveBeenCalled();
    });
  });
});
