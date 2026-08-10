// Coverage for bounded Code Mode failure projection into terminal metadata.
import { describe, expect, it } from "vitest";
import { resolveEmbeddedRunTerminalToolFailure } from "./terminal-tool-failure.js";

describe("resolveEmbeddedRunTerminalToolFailure", () => {
  it("projects a sanitized Code Mode cron failure", () => {
    expect(
      resolveEmbeddedRunTerminalToolFailure({
        trigger: "cron",
        codeModeEngaged: true,
        lastToolError: {
          toolName: "exec",
          errorCode: "invalid_input",
          error: "Unknown tool id: MCP.notes.read",
        },
      }),
    ).toEqual({
      source: "tool",
      toolName: "exec",
      code: "UNKNOWN_TOOL_ID",
      message: "Unknown tool id: MCP.notes.read",
    });
  });

  it("projects a failed resumed Code Mode run from the wait control", () => {
    expect(
      resolveEmbeddedRunTerminalToolFailure({
        trigger: "cron",
        codeModeEngaged: true,
        lastToolError: {
          toolName: "wait",
          errorCode: "invalid_input",
          error: "Unknown tool id: MCP.notes.read",
        },
      }),
    ).toEqual({
      source: "tool",
      toolName: "wait",
      code: "UNKNOWN_TOOL_ID",
      message: "Unknown tool id: MCP.notes.read",
    });
  });

  it("keeps ordinary exec, structured denials, and arbitrary private errors on existing paths", () => {
    const base = {
      trigger: "cron",
      lastToolError: { toolName: "exec", error: "command failed" },
    } as const;

    expect(resolveEmbeddedRunTerminalToolFailure(base)).toBeUndefined();
    expect(
      resolveEmbeddedRunTerminalToolFailure({
        ...base,
        codeModeEngaged: true,
        lastToolError: { ...base.lastToolError, errorCode: "SYSTEM_RUN_DENIED" },
      }),
    ).toBeUndefined();
    expect(
      resolveEmbeddedRunTerminalToolFailure({
        ...base,
        codeModeEngaged: true,
        lastToolError: {
          ...base.lastToolError,
          error: "Unknown tool id: MCP.notes.read; private output: /home/operator/.config/token",
        },
      }),
    ).toBeUndefined();
    expect(
      resolveEmbeddedRunTerminalToolFailure({
        ...base,
        codeModeEngaged: true,
        lastToolError: {
          ...base.lastToolError,
          error: "OPENAI_API_KEY=sk-test-abcdefghijklmnopqrstuvwxyz",
        },
      }),
    ).toBeUndefined();
  });

  it("normalizes only the allowlisted tool identifier into history metadata", () => {
    const result = resolveEmbeddedRunTerminalToolFailure({
      trigger: "cron",
      codeModeEngaged: true,
      lastToolError: {
        toolName: "exec",
        error: "Unknown tool id: MCP.notes.read",
      },
    });

    expect(result).toEqual({
      source: "tool",
      toolName: "exec",
      code: "UNKNOWN_TOOL_ID",
      message: "Unknown tool id: MCP.notes.read",
    });
  });
});
