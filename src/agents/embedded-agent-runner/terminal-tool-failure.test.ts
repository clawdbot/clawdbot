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
      code: "invalid_input",
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
      code: "invalid_input",
      message: "Unknown tool id: MCP.notes.read",
    });
  });

  it("keeps ordinary exec and structured denial failures on their existing paths", () => {
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
  });

  it("redacts, flattens, and bounds terminal metadata", () => {
    const result = resolveEmbeddedRunTerminalToolFailure({
      trigger: "cron",
      codeModeEngaged: true,
      lastToolError: {
        toolName: "exec",
        error: `OPENAI_API_KEY=sk-test-abcdefghijklmnopqrstuvwxyz\n${"x".repeat(700)}`,
      },
    });

    expect(result?.message).not.toContain("sk-test-abcdefghijklmnopqrstuvwxyz");
    expect(result?.message).not.toContain("\n");
    expect(result?.message.length).toBeLessThanOrEqual(501);
    expect(result?.message.endsWith("…")).toBe(true);
  });
});
