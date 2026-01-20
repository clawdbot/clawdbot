/**
 * Tests for Claude Code session management.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseProjectIdentifier,
  resolveProject,
  getGitBranch,
  encodeClaudeProjectPath,
  decodeClaudeProjectPath,
} from "./project-resolver.js";
import { extractRecentActions, getWaitingEvent, isSessionIdle } from "./session-parser.js";
import {
  formatRuntime,
  formatRuntimeDetailed,
  isRuntimeExceeded,
  getRemainingTime,
} from "./progress-tracker.js";
import type { SessionEvent } from "./types.js";

describe("project-resolver", () => {
  describe("parseProjectIdentifier", () => {
    it("parses simple project name", () => {
      const result = parseProjectIdentifier("juzi");
      expect(result.name).toBe("juzi");
      expect(result.worktree).toBeUndefined();
      expect(result.isAbsolute).toBe(false);
    });

    it("parses project with worktree", () => {
      const result = parseProjectIdentifier("juzi @experimental");
      expect(result.name).toBe("juzi");
      expect(result.worktree).toBe("experimental");
      expect(result.isAbsolute).toBe(false);
    });

    it("parses project with worktree (no space)", () => {
      const result = parseProjectIdentifier("juzi@experimental");
      expect(result.name).toBe("juzi");
      expect(result.worktree).toBe("experimental");
      expect(result.isAbsolute).toBe(false);
    });

    it("parses absolute path", () => {
      const result = parseProjectIdentifier("/Users/dydo/projects/juzi");
      expect(result.name).toBe("/Users/dydo/projects/juzi");
      expect(result.isAbsolute).toBe(true);
    });
  });

  describe("encodeClaudeProjectPath / decodeClaudeProjectPath", () => {
    it("encodes path correctly", () => {
      const path = "/Users/dydo/clawd/projects/juzi";
      const encoded = encodeClaudeProjectPath(path);
      expect(encoded).toBe("-Users-dydo-clawd-projects-juzi");
    });

    it("handles literal dashes", () => {
      const path = "/Users/dydo/clawd/projects/monitor-v3";
      const encoded = encodeClaudeProjectPath(path);
      expect(encoded).toBe("-Users-dydo-clawd-projects-monitor--v3");
    });

    it("round-trips correctly", () => {
      const path = "/Users/dydo/clawd/projects/monitor-v3";
      const encoded = encodeClaudeProjectPath(path);
      const decoded = decodeClaudeProjectPath(encoded);
      expect(decoded).toBe(path);
    });

    it("round-trips worktree path", () => {
      const path = "/Users/dydo/Documents/agent/juzi/.worktrees/experimental";
      const encoded = encodeClaudeProjectPath(path);
      const decoded = decodeClaudeProjectPath(encoded);
      expect(decoded).toBe(path);
    });
  });
});

describe("session-parser", () => {
  describe("extractRecentActions", () => {
    it("extracts tool_use events", () => {
      const events: SessionEvent[] = [
        {
          type: "tool_use",
          timestamp: new Date(),
          toolName: "Read",
          toolInput: "/path/to/file.ts",
        },
      ];
      const actions = extractRecentActions(events);
      expect(actions).toHaveLength(1);
      expect(actions[0].icon).toBe("▸");
      expect(actions[0].description).toContain("Reading");
    });

    it("extracts tool_result events", () => {
      const events: SessionEvent[] = [
        { type: "tool_result", timestamp: new Date(), text: "File content..." },
      ];
      const actions = extractRecentActions(events);
      expect(actions).toHaveLength(1);
      expect(actions[0].icon).toBe("✓");
    });

    it("extracts assistant_message events", () => {
      const events: SessionEvent[] = [
        { type: "assistant_message", timestamp: new Date(), text: "Let me help you with that." },
      ];
      const actions = extractRecentActions(events);
      expect(actions).toHaveLength(1);
      expect(actions[0].icon).toBe("💬");
    });

    it("limits to specified number", () => {
      const events: SessionEvent[] = Array.from({ length: 20 }, (_, i) => ({
        type: "tool_use" as const,
        timestamp: new Date(),
        toolName: `Tool${i}`,
      }));
      const actions = extractRecentActions(events, 5);
      expect(actions).toHaveLength(5);
    });
  });

  describe("getWaitingEvent", () => {
    it("returns undefined when no waiting event", () => {
      const events: SessionEvent[] = [
        { type: "tool_use", timestamp: new Date() },
        { type: "tool_result", timestamp: new Date() },
      ];
      expect(getWaitingEvent(events)).toBeUndefined();
    });

    it("returns waiting assistant message", () => {
      const events: SessionEvent[] = [
        { type: "tool_result", timestamp: new Date() },
        {
          type: "assistant_message",
          timestamp: new Date(),
          text: "What would you like?",
          isWaitingForInput: true,
        },
      ];
      const waiting = getWaitingEvent(events);
      expect(waiting).toBeDefined();
      expect(waiting?.text).toBe("What would you like?");
    });

    it("only checks last assistant message", () => {
      const events: SessionEvent[] = [
        {
          type: "assistant_message",
          timestamp: new Date(),
          text: "Old question?",
          isWaitingForInput: true,
        },
        { type: "user_message", timestamp: new Date(), text: "Answer" },
        {
          type: "assistant_message",
          timestamp: new Date(),
          text: "Working on it...",
          isWaitingForInput: false,
        },
      ];
      expect(getWaitingEvent(events)).toBeUndefined();
    });
  });

  describe("isSessionIdle", () => {
    it("returns true for empty events", () => {
      expect(isSessionIdle([])).toBe(true);
    });

    it("returns true when last event is tool_result", () => {
      const events: SessionEvent[] = [
        { type: "tool_use", timestamp: new Date() },
        { type: "tool_result", timestamp: new Date() },
      ];
      expect(isSessionIdle(events)).toBe(true);
    });

    it("returns true when last event is assistant_message", () => {
      const events: SessionEvent[] = [
        { type: "assistant_message", timestamp: new Date(), text: "Done!" },
      ];
      expect(isSessionIdle(events)).toBe(true);
    });

    it("returns false when last event is tool_use", () => {
      const events: SessionEvent[] = [
        { type: "tool_result", timestamp: new Date() },
        { type: "tool_use", timestamp: new Date() },
      ];
      expect(isSessionIdle(events)).toBe(false);
    });
  });
});

describe("progress-tracker", () => {
  describe("formatRuntime", () => {
    it("formats seconds to hours and minutes", () => {
      expect(formatRuntime(0)).toBe("0h 0m");
      expect(formatRuntime(60)).toBe("0h 1m");
      expect(formatRuntime(3600)).toBe("1h 0m");
      expect(formatRuntime(3660)).toBe("1h 1m");
      expect(formatRuntime(7230)).toBe("2h 0m");
    });
  });

  describe("formatRuntimeDetailed", () => {
    it("formats short durations with seconds", () => {
      expect(formatRuntimeDetailed(30)).toBe("30s");
      expect(formatRuntimeDetailed(90)).toBe("1m 30s");
    });

    it("formats longer durations with hours and minutes", () => {
      expect(formatRuntimeDetailed(3600)).toBe("1h 0m");
      expect(formatRuntimeDetailed(3660)).toBe("1h 1m");
    });
  });

  describe("isRuntimeExceeded", () => {
    it("returns false when under limit", () => {
      const start = Date.now() - 1000 * 60 * 30; // 30 minutes ago
      expect(isRuntimeExceeded(start, 1)).toBe(false);
    });

    it("returns true when over limit", () => {
      const start = Date.now() - 1000 * 60 * 90; // 90 minutes ago
      expect(isRuntimeExceeded(start, 1)).toBe(true);
    });
  });

  describe("getRemainingTime", () => {
    it("returns remaining seconds", () => {
      const start = Date.now() - 1000 * 60 * 30; // 30 minutes ago
      const remaining = getRemainingTime(start, 1);
      expect(remaining).toBeGreaterThan(1700); // ~30 minutes left
      expect(remaining).toBeLessThan(1900);
    });

    it("returns 0 when exceeded", () => {
      const start = Date.now() - 1000 * 60 * 90; // 90 minutes ago
      expect(getRemainingTime(start, 1)).toBe(0);
    });
  });
});
