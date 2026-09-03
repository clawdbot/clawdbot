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
          error:
            "Unknown tool id: MCP.notes.read. Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name.",
        },
      }),
    ).toEqual({
      source: "tool",
      toolName: "exec",
      code: "UNKNOWN_TOOL_ID",
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
          error:
            "Unknown tool id: MCP.notes.read. Did you mean: MCP.notes.list? Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name.",
        },
      }),
    ).toEqual({
      source: "tool",
      toolName: "wait",
      code: "UNKNOWN_TOOL_ID",
    });
  });

  it("recognizes the wrapped bridge error a live exec failure actually records", () => {
    // Captured verbatim from a real cron run: the bridge throws, so the
    // recorded text carries an Error: prefix, tools.* recovery phrasing, and a
    // controller stack frame after the formatter line.
    expect(
      resolveEmbeddedRunTerminalToolFailure({
        trigger: "cron",
        codeModeEngaged: true,
        lastToolError: {
          toolName: "exec",
          errorCode: "internal_error",
          error:
            "Error: Unknown tool id: MCP.notes.frobnicate. Did you mean: automations, browser? Use tools.search to find a tool, tools.describe to inspect it, then tools.call with the exact id or name.\n    at settle (openclaw-code-mode:controller.js:125:49)\n",
        },
      }),
    ).toEqual({
      source: "tool",
      toolName: "exec",
      code: "UNKNOWN_TOOL_ID",
    });
  });

  it("rejects multi-line text whose later lines mimic the formatter", () => {
    expect(
      resolveEmbeddedRunTerminalToolFailure({
        trigger: "cron",
        codeModeEngaged: true,
        lastToolError: {
          toolName: "exec",
          error:
            "secret-ish output sk-live-4242\nUnknown tool id: MCP.notes.read. Use tools.search to find a tool, tools.describe to inspect it, then tools.call with the exact id or name.",
        },
      }),
    ).toBeUndefined();
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

  it("does not persist an identifier fragment that could be secret-shaped", () => {
    const result = resolveEmbeddedRunTerminalToolFailure({
      trigger: "cron",
      codeModeEngaged: true,
      lastToolError: {
        toolName: "exec",
        error:
          "Unknown tool id: MCP.sk_test_abcdefghijklmnopqrstuvwxyz.read. Did you mean: MCP.notes.read? Use openclaw.tools.search to find a tool, openclaw.tools.describe to inspect it, then openclaw.tools.call with the exact id or name.",
      },
    });

    expect(result).toEqual({
      source: "tool",
      toolName: "exec",
      code: "UNKNOWN_TOOL_ID",
    });
  });
});
